import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicJson, goalSnapshot, managedGoal } from "./goal.js";

export type FlagRow = Record<string, unknown> & { flag?: string };

export function loadJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export function loadFlags(workspace: string): FlagRow[] {
  const data = loadJson(join(workspace, "flags.json"));
  if (Array.isArray(data)) {
    const out: FlagRow[] = [];
    for (const item of data) {
      if (typeof item === "string") out.push({ flag: item });
      else if (item && typeof item === "object" && (item as FlagRow).flag) {
        out.push(item as FlagRow);
      }
    }
    return out;
  }
  if (data && typeof data === "object" && (data as FlagRow).flag) {
    return [data as FlagRow];
  }
  return [];
}

/** Local submissions are recorded findings, never platform-verified scores. */
export function isDirectWorkspace(workspace: string, code?: string): boolean {
  const doc = inputDoc(workspace);
  if (code && doc.unique_code && code !== doc.unique_code) return code.startsWith("url-");
  return doc.target_mode === "direct" || doc.container_status === "direct"
    || String(code || doc.unique_code || "").startsWith("url-");
}

export function isLocalSubmit(row: FlagRow): boolean {
  return row.source === "direct" && row.via === "heimdall-submit" && row.recorded === true;
}

export function recordLocalFlag(workspace: string, flag: string): FlagRow {
  mkdirSync(workspace, { recursive: true });
  const row = { flag, source: "direct", via: "heimdall-submit", recorded: true, correct: null };
  const rows = loadFlags(workspace).filter(item => item.flag !== flag);
  writeJson(join(workspace, "flags.json"), [...rows, row]);
  return row;
}

export function hasAnyFlag(workspace: string): boolean {
  return loadFlags(workspace).length > 0;
}

export function scoredCorrect(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === "string" && ["true", "1", "yes"].includes(value.trim().toLowerCase())) {
    return true;
  }
  return false;
}

function isPlatformSubmit(item: FlagRow): boolean {
  if (!scoredCorrect(item.correct)) return false;
  const via = String(item.via || item.source || "")
    .trim()
    .toLowerCase();
  return via === "heimdall-submit" || via === "submit";
}

export function hasCorrectSubmit(workspace: string): boolean {
  return loadFlags(workspace).some(isPlatformSubmit);
}

export function forgetStaleCorrectFlags(
  workspace: string,
  opts: { force?: boolean; instanceRotated?: boolean; chRow?: Record<string, unknown> | null } = {},
): boolean {
  const path = join(workspace, "flags.json");
  if (!existsSync(path)) return false;
  // Same-instance loop-to-loop: platform correct_flag_count may still be 0 after a lag.
  // Only drop the ledger when the instance actually rotated or the caller forces a reset.
  if (!opts.force && !opts.instanceRotated) return false;
  const rows = loadFlags(workspace);
  if (!rows.some((item) => item.flag)) return false;
  writeJson(path, []);
  return true;
}

export function uniqueCorrectSubmits(workspace: string): number {
  const seen = new Set<string>();
  let n = 0;
  for (const item of loadFlags(workspace)) {
    if (!isPlatformSubmit(item)) continue;
    const flag = String(item.flag || "").trim();
    if (flag) {
      if (seen.has(flag)) continue;
      seen.add(flag);
    }
    n += 1;
  }
  return n;
}

function inputDoc(workspace: string): Record<string, unknown> {
  const data = loadJson(join(workspace, "input.json"));
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

export function isChallengeComplete(workspace: string): boolean {
  if (managedGoal(workspace)) return goalSnapshot(workspace)?.verdict.state === "satisfied";
  const doc = inputDoc(workspace);
  if (scoredCorrect(doc.is_completed)) return true;
  let total = 0;
  try {
    total = Number.parseInt(String(doc.flag_count || 0), 10) || 0;
  } catch {
    total = 0;
  }
  const scored = isDirectWorkspace(workspace)
    ? new Set(loadFlags(workspace).filter(isLocalSubmit).map(row => row.flag)).size
    : uniqueCorrectSubmits(workspace);
  if (total > 1) return scored >= total;
  if (total === 1) return scored >= 1;
  // Unknown platform totals require a challenge-complete response. Direct
  // workspaces retain their explicit candidate-collection compatibility mode.
  return isDirectWorkspace(workspace) && scored >= 1;
}

export function decideExitCode(opts: {
  workspace: string;
  backendOk: boolean;
  backendExit: number;
}): number {
  if (isChallengeComplete(opts.workspace)) return 0;
  return opts.backendExit === 0 ? 1 : opts.backendExit;
}

export function writeJson(path: string, doc: unknown): void {
  atomicJson(path, doc);
}
