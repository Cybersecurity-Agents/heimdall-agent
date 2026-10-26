import { StringDecoder } from "node:string_decoder";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const COUNT_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
] as const;
export const USAGE_FIELDS = [...COUNT_FIELDS, "calls"] as const;

export type UsageCounts = Record<(typeof USAGE_FIELDS)[number], number>;

function asInt(value: unknown): number {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function emptyUsage(): UsageCounts {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    calls: 0,
  };
}

export function billed(rec: Record<string, unknown> | null | undefined): number {
  if (!rec) return 0;
  return COUNT_FIELDS.reduce((sum, k) => sum + asInt(rec[k]), 0);
}

export function addTotals(
  dst: UsageCounts,
  src: Record<string, unknown> | null | undefined,
): UsageCounts {
  if (!src) return dst;
  for (const key of USAGE_FIELDS) dst[key] = asInt(dst[key]) + asInt(src[key]);
  return dst;
}

function modelsMap(rec: Record<string, unknown>): Record<string, UsageCounts> | null {
  const raw = rec.models;
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, UsageCounts> = {};
  if (Array.isArray(raw)) {
    for (const slot of raw) {
      if (!slot || typeof slot !== "object") continue;
      const name = String((slot as Record<string, unknown>).name || "").trim();
      if (!name) continue;
      const acc = emptyUsage();
      addTotals(acc, slot as Record<string, unknown>);
      out[name] = acc;
    }
    return Object.keys(out).length ? out : null;
  }
  for (const [name, slot] of Object.entries(raw as Record<string, unknown>)) {
    const label = name.trim();
    if (!label || !slot || typeof slot !== "object") continue;
    const acc = emptyUsage();
    addTotals(acc, slot as Record<string, unknown>);
    out[label] = acc;
  }
  return Object.keys(out).length ? out : null;
}

export function usageJson(workspace: string): string {
  return join(workspace, ".heimdall", "llm", "usage.json");
}

export function readTotals(workspace: string | null | undefined): Record<string, unknown> | null {
  if (!workspace) return null;
  const path = usageJson(workspace);
  if (!existsSync(path)) return null;
  try {
    const rec = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
    const raw = rec as Record<string, unknown>;
    const out: Record<string, unknown> = { ...emptyUsage() };
    addTotals(out as UsageCounts, raw);
    if (raw.updated_ts != null) out.updated_ts = raw.updated_ts;
    out.code = raw.code || workspace.split(/[/\\]/).pop() || "";
    const models = modelsMap(raw);
    if (models) out.models = models;
    return out;
  } catch {
    return null;
  }
}

function asNonNeg(value: unknown): number {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function extractUsage(obj: unknown): UsageCounts | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  let usage: Record<string, unknown> | null = rec.usage && typeof rec.usage === "object" && !Array.isArray(rec.usage)
    ? (rec.usage as Record<string, unknown>)
    : null;
  const msg = rec.message || rec.response;
  if (!usage && msg && typeof msg === "object" && !Array.isArray(msg)) {
    const nested = (msg as Record<string, unknown>).usage;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) usage = nested as Record<string, unknown>;
  }
  if (!usage) {
    const keys = ["input_tokens", "output_tokens", "prompt_tokens", "input", "output", "cacheRead"];
    if (keys.some((k) => k in rec)) usage = rec;
  }
  if (!usage) return null;
  const details = usage.prompt_tokens_details || usage.input_tokens_details;
  const cacheRead =
    asNonNeg(usage.cache_read_input_tokens) ||
    asNonNeg(usage.cache_read_tokens) ||
    asNonNeg(usage.cached_tokens) ||
    asNonNeg(usage.prompt_cache_hit_tokens) ||
    asNonNeg(usage.cacheRead) ||
    (details && typeof details === "object" && !Array.isArray(details)
      ? asNonNeg((details as Record<string, unknown>).cached_tokens)
      : 0);
  const cacheWrite =
    asNonNeg(usage.cache_creation_input_tokens) ||
    asNonNeg(usage.cache_creation_tokens) ||
    asNonNeg(usage.cache_write_tokens) ||
    asNonNeg(usage.cacheWrite);
  let input = asNonNeg(usage.input_tokens) || asNonNeg(usage.input);
  // Responses input_tokens includes cached tokens; Anthropic input_tokens does not.
  if (usage.input_tokens_details && input >= cacheRead) input -= cacheRead;
  const prompt = asNonNeg(usage.prompt_tokens);
  if (!input && prompt) input = prompt >= cacheRead ? prompt - cacheRead : prompt;
  const output = asNonNeg(usage.output_tokens) || asNonNeg(usage.completion_tokens) || asNonNeg(usage.output);
  const out: UsageCounts = {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    calls: 0,
  };
  if (!COUNT_FIELDS.some((k) => out[k] > 0)) return out;
  return out;
}

