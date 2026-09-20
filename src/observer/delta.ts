import { createHash } from "node:crypto";
import { currentJobId } from "./recap-state.js";
import type { LogSource } from "../shared/observer-contract.js";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync, truncateSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Watermark } from "./recap-state.js";
import { atomicWrite } from "./render.js";
import {
  deltaMd,
  eventsJsonl,
  httpJsonl,
  observeCursorJson,
  observeExcerptsPendingJson,
  trafficDir,
  turnsJsonl,
  turnsMd,
  workspaceDir,
} from "../shared/paths.js";

type Cursor = { http_byte: number; events_byte: number; turns_byte: number };
type Pending = Cursor & { turns_md_mark?: number; turns_jsonl_mark?: number };

export type Excerpt = {
  jobId?: string;
  sources?: LogSource[];
  callId?: string;
  kind: "tool" | "result" | "say" | "think" | "meta" | "http";
  name?: string;
  cmd?: string;
  text: string;
  detail: string;
};

const TOOL_KEYS = ["command", "cmd", "url", "path", "file_path", "query", "pattern"] as const;
const HTTP_LINE_LIMIT = 80;
const EVENT_SCAN_LIMIT = 400;
const EXCERPT_CAP = 80;
const SNIP = 240;
const DETAIL = 2000;
const TURNS_MD_MAX = 120_000;
const CHUNK = 256 * 1024;

export function loadCursor(workspace?: string | null): Cursor {
  const empty: Cursor = { http_byte: 0, events_byte: 0, turns_byte: 0 };
  const p = observeCursorJson(workspace);
  if (!existsSync(p)) return { ...empty };
  try {
    const doc = JSON.parse(readFileSync(p, "utf8")) as Cursor;
    if (!doc || typeof doc !== "object") return { ...empty };
    return {
      http_byte: Number(doc.http_byte || 0),
      events_byte: Number(doc.events_byte || 0),
      turns_byte: Number(doc.turns_byte || 0),
    };
  } catch {
    return { ...empty };
  }
}

export function saveCursor(workspace: string | null | undefined, cursor: Cursor): void {
  atomicWrite(observeCursorJson(workspace), JSON.stringify(cursor, null, 2) + "\n");
}

function oneLine(text: unknown, limit = SNIP, fromEnd = false): string {
  const s = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= limit) return s;
  return fromEnd ? s.slice(-limit) : s.slice(0, limit);
}

function redactFlags(text: string): string {
  return text.replace(/flag\{[^{}]*\}/gi, "[flag omitted]");
}

function payloadOf(rec: Record<string, unknown>): Record<string, unknown> {
  return rec.payload && typeof rec.payload === "object" && !Array.isArray(rec.payload)
    ? (rec.payload as Record<string, unknown>)
    : {};
}

function contentBlocks(payload: Record<string, unknown>): Record<string, unknown>[] {
  const nested =
    payload.message && typeof payload.message === "object" && !Array.isArray(payload.message)
      ? (payload.message as Record<string, unknown>)
      : null;
  const content = payload.content ?? nested?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x));
}

function toolArg(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input ? oneLine(input, 200) : "";
  const rec = input as Record<string, unknown>;
  for (const key of TOOL_KEYS) {
    if (rec[key]) return oneLine(rec[key], 200);
  }
  try {
    return oneLine(JSON.stringify(input), 200);
  } catch {
    return "";
  }
}

function resultRaw(block: Record<string, unknown>, payload: Record<string, unknown>): { body: string; err: boolean } {
  const err = Boolean(block.is_error || block.isError);
  const raw = block.content ?? block.text;
  if (typeof raw === "string" && raw.trim()) return { body: raw, err };
  if (Array.isArray(raw)) {
    const bits: string[] = [];
    for (const item of raw) {
      if (typeof item === "string") bits.push(item);
      else if (item && typeof item === "object" && "text" in item) bits.push(String((item as { text?: unknown }).text || ""));
    }
    if (bits.some((x) => x.trim())) return { body: bits.join("\n"), err };
  }
  const wrap = payload.tool_use_result;
  if (wrap && typeof wrap === "object" && !Array.isArray(wrap)) {
    const w = wrap as Record<string, unknown>;
    if (w.stdout) return { body: String(w.stdout), err };
    if (w.content) return { body: String(w.content), err };
  }
  return { body: "", err };
}

