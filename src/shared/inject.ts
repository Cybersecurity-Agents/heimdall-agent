import { publicationDir, hasObservationPublication } from "./observation-publication.js";
import { currentJobId, readRecord } from "../observer/recap-state.js";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { jobHintText } from "./paths.js";

export const INJECT_MARKER = "<heimdall-map>";
export const INJECT_CLOSE = "</heimdall-map>";
export const BRIEF_MARKER = "<heimdall-brief>";
export const BRIEF_CLOSE = "</heimdall-brief>";

export const INJECT_SPECS: [string, string, string][] = [
  ["map", INJECT_MARKER, INJECT_CLOSE],
  ["brief", BRIEF_MARKER, BRIEF_CLOSE],
];

export type InjectHit = [start: number, end: number, kind: string];

function codeFenceRanges(raw: string): [number, number][] {
  const ranges: [number, number][] = [];
  let i = 0;
  while (true) {
    const a = raw.indexOf("```", i);
    if (a < 0) break;
    const b = raw.indexOf("```", a + 3);
    if (b < 0) break;
    ranges.push([a, b + 3]);
    i = b + 3;
  }
  return ranges;
}

function inRanges(index: number, ranges: [number, number][]): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function isBlockOpen(raw: string, index: number): boolean {
  return index === 0 || raw.charAt(index - 1) === "\n";
}

/** Real inject blocks: line-start marker, closed, not in a fence. Table/inline mentions do not count. */
export function findInjectHits(raw: string, kinds?: Iterable<string> | null): InjectHit[] {
  const want = kinds ? new Set([...kinds]) : null;
  const fences = codeFenceRanges(raw);
  const hits: InjectHit[] = [];
  for (const [kind, open, close] of INJECT_SPECS) {
    if (want && !want.has(kind)) continue;
    let start = 0;
    while (true) {
      const i = raw.indexOf(open, start);
      if (i < 0) break;
      start = i + open.length;
      if (!isBlockOpen(raw, i)) continue;
      if (inRanges(i, fences)) continue;
      const j = raw.indexOf(close, i + open.length);
      if (j < 0) continue;
      let end = j + close.length;
      if (raw.charAt(end) === "\n") end += 1;
      hits.push([i, end, kind]);
      start = j + close.length;
    }
  }
  hits.sort((a, b) => a[0] - b[0] || b[1] - a[1] - (a[1] - a[0]));
  const kept: InjectHit[] = [];
  for (const hit of hits) {
    if (kept.length && hit[0] < kept[kept.length - 1]![1]) continue;
    kept.push(hit);
  }
  return kept;
}

export function kindForMarker(open: string): string {
  const spec = INJECT_SPECS.find((item) => item[1] === open);
  return spec ? spec[0] : "";
}

function mergeHint(blob: string, hint: string): string | null {
  const text = (blob || "").trim();
  const h = (hint || "").trim();
  if (!text && !h) return null;
  if (!h) return text && findInjectHits(text, ["map"]).length ? (text.endsWith("\n") ? text : text + "\n") : null;
  if (!text) {
    return `${INJECT_MARKER}\nPLATFORM HINT:\n${h}\n${INJECT_CLOSE}\n`;
  }
  if (text.includes("PLATFORM HINT")) return text.endsWith("\n") ? text : text + "\n";
  const close = text.lastIndexOf(INJECT_CLOSE);
  if (close >= 0) {
    return `${text.slice(0, close)}PLATFORM HINT:\n${h}\n${text.slice(close)}`;
  }
  return `${text}\nPLATFORM HINT:\n${h}\n`;
}

export function composeInjectBlob(workspace?: string | null): string | null {
  let blob = "";
  // Legacy files may be startup defaults or unvalidated observer drafts.
  // Only a committed publication belonging to this job can supply the map.
  if (hasObservationPublication(workspace)) {
    const dir = publicationDir(workspace);
    const ws = workspace || process.env.HEIMDALL_WORKSPACE || "/workspace";
    const state = readRecord<{ jobId: string }>(join(dir, "observation.json"));
    if (state?.jobId && state.jobId === currentJobId(ws)) {
      try { blob = readFileSync(join(dir, "inject.txt"), "utf8"); } catch { /* No usable map. */ }
      blob = blob.replace(/(?:^|\n)PLATFORM HINT:\n[\s\S]*?(?=\n<\/heimdall-map>)/, "");
    }
  }
  return mergeHint(blob, jobHintText(workspace));
}

type SystemTextBlock = { type: "text"; text: string; [k: string]: unknown };

