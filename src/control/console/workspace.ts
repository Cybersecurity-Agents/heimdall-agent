import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Config } from "../../shared/config.js";
import { nowSec, rmTree } from "../../shared/fsutil.js";
import { isPreset, workspaceStrategy as tsecWorkspaceStrategy } from "../../platforms/tsec/preset.js";
import { codeForUrl, normalizeTargetUrl } from "../../platforms/direct.js";
import { canonicalType } from "../../shared/classify.js";

import { WORKSPACE_IDS, normalizeWorkspace, normalizeTaskWorkspace, normalizeStrategy, strategyToTypes } from "../../shared/workspace-strategy.js";
export { WORKSPACE_IDS, normalizeWorkspace, normalizeTaskWorkspace, normalizeStrategy, strategyToTypes, resolveWorkspace } from "../../shared/workspace-strategy.js";

const WORKSPACE_META: Record<string, Record<string, string>> = {
  all: { label_zh: "全量", label_en: "All", hint_zh: "未分赛道 / 总表 + 各赛道", hint_en: "Unknown type / full table + tracks" },
  web: { label_zh: "Web", label_en: "Web", hint_zh: "HTTP / Playwright / XSS / 提示注入", hint_en: "HTTP / Playwright / XSS / prompt injection" },
  pwn: { label_zh: "Pwn", label_en: "Pwn", hint_zh: "二进制 / 漏洞利用", hint_en: "Binary / exploit" },
  intranet: { label_zh: "内网", label_en: "Intranet", hint_zh: "入口 / 跳板 / AD", hint_en: "Foothold / pivot / AD" },
  cve: { label_zh: "通用漏洞", label_en: "CVE", hint_zh: "grep 产品 / heimdall-cve 编号", hint_en: "grep product / heimdall-cve id" },
  evasion: { label_zh: "对抗规避", label_en: "Evasion", hint_zh: "免杀 / 脱壳 / AMSI / EDR / 扫描器", hint_en: "AV/EDR evasion / unpack / AMSI / scanners" },
};

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

import { readLedger, writeLedger, type Ledger } from "../../shared/project-ledger.js";

export function safeProjectId(projectId: string | null | undefined): string | null {
  const pid = (projectId || "").trim();
  if (!pid || pid.includes("/") || pid.includes("\\") || pid.includes("..")) return null;
  if (!PROJECT_ID_RE.test(pid)) return null;
  return pid;
}

export function projectRootDir(cfg: Config, projectId: string | null | undefined): string | null {
  const pid = safeProjectId(projectId);
  if (!pid) return null;
  return join(cfg.data_dir, "projects", pid);
}

export function projectWorkspacesDir(cfg: Config, projectId: string | null | undefined): string {
  const root = projectRootDir(cfg, projectId);
  if (!root) return join(cfg.data_dir, "workspaces");
  return join(root, "workspaces");
}

export function challengeWorkspace(cfg: Config, code: string, projectId?: string | null): string {
  return join(projectWorkspacesDir(cfg, projectId), String(code || "").trim());
}

export { rmTree };

export function listWorkspaceCatalog(repoRoot?: string | null): Record<string, unknown>[] {
  const root = repoRoot ? join(repoRoot, "resources/workspaces/types") : null;
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const wid of WORKSPACE_IDS) {
    const path = root ? join(root, wid) : null;
    if (path && !existsSync(path) && !existsSync(join(path, "CLAUDE.md"))) continue;
    out.push({ id: wid, ...(WORKSPACE_META[wid] || {}) });
    seen.add(wid);
  }
  if (root && existsSync(root)) {
    for (const name of readdirSync(root).sort()) {
      if (name.startsWith("_") || seen.has(name)) continue;
      const child = join(root, name);
      try {
        if (!existsSync(join(child, "CLAUDE.md"))) continue;
      } catch {
        continue;
      }
      out.push({ id: name, label_zh: name, label_en: name, hint_zh: "", hint_en: "" });
    }
  }
  return out.length
    ? out
    : WORKSPACE_IDS.map((wid) => ({ id: wid, ...(WORKSPACE_META[wid] || {}) }));
}

export function listSolvePresets(): Record<string, unknown>[] {
  const strat = tsecWorkspaceStrategy() as Record<string, unknown>;
  strat.preset = "tsecbench-v1";
  return [
    {
      id: "tsecbench-v1",
      label_zh: "Tsecbench v1",
      label_en: "Tsecbench v1",
      hint_zh:
        "只对当前项目生效。按题号前缀分 workspace：a/d→web，f→pwn，c→cve，b→内网，e→对抗规避。内网题跳过首次 Pi，直接进 loop。",
      hint_en:
        "This project only. Prefixes: a/d web, f pwn, c cve, b intranet, e evasion. Intranet codes skip the first Pi pass and go to the loop.",
      workspace_strategy: strat,
    },
  ];
}

