import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Runtime assets are resolved from the installation, never the job cwd. */
export function installationRoot(root?: string): string {
  return resolve(root || process.env.HEIMDALL_REPO_ROOT || join(dirname(fileURLToPath(import.meta.url)), "../.."));
}

const PROMPTS = {
  "solver-protocol": "resources/prompts/solver/en/protocol.md",
  "solver-user": "resources/prompts/solver/en/user.md",
  "solver-loop": "resources/prompts/solver/en/loop_followup.md",
  observer: "resources/prompts/observer/en/observer_system.md",
  "observer-spray": "resources/prompts/observer/en/observer_spray.md",
  "observer-zh": "resources/prompts/observer/zh/observer_system.md",
  "observer-spray-zh": "resources/prompts/observer/zh/observer_spray.md",
  "observer-recap": "resources/prompts/observer/zh/observer_recap.md",
  summarizer: "resources/prompts/summarizer/en/brief-summarizer-system.md",
};
export type PromptId = keyof typeof PROMPTS;
export function resourcePath(id: string, root?: string): string {
  const base = installationRoot(root);
  if (id in PROMPTS) return join(base, PROMPTS[id as PromptId]);
  if (id.startsWith("workspace-")) {
    const type = id.slice("workspace-".length);
    if (!/^[a-z0-9-]+$/.test(type)) throw new Error(`Invalid workspace resource: ${id}`);
    const dir = join(base, "resources/workspaces/types", type);
    const en = join(dir, "_en", "CLAUDE.md");
    return existsSync(en) ? en : join(dir, "CLAUDE.md");
  }
  if (id === "map-template") return join(base, "resources/workspaces/templates/map-template.html");
  if (id === "wordlists") return join(base, "resources/wordlists");
  throw new Error(`Unknown resource: ${id}`);
}
export function loadPrompt(id: PromptId, root?: string): string {
  return readFileSync(resourcePath(id, root), "utf8");
}

export type SkillMapping = { common: string[]; types: Record<string, string[]> };
export function skillMapping(root?: string): SkillMapping {
  return JSON.parse(readFileSync(join(installationRoot(root), "resources/skills/mapping.json"), "utf8"));
}
export function resolveSkillSet(type: string, root?: string): string[] {
  const mapping = skillMapping(root);
  return [...new Set([...mapping.common, ...(mapping.types[type] ?? mapping.types.all ?? [])])];
}

export type RuntimeLayout = { directories: string[]; defaultWordlists: string[]; compatibility: Record<string, string> };
export function runtimeLayout(root?: string): RuntimeLayout {
  return JSON.parse(readFileSync(join(installationRoot(root), "resources/runtime-layout.json"), "utf8"));
}