export function isNoiseEvent(rec: Record<string, unknown>): boolean {
  const kind = String(rec.kind || rec.type || "");
  if (kind === "thinking_tokens") return true;
  if (kind !== "message") return false;
  const payload = payloadOf(rec);
  const mt = String(rec.message_type || payload.type || "").toLowerCase();
  const nested = payload.data && typeof payload.data === "object" ? (payload.data as Record<string, unknown>) : null;
  const subtype = String(payload.subtype || nested?.subtype || "").toLowerCase();
  if (subtype === "thinking_tokens") return true;
  if (mt === "system" || mt === "systemmessage") return true;
  if (mt === "result" || mt.includes("task") || mt === "tool_progress") return true;
  return false;
}

function blocksFromPiTurn(payload: Record<string, unknown>): Record<string, unknown>[] {
  const msg = payload.message && typeof payload.message === "object" ? (payload.message as Record<string, unknown>) : {};
  const content = Array.isArray(msg.content) ? msg.content : Array.isArray(payload.content) ? payload.content : [];
  return content.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x));
}

function item(kind: Excerpt["kind"], text: string, extra: Partial<Excerpt> = {}): Excerpt {
  const short = redactFlags(extra.text || text);
  return {
    kind,
    jobId: extra.jobId,
    sources: extra.sources,
    callId: extra.callId,
    name: extra.name,
    cmd: extra.cmd,
    text: short,
    detail: redactFlags(extra.detail || extra.text || text),
  };
}

function excerptBlocks(blocks: Record<string, unknown>[], payload: Record<string, unknown>): Excerpt[] {
  const out: Excerpt[] = [];
  let think = "";
  for (const b of blocks) {
    const ptype = String(b.type || "").toLowerCase();
    if (ptype === "thinking" || b.thinking) {
      const bit = oneLine(b.thinking, 180);
      if (bit) think = bit;
      continue;
    }
    if (ptype === "tool_result" || ptype === "toolresult") {
      const { body, err } = resultRaw(b, payload);
      if (!body.trim()) continue;
      const prefix = err ? "result[err]" : "result";
      out.push(
        item("result", `${prefix}: ${oneLine(body, SNIP, true)}`, {
          callId: String(b.tool_use_id || b.toolCallId || payload.tool_use_id || ""),
          detail: `${prefix}: ${oneLine(body, DETAIL, true)}`,
        }),
      );
      continue;
    }
    const name = String(b.name || b.toolName || "");
    const isTool =
      ptype === "tool_use" ||
      ptype === "toolcall" ||
      (ptype.includes("tool") && !ptype.includes("result")) ||
      Boolean(name && (b.input || b.arguments || b.tool_input));
    if (isTool) {
      const cmd = toolArg(b.input || b.arguments || b.tool_input);
      const text = `tool ${name || "tool"}: ${cmd}`.trim();
      out.push(item("tool", text, { name: name || "tool", cmd, detail: text, callId: String(b.id || b.toolCallId || "") }));
      continue;
    }
    if (ptype === "text" || typeof b.text === "string") {
      const text = oneLine(b.text, 180);
      if (text) out.push(item("say", `say: ${text}`, { detail: `say: ${oneLine(b.text, DETAIL)}` }));
    }
  }
  if (!out.length && think) out.push(item("think", `think: ${think}`));
  return out;
}

