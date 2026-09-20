import { chownSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export type Acceptance =
  | { kind: "platform_flags"; requiredCount?: number }
  | { kind: "local_flags"; requiredCount: number; validatorId?: string }
  | { kind: "checks"; checkIds: string[] };

export type GoalCheck = { command: string; args: string[]; timeoutSec: number };
export type GoalConfig = {
  driver: "native_required" | "legacy";
  persistence: "until_satisfied" | "bounded";
  maxDurationSec: number;
  smallModel: string;
  checks: Record<string, GoalCheck>;
  acceptanceByCode: Record<string, Acceptance>;
};
export type GoalState = "queued" | "running" | "retry_wait" | "waiting_verification" | "blocked" | "paused_budget" | "succeeded" | "cancelled";
export type GoalSpec = {
  taskId: string;
  revision: number;
  instanceEpoch: string;
  code: string;
  objective: string;
  acceptance: Acceptance;
  persistence: GoalConfig["persistence"];
  createdAt: number;
  deadlineAt: number | null;
};
export type GoalVerdict = {
  taskId: string;
  goalRevision: number;
  instanceEpoch: string;
  state: "satisfied" | "unsatisfied" | "unknown";
  assurance: "platform_verified" | "locally_verified" | "recorded" | "none";
  checkedAt: number;
  count: number;
  requiredCount: number | null;
  reason: string;
};
export type GoalRecord = {
  spec: GoalSpec;
  state: GoalState;
  verdict: GoalVerdict;
  workspace: string;
  jobId: string | null;
  runOptions: Record<string, unknown>;
  nextRunAt: number;
  reason: string;
};
export type GoalSnapshot = { jobId: string; spec: GoalSpec; verdict: GoalVerdict; state: GoalState; heartbeatAt: number };

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function parseAcceptance(value: unknown): Acceptance {
  const raw = object(value);
  const count = raw.requiredCount;
  if (count !== undefined && (!Number.isSafeInteger(count) || Number(count) < 1)) throw new Error("goal requiredCount must be a positive integer");
  if (raw.kind === "platform_flags") return { kind: raw.kind, ...(count === undefined ? {} : { requiredCount: Number(count) }) };
  if (raw.kind === "local_flags") {
    if (raw.validatorId !== undefined && (typeof raw.validatorId !== "string" || !raw.validatorId.trim())) throw new Error("goal validatorId must name a registered check");
    return { kind: raw.kind, requiredCount: Number(count ?? 1), ...(raw.validatorId ? { validatorId: String(raw.validatorId) } : {}) };
  }
  if (raw.kind === "checks" && Array.isArray(raw.checkIds) && raw.checkIds.length && raw.checkIds.every(id => typeof id === "string" && id.trim())) {
    return { kind: raw.kind, checkIds: [...new Set(raw.checkIds as string[])] };
  }
  throw new Error("goal acceptance must be platform_flags, local_flags, or nonempty checks");
}
export function parseGoalConfig(value: unknown): GoalConfig {
  const raw = object(value);
  const driver = raw.driver ?? "native_required";
  const persistence = raw.persistence ?? "until_satisfied";
  if (driver !== "native_required" && driver !== "legacy") throw new Error("goal.driver must be native_required or legacy");
  if (persistence !== "bounded" && persistence !== "until_satisfied") throw new Error("goal.persistence must be bounded or until_satisfied");
  const maxDurationSec = Number(raw.max_duration_sec ?? 0);
  if (!Number.isFinite(maxDurationSec) || maxDurationSec < 0) throw new Error("goal.max_duration_sec must be >= 0");
  const checks: Record<string, GoalCheck> = {};
  for (const [id, value] of Object.entries(object(raw.checks))) {
    const check = object(value);
    if (typeof check.command !== "string" || !check.command.trim() || (check.args !== undefined && (!Array.isArray(check.args) || !check.args.every(a => typeof a === "string")))) throw new Error(`Invalid goal check ${id}`);
    const timeoutSec = Number(check.timeout_sec ?? 30);
    if (!Number.isFinite(timeoutSec) || timeoutSec < 1 || timeoutSec > 300) throw new Error(`goal check ${id} timeout must be 1..300 seconds`);
    checks[id] = { command: check.command, args: (check.args || []) as string[], timeoutSec };
  }
  const acceptanceByCode: Record<string, Acceptance> = {};
  for (const [code, value] of Object.entries(object(raw.acceptance_by_code))) {
    const acceptance = parseAcceptance(value);
    const ids = acceptance.kind === "checks" ? acceptance.checkIds : acceptance.kind === "local_flags" && acceptance.validatorId ? [acceptance.validatorId] : [];
    for (const id of ids) if (!checks[id]) throw new Error(`Unknown goal check ${id} for ${code}`);
    acceptanceByCode[code] = acceptance;
  }
  return { driver, persistence, maxDurationSec, smallModel: String(raw.small_model || ""), checks, acceptanceByCode };
}
export function pendingVerdict(spec: GoalSpec, reason = "Awaiting acceptance evidence"): GoalVerdict {
  return { taskId: spec.taskId, goalRevision: spec.revision, instanceEpoch: spec.instanceEpoch,
    state: "unsatisfied", assurance: "none", checkedAt: Date.now(), count: 0,
    requiredCount: spec.acceptance.kind === "checks" ? spec.acceptance.checkIds.length : spec.acceptance.requiredCount ?? null, reason };
}
export function sameGoal(spec: GoalSpec, verdict: GoalVerdict): boolean {
  return verdict.taskId === spec.taskId && verdict.goalRevision === spec.revision && verdict.instanceEpoch === spec.instanceEpoch;
}
export function goalDir(workspace: string): string { return join(workspace, ".heimdall", "goal"); }
export function atomicJson(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  let previous: ReturnType<typeof lstatSync> | null = null;
  try { previous = lstatSync(path); } catch { /* first write */ }
  try {
    writeFileSync(temp, JSON.stringify(value) + "\n", { mode: previous?.isFile() ? previous.mode & 0o777 : 0o644, flag: "wx" });
    if (previous?.isFile()) try { chownSync(temp, previous.uid, previous.gid); } catch { /* unprivileged writer retains its identity */ }
    renameSync(temp, path);
  }
  finally { try { unlinkSync(temp); } catch { /* renamed */ } }
}
export function readJsonObject(path: string): Record<string, unknown> {
  try { return object(JSON.parse(readFileSync(path, "utf8"))); } catch { return {}; }
}
export function goalSnapshot(workspace: string): GoalSnapshot | null {
  const raw = readJsonObject(join(goalDir(workspace), "status.json"));
  const input = readJsonObject(join(workspace, "input.json"));
  const snap = raw as unknown as GoalSnapshot;
  if (!snap.spec || !snap.verdict || snap.jobId !== input.job_id || !sameGoal(snap.spec, snap.verdict)) return null;
  return snap;
}
export function managedGoal(workspace: string): boolean {
  return readJsonObject(join(workspace, "input.json")).goal_managed === true;
}

/** Shared-volume RPC works in local, Docker and VPN network namespaces. The
 * controller never trusts replies/snapshots as evidence; they are UI projections. */
export async function goalRequest(workspace: string, op: "status" | "check" | "submit", flag?: string): Promise<Record<string, unknown>> {
  const input = readJsonObject(join(workspace, "input.json"));
  if (!input.goal_managed || !input.job_id) throw new Error("No managed goal in this workspace");
  const dir = goalDir(workspace);
  const id = randomUUID();
  const request = join(dir, "requests", `${id}.json`);
  const response = join(dir, "responses", `${id}.json`);
  mkdirSync(join(dir, "requests"), { recursive: true });
  atomicJson(request, { jobId: input.job_id, op, flag });
  const deadline = Date.now() + 45_000;
  try {
    while (Date.now() < deadline) {
      if (existsSync(response)) {
        const result = readJsonObject(response);
        if (result.error) throw new Error(String(result.error));
        return result;
      }
      await delay(100);
    }
    throw new Error("Goal controller unavailable; acceptance remains unknown");
  } finally {
    for (const path of [request, response]) try { unlinkSync(path); } catch { /* consumed */ }
  }
}

export function renderGoalCondition(workspace: string): string {
  const snap = goalSnapshot(workspace);
  const condition = snap?.spec.objective || "Obtain and submit every required flag for the current authorized task";
  return `${condition}. Run heimdall-goal check --json and surface its output. Completion requires state=satisfied for the current task, goal revision and instance. A candidate string, an unverified claim, or partial flags do not complete the goal. Follow input.json and the workspace playbook; continue unfinished work.`;
}
