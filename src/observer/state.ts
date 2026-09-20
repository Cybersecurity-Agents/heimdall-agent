import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { publishedArtifact } from "../shared/observation-publication.js";
import { currentJobId } from "./recap-state.js";
import { type Assessment, type Guidance, type LootItem, type ObservationSubmit, type Issue, ObservationValidationError } from "./contract.js";
import type { Evidence } from "../shared/observer-contract.js";
import { parseObserverDag } from "./schema.js";

export type ObservationCursor = { events_byte: number; http_byte: number; turns_byte: number };
export type ObservationState = {
  version: 1; jobId: string; revision: string | null; submissionHash: string | null;
  assessments: Assessment[]; retired: Assessment[]; guidance: Guidance; loot: LootItem[]; cursor: ObservationCursor;
};

export function loadObservation(ws: string): ObservationState {
  const empty: ObservationState = { version: 1, jobId: currentJobId(ws), revision: null, submissionHash: null,
    assessments: [], retired: [], loot: [], cursor: { events_byte: 0, http_byte: 0, turns_byte: 0 },
    guidance: { hypothesis: null, lock: null, angleIds: [], confirmedIds: [], tension: [] } };
  const path = publishedArtifact(ws, "observation.json");
  if (existsSync(path)) {
    const state = JSON.parse(readFileSync(path, "utf8")) as ObservationState;
    if (state.version !== 1) throw new Error("unsupported observation state version");
    return state.jobId === empty.jobId ? state : empty;
  }
  // Import only a validated publication from the same job, never a failed model draft.
  try {
    const graph = JSON.parse(readFileSync(join(ws, ".heimdall/traffic/graph.json"), "utf8"));
    if (graph.publication?.jobId !== empty.jobId) return empty;
    const dag = parseObserverDag({ schemaVersion: graph.schemaVersion,
      nodes: graph.view.nodes.map((n: Record<string, unknown>) => ({
        id: n.id, kind: n.group, label: n.label, coverage: n.coverage, api: n.api,
        summary: n.summary, evidenceRefs: n.evidenceRefs, steps: n.steps,
      })), edges: graph.view.edges });
    const imported = dag.nodes.filter(n => ["direction", "scan", "endpoint", "path"].includes(n.kind) && /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(n.id));
    const importedIds = new Set(imported.map(n => n.id));
    empty.assessments = imported.map(n => ({ id: n.id, subject: String(n.label),
        status: (["inferred-open", "tried-hit", "tried-miss", "scan-class"].includes(n.coverage) ? n.coverage : n.steps.length ? "tried-hit" : "inferred-open") as Assessment["status"],
        role: (n.kind === "scan" ? "direction" : n.kind) as Assessment["role"], ...(typeof n.api === "string" ? { api: n.api } : {}), ...n.summary,
        evidenceRefs: n.evidenceRefs, attempts: n.steps, dependsOn: dag.edges.filter(e => e.to === n.id && importedIds.has(e.from)).map(e => e.from) }));
    empty.guidance.angleIds = empty.assessments.filter(a => a.status === "inferred-open").slice(0, 4).map(a => a.id);
    empty.guidance.confirmedIds = empty.assessments.filter(a => a.attempts.length).slice(-8).map(a => a.id);
  } catch { /* First structured publication can start with evidence and no historical graph. */ }
  return empty;
}

export function submissionHash(request: ObservationSubmit, cursor: ObservationCursor): string {
  // Object key order must not turn an identical retry into a second publication.
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : value;
  return createHash("sha256").update(JSON.stringify(stable({ request, cursor }))).digest("hex");
}