export function eventItems(line: string): Excerpt[] {
  try {
    const rec = JSON.parse(line) as Record<string, unknown>;
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) return [];
    if (isNoiseEvent(rec)) return [];
    const kind = String(rec.kind || rec.type || "");
    const payload = payloadOf(rec);
    if (kind === "pi_turn_end") {
      const results = Array.isArray(payload.toolResults) ? payload.toolResults.filter((r): r is Record<string, unknown> => !!r && typeof r === "object").map((r) => ({ ...r, type: "tool_result" })) : [];
      return excerptBlocks([...blocksFromPiTurn(payload), ...results], payload);
    }
    if (kind === "message") return excerptBlocks(contentBlocks(payload), payload);
    if (kind === "sdk_error" || kind === "pi_error" || kind === "agent_done") {
      const extra = oneLine(payload.error || payload.exit_code, 160);
      const text = extra ? `${kind}: ${extra}` : kind;
      return [item("meta", text)];
    }
    return [];
  } catch {
    return [];
  }
}

/** Host digest of one events.jsonl line. Empty = skip (noise or unreadable). */
export function eventExcerpt(line: string): string[] {
  return eventItems(line).map((x) => x.text);
}

function pairItems(items: Excerpt[]): Excerpt[] {
  const out: Excerpt[] = [];
  const tools: Excerpt[] = [];
  const flushTools = (): void => {
    while (tools.length) out.push(tools.shift()!);
  };
  for (const it of items) {
    if (it.kind === "tool") {
      tools.push(it);
      continue;
    }
    const matching = it.callId ? tools.findIndex((tool) => tool.callId === it.callId && tool.jobId === it.jobId) : -1;
    if (it.kind === "result" && matching >= 0) {
      const pending = tools.splice(matching, 1)[0]!;
      const result = it.text.replace(/^result(?:\[err\])?:\s*/, "");
      out.push(
        item("tool", `${pending.text} → ${result}`, {
          jobId: pending.jobId,
          sources: [...new Map([...(pending.sources || []), ...(it.sources || [])].map((s) => [JSON.stringify(s), s])).values()],
          callId: pending.callId,
          name: pending.name,
          cmd: pending.cmd,
          detail: `${pending.detail}\n${it.detail}`,
        }),
      );
      continue;
    }
    if (it.kind === "think" || it.kind === "say") {
      out.push(it);
      continue;
    }
    flushTools();
    out.push(it);
  }
  flushTools();
  return out;
}

function dropThinkIfBusy(items: Excerpt[]): Excerpt[] {
  const busy = items.some((x) => x.kind === "tool" || x.kind === "result" || x.kind === "say" || x.kind === "http");
  if (busy) return items.filter((x) => x.kind !== "think");
  return items.slice(0, 2);
}

function httpItem(line: string): Excerpt | null {
  try {
    const rec = JSON.parse(line) as Record<string, unknown>;
    if (!rec || typeof rec !== "object") return item("http", oneLine(line, SNIP));
    const method = String(rec.method || "?");
    const url = String(rec.url || rec.path || "");
    const status = rec.status;
    const body = String(rec.resp_body || "");
    const sig = Array.isArray(rec.sig) ? (rec.sig as unknown[]).slice(0, 4).join(",") : "";
    const text = redactFlags(`${method} ${url} → ${status} sig=${sig} body=${JSON.stringify(oneLine(body, 120, true))}`);
    const detail = redactFlags(`${method} ${url} → ${status} sig=${sig} body=${JSON.stringify(oneLine(body, DETAIL, true))}`);
    return { kind: "http", jobId: typeof rec.job_id === "string" ? rec.job_id : undefined, text, detail, cmd: url, name: `${method} ${status}` };
  } catch {
    return item("http", oneLine(line, SNIP));
  }
}

