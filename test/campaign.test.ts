import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Desk } from "../src/control/console/desk.js";
import { createProject, createTask } from "../src/control/console/workspace.js";
import { loadConfig } from "../src/shared/config.js";
import { Database } from "../src/shared/db.js";
import { pendingVerdict, type GoalRecord, type GoalState } from "../src/shared/goal.js";
import { taskGroups } from "../console/src/lib/task-groups.js";

vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));

const cleanup: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
  cleanup.splice(0).reverse().forEach(fn => fn());
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "heimdall-campaign-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "config.yaml"), "scheduler:\n  max_slots: 3\ndocker:\n  runtime: local\npaths:\n  data_dir: data\n");
  const cfg = loadConfig(join(root, "config.yaml"), root);
  const db = new Database(cfg.db_path);
  cleanup.push(() => db["db"].close());
  const desk = new Desk(cfg, db);
  const project = String(createProject(cfg, "Campaign test").id);
  const codes = Array.from({ length: 4 }, (_, n) => String(createTask(cfg, {
    projectId: project, name: `Task ${n}`, kind: "url", url: `http://example.invalid/${n}`,
  }).code));
  const finish = new Map<string, (result: Record<string, unknown>) => void>();
  const run = vi.spyOn(desk["daemon"], "runJob").mockImplementation(code =>
    new Promise(resolve => finish.set(code, resolve)));
  // Project overlays share the same mocked runner for these local scheduler tests.
  vi.spyOn(desk["daemon"], "withOverlay").mockReturnValue(desk["daemon"]);
  return { desk, db, project, codes, finish, run };
}

