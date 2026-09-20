import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ClockJob = {
  started_at?: unknown;
  timeout_sec?: unknown;
  status?: unknown;
  job_kind?: unknown;
};

export function jobOverdue(job: ClockJob, nowSec = Date.now() / 1000, graceSec = 15): boolean {
  const status = String(job.status || "running");
  if (!["running", "starting"].includes(status)) return false;
  const started = Number(job.started_at);
  const timeout = Number(job.timeout_sec);
  if (!Number.isFinite(started) || started <= 0) return false;
  if (!Number.isFinite(timeout) || timeout < 60) return false;
  return nowSec >= started + timeout + Math.max(0, graceSec);
}

export function countLiveRegularInFlight(
  inFlight: Iterable<string>,
  jobsFor: (code: string) => ClockJob[],
  nowSec = Date.now() / 1000,
  graceSec = 15,
): number {
  let n = 0;
  for (const code of inFlight) {
    const jobs = jobsFor(code).filter((j) => {
      const kind = String(j.job_kind || "regular");
      return kind !== "loop" && ["queued", "starting", "running"].includes(String(j.status || "running"));
    });
    const job = jobs[jobs.length - 1];
    if (job && jobOverdue(job, nowSec, graceSec)) continue;
    n += 1;
  }
  return n;
}

export function wallRemainingMs(workspace: string, nowMs = Date.now()): number {
  const timeoutSec = Number.parseFloat(process.env.HEIMDALL_LOOP_TIMEOUT_SEC || "");
  const timeoutMs = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 1_800_000;
  let startedMs = 0;
  const stamp = join(workspace, ".heimdall", "started_at");
  if (existsSync(stamp)) {
    try {
      const sec = Number.parseFloat(readFileSync(stamp, "utf8").trim());
      if (Number.isFinite(sec) && sec > 0) startedMs = sec * 1000;
    } catch {
      startedMs = 0;
    }
  }
  if (!startedMs) startedMs = nowMs;
  return Math.max(250, startedMs + timeoutMs - nowMs);
}