function collapseHttp(items: Excerpt[]): Excerpt[] {
  const out: Excerpt[] = [];
  let i = 0;
  while (i < items.length) {
    const cur = items[i]!;
    const key = cur.name || "";
    let j = i + 1;
    while (j < items.length && items[j]!.name === key && items[j]!.jobId === cur.jobId && key) j += 1;
    const n = j - i;
    if (n >= 3 && key) {
      const urls = items.slice(i, j).map((x) => x.cmd || "").filter(Boolean);
      out.push(
        item("http", `${key} × ${n} (${urls[0]} … ${urls[urls.length - 1]})`, {
          jobId: cur.jobId,
          sources: items.slice(i, j).flatMap((x) => x.sources || []),
          name: key,
          detail: urls.slice(0, 8).join("\n") + (urls.length > 8 ? `\n… +${urls.length - 8}` : ""),
        }),
      );
    } else {
      out.push(...items.slice(i, j));
    }
    i = j;
  }
  return out;
}

function readCompleteLines(path: string, start: number, limit: number, until?: number, sealed = false): { lines: { text: string; source: LogSource }[]; end: number } {
  if (!existsSync(path)) return { lines: [], end: start };
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { lines: [], end: start };
  }
  try {
    const size = Math.min(fstatSync(fd).size, until ?? Infinity);
    if (start > size) start = 0;
    if (start >= size) return { lines: [], end: start };
    const lines: { text: string; source: LogSource }[] = [];
    let pos = start;
    let carry = "";
    const decoder = new StringDecoder("utf8");
    let end = start;
    while (pos < size && lines.length < limit) {
      const want = Math.min(CHUNK, size - pos);
      const buf = Buffer.allocUnsafe(want);
      const n = readSync(fd, buf, 0, want, pos);
      if (n <= 0) break;
      pos += n;
      carry += decoder.write(buf.subarray(0, n));
      if (pos === size) {
        carry += decoder.end();
        if (sealed && carry && !carry.endsWith("\n")) carry += "\n";
      }
      const parts = carry.split("\n");
      carry = parts.pop() || "";
      for (const ln of parts) {
        const row = ln.replace(/\r$/, "");
        const rowStart = end;
        end = Math.min(size, end + Buffer.byteLength(ln, "utf8") + 1);
        if (row.trim()) lines.push({ text: row, source: logSource("http", rowStart, end, ln) });
        if (lines.length >= limit) return { lines, end };
      }
    }
    return { lines, end };
  } finally {
    closeSync(fd);
  }
}

function digestEvents(path: string, start: number, scanLimit: number, excerptCap: number, until?: number, sealed = false): { items: Excerpt[]; end: number } {
  if (!existsSync(path)) return { items: [], end: start };
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { items: [], end: start };
  }
  try {
    const size = Math.min(fstatSync(fd).size, until ?? Infinity);
    if (start > size) start = 0;
    if (start >= size) return { items: [], end: start };
    const raw: Excerpt[] = [];
    let pos = start;
    let carry = "";
    const decoder = new StringDecoder("utf8");
    let end = start;
    let scanned = 0;
    while (pos < size && scanned < scanLimit) {
      const want = Math.min(CHUNK, size - pos);
      const buf = Buffer.allocUnsafe(want);
      const n = readSync(fd, buf, 0, want, pos);
      if (n <= 0) break;
      pos += n;
      carry += decoder.write(buf.subarray(0, n));
      if (pos === size) {
        carry += decoder.end();
        if (sealed && carry && !carry.endsWith("\n")) carry += "\n";
      }
      const parts = carry.split("\n");
      carry = parts.pop() || "";
      for (const ln of parts) {
        const row = ln.replace(/\r$/, "");
        const lineBytes = Buffer.byteLength(ln, "utf8") + 1;
        if (!row.trim()) {
          end = Math.min(size, end + lineBytes);
          continue;
        }
        const already = dropThinkIfBusy(pairItems(raw));
        if (already.length >= excerptCap) return { items: already, end };
        const rowStart = end;
        end = Math.min(size, end + lineBytes);
        scanned += 1;
        const source = logSource("events", rowStart, end, ln);
        const record = (() => { try { return JSON.parse(row); } catch { return {}; } })();
        raw.push(...eventItems(row).map((x) => ({ ...x, jobId: record.job_id, sources: [source] })));
        const items = dropThinkIfBusy(pairItems(raw));
        if (items.length >= excerptCap) return { items, end };
        if (scanned >= scanLimit) return { items, end };
      }
    }
    return { items: dropThinkIfBusy(pairItems(raw)), end };
  } finally {
    closeSync(fd);
  }
}

