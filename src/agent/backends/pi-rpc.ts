import { startLlmAdapter, type LlmAdapterProxy } from "../../shared/llm-request-adapter.js";
import { resolveLlmOptions, type LlmOptions } from "../../shared/llm-options.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { wallRemainingMs } from "../../policy/job-clock.js";
import { createInterface } from "node:readline";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  piAgentDir, buildModelsDoc, resolveBaseUrl,
  resolveModelId,
  resolveProvider,
  seedPiWorkspace,
  SOLVER_TOOLS,
} from "../../shared/pi-workspace.js";
import { saveSession } from "../../shared/session.js";
import type { EventSink } from "../../shared/events.js";
import type { AgentRunResult, Backend, BackendRunOpts } from "./types.js";

const COMPACT_INSTRUCTIONS =
  "Keep the CTF goal, live addresses, LOCK/hint, " +
  "working exploit path, failed oracles, and the next step. " +
  "Drop raw tool dumps and repeated recon.";

type RpcMsg = Record<string, unknown>;

function whichPi(): string[] {
  const raw = (process.env.HEIMDALL_PI_CLI || "").trim();
  if (!raw) return ["pi"];
  if (raw.endsWith(".py")) return [process.env.HEIMDALL_PYTHON || "python3", "-u", raw];
  return [raw];
}

class PiRpc {
  sessionId: string | null = null;
  sessionFile: string | null = null;
  dead = false;
  private q: RpcMsg[] = [];
  private waiters: Array<(v: RpcMsg | null) => void> = [];
  private stderrChunks: string[] = [];