export function projectSolveOverlay(
  project: Record<string, unknown> | null,
  tasks: Record<string, unknown>[] = [],
): Record<string, unknown> {
  if (!project) return {};
  const strat = normalizeStrategy(project.workspace_strategy);
  const types = strategyToTypes(strat);
  // A project owns its classification, including an explicit all/default and
  // empty rules. Global overrides and level mappings must not change its UI result.
  const overrides = { ...types.overrides };
  const seen = new Set<string>();
  for (const task of tasks.slice().sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0))) {
    const code = String(task.code || "").trim().toLowerCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const ws = normalizeTaskWorkspace(String(task.workspace || "auto"));
    if (ws !== "auto") overrides[code] = ws;
  }
  return {
    type_default: types.default,
    type_overrides: overrides,
    type_rules: types.rules,
    type_by_level: {},
    ...(isPreset(String(strat.preset || "")) ? { loop_direct_types: ["intranet"] } : {}),
  };
}

export function getProjectStrategy(cfg: Config, projectId: string): Record<string, unknown> {
  const proj = getProject(cfg, projectId);
  if (!proj) return { default: "all", rules: [] };
  return normalizeStrategy(proj.workspace_strategy);
}

export function storePath(cfg: Config): string {
  return join(cfg.data_dir, "console", "ledger.json");
}

function makeId(prefix: string): string {
  return `${prefix}_${randomBytes(5).toString("hex")}`;
}

function taskView(task: Record<string, unknown>): Record<string, unknown> {
  return { ...task, workspace: normalizeTaskWorkspace(String(task.workspace || "auto")) };
}

function projectView(project: Record<string, unknown>): Record<string, unknown> {
  const item = { ...project };
  const settings = item.settings;
  item.settings = settings && typeof settings === "object" && !Array.isArray(settings) ? { ...settings } : {};
  item.workspace_strategy = normalizeStrategy(item.workspace_strategy);
  item.solve_presets = listSolvePresets();
  return item;
}

export function ensureDefault(cfg: Config): Ledger {
  const data = readLedger(cfg);
  if (!existsSync(storePath(cfg))) {
    data.projects.push({ id: makeId("p"), name: "Ledger", note: "Default book", created_at: nowSec(), updated_at: nowSec() });
    writeLedger(cfg, data);
  }
  return data;
}

export function listProjects(cfg: Config): Record<string, unknown>[] {
  const data = readLedger(cfg);
  const out = data.projects.map((p) => {
    const item = projectView(p);
    const pid = String(p.id || "");
    item.task_count = data.tasks.filter((t) => t.project_id === pid).length;
    return item;
  });
  out.sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
  return out;
}

export function getProject(cfg: Config, projectId: string): Record<string, unknown> | null {
  for (const p of readLedger(cfg).projects) {
    if (p.id === projectId) return projectView(p);
  }
  return null;
}

export function createProject(cfg: Config, name: string, note = ""): Record<string, unknown> {
  const title = (name || "").trim();
  if (!title) throw new Error("project needs a name");
  const rec: Record<string, unknown> = {
    id: makeId("p"),
    name: title.slice(0, 80),
    note: (note || "").trim().slice(0, 400),
    settings: {},
    workspace_strategy: { default: "all", rules: [] },
    created_at: nowSec(),
    updated_at: nowSec(),
  };
  const data = readLedger(cfg);
  data.projects.push(rec);
  writeLedger(cfg, data);
  return rec;
}

export function deleteProject(cfg: Config, projectId: string): boolean {
  const data = readLedger(cfg);
  const before = data.projects.length;
  data.projects = data.projects.filter((p) => p.id !== projectId);
  data.tasks = data.tasks.filter((t) => t.project_id !== projectId);
  if (data.projects.length === before) return false;
  writeLedger(cfg, data);
  return true;
}

export function setProjectSettings(
  cfg: Config,
  projectId: string,
  overrides: Record<string, unknown>,
): Record<string, unknown> | null {
  const pid = (projectId || "").trim();
  if (!pid) return null;
  const data = readLedger(cfg);
  let found: Record<string, unknown> | null = null;
  for (const p of data.projects) {
    if (p.id !== pid) continue;
    p.settings = { ...overrides };
    p.updated_at = nowSec();
    found = projectView(p);
    break;
  }
  if (!found) return null;
  writeLedger(cfg, data);
  return found;
}

export function setProjectStrategy(
  cfg: Config,
  projectId: string,
  strategy: unknown,
): Record<string, unknown> | null {
  const pid = (projectId || "").trim();
  if (!pid) return null;
  const clean = normalizeStrategy(strategy);
  const data = readLedger(cfg);
  let found: Record<string, unknown> | null = null;
  for (const p of data.projects) {
    if (p.id !== pid) continue;
    p.workspace_strategy = clean;
    p.updated_at = nowSec();
    found = projectView(p);
    break;
  }
  if (!found) return null;
  writeLedger(cfg, data);
  return found;
}

