import { type NodeSummary } from "../shared/observer-contract.js";
import { resourcePath } from "../shared/resources.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { atomicWrite } from "../shared/fsutil.js";
import { dagJson } from "../shared/paths.js";
import { bruteLaterScore, OPEN_COVERAGE, validateDagDoc } from "./validate.js";
import { safeText } from "./render.js";
import { GRAPH_SCHEMA_VERSION, type ObserverDag } from "./schema.js";
import { sugiyamaLayout } from "./layout.js";
export { sugiyamaLayout } from "./layout.js";

type GNode = Record<string, unknown>;
type GEdge = Record<string, unknown>;
type GView = { nodes: GNode[]; edges: GEdge[]; source?: string; [k: string]: unknown };

const VIEW_RANK: Record<string, number> = {
  start: 0,
  recon: 1,
  direction: 2,
  scan: 2,
  endpoint: 3,
  path: 4,
  flag: 5,
  next: 5,
};

export const COVERAGE_STATUS: Record<string, [string, string]> = {
  "tried-hit": ["live", "已连通"],
  "tried-miss": ["miss", "未连通"],
  "inferred-open": ["open", "未试·待突"],
  untested: ["open", "未试·待突"],
  "scan-class": ["miss", "待连通验证"],
};

const LATER_SUB: Record<string, string> = {
  "未试·待突": "未试·最后",
  未连通: "未连通·最后",
  待连通验证: "待连通验证·最后",
  // Compatibility with graphs published before the terminology change.
  "已测·未穿": "未连通·最后",
  "侦察·未穿": "待连通验证·最后",
};

function clipToken(text: string, n: number): string {
  const s = String(text || "").trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  for (const sep of [" / ", " · ", " "]) {
    const i = cut.lastIndexOf(sep);
    if (i >= Math.max(4, Math.floor(n / 3))) {
      const out = cut.slice(0, i).replace(/[ ·/-]+$/g, "");
      if (out) return out;
    }
  }
  return cut.replace(/[-_/]+$/g, "");
}

function dropCoords(node: GNode): void {
  delete node.x;
  delete node.y;
  delete node.width;
  delete node.height;
}

function layoutFree(node: GNode): GNode {
  const skip = new Set(["x", "y", "width", "height"]);
  const out: GNode = {};
  for (const [k, v] of Object.entries(node)) {
    if (!skip.has(k)) out[k] = v;
  }
  return out;
}

function viewHasCycle(ids: Set<string>, edges: GEdge[]): boolean {
  const succ: Record<string, string[]> = Object.create(null);
  for (const i of ids) succ[i] = [];
  for (const e of edges) {
    const src = String(e.from || "");
    const dst = String(e.to || "");
    (succ[src] ??= []).push(dst);
  }
  const state = new Map<string, number>();
  const visit = (nid: string): boolean => {
    const st = state.get(nid) || 0;
    if (st === 1) return true;
    if (st === 2) return false;
    state.set(nid, 1);
    for (const nxt of succ[nid] || []) {
      if (visit(nxt)) return true;
    }
    state.set(nid, 2);
    return false;
  };
  for (const i of ids) {
    if (visit(i)) return true;
  }
  return false;
}

function remapEdges(edges: GEdge[], idMap: Record<string, string>, ids: Set<string>): GEdge[] {
  const out: GEdge[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    const src = idMap[String(e.from || "")] ?? String(e.from || "");
    const dst = idMap[String(e.to || "")] ?? String(e.to || "");
    const key = `${src}\0${dst}`;
    if (!ids.has(src) || !ids.has(dst) || src === dst || seen.has(key)) continue;
    seen.add(key);
    const rec: GEdge = { from: src, to: dst, label: e.label || "" };
    if (e.dashes) rec.dashes = true;
    if (e.tone) rec.tone = e.tone;
    out.push(rec);
  }
  return out;
}

function isLaterNode(node: GNode): boolean {
  const group = String(node.group || "");
  const cov = String(node.coverage || "")
    .trim()
    .toLowerCase();
  if (group === "scan" || cov === "scan-class") return true;
  const blob = `${node.label || ""} ${(node.summary as NodeSummary | undefined)?.conclusion || ""} ${node.id || ""}`;
  return bruteLaterScore(blob) > 0;
}

function applyLaterMark(node: GNode): void {
  node.later = isLaterNode(node);
  if (!node.later) return;
  const sub = String(node.sub || "");
  if (sub in LATER_SUB) node.sub = LATER_SUB[sub];
  else if (!sub) node.sub = "最后";
}

function normalizeStatus(node: GNode): void {
  if (String(node.status || "") === "dead") {
    node.status = "miss";
    if (!node.sub) node.sub = "未连通";
  }
}

