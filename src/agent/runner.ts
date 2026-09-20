import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  decideExitCode,
  hasAnyFlag,
  hasCorrectSubmit,
  isChallengeComplete,
} from "../shared/completion.js";
import { goalSnapshot, managedGoal, renderGoalCondition } from "../shared/goal.js";
import { EventSink } from "../shared/events.js";
import { applyLoopLlmEnv, seedPiWorkspace, syncLlmEnv } from "../shared/pi-workspace.js";
import { loadHandoff } from "../shared/handoff.js";
import {
  clearSession,
  loadSession,
  sessionTranscriptsExist,
} from "../shared/session.js";
import { resolveBackend, type AgentRunResult, type Backend } from "./backends/index.js";
import { heimdallDir, loadSettings, type AgentSettings } from "./config.js";
import { flushWorkspace, watchFlags } from "./flag-flush.js";
import {
  buildSystemPrompt,
  buildUserPrompt,
  ensureWorkspaceSeed,
  loadInput,
  loopFollowupPrompt,
  withWorkspacePlaybook,
} from "./prompts.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isFatal(error?: string | null): boolean {
  const err = (error || "").toLowerCase();
  return [
    "pi cli not found",
    "not found on path",
    "not installed",
    "no module named 'claude_agent_sdk'",
    "cli_not_found",
    "clinotfound",
  ].some((k) => err.includes(k));
}

export function isSessionDead(error?: string | null): boolean {
  const err = (error || "").toLowerCase();
  if (!err || err.includes("error_max_turns")) return false;
  return [
    "fatal error in message reader",
    "messageparseerror",
    "message parse",
    "missing required field",
    "cannot write to terminated process",
    "command failed with exit code",
    "processerror",
    "cli connection",
    "closed",
    "rpc",
    "unexpected end of json",
    "max_buffer",
    "buffer size",
    "no conversation found",
    "conversation found with session",
    "unknown session",
    "session not found",
    "error_during_execution",
    "unknown provider",
    "claude-opus",
  ].some((k) => err.includes(k));
}

export function isShortUntilFlagIter(opts: {
  elapsedMs: number;
  turns?: number | null;
  tools?: number | null;
}): boolean {
  const turns = Number(opts.turns || 0) || 0;
  const tools = Number(opts.tools || 0) || 0;
  return opts.elapsedMs < 20_000 && turns <= 2 && tools <= 2;
}

export function shouldBackoffUntilFlag(shortStreak: number): boolean {
  return shortStreak >= 3;
}