export function mergeObservation(base: ObservationState, request: ObservationSubmit, evidence: Record<string, Evidence>, dictionaryEnabled: boolean): ObservationState {
  const errors: Issue[] = [];
  const fail = (path: string, code: string, message: string) => errors.push({ path, code, message });
  if (request.baseRevision !== base.revision) fail("/baseRevision", "stale_revision", `Expected ${base.revision}; refresh observation_context.`);
  const seen = new Set<string>();
  for (const [i, item] of request.upserts.entries()) {
    if (seen.has(item.id)) fail(`/upserts/${i}/id`, "duplicate_id", item.id);
    if (["start", "recon", "spray-dict"].includes(item.id) || item.id.startsWith("host-flag-")) fail(`/upserts/${i}/id`, "reserved_id", item.id);
    if (request.retireIds.includes(item.id)) fail(`/upserts/${i}/id`, "conflicting_update", "Cannot update and retire the same assessment.");
    const attempts = new Set<string>();
    for (const [j, attempt] of item.attempts.entries()) {
      if (attempts.has(attempt.id)) fail(`/upserts/${i}/attempts/${j}/id`, "duplicate_id", attempt.id);
      attempts.add(attempt.id);
    }
    seen.add(item.id);
  }
  const next = structuredClone(base);
  const active = new Map(next.assessments.map(a => [a.id, a]));
  const retired = new Map(next.retired.map(a => [a.id, a]));
  for (const id of request.retireIds) {
    const previous = active.get(id);
    if (!previous && !retired.has(id)) fail("/retireIds", "unknown_id", id);
    if (previous) { retired.set(id, previous); active.delete(id); }
  }
  for (const item of request.upserts) {
    const old = active.get(item.id) || retired.get(item.id);
    const attempts = new Map((old?.attempts || []).map(a => [a.id, a]));
    for (const attempt of item.attempts) attempts.set(attempt.id, attempt);
    active.set(item.id, { ...item, role: item.role ?? old?.role, api: item.api ?? old?.api,
      attempts: [...attempts.values()], dependsOn: item.dependsOn ?? old?.dependsOn ?? [] });
    retired.delete(item.id);
  }
  next.assessments = [...active.values()];
  next.retired = [...retired.values()];
  if (request.guidance) next.guidance = structuredClone(request.guidance);
  else {
    next.guidance.angleIds = next.guidance.angleIds.filter(id => active.has(id));
    next.guidance.confirmedIds = next.guidance.confirmedIds.filter(id => active.has(id));
  }
  const checkRefs = (refs: string[], path: string, execution = false) => {
    for (const ref of refs) if (!evidence[ref]) fail(path, "unknown_evidence", ref);
    if (execution && !refs.some(ref => ["excerpt", "receipt"].includes(evidence[ref]?.kind || "")))
      fail(path, "execution_evidence_required", "An attempt needs a real turn or platform receipt, not task text.");
  };
  for (const a of next.assessments) {
    const path = `/assessments/${a.id}`;
    checkRefs(a.evidenceRefs, `${path}/evidenceRefs`);
    if (a.status !== "inferred-open" && !a.attempts.length) fail(`${path}/attempts`, "missing_attempt", "Attempted judgments require at least one evidenced attempt.");
    const attemptIds = new Set<string>();
    for (const attempt of a.attempts) {
      if (attemptIds.has(attempt.id)) fail(`${path}/attempts/${attempt.id}`, "duplicate_id", attempt.id);
      attemptIds.add(attempt.id);
      checkRefs(attempt.evidenceRefs, `${path}/attempts/${attempt.id}/evidenceRefs`, true);
    }
    if (a.attempts.length > 20) fail(`${path}/attempts`, "too_many_attempts", `${a.attempts.length} attempts; retire this assessment and start a new phase instead of dropping history.`);
    for (const parent of a.dependsOn || []) if (!active.has(parent)) fail(`${path}/dependsOn`, "unknown_dependency", parent);
  }
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) { fail(`/assessments/${id}/dependsOn`, "cycle", "Dependencies must not form a cycle."); return; }
    if (done.has(id)) return;
    visiting.add(id);
    for (const parent of active.get(id)?.dependsOn || []) if (active.has(parent)) visit(parent);
    visiting.delete(id); done.add(id);
  };
  for (const id of active.keys()) visit(id);
  for (const id of next.guidance.angleIds) {
    if (!active.has(id)) fail("/guidance/angleIds", "unknown_id", id);
    else if (active.get(id)!.status !== "inferred-open") fail("/guidance/angleIds", "not_open", `${id} is not an untried direction.`);
  }
  for (const id of next.guidance.confirmedIds) if (!active.get(id)?.attempts.length) fail("/guidance/confirmedIds", "missing_attempt", `${id} has no recorded attempt.`);
  if (next.guidance.tension.length === 1) fail("/guidance/tension", "incomplete_tension", "Provide both conflicting quotations or an empty list.");
  if (request.loot?.length && !dictionaryEnabled) fail("/loot", "disabled", "Credential dictionary generation is not enabled for this job.");
  const loot = new Map(next.loot.map(l => [`${l.bucket}\0${l.value}`, l]));
  for (const [i, item] of (request.loot || []).entries()) {
    checkRefs(item.evidenceRefs, `/loot/${i}/evidenceRefs`);
    loot.set(`${item.bucket}\0${item.value}`, item);
  }
  next.loot = [...loot.values()];
  if (errors.length) throw new ObservationValidationError(errors);
  return next;
}
