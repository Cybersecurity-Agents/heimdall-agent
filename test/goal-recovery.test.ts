import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "../src/shared/db.js";
import { loadConfig } from "../src/shared/config.js";
import { Daemon } from "../src/control/daemon.js";
import { ensureDirectChallenge } from "../src/platforms/direct.js";
import { createBench } from "../src/platforms/index.js";
import { recordLocalFlag } from "../src/shared/completion.js";
import * as runner from "../src/control/runner.js";
import * as finalizer from "../src/control/observer-finalize.js";
vi.mock("../src/control/observer-finalize.js", async original => ({ ...await original<typeof import("../src/control/observer-finalize.js")>() }));
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync("/tmp/heimdall-goal-recovery-"); dirs.push(dir);
  const config = join(dir, "config.yaml");
  writeFileSync(config, JSON.stringify({ paths: { data_dir: dir, tools_env: join(dir, "absent") }, goal: { persistence: "until_satisfied" } }));
  const cfg = loadConfig(config, process.cwd());
  Object.assign(cfg, { agent_runtime: "local", observe_enabled: false, vpn_enabled: false, base_url: "", token: "", loop_max_per_challenge: 1 });
  const db = new Database(cfg.db_path);
  ensureDirectChallenge(db, "url-fixture", "http://127.0.0.1:9/fixture");
  const client = createBench(cfg, db);
  const daemon = new Daemon(cfg, db, client);
  return { dir, cfg, db, client, daemon };
}
const empty = { containerId: "fixture", exitCode: 0, timedOut: false, logPath: "", error: null };

describe("persistent task recovery", () => {
  it("releases the successful job and controller lease while its recap is still pending", async () => {
    const f = fixture();
    let finishRecap!: () => void;
    const recap = new Promise<void>(resolve => { finishRecap = resolve; });
    const finalize = vi.spyOn(finalizer, "runObserverFinalizer").mockReturnValue(recap);
    vi.spyOn(runner, "runLocal").mockImplementation(async (_cfg, spec) => { recordLocalFlag(spec.workspace, "flag{accepted}"); return empty; });
    try {
      const result = await f.daemon.runJob("url-fixture", "regular", { targetUrl: "http://127.0.0.1:9/fixture" });
      expect(result).toMatchObject({ status: "succeeded", completed: true });
      expect(finalize).toHaveBeenCalledOnce();
      expect(f.daemon.activeJobCodes().size).toBe(0);
      expect(f.db.countActiveJobs()).toBe(0);
      expect(f.db.goalOwned(f.db.listGoals()[0]!.workspace)).toBe(false);
      ensureDirectChallenge(f.db, "url-next", "http://127.0.0.1:9/next");
      expect(await f.daemon.runJob("url-next", "regular", { targetUrl: "http://127.0.0.1:9/next" })).toMatchObject({ status: "succeeded" });
    } finally { finishRecap(); }
  });

  it("does not mark exit zero successful and continues beyond legacy loop limits", async () => {
    const f = fixture();
    const run = vi.spyOn(runner, "runLocal").mockResolvedValue(empty);
    let result = await f.daemon.runJob("url-fixture", "loop", { targetUrl: "http://127.0.0.1:9/fixture" });
    expect(result).toMatchObject({ completed: false, status: "failed", goal_state: "retry_wait" });
    expect(f.db.getLoopEntry("url-fixture")?.status).toBe("queued");
    run.mockImplementationOnce(async (_cfg, spec) => { recordLocalFlag(spec.workspace, "flag{accepted}"); return empty; });
    result = (await f.daemon.runNextLoop("url-fixture"))!;
    expect(result).toMatchObject({ completed: true, status: "succeeded" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(f.db.getLoopEntry("url-fixture")?.loop_n).toBe(2);
  });

  it("recovers a task from the database after the controller restarts", async () => {
    const f = fixture();
    const run = vi.spyOn(runner, "runLocal").mockResolvedValue(empty);
    await f.daemon.runJob("url-fixture", "regular", { targetUrl: "http://127.0.0.1:9/fixture" });
    const record = f.db.listGoals()[0]!;
    record.nextRunAt = 0;
    expect(f.db.claimGoal(record, "fixture-update")).toBe(true); f.db.releaseGoal(record.workspace, "fixture-update");
    run.mockImplementationOnce(async (_cfg, spec) => { recordLocalFlag(spec.workspace, "flag{recovered}"); return empty; });
    const restarted = new Daemon(f.cfg, new Database(f.cfg.db_path), f.client);
    await restarted.resumeGoals();
    await vi.waitFor(() => expect(f.db.getGoal(record.workspace)?.state).toBe("succeeded"));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("never resurrects cancellation, but permits an explicit new start", async () => {
    const f = fixture();
    const run = vi.spyOn(runner, "runLocal").mockResolvedValue(empty);
    await f.daemon.runJob("url-fixture", "regular", { targetUrl: "http://127.0.0.1:9/fixture" });
    f.daemon.stopCode("url-fixture");
    const restarted = new Daemon(f.cfg, f.db, f.client);
    await restarted.resumeGoals(); expect(run).toHaveBeenCalledOnce();
    run.mockImplementationOnce(async (_cfg, spec) => { recordLocalFlag(spec.workspace, "flag{new-start}"); return empty; });
    const result = await restarted.runNextLoop("url-fixture", { resumeGoal: false });
    expect(result?.completed).toBe(true); expect(f.db.listGoals()[0]!.spec.revision).toBe(2);
  });

  it("does not reset an expired task deadline on automatic recovery", async () => {
    const f = fixture();
    vi.spyOn(runner, "runLocal").mockResolvedValue(empty);
    await f.daemon.runJob("url-fixture", "regular", { targetUrl: "http://127.0.0.1:9/fixture" });
    const record = f.db.listGoals()[0]!;
    record.spec.deadlineAt = Date.now() - 1;
    expect(f.db.claimGoal(record, "fixture-update")).toBe(true); f.db.releaseGoal(record.workspace, "fixture-update");
    const result = await f.daemon.runNextLoop("url-fixture");
    expect(result).toMatchObject({ completed: false, status: "paused_budget", goal_state: "paused_budget" });
    expect(runner.runLocal).toHaveBeenCalledOnce();
  });

  it("retries a blocked task only after the controller configuration changes", async () => {
    const f = fixture();
    const run = vi.spyOn(runner, "runLocal").mockResolvedValue({ ...empty, exitCode: 2, error: "fixture invalid credentials" });
    await f.daemon.runJob("url-fixture", "regular", { targetUrl: "http://127.0.0.1:9/fixture" });
    const record = f.db.listGoals()[0]!;
    record.nextRunAt = 0;
    expect(f.db.claimGoal(record, "fixture-update")).toBe(true); f.db.releaseGoal(record.workspace, "fixture-update");
    await f.daemon.resumeGoals(); expect(run).toHaveBeenCalledOnce();
    f.cfg.goal.smallModel = "new-config-fixture";
    run.mockImplementationOnce(async (_cfg, spec) => { recordLocalFlag(spec.workspace, "flag{recovered}"); return empty; });
    await f.daemon.resumeGoals();
    await vi.waitFor(() => expect(f.db.getGoal(record.workspace)?.state).toBe("succeeded"));
    expect(run).toHaveBeenCalledTimes(2);
  });
});
