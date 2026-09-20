import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addrHost } from "../policy/resources.js";
import { forgetStaleCorrectFlags } from "./completion.js";
import { loadJson } from "./completion.js";

export const HANDOFF_NAME = "handoff.json";

export type FlagProgress = {
  flag_count: number;
  correct_flag_count: number;
  flags_remaining: number;
  is_completed: boolean;
  known: boolean;
};

export function firstHost(addrs: unknown): string {
  if (typeof addrs === "string") return addrHost(addrs);
  if (!Array.isArray(addrs)) return "";
  for (const item of addrs) {
    const host = addrHost(String(item));
    if (host) return host;
  }
  return "";
}

export function hostsOf(addrs: unknown): Set<string> {
  const out = new Set<string>();
  if (typeof addrs === "string") {
    const h = addrHost(addrs);
    if (h) out.add(h);
    return out;
  }
  if (Array.isArray(addrs)) {
    for (const item of addrs) {
      const h = addrHost(String(item));
      if (h) out.add(h);
    }
  }
  return out;
}

export function instanceRotated(prevAddrs: unknown, newAddrs: unknown): boolean {
  const prev = hostsOf(prevAddrs);
  const next = hostsOf(newAddrs);
  if (!prev.size || !next.size) return false;
  if (prev.size !== next.size) return true;
  for (const h of prev) if (!next.has(h)) return true;
  return false;
}

export function handoffPath(workspace: string): string {
  return join(workspace, ".heimdall", HANDOFF_NAME);
}

export function loadHandoff(workspace: string): Record<string, unknown> {
  const path = handoffPath(workspace);
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function remainingFlags(chRow: Record<string, unknown> | null | undefined): number {
  const prog = flagProgress(chRow);
  return prog.known ? prog.flags_remaining : 0;
}

function extractMethods(workspace: string): string[] {
  const out: string[] = [];
  const flagsPath = join(workspace, "flags.json");
  const raw = loadJson(flagsPath);
  const items = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? ((raw as { flags?: unknown[]; items?: unknown[] }).flags || (raw as { items?: unknown[] }).items || []) : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const src = String((item as { source?: unknown }).source || "").trim();
    if (src && !out.includes(src)) out.push(src.slice(0, 240));
    if (out.length >= 12) break;
  }
  return out;
}

export function buildHandoff(opts: {
  uniqueCode: string;
  addrs: string[];
  prev?: Record<string, unknown> | null;
  chRow?: Record<string, unknown> | null;
  workspace: string;
  hintTaken?: boolean;
  sessionReusable?: boolean;
  instanceRotatedFlag?: boolean | null;
}): Record<string, unknown> {
  const prev = opts.prev || {};
  const prevAddrs = Array.isArray(prev.addrs) ? prev.addrs.map(String) : [];
  const rotated =
    opts.instanceRotatedFlag != null ? Boolean(opts.instanceRotatedFlag) : instanceRotated(prevAddrs, opts.addrs);
  let gen = Number.parseInt(String(prev.generation || 0), 10) || 0;
  gen += 1;
  if (gen < 1) gen = 1;
  const prog = flagProgress(opts.chRow);
  const dead = [...((prev.dead_hosts as string[]) || [])].map(String);
  if (rotated) {
    for (const h of hostsOf(prevAddrs)) if (!dead.includes(h)) dead.push(h);
  }
  return {
    schema: 1,
    unique_code: opts.uniqueCode,
    generation: gen,
    instance_rotated: Boolean(rotated),
    prev_addrs: prevAddrs.map(String),
    addrs: opts.addrs.map(String),
    flags_correct: prog.correct_flag_count,
    flag_count: prog.flag_count,
    flags_remaining: prog.flags_remaining,
    hint_taken: Boolean(opts.hintTaken),
    methods_that_worked: extractMethods(opts.workspace),
    dead_hosts: dead,
    session_reusable: Boolean(opts.sessionReusable) && !rotated,
    written_at: Date.now() / 1000,
  };
}

