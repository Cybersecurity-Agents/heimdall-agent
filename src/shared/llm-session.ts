import { StringDecoder } from "node:string_decoder";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { flagOn } from "./env.js";
import { findInjectHits } from "./inject.js";
import { COUNT_FIELDS } from "./llm-usage.js";

const CALL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const MAX_TEXT = 80_000;
const MAX_INJECT = 120_000;
const MAX_REPLY = 80_000;
const MAX_CALL_BYTES = 1_500_000;
const MAX_INDEX_BYTES = 512_000;
const MAX_INDEX_LINES = 2000;

const HINT_RE = /PLATFORM HINT/i;

let seq = 1;
let bgLive = 0;

export type SessPart = { kind: string; text: string; has_hint?: boolean };
export type SessMessage = { role: string; parts: SessPart[] };

export function safeCallId(callId: string | null | undefined): string | null {
  const raw = (callId || "").trim();
  if (!raw || !CALL_ID_RE.test(raw)) return null;
  return raw;
}

export function sessionsIndex(workspace: string): string {
  return join(workspace, ".heimdall", "llm", "sessions.jsonl");
}

export function sessionCallPath(workspace: string, callId: string): string {
  return join(workspace, ".heimdall", "llm", "sessions", `${callId}.json`);
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

export function blocksToText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(blocksToText).filter(Boolean).join("\n");
  }
  if (typeof content !== "object") return String(content);
  const rec = content as Record<string, unknown>;
  const type = String(rec.type || "");
  if (type === "text" || type === "input_text" || type === "output_text") {
    return String(rec.text || "");
  }
  if (type === "thinking") {
    const body = String(rec.thinking || rec.text || "");
    return body ? `[thinking]\n${body}` : "";
  }
  if (type === "tool_use") {
    const name = String(rec.name || "tool");
    let dumped = "";
    try {
      dumped = JSON.stringify(rec.input ?? "");
    } catch {
      dumped = String(rec.input ?? "");
    }
    return `[tool_use ${name}]\n${clip(dumped, 8000)}`;
  }
  if (type === "tool_result") {
    const inner = blocksToText(rec.content);
    return inner ? `[tool_result]\n${inner}` : "[tool_result]";
  }
  if ("text" in rec) return String(rec.text || "");
  return "";
}

export function annotateText(text: string): SessPart[] {
  const raw = text || "";
  if (!raw) return [];
  const kept = findInjectHits(raw);
  const parts: SessPart[] = [];
  let cursor = 0;
  for (const [i, j, kind] of kept) {
    if (i > cursor) parts.push({ kind: "text", text: clip(raw.slice(cursor, i), MAX_TEXT) });
    const block = raw.slice(i, j);
    const item: SessPart = { kind, text: clip(block, MAX_INJECT) };
    if (kind === "map" && HINT_RE.test(block)) item.has_hint = true;
    parts.push(item);
    cursor = j;
  }
  if (cursor < raw.length) parts.push({ kind: "text", text: clip(raw.slice(cursor), MAX_TEXT) });
  return parts.filter((p) => p.text);
}

export function flattenMessages(body: Record<string, unknown> | null | undefined): SessMessage[] {
  if (!body || typeof body !== "object") return [];
  const out: SessMessage[] = [];
  if (body.system != null) {
    const text = blocksToText(body.system);
    if (text.trim()) out.push({ role: "system", parts: annotateText(text) });
  }
  if (typeof body.instructions === "string" && body.instructions.trim()) out.push({ role: "system", parts: annotateText(body.instructions) });
  const messages = body.messages ?? (typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input);
  if (!Array.isArray(messages)) return out;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
    const rec = msg as Record<string, unknown>;
    const role = String(rec.role || "user").trim().toLowerCase() || "user";
    if (rec.type === "reasoning") continue; // Ciphertext is continuation data, never display it as assistant prose.
    if (rec.type === "function_call" || rec.type === "function_call_output") {
      const text = rec.type === "function_call" ? `[tool_use ${rec.name || "tool"}]\n${String(rec.arguments || "")}` : `[tool_result]\n${blocksToText(rec.output)}`;
      out.push({ role: rec.type === "function_call" ? "assistant" : "tool", parts: annotateText(text) });
      continue;
    }
    const text = blocksToText(rec.content);
    if (!text.trim() && role !== "assistant" && role !== "user") continue;
    out.push({ role, parts: text ? annotateText(text) : [] });
  }
  return out;
}

