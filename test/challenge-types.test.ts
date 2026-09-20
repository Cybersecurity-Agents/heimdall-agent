import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, overlayConfig } from "../src/shared/config.js";
import { classifyChallenge } from "../src/shared/classify.js";
import { normalizeStrategy, resolveWorkspace, strategyToTypes } from "../src/shared/workspace-strategy.js";
import { resolveWorkspace as previewWorkspace } from "../console/src/lib/workspace.js";
import { Database } from "../src/shared/db.js";
import { createProject, createTask, projectSolveOverlay, setProjectStrategy, setProjectSettings } from "../src/control/console/workspace.js";
import { createBench } from "../src/platforms/index.js";
import { ensureDirectChallenge } from "../src/platforms/direct.js";
import { challengeFromDict } from "../src/platforms/types.js";
import { Daemon } from "../src/control/daemon.js";
import { Desk } from "../src/control/console/desk.js";
import * as runner from "../src/control/runner.js";
import { challengeTypeOf, applyResourceFilter } from "../src/policy/resources.js";
import { sortCodes } from "../src/policy/order.js";
import { recordLocalFlag } from "../src/shared/completion.js";

vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllTimers();
  vi.useRealTimers();
  cleanup.splice(0).reverse().forEach(fn => fn());
});

function fixture() {
  const dir = mkdtempSync("/tmp/heimdall-types-");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "config.yaml");
  writeFileSync(config, JSON.stringify({ paths: { data_dir: dir, tools_env: join(dir, "absent") }, images: { rules: [] } }));
  vi.stubEnv("HEIMDALL_WS_STRATEGY_FILE", "");
  const cfg = loadConfig(config, process.cwd());
  Object.assign(cfg, { agent_runtime: "local", observe_enabled: false, vpn_enabled: false, base_url: "", token: "",
    image_default: "fixture:default", image_pwn: "fixture:pwn", resources_enabled: true,
    timeout_by_type: { pwn: 1234, intranet: 2345 }, loop_timeout_by_type: { pwn: 3456, intranet: 4567 } });
  const db = new Database(cfg.db_path);
  cleanup.push(() => db["db"].close());
  const daemon = new Daemon(cfg, db, createBench(cfg, db));
  return { dir, config, cfg, db, daemon };
}

const empty = { containerId: "fixture", exitCode: 0, timedOut: false, logPath: "", error: null };

function assertExecution(f: ReturnType<typeof fixture>, spec: runner.RunSpec, type: string, image: string, timeout: number) {
  expect(spec).toMatchObject({ challengeType: type, image, timeoutSec: timeout });
  expect(f.db.getJob(spec.jobId)).toMatchObject({ challenge_type: type, image, timeout_sec: timeout });
  expect(readFileSync(join(spec.workspace, ".heimdall/challenge_type"), "utf8").trim()).toBe(type);
  expect(JSON.parse(readFileSync(join(spec.workspace, "input.json"), "utf8")).challenge_type).toBe(type);
  expect(f.db.getGoal(spec.workspace)?.runOptions.challengeType).toBe(type);
}

