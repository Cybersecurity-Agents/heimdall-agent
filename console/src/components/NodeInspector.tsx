import { useEffect, useRef, useState } from "react";
import { Button, Drawer, Tag } from "antd";
import { api, withProject } from "../api";
import type { GraphNode, GraphPayload } from "../types";
import type { Evidence, NodeEvidenceResponse, NodeSummary, Publication } from "../../../src/shared/observer-contract";

type Translate = (key: string) => string;
export function NodeSummaryView({ summary, t }: { summary: NodeSummary; t: Translate }) {
  return <dl className="node-summary">
    <dt>{t("nodeConclusion")}</dt><dd>{summary.conclusion}</dd>
    <dt>{t("nodeBasis")}</dt><dd>{summary.basis}</dd>
    {summary.uncertainty && <><dt>{t("nodeUncertainty")}</dt><dd className="node-uncertainty">{summary.uncertainty}</dd></>}
  </dl>;
}
function statusKey(node: GraphNode) {
  if (node.group === "flag") return "nodeAccepted";
  return ({ "tried-hit": "nodeAdvanced", "tried-miss": "nodeMiss", "inferred-open": "nodeUntried", "scan-class": "nodeScan" } as Record<string, string>)[node.coverage || ""] || "nodeFact";
}
function EvidenceView({ item, jobId, t }: { item: Evidence; jobId: string; t: Translate }) {
  return <article className="node-evidence-item">
    <div className="meta">{t(({ excerpt: "nodeExcerpt", receipt: "nodeReceipt", input: "nodeInput", system: "nodeSystem" })[item.kind])} · {item.ref}
      {item.jobId !== jobId && <Tag>{t("nodeHistorical")} · {item.jobId}</Tag>}</div>
    {item.truncated && <p className="meta">{t("nodeExcerptNotice")}</p>}
    <pre>{item.text}</pre>
    {item.kind === "excerpt" && <details><summary>{t("nodeRaw")}</summary>
      {!item.raw?.length ? <p className="meta">{t("nodeNoSource")}</p> : item.raw.map((raw, i) => <div key={i}>
        <p className="meta">{raw.log}</p>
        {raw.text !== undefined ? <pre>{raw.text}</pre> : <p className="meta">{t(raw.unavailable === "size_limit" ? "nodeSourceLimit" : "nodeSourceMissing")}</p>}
      </div>)}
    </details>}
  </article>;
}
export function NodeInspector({ node, graph, code, projectId, t }: {
  node: GraphNode | null; graph: GraphPayload | null; code: string; projectId: string; t: Translate;
}) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<{ node: GraphNode; publication: Publication } | null>(null);
  const [evidence, setEvidence] = useState<NodeEvidenceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  const selection = node?.id;
  const publication = graph?.publication;
  const revision = snapshot?.publication.revision;
  const stale = !!snapshot && publication?.revision !== revision;
  const useLatest = () => {
    if (node && publication) setSnapshot({ node, publication });
  };
  useEffect(() => { if (open && node && publication) setSnapshot({ node, publication }); }, [selection]);
  useEffect(() => {
    request.current?.abort(); request.current = null;
    setEvidence(null); setLoading(false);
    return () => { request.current?.abort(); request.current = null; };
  }, [revision, snapshot?.node.id, open]);
  async function loadEvidence() {
    if (!snapshot || loading || evidence?.items || request.current) return;
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setEvidence(null);
    try {
      const path = withProject(`/api/node-evidence/${encodeURIComponent(code)}?node=${encodeURIComponent(snapshot.node.id)}&revision=${encodeURIComponent(snapshot.publication.revision)}`, projectId);
      const result = await api<NodeEvidenceResponse>(path, { signal: controller.signal });
      if (request.current !== controller || controller.signal.aborted) return;
      setEvidence(result.publication?.revision && result.publication.revision !== snapshot.publication.revision ? { error: "stale_revision" } : result);
    } catch {
      if (request.current === controller && !controller.signal.aborted) setEvidence({ error: "network" });
    } finally { if (request.current === controller && !controller.signal.aborted) { setLoading(false); request.current = null; } }
  }
  const records = (refs: string[]) => refs.length ? <details className="node-evidence" onToggle={(e) => { if (e.currentTarget.open && !evidence) void loadEvidence(); }}>
    <summary>{t("nodeEvidence")} · {refs.length}</summary>
    {loading ? <p role="status">{t("nodeLoading")}</p> : evidence?.error ? <div role="status">
      <p>{t(evidence.error === "stale_revision" ? "nodeStaleEvidence" : "nodeEvidenceError")}</p>
      <Button size="small" onClick={() => void loadEvidence()}>{t("nodeRetry")}</Button>
    </div> : evidence?.items ? refs.map((ref) => {
      const item = evidence.items!.find((it) => it.ref === ref);
      return item ? <EvidenceView key={ref} item={item} jobId={snapshot!.publication.jobId} t={t} /> : <p key={ref}>{ref} · {t("nodeNoSource")}</p>;
    }) : <Button size="small" onClick={() => void loadEvidence()}>{t("nodeLoadEvidence")}</Button>}
  </details> : null;
  return <>
    {!node ? <p className="empty-hint">{t("pickNode")}</p> : <div className="node-preview">
      <div className="node-preview-head"><span>{t("nodeOverview")}</span><Tag>{t(statusKey(node))}</Tag></div>
      <h3 className="node-preview-title">{node.label || node.id}</h3>
      {node.later && <div className="later-tag">{t("laterHint")}</div>}
      <p className="node-preview-conclusion">{node.summary.conclusion}</p>
      {node.summary.uncertainty && <span className="node-preview-uncertainty">{t("nodeHasUncertainty")}</span>}
      <div className="node-preview-counts">
        <span>{node.steps.length} {t("nodeStepCount")}</span>
        <span>{new Set([...node.evidenceRefs, ...node.steps.flatMap((step) => step.evidenceRefs)]).size} {t("nodeEvidenceCount")}</span>
      </div>
      <Button block autoInsertSpace={false} onClick={() => { useLatest(); setOpen(true); }} disabled={!publication}>{t("nodeOpenDetails")} <span aria-hidden="true">↗</span></Button>
    </div>}
    <Drawer className="node-drawer" destroyOnClose open={open} onClose={() => setOpen(false)} width="min(720px, 100vw)" title={snapshot?.node.label || t("nodeOpenDetails")}>
      {snapshot && <div className="node-details" key={snapshot.node.id}>
        {!node ? <p role="status">{t("nodeRemoved")}</p> : stale && <div className="node-update" role="status">
          <span>{t("nodeUpdated")}</span><Button size="small" onClick={useLatest}>{t("nodeUseLatest")}</Button>
        </div>}
        <p className="meta">{t(snapshot.node.source === "system" ? "nodeSystem" : "nodeObserver")} · {t(statusKey(snapshot.node))}</p>
        <p className="meta">{t(({ observe: "nodeStageObserve", recap: "nodeStageRecap", final: "nodeStageFinal" })[snapshot.publication.phase])} · {new Date(snapshot.publication.publishedAt).toLocaleString()}</p>
        <NodeSummaryView summary={snapshot.node.summary} t={t} />
        {records(snapshot.node.evidenceRefs)}
        <h3>{t("nodeSteps")}</h3>
        {!snapshot.node.steps.length ? <p className="meta">{t(snapshot.node.coverage === "inferred-open" ? "nodeNotAttempted" : "nodeNoSteps")}</p> :
          <ol className="node-steps">{snapshot.node.steps.map((step) => <li key={step.id}>
            <h4>{step.action}</h4><div className="node-result">{step.result}</div>
            {step.assessment && <p className="node-assessment"><span>{t("nodeAssessment")}</span>{step.assessment}</p>}
            {records(step.evidenceRefs)}
          </li>)}</ol>}
      </div>}
    </Drawer>
  </>;
}