export function injectKinds(messages: SessMessage[]): string[] {
  const seen: string[] = [];
  for (const msg of messages || []) {
    for (const part of msg.parts || []) {
      const kind = part.kind || "";
      if ((kind === "map" || kind === "brief") && !seen.includes(kind)) seen.push(kind);
      if (part.has_hint && !seen.includes("hint")) seen.push("hint");
    }
  }
  return seen;
}

function partsText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (part && typeof part === "object" ? String((part as SessPart).text || "") : ""))
    .join("");
}

export function refreshMessages(messages: SessMessage[] | null | undefined): SessMessage[] {
  const out: SessMessage[] = [];
  for (const msg of messages || []) {
    if (!msg || typeof msg !== "object") continue;
    const text = partsText(msg.parts);
    out.push({ ...msg, parts: text ? annotateText(text) : [] });
  }
  return out;
}

export function refreshRecord(rec: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!rec || typeof rec !== "object") return rec ?? null;
  const messages = rec.messages;
  if (!Array.isArray(messages)) return rec;
  const out = { ...rec };
  const refreshed = refreshMessages(messages as SessMessage[]);
  out.messages = refreshed;
  const kinds = injectKinds(refreshed);
  out.inject = kinds;
  out.injected = Boolean(kinds.length);
  return out;
}

function deltaText(obj: unknown): string {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "";
  const rec = obj as Record<string, unknown>;
  if (rec.type === "response.output_text.delta" && typeof rec.delta === "string") return rec.delta;
  const delta = rec.delta;
  if (delta && typeof delta === "object" && !Array.isArray(delta)) {
    const d = delta as Record<string, unknown>;
    if (typeof d.text === "string" && d.text) return d.text;
    if (typeof d.thinking === "string" && d.thinking) return d.thinking;
    if (typeof d.content === "string" && d.content) return d.content;
  }
  const block = rec.content_block;
  if (block && typeof block === "object" && !Array.isArray(block)) {
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string" && b.text) return b.text;
  }
  const choices = rec.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
    const c0 = choices[0] as Record<string, unknown>;
    const d = c0.delta;
    if (d && typeof d === "object" && !Array.isArray(d)) {
      const content = (d as Record<string, unknown>).content;
      if (typeof content === "string" && content) return content;
    }
    const msg = c0.message;
    if (msg && typeof msg === "object" && !Array.isArray(msg)) {
      return blocksToText((msg as Record<string, unknown>).content);
    }
  }
  return "";
}

/** Collect assistant text from Anthropic SSE / OpenAI stream / JSON. */
export class ReplyCollector {
  private decoder = new StringDecoder("utf8");
  private buf = "";
  private chunks: string[] = [];

  feed(chunk: Buffer | Uint8Array | string | null | undefined): void {
    if (chunk == null) return;
    if (typeof chunk !== "string" && chunk.length === 0) return;
    if (typeof chunk === "string" && !chunk) return;
    this.buf += typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
    this.drain();
    if (this.buf.length > 256_000) this.buf = this.buf.slice(-64_000);
  }

  private drain(): void {
    while (true) {
      let sep = this.buf.indexOf("\n\n");
      let width = 2;
      if (sep < 0) {
        sep = this.buf.indexOf("\r\n\r\n");
        width = 4;
      }
      if (sep < 0) break;
      const event = this.buf.slice(0, sep);
      this.buf = this.buf.slice(sep + width);
      this.eatEvent(event);
    }
  }

  private eatEvent(event: string): void {
    let payload = "";
    for (const line of event.split(/\r?\n/)) {
      if (line.startsWith("data:")) payload += line.slice(5).trimStart();
    }
    const trimmed = payload.trim();
    if (!trimmed || trimmed === "[DONE]") return;
    try {
      const piece = deltaText(JSON.parse(payload) as unknown);
      if (piece) this.chunks.push(piece);
    } catch {
      /* ignore one event */
    }
  }