  constructor(
    readonly proc: ChildProcessWithoutNullStreams,
    readonly events: EventSink | null,
    readonly tuning: LlmOptions,
  ) {
    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      const text = line.trim();
      if (!text) return;
      try {
        this.push(JSON.parse(text) as RpcMsg);
      } catch {
        /* ignore non-json */
      }
    });
    proc.stderr.on("data", (buf: Buffer) => {
      this.stderrChunks.push(buf.toString("utf8"));
      if (this.stderrChunks.join("").length > 8000) {
        this.stderrChunks = [this.stderrChunks.join("").slice(-4000)];
      }
    });
    proc.on("close", () => {
      this.dead = true;
      this.push(null);
    });
  }

  stderrTail(): string {
    return this.stderrChunks.join("").slice(-2000);
  }

  private push(msg: RpcMsg | null): void {
    const w = this.waiters.shift();
    if (w) w(msg);
    else if (msg) this.q.push(msg);
  }

  private next(timeoutMs: number | null): Promise<RpcMsg | null> {
    if (this.q.length) return Promise.resolve(this.q.shift()!);
    if (this.dead) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              const i = this.waiters.indexOf(resolve);
              if (i >= 0) this.waiters.splice(i, 1);
              reject(new Error("pi rpc timeout"));
            }, timeoutMs);
      this.waiters.push((v) => {
        if (timer) clearTimeout(timer);
        resolve(v);
      });
    });
  }

  send(cmd: RpcMsg): void {
    if (this.dead || !this.proc.stdin.writable) throw new Error("pi rpc stdin closed");
    this.proc.stdin.write(JSON.stringify(cmd) + "\n");
  }

  async request(cmd: RpcMsg, timeoutMs = 15_000): Promise<RpcMsg> {
    const id = String(cmd.id || `req-${Math.random().toString(16).slice(2, 12)}`);
    cmd.id = id;
    this.send(cmd);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`pi rpc ${cmd.type} timeout`);
      const ev = await this.next(remaining);
      if (ev === null) throw new Error(this.stderrTail() || "pi rpc closed");
      this.note(ev);
      if (ev.type === "response" && String(ev.id || "") === id) return ev;
    }
  }

  note(ev: RpcMsg): void {
    const kind = String(ev.type || "");
    if (kind === "message_update" && this.events) {
      const delta = (ev.assistantMessageEvent || {}) as { type?: string; delta?: string };
      if (delta.type === "text_delta" && delta.delta?.trim()) {
        this.events.writeText(`[assistant] ${String(delta.delta).replace(/\n/g, " ").slice(0, 500)}`);
      }
    }
  }

  async refreshState(timeoutMs = 15_000): Promise<void> {
    const resp = await this.request({ type: "get_state" }, timeoutMs);
    const data = (resp.data && typeof resp.data === "object" ? resp.data : {}) as RpcMsg;
    const sid = data.sessionId || data.session_id;
    const sfile = data.sessionFile || data.session_file;
    if (sid) this.sessionId = String(sid);
    if (sfile) this.sessionFile = String(sfile);
  }

  async prompt(
    message: string,
    maxTurns: number,
    timeoutMs?: number,
  ): Promise<{ turns: number; tools: number; messages: number; error: string | null }> {
    const resp = await this.request({ type: "prompt", message }, 60_000);
    if (!resp.success) {
      return { turns: 0, tools: 0, messages: 0, error: String(resp.error || "prompt rejected") };
    }
    return this.waitSettled(maxTurns, timeoutMs);
  }

  async waitSettled(
    maxTurns: number,
    timeoutMs?: number,
  ): Promise<{ turns: number; tools: number; messages: number; error: string | null }> {
    const stats = { turns: 0, tools: 0, messages: 0, error: null as string | null };
    let aborted = false;
    const deadline = timeoutMs && timeoutMs > 0 ? Date.now() + timeoutMs : 0;
    while (true) {
      const remaining = deadline ? deadline - Date.now() : null;
      if (remaining !== null && remaining <= 0) {
        try {
          await this.request({ type: "abort" }, 5_000);
        } catch {
          /* ignore */
        }
        this.close();
        stats.error = "pi rpc wall timeout";
        return stats;
      }
      let ev: RpcMsg | null;
      try {
        ev = await this.next(remaining !== null ? Math.max(250, remaining) : null);
      } catch (e) {
        try {
          await this.request({ type: "abort" }, 5_000);
        } catch {
          /* ignore */
        }
        this.close();
        stats.error = String((e as Error).message || "pi rpc wall timeout");
        return stats;
      }
      if (ev === null) throw new Error(`pi rpc closed before agent_settled ${this.stderrTail()}`.trim());
      const kind = String(ev.type || "");
      this.note(ev);
      if (kind === "turn_end") {
        stats.turns += 1;
        if (this.events) this.events.turnCount += 1;
        if (maxTurns > 0 && stats.turns >= maxTurns && !aborted) {
          aborted = true;
          try {
            // Continue consuming events here: request() would discard an already queued agent_settled.
            this.send({ type: "abort" });
          } catch {
            /* ignore */
          }
        }
      } else if (kind === "tool_execution_start") {
        stats.tools += 1;
        if (this.events) {
          this.events.toolUseCount += 1;
          this.events.writeText(`[tool_use] ${ev.toolName || ""}`);
        }
      } else if (kind === "message_end") {
        stats.messages += 1;
        if (this.events) this.events.messageCount += 1;
      } else if (kind === "auto_retry_end" && ev.success === false) {
        stats.error = String(ev.finalError || "auto_retry failed");
      } else if (kind === "agent_settled") {
        return stats;
      }
    }
  }

  async maybeCompact(threshold = this.tuning.compactPct): Promise<boolean> {
    if (!this.tuning.compactEnabled) return false;
    if (this.dead) return false;
    try {
      const resp = await this.request({ type: "get_session_stats" }, 15_000);
      const data = (resp.data && typeof resp.data === "object" ? resp.data : {}) as RpcMsg;
      const usage = (data.contextUsage && typeof data.contextUsage === "object"
        ? data.contextUsage
        : {}) as { percent?: unknown };
      const pct = Number(usage.percent);
      if (!Number.isFinite(pct) || pct < threshold) return false;
      this.events?.writeText(`[pi] compact context=${pct.toFixed(1)}%`);
      const done = await this.request(
        { type: "compact", customInstructions: COMPACT_INSTRUCTIONS },
        180_000,
      );
      return Boolean(done.success);
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.dead) return;
    this.dead = true;
    try {
      this.send({ type: "abort" });
    } catch {
      /* ignore */
    }
    try {
      this.proc.stdin.end();
    } catch {
      /* ignore */
    }
    this.proc.kill("SIGTERM");
  }
}

export class PiRpcBackend implements Backend {
  name = "pi";
  private adapter: LlmAdapterProxy | null = null;
  private rpc: PiRpc | null = null;

  async close(): Promise<void> {
    this.rpc?.close();
    this.rpc = null;
    await this.adapter?.close();
    this.adapter = null;
  }

  async maybeCompact(threshold?: number): Promise<boolean> {
    if (!this.rpc || this.rpc.dead) return false;
    return this.rpc.maybeCompact(threshold);
  }

