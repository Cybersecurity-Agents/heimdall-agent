import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  COMPACT_THRESHOLD,
  firstLlmKey,
  piAgentDir,
  resolveModelId,
  resolveProvider,
  resolveThinking,
  seedPiWorkspace,
  SOLVER_TOOLS,
  type ThinkingLevel,
} from "../../shared/pi-workspace.js";
import { saveSession } from "../../shared/session.js";
import type { AgentRunResult, Backend, BackendRunOpts } from "./types.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const COMPACT_INSTRUCTIONS =
  "Keep the CTF goal, live addresses, LOCK/hint, " +
  "working exploit path, failed oracles, and the next step. " +
  "Drop raw tool dumps and repeated recon.";

function authenticationError(error: string | null): boolean {
  return /\b(401|403)\b|authentication_error|permission_error|invalid[ _-]*(api[ _-]*)?key|unauthorized/i.test(error || "");
}

type SessionLike = {
  sessionId: string;
  sessionFile?: string;
  prompt: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  compact: (instructions?: string) => Promise<unknown>;
  getSessionStats: () => {
    contextUsage?: { percent?: number; tokens?: number; contextWindow?: number };
  };
  subscribe: (fn: (ev: Record<string, unknown>) => void) => () => void;
  dispose: () => void;
};

export async function loadPiResources(
  workspace: string,
  agentDir: string,
  systemPrompt: string,
  noContextFiles: boolean,
  noSkills = false,
) {
  const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const settingsManager = SettingsManager.create(workspace, agentDir, { projectTrusted: true });
  const skillsDir = join(workspace, ".claude", "skills");
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager,
    // Observer/summarizer can start before the solver writes .pi/settings.json.
    additionalSkillPaths: !noSkills && existsSync(skillsDir) ? [skillsDir] : [],
    noSkills,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles,
    systemPrompt,
  });
  await resourceLoader.reload();
  return { resourceLoader, settingsManager };
}

export class PiBackend implements Backend {
  name = "pi";
  private session: SessionLike | null = null;
  private dead = false;
  private unsub: (() => void) | null = null;
  constructor(
    readonly opts: {
      tools?: string[];
      noContextFiles?: boolean;
      noSkills?: boolean;
      skipWorkspaceSeed?: boolean;
      persistSession?: boolean;
      agentDir?: (workspace: string) => string;
      customTools?: (workspace: string) => ToolDefinition[];
    } = {},
  ) {}

  async close(): Promise<void> {
    this.unsub?.();
    this.unsub = null;
    try {
      this.session?.dispose();
    } catch {
      /* ignore */
    }
    this.session = null;
    this.dead = false;
  }

  async maybeCompact(threshold = COMPACT_THRESHOLD): Promise<boolean> {
    const session = this.session;
    if (!session || this.dead) return false;
    try {
      const usage = session.getSessionStats().contextUsage || {};
      const pct = Number(usage.percent);
      if (!Number.isFinite(pct) || pct < threshold) return false;
      await session.compact(COMPACT_INSTRUCTIONS);
      return true;
    } catch {
      return false;
    }
  }

