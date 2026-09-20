import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatObligation } from "./observe.js";
import { loadHandoff } from "../shared/handoff.js";
import { loadJson } from "../shared/completion.js";
import { confirmedMd, mapMd, readText } from "../shared/paths.js";

export const BRIEF_MAX_CHARS = 24000;

function flagFingerprint(flag: string): string {
  const s = (flag || "").trim();
  if (!s) return "";
  const low = s.toLowerCase();
  if (low.startsWith("flag{") && s.endsWith("}") && s.length > 12) {
    const inner = s.slice(5, -1);
    if (inner.length > 8) return `flag{${inner.slice(0, 4)}…${inner.slice(-4)}}`;
  }
  if (s.length > 16) return `${s.slice(0, 6)}…${s.slice(-4)}`;
  return s;
}

function summarizeEvent(rec: Record<string, unknown>): string | null {
  const kind = String(rec.kind || rec.message_type || "");
  const payload = rec.payload;
  if (["sdk_start", "agent_start", "sdk_done", "agent_done", "sdk_error"].includes(kind)) {
    let extra = "";
    if (payload && typeof payload === "object") {
      const p = payload as Record<string, unknown>;
      extra = String(p.error || p.subtype || p.backend_chosen || "");
    }
    return extra ? `${kind}: ${extra.slice(0, 160)}` : kind;
  }
  if (kind.includes("Tool") || kind === "message" || kind === "pi_turn_end") {
    return summarizeMessage(payload, rec.message_type);
  }
  return null;
}

function summarizeMessage(payload: unknown, messageType: unknown): string | null {
  const name = String(messageType || "");
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    const content = p.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        const tool = String(b.name || "");
        if (String(b.type || "").includes("tool") || String(b.type || "").includes("ToolUse") || tool) {
          return `tool ${tool || b.type}: ${toolSnippet(tool, b.input || b.tool_input || b.arguments)}`;
        }
        if (typeof b.text === "string" && b.text.trim() && name.toLowerCase().includes("assistant")) {
          return `assistant: ${b.text.trim().slice(0, 180)}`;
        }
      }
    }
    if (p.name) return `tool ${p.name}: ${toolSnippet(String(p.name), p.input)}`;
  }
  return null;
}

function toolSnippet(tool: string, inp: unknown): string {
  if (inp && typeof inp === "object") {
    const rec = inp as Record<string, unknown>;
    for (const key of ["command", "cmd", "url", "path", "file_path", "query", "pattern"]) {
      if (rec[key]) return `${key}=${String(rec[key]).slice(0, 160)}`;
    }
    try {
      return JSON.stringify(inp).slice(0, 160);
    } catch {
      return String(inp).slice(0, 160);
    }
  }
  return inp ? String(inp).slice(0, 160) : tool;
}

export function timelineIsInfraNoise(summary: string): boolean {
  const s = (summary || "").toLowerCase();
  return (
    s.includes("claude-agent-sdk not installed") ||
    s.includes("argument list too long") ||
    s.includes("err_module_not_found") ||
    s.includes("no conversation found") ||
    s.includes("conversation found with session") ||
    s.includes("unknown session") ||
    s.includes("session not found") ||
    s.includes("error_during_execution")
  );
}

function parentInfraFailed(parent: Record<string, unknown>): boolean {
  const blob = `${parent.error || ""} ${parent.terminal_reason || ""}`;
  return /claude-agent-sdk not installed|argument list too long|already_running|err_module_not_found/i.test(blob);
}

export function loopParentUsable(parent: Record<string, unknown> | null | undefined): boolean {
  if (!parent) return false;
  const kind = String(parent.job_kind || "regular").toLowerCase();
  if (kind === "loop") return false;
  if (parentInfraFailed(parent)) return false;
  return Boolean(String(parent.job_dir || "").trim());
}

/** Previous loop job can seed the next loop brief (not a regular Pi timeout). */
export function loopHandoffUsable(parent: Record<string, unknown> | null | undefined): boolean {
  if (!parent) return false;
  if (String(parent.job_kind || "").toLowerCase() !== "loop") return false;
  if (parentInfraFailed(parent)) return false;
  return Boolean(String(parent.job_dir || "").trim());
}

