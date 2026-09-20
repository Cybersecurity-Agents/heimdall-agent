import { canonicalType } from "../shared/classify.js";
import { loadPrompt } from "../shared/resources.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flagProgressForAttempt } from "../shared/handoff.js";
import { readText } from "../shared/paths.js";
import { composeInjectBlob } from "../shared/inject.js";
import { composeBriefBlob, detectJob, formatObligation } from "./observe.js";

const SECTION_RE = /\{\{#([A-Za-z0-9_]+)\}\}(.*?)\{\{\/\1\}\}/gs;
const VAR_RE = /\{\{([A-Za-z0-9_]+)\}\}/g;

const OVERLAY: Record<string, [string, string]> = {
  protocol: ["HEIMDALL_SYSTEM_PROMPT_FILE", "operator_prompt.md"],
  user: ["HEIMDALL_USER_PROMPT_FILE", "operator_user_prompt.md"],
  loop: ["HEIMDALL_LOOP_FOLLOWUP_FILE", "operator_loop_followup.md"],
};

export function loadInput(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function resolveChallengeType(inputDoc?: Record<string, unknown> | null): string {
  let raw = "";
  if (inputDoc?.challenge_type) raw = String(inputDoc.challenge_type).trim().toLowerCase();
  if (!raw) raw = (process.env.HEIMDALL_CHALLENGE_TYPE || "").trim().toLowerCase();
  return canonicalType(raw);
}

export function bundledTemplate(name: string, root?: string): string {
  if (name === "user.md") return loadPrompt("solver-user", root);
  if (name === "loop_followup.md") return loadPrompt("solver-loop", root);
  throw new Error(`Unknown prompt template: ${name}`);
}

export function loadProtocolFile(root?: string): string {
  return loadPrompt("solver-protocol", root);
}

export function renderTemplate(template: string, ctx: Record<string, string>): string {
  const truthy = (key: string) => Boolean(ctx[key] && String(ctx[key]).trim() !== "");
  let text = template.replace(SECTION_RE, (_m, key: string, inner: string) => {
    if (!truthy(key)) return "";
    return inner.startsWith("\n") ? inner.slice(1) : inner;
  });
  text = text.replace(VAR_RE, (m, key: string) => (key in ctx ? String(ctx[key] || "") : m));
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim() + "\n";
}

function loadNamedOverlay(kind: string, fallback: string): string {
  const pair = OVERLAY[kind];
  if (!pair) return fallback.trim();
  const [envKey, filename] = pair;
  const candidates: string[] = [];
  const envp = (process.env[envKey] || "").trim();
  if (envp) candidates.push(envp);
  const ws = (process.env.HEIMDALL_WORKSPACE || "").trim();
  if (ws) candidates.push(join(ws, ".heimdall", filename), join(ws, ".heimdall", "console-prompts", filename));
  for (const path of candidates) {
    try {
      if (existsSync(path)) {
        const text = readFileSync(path, "utf8").trim();
        if (text) return text;
      }
    } catch {
      /* ignore */
    }
  }
  return fallback.trim();
}

export function loadProtocol(): string {
  return loadNamedOverlay("protocol", loadProtocolFile());
}

export function loadUserPromptTemplate(): string {
  return loadNamedOverlay("user", bundledTemplate("user.md"));
}

export function loadLoopFollowupTemplate(): string {
  return loadNamedOverlay("loop", bundledTemplate("loop_followup.md"));
}

export function buildSystemPrompt(): string {
  return loadProtocol().trim() + "\n";
}

const PLAYBOOK_MARK = "\n# Workspace playbook (CLAUDE.md)\n";

export function loadWorkspaceClaudeMd(workspace: string): string {
  const path = join(workspace, "CLAUDE.md");
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

/** Inline workspace-root CLAUDE.md into the system prompt. Idempotent. */
export function withWorkspacePlaybook(systemPrompt: string, workspace: string): string {
  const body = loadWorkspaceClaudeMd(workspace);
  const base = (systemPrompt || "").trimEnd();
  if (!body) return base ? base + "\n" : "";
  if (base.includes(PLAYBOOK_MARK) || base.includes(body.slice(0, Math.min(80, body.length)))) {
    return base.endsWith("\n") ? base : base + "\n";
  }
  return `${base}${PLAYBOOK_MARK}\n${body}\n`;
}

function remainingFlagsLine(workspace: string): string {
  const inp = loadInput(join(workspace, "input.json"));
  const prog = flagProgressForAttempt(workspace, inp);
  const total = Number(prog.flag_count);
  const scored = Number(prog.correct_flag_count);
  const completed = Boolean(prog.is_completed);
  if (total > 0) {
    return `flags scored=${scored}/${total} remaining=${prog.flags_remaining} is_completed=${completed}`;
  }
  if (scored) return `flags scored=${scored} is_completed=${completed}`;
  return "flag_count unknown; after one submit, heimdall-challenge for is_completed";
}

function observerMapBlock(workspace: string, maxChars = 3500): string {
  let text = (composeInjectBlob(workspace) || "").trim();
  if (text.length > maxChars + 1600) {
    text = text.slice(0, maxChars + 1580).replace(/\s+$/, "") + "\n…(coverage map truncated)…";
  }
  return text;
}

export function loopFollowupPrompt(iteration: number, workspace?: string | null): string {
  const ctx: Record<string, string> = {
    iteration: String(iteration),
    advisor: "",
    remaining_flags: "",
    map: "",
    no_map: "",
    no_workspace: "",
    prior_brief: "",
    flags_json: "",
  };
  if (workspace) {
    if (detectJob(workspace)) {
      const blob = composeBriefBlob(workspace);
      if (blob) ctx.advisor = blob.trim();
    }
    ctx.remaining_flags = remainingFlagsLine(workspace);
    const mapped = observerMapBlock(workspace);
    if (mapped) ctx.map = mapped;
    else ctx.no_map = "1";
    const brief = readText(join(workspace, ".heimdall", "prior_brief.md"), 24000).trim();
    if (brief) ctx.prior_brief = brief;
    const flags = readText(join(workspace, "flags.json"), 2000);
    if (flags && flags.trim() !== "[]" && flags.trim() !== "") ctx.flags_json = flags;
  } else {
    ctx.no_workspace = "1";
  }
  return renderTemplate(loadLoopFollowupTemplate(), ctx);
}

export function buildUserPrompt(opts: {
  inputDoc: Record<string, unknown>;
  workspace: string;
  uniqueCode: string;
  attemptN: number;
}): string {
  const { inputDoc, workspace, uniqueCode, attemptN } = opts;
  let addrs = inputDoc.container_addr || [];
  if (typeof addrs === "string") addrs = [addrs];
  const resume = Boolean(inputDoc.resume);
  const isLoop = Boolean(inputDoc.loop || inputDoc.job_kind === "loop");
  const desc = String(inputDoc.description || "");
  const hint = inputDoc.hint;
  const ctype = resolveChallengeType(inputDoc);
  const rotated = Boolean(inputDoc.instance_rotated);
  const addrList = Array.isArray(addrs) ? addrs.map(String) : [];

  const fields = [
    `- unique_code: ${inputDoc.unique_code || uniqueCode}`,
    `- challenge_type: ${ctype}`,
    `- attempt_n: ${inputDoc.attempt_n || attemptN}`,
    `- resume: ${resume}`,
    `- loop: ${isLoop}`,
    `- container_addr: ${addrList.length ? addrList.join(", ") : "(none yet)"}`,
  ];
  if ("instance_rotated" in inputDoc) fields.push(`- instance_rotated: ${rotated}`);
  if (inputDoc.generation) fields.push(`- generation: ${inputDoc.generation}`);
  if ("session_reusable" in inputDoc) fields.push(`- session_reusable: ${Boolean(inputDoc.session_reusable)}`);
  const prev = inputDoc.prev_addrs;
  if (Array.isArray(prev) && prev.length) fields.push(`- prev_addrs: ${prev.map(String).join(", ")}`);
  const flagsProg = flagProgressForAttempt(workspace, inputDoc);
  if (flagsProg.known) {
    fields.push(
      `- flags: ${flagsProg.correct_flag_count}/${flagsProg.flag_count} remaining=${flagsProg.flags_remaining} is_completed=${Boolean(flagsProg.is_completed)}`,
    );
  } else {
    fields.push("- flags: unknown (platform did not report flag_count)");
  }
  if (isLoop) {
    fields.push(`- parent_job_id: ${inputDoc.parent_job_id || "-"}`);
    if (inputDoc.session_id) fields.push(`- session_id: ${inputDoc.session_id}`);
  }
  if (desc) fields.push(`- description: ${desc}`);
  if (hint) fields.push(`- platform_hint: ${hint}`);

  const ctx: Record<string, string> = {
    task_lines: fields.join("\n"),
    advisor: "",
    loop_rotated: "",
    loop_direct: "",
    loop_from_loop: "",
    loop_same: "",
    direct: "",
    hint: "",
    flags_json: "",
    obligation: "",
    map: "",
    map_notice: "",
    handoff: "",
    prior_brief: "",
    closing_multi: "",
    closing_one: "",
    closing_unknown: "",
    flag_count: String(flagsProg.flag_count || 0),
    scored: String(flagsProg.correct_flag_count || 0),
    remaining: String(flagsProg.flags_remaining || 0),
  };
  if (isLoop) {
    const advisor = composeBriefBlob(workspace);
    if (advisor) ctx.advisor = advisor.trim();
    const skipPi = Boolean(inputDoc.skip_pi);
    const fromLoop = Boolean(inputDoc.loop_from_loop);
    if (rotated) ctx.loop_rotated = "1";
    else if (fromLoop) ctx.loop_from_loop = "1";
    else if (skipPi) ctx.loop_direct = "1";
    else ctx.loop_same = "1";
  }
  if (Boolean(inputDoc.direct)) ctx.direct = "1";
  const diskHint = readText(join(workspace, "hint.txt"), 1500).trim();
  if (diskHint && diskHint !== String(hint || "").trim()) ctx.hint = diskHint;
  const flags = readText(join(workspace, "flags.json"), 2000);
  if (flags && flags.trim() !== "[]" && flags.trim() !== "") ctx.flags_json = flags;
  const obligation = formatObligation(workspace);
  if (obligation) ctx.obligation = obligation;
  const mapped = observerMapBlock(workspace);
  if (mapped) ctx.map = mapped;
  if (["all", "web", "pwn", "intranet", "cve", "evasion"].includes(ctype)) ctx.map_notice = "1";
  const handoff = readText(join(workspace, ".heimdall", "handoff.json"), 4000).trim();
  if (handoff && handoff !== "{}") ctx.handoff = handoff;
  if (isLoop) {
    const brief = readText(join(workspace, ".heimdall", "prior_brief.md"), 24000).trim();
    if (brief) ctx.prior_brief = brief;
  }
  if (flagsProg.known && flagsProg.flag_count > 1) ctx.closing_multi = "1";
  else if (flagsProg.known) ctx.closing_one = "1";
  else ctx.closing_unknown = "1";
  return renderTemplate(loadUserPromptTemplate(), ctx);
}

export function ensureWorkspaceSeed(workspace: string): void {
  mkdirSync(join(workspace, "artifacts"), { recursive: true });
  const defaults: [string, string][] = [
    ["progress.md", "# Challenge\n\n## Status\n- phase: start\n\n## Notes\n\n"],
    ["findings.json", '{ "leads": [] }\n'],
    ["flags.json", "[]\n"],
  ];
  for (const [name, body] of defaults) {
    const p = join(workspace, name);
    if (!existsSync(p)) {
      try {
        writeFileSync(p, body, "utf8");
      } catch {
        /* ignore */
      }
    }
  }
}
