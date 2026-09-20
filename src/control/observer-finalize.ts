import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "../shared/config.js";
import type { Database } from "../shared/db.js";
import { clearProxyEnv } from "../shared/network-env.js";
import { observerLeaseActive } from "../observer/lease.js";
import { currentJobId, pendingRecap, readRecord, readRecapState, requestTerminalRecap, setRecapState, type RecapRequest } from "../observer/recap-state.js";

// Separate from solver slots. The durable request/state files survive this map.
const workers = new Map<string, Promise<void>>();
const MAX_WORKERS = 2;

/** Enqueue a durable recap; callers must not await it on the solver completion path. */
export function runObserverFinalizer(cfg: Config, workspace: string, request: RecapRequest): Promise<void> {
  const key = resolve(workspace);
  if (workers.has(key)) return workers.get(key)!;
  if (currentJobId(workspace) !== request.jobId || pendingRecap(workspace)?.id !== request.id) return Promise.resolve();
  const state = readRecapState(workspace);
  if (state?.requestId === request.id && state.status === "published") return Promise.resolve();
  const env: NodeJS.ProcessEnv = { ...process.env };
  cfg.tools_env.mergeInto(env as Record<string, string>, { overwrite: true });
  const input = readRecord<{ unique_code?: string }>(join(workspace, "input.json"));
  Object.assign(env, { HEIMDALL_WORKSPACE: workspace, HEIMDALL_JOB_ID: request.jobId, HEIMDALL_RECAP_REQUEST_ID: request.id,
    HEIMDALL_REPO_ROOT: cfg.repo_root, UNIQUE_CODE: input?.unique_code || request.receipts[0]?.code || "" });
  clearProxyEnv(env);
  if (cfg.observe_enabled === false || ["0", "false", "no", "off"].includes(String(env.HEIMDALL_COACH || "").toLowerCase())) {
    if (state?.requestId !== request.id || state.status !== "disabled") setRecapState(workspace, request, "disabled");
    return Promise.resolve();
  }
  // A surviving worker after daemon restart, or the sidecar, already owns it.
  if (observerLeaseActive(workspace) || workers.size >= MAX_WORKERS) return Promise.resolve();
  const work = Promise.resolve().then(() => new Promise<void>((done) => {
    let fd: number | undefined;
    let finished = false;
    const finish = (error?: string): void => {
      if (finished) return;
      finished = true;
      try {
        const current = readRecapState(workspace);
        if (error && pendingRecap(workspace)?.id === request.id && current?.status !== "published") {
          setRecapState(workspace, request, "failed", { error });
        }
      } catch (writeError) { console.warn(`[observer] status write failed: ${writeError}`); }
      finally { done(); } // Recovery retries unpublished requests on its next pass.
    };
    try {
      fd = openSync(join(workspace, ".heimdall", "observer.log"), "a");
      const proc = spawn(process.execPath, [join(cfg.repo_root, "dist", "observer", "main.js"), "--finalize"], {
        cwd: workspace, env, detached: true, stdio: ["ignore", fd, fd],
      });
      proc.once("error", error => finish(error.message));
      proc.once("close", code => finish(code === 0 ? undefined : `observer finalizer exited ${code}`));
      // Logs go directly to disk. CLI exit/daemon restart must not kill the recap.
      proc.unref();
    } catch (error) { finish(String(error)); }
    finally { if (fd !== undefined) try { closeSync(fd); } catch { /* Already closed. */ } }
  })).finally(() => { workers.delete(key); });
  workers.set(key, work);
  return work;
}

/** Retry interrupted/failed terminal recaps, including the crash before request creation. */
export function recoverObserverFinalizers(cfg: Config, db: Database): void {
  for (const status of ["succeeded", "timeout"]) {
    for (const job of db.listJobs({ status, limit: -1 })) {
      const ws = String(job.workspace_path || ""), jobId = String(job.id || "");
      if (!ws || currentJobId(ws) !== jobId) continue;
      try {
        let request = pendingRecap(ws);
        if (!request?.terminal) {
          // A timed-out attempt that will continue is not a terminal task.
          const goal = db.getGoal(ws);
          if (goal && ["running", "waiting_verification", "retry_wait", "cancelled"].includes(goal.state)) continue;
          request = requestTerminalRecap(ws, jobId, status);
        }
        if (request) void runObserverFinalizer(cfg, ws, request).catch(error => console.warn(`[observer] recovery: ${error}`));
      } catch (error) { console.warn(`[observer] recovery ${jobId}: ${error}`); }
    }
  }
}