describe("one workspace classification", () => {
  it("matches UI, project policies and exported rules with case-insensitive exact-code priority", () => {
    const f = fixture();
    Object.assign(f.cfg, { type_overrides: { "web-1": "evasion" }, type_by_level: { 1: "cve" },
      type_rules: [{ match: ".*", type: "pwn" }], type_default: "intranet" });
    const strategy = normalizeStrategy({ default: "all", rules: [
      { workspace: "web", prefix: ["web"] },
      { workspace: "pentest", codes: ["WEB-1"] },
      { workspace: "pwn", codes: ["web-1"] },
      { workspace: "edr", match: "^BOX-" },
    ] });
    const projectCfg = overlayConfig(f.cfg, projectSolveOverlay({ workspace_strategy: strategy }));
    const types = strategyToTypes(strategy);
    const exported = { type_default: types.default, type_rules: types.rules, type_overrides: types.overrides };
    for (const [code, type] of [["WEB-1", "intranet"], ["web-2", "web"], ["box-1", "evasion"], ["other", "all"]]) {
      expect(resolveWorkspace(strategy, code!)).toBe(type);
      expect(previewWorkspace(strategy, code!)).toBe(type);
      expect(classifyChallenge(code!, projectCfg, { level: 1 })).toBe(type);
      expect(classifyChallenge(code!, exported)).toBe(type);
    }
    const emptyProject = overlayConfig(f.cfg, projectSolveOverlay({ workspace_strategy: { default: "all", rules: [] } }));
    expect(classifyChallenge("web-1", emptyProject, { level: 1 })).toBe("all");
    expect(f.cfg.type_overrides).toEqual({ "web-1": "evasion" });
  });

  it.each(["exported", "workspace", "project", "preset"])("loads %s strategy files for the standalone scheduler", format => {
    const f = fixture();
    const strategy = { preset: "tsecbench-v1" };
    const doc = format === "exported" ? { types: strategyToTypes(strategy) }
      : format === "project" ? { workspace_strategy: strategy }
        : format === "workspace" ? normalizeStrategy(strategy) : strategy;
    writeFileSync(join(f.dir, "workspace_strategy.yaml"), JSON.stringify(doc));
    const cfg = loadConfig(f.config, process.cwd());
    for (const [code, type] of [["A-1", "web"], ["b-1", "intranet"], ["f-1", "pwn"], ["unknown", "all"]]) {
      expect(classifyChallenge(code!, cfg)).toBe(type);
    }
  });

  it("applies saved task workspaces before waves, resource admission and direct-loop enqueue, scoped by project", () => {
    const f = fixture();
    const a = String(createProject(f.cfg, "A").id), b = String(createProject(f.cfg, "B").id);
    createTask(f.cfg, { projectId: a, name: "lab", kind: "tsec", code: "opaque-1", workspace: "pentest" });
    createTask(f.cfg, { projectId: a, name: "binary", kind: "tsec", code: "opaque-2", workspace: "pwn" });
    createTask(f.cfg, { projectId: b, name: "web", kind: "tsec", code: "opaque-1", workspace: "web" });
    f.db.upsertChallenges([challengeFromDict({ unique_code: "opaque-1" }), challengeFromDict({ unique_code: "opaque-2" })]);
    const sched = f.daemon.withOverlay({ project_id: a });
    const other = f.daemon.withOverlay({ project_id: b });
    expect(challengeTypeOf(f.db.getChallenge("opaque-1")!, sched.cfg)).toBe("intranet");
    expect(sortCodes(["opaque-2", "opaque-1"], { ...sched.cfg, dispatch_waves: [["intranet"], ["pwn"]] })).toEqual(["opaque-1", "opaque-2"]);
    expect(applyResourceFilter(["opaque-1", "opaque-2"], { ...sched.cfg, lab_exclusive_types: ["intranet"], lab_exclusive_max: 0 },
      { challenges: f.db.listChallenges(), inFlight: [] })).toEqual(["opaque-2"]);
    expect(sched.enqueueDirectLoopChallenges().enqueued).toBe(1);
    expect(f.db.getLoopEntry("opaque-1", a)?.reason).toBe("direct_loop");
    expect(classifyChallenge("opaque-1", other.cfg)).toBe("web");
    expect(classifyChallenge("opaque-1", f.daemon.cfg)).toBe("all");
  });
});