function nextTurnN(path: string): number {
  if (!existsSync(path)) return 1;
  try {
    const text = readFileSync(path, "utf8");
    return (text.match(/\n/g) || []).length + 1;
  } catch {
    return 1;
  }
}

function appendLedger(workspace: string, items: Excerpt[]): void {
  if (!items.length) return;
  const mdPath = turnsMd(workspace);
  const jsonlPath = turnsJsonl(workspace);
  let prev = "";
  if (existsSync(mdPath)) {
    try {
      prev = readFileSync(mdPath, "utf8");
    } catch {
      prev = "";
    }
  }
  if (!prev.trim()) prev = "# Solver turns (host ledger)\n";
  const stamp = new Date().toISOString();
  let refN = nextTurnN(jsonlPath);
  const block = [`\n## window ${stamp}\n`, ...items.map((x) => `- [turn:${refN++}] ${x.text}\n`)].join("");
  let next = prev.replace(/\s+$/, "") + "\n" + block;
  if (next.length > TURNS_MD_MAX) {
    const keep = next.slice(-TURNS_MD_MAX);
    const nl = keep.indexOf("\n");
    next = "# Solver turns (host ledger)\n\n…(earlier windows trimmed)…\n" + (nl >= 0 ? keep.slice(nl + 1) : keep);
  }
  atomicWrite(mdPath, next.endsWith("\n") ? next : next + "\n");
  let n = nextTurnN(jsonlPath);
  const rows = items.map((x) => {
    const row = JSON.stringify({ n, jobId: x.jobId || currentJobId(workspace), sources: x.sources || [], kind: x.kind, name: x.name || "", cmd: x.cmd || "", text: x.text, detail: x.detail });
    n += 1;
    return row;
  });
  const old = existsSync(jsonlPath) ? readFileSync(jsonlPath, "utf8") : "";
  atomicWrite(jsonlPath, (old.endsWith("\n") || !old ? old : old + "\n") + rows.join("\n") + "\n");
}

function pendingCursorPath(workspace: string): string {
  return `${trafficDir(workspace)}/observe_cursor.pending.json`;
}