export function applyCoverage(node: GNode): void {
  const cov = String(node.coverage || "")
    .trim()
    .toLowerCase();
  const mapped = COVERAGE_STATUS[cov];
  if (mapped) {
    node.status = mapped[0];
    node.sub = mapped[1];
  }
  normalizeStatus(node);
  applyLaterMark(node);
}

export function viewFromCoach(coach: GNode, limits?: { nodes: number; edges: number; requireOpen?: boolean }): GView | null {
  const parsed = validateDagDoc(coach, limits);
  if (!parsed.ok || !parsed.dag) return null;
  return viewFromValidatedDag(parsed.dag);
}

/** Conversion only. Structured observations have already passed domain and schema checks. */
export function viewFromValidatedDag(dag: ObserverDag): GView | null {
  const rawNodes = dag.nodes;
  const rawEdges = dag.edges;
  const nodes: GNode[] = [];
  for (const item of rawNodes) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as GNode;
    const kind = String(rec.kind || rec.group || "");
    if (!(kind in VIEW_RANK) || kind === "next") continue;
    const nid = String(rec.id || "");
    if (!nid) continue;
    const note = String((rec.summary as NodeSummary).conclusion);
    const label = clipToken(String(rec.label || kind), 40);
    const sub = clipToken(note || String(rec.probe || rec.api || ""), 22);
    nodes.push({
      id: nid,
      label,
      group: kind,
      title: note || label,
      sub,
      rank: VIEW_RANK[kind],
      summary: rec.summary,
      steps: rec.steps,
      coverage: String(rec.coverage || "")
        .trim()
        .toLowerCase(),
      probe: rec.probe,
      flag: kind === "flag" ? rec.flag : null,
      api: rec.api,
      evidenceRefs: rec.evidenceRefs,
    });
  }
  if (!nodes.length) return null;
  const ids = new Set(nodes.map((n) => String(n.id)));
  const edges: GEdge[] = [];
  for (const item of Array.isArray(rawEdges) ? rawEdges : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as GEdge;
    const src = String(rec.from || "");
    const dst = String(rec.to || "");
    if (!ids.has(src) || !ids.has(dst) || src === dst) continue;
    const e: GEdge = { from: src, to: dst, label: String(rec.label || "") };
    if (rec.dashes) e.dashes = true;
    edges.push(e);
  }
  for (const n of nodes) {
    if (n.group === "flag") n.status = "flag";
    applyCoverage(n);
  }
  return { nodes, edges, source: "coach" };
}

function sanitizeCoachView(view: GView): GView {
  const nodes: GNode[] = [];
  for (const n of view.nodes || []) {
    if (!n || typeof n !== "object" || !n.id) continue;
    const rec = { ...n };
    const group = String(rec.group || rec.kind || "");
    if (group === "next") continue;
    rec.group = group;
    rec.rank = VIEW_RANK[group] ?? Number(rec.rank || 2);
    dropCoords(rec);
    nodes.push(rec);
  }
  const ids = new Set(nodes.map((n) => String(n.id)));
  const idMap: Record<string, string> = Object.create(null);
  for (const i of ids) idMap[i] = i;
  const edges = remapEdges(view.edges || [], idMap, ids);
  if (viewHasCycle(ids, edges)) throw new Error("dag has a cycle");
  const out: GView = { nodes, edges };
  if (view.source) out.source = String(view.source);
  return out;
}

export function sanitizeView(
  view: GView | null | undefined,
  _cover: GNode | null = null,
  opts: { preserveTopology?: boolean } = {},
): GView {
  if (!view || typeof view !== "object") return { nodes: [], edges: [] };
  return sanitizeCoachView(view);
}

export function paintFlagPath(view: GView): void {
  const nodes = (view.nodes || []).filter((n) => n && n.id);
  const edges = (view.edges || []).filter((e) => e && typeof e === "object");
  const by: Record<string, GNode> = Object.create(null);
  for (const n of nodes) by[String(n.id)] = n;
  const flagIds = new Set(Object.keys(by).filter((i) => by[i]!.group === "flag"));
  for (const nid of flagIds) {
    const n = by[nid]!;
    n.status = "flag";
    const sub = String(n.sub || "");
    if (["未试·待突", "未试·最后", "待取·FLAG"].includes(sub)) {
      n.sub = clipToken(String((n.summary as NodeSummary | undefined)?.conclusion || n.label || "flag"), 18);
    }
  }
  if (!flagIds.size) return;
  const direct = new Set(edges.filter((e) => flagIds.has(String(e.to || ""))).map((e) => String(e.from || "")));
  const skip = new Set(["start", "recon", "scan", "flag"]);
  for (const nid of direct) {
    const n = by[nid];
    if (!n || skip.has(String(n.group || ""))) continue;
    const cov = String(n.coverage || "")
      .trim()
      .toLowerCase();
    // A successful submission elsewhere is not evidence that this path worked.
    if (OPEN_COVERAGE.has(cov)) {
      n.status = "open";
      n.sub = "待取·FLAG";
      n.flag_path = true;
    }
  }
}

