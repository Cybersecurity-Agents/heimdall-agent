import { readFileSync, readdirSync, readlinkSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const owned = new Set<string>();
export function ownLocalProcess(jobId: string): () => void {
  owned.add(jobId);
  return () => { owned.delete(jobId); };
}

export type ProcessIdentity = { pid: number; boot: string; namespace: string; start: string };
export function processIdentity(pid: number): ProcessIdentity | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (["Z", "X"].includes(fields[0]!)) return null;
    return { pid, boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      namespace: readlinkSync("/proc/self/ns/pid"),
      start: fields[19]! };
  } catch { return null; }
}

type LocalRecord = { jobId: string; identity: ProcessIdentity | null; state: "running" | "exited";
  exit: number | null; error: string | null; timedOut: boolean; owner?: string };
export function recordLocalProcess(jobDir: string, record: LocalRecord): void {
  mkdirSync(jobDir, { recursive: true });
  const path = join(jobDir, "runtime.json"), temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(record) + "\n", { mode: 0o600 });
  renameSync(temp, path);
}

/** A PID alone is insufficient after a container or host restart. */
export function inspectLocalProcess(jobId: string, jobDir: string): {
  status: "running" | "exited" | "missing" | "unknown"; exit: number | null; error?: string | null; timedOut?: boolean; owner?: string;
} {
  // The runner retains ownership while final output/children are being drained.
  if (owned.has(jobId)) return { status: "running", exit: null };
  try {
    const rec = JSON.parse(readFileSync(join(jobDir, "runtime.json"), "utf8")) as LocalRecord;
    if (rec.jobId !== jobId) return { status: "unknown", exit: null };
    if (rec.state === "exited") return { status: "exited", exit: rec.exit, error: rec.error, timedOut: rec.timedOut, owner: rec.owner };
    if (!rec.identity) return { status: "unknown", exit: null };
    const current = processIdentity(rec.identity.pid);
    if (!current) return { status: "missing", exit: null, owner: rec.owner };
    return { status: (current.pid === rec.identity.pid && current.boot === rec.identity.boot
      && current.namespace === rec.identity.namespace && current.start === rec.identity.start) ? "running" : "missing", exit: null, owner: rec.owner };
  } catch { return { status: "unknown", exit: null }; }
}

/** SDK tools may create their own process groups; retain ownership via inherited env. */
export function signalOwnedProcesses(owner: string, signal: NodeJS.Signals): void {
  if (!owner) return;
  const marker = `HEIMDALL_PROCESS_OWNER=${owner}`;
  let entries: string[];
  try { entries = readdirSync("/proc"); } catch { return; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    const identity = processIdentity(pid);
    if (!identity) continue;
    try {
      if (!readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(marker)) continue;
      // Do not signal an unrelated process if its PID was reused during inspection.
      if (processIdentity(pid)?.start === identity.start) process.kill(pid, signal);
    } catch { /* Process exited or is not owned by this runtime user. */ }
  }
}

/** Ownership identity of the control process, never just a reusable PID. */
export function startupOwnerAlive(raw: unknown): boolean | null {
  try {
    const identity = JSON.parse(String(raw || "")) as ProcessIdentity;
    if (!identity || !Number.isInteger(identity.pid) || !identity.boot || !identity.namespace || !identity.start) return null;
    const current = processIdentity(identity.pid);
    if (!current) return false;
    return current.boot === identity.boot && current.namespace === identity.namespace && current.start === identity.start;
  } catch { return null; }
}

export function stopPersistedLocal(jobId: string, jobDir: string, signal: NodeJS.Signals): boolean {
  try {
    const rec = JSON.parse(readFileSync(join(jobDir, "runtime.json"), "utf8")) as LocalRecord;
    if (rec.jobId !== jobId) return false;
    if (rec.owner) signalOwnedProcesses(rec.owner, signal);
    const current = rec.identity && processIdentity(rec.identity.pid);
    if (!current || !rec.identity || current.boot !== rec.identity.boot || current.namespace !== rec.identity.namespace || current.start !== rec.identity.start) return false;
    try { process.kill(-current.pid, signal); } catch { process.kill(current.pid, signal); }
    return true;
  } catch {
    let stopped = false;
    for (const identity of findLocalJob(jobId) || []) {
      const current = processIdentity(identity.pid);
      if (!current || current.boot !== identity.boot || current.namespace !== identity.namespace || current.start !== identity.start) continue;
      try { process.kill(current.pid, signal); stopped = true; } catch { /* Already exited. */ }
    }
    return stopped;
  }
}

/** Covers a host crash between spawn and writing runtime.json. */
export function findLocalJob(jobId: string): ProcessIdentity[] | null {
  try {
    const found: ProcessIdentity[] = [];
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        if (!readFileSync(`/proc/${name}/environ`, "utf8").split("\0").includes(`HEIMDALL_JOB_ID=${jobId}`)) continue;
        const identity = processIdentity(Number(name));
        if (identity) found.push(identity);
      } catch (error) {
        // Foreign users are unrelated; same-user process exit is routine.
        if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(String((error as NodeJS.ErrnoException).code))) return null;
      }
    }
    return found;
  } catch { return null; }
}
