import { evidenceErrors } from "./evidence.js";
import { nodeRefs } from "../shared/observer-contract.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Backend } from "../agent/backends/types.js";
import type { EventSink } from "../shared/events.js";
import { loadPrompt } from "../shared/resources.js";
import { trafficDir } from "../shared/paths.js";
import { commitCursor, loadCursor, pendingWatermark, writeDelta } from "./delta.js";
import { publishObserverGraph } from "./publish.js";
import { validateDagDoc, type ValidateResult } from "./validate.js";
import { currentJobId, pendingRecap, readRecapState, readRecord, recapDir, writeRecord, setRecapState, recapTimeoutMs, type RecapRequest, type Watermark } from "./recap-state.js";

export const RECAP_TOOLS = ["read", "write", "edit", "grep", "find", "ls"] as const;

const covered = (cursor: Watermark, end: Watermark): boolean =>
  cursor.events_byte >= end.events_byte && cursor.http_byte >= end.http_byte;

export function validateRecap(ws: string, request: RecapRequest, lastWindow = true): ValidateResult {
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(join(trafficDir(ws), "recap_dag.json"), "utf8")); } catch { doc = null; }
  const result = validateDagDoc(doc, { nodes: request.terminal ? 48 : 16, edges: request.terminal ? 72 : 24, requireOpen: false });
  if (!result.dag) return result;
  const dag = result.dag;
  const receipts = [...request.receipts, ...(request.historicalReceipts || [])];
  for (const error of evidenceErrors(ws, dag.nodes, receipts)) result.fail(error);
  const validRefs = new Set(receipts.map((r) => `receipt:${r.id}`));
  const reached = new Set(dag.nodes.filter((n) => n.kind === "start").map((n) => n.id));
  for (let i = 0; i < dag.nodes.length; i++) {
    for (const edge of dag.edges) if (reached.has(edge.from)) reached.add(edge.to);
  }
  for (const node of dag.nodes) {
    const refs = nodeRefs(node);
    if (node.kind === "flag") {
      if (!refs.some((ref) => ref.startsWith("receipt:") && validRefs.has(ref))) result.fail(`flag ${node.id}: platform receipt required`);
      if (!reached.has(node.id)) result.fail(`flag ${node.id}: no path from start`);
      const parents = dag.edges.filter((edge) => edge.to === node.id).map((edge) => dag.nodes.find((n) => n.id === edge.from)!);
      if (!parents.length || parents.some((n) => n.kind === "direction" && n.coverage !== "tried-hit")) result.fail(`flag ${node.id}: incoming success path is not confirmed`);
    }
    if (node.kind === "direction" && node.coverage === "tried-hit" && !refs.some((ref) => ref.startsWith("turn:"))) {
      result.fail(`direction ${node.id}: cite a turn supporting the successful step`);
    }
  }
  for (const receipt of lastWindow ? request.receipts : []) {
    if (!dag.nodes.some((n) => n.kind === "flag" && (n.evidenceRefs as string[] | undefined)?.includes(`receipt:${receipt.id}`))) {
      result.fail(`accepted receipt:${receipt.id} missing from graph`);
    }
  }
  return result;
}

export function buildRecapPrompt(request: RecapRequest, lastWindow: boolean, repair: string): string {
  return [
    `This job is ${request.jobId}. Trigger=${request.reason}; terminal=${request.terminal}; last_window=${lastWindow}.`,
    request.reason === "timeout" ? "任务超时。整理已验证路径、失败尝试和阻塞点；不要把超时写成成功。" :
      request.receipts.length ? "平台已确认以下提交正确。只把有证据的对应路径标为成功。" :
        "控制台任务成功结束，但本次没有平台成功回执。不要推断 flag 已通过验证。",
    "Platform receipts (values omitted):", JSON.stringify(request.receipts),
    "Historical receipts from earlier jobs (historical evidence only; NOT proof of acceptance on the current instance):",
    JSON.stringify(request.historicalReceipts || []),
    "本窗口的末尾位置：", JSON.stringify(request.watermark),
    "读取 input.json、已有 observe_dag.json / map.md、turns.md 和本窗 delta.md；用 turns.jsonl 定位证据。",
    "输出 .heimdall/traffic/recap_dag.json 与 .heimdall/traffic/recap.md。其他文件不要修改。",
    "已有输出是当前窗口的草稿：先读取并保留正确内容，只补齐缺失文件或修复校验错误，不要从头重复分析。两个文件都必须完成；主机校验发布前不要声称完成。",
    `节点上限 ${request.terminal ? 48 : 16}，边上限 ${request.terminal ? 72 : 24}。`,
    lastWindow ? "已到本次日志截止位置：完成全路径复核。" : "尚有后续窗口：保留已有历史，合并本窗证据；不要声称全量日志已整理完。",
    repair ? `上次校验失败，请修复：\n${repair}` : "",
  ].join("\n");
}

type RecapCheckpoint = {
  requestId: string; before: Watermark; cursor: Watermark; attempts: number;
  repair: string; sessionFile?: string;
};
const sameWindow = (a: Watermark, b: Watermark): boolean =>
  a.events_byte === b.events_byte && a.http_byte === b.http_byte;

