import { type NodeSummary } from "../shared/observer-contract.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { atomicWrite } from "../shared/fsutil.js";
import { injectTxt, observeDagJson, steerJson } from "../shared/paths.js";
import { OPEN_COVERAGE, anglesBullets, bruteLaterScore, forbidItems } from "./validate.js";
import { parseObserverDag, type ObserverDag } from "./schema.js";

export const LIGHT_PATHS = 200;
export const LIGHT_PORTS = 24;
export const RANGE_BLOCK = 80;
export const LIGHT_TOOLS = new Set(["dirsearch"]);
export const FORBID_TOOLS = new Set([
  "ffuf",
  "gobuster",
  "feroxbuster",
  "dirb",
  "dirbuster",
  "wfuzz",
  "nuclei",
  "nikto",
]);
export const LATER_TOOLS = new Set([
  "hashcat",
  "john",
  "hydra",
  "medusa",
  "patator",
  "jwt_tool",
  "jwt-cracker",
]);

const WORDLIST_RE =
  /rockyou|sqlmap\/.*\/wordlist|wordlists\/|\/opt\/heimdall\/tools\/wordlists|top-20k|1\.6m|flask-unsign|jwt-cracker|hashcat|hydra|john\b|secret.?brute|password.?spray/i;
const WL_INSPECT_RE = /\b(?:ls|cat|head|tail|wc|file|less|more|nl|find)\b/i;
const WL_CAMPAIGN_RE = /\b(?:for|while|ffuf|gobuster|hydra|hashcat|sqlmap|feroxbuster|dirb|wfuzz)\b/i;
const TARGETED_WL_RE = /wordlists\/(?:sqli(?:_login)?|lfi)\.txt|spray_(?:users|passwords|creds)\.txt|loot\.json/i;
const BRUTE_WL_RE = /wordlists\/(?:jwt|passwords|usernames|creds)\.txt/i;
const HEAVY_SCAN_RE = /rockyou|seclists|dicc\.txt|top-20k|1\.6m|\b9k\b/i;
const DIRSEARCH_W_RE = /(?:-w|--wordlist)\s+(\S+)/i;
const SEQ_RE = /seq\s+(\d+)\s+(\d+)/gi;
const PY_RANGE_RE = /range\(\s*(\d+)\s*,\s*(\d+)/gi;
const PATH_TOKEN_RE = /(?:^|[\s'"=])(\/[A-Za-z0-9._~/-]{1,80})/g;
const SKILL_READ_RE = /\/opt\/heimdall|grep\s|find\s|SECRET_KEY|secret_key|app\.py|CLAUDE\.md/i;

export function allowFuzz(): boolean {
  return (process.env.HEIMDALL_ALLOW_FUZZ || "").trim() === "1";
}

export function loadSteer(workspace?: string | null): Record<string, unknown> {
  try {
    const raw = readFileSync(steerJson(workspace), "utf8");
    const doc = JSON.parse(raw) as unknown;
    return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function buildSteer(workspace?: string | null, dag?: ObserverDag): Record<string, unknown> {
  let inject = "";
  const inj = injectTxt(workspace);
  if (existsSync(inj)) {
    try {
      inject = readFileSync(inj, "utf8");
    } catch {
      inject = "";
    }
  }
  const angles = anglesBullets(inject);
  const now = angles.filter((a) => bruteLaterScore(a) === 0);
  const later = angles.filter((a) => bruteLaterScore(a) > 0);
  const forbid = forbidItems(inject);
  const openSkill = openSkillFaces(workspace, dag);
  return {
    now,
    later,
    forbid: forbid.length ? forbid : ["portscan"],
    open_skill: openSkill,
    later_open: !openSkill.length,
  };
}

export function writeSteer(workspace?: string | null, dag?: ObserverDag): Record<string, unknown> {
  const doc = buildSteer(workspace, dag);
  atomicWrite(steerJson(workspace), JSON.stringify(doc, null, 2) + "\n");
  return doc;
}

function openSkillFaces(workspace?: string | null, document?: ObserverDag): string[] {
  const dag = observeDagJson(workspace);
  if (!document && !existsSync(dag)) return [];
  try {
    const raw = document || parseObserverDag(JSON.parse(readFileSync(dag, "utf8")));
    const out: string[] = [];
    for (const item of raw.nodes) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const kind = String(rec.kind || rec.group || "")
        .trim()
        .toLowerCase();
      const cov = String(rec.coverage || "")
        .trim()
        .toLowerCase();
      if (kind !== "direction" || !OPEN_COVERAGE.has(cov)) continue;
      const label = String(rec.label || (rec.summary as NodeSummary | undefined)?.conclusion || rec.id || "");
      const blob = `${label} ${(rec.summary as NodeSummary | undefined)?.conclusion || ""}`;
      if (bruteLaterScore(blob) > 0) continue;
      if (label.trim()) out.push(label.trim());
    }
    return out;
  } catch {
    return [];
  }
}

export function classifyCommand(text: string): string | null {
  const cmd = String(text || "");
  if (!cmd.trim()) return null;
  if (isWideRange(cmd)) return "forbid";
  if (/\bdirsearch\b/i.test(cmd) && !isLightPathsScan(cmd)) return "forbid";
  if (HEAVY_SCAN_RE.test(cmd) && /\b(?:dirsearch|ffuf|gobuster|feroxbuster|dirb|wfuzz)\b/i.test(cmd)) {
    return "forbid";
  }
  const pathsN = [...cmd.matchAll(PATH_TOKEN_RE)].length;
  if (pathsN > LIGHT_PATHS && /\bfor\b|\bwhile\b/.test(cmd)) return "forbid";
  if (isLightPathsScan(cmd)) return null;
  if (isWordlistCampaign(cmd)) return "later";
  return null;
}

function isWideRange(cmd: string): boolean {
  SEQ_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SEQ_RE.exec(cmd))) {
    if (Number(m[2]) - Number(m[1]) >= RANGE_BLOCK) return true;
  }
  PY_RANGE_RE.lastIndex = 0;
  while ((m = PY_RANGE_RE.exec(cmd))) {
    if (Number(m[2]) - Number(m[1]) >= RANGE_BLOCK) return true;
  }
  return /1-10000|1-65535|1\s*\.\.\s*10000/.test(cmd);
}

function isWordlistInspect(cmd: string): boolean {
  if (WL_CAMPAIGN_RE.test(cmd)) return false;
  if (/rockyou|sqlmap\/.*\/wordlist|top-20k|1\.6m/i.test(cmd)) return false;
  if (!/\/opt\/heimdall\/tools\/wordlists|wordlists\//i.test(cmd)) return false;
  return WL_INSPECT_RE.test(cmd);
}

function isLightPathsScan(cmd: string): boolean {
  if (/\bdirsearch\b/i.test(cmd)) {
    if (HEAVY_SCAN_RE.test(cmd)) return false;
    const m = DIRSEARCH_W_RE.exec(cmd);
    if (m && !m[1]!.replace(/\\/g, "/").includes("wordlists/paths.txt")) return false;
    return true;
  }
  if (!/wordlists\/paths\.txt/i.test(cmd)) return false;
  if (HEAVY_SCAN_RE.test(cmd)) return false;
  if (/\b(?:ffuf|gobuster|feroxbuster|dirb|wfuzz)\b/i.test(cmd)) return false;
  return true;
}

function isWordlistCampaign(cmd: string): boolean {
  if (SKILL_READ_RE.test(cmd) && !WORDLIST_RE.test(cmd)) return false;
  if (!WORDLIST_RE.test(cmd)) return false;
  if (isWordlistInspect(cmd)) return false;
  if (isLightPathsScan(cmd)) return false;
  if (TARGETED_WL_RE.test(cmd) && !BRUTE_WL_RE.test(cmd)) return false;
  if (/flask-unsign/i.test(cmd) && !/wordlist|crack|sqlmap|rockyou|top-20|1\.6/i.test(cmd)) {
    const secrets = cmd.match(/['"][^'"]{0,80}['"]/g) || [];
    if (secrets.length <= LIGHT_PORTS) return false;
  }
  return true;
}

export function bashBlockReason(
  workspace: string | null | undefined,
  argv: string[] | null = null,
  opts: { script?: string } = {},
): string | null {
  if (allowFuzz()) return null;
  const body = opts.script || scriptFromArgv(argv || []);
  const kind = classifyCommand(body);
  if (kind == null) {
    if (dirbustAlreadyForbidden(workspace) && isRepeatDirscan(body)) {
      return blockReason(workspace, "forbid", { tool: "dirsearch" });
    }
    return null;
  }
  return blockReason(workspace, kind);
}

function isRepeatDirscan(cmd: string): boolean {
  if (isLightPathsScan(cmd)) return true;
  if (!/\bfor\b|\bwhile\b/.test(cmd)) return false;
  return [...cmd.matchAll(PATH_TOKEN_RE)].length > 48;
}

function dirbustAlreadyForbidden(workspace?: string | null): boolean {
  const steer = loadSteer(workspace);
  for (const item of (steer.forbid as unknown[]) || []) {
    if (String(item).toLowerCase().includes("dirbust")) return true;
  }
  return false;
}

export function toolBlockReason(workspace: string | null | undefined, tool: string): string | null {
  if (allowFuzz()) return null;
  const name = (tool || "").trim() || "scanner";
  if (LIGHT_TOOLS.has(name)) {
    if (dirbustAlreadyForbidden(workspace)) return blockReason(workspace, "forbid", { tool: name });
    return null;
  }
  if (FORBID_TOOLS.has(name)) return blockReason(workspace, "forbid", { tool: name });
  if (LATER_TOOLS.has(name)) return blockReason(workspace, "later", { tool: name });
  return null;
}

export function blockReason(
  workspace: string | null | undefined,
  kind: string,
  opts: { tool?: string } = {},
): string | null {
  const steer = loadSteer(workspace);
  let now = ((steer.now as unknown[]) || []).map((x) => String(x)).filter((x) => x.trim());
  if (!now.length) now = ((steer.open_skill as unknown[]) || []).map((x) => String(x)).filter((x) => x.trim());
  const laterOpen = Boolean(steer.later_open);
  if (kind === "later" && laterOpen) return null;
  if (kind === "forbid") {
    const who = opts.tool || "dirbust / wide port-range";
    return pointAtNow(`${who} blocked — keep it off the board.`, now);
  }
  const who = opts.tool || "wordlist / secret-brute";
  return pointAtNow(`${who} blocked until the other faces are tried.`, now);
}

function pointAtNow(head: string, now: string[]): string {
  const lines = [
    head,
    "Read `.heimdall/traffic/inject.txt` ANGLES and try those first.",
    "One dirsearch pass (paths.txt) is light recon; do not repeat it.",
  ];
  if (now.length) {
    lines.push("Still open:");
    for (const item of now.slice(0, 4)) lines.push(`- ${item}`);
  } else {
    lines.push("No observer map yet — follow the surface, do not start a wordlist or 1-10000 scan.");
  }
  return lines.slice(0, 2).join(" ") + "\n" + lines.slice(2).join("\n");
}

function scriptFromArgv(argv: string[]): string {
  const chunks: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const a = String(argv[i]);
    if (a === "-c" || a === "-lc" || (a.startsWith("-") && a.slice(1).includes("c") && !a.startsWith("--"))) {
      if (i + 1 < argv.length) {
        chunks.push(String(argv[i + 1]));
        i += 2;
        continue;
      }
    }
    if (i > 0 && !a.startsWith("-")) {
      try {
        if (existsSync(a) && statSync(a).isFile() && statSync(a).size < 200_000) {
          chunks.push(readFileSync(a, "utf8"));
        } else {
          chunks.push(a);
        }
      } catch {
        chunks.push(a);
      }
    }
    i += 1;
  }
  if (!chunks.length) return argv.map(String).join(" ");
  return chunks.join("\n");
}
