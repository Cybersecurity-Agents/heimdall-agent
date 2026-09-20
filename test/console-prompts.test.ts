import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/shared/config.js";
import { getPrompt, writePrompt, resetPrompt } from "../src/control/console/prompts.js";
import { loadPrompt } from "../src/shared/resources.js";
import { loadObserverSystem } from "../src/observer/system-prompt.js";
import { seedWorkspace } from "../src/control/seed.js";
import { snapshotConsolePrompts } from "../src/control/prompt-snapshot.js";
import { loadProtocol, loadUserPromptTemplate, loadLoopFollowupTemplate } from "../src/agent/prompts.js";
const dirs: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), "heimdall-edit-")); dirs.push(root);
  cpSync(join(process.cwd(), "resources"), join(root, "resources"), { recursive: true });
  return { repo_root: root, data_dir: join(root, "data") } as Config;
}
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
describe("console prompt editing reaches effective runtime assets", () => {
  it.each(["observer", "observer-spray", "observer-recap", "summarizer"] as const)("edits %s without rebuilding", id => {
    const cfg = setup();
    expect(getPrompt(cfg, id)?.language).toBe(id === "observer-recap" ? "zh" : "en");
    writePrompt(cfg, id, `edited ${id}\n`);
    expect(loadPrompt(id, cfg.repo_root)).toBe(`edited ${id}\n`);
    expect(getPrompt(cfg, id)?.content).toBe(`edited ${id}\n`);
    if (id === "observer-spray") {
      const ws = join(cfg.data_dir, "ws");
      seedWorkspace(ws, cfg.repo_root, { challengeType: "intranet" });
      writeFileSync(join(ws, "input.json"), JSON.stringify({ challenge_type: "intranet" }));
      vi.stubEnv("HEIMDALL_REPO_ROOT", cfg.repo_root);
      expect(loadObserverSystem(ws)).toContain(`edited ${id}\n`);
    }
  });
  it("edits the English playbook used by seed and preserves resumed manual work", () => {
    const cfg = setup(); const ws = join(cfg.data_dir, "ws");
    const beforeZh = readFileSync(join(cfg.repo_root, "resources/workspaces/types/web/CLAUDE.md"), "utf8");
    writePrompt(cfg, "workspace-web", "edited English playbook\n");
    expect(getPrompt(cfg, "workspace-web")?.language).toBe("en");
    seedWorkspace(ws, cfg.repo_root, { challengeType: "web" });
    expect(readFileSync(join(ws, "CLAUDE.md"), "utf8")).toBe("edited English playbook\n");
    expect(readFileSync(join(cfg.repo_root, "resources/workspaces/types/web/CLAUDE.md"), "utf8")).toBe(beforeZh);
    writeFileSync(join(ws, "CLAUDE.md"), "manual task playbook\n");
    writePrompt(cfg, "workspace-web", "next playbook\n");
    seedWorkspace(ws, cfg.repo_root, { challengeType: "web" });
    expect(readFileSync(join(ws, "CLAUDE.md"), "utf8")).toBe("manual task playbook\n");
    seedWorkspace(ws, cfg.repo_root, { challengeType: "web", forceClaudeMd: true });
    expect(readFileSync(join(ws, "CLAUDE.md"), "utf8")).toBe("next playbook\n");
  });
  it.each([
    ["solver-protocol", loadProtocol, "HEIMDALL_SYSTEM_PROMPT_FILE"],
    ["solver-user", loadUserPromptTemplate, "HEIMDALL_USER_PROMPT_FILE"],
    ["solver-loop", loadLoopFollowupTemplate, "HEIMDALL_LOOP_FOLLOWUP_FILE"],
  ] as const)("snapshots and resets %s for the next job", (id, read, envKey) => {
    const cfg = setup(); const ws = join(cfg.data_dir, "ws");
    vi.stubEnv("HEIMDALL_REPO_ROOT", cfg.repo_root); vi.stubEnv("HEIMDALL_WORKSPACE", ws); vi.stubEnv(envKey, "");
    const original = read();
    writePrompt(cfg, id, "desk override\n"); snapshotConsolePrompts(cfg, ws);
    expect(read()).toBe("desk override");
    resetPrompt(cfg, id); snapshotConsolePrompts(cfg, ws);
    expect(read()).toBe(original);
  });
});
