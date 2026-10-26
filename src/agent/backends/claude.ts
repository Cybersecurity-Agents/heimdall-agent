import { startLlmAdapter, type LlmAdapterProxy } from "../../shared/llm-request-adapter.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolveLlmOptions, claudeThinkingOptions } from "../../shared/llm-options.js";
import { join } from "node:path";
import {
  claudeAutocompactEnv,
  resolveModelId,
  sdkInheritAgents,
  sdkModelId,
  sdkModelOverrides,
} from "../../shared/pi-workspace.js";
import { claudeConfigDir, saveSession } from "../../shared/session.js";
import { withWorkspacePlaybook } from "../prompts.js";
import type { AgentRunResult, Backend, BackendRunOpts } from "./types.js";
import type { Options, Query, PermissionMode } from "@anthropic-ai/claude-agent-sdk";

function resolveSdkModel(model: string | null): string | null {
  return sdkModelId(model) || null;
}

export function seedClaudeWorkspace(
  workspace: string,
  model?: string | null,
): { cfgDir: string; settings: Record<string, unknown> } {
  const cfgDir = claudeConfigDir(workspace);
  mkdirSync(cfgDir, { recursive: true });
  mkdirSync(join(workspace, ".claude"), { recursive: true });
  const modelId = resolveSdkModel(resolveModelId(model)) || resolveModelId(model);
  const tuning = resolveLlmOptions(process.env, modelId, "sdk");
  const settings: Record<string, unknown> = {
    model: modelId,
    alwaysThinkingEnabled: tuning.thinkingMode !== "disabled",
    env: claudeAutocompactEnv(modelId),
    modelOverrides: sdkModelOverrides(modelId),
    agents: sdkInheritAgents(),
    // Playbook is inlined into systemPrompt. Do not also attach CLAUDE.md as user claudeMd.
    claudeMdExcludes: ["**/CLAUDE.md", join(workspace, "CLAUDE.md")],
  };
  const blob = JSON.stringify(settings, null, 2) + "\n";
  for (const dest of [join(cfgDir, "settings.json"), join(workspace, ".claude", "settings.json")]) {
    try {
      writeFileSync(dest, blob);
    } catch {
      /* ignore */
    }
  }
  return { cfgDir, settings };
}

export class ClaudeBackend implements Backend {
  name = "sdk";
  private active: Query | null = null;
  private controller: AbortController | null = null;

  close(): void {
    this.controller?.abort();
    this.active?.close();
    this.active = null;
    this.controller = null;
  }