export function writeHandoff(workspace: string, doc: Record<string, unknown>): string {
  const path = handoffPath(workspace);
  mkdirSync(join(workspace, ".heimdall"), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
  return path;
}

export function renderProgressMd(doc: Record<string, unknown>): string {
  const addrs = (doc.addrs as unknown[]) || [];
  const prev = (doc.prev_addrs as unknown[]) || [];
  const methods = (doc.methods_that_worked as unknown[]) || [];
  const dead = (doc.dead_hosts as unknown[]) || [];
  const lines = [
    `# ${doc.unique_code || "challenge"}`,
    "",
    "## Status",
    `- phase: ${doc.instance_rotated ? "rescope" : "continue"}`,
    `- generation: ${doc.generation || 1}`,
    `- instance_rotated: ${Boolean(doc.instance_rotated)}`,
    `- flags: ${doc.flags_correct || 0}/${doc.flag_count || "?"}`,
    `- flags_remaining: ${doc.flags_remaining || 0}`,
    `- hint_taken: ${Boolean(doc.hint_taken)}`,
    `- session_reusable: ${Boolean(doc.session_reusable)}`,
    "",
    "## Addresses",
    `- current: ${addrs.map(String).join(", ") || "(none)"}`,
    `- previous: ${prev.map(String).join(", ") || "(none)"}`,
    "",
    "## Methods that worked",
  ];
  if (methods.length) for (const m of methods) lines.push(`- ${m}`);
  else lines.push("- (none recorded)");
  lines.push("", "## Do not reuse hosts");
  if (dead.length) for (const h of dead) lines.push(`- ${h}`);
  else lines.push("- (none)");
  lines.push("", "## Next", "- read input.json (addresses may have changed)", "- heimdall-challenge", "");
  return lines.join("\n");
}

export function writeProgressMd(workspace: string, doc: Record<string, unknown>): string {
  const path = join(workspace, "progress.md");
  writeFileSync(path, renderProgressMd(doc));
  return path;
}

export function beginAttempt(
  workspace: string,
  opts: {
    uniqueCode: string;
    addrs: string[];
    jobKind: string;
    holdInstance: boolean;
    chRow?: Record<string, unknown> | null;
    instanceRestarted?: boolean;
  },
): Record<string, unknown> {
  const prev = loadHandoff(workspace);
  const prevAddrs = Array.isArray(prev.addrs) ? prev.addrs.map(String) : [];
  let rotated = Boolean(opts.instanceRestarted) || instanceRotated(prevAddrs, opts.addrs);
  if (!Object.keys(prev).length) rotated = false;
  const hadPrior = Object.keys(prev).length > 0;
  const reusable = opts.jobKind === "loop" && !rotated && (Boolean(opts.holdInstance) || hadPrior);
  const gen = Number.parseInt(String(prev.generation || 0), 10) || 0;
  const generation = hadPrior ? gen + 1 : 1;
  try {
    forgetStaleCorrectFlags(workspace, { instanceRotated: Boolean(rotated), chRow: opts.chRow });
  } catch {
    /* ignore */
  }
  const prog = flagProgressForAttempt(
    workspace,
    opts.chRow || {
      flag_count: prev.flag_count,
      correct_flag_count: prev.flags_correct,
      is_completed: false,
    },
  );
  const stub: Record<string, unknown> = {
    schema: 1,
    unique_code: opts.uniqueCode,
    generation,
    instance_rotated: Boolean(rotated),
    prev_addrs: prevAddrs,
    addrs: opts.addrs.map(String),
    flags_correct: prog.correct_flag_count,
    flag_count: prog.flag_count,
    flags_remaining: prog.flags_remaining,
    hint_taken: Boolean(prev.hint_taken),
    methods_that_worked: [...((prev.methods_that_worked as string[]) || [])],
    dead_hosts: [...((prev.dead_hosts as string[]) || [])].map(String),
    session_reusable: Boolean(reusable),
    written_at: Date.now() / 1000,
  };
  if (rotated) {
    const dead = [...(stub.dead_hosts as string[])];
    for (const h of hostsOf(prevAddrs)) if (!dead.includes(h)) dead.push(h);
    stub.dead_hosts = dead;
  }
  try {
    writeHandoff(workspace, stub);
    writeProgressMd(workspace, stub);
  } catch {
    /* ignore */
  }
  return {
    prev,
    prev_addrs: prevAddrs,
    instance_rotated: rotated,
    session_reusable: reusable,
    generation,
    host: firstHost(opts.addrs),
  };
}

export function scoredFlagsOnDisk(workspace: string): number {
  if (!workspace) return 0;
  const flagsPath = join(workspace, "flags.json");
  if (!existsSync(flagsPath)) return 0;
  try {
    const raw = JSON.parse(readFileSync(flagsPath, "utf8")) as unknown;
    const items = Array.isArray(raw) ? raw : [];
    return items.filter((x) => x && typeof x === "object" && (x as { correct?: unknown }).correct === true).length;
  } catch {
    return 0;
  }
}

/** Prefer platform row, then flags.json (loop-to-loop may start before listChallenges refreshes). */
export function flagProgressForAttempt(
  workspace: string,
  chRow?: Record<string, unknown> | null,
): FlagProgress {
  const prog = flagProgress(chRow);
  const disk = scoredFlagsOnDisk(workspace);
  if (disk <= prog.correct_flag_count) return prog;
  const total = prog.flag_count;
  const scored = disk;
  const completed = Boolean(prog.is_completed) || (total > 0 && scored >= total);
  const remaining = total > 0 ? (completed ? 0 : Math.max(0, total - scored)) : 0;
  return {
    flag_count: total,
    correct_flag_count: scored,
    flags_remaining: remaining,
    is_completed: completed,
    known: total > 0 || scored > 0,
  };
}

export function flagProgress(chRow: Record<string, unknown> | null | undefined): FlagProgress {
  const row = chRow || {};
  let total = 0;
  try {
    total = Number.parseInt(String(row.flag_count || 0), 10) || 0;
  } catch {
    total = 0;
  }
  let scored = 0;
  try {
    const raw = row.correct_flag_count ?? row.flags_correct ?? 0;
    scored = Number.parseInt(String(raw), 10) || 0;
  } catch {
    scored = 0;
  }
  if (scored < 0) scored = 0;
  const completed = Boolean(row.is_completed);
  const remaining = total > 0 ? (completed ? 0 : Math.max(0, total - scored)) : 0;
  return {
    flag_count: total,
    correct_flag_count: scored,
    flags_remaining: remaining,
    is_completed: completed || (total > 0 && remaining === 0 && scored > 0),
    known: total > 0,
  };
}