  finish(): string {
    this.buf += this.decoder.end();
    this.decoder = new StringDecoder("utf8");
    this.drain();
    const leftover = this.buf.trim();
    this.buf = "";
    if (leftover && leftover !== "[DONE]") {
      try {
        const obj = JSON.parse(leftover) as unknown;
        let piece = deltaText(obj);
        if (!piece && obj && typeof obj === "object" && !Array.isArray(obj)) {
          const rec = obj as Record<string, unknown>;
          piece = blocksToText(rec.content);
          if (!piece && Array.isArray(rec.output)) piece = rec.output.filter(item => item?.type === "message").map(item => blocksToText(item.content)).join("\n");
          if (!piece) {
            const choices = rec.choices;
            if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
              const msg = (choices[0] as Record<string, unknown>).message;
              if (msg && typeof msg === "object" && !Array.isArray(msg)) {
                piece = blocksToText((msg as Record<string, unknown>).content);
              }
            }
          }
        }
        if (piece) this.chunks.push(piece);
      } catch {
        /* leftover was not JSON */
      }
    }
    return clip(this.chunks.join(""), MAX_REPLY);
  }
}

function parseBody(raw: Buffer | Uint8Array | string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
    const doc = JSON.parse(text) as unknown;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
    return doc as Record<string, unknown>;
  } catch {
    return null;
  }
}

function shrinkMessages(messages: SessMessage[]): SessMessage[] {
  return messages.map((msg) => ({
    role: msg.role,
    parts: (msg.parts || []).map((part) => {
      const kind = part.kind || "text";
      const limit = kind === "text" ? 4000 : 24_000;
      const item: SessPart = { ...part, text: clip(part.text || "", limit) };
      return item;
    }),
  }));
}

function trimIndex(path: string, callsDir: string): void {
  try {
    if (!existsSync(path) || statSync(path).size < MAX_INDEX_BYTES) return;
  } catch {
    return;
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const lines = text.split(/\r?\n/).filter((ln) => ln.trim());
  if (lines.length <= MAX_INDEX_LINES) return;
  const dropped = lines.slice(0, lines.length - MAX_INDEX_LINES);
  const keep = lines.slice(-MAX_INDEX_LINES);
  try {
    writeFileSync(path, keep.join("\n") + "\n");
  } catch {
    return;
  }
  for (const line of dropped) {
    try {
      const row = JSON.parse(line) as unknown;
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const cid = safeCallId(String((row as Record<string, unknown>).id || ""));
      if (!cid) continue;
      try {
        unlinkSync(join(callsDir, `${cid}.json`));
      } catch {
        /* already gone */
      }
    } catch {
      continue;
    }
  }
}

function asUsage(usage: Record<string, unknown> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!usage) return out;
  for (const key of COUNT_FIELDS) {
    const n = Number.parseInt(String(usage[key] ?? 0), 10);
    out[key] = Number.isFinite(n) ? n : 0;
  }
  return out;
}

function slotFor(role: string): string {
  const raw = (role || "solver").trim().toLowerCase() || "solver";
  let slot = raw === "coach" ? "observer" : raw;
  if (slot !== "solver" && slot !== "observer" && slot !== "loop") slot = "solver";
  if (flagOn(process.env.HEIMDALL_LOOP) && slot === "solver") slot = "loop";
  return slot;
}

export type RecordSessionOpts = {
  requestBody?: Buffer | Uint8Array | string | null;
  role?: string;
  model?: string;
  path?: string;
  status?: number | null;
  usage?: Record<string, unknown> | null;
  reply?: string;
  injected?: boolean;
  jobId?: string;
  background?: boolean;
};