  async run(opts: BackendRunOpts): Promise<AgentRunResult> {
    const { workspace, systemPrompt, model, events, userPrompt, maxTurns } = opts;
    try { resolveLlmOptions(process.env, resolveModelId(model), "pi"); }
    catch (error) { return { backend: this.name, ok: false, exitCode: 2, retryable: false, error: String(error) }; }
    try {
      seedPiWorkspace(workspace, { systemPrompt, model });
    } catch (e) {
      events.writeText(`[pi] seed_pi_workspace: ${e}`);
    }
    try {
      await this.ensureRpc(opts);
    } catch (e) {
      await this.close();
      const msg = `${(e as Error).name || "Error"}: ${(e as Error).message || e}`;
      events.emit("pi_error", { error: msg });
      events.writeText(`[pi] error: ${msg}`);
      const hard = /not found/i.test(msg);
      return { backend: this.name, ok: false, exitCode: hard ? 2 : 1, error: msg };
    }
    const rpc = this.rpc!;
    events.writeText(
      `[pi] starting rpc cwd=${workspace} max_turns=${maxTurns} continue=${Boolean(opts.continueConversation)} resume=${opts.resume || "-"}`,
    );
    events.emit("pi_start", {
      cwd: workspace,
      transport: "rpc",
      session_id: rpc.sessionId,
      session_file: rpc.sessionFile,
    });
    try {
      const stats = await rpc.prompt(userPrompt, maxTurns, wallRemainingMs(workspace));
      try {
        await rpc.maybeCompact();
      } catch {
        /* ignore */
      }
      this.persist(workspace, rpc);
      events.emit("pi_done", {
        session_id: rpc.sessionId,
        session_file: rpc.sessionFile,
        error: stats.error,
        transport: "rpc",
      });
      return {
        backend: this.name,
        ok: !stats.error,
        exitCode: stats.error ? 1 : 0,
        error: stats.error,
        turns: stats.turns,
        toolUses: stats.tools,
        messages: stats.messages,
        extra: { session_id: rpc.sessionId, session_file: rpc.sessionFile, transport: "rpc" },
      };
    } catch (e) {
      const msg = `${(e as Error).name || "Error"}: ${(e as Error).message || e}`;
      events.emit("pi_error", { error: msg });
      events.writeText(`[pi] error: ${msg}`);
      this.persist(workspace, rpc);
      if (rpc.dead) {
        rpc.close();
        this.rpc = null;
      }
      return {
        backend: this.name,
        ok: false,
        exitCode: 1,
        error: msg,
        extra: { session_id: rpc.sessionId, session_file: rpc.sessionFile, transport: "rpc" },
      };
    }
  }

  private persist(workspace: string, rpc: PiRpc): void {
    try {
      saveSession(workspace, rpc.sessionId, {
        session_file: rpc.sessionFile,
        backend: "pi",
      });
    } catch {
      /* ignore */
    }
  }

  private async ensureRpc(opts: BackendRunOpts): Promise<void> {
    if (this.rpc && !this.rpc.dead) return;
    await this.close();

    const agentDir = piAgentDir(opts.workspace);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_OFFLINE = process.env.PI_OFFLINE || "1";
    const modelId = resolveModelId(opts.model);
    const provider = resolveProvider();
    const tuning = resolveLlmOptions(process.env, modelId, "pi");
    const upstream = resolveBaseUrl();
    if (upstream) {
      this.adapter = await startLlmAdapter(upstream, tuning);
      writeFileSync(join(agentDir, "models.json"), JSON.stringify(buildModelsDoc({ modelId, provider, baseUrl: this.adapter.baseUrl, env: { ...process.env, HEIMDALL_LLM_API: tuning.protocol } })));
    }
    const thinking = tuning.thinking;
    opts.events.emit("llm_config", { effective_config: tuning });
    const tools = SOLVER_TOOLS.join(",");
    const cmd = [
      ...whichPi(),
      "--mode",
      "rpc",
      "-a",
      "--provider",
      provider,
      "--model",
      modelId,
      "--thinking",
      thinking,
      "--tools",
      tools,
      "--session-dir",
      join(agentDir, "sessions"),
    ];
    const prompt = (opts.systemPrompt || "").trim();
    if (prompt) cmd.push("--system-prompt", prompt);
    // Playbook is already inlined into --system-prompt. Skip cwd/ancestor CLAUDE.md / AGENTS.md.
    cmd.push("--no-context-files");
    if (opts.resume) cmd.push("--session", String(opts.resume));

    opts.events.writeText(
      `[pi] rpc exec: ${cmd[0]} --mode rpc provider=${provider} model=${modelId} thinking=${thinking}`,
    );
    const [bin, ...args] = cmd;
    const proc = spawn(bin!, args, {
      cwd: opts.workspace,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rpc = new PiRpc(proc as ChildProcessWithoutNullStreams, opts.events, tuning);
    try {
      await rpc.refreshState(30_000);
    } catch (e) {
      const err = rpc.stderrTail() || String(e);
      rpc.close();
      throw new Error(err);
    }
    for (const type of ["set_auto_compaction", "set_auto_retry"]) {
      try {
        await rpc.request({ type, enabled: type === "set_auto_compaction" ? tuning.compactEnabled : true }, 10_000);
      } catch {
        /* ignore */
      }
    }
    this.rpc = rpc;
    this.persist(opts.workspace, rpc);
  }
}

export function repoRootFromHere(): string {
  return dirname(fileURLToPath(new URL("../../..", import.meta.url)));
}

export function fakePiRpcPath(): string | null {
  const p = join(repoRootFromHere(), "tests", "fixtures", "fake_pi_rpc.py");
  return existsSync(p) ? p : null;
}
