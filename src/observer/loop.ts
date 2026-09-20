import { pendingRecap, readRecapState, setRecapState } from "./recap-state.js";
import { RECAP_TOOLS, runRecap } from "./recap.js";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { EventSink } from "../shared/events.js";
import { envBool, flagOn } from "../shared/env.js";
import { applyCoachLlmEnv, seedCoachAgentDir } from "../shared/pi-workspace.js";
import { jobHintText, migrateConfirmedMd } from "../shared/paths.js";
import { PiBackend } from "../agent/backends/pi.js";
import { mainLlmInFlight, writeJobFlags } from "./coach.js";
import { watchHint } from "./hint.js";
import { seedJobSteer } from "./job-steer.js";
import { prepareTick } from "./publish.js";
import { ObservationTurn, recoverObservationCursor } from "./tools.js";
import type { Backend, BackendRunOpts } from "../agent/backends/types.js";
import { acquireObserverLease } from "./lease.js";
import { loadObserverSystem } from "./system-prompt.js";

export const OBSERVER_TOOLS = ["observation_context", "observation_submit", "read", "write", "edit", "grep", "find", "ls"] as const;
const DEFAULT_EVERY = 300;
const DEFAULT_EVERY_LOOP = 660;
const DEFAULT_WARMUP = 60;
const DEFAULT_WARMUP_LOOP = 660;

export function observerEnabled(): boolean {
  return envBool("HEIMDALL_COACH", true);
}

function observerCadenceFallback(loop: boolean, regular: number, loopSec: number): number {
  return loop ? loopSec : regular;
}

export function observerEverySec(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseFloat(env.HEIMDALL_OBSERVER_EVERY_SEC || "");
  if (Number.isFinite(n)) return Math.max(30, n);
  return observerCadenceFallback(flagOn(env.HEIMDALL_LOOP), DEFAULT_EVERY, DEFAULT_EVERY_LOOP);
}

export function observerWarmupSec(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseFloat(env.HEIMDALL_OBSERVER_WARMUP_SEC || "");
  if (Number.isFinite(n)) return Math.max(30, n);
  return observerCadenceFallback(flagOn(env.HEIMDALL_LOOP), DEFAULT_WARMUP, DEFAULT_WARMUP_LOOP);
}

export function shouldTick(opts: {
  now: number;
  startedAt: number;
  lastTickTs: number;
  lastHintMtime: number;
  hintMtime: number;
  retryAt?: number;
  everySec?: number;
  warmupSec?: number;
}): boolean {
  if (opts.retryAt !== undefined) return opts.now >= opts.retryAt;
  if (opts.hintMtime && opts.hintMtime !== opts.lastHintMtime) return true;
  const later = opts.everySec ?? DEFAULT_EVERY;
  const first = opts.warmupSec ?? DEFAULT_WARMUP;
  if (opts.lastTickTs > 0) return opts.now - opts.lastTickTs >= later;
  return opts.now - opts.startedAt >= first;
}

export function observePiDir(workspace: string): string {
  return join(workspace, ".heimdall", "observe-pi");
}

export async function afterObserverTick(backend: { close?: () => Promise<void> | void }): Promise<void> {
  await backend.close?.();
}

export function seedObserverDir(workspace: string): string {
  const agent = seedCoachAgentDir(observePiDir(workspace));
  const confirmed = migrateConfirmedMd(workspace);
  if (!existsSync(confirmed)) {
    writeFileSync(confirmed, "# CONFIRMED\n\nHYPOTHESIS:\nLOCK: (none)\nCONFIRMED:\nANGLES:\n");
  }
  writeJobFlags(workspace);
  seedJobSteer(workspace);
  return agent;
}

function hintMtime(workspace: string): number {
  const p = join(workspace, "hint.txt");
  try {
    return existsSync(p) ? statSync(p).mtimeMs / 1000 : 0;
  } catch {
    return 0;
  }
}

function buildPrompt(workspace: string): string {
  const inp = join(workspace, "input.json");
  let code = process.env.UNIQUE_CODE || "";
  if (!code && existsSync(inp)) {
    try {
      code = String(JSON.parse(readFileSync(inp, "utf8")).unique_code || "");
    } catch {
      code = "";
    }
  }
  const lines = [`This job is ${code || "(unknown)"}. Ignore other unique_codes.`];
  const hint = jobHintText(workspace);
  if (hint) {
    lines.push("PLATFORM HINT:");
    lines.push(hint.slice(0, 800));
  }
  lines.push("Read observation_context, judge this fixed evidence window, then call observation_submit. Correct tool errors in this same window until ok:true confirms publication. A text reply is not publication.");
  return lines.join("\n") + "\n";
}

