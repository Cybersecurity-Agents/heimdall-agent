import { recordLocalProcess } from "../src/control/local-process.js";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Desk } from "../src/control/console/desk.js";
import { createProject, createTask, deleteProject, getProject, projectWorkspacesDir } from "../src/control/console/workspace.js";
import { GoalController } from "../src/control/goal-controller.js";
import { loadConfig } from "../src/shared/config.js";
import { Database } from "../src/shared/db.js";
import { pendingVerdict, type GoalRecord } from "../src/shared/goal.js";
import { challengeFromDict, emptySubmit } from "../src/platforms/types.js";
import * as runner from "../src/control/runner.js";

vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));
const cleanup: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); cleanup.splice(0).reverse().forEach(fn => fn()); });
function fixture() {
  const dir = mkdtempSync("/tmp/heimdall-project-delete-");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "config.yaml");
  writeFileSync(path, JSON.stringify({ paths: { data_dir: dir, tools_env: join(dir, "absent") } }));
  const cfg = loadConfig(path, process.cwd());
  Object.assign(cfg, { agent_runtime: "local", observe_enabled: false, vpn_enabled: false });
  const db = new Database(cfg.db_path);
  cleanup.push(() => db["db"].close());
  const desk = new Desk(cfg, db);
  const old = String(createProject(cfg, "Old").id), current = String(createProject(cfg, "Current").id);
  const daemon = desk["daemon"];
  function goal(pid: string, code: string, withJob = true) {
    const ws = join(projectWorkspacesDir(cfg, pid), code);
    mkdirSync(ws, { recursive: true });
    const job = withJob ? db.createJob({ uniqueCode: code, attemptN: 1, image: "fixture", workspacePath: ws,
      jobDir: join(cfg.jobs_dir, `${pid}-${code}`), status: "running", projectId: pid }) : null;
    const spec: GoalRecord["spec"] = { taskId: `${pid}-${code}`, revision: 1, instanceEpoch: "fixture", code,
      objective: "Fixture", acceptance: { kind: "platform_flags" }, persistence: "until_satisfied", createdAt: Date.now(), deadlineAt: null };
    const record: GoalRecord = { spec, state: "retry_wait", verdict: pendingVerdict(spec), workspace: ws, jobId: job,
      runOptions: { projectId: pid }, nextRunAt: Date.now() + 100000, reason: "timeout" };
    expect(db.claimGoal(record, "fixture")).toBe(true); db.releaseGoal(ws, "fixture");
    db.putGoalReceipt(spec, "flag{receipt}", { correct: true });
    return record;
  }
  return { cfg, db, desk, daemon, old, current, goal };
}