export function mergeCall(
  dst: UsageCounts,
  src: Record<string, unknown> | null | undefined,
): UsageCounts {
  if (!src) return dst;
  for (const key of ["input_tokens", "cache_read_tokens", "cache_write_tokens"] as const) {
    const val = asInt(src[key]);
    if (val) dst[key] = val;
  }
  const out = asInt(src.output_tokens);
  if (out >= asInt(dst.output_tokens)) dst.output_tokens = out;
  return dst;
}

function usageObjectRe(): RegExp {
  return /"usage"\s*:\s*(\{(?:[^{}]|\{[^{}]*\})*\})/g;
}

export function scanUsageText(text: string): UsageCounts | null {
  const raw = (text || "").trim();
  if (!raw) return null;
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      return extractUsage(JSON.parse(raw));
    } catch {
      /* fall through to SSE */
    }
  }
  const acc = emptyUsage();
  let found = false;
  for (const match of raw.matchAll(usageObjectRe())) {
    try {
      const piece = extractUsage({ usage: JSON.parse(match[1]!) });
      if (!piece) continue;
      found = true;
      mergeCall(acc, piece);
    } catch {
      /* ignore one event */
    }
  }
  return found ? acc : null;
}

/** Incremental SSE/JSON scanner. Does not keep the full response. */
export class UsageScanner {
  private decoder = new StringDecoder("utf8");
  private buf = "";
  usage: UsageCounts = emptyUsage();
  found = false;

  feed(chunk: Buffer | Uint8Array | string | null | undefined): void {
    if (chunk == null) return;
    if (typeof chunk !== "string" && chunk.length === 0) return;
    if (typeof chunk === "string" && !chunk) return;
    const text = typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
    this.buf += text;
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
    this.scanUsageObjects(this.buf);
  }

  private eatEvent(event: string): void {
    let payload = "";
    for (const line of event.split(/\r?\n/)) {
      if (line.startsWith("data:")) payload += line.slice(5).trimStart();
    }
    const trimmed = payload.trim();
    if (!trimmed || trimmed === "[DONE]") return;
    try {
      const got = extractUsage(JSON.parse(payload) as unknown);
      if (!got) return;
      this.found = true;
      mergeCall(this.usage, got);
    } catch {
      this.scanUsageObjects(payload);
    }
  }

  private scanUsageObjects(text: string): void {
    if (!text.includes('"usage"') && !text.includes("input_tokens") && !text.includes("prompt_tokens")) {
      return;
    }
    for (const match of text.matchAll(usageObjectRe())) {
      try {
        const got = extractUsage(JSON.parse(match[1]!));
        if (!got) continue;
        this.found = true;
        mergeCall(this.usage, got);
      } catch {
        /* ignore one object */
      }
    }
  }

  finish(): UsageCounts {
    this.buf += this.decoder.end();
    this.decoder = new StringDecoder("utf8");
    this.drain();
    const leftover = this.buf.trim();
    if (leftover) {
      try {
        const got = extractUsage(JSON.parse(leftover) as unknown);
        if (got) {
          this.found = true;
          mergeCall(this.usage, got);
        }
      } catch {
        this.scanUsageObjects(leftover);
      }
    }
    this.buf = "";
    return { ...this.usage };
  }
}

export function recordCall(
  workspace: string | null | undefined,
  usage: Record<string, unknown> | null | undefined,
  opts: { role?: string; model?: string; path?: string; status?: number | null } = {},
): UsageCounts | null {
  if (!workspace) return null;
  const increment = emptyUsage();
  increment.calls = 1;
  addTotals(increment, usage);
  const totals = (readTotals(workspace) as Record<string, unknown> | null) || { ...emptyUsage() };
  addTotals(totals as UsageCounts, increment);
  totals.updated_ts = Date.now() / 1000;
  totals.code = String(totals.code || workspace.split(/[/\\]/).pop() || "");
  const models = modelsMap(totals) || {};
  const label = (opts.model || "").trim() || "unknown";
  const slot = emptyUsage();
  addTotals(slot, models[label]);
  addTotals(slot, increment);
  models[label] = slot;
  totals.models = models;
  const path = usageJson(workspace);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(totals, null, 2) + "\n");
  } catch {
    return totals as UsageCounts;
  }
  try {
    const line = JSON.stringify({
      ts: totals.updated_ts,
      role: opts.role || "solver",
      model: label,
      path: opts.path || "",
      status: opts.status ?? null,
      ...increment,
    });
    const log = join(dirname(path), "usage.jsonl");
    let size = 0;
    try {
      if (existsSync(log)) size = statSync(log).size;
    } catch {
      size = 0;
    }
    if (size < 16 * 1024 * 1024) {
      writeFileSync(log, line.slice(0, 4000) + "\n", { flag: "a" });
    }
  } catch {
    /* ignore jsonl */
  }
  return totals as UsageCounts;
}