  async run(opts: BackendRunOpts): Promise<AgentRunResult> {
    let query: typeof import("@anthropic-ai/claude-agent-sdk").query;
    try {
      const mod = await import("@anthropic-ai/claude-agent-sdk");
      query = mod.query;
    } catch (e) {
      return {
        backend: this.name,
        ok: false,
        exitCode: 2,
        error: `claude-agent-sdk not installed: ${e}`,
      };
    }
    let tuning: ReturnType<typeof resolveLlmOptions>;
    try { tuning = resolveLlmOptions(process.env, sdkModelId(resolveModelId(opts.model)), "sdk"); }
    catch (error) { return { backend: this.name, ok: false, exitCode: 2, retryable: false, error: String(error) }; }
    let sdkSettings: Options["settings"] = join(claudeConfigDir(opts.workspace), "settings.json");
    try {
      sdkSettings = seedClaudeWorkspace(opts.workspace, opts.model).settings as Options["settings"];
    } catch {
      /* ignore */
    }
    const thinking = tuning.thinking;
    const modelId = resolveSdkModel(resolveModelId(opts.model)) || undefined;
    const systemPrompt = withWorkspacePlaybook(opts.systemPrompt, opts.workspace) +
      (opts.goal ? `\n\n# Current task context\n${opts.userPrompt}` : "");
    const controller = new AbortController();
    this.controller = controller;
    const abort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) abort();
    const before = { turns: opts.events.turnCount, tools: opts.events.toolUseCount, messages: opts.events.messageCount };
    const counts = () => ({ turns: opts.events.turnCount - before.turns, toolUses: opts.events.toolUseCount - before.tools, messages: opts.events.messageCount - before.messages });
    opts.events.writeText(
      `[sdk] starting query cwd=${opts.workspace} max_turns=${opts.maxTurns} thinking=${thinking} compact=${tuning.compactPct}%`,
    );
    opts.events.emit("sdk_start", {
      cwd: opts.workspace,
      max_turns: opts.maxTurns,
      model: modelId,
      thinking,
      context_window: tuning.contextWindow,
      compact_pct: tuning.compactPct,
      effective_config: tuning,
      goal_driver: opts.goal ? "native" : "none",
    });
    let sessionId = opts.resume || null;
    let resultSubtype: string | null = null;
    let resultIsError = false;
    let lastResult: string | null = null;
    let error: string | null = null;
    let goalUnavailable = false;
    let adapter: LlmAdapterProxy | undefined;
    try {
      adapter = await startLlmAdapter(process.env.ANTHROPIC_BASE_URL || process.env.HEIMDALL_LLM_BASE_URL || "https://api.anthropic.com", tuning);
      const options: Options = {
        ...claudeThinkingOptions(tuning),
        cwd: opts.workspace,
        systemPrompt,
        permissionMode: opts.permissionMode as PermissionMode,
        allowDangerouslySkipPermissions: opts.permissionMode === "bypassPermissions",
        abortController: controller,
        // Keep the seeded workspace skills/hooks; playbook exclusions above
        // prevent CLAUDE.md being duplicated in the prompt.
        settingSources: ["project"],
        skills: "all",
        includePartialMessages: false,
        settings: sdkSettings,
        agents: sdkInheritAgents(),
        env: {
          ...process.env,
          ...claudeAutocompactEnv(modelId),
          ANTHROPIC_BASE_URL: adapter.baseUrl,
        },
      };
      if (opts.maxTurns > 0) options.maxTurns = opts.maxTurns;
      if (modelId) options.model = modelId;
      if (opts.continueConversation && !opts.resume) options.continue = true;
      if (opts.resume) options.resume = opts.resume;
      this.active = query({ prompt: opts.goal ? `/goal ${opts.goal}` : opts.userPrompt, options });
      for await (const message of this.active) {
        opts.events.onMessage(message);
        const rec = message as {
          type?: string;
          session_id?: string;
          sessionId?: string;
          subtype?: string;
          is_error?: boolean;
          isError?: boolean;
          result?: unknown;
          errors?: string[];
          slash_commands?: string[];
          value?: unknown;
        };
        if (opts.goal && rec.type === "system" && rec.subtype === "init" && !rec.slash_commands?.includes("goal")) {
          goalUnavailable = true;
          throw new Error("Native /goal is unavailable in the installed CLI or disabled by policy");
        }
        if (rec.type === "active_goal") opts.events.emit("sdk_goal", { value: rec.value ?? null });
        if (opts.goal && rec.type === "assistant") {
          const content = "message" in message ? message.message as { content?: Array<{ text?: string }> } : null;
          const text = content?.content?.map(b => b.text || "").join("\n") || "";
          if (/\/goal (?:can't run|is only available)|hooks are restricted|Unknown (?:slash )?command.*goal/i.test(text)) {
            goalUnavailable = true; throw new Error(text);
          }
        }
        const sid = rec.session_id || rec.sessionId;
        if (sid) {
          sessionId = String(sid);
          saveSession(opts.workspace, sessionId, { backend: "sdk" });
        }
        if (rec.type === "result" || String(rec.type || "").toLowerCase().includes("result")) {
          resultSubtype = rec.subtype ? String(rec.subtype) : null;
          if (rec.is_error || rec.isError) resultIsError = true;
          if (rec.result != null) lastResult = String(rec.result);
          else if (rec.errors?.length) lastResult = rec.errors.join("; ");
        }
      }
    } catch (e) {
      const msg = `${(e as Error).name || "Error"}: ${(e as Error).message || e}`;
      error = msg;
      opts.events.emit("sdk_error", { error: msg });
      opts.events.writeText(`[sdk] error: ${msg}`);
    } finally {
      opts.signal?.removeEventListener("abort", abort);
      this.active?.close();
      this.active = null;
      this.controller = null;
      await adapter?.close();
    }
    let ok = !error && !resultIsError && resultSubtype !== null && !controller.signal.aborted;
    if (resultSubtype && ["error", "error_during_execution", "error_max_turns", "error_max_budget_usd"].includes(resultSubtype.toLowerCase())) {
      ok = false;
    }
    opts.events.emit("sdk_done", {
      subtype: resultSubtype,
      is_error: resultIsError,
      result: lastResult ? lastResult.slice(0, 500) : null,
    });
    const message = error || lastResult || resultSubtype || "SDK ended without a result";
    const permanent = goalUnavailable || /authentication_error|invalid.api.key|API Error: (401|403)|credit balance|model.*(?:not found|not available)|not installed/i.test(message);
    return {
      backend: this.name,
      ok,
      exitCode: ok ? 0 : permanent ? 2 : 1,
      retryable: !permanent,
      error: ok ? null : message,
      ...counts(),
      extra: { result_subtype: resultSubtype, session_id: sessionId, goal_driver: opts.goal ? "native" : "none", aborted: controller.signal.aborted },
    };
  }
}
