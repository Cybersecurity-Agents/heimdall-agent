import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eventsJsonl, httpJsonl } from "../shared/paths.js";
import type { SubmitResult } from "../platforms/types.js";

export type Watermark = { events_byte: number; http_byte: number };
export type RecapReason = "flag_accepted" | "succeeded" | "timeout";
export type Receipt = {
  id: string; jobId: string; code: string; acceptedAt: number;
  flagIndex: number | null; correctCount: number; totalCount: number; duplicate: boolean;
};
export type RecapRequest = {
  id: string; jobId: string; reason: RecapReason; requestedAt: number;
  watermark: Watermark; receipts: Receipt[]; terminal: boolean;
  historicalReceipts?: Receipt[];
};
export type RecapState = {
  requestId: string; jobId: string; status: "pending" | "running" | "published" | "failed" | "disabled";
  reason: RecapReason; terminal: boolean; updatedAt: number;
  watermark?: Watermark; error?: string;
  attempts?: number;
};

export const recapDir = (ws: string): string => join(ws, ".heimdall", "recap");
export function readRecord<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}
// Distinct temporary names are necessary: submit processes can run concurrently.
export function writeRecord(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o666 });
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
}
export function currentJobId(ws: string): string {
  const input = readRecord<{ job_id?: string }>(join(ws, "input.json"));
  return input?.job_id || process.env.HEIMDALL_JOB_ID || "standalone";
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Only call with an actual platform response, never a solver-authored flag row. */
export function recordAcceptedSubmit(ws: string, code: string, flag: string, result: SubmitResult, jobId = currentJobId(ws)): Receipt | null {
  if (result.correct !== true) return null;
  const input = readRecord<{ unique_code?: string }>(join(ws, "input.json"));
  if (input?.unique_code && input.unique_code !== code) return null;
  const dir = join(recapDir(ws), "receipts");
  mkdirSync(dir, { recursive: true });
  const id = hash(`${jobId}\0${code}\0${flag}`);
  const path = join(dir, `${id}.json`);
  const previous = readRecord<Receipt>(path);
  if (previous) return previous;
  const receipt: Receipt = {
    id, jobId, code, acceptedAt: Date.now(), flagIndex: result.matched_flag_index,
    correctCount: result.correct_flag_count, totalCount: result.total_flag_count, duplicate: result.duplicate,
  };
  writeRecord(path, receipt);
  const terminal = readRecord<RecapRequest>(join(recapDir(ws), "request.json"));
  if (terminal?.jobId === jobId && terminal.terminal) requestTerminalRecap(ws, jobId, terminal.reason);
  return receipt;
}
export function acceptedReceipts(ws: string, jobId = currentJobId(ws), allJobs = false): Receipt[] {
  const dir = join(recapDir(ws), "receipts");
  if (!existsSync(dir)) return [];
  const input = readRecord<{ unique_code?: string }>(join(ws, "input.json"));
  return readdirSync(dir).filter((name) => name.endsWith(".json"))
    .map((name) => readRecord<Receipt>(join(dir, name)))
    .filter((r): r is Receipt => Boolean(r && (allJobs || r.jobId === jobId) && (!input?.unique_code || r.code === input.unique_code)))
    .sort((a, b) => a.id.localeCompare(b.id));
}
export function logWatermark(ws: string): Watermark {
  const size = (p: string): number => { try { return statSync(p).size; } catch { return 0; } };
  return { events_byte: size(eventsJsonl(ws)), http_byte: size(httpJsonl(ws)) };
}
export function recapTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  // Per model call only: reaching this limit preserves drafts and retries.
  const seconds = Number(env.HEIMDALL_OBSERVER_FINALIZE_SEC || 300);
  return (Number.isFinite(seconds) ? Math.min(1800, Math.max(5, seconds)) : 300) * 1000;
}
export function terminalNeedsRecap(status: string): status is "succeeded" | "timeout" {
  return status === "succeeded" || status === "timeout";
}
export function requestTerminalRecap(ws: string, jobId: string, status: string): RecapRequest | null {
  if (!terminalNeedsRecap(status)) return null;
  const receipts = acceptedReceipts(ws, jobId);
  const watermark = logWatermark(ws);
  const request: RecapRequest = {
    id: hash(JSON.stringify([jobId, status, watermark, receipts.map((r) => r.id)])),
    jobId, reason: status, requestedAt: Date.now(), watermark, receipts, terminal: true,
    historicalReceipts: acceptedReceipts(ws, jobId, true).filter((r) => r.jobId !== jobId),
  };
  writeRecord(join(recapDir(ws), "request.json"), request);
  const state = readRecapState(ws);
  if (state?.requestId !== request.id) setRecapState(ws, request, "pending");
  return request;
}
export function pendingRecap(ws: string): RecapRequest | null {
  const jobId = currentJobId(ws);
  const terminal = readRecord<RecapRequest>(join(recapDir(ws), "request.json"));
  if (terminal?.jobId === jobId) return terminal;
  const receipts = acceptedReceipts(ws, jobId);
  if (!receipts.length) return null;
  return {
    id: hash(JSON.stringify([jobId, receipts.map((r) => r.id)])),
    jobId, reason: "flag_accepted", terminal: false, receipts,
    historicalReceipts: acceptedReceipts(ws, jobId, true).filter((r) => r.jobId !== jobId),
    requestedAt: Math.max(...receipts.map((r) => r.acceptedAt)), watermark: logWatermark(ws),
  };
}
export function readRecapState(ws: string): RecapState | null {
  return readRecord<RecapState>(join(recapDir(ws), "state.json"));
}
export function setRecapState(ws: string, request: RecapRequest, status: RecapState["status"], extra: Partial<RecapState> = {}): void {
  if (currentJobId(ws) !== request.jobId) return;
  const latest = pendingRecap(ws);
  if (latest && latest.id !== request.id) return;
  writeRecord(join(recapDir(ws), "state.json"), {
    requestId: request.id, jobId: request.jobId, reason: request.reason, terminal: request.terminal,
    status, updatedAt: Date.now(), ...extra,
  } satisfies RecapState);
}
