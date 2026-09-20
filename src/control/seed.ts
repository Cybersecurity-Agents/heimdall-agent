import { resolveSkillSet } from "../shared/resources.js";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalType } from "../shared/classify.js";

function playbookFile(dir: string, name: string): string {
  const en = join(dir, "_en", name);
  if (existsSync(en)) return en;
  return join(dir, name);
}

function copyMissing(src: string, dst: string): void {
  if (!existsSync(src)) return;
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    if (name === "_en") continue;
    const s = join(src, name);
    const d = join(dst, name);
    const st = statSync(s);
    if (st.isDirectory()) copyMissing(s, d);
    else if (!existsSync(d)) cpSync(s, d);
  }
}

function applyLayer(
  srcRoot: string,
  workspace: string,
): void {
  if (!existsSync(srcRoot)) return;
  for (const name of readdirSync(srcRoot)) {
    if (name === "CLAUDE.md" || name === ".claude") continue;
    const s = join(srcRoot, name);
    const d = join(workspace, name);
    const st = statSync(s);
    if (st.isDirectory()) copyMissing(s, d);
    else if (!existsSync(d)) cpSync(s, d);
  }

}

export function seedWorkspace(
  workspace: string,
  repoRoot: string,
  opts: { challengeType?: string; forceClaudeMd?: boolean } = {},
): void {
  let ctype = canonicalType(opts.challengeType || "all");
  const base = join(repoRoot, "resources/workspaces", "base");
  if (!existsSync(base)) return;
  // The fallback playbook and its skill overlays must describe the same type.
  if (!existsSync(playbookFile(join(repoRoot, "resources/workspaces/types", ctype), "CLAUDE.md"))) ctype = "all";
  mkdirSync(join(workspace, "artifacts"), { recursive: true });
  mkdirSync(join(workspace, ".heimdall", "browser", "shots"), { recursive: true });
  const stateJson = join(workspace, ".heimdall", "browser", "state.json");
  if (!existsSync(stateJson)) {
    writeFileSync(stateJson, '{\n  "cookies": [],\n  "origins": []\n}\n');
  }
  const typeMarker = join(workspace, ".heimdall", "challenge_type");
  let prev = "";
  if (existsSync(typeMarker)) {
    try {
      prev = readFileSync(typeMarker, "utf8").trim().toLowerCase();
    } catch {
      prev = "";
    }
  }
  let force = Boolean(opts.forceClaudeMd);
  if (prev && prev !== ctype) force = true;
  writeFileSync(typeMarker, ctype + "\n");

  applyLayer(base, workspace);
  const web = join(repoRoot, "resources/workspaces/types", "web");
  if (existsSync(web)) applyLayer(web, workspace);

  const typeOverlay = join(repoRoot, "resources/workspaces/types", ctype);
  const overlays: string[] = [];
  if (["pwn", "evasion"].includes(ctype) && typeOverlay !== base && typeOverlay !== web) {
    overlays.push(typeOverlay);
  }
  if (ctype === "all" || ctype === "") {
    for (const extra of ["pwn", "evasion"]) {
      const p = join(repoRoot, "resources/workspaces/types", extra);
      if (existsSync(p) && !overlays.includes(p)) overlays.push(p);
    }
  }
  for (const overlay of overlays) applyLayer(overlay, workspace);

  let claudeSrc = playbookFile(typeOverlay, "CLAUDE.md");
  if (!existsSync(claudeSrc)) claudeSrc = playbookFile(join(repoRoot, "resources/workspaces/types", "all"), "CLAUDE.md");
  if (!existsSync(claudeSrc)) claudeSrc = playbookFile(web, "CLAUDE.md");
  const dst = join(workspace, "CLAUDE.md");
  if (existsSync(claudeSrc) && (force || !existsSync(dst))) cpSync(claudeSrc, dst);

  const allowed = new Set(resolveSkillSet(ctype, repoRoot));
  for (const name of allowed) {
    const src = join(repoRoot, "resources/skills/catalog", name);
    const dst = join(workspace, ".claude/skills", name);
    copyMissing(src, dst);
    const en = join(src, "_en/SKILL.md");
    if (existsSync(en)) cpSync(en, join(dst, "SKILL.md"));
  }
  const skillsDst = join(workspace, ".claude", "skills");
  if (existsSync(skillsDst)) {
    for (const name of readdirSync(skillsDst)) {
      if (allowed.has(name)) continue;
      try {
        rmSync(join(skillsDst, name), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
