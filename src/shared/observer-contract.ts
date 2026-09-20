/** Shared model/publisher/desk contract. Host evidence is never model-authored. */
export const GRAPH_SCHEMA_VERSION = 2;
export type NodeSummary = { conclusion: string; basis: string; uncertainty: string | null };
export type NodeStep = { id: string; action: string; result: string; assessment: string | null; evidenceRefs: string[] };
export type NodeDetails = { summary: NodeSummary; steps: NodeStep[]; evidenceRefs: string[] };
export type Publication = { jobId: string; revision: string; phase: "observe" | "recap" | "final"; publishedAt: number };
export type LogSource = { log: "events" | "http"; start: number; end: number; sha256: string };
export type Evidence = {
  ref: string; kind: "excerpt" | "receipt" | "input" | "system";
  jobId: string; text: string; truncated: boolean; sources?: LogSource[];
  raw?: Array<{ log: string; text?: string; unavailable?: string; truncated?: boolean }>;
};
export type EvidenceSnapshot = { publication: Publication; items: Record<string, Evidence> };
export type NodeEvidenceResponse = { publication?: Publication; items?: Evidence[]; error?: string };
export const nodeRefs = (node: NodeDetails): string[] => [...new Set([
  ...node.evidenceRefs, ...node.steps.flatMap((step) => step.evidenceRefs),
])];