function recordNow(
  workspace: string,
  opts: RecordSessionOpts,
): Record<string, unknown> | null {
  const body = parseBody(opts.requestBody);
  const messages = flattenMessages(body);
  const kinds = injectKinds(messages);
  if (opts.reply) {
    messages.push({ role: "assistant", parts: annotateText(clip(opts.reply, MAX_REPLY)) });
  }
  const ts = Date.now() / 1000;
  const slot = slotFor(opts.role || "solver");
  let modelName = (opts.model || "").trim();
  if (!modelName && body) modelName = String(body.model || "").trim();
  const jid = (opts.jobId || process.env.HEIMDALL_JOB_ID || "").trim();
  const callId = `${Math.trunc(ts * 1000).toString(16)}-${slot.slice(0, 1)}-${(seq++).toString(16)}`;
  const rec: Record<string, unknown> = {
    id: callId,
    ts,
    role: slot,
    model: modelName,
    path: opts.path || "",
    status: opts.status ?? null,
    injected: Boolean(opts.injected || kinds.length),
    inject: kinds,
    loop: flagOn(process.env.HEIMDALL_LOOP),
    job_id: jid,
    usage: asUsage(opts.usage),
    n_messages: messages.length,
    messages,
  };
  let raw = JSON.stringify(rec);
  if (raw.length > MAX_CALL_BYTES) {
    rec.messages = shrinkMessages(messages);
    rec.truncated = true;
    rec.n_messages = (rec.messages as SessMessage[]).length;
    raw = JSON.stringify(rec);
  }
  const index: Record<string, unknown> = {
    id: callId,
    ts,
    role: slot,
    model: modelName,
    injected: rec.injected,
    inject: kinds,
    status: opts.status ?? null,
    loop: rec.loop,
    job_id: jid,
    n_messages: rec.n_messages,
    usage: rec.usage,
  };
  const dest = sessionCallPath(workspace, callId);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, raw + "\n");
  const idx = sessionsIndex(workspace);
  mkdirSync(dirname(idx), { recursive: true });
  appendFileSync(idx, JSON.stringify(index) + "\n");
  trimIndex(idx, dirname(dest));
  return index;
}

/** Write one call. Fail-open: never throw into the proxy path. */
export function recordCallSession(
  workspace: string | null | undefined,
  opts: RecordSessionOpts = {},
): Record<string, unknown> | null {
  if (!workspace) return null;
  if (opts.background) {
    const ws = workspace;
    const snap: RecordSessionOpts = {
      requestBody: opts.requestBody
        ? Buffer.from(opts.requestBody as Buffer | Uint8Array | string)
        : null,
      role: opts.role,
      model: opts.model,
      path: opts.path,
      status: opts.status,
      usage: opts.usage ? { ...opts.usage } : null,
      reply: opts.reply || "",
      injected: opts.injected,
      jobId: opts.jobId,
      background: false,
    };
    bgLive += 1;
    setImmediate(() => {
      try {
        recordCallSession(ws, snap);
      } catch {
        /* fail-open */
      } finally {
        bgLive = Math.max(0, bgLive - 1);
      }
    });
    return null;
  }
  try {
    return recordNow(workspace, opts);
  } catch {
    return null;
  }
}

/** Tests only: wait until background dumps finish. */
export async function waitSessionWrites(timeout = 2000): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeout);
  while (bgLive > 0) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}

export function listCalls(workspace: string | null | undefined, limit = 200): Record<string, unknown>[] {
  if (!workspace) return [];
  const path = sessionsIndex(workspace);
  if (!existsSync(path)) return [];
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as unknown;
      if (row && typeof row === "object" && !Array.isArray(row) && (row as Record<string, unknown>).id) {
        out.push(row as Record<string, unknown>);
      }
    } catch {
      continue;
    }
  }
  const sliced = limit > 0 ? out.slice(-limit) : out;
  sliced.reverse();
  return sliced;
}

export function loadCall(workspace: string | null | undefined, callId: string): Record<string, unknown> | null {
  const cid = safeCallId(callId);
  if (!cid || !workspace) return null;
  const path = sessionCallPath(workspace, cid);
  if (!existsSync(path)) return null;
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
    return refreshRecord(doc as Record<string, unknown>);
  } catch {
    return null;
  }
}
