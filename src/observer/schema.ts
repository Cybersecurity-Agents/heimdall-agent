import { GRAPH_SCHEMA_VERSION, type NodeDetails } from "../shared/observer-contract.js";
export { GRAPH_SCHEMA_VERSION } from "../shared/observer-contract.js";
export type ObserverNode = Record<string, unknown> & NodeDetails & { id: string; kind: string; coverage: string };
export type ObserverEdge = Record<string, unknown> & { from: string; to: string };
export type ObserverDag = Record<string, unknown> & { schemaVersion: number; nodes: ObserverNode[]; edges: ObserverEdge[] };
function object(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v); }
function text(v: unknown, field: string, max = 1200): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`${field}: expected nonempty text (max ${max})`);
  return v.trim();
}
function optional(v: unknown, field: string): string | null { return v === null ? null : text(v, field); }
function refs(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) throw new Error(`${field}: expected an evidence reference list; got ${v === undefined ? "missing field (check nesting)" : typeof v}`);
  if (v.length > 16) throw new Error(`${field}: ${v.length} references exceeds max 16`);
  const invalid = v.findIndex(r => typeof r !== "string" || !/^(turn:[1-9]\d*|receipt:[a-f0-9]{64}|input:task|input:hint|system:spray-dict)$/.test(r));
  if (invalid >= 0) throw new Error(`${field}[${invalid}]: invalid evidence reference ${JSON.stringify(v[invalid])}`);
  return [...new Set(v as string[])];
}
export function parseObserverDag(value: unknown): ObserverDag {
  if (!object(value)) throw new Error("dag must be an object with nodes/edges");
  if (value.schemaVersion !== GRAPH_SCHEMA_VERSION) throw new Error(`unsupported graph schemaVersion ${String(value.schemaVersion)}; expected ${GRAPH_SCHEMA_VERSION}`);
  if (!Array.isArray(value.nodes) || !value.nodes.length) throw new Error("dag.nodes must be a non-empty list");
  if (!Array.isArray(value.edges)) throw new Error("dag.edges must be a list");
  const nodes = value.nodes.map((item): ObserverNode => {
    if (!object(item)) throw new Error("dag node is not an object");
    const id = text(item.id, "node.id", 100);
    if (id.includes("\0")) throw new Error("dag node id contains a null character");
    for (const legacy of ["note", "trace", "title", "group"]) if (legacy in item) throw new Error(`node ${id}: ${legacy} was replaced by summary/steps/kind`);
    const kind = text(item.kind, `node ${id} kind`, 30);
    const label = text(item.label, `node ${id} label`, 120);
    if (!object(item.summary)) throw new Error(`node ${id}: summary required`);
    const summary = { conclusion: text(item.summary.conclusion, `${id}.conclusion`, 600),
      basis: text(item.summary.basis, `${id}.basis`), uncertainty: optional(item.summary.uncertainty, `${id}.uncertainty`) };
    if (!Array.isArray(item.steps)) throw new Error(`node ${id}: steps must be a list; got ${item.steps === undefined ? "missing field (check nesting)" : typeof item.steps}`);
    if (item.steps.length > 20) throw new Error(`node ${id}: ${item.steps.length} steps exceeds max 20`);
    const ids = new Set<string>();
    const steps = item.steps.map((step) => {
      if (!object(step)) throw new Error(`node ${id}: invalid step`);
      const sid = text(step.id, `${id}.step.id`, 100);
      if (ids.has(sid)) throw new Error(`node ${id}: duplicate step id ${sid}`);
      ids.add(sid);
      const evidenceRefs = refs(step.evidenceRefs, `${id}.${sid}.evidenceRefs`);
      if (!evidenceRefs.some((ref) => /^(turn|receipt):/.test(ref))) throw new Error(`node ${id}: step ${sid} requires evidence from a log or receipt`);
      return { id: sid, action: text(step.action, `${id}.${sid}.action`), result: text(step.result, `${id}.${sid}.result`, 4000),
        assessment: optional(step.assessment, `${id}.${sid}.assessment`), evidenceRefs };
    });
    const evidenceRefs = refs(item.evidenceRefs, `${id}.evidenceRefs`);
    if (!evidenceRefs.length) throw new Error(`node ${id}: conclusion requires evidence`);
    const coverage = typeof item.coverage === "string" ? item.coverage : "";
    if (["tried-hit", "tried-miss", "scan-class"].includes(coverage) && !steps.length) throw new Error(`node ${id}: attempted direction requires steps`);
    return { ...item, id, kind, label, coverage, summary, steps, evidenceRefs };
  });
  const edges = value.edges.map((item): ObserverEdge => {
    if (!object(item)) throw new Error("dag edge is not an object");
    return { ...item, from: text(item.from, "edge.from", 100), to: text(item.to, "edge.to", 100) };
  });
  return { ...value, schemaVersion: GRAPH_SCHEMA_VERSION, nodes, edges };
}