async function runUntilFlag(
  settings: AgentSettings, backend: Backend, chosen: string,
  systemPrompt: string, userPrompt: string, events: EventSink, startedAt: number,
): Promise<{ result: AgentRunResult; fallbackFrom: string | null }> {
  const ws = settings.workspace;
  const native = chosen === "sdk" && process.env.HEIMDALL_GOAL_DRIVER !== "legacy";
  const managed = managedGoal(ws);
  const input = loadInput(join(ws, "input.json"));
  const handoff = loadHandoff(ws);
  const stored = loadSession(ws);
  const reusable = input.session_reusable ?? handoff.session_reusable ?? !input.instance_rotated;
  const usable = reusable && stored.backend === chosen && !stored.dead;
  let sessionId = usable ? settings.sessionId || String(stored.session_id || "") || null : null;
  let sessionFile = usable && chosen !== "sdk" ? settings.sessionFile || String(stored.session_file || "") || null : null;
  let result: AgentRunResult = { backend: chosen, ok: false, exitCode: 1 };
  let iteration = 0;
  let noProgress = 0;
  const counts = { turns: 0, toolUses: 0, messages: 0 };
  const controller = new AbortController();
  let stopReason = "";
  const stop = (reason: string) => {
    if (controller.signal.aborted) return;
    stopReason = reason;
    controller.abort(reason);
  };
  const observe = () => {
    const snapshot = goalSnapshot(ws);
    if (snapshot?.state === "cancelled") stop("operator_stop");
    else if (isChallengeComplete(ws)) stop("goal_satisfied");
    else if (snapshot?.state === "blocked" || snapshot?.state === "paused_budget") stop(snapshot.state);
    else if (managed && (!snapshot || Date.now() - snapshot.heartbeatAt > 60_000)) stop("controller_unavailable");
  };
  const deadline = setTimeout(() => stop("attempt_timeout"), Math.max(1, startedAt + Math.max(1, settings.loopTimeoutSec) * 1000 - Date.now()));
  const monitor = setInterval(observe, 500);
  const interrupted = new Promise<AgentRunResult>(resolve => controller.signal.addEventListener("abort", () => {
    Promise.resolve(backend.close?.()).catch(e => events.writeText(`[goal] close: ${e}`));
    resolve({ backend: chosen, ok: false, exitCode: 1, error: stopReason });
  }, { once: true }));
  events.writeText(`[goal] driver=${native ? "native" : "legacy"} session=${sessionId || "-"}`);
  try {
    observe();
    while (!controller.signal.aborted) {
      iteration++;
      const snapshot = goalSnapshot(ws);
      const priorTurns = events.turnCount;
      const priorTools = events.toolUseCount;
      const iterStarted = Date.now();
      events.emit("goal_attempt", { iteration, session_id: sessionId, driver: native ? "native" : "legacy" });
      const prompt = native
        ? `${userPrompt}\n\nAcceptance status: ${snapshot?.verdict.reason || "not yet satisfied"}. Continue from the current session's evidence and unfinished work.`
        : iteration > 1 ? loopFollowupPrompt(iteration, ws) : userPrompt;
      try {
        result = await Promise.race([backend.run({
          systemPrompt, userPrompt: prompt, workspace: ws, permissionMode: settings.permissionMode,
          maxTurns: settings.maxTurns, model: settings.model, events,
          resume: chosen === "sdk" ? sessionId : sessionFile || sessionId,
          continueConversation: Boolean(sessionId || sessionFile), signal: controller.signal,
          ...(native ? { goal: renderGoalCondition(ws) } : {}),
        }), interrupted]);
      } catch (e) {
        result = { backend: chosen, ok: false, exitCode: 1, error: String(e) };
      }
      counts.turns += result.turns ?? Math.max(0, events.turnCount - priorTurns);
      counts.toolUses += result.toolUses ?? Math.max(0, events.toolUseCount - priorTools);
      counts.messages += result.messages || 0;
      if (result.extra?.session_id) sessionId = String(result.extra.session_id);
      if (chosen !== "sdk" && result.extra?.session_file) sessionFile = String(result.extra.session_file);
      if (!managed && !controller.signal.aborted) await flushWorkspace(ws);
      observe();
      if (controller.signal.aborted) break;
      if (result.retryable === false || (result.exitCode === 2 && isFatal(result.error))) break;
      // Only explicit transcript/session failures justify abandoning context.
      if (/no conversation found|unknown session|session not found|messageparseerror|missing required field/i.test(result.error || "")) {
        await backend.close?.();
        sessionId = null; sessionFile = null;
        clearSession(ws, result.error || "session_lost");
      }
      noProgress = isShortUntilFlagIter({ elapsedMs: Date.now() - iterStarted, turns: result.turns, tools: result.toolUses }) ? noProgress + 1 : 0;
      if (!native) await backend.maybeCompact?.();
      // SDK native goal owns ordinary turns. We reach here only when that
      // invocation returned without satisfying the independently checked goal.
      const waitMs = Math.min(30_000, 1000 * 2 ** Math.min(5, noProgress));
      events.emit("goal_recovery", { iteration, wait_ms: waitMs, error: result.error || null, remaining: snapshot?.verdict.reason });
      await Promise.race([sleep(waitMs), interrupted]);
    }
  } finally { clearTimeout(deadline); clearInterval(monitor); }
  const complete = stopReason !== "operator_stop" && isChallengeComplete(ws);
  return { result: { ...result, ...counts, ok: complete, exitCode: complete ? 0 : result.exitCode === 2 ? 2 : 1,
    error: complete ? null : result.error || stopReason || "Goal not satisfied",
    extra: { ...result.extra, session_id: sessionId, session_file: sessionFile, loop_iterations: iteration,
      goal_driver: native ? "native" : "legacy", stop_reason: stopReason || "backend_error" } }, fallbackFrom: null };
}

