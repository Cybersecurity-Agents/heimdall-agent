import { evidenceErrors } from "./evidence.js";
import { type NodeSummary } from "../shared/observer-contract.js";
import { existsSync, readFileSync } from "node:fs";
import { atomicWrite } from "../shared/fsutil.js";
import {
  injectTxt,
  observeDagJson,
  validateErrPath,
  workspaceDir,
} from "../shared/paths.js";
import { parseObserverDag, type ObserverDag } from "./schema.js";
import { sprayEnabled } from "./spray.js";
import { jobHintText } from "../shared/paths.js";

export const KINDS = new Set(["start", "recon", "direction", "endpoint", "path", "scan", "flag"]);
export const COVERAGE = new Set(["tried-hit", "tried-miss", "inferred-open", "untested", "scan-class"]);
export const OPEN_COVERAGE = new Set(["inferred-open", "untested"]);
export const MAX_NODES = 32;
export const MAX_EDGES = 48;
export const INTRANET_MAX_NODES = 32;
export const INTRANET_MAX_EDGES = 48;
export const TERMINAL_MAX_NODES = 48;
export const TERMINAL_MAX_EDGES = 72;

export function processDagLimits(intranet: boolean): { nodes: number; edges: number } {
  return intranet ? { nodes: INTRANET_MAX_NODES, edges: INTRANET_MAX_EDGES } : { nodes: MAX_NODES, edges: MAX_EDGES };
}


