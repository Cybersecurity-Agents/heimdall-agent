import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../shared/config.js";
import { listCalls, loadCall, safeCallId } from "../../shared/llm-session.js";
import { safeWsCode } from "./graphs.js";
import { listProjects, projectWorkspacesDir, safeProjectId } from "./workspace.js";

function scanRoot(root: string, projectId = ""): Record<string, unknown>[] {
  if (!existsSync(root)) return [];
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const name of names.sort()) {
    const child = join(root, name);
    try {
      if (!statSync(child).isDirectory() || name.startsWith(".")) continue;
    } catch {
      continue;
    }
    const calls = listCalls(child, 0);
    if (!calls.length) continue;
    const injected = calls.filter((c) => c.injected).length;
    const latest = calls[0] || {};
    const roles: string[] = [];
    for (const row of calls) {
      const role = String(row.role || "");
      if (role && !roles.includes(role)) roles.push(role);
    }
    const item: Record<string, unknown> = {
      code: name,
      calls: calls.length,
      injected,
      updated_ts: latest.ts,
      roles,
      model: latest.model || "",
    };
    if (projectId) item.project_id = projectId;
    out.push(item);
  }
  return out;
}

function wsRoot(cfg: Config, projectId?: string | null): string {
  const pid = safeProjectId(projectId);
  if (pid) return projectWorkspacesDir(cfg, pid);
  return join(cfg.data_dir, "workspaces");
}

export function board(cfg: Config, projectId?: string | null): Record<string, unknown> {
  const pid = safeProjectId(projectId);
  const items: Record<string, unknown>[] = [];
  if (pid) {
    items.push(...scanRoot(projectWorkspacesDir(cfg, pid), pid));
  } else {
    for (const proj of listProjects(cfg)) {
      items.push(...scanRoot(projectWorkspacesDir(cfg, String(proj.id)), String(proj.id)));
    }
    items.push(...scanRoot(join(cfg.data_dir, "workspaces")));
  }
  items.sort((a, b) => Number(b.updated_ts || 0) - Number(a.updated_ts || 0));
  return { ok: true, items };
}

export function challengeCalls(
  cfg: Config,
  code: string,
  opts: { projectId?: string | null; limit?: number } = {},
): Record<string, unknown> {
  const safe = safeWsCode(code);
  if (!safe) return { ok: false, error: "bad_code" };
  const calls = listCalls(join(wsRoot(cfg, opts.projectId), safe), opts.limit ?? 200);
  return { ok: true, code: safe, items: calls, count: calls.length };
}

export function challengeCall(
  cfg: Config,
  code: string,
  callId: string,
  opts: { projectId?: string | null } = {},
): Record<string, unknown> {
  const safe = safeWsCode(code);
  const cid = safeCallId(callId);
  if (!safe || !cid) return { ok: false, error: "bad_code" };
  const rec = loadCall(join(wsRoot(cfg, opts.projectId), safe), cid);
  if (!rec) return { ok: false, error: "not found", code: safe, id: cid };
  return { ...rec, ok: true, code: safe };
}