export async function executeObservationTick(turn: ObservationTurn, backend: Backend, opts: BackendRunOpts,
  isActive: () => boolean = () => true): Promise<boolean> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  opts.signal?.addEventListener("abort", abort, { once: true });
  if (opts.signal?.aborted) abort();
  // Interrupt a blocked model call when this job stops, loses ownership, or
  // publishes. Publication is durable before the model is interrupted.
  const guard = setInterval(() => {
    if (turn.published?.ok || !turn.isActive() || !isActive()) abort();
  }, 250);
  let prompt = opts.userPrompt;
  try {
    while (!controller.signal.aborted && turn.isActive() && isActive()) {
      let reason: string;
      let transportFailure = false;
      try {
        const run = await backend.run({ ...opts, userPrompt: prompt, maxTurns: 0, signal: controller.signal });
        reason = String(run.extra?.stop_reason || run.error || "no_submission");
        transportFailure = !run.ok;
      } catch (error) {
        reason = String(error);
        transportFailure = true;
      }
      if (turn.published?.ok) return true;
      const errors = JSON.stringify(turn.lastFailure?.errors || []);
      const stopped = controller.signal.aborted || !turn.isActive() || !isActive();
      opts.events.writeText(`[observer] ${stopped ? "interrupted" : "continuing"} unpublished window reason=${reason} submissions=${turn.attempts} errors=${errors}`);
      if (stopped) break;
      prompt = `This fixed observation window is still unpublished. Continue correcting the same judgments; call observation_context if needed. Last errors: ${errors}. Use native arrays/objects, specific non-reserved judgment IDs and actual attempt evidence. Submit until ok:true. Do not claim publication in prose or replace evidence-backed judgments with an empty update to bypass an error.`;
      // Preserve the conversation, evidence window and diagnostics. Transport
      // outages pause briefly; validation failures continue immediately.
      if (transportFailure) await delay(1000, undefined, { signal: controller.signal }).catch(() => undefined);
    }
    return Boolean(turn.published?.ok);
  } finally {
    clearInterval(guard);
    opts.signal?.removeEventListener("abort", abort);
    turn.close();
    try { await afterObserverTick(backend); }
    catch (error) { opts.events.writeText(`[observer] session cleanup failed: ${error}`); }
  }
}

export async function observerLoop(workspace: string): Promise<void> {
  if (!observerEnabled()) {
    console.log("observer_pi skip (disabled)");
    return;
  }
  applyCoachLlmEnv();
  const ws = workspace || process.env.HEIMDALL_WORKSPACE || "/workspace";
  const lease = acquireObserverLease(ws);
  if (!lease) return;
  const terminate = (): void => {
    try {
      const request = pendingRecap(ws);
      const state = readRecapState(ws);
      if (request && state?.requestId === request.id && state.status === "running") {
        setRecapState(ws, request, "failed", { error: "observer sidecar stopped before recap finished" });
      }
    } finally { lease.release(); process.exit(0); }
  };
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  console.log(`observer_pi start workspace=${ws}`);
  seedObserverDir(ws);
  process.env.PI_CODING_AGENT_DIR = observePiDir(ws);
  const events = new EventSink(join(ws, ".heimdall", "observer.events.jsonl"), join(ws, ".heimdall", "observer.log"));
  let activeTurn: ObservationTurn | null = null;
  const backend = new PiBackend({
    tools: [...OBSERVER_TOOLS],
    noSkills: true,
    noContextFiles: true,
    skipWorkspaceSeed: true,
    persistSession: false,
    agentDir: observePiDir,
    customTools: () => activeTurn!.tools(),
  });
  const recapBackend = new PiBackend({ tools: [...RECAP_TOOLS], noContextFiles: true,
    skipWorkspaceSeed: true, persistSession: false, agentDir: observePiDir });
  const system = loadObserverSystem(ws);
  const startedAt = Date.now() / 1000;
  let lastTick = 0;
  let lastHint = 0;
  const every = observerEverySec();
  const warmup = observerWarmupSec();
  events.writeText(`[observer] cadence every=${every}s warmup=${warmup}s`);
  const stop = join(ws, ".heimdall", "observer.stop");
  let failures = 0;
  let retryAt: number | undefined;
  const stopHint = watchHint(ws);
  try {
    while (!existsSync(stop)) {
      if (!lease.owns()) break;
      const recap = pendingRecap(ws);
      const recapState = readRecapState(ws);
      if (recap && (recapState?.requestId !== recap.id || recapState.status === "pending")) {
        await runRecap(ws, recap, recapBackend, events, lease.owns);
        if (recap.terminal) break;
        lastTick = Date.now() / 1000;
        failures = 0;
        retryAt = undefined;
        continue;
      }
      if (mainLlmInFlight(ws)) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      const now = Date.now() / 1000;
      const hm = hintMtime(ws);
      if (
        !shouldTick({
          now,
          startedAt,
          lastTickTs: lastTick,
          lastHintMtime: lastHint,
          hintMtime: hm,
          retryAt,
          everySec: every,
          warmupSec: warmup,
        })
      ) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      try {
        writeJobFlags(ws);
        recoverObservationCursor(ws);
        prepareTick(ws);
        activeTurn = new ObservationTurn(ws, lease.owns);
        const published = await executeObservationTick(activeTurn, backend, {
          systemPrompt: system,
          userPrompt: buildPrompt(ws),
          workspace: ws,
          permissionMode: "bypassPermissions",
          maxTurns: 0,
          model: process.env.HEIMDALL_COACH_MODEL || process.env.ANTHROPIC_MODEL || null,
          events,
        }, () => {
          const request = pendingRecap(ws), state = readRecapState(ws);
          return !request || (state?.requestId === request.id && ["published", "failed", "disabled"].includes(state.status));
        });
        if (!lease.owns()) break;
        lastTick = Date.now() / 1000;
        lastHint = hm;
        if (published) {
          failures = 0;
          retryAt = undefined;
          events.writeText(`[observer] published revision=${activeTurn.published?.revision} submissions=${activeTurn.attempts}`);
        } else {
          retryAt = lastTick;
        }
      } catch (e) {
        try {
          await afterObserverTick(backend);
        } catch {
          /* ignore */
        }
        if (!lease.owns()) break;
        activeTurn?.close();
        lastTick = Date.now() / 1000;
        lastHint = hm;
        retryAt = lastTick + 1;
        failures++;
        events.writeText(`[observer] runtime failure, retry after=${retryAt - lastTick}s: ${e}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    stopHint();
    await backend.close();
    await recapBackend.close();
    events.close();
    lease.release();
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGINT", terminate);
    try {
      unlinkSync(stop);
    } catch {
      /* ignore */
    }
  }
}