/** Latest finished loop job for this code, excluding the job that just started. */
export function latestFinishedLoopJob(
  jobs: Array<Record<string, unknown>>,
  opts: { excludeId?: string | null } = {},
): Record<string, unknown> | null {
  const exclude = String(opts.excludeId || "").trim();
  let best: Record<string, unknown> | null = null;
  let bestAt = -1;
  for (const job of jobs) {
    const id = String(job.id || "").trim();
    if (exclude && id === exclude) continue;
    if (String(job.job_kind || "").toLowerCase() !== "loop") continue;
    if (!loopHandoffUsable(job)) continue;
    const finished = Number(job.finished_at || 0) || 0;
    const created = Number(job.created_at || 0) || 0;
    const at = Math.max(finished, created);
    if (!best || at >= bestAt) {
      best = job;
      bestAt = at;
    }
  }
  return best;
}

export function resetStaleLoopWorkspace(workspace: string): void {
  const heim = join(workspace, ".heimdall");
  if (!existsSync(heim)) return;
  for (const name of ["prior_brief.md", "handoff.json", "session.json", "started_at"]) {
    try {
      unlinkSync(join(heim, name));
    } catch {
      /* ignore */
    }
  }
  const ev = join(heim, "events.jsonl");
  if (!existsSync(ev)) return;
  try {
    renameSync(ev, join(heim, "events.prev.jsonl"));
  } catch {
    try {
      unlinkSync(ev);
    } catch {
      /* ignore */
    }
  }
}