const FLAG_RE = /flag\{/i;
const IMPERATIVE_RE =
  /(下一步去|下一步试|去试\s|去打\s|去 curl|curl 这个|do this|try this|hit\s+https?:\/\/|请立刻|马上利用)/i;
const LOCK_HEAD = /^LOCK\s*:/i;
const SECTION = /^[A-Z][A-Z0-9 _-]{1,20}:\s*$/;
const PLACEHOLDER_LOCK =
  /<one main direction>|<possible direction>|<evidence>|\(none\)|\.\.\.\s*\|\s*evidence|…\s*\|\s*evidence/i;
const ANGLES_HEAD = /^ANGLES\s*:/i;
const FORBID_HEAD = /^FORBID\s*:/i;
const INLINE_SECTION = /^[A-Z][A-Z0-9 _-]{1,20}:/;

const BRUTE_RE =
  /brute|wordlist|spray|hydra|hashcat|rockyou|dirbust|gobuster|ffuf|password.?spray|weak.?pass|secret.?brute|(?:jwt[-_ ]?secret|secret_key).{0,24}(?:brute|wordlist|spray|字典)|(?:brute|wordlist|spray|字典).{0,24}(?:jwt[-_ ]?secret|secret_key)|爆破|字典|弱口令|穷举|wordlists\//i;
const TARGETED_WL_RE =
  /sqli(?:_login)?\.txt|lfi\.txt|(?:sqli|sql\s*inject|注入).{0,20}(?:字典|wordlist)|(?:字典|wordlist).{0,20}(?:sqli|sql\s*inject|注入|lfi)/i;
const TARGETED_SPRAY_RE =
  /targeted\s+spray|collected\s+pattern|口令规则|针对性(?:喷洒|爆破)|自构口令|定向喷洒|spray_(?:users|passwords|creds)\.txt|loot\.json|已成功登录|已登录.{0,16}(?:口令|密码|喷)|同一口令/i;
const GENERIC_BRUTE_RE = /rockyou|jwt|dirbust|secret.?brute|gobuster|ffuf|SECRET_KEY/i;
const SPRAY_FORBID_RE = /喷|spray|不许喷|停喷|弱口令|password.?spray|hydra/i;

export class ValidateResult {
  errors: string[] = [];
  dag: ObserverDag | null = null;
  get ok(): boolean {
    return this.errors.length === 0;
  }
  fail(msg: string): void {
    this.errors.push(msg);
  }
  asText(): string {
    if (this.ok) return "ok\n";
    return this.errors.map((e) => `- ${e}`).join("\n") + "\n";
  }
}

type Dag = Record<string, unknown>;

export function validateWorkspace(workspace?: string | null): ValidateResult {
  const ws = workspaceDir(workspace);
  let out: ValidateResult;
  try {
    out = validateDagDoc(JSON.parse(readFileSync(observeDagJson(ws), "utf8")), processDagLimits(sprayEnabled(ws)));
  } catch (exc) {
    out = new ValidateResult();
    out.fail(`observe_dag.json unreadable: ${exc}`);
  }
  const dag = out.dag;
  if (dag) for (const error of evidenceErrors(ws, dag.nodes)) out.fail(error);
  const injectPath = injectTxt(ws);
  let inject = "";
  if (existsSync(injectPath)) {
    try {
      inject = readFileSync(injectPath, "utf8");
    } catch (exc) {
      out.fail(`inject.txt unreadable: ${exc}`);
    }
  } else {
    out.fail("inject.txt missing");
  }
  if (existsSync(injectPath)) {
    checkInject(inject, out);
    const hint = jobHintText(ws);
    if (hint) checkLockFollowsHint(inject, hint, out);
    if (dag) checkOpenFacesInAngles(dag, inject, out);
  }
  return out;
}

export function validateDagDoc(doc: unknown, limits: { nodes: number; edges: number; requireOpen?: boolean } = { nodes: MAX_NODES, edges: MAX_EDGES }): ValidateResult {
  const out = new ValidateResult();
  try {
    out.dag = parseObserverDag(doc);
    checkDag(out.dag, out, limits);
  } catch (exc) {
    out.fail(exc instanceof Error ? exc.message : String(exc));
  }
  return out;
}

function checkDag(doc: Dag, out: ValidateResult, limits: { nodes: number; edges: number; requireOpen?: boolean }): void {
  const nodes = doc.nodes;
  const edges = doc.edges;
  if (!Array.isArray(nodes) || !nodes.length) {
    out.fail("dag.nodes must be a non-empty list");
    return;
  }
  if (!Array.isArray(edges)) {
    out.fail("dag.edges must be a list");
    return;
  }
  if (nodes.length > limits.nodes) out.fail(`dag has ${nodes.length} nodes (max ${limits.nodes})`);
  if (edges.length > limits.edges) out.fail(`dag has ${edges.length} edges (max ${limits.edges})`);
  const ids: string[] = [];
  const kinds: Record<string, string> = Object.create(null);
  for (const item of nodes) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      out.fail("dag node is not an object");
      continue;
    }
    const rec = item as Record<string, unknown>;
    const nid = String(rec.id || "").trim();
    const kind = String(rec.kind || rec.group || "")
      .trim()
      .toLowerCase();
    const blob = JSON.stringify(rec);
    if (FLAG_RE.test(blob)) out.fail(`node ${nid || "?"} contains flag{`);
    if (!nid) {
      out.fail("dag node missing id");
      continue;
    }
    if (nid in kinds) {
      out.fail(`duplicate node id ${nid}`);
      continue;
    }
    if (!KINDS.has(kind)) {
      out.fail(`node ${nid} kind ${JSON.stringify(kind)} not allowed`);
      continue;
    }
    if (kind === "next") {
      out.fail(`node ${nid} kind=next is forbidden`);
      continue;
    }
    ids.push(nid);
    kinds[nid] = kind;
    const note = String((rec.summary as NodeSummary | undefined)?.conclusion || rec.title || "");
    if (IMPERATIVE_RE.test(note)) out.fail(`node ${nid} note looks like a next-step command`);
    if (kind === "direction" || kind === "scan") {
      const cov = String(rec.coverage || "")
        .trim()
        .toLowerCase();
      if (!COVERAGE.has(cov)) out.fail(`node ${nid} (${kind}) missing coverage`);
    }
  }
  const idset = new Set(ids);
  const seenE = new Set<string>();
  const scanEdges = new Map<string, number>();
  for (const item of edges) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      out.fail("dag edge is not an object");
      continue;
    }
    const rec = item as Record<string, unknown>;
    const src = String(rec.from || rec.src || "");
    const dst = String(rec.to || rec.dst || "");
    if (!idset.has(src) || !idset.has(dst)) {
      out.fail(`edge ${src}->${dst} references unknown node`);
      continue;
    }
    if (src === dst) {
      out.fail(`self-edge on ${src}`);
      continue;
    }
    const key = `${src}\0${dst}`;
    if (seenE.has(key)) continue;
    seenE.add(key);
    const fk = kinds[src];
    const tk = kinds[dst];
    if (fk === "start" && tk !== "recon") out.fail(`start may only connect to recon (${src}->${dst})`);
    if (fk === "flag") out.fail(`flag node must be a sink (${src}->${dst})`);
    if (tk === "scan") scanEdges.set(dst, (scanEdges.get(dst) || 0) + 1);
  }
  for (const [id, count] of scanEdges) if (count > 1) out.fail(`at most one edge to a scan node (${id} has ${count})`);
  if (hasCycle(idset, [...seenE].map((k) => k.split("\0") as [string, string]))) out.fail("dag has a cycle");
  const hasFlag = Object.values(kinds).some((k) => k === "flag");
  const hasOpen = nodes.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const rec = item as Record<string, unknown>;
    const kind = String(rec.kind || rec.group || "")
      .trim()
      .toLowerCase();
    const cov = String(rec.coverage || "")
      .trim()
      .toLowerCase();
    return kind === "direction" && OPEN_COVERAGE.has(cov);
  });
  if (limits.requireOpen !== false && !hasFlag && !hasOpen && Object.values(kinds).some((k) => k === "direction")) {
    out.fail("dag has no inferred-open direction (untried breakthrough faces)");
  }
}

