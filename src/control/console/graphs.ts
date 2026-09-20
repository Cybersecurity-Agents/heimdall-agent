import { publicationDir } from "../../shared/observation-publication.js";
import { attachRaw } from "../../observer/evidence.js";
import { currentJobId } from "../../observer/recap-state.js";
import { nodeRefs, type NodeDetails, type EvidenceSnapshot, type NodeEvidenceResponse } from "../../shared/observer-contract.js";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { observerOkPath } from "../../shared/paths.js";
import { observerWarmupSec } from "../../observer/loop.js";
import { pendingRecap, readRecapState } from "../../observer/recap-state.js";

export function safeWsCode(code: string): string | null {
  const c = (code || "").trim();
  if (!c || c === "." || c === ".." || c.includes("/") || c.includes("\\") || c.includes("..")) return null;
  return c;
}

export function listTrafficMaps(wsRoot: string): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  if (!existsSync(wsRoot)) return items;
  let names: string[] = [];
  try {
    names = readdirSync(wsRoot);
  } catch {
    return items;
  }
  for (const name of names.sort()) {
    const child = join(wsRoot, name);
    try {
      if (!statSync(child).isDirectory() || name.startsWith(".")) continue;
    } catch {
      continue;
    }
    const traffic = publicationDir(child);
    const graph = join(traffic, "graph.json");
    const mp = join(traffic, "map.json");
    const cover = join(traffic, "cover.json");
    const http = join(traffic, "http.jsonl");
    let httpSize = 0;
    try {
      if (existsSync(http)) httpSize = statSync(http).size;
    } catch {
      httpSize = 0;
    }
    items.push({
      code: name,
      has_graph: existsSync(graph) || existsSync(mp) || existsSync(cover) || httpSize > 2,
      graph: existsSync(graph) ? graph : null,
      html: existsSync(join(traffic, "map.html")) ? join(traffic, "map.html") : null,
    });
  }
  return items;
}

function observerPublished(workspace: string): boolean {
  try {
    return existsSync(observerOkPath(workspace));
  } catch {
    return false;
  }
}

export function loadTrafficGraph(wsRoot: string, code: string, warmupSec = observerWarmupSec()): Record<string, unknown> | null {
  const safe = safeWsCode(code);
  if (!safe) return null;
  const root = resolve(join(wsRoot, safe, ".heimdall", "traffic"));
  try {
    if (relative(resolve(wsRoot), root).startsWith("..")) return null;
  } catch {
    return null;
  }
  if (!existsSync(root)) return { error: "no_traffic_dir", code: safe };
  const ws = join(wsRoot, safe);
  const request = pendingRecap(ws);
  const state = readRecapState(ws);
  const recap = request ? (state?.requestId === request.id ? state : {
    requestId: request.id, jobId: request.jobId, reason: request.reason,
    terminal: request.terminal, status: "pending", updatedAt: request.requestedAt,
  }) : null;
  const active = publicationDir(ws);
  const graphPath = join(active, "graph.json");
  const published = observerPublished(ws);
  if (!published || !existsSync(graphPath)) {
    return {
      code: safe,
      warming_up: true,
      published: false,
      warmup_sec: warmupSec,
      recap,
    };
  }
  let graph: Record<string, unknown> | null = null;
  try {
    const raw = JSON.parse(readFileSync(graphPath, "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) graph = raw as Record<string, unknown>;
  } catch {
    graph = null;
  }
  if (!graph || !graph.view || (graph.publication as { jobId?: string } | undefined)?.jobId !== currentJobId(ws)) {
    return { code: safe, warming_up: true, published: true, recap };
  }
  let mermaid: string | null = null;
  const mmd = join(active, "map.mmd");
  if (existsSync(mmd)) {
    try {
      mermaid = readFileSync(mmd, "utf8");
    } catch {
      mermaid = null;
    }
  }
  let updated = 0;
  try {
    updated = statSync(graphPath).mtimeMs / 1000;
  } catch {
    updated = 0;
  }
  return {
    code: safe,
    graph,
    updated,
    html: existsSync(join(active, "map.html")),
    mermaid,
    published: true,
    recap,
  };
}

export function loadNodeEvidence(wsRoot: string, code: string, nodeId: string, revision: string): NodeEvidenceResponse {
  const safe = safeWsCode(code);
  if (!safe || !nodeId || nodeId.length > 100 || !/^[a-f0-9-]{36}$/.test(revision)) return { error: "bad_request" };
  const ws = join(wsRoot, safe);
  const traffic = publicationDir(ws);
  try {
    const graph = JSON.parse(readFileSync(join(traffic, "graph.json"), "utf8"));
    const snapshot = JSON.parse(readFileSync(join(traffic, "evidence.json"), "utf8")) as EvidenceSnapshot;
    if (graph.publication?.revision !== revision || snapshot.publication.revision !== revision ||
      snapshot.publication.jobId !== currentJobId(ws)) return { error: "stale_revision" };
    const node = graph.view.nodes.find((n: { id: string }) => n.id === nodeId) as NodeDetails | undefined;
    if (!node) return { error: "node_missing" };
    const refs = nodeRefs(node);
    if (refs.some((ref) => !snapshot.items[ref])) return { error: "evidence_missing" };
    return { publication: snapshot.publication, items: attachRaw(ws, refs.map((ref) => snapshot.items[ref]!)) };
  } catch { return { error: "evidence_unavailable" }; }
}
