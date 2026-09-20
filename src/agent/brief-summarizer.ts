import { loadPrompt } from "../shared/resources.js";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join, relative } from "node:path";
import { EventSink } from "../shared/events.js";
import { applyCoachLlmEnv, seedCoachAgentDir } from "../shared/pi-workspace.js";
import { confirmedMd, generatedBriefMd, injectTxt, mapMd, readText, trafficDir } from "../shared/paths.js";
import { sprayEnabled } from "../observer/spray.js";
import { SPRAY_ANGLE_RE } from "../observer/spray-stamp.js";
import { PiBackend } from "./backends/pi.js";
import { jobUniqueCode, loadGeneratedBody, saveGeneratedBrief } from "./observe.js";

const MAX_TURNS = 12;
const MIN_CHARS = 80;
const FLAG_RE = /flag\{([^{}]+)\}/gi;
const SECTION_HEAD = /^(LOCK|ANGLES|FACTS|CONFIRMED|HYPOTHESIS)\s*:/i;
const SECTION_ALIAS: Record<string, string> = { FACTS: "CONFIRMED" };
const SUMMARIZER_TOOLS = ["read", "write", "edit", "grep", "find", "ls"] as const;

export function summarizerEnabled(): boolean {
  const raw = (process.env.HEIMDALL_BRIEF_SUMMARIZER || "").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(raw)) return false;
  if ((process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.PYTEST_CURRENT_TEST) && !["1", "true", "yes", "on"].includes(raw)) {
    return false;
  }
  return true;
}

export function loadSummarizerSystem(): string {
  try {
    return loadPrompt("summarizer");
  } catch {
    return "You are the first-attempt summarizer. No bash. Write .heimdall/traffic/generated_brief.md with LOCK / CONFIRMED / ANGLES.\n";
  }
}

function hasRawFlag(text: string): boolean {
  FLAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FLAG_RE.exec(text || ""))) {
    const inner = m[1] || "";
    if (inner.includes("…") || inner.includes("...")) continue;
    if (inner.length >= 8 && /^[A-Za-z0-9._\-]+$/.test(inner)) return true;
  }
  return false;
}

export function validateGeneratedBrief(body: string, opts?: { workspace?: string | null }): string {
  const text = (body || "").trim();
  if (text.length < MIN_CHARS) return "too short; write LOCK, CONFIRMED, ANGLES, and a short evidence paragraph";
  if (hasRawFlag(text)) return "contains a raw flag value; use a fingerprint only";
  const low = text.toLowerCase();
  if (/^dead\s*:/m.test(low) || /\ndead\s*:/.test(low)) return "DEAD is not allowed; record misses under CONFIRMED";
  if (low.includes("summarizer 不可用") || low.includes("指导员 summarizer")) {
    return "fallback brief; summarizer must rewrite LOCK / CONFIRMED / ANGLES";
  }
  if (!low.includes("lock")) return "missing LOCK heading";
  if (!low.includes("confirmed") && !low.includes("angle")) return "missing CONFIRMED or ANGLES";
  const ws = opts?.workspace;
  if (!ws || sprayEnabled(ws)) return "";
  const angles = extractSection(text, "ANGLES");
  if (angles[0] && SPRAY_ANGLE_RE.test(angles[0])) {
    return "web brief must not lead ANGLES with spray_*.txt / DICT";
  }
  return "";
}

export function buildSummarizerPrompt(workspace: string, repair = ""): string {
  const code = jobUniqueCode(workspace) || "(unknown)";
  const dest = generatedBriefMd(workspace);
  let rel = dest;
  try {
    rel = relative(workspace, dest) || dest;
  } catch {
    rel = dest;
  }
  const lines = [
    `You are the first-attempt summarizer. This job is ${code}. Ignore other unique_codes.`,
    "Read input.json first, then .heimdall/traffic/CONFIRMED.md, map.md, inject.txt (if present).",
    "Then read .heimdall/traffic/turns.md (the full first attempt). Then job_flags.md, hint.txt, .heimdall/handoff.json (if present).",
    "Do not dump http.jsonl / events.jsonl / turns.jsonl. Do not attack.",
    `Write only \`${rel}\`: LOCK / CONFIRMED / ANGLES, plus a short evidence note. Do not write DEAD.`,
    "Do not wrap in <heimdall-brief>. No curl recipes. No raw flag{...} values.",
    "If this job is not intranet: do not put spray_*.txt, DICT, or password spray as ANGLES #1.",
  ];
  if (repair) {
    lines.push("The last write failed host checks; fix this file:", repair);
  }
  return lines.join("\n") + "\n";
}

function extractSection(text: string, name: string): string[] {
  const want = (SECTION_ALIAS[name.toUpperCase()] || name).toUpperCase();
  let capturing = false;
  const out: string[] = [];
  for (const line of (text || "").split(/\r?\n/)) {
    const raw = line.trim();
    if (raw.startsWith("</")) {
      if (capturing) break;
      continue;
    }
    const match = raw.match(SECTION_HEAD);
    if (match) {
      const got = SECTION_ALIAS[match[1]!.toUpperCase()] || match[1]!.toUpperCase();
      capturing = got === want;
      if (capturing) {
        const rest = raw.split(":", 2)[1]?.trim() || "";
        if (rest && !["(none)", "none"].includes(rest.toLowerCase())) out.push(rest.replace(/^-\s*/, "").trim());
      }
      continue;
    }
    if (capturing && raw) out.push(raw.replace(/^-\s*/, "").trim());
  }
  return out.filter(Boolean);
}

