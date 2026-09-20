import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/shared/config.js";
import { codeForUrl, isDirectCode, normalizeTargetUrl } from "../src/platforms/direct.js";
import {
  ensureDefault,
  createProject,
  createTask,
  listProjects,
  listTasks,
  normalizeStrategy,
  resolveWorkspace,
} from "../src/control/console/workspace.js";
import { coerceField, projectOverlay, snapshot } from "../src/control/console/settings.js";
import * as platform from "../src/control/console/platform.js";

const dirs: string[] = [];

function tempCfg() {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-console-"));
  dirs.push(dir);
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(
    join(dir, "config.yaml"),
    [
      "benchmark:",
      "  base_url: http://example.invalid",
      "  token: tok",
      "scheduler:",
      "  max_slots: 3",
      "docker:",
      "  runtime: local",
      "paths:",
      "  data_dir: data",
    ].join("\n"),
  );
  return loadConfig(join(dir, "config.yaml"), dir);
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("direct URLs", () => {
  it("normalizes and hashes a stable code", () => {
    const url = normalizeTargetUrl("example.com/path");
    expect(url).toBe("http://example.com/path");
    const code = codeForUrl("example.com/path");
    expect(isDirectCode(code)).toBe(true);
    expect(codeForUrl("http://example.com/path")).toBe(code);
  });
});

describe("workspace strategy", () => {
  it("resolves operator-defined prefix rules", () => {
    const strat = normalizeStrategy({
      default: "all",
      rules: [{ workspace: "web", prefix: ["web"] }, { workspace: "intranet", prefix: ["lab"] }],
    });
    expect(resolveWorkspace(strat, "web-1")).toBe("web");
    expect(resolveWorkspace(strat, "lab-2")).toBe("intranet");
    expect(resolveWorkspace(strat, "other")).toBe("all");
  });
});

describe("platform overlay", () => {
  it("does not fill a vendor URL when the platform is unset", () => {
    const cfg = tempCfg();
    cfg.base_url = "";
    cfg.token = "";
    platform.applySaved(cfg);
    expect(cfg.base_url).toBe("");
    const snap = platform.snapshot(cfg);
    expect(snap.base_url).toBe("");
    expect(snap.token_set).toBe(false);
    expect(snap.default_base_url).toBe(platform.EXAMPLE_BASE_URL);
  });
});

describe("ledger", () => {
  it("creates a default project and tasks", () => {
    const cfg = tempCfg();
    expect(listProjects(cfg)).toEqual([]);
    ensureDefault(cfg);
    const projects = listProjects(cfg);
    expect(projects.length).toBe(1);
    expect(projects[0]?.name).toBe("Ledger");
    const extra = createProject(cfg, "Lab", "note");
    expect(String(extra.id)).toMatch(/^p_/);
    const task = createTask(cfg, {
      projectId: String(extra.id),
      name: "box",
      kind: "url",
      url: "http://10.0.0.1/",
    });
    expect(task.kind).toBe("url");
    expect(isDirectCode(String(task.code))).toBe(true);
    expect(listTasks(cfg, String(extra.id)).length).toBe(1);
  });
});

describe("settings", () => {
  it("coerces floors and project overlay", () => {
    expect(() => coerceField("max_slots", 0)).toThrow(/>= 1/);
    expect(coerceField("loop_enabled", "yes")).toBe(true);
    const overlay = projectOverlay({ default_timeout_sec: 120, max_slots: 9 });
    expect(overlay.default_timeout_sec).toBe(120);
    expect(overlay.max_slots).toBeUndefined();
    const cfg = tempCfg();
    const snap = snapshot(cfg);
    expect(snap.agent_runtime).toBe("local");
  });
});
