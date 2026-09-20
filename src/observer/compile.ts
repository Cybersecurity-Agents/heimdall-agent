import type { ObservationState } from "./state.js";
import { ObservationValidationError } from "./contract.js";
import { parseObserverDag } from "./schema.js";
import { finalizePublishedView, renderMapHtml, viewFromValidatedDag } from "./graph.js";
import { attachSprayDictView, dictAngleBullet, dictConfirmedBullet } from "./spray-stamp.js";
import { emptySprayMeta, rebuildSprayDict } from "./spray.js";
import { redactEvidence } from "./evidence.js";
import { bruteLaterScore, processDagLimits } from "./validate.js";
import type { Receipt } from "./recap-state.js";
import { nodeRefs, type Evidence, type NodeDetails, type Publication } from "../shared/observer-contract.js";

export type ObservationInputs = {
  evidence: Record<string, Evidence>; receipts: Receipt[]; hint: string; code: string;
  dictionaryEnabled: boolean;
};
const clean = (text: string): string => redactEvidence(text).replace(/flag\{/gi, "[flag omitted]");
const line = (text: string): string => clean(text).replace(/[\r\n]+/g, " ").replace(/<\/?heimdall-map>/gi, "").trim();
const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

/** Deterministic projection of judgments. No model-authored markup or inferred causal edges. */
export function compileObservation(state: ObservationState, input: ObservationInputs) {
  const root = (id: string, kind: string, label: string, conclusion: string) => ({ id, kind, label,
    summary: { conclusion, basis: "Workspace task facts", uncertainty: null }, evidenceRefs: ["input:task"], steps: [] });
  const nodes: Record<string, unknown>[] = [root("start", "start", "Task", "Current authorized task"), root("recon", "recon", "Evidence", "Observed workspace evidence")];
  const edges: { from: string; to: string }[] = [{ from: "start", to: "recon" }];
  for (const a of state.assessments) {
    nodes.push({ id: a.id, kind: a.status === "scan-class" ? "scan" : a.role || "direction", label: line(a.subject), coverage: a.status, ...(a.api ? { api: line(a.api) } : {}),
      summary: { conclusion: clean(a.conclusion), basis: clean(a.basis), uncertainty: a.uncertainty === null ? null : clean(a.uncertainty) },
      evidenceRefs: a.evidenceRefs, steps: a.attempts.map(t => ({ ...t, action: clean(t.action), result: clean(t.result), assessment: t.assessment ? clean(t.assessment) : null })) });
    for (const parent of a.dependsOn?.length ? a.dependsOn : ["recon"]) edges.push({ from: parent, to: a.id });
  }
  for (const receipt of input.receipts) {
    const ref = `receipt:${receipt.id}`, id = `host-flag-${receipt.id}`;
    nodes.push({ id, kind: "flag", label: `Accepted flag${receipt.flagIndex === null ? "" : ` ${receipt.flagIndex}`}`,
      summary: { conclusion: "Platform accepted this submission", basis: "Host-recorded successful platform receipt", uncertainty: null }, evidenceRefs: [ref], steps: [] });
    const parents = state.assessments.filter(a => a.evidenceRefs.includes(ref) || a.attempts.some(t => t.evidenceRefs.includes(ref))).map(a => a.id);
    for (const parent of parents.length ? parents : ["recon"]) edges.push({ from: parent, to: id });
  }
  const limits = processDagLimits(input.dictionaryEnabled);
  if (nodes.length > limits.nodes || edges.length > limits.edges) throw new ObservationValidationError([{ path: "/assessments", code: "graph_budget",
    message: `${nodes.length}/${limits.nodes} nodes, ${edges.length}/${limits.edges} edges; retire superseded assessments. Accepted flags remain host-owned.` }]);
  const dag = parseObserverDag({ schemaVersion: 2, nodes, edges });
  const warnings: string[] = [];
  const hint = input.hint;
  if (hint && !state.guidance.lock) warnings.push("A platform hint is available; consider updating LOCK.");
  if (state.assessments.some(a => a.status === "inferred-open") && !state.guidance.angleIds.length) warnings.push("Untried directions exist but no ANGLES are selected.");
  const byId = new Map(state.assessments.map(a => [a.id, a]));
  const angles = state.guidance.angleIds.map(id => line(byId.get(id)!.subject));
  const confirmed = state.guidance.confirmedIds.map(id => {
    const a = byId.get(id)!;
    return `${line(a.subject)}: ${line(a.conclusion)}`;
  });
  const sections = (lines: string[]): string[] => ["HYPOTHESIS:", ...(state.guidance.hypothesis ? [`- ${line(state.guidance.hypothesis)}`] : []),
    "CONFIRMED:", ...lines.map(s => `- ${s}`), "LOCK:", ...(state.guidance.lock ? [`- ${line(state.guidance.lock)}`] : []),
    "ANGLES:", ...angles.map(s => `- ${line(s)}`),
    ...(state.guidance.tension.length ? ["TENSION:", ...state.guidance.tension.map(s => `- ${line(s)}`)] : [])];
  const inject = ["<heimdall-map>", ...sections(confirmed), ...(hint ? ["PLATFORM HINT:", line(hint)] : []), "</heimdall-map>", ""].join("\n");
  const map = ["# Coverage ledger", "", ...state.assessments.flatMap(a => [
    `## ${line(a.subject)} [${a.status}]`, line(a.conclusion), `Basis: ${line(a.basis)}`,
    ...(a.uncertainty ? [`Uncertainty: ${line(a.uncertainty)}`] : []),
    ...a.attempts.map(t => `- ${line(t.action)} → ${line(t.result)} (${t.evidenceRefs.join(", ")})`), "",
  ])].join("\n");
  const steer = { now: angles.filter(a => bruteLaterScore(a) === 0), later: angles.filter(a => bruteLaterScore(a) > 0),
    forbid: ["portscan"], open_skill: state.assessments.filter(a => a.status === "inferred-open").map(a => line(a.subject)),
    later_open: !state.assessments.some(a => a.status === "inferred-open") };
  return { dag, inject, confirmed: "# CONFIRMED\n\n" + sections(confirmed).join("\n") + "\n", map, steer, warnings };
}

export function observationArtifacts(ws: string, state: ObservationState, input: ObservationInputs, previousGraph: string | null): Record<string, string> {
  const compiled = compileObservation(state, input);
  const publication: Publication = { jobId: state.jobId, revision: state.revision!, phase: "observe", publishedAt: Date.now() };
  const loot: Record<string, string[]> = {};
  for (const item of state.loot) (loot[item.bucket] ??= []).push(item.value);
  const dictionary = input.dictionaryEnabled ? rebuildSprayDict(ws, { loot: { ...loot, users: [...(loot.users || []), ...(loot.names || [])] }, write: false }) : null;
  const meta = dictionary?.meta || emptySprayMeta();
  const view = attachSprayDictView(viewFromValidatedDag(compiled.dag)!, meta);
  const limits = processDagLimits(input.dictionaryEnabled);
  if (view.nodes.length > limits.nodes || view.edges.length > limits.edges) throw new ObservationValidationError([{
    path: "/assessments", code: "graph_budget", message: "Graph including host dictionary nodes exceeds its budget; retire superseded assessments.",
  }]);
  const graph = finalizePublishedView(view);
  graph.publication = publication;
  const evidence: Record<string, Evidence> = {};
  for (const ref of new Set((view.nodes as unknown as NodeDetails[]).flatMap(nodeRefs))) {
    if (ref === "system:spray-dict") evidence[ref] = { ref, kind: "system", jobId: state.jobId, text: dictConfirmedBullet(meta), truncated: false };
    else if (input.evidence[ref]) evidence[ref] = input.evidence[ref]!;
    else throw new ObservationValidationError([{ path: "/evidence", code: "unknown_evidence", message: ref }]);
  }
  let inject = compiled.inject, confirmed = compiled.confirmed, map = compiled.map;
  if (dictionary && meta.status !== "empty") {
    const stamp = `- ${dictConfirmedBullet(meta)}\n`;
    inject = inject.replace("CONFIRMED:\n", `CONFIRMED:\n${stamp}`);
    confirmed = confirmed.replace("CONFIRMED:\n", `CONFIRMED:\n${stamp}`);
    map = `${dictConfirmedBullet(meta)}\n\n${map}`;
    if (meta.status === "updated") {
      const angle = dictAngleBullet(meta);
      inject = inject.replace("ANGLES:\n", `ANGLES:\n- ${angle}\n`);
      confirmed = confirmed.replace("ANGLES:\n", `ANGLES:\n- ${angle}\n`);
      compiled.steer.now.unshift(angle);
    }
  }
  return { "observation.json": json(state), "observe_dag.json": json(compiled.dag), "dag.json": json({ schemaVersion: 2, ...view }),
    "graph.json": json(graph), "graph.prev.json": previousGraph || json(graph),
    "evidence.json": json({ publication, items: evidence }), "map.html": renderMapHtml({ ...graph, evidence }, input.code),
    "map.md": map, "CONFIRMED.md": confirmed, "inject.txt": inject, "inject.published.txt": inject,
    "steer.json": json(compiled.steer), "observer.ok": `${Date.now() / 1000}\n`, "loot.json": json(loot),
    ...(dictionary?.contents || {}) };
}
