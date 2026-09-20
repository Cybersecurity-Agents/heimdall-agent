import { hasObservationPublication } from "../shared/observation-publication.js";
import { existsSync, readFileSync } from "node:fs";
import { atomicWrite } from "../shared/fsutil.js";
import { confirmedMd, injectTxt, mapMd } from "../shared/paths.js";
import { type SprayDictMeta } from "./spray.js";

const CONFIRMED_HEAD = /^CONFIRMED\s*:/i;
const ANGLES_HEAD = /^ANGLES\s*:/i;
const DICT_CONFIRMED = /^DICT\b/;
const DICT_ANGLE = /^spray_creds rev=\d+ 已更新/;
export const SPRAY_DICT_ID = "spray-dict";
/** ANGLES that tell the solver to spray leftover host dictionaries. */
export const SPRAY_ANGLE_RE =
  /spray_creds rev=\d+|spray_(?:users|passwords|creds)\.txt|按表再喷|字典已备|^DICT\b/i;
const SECTION = /^[A-Z][A-Z0-9 _-]{1,20}:\s*$/;
const INLINE_SECTION = /^[A-Z][A-Z0-9 _-]{1,20}:/;

export function dictConfirmedBullet(meta: SprayDictMeta): string {
  return (
    `DICT rev=${meta.rev} ${meta.status} · ${meta.creds} creds / ${meta.users} users / ${meta.passwords} pw` +
    ` → spray_creds.txt（空读过一次不算没有字典；rev 变了的登录面可再扫）`
  );
}

export function dictAngleBullet(meta: SprayDictMeta): string {
  return `spray_creds rev=${meta.rev} 已更新 — 未用本 rev 扫过的 SSH/FTP/HTTP 登录面按表再喷`;
}

export function dictMapLine(meta: SprayDictMeta): string {
  return `DICT rev=${meta.rev} ${meta.status} · ${meta.creds} creds / ${meta.users} users / ${meta.passwords} pw → spray_creds.txt`;
}

export function dictNodeNote(meta: SprayDictMeta): string {
  return `DICT rev=${meta.rev} ${meta.status} · ${meta.creds} creds`;
}

function isOtherSection(line: string, head: RegExp): boolean {
  const stripped = line.trim();
  if (!stripped || stripped.startsWith("-") || head.test(stripped)) return false;
  if (SECTION.test(stripped) || stripped.startsWith("</")) return true;
  return INLINE_SECTION.test(stripped);
}

function sectionBullets(text: string, head: RegExp): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let inSec = false;
  const bullets: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (head.test(line)) {
      inSec = true;
      const rest = line.includes(":") ? line.slice(line.indexOf(":") + 1).trim() : "";
      if (rest && !["(none)", "none", "-"].includes(rest)) bullets.push(rest);
      continue;
    }
    if (inSec) {
      if (SECTION.test(line) || (line.endsWith(":") && line.slice(0, -1) === line.slice(0, -1).toUpperCase())) break;
      if (line.startsWith("- ")) bullets.push(line.slice(2).trim());
      else if (line && !line.startsWith("#") && !bullets.length) bullets.push(line);
    }
  }
  return bullets.filter(Boolean);
}

function replaceSectionBullets(text: string, head: RegExp, bullets: string[]): string {
  const lines = String(text || "").split(/\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (head.test(lines[i]!.trim())) {
      start = i;
      break;
    }
  }
  if (start < 0) return text;
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    if (isOtherSection(lines[j]!, head)) {
      end = j;
      break;
    }
  }
  const prefix = lines.slice(0, start + 1);
  const suffix = lines.slice(end);
  const body = bullets.map((b) => `- ${b}`);
  return prefix.concat(body, suffix).join("\n").replace(/\s+$/, "") + "\n";
}

function ensureConfirmedSection(text: string): string {
  if (CONFIRMED_HEAD.test(text) || /^CONFIRMED\s*:/m.test(text)) return text;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const insertAt = lines.findIndex((l) => {
    const t = l.trim();
    return /^(LOCK|ANGLES|TENSION|FORBID)\s*:/i.test(t) || t === "</heimdall-map>";
  });
  if (insertAt < 0) {
    if (text.includes("</heimdall-map>")) return text.replace("</heimdall-map>", "CONFIRMED:\n</heimdall-map>");
    return text.replace(/\s*$/, "\nCONFIRMED:\n");
  }
  lines.splice(insertAt, 0, "CONFIRMED:");
  return lines.join("\n");
}

function hasSection(text: string, head: RegExp): boolean {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .some((line) => head.test(line.trim()));
}