function bullets(items: string[]): string {
  return items.map((x) => `- ${x}`).join("\n");
}

function stripDeadBlocks(text: string): string {
  const out: string[] = [];
  let skip = false;
  for (const line of (text || "").split(/\r?\n/)) {
    const raw = line.trim();
    if (/^DEAD\s*:/i.test(raw)) {
      skip = true;
      continue;
    }
    if (skip && (SECTION_HEAD.test(raw) || raw.startsWith("</"))) skip = false;
    if (!skip) out.push(line);
  }
  return out.join("\n");
}

async function withProcessEnv<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  const keys = new Set([...Object.keys(env), ...Object.keys(process.env)]);
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) saved[key] = process.env[key];
  try {
    for (const key of keys) {
      const val = env[key];
      if (val === undefined) delete process.env[key];
      else process.env[key] = String(val);
    }
    return await fn();
  } finally {
    for (const key of keys) {
      const val = saved[key];
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }
}

export function writeFallbackBrief(workspace: string, uniqueCode = ""): string | null {
  const code = uniqueCode || jobUniqueCode(workspace);
  const existing = loadGeneratedBody(workspace, code);
  if (existing && !validateGeneratedBrief(existing)) return generatedBriefMd(workspace);
  const inject = readText(injectTxt(workspace));
  const facts = readText(confirmedMd(workspace));
  const mapmd = readText(mapMd(workspace));
  const blob = inject || facts || mapmd;
  let lockItems = extractSection(blob, "LOCK").length ? extractSection(blob, "LOCK") : extractSection(facts, "LOCK");
  if (!lockItems.length) lockItems = extractSection(blob, "HYPOTHESIS").length ? extractSection(blob, "HYPOTHESIS") : extractSection(facts, "HYPOTHESIS");
  if (!lockItems.length) return null;
  const confirmedItems = extractSection(blob, "CONFIRMED").length
    ? extractSection(blob, "CONFIRMED")
    : extractSection(facts, "CONFIRMED");
  const angleItems = extractSection(blob, "ANGLES").length ? extractSection(blob, "ANGLES") : extractSection(facts, "ANGLES");
  const evidence = stripDeadBlocks((facts || mapmd || inject).trim()).slice(0, 700);
  const body =
    `LOCK: ${lockItems[0]}\n` +
    `CONFIRMED:\n${confirmedItems.length ? bullets(confirmedItems) : "- (none recorded)"}\n` +
    `ANGLES:\n${angleItems.length ? bullets(angleItems) : "- continue from the prior coverage map"}\n` +
    `${evidence}\n`;
  if (validateGeneratedBrief(body, { workspace })) return null;
  return saveGeneratedBrief(workspace, body, code);
}

function seedSummarizerDir(workspace: string): string {
  return seedCoachAgentDir(join(workspace, ".heimdall", "brief-summarizer"));
}

function coachEnv(environ?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(environ || {}) };
  return applyCoachLlmEnv(env);
}

export async function runBriefSummarizer(
  workspace: string,
  uniqueCode = "",
  environ?: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (!summarizerEnabled()) return null;
  const env = coachEnv(environ);
  return withProcessEnv(env, async () => {
    const code = uniqueCode || jobUniqueCode(workspace);
    const existing = loadGeneratedBody(workspace, code);
    if (existing && !validateGeneratedBrief(existing)) return generatedBriefMd(workspace);
    const agentDir = seedSummarizerDir(workspace);
    const events = new EventSink(join(agentDir, "events.jsonl"), join(agentDir, "summarizer.log"));
    const backend = new PiBackend({
      tools: [...SUMMARIZER_TOOLS],
      noContextFiles: true,
      skipWorkspaceSeed: true,
      persistSession: false,
      agentDir: () => agentDir,
    });
    try {
      const model = process.env.HEIMDALL_COACH_MODEL || process.env.ANTHROPIC_MODEL || null;
      await backend.run({
        systemPrompt: loadSummarizerSystem(),
        userPrompt: buildSummarizerPrompt(workspace),
        workspace,
        permissionMode: "bypassPermissions",
        maxTurns: MAX_TURNS,
        model,
        events,
      });
      let body = loadGeneratedBody(workspace, code);
      let err = validateGeneratedBrief(body, { workspace });
      if (err) {
        await backend.run({
          systemPrompt: loadSummarizerSystem(),
          userPrompt: buildSummarizerPrompt(workspace, err),
          workspace,
          permissionMode: "bypassPermissions",
          maxTurns: MAX_TURNS,
          model,
          events,
        });
        body = loadGeneratedBody(workspace, code);
        err = validateGeneratedBrief(body, { workspace });
      }
      if (err) {
        const src = generatedBriefMd(workspace);
        if (existsSync(src)) {
          try {
            renameSync(src, join(trafficDir(workspace), "generated_brief.invalid.md"));
          } catch {
            /* ignore */
          }
        }
        events.writeText(`[summarizer] invalid: ${err}`);
        return null;
      }
      return saveGeneratedBrief(workspace, body, code);
    } catch (e) {
      events.writeText(`[summarizer] error: ${e}`);
      return null;
    } finally {
      await backend.close();
      events.close();
    }
  });
}

export async function ensureGeneratedBrief(
  workspace: string,
  uniqueCode = "",
  environ?: NodeJS.ProcessEnv,
): Promise<string | null> {
  const path = await runBriefSummarizer(workspace, uniqueCode, environ);
  if (path) return path;
  try {
    return writeFallbackBrief(workspace, uniqueCode);
  } catch {
    return null;
  }
}