function systemTextOf(item: unknown): string {
  if (typeof item === "string") return item;
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const text = (item as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

function asSystemTextBlock(text: string): SystemTextBlock {
  return { type: "text", text };
}

/** DeepSeek / GLM `/anthropic` reject a bare string `system` (Pi and Claude Code SDK). */
function toSystemBlocks(system: unknown): unknown[] {
  if (Array.isArray(system)) {
    return system.map((item) => (typeof item === "string" ? asSystemTextBlock(item) : item));
  }
  if (typeof system === "string") return [asSystemTextBlock(system)];
  if (system && typeof system === "object") return [system];
  return [];
}

function withText(item: unknown, text: string): unknown {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    return { ...(item as Record<string, unknown>), text };
  }
  return asSystemTextBlock(text);
}

function normalizeBlob(blob: string): string {
  return blob.trim() + "\n";
}

function replaceHits(text: string, hits: InjectHit[], blob: string): string {
  if (!hits.length) return text;
  const first = hits[0]!;
  let out = text.slice(0, first[0]) + blob + text.slice(first[1]);
  const shift = blob.length - (first[1] - first[0]);
  for (let i = hits.length - 1; i >= 1; i--) {
    const hit = hits[i]!;
    const a = hit[0] + shift;
    const b = hit[1] + shift;
    out = out.slice(0, a) + out.slice(b);
  }
  return out;
}

function stripHits(text: string, hits: InjectHit[]): string {
  let out = text;
  for (let i = hits.length - 1; i >= 0; i--) {
    const hit = hits[i]!;
    out = out.slice(0, hit[0]) + out.slice(hit[1]);
  }
  return out.replace(/\n{3,}/g, "\n\n");
}

function injectBlock(raw: Buffer, blob: string | null, open: string, _close: string): Buffer {
  const kind = kindForMarker(open) || open;
  if (!blob && kind !== "map") return raw;
  try {
    const doc = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    const block = blob ? normalizeBlob(blob) : "";
    const blocks = toSystemBlocks(doc.system);
    if (!blob && !blocks.some(item => findInjectHits(systemTextOf(item), [kind]).length)) return raw;
    let replaced = false;
    const next: unknown[] = [];
    for (const item of blocks) {
      const text = systemTextOf(item);
      const hits = findInjectHits(text, [kind]);
      if (!hits.length) {
        next.push(item);
        continue;
      }
      if (blob && !replaced) {
        const updated = replaceHits(text, hits, block);
        if (updated === text) next.push(item);
        else next.push(withText(item, updated));
        replaced = true;
        continue;
      }
      const stripped = stripHits(text, hits).trim();
      if (stripped) next.push(withText(item, stripped.endsWith("\n") ? stripped : stripped + "\n"));
    }
    if (blob && !replaced) next.push(asSystemTextBlock(block));
    doc.system = next;
    return Buffer.from(JSON.stringify(doc), "utf8");
  } catch {
    return raw;
  }
}

export type LlmRequestFormat = "anthropic" | "chat" | "responses";

/** Edit only instruction text. Leave encrypted reasoning, tool calls and images untouched. */
function injectOtherFormat(raw: Buffer, blob: string | null, kind: string, format: LlmRequestFormat): Buffer {
  if (!blob && kind !== "map") return raw;
  try {
    const doc = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    const field = format === "responses" ? "input" : "messages";
    const original = doc[field];
    const messages: Record<string, unknown>[] = Array.isArray(original) ? original : typeof original === "string" ? [{ role: "user", content: original }] : [];
    let replaced = false, changed = false;
    const edit = (text: string): string => {
      const hits = findInjectHits(text, [kind]);
      if (!hits.length) return text;
      const updated = blob && !replaced ? replaceHits(text, hits, normalizeBlob(blob)) : stripHits(text, hits);
      if (blob) replaced = true;
      if (updated !== text) changed = true;
      return updated;
    };
    if (format === "responses" && typeof doc.instructions === "string") doc.instructions = edit(doc.instructions);
    for (const msg of messages) {
      if (!msg || !["system", "developer"].includes(String(msg.role))) continue;
      if (typeof msg.content === "string") msg.content = edit(msg.content);
      else if (Array.isArray(msg.content)) for (const part of msg.content) {
        if (part && ["text", "input_text"].includes(part.type) && typeof part.text === "string") part.text = edit(part.text);
      }
    }
    if (blob && !replaced) {
      changed = true;
      // Keep the existing prefix stable for caching. A separate instruction item is
      // valid in both Chat Completions and Responses and does not mutate history.
      messages.push({ role: "system", content: normalizeBlob(blob) });
    }
    if (!changed) return raw;
    doc[field] = messages;
    return Buffer.from(JSON.stringify(doc));
  } catch { return raw; }
}

export function injectMapIntoMessages(raw: Buffer, blob: string | null, format: LlmRequestFormat = "anthropic"): Buffer {
  return format === "anthropic" ? injectBlock(raw, blob, INJECT_MARKER, INJECT_CLOSE) : injectOtherFormat(raw, blob, "map", format);
}

export function injectBriefIntoMessages(raw: Buffer, blob: string | null, format: LlmRequestFormat = "anthropic"): Buffer {
  return format === "anthropic" ? injectBlock(raw, blob, BRIEF_MARKER, BRIEF_CLOSE) : injectOtherFormat(raw, blob, "brief", format);
}

export function requestHasRealInject(raw: Buffer, kind: "map" | "brief" = "map"): boolean {
  try {
    const doc = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    const instructionText = toSystemBlocks(doc.system).map(systemTextOf);
    if (typeof doc.instructions === "string") instructionText.push(doc.instructions);
    for (const field of ["messages", "input"]) {
      if (!Array.isArray(doc[field])) continue;
      for (const msg of doc[field]) if (msg && ["system", "developer"].includes(msg.role)) {
        instructionText.push(...toSystemBlocks(msg.content).map(systemTextOf));
      }
    }
    return instructionText.some(text => findInjectHits(text, [kind]).length > 0);
  } catch { return false; }
}
