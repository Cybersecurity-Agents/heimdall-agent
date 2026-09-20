import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { flagOn } from "../shared/env.js";
import {
  advisorBriefMd,
  generatedBriefMd,
  mapJson,
  readText,
  workspaceDir,
} from "../shared/paths.js";
import { sprayEnabled } from "../observer/spray.js";
import { stripSpraySummaries } from "../observer/spray-stamp.js";

const BRIEF_MARKER = "<heimdall-brief>";
const BRIEF_CLOSE = "</heimdall-brief>";
const BRIEF_ATTRIBUTION = "Below is a summary of the first regular attempt, for reference.";
const BRIEF_LOOP_ATTRIBUTION = "Below is a summary of the prior loop attempt, for reference.";
const BRIEF_FOLLOW = "This is a suggested direction, not a duty. New evidence or PLATFORM HINT may overturn it.";
const BRIEF_LOCK_WINS =
  "If the brief conflicts with PLATFORM HINT, the hint wins. If it conflicts with the coverage-map LOCK, the updated map wins.";

const CODE_TAIL = /^([a-z]+)-?(\d{1,3})$/;

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return doc && typeof doc === "object" && !Array.isArray(doc)
      ? (doc as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function canonicalBriefCode(uniqueCode: string | null | undefined): string {
  let raw = String(uniqueCode || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  raw = raw.replace(/[^a-z0-9-]+/g, "");
  raw = raw.replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
  if (!raw) return "";
  const m = CODE_TAIL.exec(raw);
  if (m) return `${m[1]}-${String(Number.parseInt(m[2] || "0", 10)).padStart(2, "0")}`;
  return raw;
}

export function jobUniqueCode(workspace?: string | null): string {
  const ws = workspaceDir(workspace);
  const inp = join(ws, "input.json");
  if (existsSync(inp)) {
    const doc = readJson(inp);
    const code = String(doc.unique_code || "").trim();
    if (code) return canonicalBriefCode(code);
  }
  return canonicalBriefCode(process.env.UNIQUE_CODE || "");
}

export function loadGeneratedBody(workspace?: string | null, uniqueCode = ""): string {
  const want = canonicalBriefCode(uniqueCode);
  if (workspace) {
    const body = readText(generatedBriefMd(workspace)).trim();
    const job = existsSync(join(workspaceDir(workspace), "input.json"))
      ? jobUniqueCode(workspace)
      : "";
    if (body && (!want || !job || want === job)) return body;
  }
  return "";
}

export function saveGeneratedBrief(workspace: string | null | undefined, body: string, uniqueCode = ""): string | null {
  let text = (body || "").trim();
  if (!text || !workspace) return null;
  if (!sprayEnabled(workspace)) text = stripSpraySummaries(text).trim();
  const dest = generatedBriefMd(workspace);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text + "\n");
  try {
    chmodSync(dest, 0o666);
  } catch {
    /* ignore */
  }
  void uniqueCode;
  return dest;
}

export function writeBrief(workspace?: string | null, opts: { force?: boolean; uniqueCode?: string } = {}): string | null {
  const body = loadGeneratedBody(workspace, opts.uniqueCode || "");
  if (!body && !opts.force) return null;
  const text = wrapBrief(body, workspace);
  if (!text || !workspace) return null;
  const dest = advisorBriefMd(workspace);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text);
  try {
    chmodSync(dest, 0o666);
  } catch {
    /* ignore */
  }
  return dest;
}

function skipPiBrief(workspace?: string | null): boolean {
  const doc = readJson(join(workspaceDir(workspace), "input.json"));
  if (doc.skip_pi || doc.loop_from_loop) return true;
  const loop = ["1", "true", "yes", "on"].includes(String(doc.loop ?? "").trim().toLowerCase()) ||
    String(doc.job_kind || "").toLowerCase() === "loop";
  return loop && String(doc.challenge_type || "").trim().toLowerCase() === "intranet";
}

export function wrapBrief(body: string, workspace?: string | null): string {
  const text = (body || "").trim();
  if (!text) return "";
  const lead = skipPiBrief(workspace) ? BRIEF_LOOP_ATTRIBUTION : BRIEF_ATTRIBUTION;
  const inner = `${lead} ${BRIEF_FOLLOW}\n${BRIEF_LOCK_WINS}\n\n${text}\n`;
  return `${BRIEF_MARKER}\n${inner}${BRIEF_CLOSE}\n`;
}

export function detectJob(workspace?: string | null): string {
  const code = jobUniqueCode(workspace);
  return code && loadGeneratedBody(workspace, code) ? code : "";
}

export function composeBriefBlob(workspace?: string | null): string | null {
  if (!detectJob(workspace)) return null;
  const p = advisorBriefMd(workspace);
  if (existsSync(p)) {
    const raw = readText(p).trim();
    if (raw && raw.includes(BRIEF_MARKER)) return raw.endsWith("\n") ? raw : raw + "\n";
  }
  return wrapBrief(loadGeneratedBody(workspace, jobUniqueCode(workspace)), workspace) || null;
}

function lockItems(workspace?: string | null): Record<string, unknown>[] {
  const items = readJson(mapJson(workspace)).lock;
  if (!Array.isArray(items)) return [];
  return items.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === "object" && (x as Record<string, unknown>).asset));
}

function findingsLeads(workspace?: string | null): Record<string, unknown>[] {
  const doc = readJson(join(workspaceDir(workspace), "findings.json"));
  const items = doc.leads;
  if (!Array.isArray(items)) return [];
  const out: Record<string, unknown>[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const status = String(rec.status || "open").trim().toLowerCase();
    if (["dropped", "dead", "closed", "done"].includes(status)) continue;
    if (rec.asset || rec.id) out.push(rec);
  }
  return out;
}

export function formatObligation(workspace?: string | null): string {
  const seen = new Set<string>();
  const items: Record<string, unknown>[] = [];
  for (const item of [...lockItems(workspace), ...findingsLeads(workspace)]) {
    const key = String(item.asset || item.id || "");
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    items.push(item);
  }
  if (!items.length) return "";
  const lines: string[] = [];
  lines.push("Observer direction (suggestion). PLATFORM HINT wins when present; see the system prompt for how to read it.");
  for (const item of items.slice(0, 3)) {
    const asset = String(item.asset || item.id || "");
    const ev = String(item.evidence || "");
    lines.push(`- ${asset}` + (ev ? ` | ${ev}` : ""));
  }
  return lines.join("\n");
}

export function isLoopEnv(): boolean {
  return flagOn(process.env.HEIMDALL_LOOP);
}
