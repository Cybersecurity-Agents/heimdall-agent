import { readLedger } from "../shared/project-ledger.js";
import { join, relative, resolve, sep } from "node:path";
import type { Config } from "../shared/config.js";

/** Unreadable metadata is not evidence that projects were deleted. */
export function knownProjectIds(cfg: Config): Set<string> | null {
  try {
    const ledger = readLedger(cfg);
    if (!Array.isArray(ledger.projects) || ledger.projects.some((p: { id?: unknown }) => !p || typeof p.id !== "string")) return null;
    return new Set(ledger.projects.map(p => String(p.id)));
  } catch { return null; }
}

export function workspaceProjectId(cfg: Config, workspace: string): string | null {
  const parts = relative(resolve(cfg.data_dir, "projects"), resolve(workspace)).split(sep);
  return parts.length >= 3 && /^p_[a-zA-Z0-9_-]+$/.test(parts[0] || "") && parts[1] === "workspaces" ? parts[0]! : null;
}