export async function runAgent(settings?: AgentSettings): Promise<number> {
  try {
    applyLoopLlmEnv();
    syncLlmEnv();
  } catch {
    /* ignore */
  }
  const cfg = settings ?? loadSettings();
  mkdirSync(cfg.workspace, { recursive: true });
  mkdirSync(heimdallDir(cfg.workspace), { recursive: true });
  ensureWorkspaceSeed(cfg.workspace);

  const inputDoc = loadInput(join(cfg.workspace, "input.json"));
  let systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({
    inputDoc,
    workspace: cfg.workspace,
    uniqueCode: cfg.uniqueCode,
    attemptN: cfg.attemptN,
  });

  const t0Ms = Date.now();
  const t0 = t0Ms / 1000;
  let flagStop: (() => void) | null = null;
  const events = new EventSink(
    join(heimdallDir(cfg.workspace), "events.jsonl"),
    join(heimdallDir(cfg.workspace), "agent.log"),
    { stdout: process.env.HEIMDALL_CAPTURE_LOG === "1", jobId: process.env.HEIMDALL_JOB_ID },
  );

  let chosen = "pi";
  let backend: Backend | null = null;
  let exitCode = 1;
  try {
    try {
      const resolved = resolveBackend(cfg);
      chosen = resolved.name;
      backend = resolved.backend;
    } catch (e) {
      events.writeText(`[agent] resolve_backend: ${e}`);
      events.emit("agent_done", { error: String(e), exit_code: 2 });
      return 2;
    }

    // Both Pi and SDK: playbook lives in system. Pi also writes this into .pi/SYSTEM.md
    // and --system-prompt. Do not rely on Pi walking ancestors for CLAUDE.md (that can
    // also pick up /opt/heimdall/AGENTS.md).
    systemPrompt = withWorkspacePlaybook(systemPrompt, cfg.workspace);
    writeFileSync(
      join(heimdallDir(cfg.workspace), "agent_prompt.md"),
      "# System\n" + systemPrompt + "\n# User\n" + userPrompt,
      "utf8",
    );
    if (chosen === "pi") {
      try {
        seedPiWorkspace(cfg.workspace, { systemPrompt, model: cfg.model });
      } catch {
        /* ignore */
      }
    }

    events.writeText(
      `=== heimdall-agent backend=${chosen} code=${cfg.uniqueCode} attempt=${cfg.attemptN} loop=${Number(cfg.loop)} transport=${cfg.piTransport} ===`,
    );
    events.emit("agent_start", {
      backend_requested: cfg.backend,
      backend_chosen: chosen,
      unique_code: cfg.uniqueCode,
      attempt_n: cfg.attemptN,
      loop: cfg.loop,
      pi_transport: cfg.piTransport,
    });

    try {
      await flushWorkspace(cfg.workspace);
      flagStop = watchFlags(cfg.workspace);
      events.writeText("[flags] inbox watch started");
    } catch (exc) {
      events.writeText(`[flags] inbox watch failed to start: ${exc}`);
    }

    const { result } = await runUntilFlag(
      cfg,
      backend,
      chosen,
      systemPrompt,
      userPrompt,
      events,
      t0Ms,
    );
    exitCode = decideExitCode({
      workspace: cfg.workspace,
      backendOk: result.ok,
      backendExit: result.exitCode,
    });
    const summary = {
      agent_backend: result.backend,
      backend_requested: cfg.backend,
      fallback_from: result.fallbackFrom ?? null,
      ok: result.ok,
      exit_code: exitCode,
      backend_exit_code: result.exitCode,
      error: result.error ?? null,
      turns: result.turns ?? 0,
      tool_uses: result.toolUses ?? 0,
      messages: result.messages ?? 0,
      has_flags: hasAnyFlag(cfg.workspace),
      has_correct_submit: hasCorrectSubmit(cfg.workspace),
      unique_code: cfg.uniqueCode,
      job_id: cfg.jobId,
      attempt_n: cfg.attemptN,
      duration_sec: Math.round((Date.now() / 1000 - t0) * 1000) / 1000,
      loop: Boolean(cfg.loop),
      extra: result.extra ?? {},
    };
    writeFileSync(join(heimdallDir(cfg.workspace), "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
    events.emit("agent_done", summary);
    events.writeText(
      `=== finished backend=${result.backend} exit=${exitCode} turns=${result.turns} tools=${result.toolUses} ===`,
    );
  } finally {
    flagStop?.();
    try {
      await backend?.close?.();
    } catch {
      /* ignore */
    }
    events.close();
  }

  try {
    const summaryPath = join(heimdallDir(cfg.workspace), "summary.json");
    writeFileSync(join(cfg.workspace, "agent_summary.json"), readOrEmpty(summaryPath), "utf8");
  } catch {
    /* ignore */
  }
  return exitCode;
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "{}\n";
  }
}