/** Retain drafts and the pinned window until both artifacts pass validation and publish. */
export async function runRecap(ws: string, request: RecapRequest, backend: Backend, events: EventSink,
  owns: () => boolean = () => true): Promise<boolean> {
  const prior = readRecapState(ws);
  const checkpointPath = join(recapDir(ws), "checkpoint.json");
  const output = join(trafficDir(ws), "recap_dag.json"), reportPath = join(trafficDir(ws), "recap.md");
  const active = (): boolean => owns() && currentJobId(ws) === request.jobId && pendingRecap(ws)?.id === request.id;
  let call: AbortController | undefined;
  const guard = setInterval(() => { if (!active()) call?.abort(); }, 250);
  try {
    const system = loadPrompt("observer-recap");
    while (active()) {
      const before = loadCursor(ws);
      writeDelta(ws, { until: request.watermark, sealed: request.terminal });
      const cursor = pendingWatermark(ws), last = covered(cursor, request.watermark);
      if (!last && sameWindow(before, cursor)) throw new Error("log cursor cannot reach snapshot (truncated or incomplete log)");
      const saved = readRecord<RecapCheckpoint>(checkpointPath);
      const resume = saved?.requestId === request.id && sameWindow(saved.before, before) && sameWindow(saved.cursor, cursor);
      const checkpoint: RecapCheckpoint = resume ? saved : { requestId: request.id, before, cursor, attempts: 0, repair: "" };
      // Old releases left partial drafts without a checkpoint. Adopt only drafts
      // belonging to this request; never reuse another job/window's output.
      const adoptLegacy = !saved && prior?.requestId === request.id;
      if (!resume && !adoptLegacy) {
        rmSync(output, { force: true }); rmSync(reportPath, { force: true });
      }
      writeRecord(checkpointPath, checkpoint);
      while (active()) {
        const result = validateRecap(ws, request, last);
        const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8").trim() : "";
        if (!report) result.fail("recap.md missing or empty");
        if (/flag\{/i.test(report)) result.fail("recap.md contains a flag value");
        if (result.ok && result.dag) {
          try {
            if (!publishObserverGraph(ws, result.dag, { request, watermark: cursor, final: request.terminal && last, report: report + "\n" })) {
              throw new Error("recap graph publication failed");
            }
            commitCursor(ws);
            if (!covered(loadCursor(ws), cursor)) throw new Error("recap cursor commit failed");
            if (last) {
              setRecapState(ws, request, "published", { watermark: cursor, attempts: checkpoint.attempts });
              events.writeText(`[observer recap] published ${request.reason} final=${request.terminal}`);
              return true;
            }
            // Commit succeeded; only now advance to the next evidence window.
            await backend.close?.();
            break;
          } catch (error) {
            checkpoint.repair = String(error);
            writeRecord(checkpointPath, checkpoint);
            setRecapState(ws, request, "running", { error: checkpoint.repair, attempts: checkpoint.attempts });
            events.writeText(`[observer recap] publication retry: ${error}`);
            // Valid artifacts remain intact; storage retries do not need a model call.
            await delay(1000);
            continue;
          }
        }
        checkpoint.repair = result.asText();
        checkpoint.attempts++;
        writeRecord(checkpointPath, checkpoint);
        setRecapState(ws, request, "running", { error: checkpoint.repair, attempts: checkpoint.attempts, watermark: before });
        events.writeText(`[observer recap] continuing attempt=${checkpoint.attempts}: ${checkpoint.repair}`);
        call = new AbortController();
        // This limits a single stalled call, never the overall recap. A timed-out
        // call is allowed to settle before another call uses the same session.
        const timer = setTimeout(() => call?.abort(), recapTimeoutMs());
        try {
          const run = await backend.run({
            systemPrompt: system, userPrompt: buildRecapPrompt(request, last, checkpoint.repair), workspace: ws,
            permissionMode: "bypassPermissions", maxTurns: 0, resume: checkpoint.sessionFile,
            model: process.env.HEIMDALL_COACH_MODEL || process.env.ANTHROPIC_MODEL || null, events, signal: call.signal,
          });
          if (typeof run.extra?.session_file === "string") checkpoint.sessionFile = run.extra.session_file;
          if (!run.ok || call.signal.aborted) {
            checkpoint.repair = run.error || "Model call interrupted; continue from saved drafts.";
            events.writeText(`[observer recap] retry: ${checkpoint.repair}`);
            if (active()) await delay(1000);
          }
        } catch (error) {
          checkpoint.repair = String(error);
          events.writeText(`[observer recap] retry: ${error}`);
          if (active()) await delay(1000);
        } finally {
          clearTimeout(timer); call = undefined;
          if (active()) writeRecord(checkpointPath, checkpoint);
        }
      }
    }
    return false;
  } catch (error) {
    if (active()) setRecapState(ws, request, "failed", { error: String(error), watermark: loadCursor(ws) });
    events.writeText(`[observer recap] interrupted: ${error}`);
    return false;
  } finally {
    clearInterval(guard);
    await backend.close?.();
  }
}