describe("project deletion and recovery", () => {
  it("resumes the current project queue without resetting attempts or reopening paused goals", async () => {
    const f = fixture();
    for (const code of ["url-retry", "url-paused", "url-fresh"]) createTask(f.cfg, {
      projectId: f.current, name: code, code, kind: "url", url: `http://example.invalid/${code}`,
    });
    const retry = f.goal(f.current, "url-retry"), paused = f.goal(f.current, "url-paused");
    f.db.updateJob(retry.jobId!, { status: "timeout" });
    f.db.updateJob(paused.jobId!, { status: "paused_budget" });
    paused.state = "paused_budget";
    expect(f.db.claimGoal(paused, "paused")).toBe(true); f.db.releaseGoal(paused.workspace, "paused");
    f.db.enqueueLoop("url-retry", { sourceJobId: retry.jobId! });
    f.db.updateLoop("url-retry", { loop_n: 1 });
    const run = vi.spyOn(f.daemon, "runJob").mockImplementation(() => new Promise(() => {}));
    vi.spyOn(f.daemon, "withOverlay").mockReturnValue(f.daemon);
    const result = await f.desk.startCampaign(f.current, { resume: true });
    expect(result).toMatchObject({ ok: true });
    expect(f.desk.campaignView(f.current).codes).not.toContain("url-paused");
    expect(f.db.getLoopEntry("url-retry")?.loop_n).toBe(1);
    expect(f.db.getGoal(retry.workspace)?.spec).toEqual(retry.spec);
    expect(f.db.goalReceipts(retry.spec)).toHaveLength(1);
    expect(run).toHaveBeenCalledWith("url-fresh", "regular", expect.objectContaining({ resumeGoal: true }));
  });

  it("purges goals without jobs, receipts and retries; preserves another project's same-code task", () => {
    const f = fixture();
    const orphan = f.goal(f.old, "orphan", false), old = f.goal(f.old, "a-05"), current = f.goal(f.current, "a-05");
    f.db.enqueueLoop("orphan", { projectId: f.old });
    const oldJob = f.db.getJob(old.jobId!)!;
    recordLocalProcess(String(oldJob.job_dir), { jobId: old.jobId!, identity: null, state: "exited", exit: 0, error: null, timedOut: false });
    f.db.updateJob(old.jobId!, { container_id: `local-${old.jobId}` });
    f.db.enqueueLoop("a-05", { sourceJobId: current.jobId! });
    const stop = vi.spyOn(runner, "stopRunningJob").mockReturnValue(1);
    expect(f.desk.purgeProject(f.old)).toMatchObject({ ok: true, goals: 2, receipts: 2, jobs: 1, loops: 1 });
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({ jobId: old.jobId }));
    expect(stop).not.toHaveBeenCalledWith(expect.objectContaining({ jobId: current.jobId }));
    expect(f.db.getGoal(orphan.workspace)).toBeNull();
    expect(f.db.goalReceipts(old.spec)).toEqual([]);
    expect(f.db.getGoal(current.workspace)).not.toBeNull();
    expect(f.db.getLoopEntry("a-05")?.source_job_id).toBe(current.jobId);
    expect(f.db.countActiveJobs()).toBe(1);
    expect(getProject(f.cfg, f.old)).toBeNull();
    expect(existsSync(orphan.workspace)).toBe(false);
    // A late callback or another process cannot resurrect the removed project.
    expect(f.db.claimGoal(old, "late")).toBe(false);
    expect(f.db.claimGoal({ ...orphan, runOptions: {} }, "legacy-late")).toBe(false);
    f.db.enqueueLoop("a-05", { sourceJobId: old.jobId! });
    expect(f.db.getLoopEntry("a-05")?.source_job_id).toBe(current.jobId);
    expect(() => f.db.createJob({ uniqueCode: "a-05", attemptN: 2, image: "fixture", workspacePath: old.workspace,
      jobDir: "/tmp/late-job", projectId: f.old })).toThrow("project_deleted");
  });

  it("preserves missing-ledger project records without an explicit deletion tombstone", async () => {
    const f = fixture();
    const old = f.goal(f.old, "f1-04"), legacy = f.goal(f.old, "a-05", false), current = f.goal(f.current, "a-05");
    legacy.runOptions = {};
    expect(f.db.claimGoal(legacy, "legacy")).toBe(true); f.db.releaseGoal(legacy.workspace, "legacy");
    f.db.enqueueLoop("f1-04", { sourceJobId: old.jobId! });
    deleteProject(f.cfg, f.old); // Simulate the previous version's incomplete deletion.
    const restarted = new Desk(f.cfg, f.db);
    const resume = vi.spyOn(restarted["daemon"], "runNextLoop");
    await restarted["daemon"].resumeGoals();
    expect(resume).not.toHaveBeenCalled();
    expect(f.db.listJobsForProject(f.old)).toHaveLength(1);
    expect(f.db.getLoopEntry("f1-04")).not.toBeNull();
    expect(f.db.listGoals()).toEqual(expect.arrayContaining([old, legacy, current]));
    expect(f.db.countActiveJobs()).toBe(2);
    expect(f.db.projectDeleted(f.old)).toBe(false);
  });

  it("does not purge projects when the project ledger cannot be read", async () => {
    const f = fixture(); const old = f.goal(f.old, "a-05");
    writeFileSync(join(f.cfg.data_dir, "console", "ledger.json"), "broken JSON");
    const resume = vi.spyOn(f.daemon, "runNextLoop");
    await f.daemon.resumeGoals();
    expect(f.db.getGoal(old.workspace)).not.toBeNull();
    expect(f.db.projectDeleted(f.old)).toBe(false);
    expect(resume).not.toHaveBeenCalled();
  });

  it("prevents an in-flight lab start from recreating a deleted project", async () => {
    const f = fixture();
    f.db.upsertChallenges([challengeFromDict({ unique_code: "a-05", flag_count: 1 })]);
    let finish!: (value: Record<string, unknown>) => void;
    vi.spyOn(f.daemon.client, "start").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    vi.spyOn(f.daemon.client, "close").mockResolvedValue({});
    vi.spyOn(f.daemon.client, "listChallenges").mockResolvedValue([]);
    const run = vi.spyOn(runner, "runLocal");
    const root = projectWorkspacesDir(f.cfg, f.old);
    const sched = f.daemon.withOverlay({ workspace_root: root, workspaces_dir: root });
    const pending = sched.runJob("a-05", "regular", { projectId: f.old });
    expect(finish).toBeTypeOf("function");
    expect(f.desk.purgeProject(f.old).ok).toBe(true);
    finish({ container_addr: ["127.0.0.1:9"] });
    expect(await pending).toMatchObject({ status: "cancelled", terminal_reason: "project_deleted" });
    expect(run).not.toHaveBeenCalled();
    expect(f.db.listJobsForProject(f.old)).toEqual([]);
    expect(f.db.listGoals()).toEqual([]);
    expect(existsSync(root)).toBe(false);
  });

  it("drops a late flag submission and stops the controller after its goal is removed", async () => {
    const f = fixture(); const record = f.goal(f.old, "a-05");
    const job = f.db.getJob(record.jobId!)!;
    recordLocalProcess(String(job.job_dir), { jobId: record.jobId!, identity: null, state: "exited", exit: 0, error: null, timedOut: false });
    f.db.updateJob(record.jobId!, { container_id: `local-${record.jobId}` });
    let finish!: (value: ReturnType<typeof emptySubmit>) => void;
    vi.spyOn(f.daemon.client, "submit").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const stop = vi.fn();
    const controller = new GoalController(f.db, f.daemon.client, f.cfg.goal, record, stop);
    expect(controller.start()).toBe(true);
    const submission = controller.submit("flag{late}");
    const rejected = expect(submission).rejects.toThrow("Task stopped during submission");
    f.desk.purgeProject(f.old);
    finish(emptySubmit({ correct: true }));
    await rejected;
    await vi.advanceTimersByTimeAsync(1000);
    expect(stop).toHaveBeenCalledOnce();
    expect(f.db.goalReceipts(record.spec)).toEqual([]);
    expect(f.db.listFlags("a-05")).toEqual([]);
    expect(existsSync(record.workspace)).toBe(false);
    await controller.close();
  });
});