export function listTasks(cfg: Config, projectId: string): Record<string, unknown>[] {
  const rows = readLedger(cfg).tasks.filter((t) => t.project_id === projectId).map(taskView);
  rows.sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
  return rows;
}

export function getTask(cfg: Config, taskId: string): Record<string, unknown> | null {
  for (const t of readLedger(cfg).tasks) {
    if (t.id === taskId) return taskView(t);
  }
  return null;
}

export function createTask(
  cfg: Config,
  opts: { projectId: string; name: string; kind?: string; url?: string; code?: string; workspace?: string },
): Record<string, unknown> {
  const proj = getProject(cfg, opts.projectId);
  if (!proj) throw new Error("project not found");
  let title = (opts.name || "").trim();
  const kind = (opts.kind || "url").trim().toLowerCase();
  if (kind !== "url" && kind !== "tsec") throw new Error("kind must be url or tsec");
  let urlN = (opts.url || "").trim();
  let codeN = (opts.code || "").trim();
  if (kind === "url") {
    if (!urlN) throw new Error("task needs a target URL");
    urlN = normalizeTargetUrl(urlN);
    codeN = codeN || codeForUrl(urlN);
    if (!title) title = urlN;
  } else {
    if (!codeN) throw new Error("task needs a TSec code");
    if (!title) title = codeN;
  }
  let wsFinal = normalizeTaskWorkspace(opts.workspace);
  if (wsFinal === "auto" && kind === "url") wsFinal = "all";
  const rec: Record<string, unknown> = {
    id: makeId("t"),
    project_id: opts.projectId,
    name: title.slice(0, 120),
    kind,
    url: urlN,
    code: codeN,
    workspace: wsFinal,
    created_at: nowSec(),
    updated_at: nowSec(),
  };
  const data = readLedger(cfg);
  data.tasks.push(rec);
  for (const p of data.projects) {
    if (p.id === opts.projectId) p.updated_at = nowSec();
  }
  writeLedger(cfg, data);
  return taskView(rec);
}

export function ensureTsecTasks(
  cfg: Config,
  projectId: string,
  codes: string[],
  names?: Record<string, string>,
): { created: Record<string, unknown>[]; existing: string[] } {
  if (!getProject(cfg, projectId)) throw new Error("project not found");
  const wanted: string[] = [];
  const seen = new Set<string>();
  for (const raw of codes) {
    const code = String(raw || "").trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    wanted.push(code);
  }
  const created: Record<string, unknown>[] = [];
  const existing: string[] = [];
  if (!wanted.length) return { created, existing };
  const data = readLedger(cfg);
  const have = new Set(
    data.tasks
      .filter((t) => t.project_id === projectId && String(t.kind || "") === "tsec")
      .map((t) => String(t.code || "").trim())
      .filter(Boolean),
  );
  const now = nowSec();
  for (const code of wanted) {
    if (have.has(code)) {
      existing.push(code);
      continue;
    }
    const title = String((names || {})[code] || code).trim() || code;
    const rec: Record<string, unknown> = {
      id: makeId("t"),
      project_id: projectId,
      name: title.slice(0, 120),
      kind: "tsec",
      url: "",
      code,
      workspace: "auto",
      created_at: now,
      updated_at: now,
    };
    data.tasks.push(rec);
    created.push(taskView(rec));
    have.add(code);
  }
  if (created.length) {
    for (const p of data.projects) {
      if (p.id === projectId) p.updated_at = now;
    }
    writeLedger(cfg, data);
  }
  return { created, existing };
}

export function updateTask(
  cfg: Config,
  taskId: string,
  opts: { workspace?: unknown; name?: unknown },
): Record<string, unknown> | null {
  const tid = (taskId || "").trim();
  if (!tid) return null;
  const data = readLedger(cfg);
  let found: Record<string, unknown> | null = null;
  for (const t of data.tasks) {
    if (t.id !== tid) continue;
    if (opts.workspace !== undefined) t.workspace = normalizeTaskWorkspace(String(opts.workspace ?? ""));
    if (opts.name !== undefined) {
      const title = String(opts.name || "").trim();
      if (title) t.name = title.slice(0, 120);
    }
    t.updated_at = nowSec();
    found = { ...t };
    break;
  }
  if (!found) return null;
  writeLedger(cfg, data);
  return taskView(found);
}

export function deleteTask(cfg: Config, taskId: string): boolean {
  const data = readLedger(cfg);
  const before = data.tasks.length;
  data.tasks = data.tasks.filter((t) => t.id !== taskId);
  if (data.tasks.length === before) return false;
  writeLedger(cfg, data);
  return true;
}

export function ensureProjectWorkspaces(cfg: Config, projectId: string): string {
  const root = projectWorkspacesDir(cfg, projectId);
  mkdirSync(root, { recursive: true });
  return root;
}

export { canonicalType };
