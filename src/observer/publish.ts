import { commitObservationPublication, hasObservationPublication, publicationDir } from "../shared/observation-publication.js";
import type { ObservationState } from "./state.js";
import { randomUUID } from "node:crypto";
import { makeEvidenceSnapshot } from "./evidence.js";
import { currentJobId, readRecord } from "./recap-state.js";
import type { NodeDetails, Publication } from "../shared/observer-contract.js";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { nowSec } from "../shared/fsutil.js";
import { atomicWrite } from "./render.js";
import {
  coverJson,
  dagJson,
  graphJson,
  graphPrevJson,
  injectTxt,
  mapHtml,
  mapMd,
  observeDagJson,
  observerOkPath,
  steerJson,
  trafficDir,
  workspaceDir,
} from "../shared/paths.js";
import { finalizePublishedView, loadDag, renderMapHtml, saveDag, viewFromCoach } from "./graph.js";
import { writeSteer } from "./steer.js";
import { emptySprayMeta, rebuildSprayDict, sprayEnabled, type SprayDictMeta } from "./spray.js";
export { sprayEnabled };
import { attachSprayDictView, stampSprayLedger, stripSpraySummaries } from "./spray-stamp.js";
import { processDagLimits, reorderInjectAngles, stripSprayForbid, validateWorkspace, writeValidateErr } from "./validate.js";
import { commitCursor, writeDelta } from "./delta.js";
import { type ObserverDag } from "./schema.js";
import type { RecapRequest, Watermark } from "./recap-state.js";

export function jobUniqueCode(workspace?: string | null): string {
  const env = (process.env.UNIQUE_CODE || "").trim();
  if (env) return env;
  const inp = join(workspaceDir(workspace), "input.json");
  if (existsSync(inp)) {
    try {
      const doc = JSON.parse(readFileSync(inp, "utf8")) as { unique_code?: unknown };
      if (doc && typeof doc === "object") {
        const code = String(doc.unique_code || "").trim();
        if (code) return code;
      }
    } catch {
      /* ignore */
    }
  }
  return workspaceDir(workspace).split(/[/\\]/).pop() || "";
}