  async run(opts: BackendRunOpts): Promise<AgentRunResult> {
    const { workspace, systemPrompt, userPrompt, model, events, maxTurns } = opts;
    opts.signal?.throwIfAborted();
    if (!this.opts.skipWorkspaceSeed) {
      try {
        seedPiWorkspace(workspace, { systemPrompt, model });
      } catch (e) {
        events.writeText(`[pi] seed_pi_workspace: ${e}`);
      }
    }

    try {
      await this.ensureSession(opts);
    } catch (e) {
      const msg = `${(e as Error).name || "Error"}: ${(e as Error).message || e}`;
      events.emit("pi_error", { error: msg });
      events.writeText(`[pi] error: ${msg}`);
      return {
        backend: this.name,
        ok: false,
        exitCode: authenticationError(msg) || /not found|not installed/i.test(msg) ? 2 : 1,
        retryable: !authenticationError(msg),
        error: msg,
        turns: events.turnCount,
        toolUses: events.toolUseCount,
        messages: events.messageCount,
      };
    }

    if (opts.signal?.aborted) {
      await this.close();
      opts.signal.throwIfAborted();
    }
    const session = this.session!;
    events.writeText(
      `[pi] starting sdk cwd=${workspace} max_turns=${maxTurns} ` +
        `continue=${Boolean(opts.continueConversation)} resume=${opts.resume || "-"}`,
    );
    events.emit("pi_start", {
      cwd: workspace,
      max_turns: maxTurns,
      model,
      continue_conversation: Boolean(opts.continueConversation),
      resume: opts.resume,
      session_id: session.sessionId,
      session_file: session.sessionFile,
      transport: "sdk",
    });

    const stats = { turns: 0, tools: 0, messages: 0, error: null as string | null, stopReason: "" };
    let aborted = false;
    this.unsub?.();
    this.unsub = session.subscribe((ev) => {
      const kind = String(ev.type || "");
      if (kind === "turn_end") {
        const message = ev.message as { stopReason?: string; stop_reason?: string; errorMessage?: string } | undefined;
        stats.stopReason = message?.stopReason || message?.stop_reason || "";
        // A provider error is a completed assistant message, not necessarily a thrown exception.
        // Reset on subsequent successful turns so SDK retries can recover normally.
        stats.error = stats.stopReason === "error" ? message?.errorMessage || "Model request failed" : null;
        stats.turns += 1;
        events.turnCount += 1;
        events.emit("pi_turn_end", {
          turn: stats.turns,
          tools: stats.tools,
          message: ev.message || null,
          toolResults: ev.toolResults || [],
        });
        if (maxTurns > 0 && stats.turns >= maxTurns && !aborted) {
          aborted = true;
          void session.abort().catch(() => undefined);
        }
      } else if (kind === "tool_execution_start") {
        stats.tools += 1;
        events.toolUseCount += 1;
        events.writeText(`[tool_use] ${ev.toolName || ""}`);
      } else if (kind === "message_end") {
        stats.messages += 1;
        events.messageCount += 1;
      } else if (kind === "auto_retry_end" && ev.success === false) {
        stats.error = String(ev.finalError || "auto_retry failed");
      } else if (kind === "message_update") {
        const delta = (ev.assistantMessageEvent || {}) as { type?: string; delta?: string };
        if (delta.type === "text_delta" && delta.delta?.trim()) {
          events.writeText(`[assistant] ${String(delta.delta).replace(/\n/g, " ").slice(0, 500)}`);
        }
      }
    });

    const abort = (): void => { void session.abort().catch(() => undefined); };
    opts.signal?.addEventListener("abort", abort, { once: true });
    try {
      await session.prompt(userPrompt);
      try {
        if (!stats.error) await this.maybeCompact();
      } catch (e) {
        events.writeText(`[pi] compact after prompt: ${e}`);
      }
    } catch (e) {
      const msg = `${(e as Error).name || "Error"}: ${(e as Error).message || e}`;
      events.emit("pi_error", { error: msg });
      events.writeText(`[pi] error: ${msg}`);
      this.persist(workspace, session);
      this.dead = true;
      try {
        await this.close();
      } catch {
        /* ignore */
      }
      return {
        backend: this.name,
        ok: false,
        exitCode: authenticationError(msg) ? 2 : 1,
        retryable: !authenticationError(msg),
        error: msg,
        turns: events.turnCount,
        toolUses: events.toolUseCount,
        messages: events.messageCount,
        extra: { session_id: session.sessionId, session_file: session.sessionFile },
      };
    } finally {
      opts.signal?.removeEventListener("abort", abort);
    }

    if (stats.error) {
      events.emit("pi_error", { error: stats.error });
      events.writeText(`[pi] error: ${stats.error}`);
    }
    this.persist(workspace, session);
    events.emit("pi_done", {
      session_id: session.sessionId,
      session_file: session.sessionFile,
      error: stats.error,
      stop_reason: stats.error ? "error" : aborted ? "turn_limit" : stats.stopReason,
      transport: "sdk",
    });
    return {
      backend: this.name,
      ok: !stats.error,
      exitCode: authenticationError(stats.error) ? 2 : stats.error ? 1 : 0,
      retryable: !authenticationError(stats.error),
      error: stats.error,
      turns: stats.turns || events.turnCount,
      toolUses: stats.tools || events.toolUseCount,
      messages: stats.messages || events.messageCount,
      extra: { session_id: session.sessionId, session_file: session.sessionFile, transport: "sdk", stop_reason: stats.error ? "error" : aborted ? "turn_limit" : stats.stopReason },
    };
  }

  private persist(workspace: string, session: SessionLike): void {
    if (this.opts.persistSession === false) return;
    try {
      saveSession(workspace, session.sessionId, {
        session_file: session.sessionFile,
        backend: "pi",
      });
    } catch {
      /* ignore */
    }
  }

  private async ensureSession(opts: BackendRunOpts): Promise<void> {
    if (this.session && !this.dead) return;
    if (this.session) await this.close();

    const { workspace, systemPrompt, model, events } = opts;
    process.env.PI_OFFLINE = process.env.PI_OFFLINE || "1";

    const sdk = await import("@earendil-works/pi-coding-agent");
    const {
      createAgentSession,
      ModelRuntime,
      SessionManager,
    } = sdk;

    const agentDir = this.opts.agentDir ? this.opts.agentDir(workspace) : piAgentDir(workspace);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const sessionsDir = join(agentDir, "sessions");
    const modelId = resolveModelId(model);
    const provider = resolveProvider();
    const thinking = resolveThinking() as ThinkingLevel;

    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const key = firstLlmKey();
    if (key) {
      try {
        await modelRuntime.setRuntimeApiKey(provider, key);
      } catch (e) {
        events.writeText(`[pi] setRuntimeApiKey: ${e}`);
      }
    }

    const { resourceLoader, settingsManager } = await loadPiResources(
      workspace, agentDir, systemPrompt, Boolean(this.opts.noContextFiles), Boolean(this.opts.noSkills),
    );
    const tools = this.opts.tools?.length ? this.opts.tools : [...SOLVER_TOOLS];

    let sessionManager;
    const resume = opts.resume ? String(opts.resume) : "";
    if (resume && existsSync(resume)) {
      sessionManager = SessionManager.open(resume, sessionsDir, workspace);
    } else if (opts.continueConversation) {
      sessionManager = SessionManager.continueRecent(workspace, sessionsDir);
    } else {
      sessionManager = SessionManager.create(workspace, sessionsDir);
    }

    const found =
      modelRuntime.getModel(provider, modelId) ||
      modelRuntime.getModels(provider).find((m) => m.id === modelId);

    events.writeText(
      `[pi] sdk createAgentSession provider=${provider} model=${modelId} thinking=${thinking} tools=${tools.join(",")}`,
    );

    const { session } = await createAgentSession({
      cwd: workspace,
      agentDir,
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager,
      thinkingLevel: thinking,
      tools,
      customTools: this.opts.customTools?.(workspace),
      ...(found ? { model: found } : {}),
    });
    this.session = session as unknown as SessionLike;
    this.dead = false;
    this.persist(workspace, this.session);
  }
}