function extractToolTimeline(path: string, limit = 40): string[] {
  const out: string[] = [];
  if (!existsSync(path)) return out;
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (out.length >= limit) break;
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        const summary = summarizeEvent(rec);
        if (summary && !timelineIsInfraNoise(summary)) out.push(summary);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

export function buildPriorBrief(
  workspace: string,
  opts: {
    parentJobDir?: string | null;
    uniqueCode?: string;
    sourceJobId?: string | null;
    maxChars?: number;
    directFirst?: boolean;
    fromLoop?: boolean;
  } = {},
): string {
  const handoff = loadHandoff(workspace);
  const rotated = Boolean(handoff.instance_rotated);
  const directFirst = Boolean(opts.directFirst);
  const fromLoop = Boolean(opts.fromLoop) && !directFirst;
  const heading = directFirst ? "# First loop (no regular Pi)" : fromLoop ? "# Prior loop" : "# Prior regular attempt";
  const lines = [heading, ""];
  if (directFirst) {
    lines.push(
      "This challenge skipped regular Pi and entered loop directly. There is no prior regular to continue; start from container_addr in input.json.",
      "Do not treat the handoff generation or old events as many completed rounds.",
      "",
    );
  } else if (fromLoop) {
    lines.push(
      "This challenge had no regular Pi; the previous job was also a loop. Continue unfinished surfaces from that round; this is not a \"regular-slot timeout\".",
      "Scored flags stay scored. Do not restart from the public site. Read the coverage map, flags.json, and the tool timeline below.",
      "brief / LOCK are suggestions only.",
      "",
    );
  } else if (rotated) {
    lines.push(
      "The target instance changed (new container_addr). Reuse the method, not the host.",
      "Refresh scope from input.json. Probe the new addresses first.",
      "Old IPs are dead; hit only the new addresses in input.json.",
      "",
    );
  } else {
    lines.push(
      "A regular slot timed out mid-work. Continue that work.",
      "Prefer a new shape from the last tension / brief, not recon from zero.",
      "If a prior submit was correct:false, stay on that sink; bypass any log/CI/WAF scrubber and re-extract the real value. Do not resubmit rejected strings.",
      "",
    );
  }
  if (opts.uniqueCode) lines.push(`- unique_code: ${opts.uniqueCode}`);
  if (opts.sourceJobId) lines.push(`- source_job_id: ${opts.sourceJobId}`);
  if (opts.parentJobDir) lines.push(`- parent_job_dir: ${opts.parentJobDir}`);
  lines.push("");
  if (Object.keys(handoff).length) {
    lines.push("## Handoff (control plane)");
    for (const key of [
      "generation",
      "instance_rotated",
      "addrs",
      "prev_addrs",
      "flags_correct",
      "flag_count",
      "flags_remaining",
      "hint_taken",
      "session_reusable",
      "dead_hosts",
    ]) {
      if (key in handoff) lines.push(`- ${key}: ${handoff[key]}`);
    }
    const methods = (handoff.methods_that_worked as unknown[]) || [];
    if (methods.length) {
      lines.push("- methods_that_worked (methods that already landed):");
      for (const item of methods.slice(0, 12)) lines.push(`  - ${item}`);
    }
    lines.push("");
  }
  const obl = formatObligation(workspace);
  if (obl) {
    lines.push("## Observer direction (suggestion)", obl, "");
  }
  const mapBody = readText(mapMd(workspace), 4000).trim();
  if (mapBody) lines.push("## Traffic map", mapBody, "");
  const confirmed = readText(confirmedMd(workspace), 3000).trim();
  if (confirmed) lines.push("## CONFIRMED (still on disk)", confirmed, "");
  const flags = loadJson(join(workspace, "flags.json"));
  if (flags) {
    const items = Array.isArray(flags) ? flags : [flags];
    const rejected: string[] = [];
    let nOk = 0;
    for (const item of items) {
      if (typeof item === "string" || !item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      if (!rec.flag) continue;
      if (rec.correct === true) {
        nOk += 1;
        continue;
      }
      const fp = flagFingerprint(String(rec.flag || ""));
      if (fp && !rejected.includes(fp)) rejected.push(fp);
    }
    if (nOk || rejected.length) {
      lines.push("## Submit ledger", `- scored: ${nOk}`);
      if (rejected.length) {
        lines.push(`- distinct rejected values: ${rejected.length} (do not resubmit these, and do not spray case/hyphen/whitespace variants)`);
        for (const fp of rejected.slice(0, 8)) lines.push(`  - ${fp}`);
      }
      lines.push("");
    }
  }
  const hint = existsSync(join(workspace, "hint.txt")) ? readFileSync(join(workspace, "hint.txt"), "utf8").trim() : "";
  if (hint) lines.push("## Platform hint (already taken)", hint.slice(0, 1500), "");
  const art = join(workspace, "artifacts");
  if (existsSync(art)) {
    try {
      const names = readdirSync(art).filter((n) => !n.startsWith(".")).slice(0, 24);
      if (names.length) {
        lines.push("## artifacts/");
        for (const name of names) lines.push(`- ${name}`);
        lines.push("");
      }
    } catch {
      /* ignore */
    }
  }
  const eventCandidates = [
    opts.parentJobDir ? join(opts.parentJobDir, "events.jsonl") : "",
    opts.parentJobDir ? join(opts.parentJobDir, "prior_events.jsonl") : "",
    directFirst ? "" : join(workspace, ".heimdall", "events.jsonl"),
  ].filter(Boolean);
  const eventsPath = eventCandidates.find((p) => existsSync(p));
  if (eventsPath) {
    const tools = extractToolTimeline(eventsPath);
    if (tools.length) {
      lines.push("## Tool timeline (prior job)");
      for (const item of tools) lines.push(`- ${item}`);
      lines.push("");
    }
  }
  let text = lines.join("\n").replace(/\s+$/, "") + "\n";
  const max = opts.maxChars ?? BRIEF_MAX_CHARS;
  if (text.length > max) text = `${text.slice(0, max - 20).replace(/\s+$/, "")}\n\n…(truncated)…\n`;
  return text;
}

export function writePriorBrief(
  workspace: string,
  opts: {
    dest?: string;
    parentJobDir?: string | null;
    uniqueCode?: string;
    sourceJobId?: string | null;
    maxChars?: number;
    directFirst?: boolean;
    fromLoop?: boolean;
  } = {},
): string {
  const dest = opts.dest || join(workspace, ".heimdall", "prior_brief.md");
  mkdirSync(join(workspace, ".heimdall"), { recursive: true });
  writeFileSync(dest, buildPriorBrief(workspace, opts));
  return dest;
}