function storyChildBits(node: GNode, children: Record<string, GNode[]>, depth: number): string[] {
  if (depth > 4) return [];
  const group = String(node.group || "");
  const bits: string[] = [];
  if (group === "path") {
    const probe = String(node.probe || "").trim();
    if (String(node.status || "") === "miss" || String(node.role || "") === "miss") {
      bits.push(`miss ${probe || node.sub || ""}`);
    } else if (probe) bits.push(`read ${probe}`);
  } else if (group === "flag") {
    bits.push(`FLAG ${node.probe || node.sub || ""} → ${node.flag || ""}`.trim());
  }
  for (const ch of children[String(node.id || "")] || []) bits.push(...storyChildBits(ch, children, depth + 1));
  return bits;
}

export function storyLinesFromView(view: GView, cover: GNode | null, limit: number): string[] {
  const nodes = (view.nodes || []).filter((n) => n && n.id);
  const edges = (view.edges || []).filter((e) => e && typeof e === "object");
  if (!nodes.length) return [];
  const byId: Record<string, GNode> = Object.create(null);
  for (const n of nodes) byId[String(n.id)] = n;
  const children: Record<string, GNode[]> = Object.create(null);
  for (const i of Object.keys(byId)) children[i] = [];
  for (const e of edges) {
    const src = String(e.from || "");
    const dst = String(e.to || "");
    if (src in byId && dst in byId && src !== dst) children[src]!.push(byId[dst]!);
  }
  const att = cover && typeof cover.attempts === "object" && cover.attempts ? (cover.attempts as GNode) : {};
  const recon = nodes.find((n) => n.group === "recon");
  const prefix = recon ? "entry → " : "";
  const lines: string[] = [];
  if (recon) {
    const detail = String(recon.title || recon.sub || "");
    lines.push(`entry ${detail}`.trim());
  }
  const dirs = nodes.filter((n) => n.group === "direction");
  dirs.sort((a, b) => Number(a.y || 0) - Number(b.y || 0) || String(a.id).localeCompare(String(b.id)));
  for (const d of dirs) {
    const bits = [prefix + String(d.label || "direction")];
    if (d.locked || String(d.status || "") === "lock") bits.push("LOCK");
    let api = String(d.api || "");
    if (!api) {
      for (const ch of children[String(d.id)] || []) {
        if (ch.group === "endpoint") {
          api = String(ch.api || ch.title || ch.label || "");
          if (api) break;
        }
      }
    }
    if (api) bits.push(api);
    const note = String((d.summary as NodeSummary | undefined)?.conclusion || "");
    if (note && !bits.includes(note)) bits.push(note.slice(0, 80));
    if (api && Object.keys(att).length) {
      const hits = ((att.hits as GNode[]) || [])
        .filter((h) => api && String(h.via || "").includes(api))
        .map((h) => String(h.probe || h.norm || ""))
        .filter(Boolean)
        .slice(0, 3);
      if (hits.length) bits.push("read " + hits.join(", "));
      let missN = 0;
      for (const c of (att.miss_clusters as GNode[]) || []) {
        if (api && String(c.via || "").includes(api)) missN += Number(c.n || 0);
      }
      if (missN) bits.push(`miss ${missN}`);
    }
    for (const ch of children[String(d.id)] || []) bits.push(...storyChildBits(ch, children, 0));
    lines.push(bits.filter(Boolean).join(" · "));
    if (lines.length >= limit) return lines;
  }
  for (const n of nodes) {
    const group = n.group;
    if (group === "next") continue;
    if (group === "scan") {
      let count: unknown = n.count;
      if (count == null || count === "") {
        const sub = String(n.sub || "");
        count = sub.replace(/^×/, "") || "";
      }
      lines.push(`dirbust ×${count} (one class, not after entry)`);
    } else if (group === "flag" && !lines.some((x) => x.includes("FLAG"))) {
      lines.push(`FLAG ${n.probe || n.sub || ""} → ${n.flag || ""}`.trim());
    }
    if (lines.length >= limit) break;
  }
  return lines;
}