function hasCycle(ids: Set<string>, edges: [string, string][]): boolean {
  const succ: Record<string, string[]> = Object.create(null);
  for (const i of ids) succ[i] = [];
  for (const [src, dst] of edges) (succ[src] ??= []).push(dst);
  const state = new Map<string, number>();
  const visit = (nid: string): boolean => {
    const st = state.get(nid) || 0;
    if (st === 1) return true;
    if (st === 2) return false;
    state.set(nid, 1);
    for (const nxt of succ[nid] || []) {
      if (visit(nxt)) return true;
    }
    state.set(nid, 2);
    return false;
  };
  for (const i of ids) {
    if (visit(i)) return true;
  }
  return false;
}

function checkInject(text: string, out: ValidateResult): void {
  if (!text.includes("<heimdall-map>") || !text.includes("</heimdall-map>")) {
    out.fail("inject.txt must wrap <heimdall-map>");
  }
  if (FLAG_RE.test(text)) out.fail("inject.txt contains flag{");
  if (IMPERATIVE_RE.test(text)) out.fail("inject.txt has an imperative next-step command");
  const lockLines = lockBullets(text);
  if (lockLines.length > 4) {
    out.fail(`LOCK has ${lockLines.length} bullets (max 4 evidence lines, one direction)`);
  } else if (lockLines.length && lockLines.every((b) => PLACEHOLDER_LOCK.test(b))) {
    out.fail("LOCK is a placeholder, not a direction");
  }
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
      if (SECTION.test(line) || (line.endsWith(":") && line.slice(0, -1) === line.slice(0, -1).toUpperCase() && line.slice(0, -1).length > 0)) {
        break;
      }
      if (line.startsWith("- ")) bullets.push(line.slice(2).trim());
      else if (line && !line.startsWith("#") && !bullets.length) bullets.push(line);
    }
  }
  return bullets.filter(Boolean);
}

export function bruteLaterScore(text: string): number {
  if (!text) return 0;
  if (TARGETED_SPRAY_RE.test(text) && !GENERIC_BRUTE_RE.test(text)) return 0;
  if (TARGETED_WL_RE.test(text) && !/jwt|password.?spray|dirbust|弱口令|secret.?brute|gobuster|ffuf/i.test(text)) {
    return 0;
  }
  return BRUTE_RE.test(text) ? 2 : 0;
}

export function anglesBullets(text: string): string[] {
  return sectionBullets(text, ANGLES_HEAD);
}

export function forbidItems(text: string): string[] {
  const out: string[] = [];
  for (const raw of sectionBullets(text, FORBID_HEAD)) {
    for (const part of raw.split(/[,;，；]+/)) {
      const item = part.trim();
      if (item && !["(none)", "none", "-"].includes(item.toLowerCase()) && !SPRAY_FORBID_RE.test(item)) {
        out.push(item);
      }
    }
  }
  return out;
}

export function stripSprayForbid(text: string): string {
  const raw = String(text || "");
  const kept = forbidItems(raw);
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (FORBID_HEAD.test(lines[i]!.trim())) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return raw;
  let end = lines.length;
  for (let j = idx + 1; j < lines.length; j++) {
    const line = lines[j]!.trim();
    if (SECTION.test(line) || (line.startsWith("</") && line.endsWith(">"))) {
      end = j;
      break;
    }
  }
  const prefix = lines.slice(0, idx);
  const suffix = lines.slice(end);
  const forbidLine = kept.length ? `FORBID: ${kept.join("; ")}` : "FORBID: dirbust";
  return prefix.concat(forbidLine, suffix).join("\n").replace(/\s+$/, "") + "\n";
}