describe("campaign capacity recovery", () => {
  it("shows an escalated timeout as awaiting retry, then running, then verified complete", () => {
    const { desk, db, project, codes } = fixture();
    const code = codes[0]!;
    const ws = join(desk["projectWsRoot"](project), code);
    const job = db.createJob({ uniqueCode: code, attemptN: 1, image: "test", workspacePath: ws,
      jobDir: join(ws, "job"), status: "timeout", jobKind: "regular", projectId: project });
    db.updateJob(job, { terminal_reason: "timeout_escalated" });
    db.enqueueLoop(code, { sourceJobId: job, reason: "timeout" });
    desk.campaigns.set(project, { project_id: project, status: "running", pending: [codes[1]!],
      running: [], finished: [code], codes, kinds: {}, workspace_by_code: {}, url_by_code: {} });
    expect(desk.campaignView(project)).toMatchObject({ done: [], finished: 0, retry_wait: [code],
      task_states: { [code]: { state: "retry_wait", reason: "timeout" } } });
    const next = db.createJob({ uniqueCode: code, attemptN: 2, image: "test", workspacePath: ws,
      jobDir: join(ws, "loop"), status: "running", jobKind: "loop", projectId: project });
    db.updateLoop(code, { status: "running", loop_n: 1, loop_job_id: next });
    expect(desk.campaignView(project)).toMatchObject({ running: [code], retry_wait: [], done: [], finished: 0,
      task_states: { [code]: { job_kind: "loop", loop_n: 1 } } });
    db.updateJob(next, { status: "succeeded" });
    db.updateLoop(code, { status: "done" });
    expect(desk.campaignView(project)).toMatchObject({ running: [], retry_wait: [], done: [code], finished: 1 });
    const home = [{ id: project }];
    desk.attachHomeProgress(home);
    expect(home[0]).toMatchObject({ progress: { done: 1, live: 0 } });
    // Persisted job state still renders correctly after losing in-memory campaign history.
    desk.campaigns.clear();
    expect(desk.campaignView(project)).toMatchObject({ done: [code], finished: 1 });
  });

  it.each(["retry_wait", "cancelled", "blocked", "paused_budget", "succeeded"] as GoalState[])(
    "uses the current %s goal instead of stale campaign completion or loop rows", state => {
      const { desk, db, project, codes } = fixture();
      const code = codes[0]!;
      const ws = join(desk["projectWsRoot"](project), code);
      const job = db.createJob({ uniqueCode: code, attemptN: 1, image: "test", workspacePath: ws,
        jobDir: join(ws, "job"), status: "timeout", projectId: project });
      db.enqueueLoop(code, { sourceJobId: job });
      const spec: GoalRecord["spec"] = { taskId: "task", revision: 1, instanceEpoch: "instance", code,
        objective: "Test acceptance", acceptance: { kind: "platform_flags" }, persistence: "until_satisfied",
        createdAt: Date.now(), deadlineAt: null };
      const record: GoalRecord = { spec, state, verdict: { ...pendingVerdict(spec),
        state: state === "succeeded" ? "satisfied" : "unsatisfied" }, workspace: ws,
        jobId: job, runOptions: {}, nextRunAt: Date.now(), reason: state };
      db.claimGoal(record, "test");
      db.releaseGoal(ws, "test");
      const group = state === "succeeded" ? "done" : state === "retry_wait" ? "retry_wait" : "unfinished";
      expect(desk.campaignView(project)).toMatchObject({ [group]: [code], finished: state === "succeeded" ? 1 : 0 });
    },
  );

  it("does not show a different project's loop as this project's retry", () => {
    const { desk, db, project, codes } = fixture();
    const code = codes[0]!;
    db.createJob({ uniqueCode: code, attemptN: 1, image: "test", workspacePath: "/tmp/own",
      jobDir: "/tmp/own-job", status: "timeout", projectId: project });
    const other = db.createJob({ uniqueCode: code, attemptN: 1, image: "test", workspacePath: "/tmp/other",
      jobDir: "/tmp/other-job", status: "timeout", projectId: "other-project" });
    db.enqueueLoop(code, { sourceJobId: other });
    expect(desk.campaignView(project)).toMatchObject({ retry_wait: [], done: [], unfinished: [code] });
  });

  it.each(["disabled", "exhausted"])("does not promise an automatic retry when Loop is %s", mode => {
    const { desk, db, project, codes } = fixture();
    const code = codes[0]!;
    const job = db.createJob({ uniqueCode: code, attemptN: 1, image: "test", workspacePath: "/tmp/bounded",
      jobDir: "/tmp/bounded-job", status: "timeout", projectId: project });
    desk.cfg.loop_enabled = mode !== "disabled";
    desk.cfg.loop_max_per_challenge = 2;
    db.enqueueLoop(code, { sourceJobId: job });
    if (mode === "exhausted") db.updateLoop(code, { loop_n: 2 });
    expect(desk.campaignView(project)).toMatchObject({ retry_wait: [], done: [], unfinished: [code] });
  });

  it("groups URL tasks by state and never duplicates a task in completed and running", () => {
    const tasks = [{ id: "a", code: "a-05" }, { id: "url", code: "url-test", kind: "url" }];
    const groups = taskGroups(tasks, { running: ["a-05"], retry_wait: ["url-test"], done: ["a-05", "url-test"] });
    expect(groups).toMatchObject({ live: [tasks[0]], retry: [tasks[1]], done: [], urls: [], rest: [] });
  });

  it.each([["regular", 75], ["loop", 720]] as const)("uses the configured %s observer warmup in both desk APIs", (kind, warmup) => {
    const { desk, db, project } = fixture();
    desk.cfg.observer_warmup_sec = 75;
    desk.cfg.observer_loop_warmup_sec = 720;
    const ws = join(desk["projectWsRoot"](project), "b-02");
    mkdirSync(join(ws, ".heimdall", "traffic"), { recursive: true });
    const job = db.createJob({ uniqueCode: "b-02", attemptN: 1, image: "test", workspacePath: ws,
      jobDir: join(ws, "job"), status: "running", jobKind: kind, projectId: project });
    db.updateJob(job, { started_at: Date.now() / 1000 - 30 });
    expect(desk.progress("b-02", project)).toMatchObject({ observer_warmup_sec: warmup, observer_wait_sec: warmup - 30 });
    expect(desk.graph("b-02", project)).toMatchObject({ warming_up: true, warmup_sec: warmup });
  });

  it.each(["deferred_capacity", "deferred_start", "deferred_addr"])(
    "retains %s tasks and refills three slots after completion", async status => {
      const { desk, project, codes, finish, run } = fixture();
      await desk.startCampaign(project);
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(3);
      finish.get(codes[0]!)!({ status });
      await vi.advanceTimersByTimeAsync(250);
      // The fourth task uses the released slot while the deferred one cools down.
      expect(run).toHaveBeenCalledTimes(4);
      expect(desk.campaignView(project).pending).toEqual([codes[0]]);
      expect(desk.campaignView(project).done).not.toContain(codes[0]);
      await vi.advanceTimersByTimeAsync(2100);
      expect(run).toHaveBeenCalledTimes(4);
      finish.get(codes[1]!)!({ status: "succeeded", completed: true });
      await vi.advanceTimersByTimeAsync(250);
      expect(run).toHaveBeenCalledTimes(5);
      expect(run.mock.calls[4]?.[0]).toBe(codes[0]);
      expect(desk.campaignView(project).running).toHaveLength(3);
      expect(desk.campaignView(project).pending).toEqual([]);
      for (const code of [codes[0]!, codes[2]!, codes[3]!]) finish.get(code)!({ status: "succeeded", completed: true });
      await vi.advanceTimersByTimeAsync(250);
      expect(desk.campaignView(project).status).toBe("done");
      expect(desk.campaignView(project).finished).toBe(4);
    },
  );

  it("counts jobs recovered outside the desk and fills their released slot", async () => {
    const { desk, db, project, run } = fixture();
    const job = db.createJob({ uniqueCode: "c-03", attemptN: 1, status: "running",
      image: "test", workspacePath: "/tmp/recovered-c-03", jobDir: "/tmp/recovered-job" });
    await desk.startCampaign(project);
    await vi.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledTimes(2);
    db.updateJob(job, { status: "succeeded" });
    await vi.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledTimes(3);
    expect(desk.campaignView(project).running).toHaveLength(3);
    desk.stopCampaign(project);
    await vi.advanceTimersByTimeAsync(250);
  });
});