describe("resolved execution type", () => {
  it("recomputes the type for an explicit restart after configuration changes", async () => {
    const f = fixture();
    const run = vi.spyOn(runner, "runLocal").mockResolvedValue(empty);
    await f.daemon.runJob("url-restart", "regular", { targetUrl: "http://127.0.0.1:9", challengeType: "pwn" });
    f.cfg.type_default = "web";
    await f.daemon.runNextLoop("url-restart", { resumeGoal: false });
    expect(run.mock.calls.map(([, spec]) => spec.challengeType)).toEqual(["pwn", "web"]);
    expect(f.db.listGoals()[0]?.runOptions.challengeType).toBe("web");
  });

  it("uses the selected type for workspace, image, admission, timeout and persisted recovery without pinning global config", async () => {
    const f = fixture();
    expect(f.cfg.image_rules).toEqual([]);
    const run = vi.spyOn(runner, "runLocal").mockImplementation(async (_cfg, spec) => {
      assertExecution(f, spec, "pwn", "fixture:pwn", spec.loop ? 3456 : 1234);
      return empty;
    });
    await f.daemon.runJob("url-opaque", "regular", { targetUrl: "http://127.0.0.1:9", challengeType: " PWN " });
    expect(run).toHaveBeenCalledOnce();
    expect(f.cfg.type_overrides).toEqual({});
    // A fresh controller must not depend on an old in-memory type pin.
    const restarted = new Daemon(f.cfg, f.db, f.daemon.client);
    await restarted.runNextLoop("url-opaque");
    expect(run).toHaveBeenCalledTimes(2);
    expect(f.cfg.type_overrides).toEqual({});
  });

  it("keeps image rule overrides while using the resolved type as the fallback", () => {
    const f = fixture();
    expect(runner.imageFor(f.cfg, "pwn", "opaque")).toBe("fixture:pwn");
    f.cfg.image_rules = [{ match: "^opaque$", image: "custom:image" }];
    expect(runner.imageFor(f.cfg, "pwn", "opaque")).toBe("custom:image");
  });

  it("uses newly synchronized platform levels before reserving the job", async () => {
    const f = fixture();
    f.cfg.type_by_level = { 8: "pwn" };
    vi.spyOn(f.daemon.client, "listChallenges").mockResolvedValue([challengeFromDict({ unique_code: "opaque", level: 8 })]);
    const run = vi.spyOn(runner, "runLocal").mockImplementation(async (_cfg, spec) => {
      assertExecution(f, spec, "pwn", "fixture:pwn", 1234);
      return empty;
    });
    await f.daemon.runJob("opaque", "regular", { syncBeforeStart: true, targetUrl: "http://127.0.0.1:9" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("loads project strategy during recovery even when a legacy goal has no saved type", async () => {
    const f = fixture();
    const pid = String(createProject(f.cfg, "recovery").id);
    setProjectStrategy(f.cfg, pid, { default: "pwn", rules: [] });
    ensureDirectChallenge(f.db, "url-recovery", "http://127.0.0.1:9");
    const run = vi.spyOn(runner, "runLocal").mockImplementation(async (_cfg, spec) => {
      assertExecution(f, spec, "pwn", "fixture:pwn", spec.loop ? 3456 : 1234);
      return empty;
    });
    await f.daemon.runJob("url-recovery", "regular", { projectId: pid, targetUrl: "http://127.0.0.1:9" });
    const goal = f.db.listGoals()[0]!;
    delete goal.runOptions.challengeType;
    goal.nextRunAt = 0;
    expect(f.db.claimGoal(goal, "fixture")).toBe(true);
    f.db.releaseGoal(goal.workspace, "fixture");
    run.mockImplementationOnce(async (_cfg, spec) => {
      assertExecution(f, spec, "pwn", "fixture:pwn", 3456);
      recordLocalFlag(spec.workspace, "flag{recovered}");
      return empty;
    });
    const restarted = new Daemon(f.cfg, f.db, f.daemon.client);
    await restarted.resumeGoals();
    await vi.waitFor(() => expect(f.db.getGoal(goal.workspace)?.state).toBe("succeeded"));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("restores project timeouts during recovery without leaking them to another project", async () => {
    const f = fixture();
    const pid = String(createProject(f.cfg, "custom clocks").id);
    const other = String(createProject(f.cfg, "global clocks").id);
    setProjectSettings(f.cfg, pid, { default_timeout_sec: 321, loop_timeout_sec: 654 });
    const scoped = f.daemon.withOverlay({ project_id: pid });
    expect(scoped.withOverlay({ project_id: other }).cfg.default_timeout_sec).toBe(f.cfg.default_timeout_sec);
    expect(scoped.withOverlay({ project_id: null }).cfg.loop_timeout_sec).toBe(f.cfg.loop_timeout_sec);
    ensureDirectChallenge(f.db, "url-clocks", "http://127.0.0.1:9");
    const run = vi.spyOn(runner, "runLocal").mockResolvedValue(empty);
    await f.daemon.runJob("url-clocks", "regular", { projectId: pid, targetUrl: "http://127.0.0.1:9" });
    const goal = f.db.listGoals()[0]!;
    goal.nextRunAt = 0;
    expect(f.db.claimGoal(goal, "fixture")).toBe(true);
    f.db.releaseGoal(goal.workspace, "fixture");
    run.mockImplementationOnce(async (_cfg, spec) => { recordLocalFlag(spec.workspace, "flag{recovered}"); return empty; });
    const restarted = new Daemon(f.cfg, f.db, f.daemon.client);
    await restarted.resumeGoals();
    await vi.waitFor(() => expect(f.db.getGoal(goal.workspace)?.state).toBe("succeeded"));
    expect(run.mock.calls.map(([, spec]) => spec.timeoutSec)).toEqual([321, 654]);
  });

  it("returns and launches the saved task type when a desk request omits workspace", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pid = String(createProject(f.cfg, "desk").id);
    const task = createTask(f.cfg, { projectId: pid, name: "lab", kind: "url", url: "http://127.0.0.1:9", workspace: "pentest" });
    const run = vi.spyOn(runner, "runLocal").mockImplementation(async (_cfg, spec) => {
      assertExecution(f, spec, "intranet", "fixture:default", 4567);
      expect(spec.loop).toBe(true);
      recordLocalFlag(spec.workspace, "flag{complete}");
      return empty;
    });
    const desk = new Desk(f.cfg, f.db);
    expect(desk.start({ project_id: pid, code: task.code, url: task.url })).toMatchObject({ ok: true, workspace: "intranet" });
    await vi.waitFor(() => expect([...desk.runs.values()][0]?.status).toBe("done"));
    expect(run).toHaveBeenCalledOnce();
  });
});
