import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { eventsJsonl, httpJsonl, turnsJsonl } from "../shared/paths.js";
import { nodeRefs, type Evidence, type EvidenceSnapshot, type LogSource, type NodeDetails, type Publication } from "../shared/observer-contract.js";
import { acceptedReceipts, currentJobId, readRecord, type Receipt } from "./recap-state.js";

export function redactEvidence(text: string): string {
  return text.replace(/flag\{[^{}]*\}/gi, "[flag omitted]");
}
/** Stream a ledger with bounded memory. Skip oversized/corrupt rows, never reinterpret them. */
function scanLedger(path: string, visit: (row: Record<string, unknown>) => boolean): void {
  if (!existsSync(path)) return;
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(64 * 1024);
  let carry = Buffer.alloc(0), skipping = false;
  try {
    let n: number;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
      carry = Buffer.concat([carry, buf.subarray(0, n)]);
      let at: number;
      while ((at = carry.indexOf(10)) >= 0) {
        const line = carry.subarray(0, at); carry = carry.subarray(at + 1);
        if (skipping) { skipping = false; continue; }
        try { if (visit(JSON.parse(line.toString("utf8")))) return; } catch { /* broken row */ }
      }
      if (carry.length > 1024 * 1024) { carry = Buffer.alloc(0); skipping = true; }
    }
  } finally { closeSync(fd); }
}
function sourceValid(s: LogSource): boolean {
  return !!s && ["events", "http"].includes(s.log) && Number.isSafeInteger(s.start) && Number.isSafeInteger(s.end)
    && s.start >= 0 && s.end > s.start && /^[a-f0-9]{64}$/.test(s.sha256);
}
export function collectEvidence(ws: string, nodes: NodeDetails[], receipts = acceptedReceipts(ws, currentJobId(ws), true)): Record<string, Evidence> {
  const wanted = new Set(nodes.flatMap(nodeRefs));
  const items: Record<string, Evidence> = Object.create(null);
  const jobId = currentJobId(ws);
  const put = (e: Evidence) => { if (wanted.has(e.ref)) items[e.ref] = e; };
  const input = readRecord<Record<string, unknown>>(join(ws, "input.json"));
  if (input) {
    // Only task facts, not runtime configuration or credentials.
    const facts = Object.fromEntries(["unique_code", "name", "title", "description", "url", "target", "flag_count"]
      .filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
    const full = JSON.stringify(facts, null, 2);
    put({ ref: "input:task", kind: "input", jobId, text: redactEvidence(full.slice(0, 8000)), truncated: full.length > 8000 });
  }
  if (wanted.has("input:hint")) {
    const raw = readBounded(join(ws, "hint.txt"), 8000);
    if (raw) put({ ref: "input:hint", kind: "input", jobId, text: redactEvidence(raw.text), truncated: raw.truncated });
  }
  for (const receipt of receipts) put(receiptEvidence(receipt));
  const turns = new Set([...wanted].filter((ref) => ref.startsWith("turn:")));
  if (turns.size) scanLedger(turnsJsonl(ws), (row) => {
    const ref = `turn:${row.n}`;
    if (turns.has(ref) && typeof row.jobId === "string" && typeof row.detail === "string") {
      put({ ref, kind: "excerpt", jobId: row.jobId, text: redactEvidence(row.detail.slice(0, 8000)), truncated: true,
        sources: Array.isArray(row.sources) ? (row.sources as LogSource[]).filter(sourceValid).slice(0, 160) : [] });
      turns.delete(ref);
    }
    return !turns.size;
  });
  return items;
}
function receiptEvidence(r: Receipt): Evidence {
  return { ref: `receipt:${r.id}`, kind: "receipt", jobId: r.jobId, truncated: false,
    text: JSON.stringify({ acceptedAt: r.acceptedAt, flagIndex: r.flagIndex, correctCount: r.correctCount,
      totalCount: r.totalCount, duplicate: r.duplicate }, null, 2) };
}
function readBounded(path: string, max: number): { text: string; truncated: boolean } | null {
  try {
    const fd = openSync(path, "r");
    try { const b = Buffer.alloc(max + 1); const n = readSync(fd, b, 0, b.length, 0);
      return { text: b.subarray(0, Math.min(n, max)).toString("utf8"), truncated: n > max }; }
    finally { closeSync(fd); }
  } catch { return null; }
}
export function evidenceErrors(ws: string, nodes: NodeDetails[], receipts?: Receipt[]): string[] {
  const items = collectEvidence(ws, nodes, receipts);
  const errors = [...new Set(nodes.flatMap(nodeRefs))].filter((ref) => !items[ref]).map((ref) => `unknown evidence reference: ${ref}`);
  for (const node of nodes) {
    const kind = (node as NodeDetails & { kind?: string }).kind;
    if (kind === "flag" && !nodeRefs(node).some((ref) => items[ref]?.kind === "receipt")) errors.push("flag node requires a platform receipt");
  }
  return errors;
}
export function makeEvidenceSnapshot(ws: string, nodes: NodeDetails[], publication: Publication, receipts?: Receipt[]): EvidenceSnapshot {
  const items = collectEvidence(ws, nodes, receipts);
  for (const node of nodes) if (node.evidenceRefs.includes("system:spray-dict")) {
    items["system:spray-dict"] = { ref: "system:spray-dict", kind: "system", jobId: publication.jobId,
      text: node.summary.basis, truncated: false };
  }
  return { publication, items };
}
/** Verify original bytes before showing them; rotated/truncated data must never masquerade as evidence. */
export function attachRaw(ws: string, items: Evidence[]): Evidence[] {
  let budget = 128 * 1024;
  return items.map((item) => ({ ...item, raw: (item.sources || []).map((source) => {
    if (!sourceValid(source)) return { log: "unknown", unavailable: "invalid_source" };
    const length = source.end - source.start;
    if (length > budget || length > 64 * 1024) return { log: source.log, unavailable: "size_limit", truncated: true };
    budget -= length;
    try {
      const fd = openSync(source.log === "events" ? eventsJsonl(ws) : httpJsonl(ws), "r");
      try {
        const b = Buffer.alloc(length); const n = readSync(fd, b, 0, length, source.start);
        if (n !== length || createHash("sha256").update(b).digest("hex") !== source.sha256)
          return { log: source.log, unavailable: "source_changed" };
        return { log: source.log, text: redactEvidence(b.toString("utf8")) };
      } finally { closeSync(fd); }
    } catch { return { log: source.log, unavailable: "source_missing" }; }
  }) }));
}