export function finalizePublishedView(
  view: GView,
  cover: GNode | null = null,
  workspace?: string | null,
): Record<string, unknown> {
  const raw: GView = { nodes: [], edges: view.edges || [], source: view.source };
  const nodes: GNode[] = [];
  for (const n of view.nodes || []) {
    if (n && typeof n === "object") {
      const m = { ...n };
      applyCoverage(m);
      normalizeStatus(m);
      nodes.push(m);
    }
  }
  raw.nodes = nodes;
  const v = sanitizeView(raw, cover, { preserveTopology: true });
  const reconRank = VIEW_RANK.recon ?? 1;
  for (const n of v.nodes || []) {
    const group = String(n.group || "");
    n.rank = VIEW_RANK[group] ?? Number(n.rank || 2);
    if (group === "scan") n.rank = reconRank;
    applyCoverage(n);
  }
  paintFlagPath(v);
  const laid = [...(v.nodes || [])];
  laid.sort((a, b) => {
    const ra = Number(a.rank || 0) - Number(b.rank || 0);
    if (ra) return ra;
    const ga = String(a.group || "") === "direction" ? bruteLaterScore(`${a.label || ""} ${(a.summary as NodeSummary | undefined)?.conclusion || ""}`) : -1;
    const gb = String(b.group || "") === "direction" ? bruteLaterScore(`${b.label || ""} ${(b.summary as NodeSummary | undefined)?.conclusion || ""}`) : -1;
    if (ga !== gb) return ga - gb;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });
  for (const n of laid) {
    if (n.flag_path && OPEN_COVERAGE.has(String(n.coverage || ""))) {
      n.sub = "待取·FLAG";
      n.later = false;
      continue;
    }
    applyLaterMark(n);
  }
  v.nodes = laid;
  const box = sugiyamaLayout(laid, v.edges || []);
  const att = cover && typeof cover.attempts === "object" && cover.attempts ? (cover.attempts as GNode) : {};
  const story = storyLinesFromView(v, { attempts: att }, 8);
  const byId: Record<string, GNode> = Object.create(null);
  for (const n of v.nodes || []) byId[String(n.id || "")] = n;
  for (const e of v.edges || []) {
    const dst = byId[String(e.to || "")];
    if (!dst) continue;
    if (String(dst.status || "") === "open" || OPEN_COVERAGE.has(String(dst.coverage || ""))) {
      e.dashes = true;
      e.tone = "open";
    } else if (e.tone === "open") {
      delete e.tone;
      delete e.dashes;
    }
  }
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    view: v,
    width: box.width,
    height: box.height,
    layout: "sugiyama",
    agent_story: story,
  };
}

export function loadDag(workspace?: string | null): GView | null {
  const path = dagJson(workspace);
  if (!existsSync(path)) return null;
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
    const nodes = (doc as GView).nodes;
    if (!Array.isArray(nodes) || nodes.length < 1) return null;
    return doc as GView;
  } catch {
    return null;
  }
}

export function saveDag(workspace: string, view: GView, prev?: GView | null): void {
  const rev = Number(prev?.rev || 0) + 1;
  const slim = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    rev,
    nodes: (view.nodes || []).filter((n) => n && typeof n === "object").map(layoutFree),
    edges: (view.edges || []).filter((e) => e && typeof e === "object"),
  };
  atomicWrite(dagJson(workspace), JSON.stringify(slim, null, 2) + "\n");
}


export function renderMapHtml(graph: Record<string, unknown>, code = ""): string {
  const payloadObj = { ...graph };
  if (!("agent_story" in payloadObj)) {
    const view = payloadObj.view && typeof payloadObj.view === "object" ? (payloadObj.view as GView) : { nodes: [], edges: [] };
    payloadObj.agent_story = storyLinesFromView(view, { attempts: payloadObj.attempts && typeof payloadObj.attempts === "object" ? (payloadObj.attempts as GNode) : {} }, 8);
  }
  // JSON escaping alone does not protect an HTML script element's closing tag.
  const payload = JSON.stringify(payloadObj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const title = safeText(code || "traffic", 40);
  let html = "";
  try {
    html = readFileSync(resourcePath("map-template"), "utf8");
  } catch {
    html = "<!DOCTYPE html><title>__TITLE__</title><pre>__GRAPH__</pre>";
  }
  return html.replaceAll("__TITLE__", () => title).replace("__GRAPH__", () => payload);
}

/** unused helper kept for id stability if cover graphs return */
export function nodeId(prefix: string, text: string): string {
  let slug = String(text).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 48);
  if (!slug) slug = createHash("sha1").update(String(text)).digest("hex").slice(0, 10);
  if (/^\d/.test(slug)) slug = "n_" + slug;
  return `${prefix}_${slug}`;
}