function loadCover(workspace?: string | null): Record<string, unknown> | null {
  try {
    const p = coverJson(workspace);
    if (existsSync(p)) {
      const doc = JSON.parse(readFileSync(p, "utf8")) as unknown;
      if (doc && typeof doc === "object" && !Array.isArray(doc)) return doc as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

export function preferLogicAngles(workspace?: string | null): void {
  if (hasObservationPublication(workspace)) return;
  const inj = injectTxt(workspace);
  if (!existsSync(inj)) return;
  try {
    const raw = readFileSync(inj, "utf8");
    let neu = reorderInjectAngles(stripSprayForbid(raw));
    if (workspace && !sprayEnabled(workspace)) neu = stripSpraySummaries(neu);
    if (neu === raw) return;
    atomicWrite(inj, neu);
  } catch {
    /* ignore */
  }
}

export function restorePublishedInject(workspace?: string | null): void {
  if (hasObservationPublication(workspace)) return;
  const backup = join(trafficDir(workspace), "inject.published.txt");
  if (!existsSync(backup)) return;
  try {
    atomicWrite(injectTxt(workspace), readFileSync(backup, "utf8"));
  } catch {
    /* ignore */
  }
}

export function publishObserverGraph(workspace?: string | null, validatedDag?: ObserverDag, recap?: {
  request: RecapRequest; watermark: Watermark; final: boolean; report: string;
}): boolean {
  if (!workspace || (!recap && hasObservationPublication(workspace))) return false;
  // Reuse the exact document checked by this tick, rather than reading it again.
  const validation = validatedDag ? null : validateWorkspace(workspace);
  const dag = validatedDag || (validation?.ok ? validation.dag : null);
  if (!dag) return false;
  let view = viewFromCoach(dag, recap ? { nodes: recap.request.terminal ? 48 : 16, edges: recap.request.terminal ? 72 : 24, requireOpen: false } : processDagLimits(sprayEnabled(workspace)));
  if (!view) return false;
  let sprayMeta: SprayDictMeta = emptySprayMeta();
  if (!recap && sprayEnabled(workspace)) try {
    sprayMeta = rebuildSprayDict(workspace).meta;
  } catch (exc) {
    console.log(`observer spray_dict rebuild failed: ${exc}`);
  }
  if (!recap) {
    // Empty metadata also removes host stamps left by older, ungated releases.
    stampSprayLedger(workspace, sprayMeta);
    view = attachSprayDictView(view, sprayMeta);
  }
  let prev = null;
  try {
    prev = loadDag(workspace);
  } catch {
    prev = null;
  }
  const graphSrc = graphJson(workspace);
  const cover = loadCover(workspace);
  const graphPayload = finalizePublishedView(view, cover, workspace);
  if (recap) graphPayload.recap = {
    requestId: recap.request.id, jobId: recap.request.jobId, reason: recap.request.reason,
    final: recap.final, watermark: recap.watermark, publishedAt: Date.now(),
    acceptedCount: recap.request.receipts.length,
  };
  const publication: Publication = { jobId: currentJobId(workspace), revision: randomUUID(),
    phase: recap ? (recap.final ? "final" : "recap") : "observe", publishedAt: Date.now() };
  graphPayload.publication = publication;
  const snapshot = makeEvidenceSnapshot(workspace, view.nodes as unknown as NodeDetails[], publication,
    recap ? [...recap.request.receipts, ...(recap.request.historicalReceipts || [])] : undefined);
  const evidencePath = join(trafficDir(workspace), "evidence.json");
  const code = jobUniqueCode(workspace) || workspaceDir(workspace);
  const html = renderMapHtml({ ...graphPayload, evidence: snapshot.items }, code);
  if (recap && hasObservationPublication(workspace)) {
    const active = publicationDir(workspace);
    const artifacts = Object.fromEntries(readdirSync(active).map(name => [name, readFileSync(join(active, name), "utf8")]));
    const previousEvidence = readRecord<{ items: typeof snapshot.items }>(join(active, "evidence.json"));
    // Retain frozen references used by ongoing judgments as well as the recap's references.
    snapshot.items = { ...previousEvidence?.items, ...snapshot.items };
    const state = readRecord<ObservationState>(join(active, "observation.json"));
    if (state?.jobId === publication.jobId) {
      state.revision = publication.revision;
      state.submissionHash = null;
      artifacts["observation.json"] = JSON.stringify(state, null, 2) + "\n";
    }
    Object.assign(artifacts, {
      "graph.prev.json": artifacts["graph.json"],
      "graph.json": JSON.stringify(graphPayload, null, 2) + "\n",
      "dag.json": JSON.stringify({ schemaVersion: 2, ...view }, null, 2) + "\n",
      "observe_dag.json": JSON.stringify(dag, null, 2) + "\n",
      "evidence.json": JSON.stringify(snapshot) + "\n",
      "map.html": html, "map.md": recap.report, "observer.ok": `${nowSec()}\n`,
    });
    commitObservationPublication(workspace, publication.revision, artifacts);
    return true;
  }
  const backup = join(trafficDir(workspace), "inject.published.txt");
  const files = [evidencePath, dagJson(workspace), graphSrc, graphPrevJson(workspace), mapHtml(workspace), steerJson(workspace), backup, observerOkPath(workspace)];
  if (recap) files.push(mapMd(workspace), observeDagJson(workspace));
  const previous = files.map((path) => ({ path, text: existsSync(path) ? readFileSync(path, "utf8") : null }));
  try {
    if (existsSync(graphSrc)) {
      try {
        atomicWrite(graphPrevJson(workspace), readFileSync(graphSrc, "utf8"));
      } catch {
        /* ignore */
      }
    }
    saveDag(workspace, view, prev);
    atomicWrite(mapHtml(workspace), html);
    if (!recap) writeSteer(workspace, dag);
    if (recap) {
      atomicWrite(mapMd(workspace), recap.report);
      atomicWrite(observeDagJson(workspace), JSON.stringify(dag, null, 2) + "\n");
    }
    const inj = injectTxt(workspace);
    if (!recap && existsSync(inj)) {
      atomicWrite(backup, readFileSync(inj, "utf8"));
    }
    atomicWrite(evidencePath, JSON.stringify(snapshot) + "\n");
    atomicWrite(graphSrc, JSON.stringify(graphPayload, null, 2) + "\n");
    atomicWrite(observerOkPath(workspace), `${nowSec()}\n`);
    return true;
  } catch (error) {
    // Keep the previous publication usable when a later file write fails.
    for (const file of previous) {
      if (file.text === null) {
        if (existsSync(file.path)) unlinkSync(file.path);
      } else atomicWrite(file.path, file.text);
    }
    throw error;
  }
}

export function afterAdvisorTick(workspace: string): boolean {
  preferLogicAngles(workspace);
  const result = validateWorkspace(workspace);
  if (result.ok) {
    try {
      if (result.dag && publishObserverGraph(workspace, result.dag)) {
        writeValidateErr(workspace, result);
        commitCursor(workspace);
        return true;
      }
      result.fail("observer graph was not published");
    } catch (exc) {
      result.fail(`observer publish failed: ${exc}`);
    }
  }
  writeValidateErr(workspace, result);
  restorePublishedInject(workspace);
  return false;
}

export function prepareTick(workspace: string): void {
  writeDelta(workspace);
  if (hasObservationPublication(workspace) || !sprayEnabled(workspace)) return;
  try {
    rebuildSprayDict(workspace);
  } catch {
    /* default login book is best-effort */
  }
}