function fileSize(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

function truncateTo(path: string, mark: number): void {
  if (!existsSync(path)) return;
  const size = fileSize(path);
  const n = Math.max(0, Math.min(Math.floor(mark), size));
  try {
    truncateSync(path, n);
  } catch {
    /* ignore */
  }
}

function rewindUncommitted(workspace: string): void {
  const p = pendingCursorPath(workspace);
  if (!existsSync(p)) return;
  let pending: Pending;
  try {
    pending = JSON.parse(readFileSync(p, "utf8")) as Pending;
  } catch {
    return;
  }
  const cur = loadCursor(workspace);
  if (cur.events_byte === Number(pending.events_byte || 0) && cur.http_byte === Number(pending.http_byte || 0)) {
    return;
  }
  if (Number.isFinite(Number(pending.turns_md_mark))) truncateTo(turnsMd(workspace), Number(pending.turns_md_mark));
  if (Number.isFinite(Number(pending.turns_jsonl_mark))) truncateTo(turnsJsonl(workspace), Number(pending.turns_jsonl_mark));
}

function dropPending(workspace: string): void {
  for (const p of [pendingCursorPath(workspace), observeExcerptsPendingJson(workspace)]) {
    try {
      unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

export function writeDelta(workspace?: string | null, opts: { httpLimit?: number; evLimit?: number; excerptCap?: number; until?: Watermark; sealed?: boolean } = {}): boolean {
  const ws = workspaceDir(workspace);
  rewindUncommitted(ws);
  const cur = loadCursor(ws);
  const httpRead = readCompleteLines(httpJsonl(ws), Number(cur.http_byte || 0), opts.httpLimit ?? HTTP_LINE_LIMIT, opts.until?.http_byte, opts.sealed);
  const httpItems = collapseHttp(httpRead.lines.map((line): Excerpt | null => { const x = httpItem(line.text); return x ? { ...x, sources: [line.source] } : null; }).filter((x): x is Excerpt => !!x));
  const evScan = opts.evLimit ?? EVENT_SCAN_LIMIT;
  const excerptCap = opts.excerptCap ?? EXCERPT_CAP;
  const ev = digestEvents(eventsJsonl(ws), Number(cur.events_byte || 0), evScan, excerptCap, opts.until?.events_byte, opts.sealed);
  const parts = ["# Observer delta (this window only)\n"];
  let neu = false;
  let refN = nextTurnN(turnsJsonl(ws));
  if (httpItems.length) {
    neu = true;
    parts.push("## HTTP\n");
    for (const it of httpItems) parts.push(`- [turn:${refN++}] ${it.text}\n`);
  }
  if (ev.items.length) {
    neu = true;
    parts.push("## Solver events\n");
    for (const it of ev.items) parts.push(`- [turn:${refN++}] ${it.text}\n`);
  }
  const hint = join(ws, "hint.txt");
  if (existsSync(hint)) {
    try {
      const ht = readFileSync(hint, "utf8").trim();
      if (ht) {
        parts.push("## hint.txt\n");
        parts.push(ht.slice(0, 800) + "\n");
      }
    } catch {
      /* ignore */
    }
  }
  atomicWrite(deltaMd(ws), parts.join(""));
  const mdMark = fileSize(turnsMd(ws));
  const jsMark = fileSize(turnsJsonl(ws));
  appendLedger(ws, [...httpItems, ...ev.items]);
  atomicWrite(
    pendingCursorPath(ws),
    JSON.stringify({
      http_byte: httpRead.end,
      events_byte: ev.end,
      turns_byte: cur.turns_byte || 0,
      turns_md_mark: mdMark,
      turns_jsonl_mark: jsMark,
    }) + "\n",
  );
  return neu;
}

export function commitCursor(workspace?: string | null): void {
  const ws = workspaceDir(workspace);
  const pending = pendingCursorPath(ws);
  if (!existsSync(pending)) return;
  try {
    const doc = JSON.parse(readFileSync(pending, "utf8")) as Pending;
    if (doc && typeof doc === "object") {
      saveCursor(ws, {
        http_byte: Number(doc.http_byte || 0),
        events_byte: Number(doc.events_byte || 0),
        turns_byte: Number(doc.turns_byte || 0),
      });
    }
  } catch {
    /* ignore */
  }
  dropPending(ws);
}

export function pendingWatermark(workspace: string): Watermark {
  try { return JSON.parse(readFileSync(pendingCursorPath(workspace), "utf8")) as Watermark; }
  catch { return loadCursor(workspace); }
}

/** Event rotation starts a new byte stream; retain historical ledger references. */
export function resetEventsCursor(workspace: string): void {
  rewindUncommitted(workspace);
  dropPending(workspace);
  saveCursor(workspace, { ...loadCursor(workspace), events_byte: 0 });
}

function logSource(log: LogSource["log"], start: number, end: number, line: string): LogSource {
  const bytes = Buffer.from(line + "\n").subarray(0, end - start);
  return { log, start, end, sha256: createHash("sha256").update(bytes).digest("hex") };
}
