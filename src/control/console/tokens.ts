import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../shared/config.js";
import { addTotals, billed, emptyUsage, readTotals, type UsageCounts } from "../../shared/llm-usage.js";
import { listProjects, projectWorkspacesDir } from "./workspace.js";

function counts(rec: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out = emptyUsage();
  addTotals(out, rec);
  const pub: Record<string, unknown> = { ...out, total_tokens: billed(out) };
  return pub;
}

function packModels(rec: Record<string, unknown> | null | undefined): Record<string, unknown>[] {
  const raw = rec && typeof rec === "object" ? rec.models : null;
  const packed: Record<string, unknown>[] = [];
  let entries: [string, unknown][] = [];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    entries = Object.entries(raw as Record<string, unknown>);
  } else if (Array.isArray(raw)) {
    entries = raw
      .filter((slot) => slot && typeof slot === "object")
      .map((slot) => [String((slot as Record<string, unknown>).name || ""), slot]);
  }
  for (const [name, slot] of entries) {
    const label = String(name || "").trim();
    if (!label || !slot || typeof slot !== "object") continue;
    const item = counts(slot as Record<string, unknown>);
    item.name = label;
    packed.push(item);
  }
  packed.sort((a, b) => Number(b.total_tokens || 0) - Number(a.total_tokens || 0) || String(a.name).localeCompare(String(b.name)));
  return packed;
}

function publicRec(rec: Record<string, unknown>): Record<string, unknown> {
  const out = counts(rec);
  if (rec.code) out.code = rec.code;
  if (rec.updated_ts != null) out.updated_ts = rec.updated_ts;
  const models = packModels(rec);
  if (models.length) out.models = models;
  return out;
}

function scanRoot(root: string): Record<string, unknown>[] {
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
    const rec = readTotals(child);
    if (!rec) continue;
    if (!rec.calls && billed(rec) === 0) continue;
    rec.code = name;
    out.push(publicRec(rec));
  }
  return out;
}

export function board(cfg: Config): Record<string, unknown> {
  const challenges: Record<string, unknown>[] = [];
  const projects: Record<string, unknown>[] = [];
  for (const proj of listProjects(cfg)) {
    const item = publicRec({});
    item.id = proj.id;
    item.name = proj.name || "";
    item.task_count = Number(proj.task_count || 0);
    const kids = scanRoot(projectWorkspacesDir(cfg, String(proj.id)));
    for (const child of kids) {
      child.project_id = proj.id;
      addTotals(item as unknown as UsageCounts, child);
      challenges.push(child);
    }
    item.total_tokens = billed(item);
    item.challenges = kids;
    projects.push(item);
  }
  const unassigned = scanRoot(join(cfg.data_dir, "workspaces"));
  challenges.push(...unassigned);
  const total = emptyUsage();
  const rolled: Record<string, UsageCounts> = {};
  for (const row of challenges) {
    addTotals(total, row);
    for (const slot of (row.models as Record<string, unknown>[]) || []) {
      if (!slot || typeof slot !== "object") continue;
      const name = String(slot.name || "").trim();
      if (!name) continue;
      const acc = (rolled[name] ||= emptyUsage());
      addTotals(acc, slot);
    }
  }
  const totalPub = publicRec(total as unknown as Record<string, unknown>);
  const models = packModels({ models: rolled });
  if (models.length) totalPub.models = models;
  return { ok: true, total: totalPub, models, projects, unassigned, challenges };
}