export function reorderInjectAngles(text: string): string {
  const raw = String(text || "");
  const bullets = anglesBullets(raw);
  if (bullets.length < 2) return raw;
  const ranked = bullets
    .map((b, i) => ({ i, b, s: bruteLaterScore(b) }))
    .sort((a, b) => a.s - b.s || a.i - b.i);
  const newBullets = ranked.map((x) => x.b);
  if (newBullets.join("\0") === bullets.join("\0")) return raw;
  return replaceSectionBullets(raw, ANGLES_HEAD, newBullets);
}

function isOtherSection(line: string, head: RegExp): boolean {
  const stripped = line.trim();
  if (!stripped || stripped.startsWith("-") || head.test(stripped)) return false;
  if (SECTION.test(stripped) || stripped.startsWith("</")) return true;
  return INLINE_SECTION.test(stripped);
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
  return (prefix.concat(body, suffix).join("\n").replace(/\s+$/, "") + "\n");
}

function familyTokens(text: string): Set<string> {
  const out = new Set<string>();
  const re = /[A-Za-z][A-Za-z0-9]{2,}|[\u4e00-\u9fff]{2,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || ""))) out.add(m[0]!.toLowerCase());
  return out;
}

function labelsMatchAngles(label: string, angleBlob: string, angleToks: Set<string>): boolean {
  const toks = familyTokens(label);
  for (const t of toks) {
    if (angleToks.has(t)) return true;
  }
  const needle = String(label || "")
    .trim()
    .toLowerCase();
  return Boolean(needle && angleBlob.toLowerCase().includes(needle));
}

function checkOpenFacesInAngles(dag: Dag, inject: string, out: ValidateResult): void {
  const opens: string[] = [];
  for (const item of (dag.nodes as unknown[]) || []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const kind = String(rec.kind || rec.group || "")
      .trim()
      .toLowerCase();
    const cov = String(rec.coverage || "")
      .trim()
      .toLowerCase();
    if (kind !== "direction" || !OPEN_COVERAGE.has(cov)) continue;
    const nid = String(rec.id || "").trim() || "?";
    opens.push(String(rec.label || (rec.summary as NodeSummary | undefined)?.conclusion || nid));
  }
  if (!opens.length) return;
  const angles = anglesBullets(inject);
  if (!angles.length) {
    out.fail("inferred-open directions must appear in ANGLES (steer the main agent)");
    return;
  }
  const angleBlob = angles.join(" ");
  const angleToks = familyTokens(angleBlob);
  if (opens.some((label) => labelsMatchAngles(label, angleBlob, angleToks))) return;
  out.fail("ANGLES does not name any inferred-open family");
}

function lockBullets(text: string): string[] {
  return sectionBullets(text, LOCK_HEAD);
}

function hintParts(hint: string): string[] {
  const parts = hint.split(/[\s,，。；、.!?:：；\n]+/);
  const out: string[] = [];
  for (let p of parts) {
    p = p.trim();
    if (p.length >= 2) out.push(p.toLowerCase());
  }
  return out;
}

function checkLockFollowsHint(inject: string, hint: string, out: ValidateResult): void {
  const lockLines = lockBullets(inject);
  const lockBlob = lockLines.join(" ").toLowerCase();
  if (!lockBlob || lockBlob === "(none)" || lockBlob === "none") {
    out.fail("hint.txt is present but LOCK is empty");
    return;
  }
  const parts = hintParts(hint);
  if (!parts.length) return;
  if (parts.some((p) => lockBlob.includes(p))) return;
  const hans = hint.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const chunk of hans) {
    for (let i = 0; i < chunk.length - 1; i++) {
      if (lockBlob.includes(chunk.slice(i, i + 2))) return;
    }
  }
  out.fail("hint.txt is present but LOCK does not mention the hint family");
}

export function writeValidateErr(workspace: string | null | undefined, result: ValidateResult): string {
  const path = validateErrPath(workspace);
  atomicWrite(path, result.asText());
  return path;
}