function upsertHostBullet(text: string, head: RegExp, drop: RegExp, insert: string | null, unshift: boolean): string {
  let raw = text;
  if (!hasSection(raw, head)) {
    if (!insert) return text;
    if (head !== CONFIRMED_HEAD) return text;
    raw = ensureConfirmedSection(raw);
  }
  const bullets = sectionBullets(raw, head).filter((b) => !drop.test(b));
  if (insert) {
    if (unshift) bullets.unshift(insert);
    else bullets.push(insert);
  }
  return replaceSectionBullets(raw, head, bullets);
}

export function stampInjectText(text: string, meta: SprayDictMeta): string {
  const hasDict = meta.status === "ready" || meta.status === "updated";
  let out = upsertHostBullet(text, CONFIRMED_HEAD, DICT_CONFIRMED, hasDict ? dictConfirmedBullet(meta) : null, true);
  if (hasDict) {
    const angle = meta.status === "updated" ? dictAngleBullet(meta) : null;
    out = upsertHostBullet(out, ANGLES_HEAD, DICT_ANGLE, angle, true);
  } else {
    out = stripSpraySummaries(out);
  }
  return out;
}

export function stripSpraySummaries(text: string): string {
  let out = upsertHostBullet(text, CONFIRMED_HEAD, DICT_CONFIRMED, null, false);
  if (hasSection(out, ANGLES_HEAD)) {
    out = upsertHostBullet(out, ANGLES_HEAD, SPRAY_ANGLE_RE, null, false);
  }
  return out.replace(/^(?:DICT\b.*\n)+/m, "");
}

function stampConfirmedMdText(text: string, meta: SprayDictMeta): string {
  const hasDict = meta.status === "ready" || meta.status === "updated";
  return upsertHostBullet(text, CONFIRMED_HEAD, DICT_CONFIRMED, hasDict ? dictConfirmedBullet(meta) : null, true);
}

function stampMapMdText(text: string, meta: SprayDictMeta): string {
  const body = text.replace(/^(?:DICT\b.*\n)+/m, "");
  if (meta.status !== "ready" && meta.status !== "updated") return body;
  const line = dictMapLine(meta);
  if (!body.trim()) return `${line}\n`;
  return `${line}\n${body.replace(/^\n+/, "")}`;
}

function writeIfPresent(path: string, next: string, prev: string): void {
  if (next === prev) return;
  atomicWrite(path, next);
}

export function stampSprayLedger(workspace: string | null | undefined, meta: SprayDictMeta): void {
  if (hasObservationPublication(workspace)) return;
  const inj = injectTxt(workspace);
  if (existsSync(inj)) {
    try {
      const prev = readFileSync(inj, "utf8");
      writeIfPresent(inj, stampInjectText(prev, meta), prev);
    } catch {
      /* ignore */
    }
  }
  const confirmed = confirmedMd(workspace);
  if (existsSync(confirmed)) {
    try {
      const prev = readFileSync(confirmed, "utf8");
      writeIfPresent(confirmed, stampConfirmedMdText(prev, meta), prev);
    } catch {
      /* ignore */
    }
  }
  const map = mapMd(workspace);
  if (existsSync(map)) {
    try {
      const prev = readFileSync(map, "utf8");
      writeIfPresent(map, stampMapMdText(prev, meta), prev);
    } catch {
      /* ignore */
    }
  }
}

type GNode = Record<string, unknown>;
type GEdge = Record<string, unknown>;
type GView = { nodes: GNode[]; edges: GEdge[]; source?: string; [k: string]: unknown };

export function attachSprayDictView(view: GView, meta: SprayDictMeta | null | undefined): GView {
  const nodes = (view.nodes || []).filter((n) => n && String(n.id || "") !== SPRAY_DICT_ID);
  const edges = (view.edges || []).filter((e) => {
    if (!e) return false;
    return String(e.from || "") !== SPRAY_DICT_ID && String(e.to || "") !== SPRAY_DICT_ID;
  });
  const recon = nodes.find((n) => String(n.group || n.kind || "") === "recon");
  if (recon && meta && (meta.status === "ready" || meta.status === "updated")) {
    const note = dictNodeNote(meta);
    nodes.push({
      id: SPRAY_DICT_ID,
      label: "spray_creds",
      group: "path",
      title: note,
      sub: `rev=${meta.rev}`,
      summary: { conclusion: note, basis: dictMapLine(meta), uncertainty: null },
      steps: [], evidenceRefs: ["system:spray-dict"],
      source: "system",
      coverage: "",
      probe: "spray_creds.txt",
    });
    edges.push({ from: String(recon.id), to: SPRAY_DICT_ID, label: "" });
  }
  const out: GView = { ...view, nodes, edges };
  return out;
}
