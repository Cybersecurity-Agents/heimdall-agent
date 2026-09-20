import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "../src/shared/db.js";
import { GoalController } from "../src/control/goal-controller.js";
import { atomicJson, goalDir, goalRequest, parseAcceptance, parseGoalConfig, pendingVerdict, type Acceptance, type GoalRecord } from "../src/shared/goal.js";
import { challengeFromDict, emptySubmit, type Bench, type Challenge } from "../src/platforms/types.js";
import { main as goalCli } from "../src/tools/goal-cli.js";
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));

const dirs: string[] = [], controllers: GoalController[] = [];
afterEach(async () => { for (const c of controllers.splice(0)) await c.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fixture(acceptance: Acceptance = { kind: "platform_flags" }, flagCount = 2) {
  const dir = mkdtempSync("/tmp/heimdall-goal-controller-"); dirs.push(dir);
  const db = new Database(join(dir, "controller.sqlite"));
  const challenge: Challenge = { unique_code: "task-1", description: null, difficulty: null, level: 1, total_score: 100,
    flag_count: flagCount, correct_flag_count: 0, is_completed: false, container_status: "available", container_addr: ["127.0.0.1:9"] };
  const client: Bench = { listChallenges: vi.fn(async () => [challenge]), start: vi.fn(), close: vi.fn(),
    submit: vi.fn(async (_code, flag) => emptySubmit({ correct: flag !== "flag{wrong}" })) };
  const config = parseGoalConfig({});
  const spec = { taskId: "task", revision: 1, instanceEpoch: "instance-1", code: "task-1", objective: "Fixture",
    acceptance, persistence: "until_satisfied" as const, createdAt: Date.now(), deadlineAt: null };
  const record: GoalRecord = { spec, state: "running", verdict: pendingVerdict(spec), workspace: dir,
    jobId: "job-1", runOptions: { flagCount }, nextRunAt: 0, reason: "" };
  writeFileSync(join(dir, "input.json"), JSON.stringify({ job_id: record.jobId, unique_code: spec.code, goal_managed: true }));
  const stop = vi.fn();
  const controller = new GoalController(db, client, config, record, stop); controllers.push(controller);
  expect(controller.start()).toBe(true);
  return { dir, db, record, controller, client, challenge, config, stop };
}

describe("authoritative acceptance", () => {
  it("keeps partial flags open and stops once all unique submissions are accepted", async () => {
    const f = fixture();
    await f.controller.submit("flag{first}");
    expect(f.record.verdict.state).toBe("unsatisfied"); expect(f.stop).not.toHaveBeenCalled();
    await f.controller.submit("flag{first}");
    expect(f.client.submit).toHaveBeenCalledTimes(1);
    await f.controller.submit("flag{second}");
    expect(f.db.getGoal(f.dir)?.state).toBe("succeeded"); expect(f.stop).toHaveBeenCalledOnce();
    await f.controller.evaluate(); expect(f.stop).toHaveBeenCalledOnce();
  });

  it("does not accept solver-authored success in any workspace projection", async () => {
    const f = fixture();
    atomicJson(join(f.dir, "input.json"), { job_id: "job-1", goal_managed: true, flag_count: 1, is_completed: true });
    atomicJson(join(goalDir(f.dir), "status.json"), { state: "succeeded", verdict: { state: "satisfied" } });
    atomicJson(join(f.dir, "flags.json"), [{ flag: "flag{wrong}", correct: true, via: "heimdall-submit" }]);
    await f.controller.tick();
    expect(f.record.verdict.state).toBe("unsatisfied"); expect(f.record.verdict.count).toBe(0);
    expect(f.stop).not.toHaveBeenCalled();
  });

  it("does not treat an unproven duplicate as correct", async () => {
    const f = fixture();
    vi.mocked(f.client.submit).mockResolvedValue(emptySubmit({ duplicate: true, correct: false }));
    await f.controller.submit("flag{duplicate}");
    expect(f.record.verdict.count).toBe(0); expect(f.stop).not.toHaveBeenCalled();
    f.challenge.is_completed = true;
    await f.controller.evaluate(true);
    expect(f.record.verdict.state).toBe("satisfied");
  });

  it("does not count two accepted variants of the same platform flag twice", async () => {
    const f = fixture();
    vi.mocked(f.client.submit).mockResolvedValue(emptySubmit({ correct: true, matched_flag_index: 1 }));
    await f.controller.submit("flag{variant-a}"); await f.controller.submit("flag{variant-b}");
    expect(f.record.verdict.count).toBe(1); expect(f.record.verdict.state).toBe("unsatisfied");
    expect(challengeFromDict({ unique_code: "fixture", is_completed: "false" }).is_completed).toBe(false);
  });

  it("waits for authoritative completion when totals are unknown, including network outages", async () => {
    const f = fixture({ kind: "platform_flags" }, 0);
    await f.controller.submit("flag{first}");
    expect(f.record.verdict.state).toBe("unsatisfied");
    vi.mocked(f.client.listChallenges).mockRejectedValueOnce(new Error("fixture network down"));
    await f.controller.evaluate(true); expect(f.record.verdict.state).toBe("unknown");
    f.challenge.is_completed = true;
    await f.controller.evaluate(true); expect(f.record.verdict.state).toBe("satisfied");
  });

  it("serializes simultaneous submit clients and keeps only one upstream submission", async () => {
    const f = fixture({ kind: "platform_flags" }, 3);
    const [a, b] = await Promise.all([goalRequest(f.dir, "submit", "flag{one}"), goalRequest(f.dir, "submit", "flag{one}")]);
    expect(a.correct).toBe(true); expect(b.correct).toBe(true);
    expect(f.client.submit).toHaveBeenCalledTimes(1);
  });

  it("returns unknown from the CLI during an outage and refreshes on request", async () => {
    const f = fixture();
    vi.stubEnv("HEIMDALL_WORKSPACE", f.dir);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(f.client.listChallenges).mockRejectedValue(new Error("fixture network down"));
    expect(await goalCli(["check", "--json"])).toBe(2);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0])).state).toBe("unknown");
    vi.mocked(f.client.listChallenges).mockResolvedValue([f.challenge]);
    f.challenge.is_completed = true;
    expect(await goalCli(["status", "--refresh", "--json"])).toBe(0);
    expect(f.db.getGoal(f.dir)?.state).toBe("succeeded");
  });

  it("separates local collection from local validation and platform correctness", async () => {
    const f = fixture({ kind: "local_flags", requiredCount: 1 });
    await f.controller.submit("flag{local}");
    expect(f.record.verdict).toMatchObject({ state: "satisfied", assurance: "recorded" });
    expect(f.client.submit).not.toHaveBeenCalled(); expect(f.client.listChallenges).not.toHaveBeenCalled();
    expect(f.db.listFlags("task-1")[0]?.submit_correct).toBeNull();
  });

  it("runs registered validators with candidate data on stdin", async () => {
    const f = fixture({ kind: "local_flags", requiredCount: 1, validatorId: "flag" });
    f.config.checks.flag = { command: process.execPath, args: ["-e", "let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>process.exit(JSON.parse(s).flag==='flag{valid}'?0:1))"], timeoutSec: 2 };
    await f.controller.submit("flag{wrong}"); expect(f.record.verdict.state).toBe("unsatisfied");
    await f.controller.submit("flag{valid}"); expect(f.record.verdict).toMatchObject({ state: "satisfied", assurance: "locally_verified" });
  });

  it("re-executes general acceptance checks instead of trusting cached success", async () => {
    const f = fixture({ kind: "checks", checkIds: ["artifact"] });
    f.config.checks.artifact = { command: process.execPath, args: ["-e", "process.exit(require('fs').existsSync('artifact')?0:1)"], timeoutSec: 2 };
    await f.controller.evaluate(); expect(f.record.verdict.state).toBe("unsatisfied");
    writeFileSync(join(f.dir, "artifact"), "fixture");
    await f.controller.evaluate(); expect(f.record.verdict.state).toBe("satisfied");
    rmSync(join(f.dir, "artifact"));
    await f.controller.evaluate(); expect(f.record.verdict.state).toBe("unsatisfied");
  });

  it("does not count receipts from a prior instance or goal revision", async () => {
    const f = fixture();
    f.db.putGoalReceipt({ ...f.record.spec, instanceEpoch: "old" }, "flag{old}", { correct: true });
    f.db.putGoalReceipt({ ...f.record.spec, revision: 0 }, "flag{old-revision}", { correct: true });
    await f.controller.evaluate(); expect(f.record.verdict.count).toBe(0);
  });

  it("allows only one controller to own a task and preserves cancellation", async () => {
    const f = fixture();
    const second = new GoalController(f.db, f.client, f.config, f.record, vi.fn());
    expect(second.start()).toBe(false);
    f.db.cancelGoals("task-1"); f.challenge.is_completed = true;
    await f.controller.evaluate(true);
    expect(f.db.getGoal(f.dir)?.state).toBe("cancelled"); expect(f.stop).toHaveBeenCalledOnce();
  });

  it("validates acceptance contracts before execution", () => {
    expect(() => parseAcceptance({ kind: "checks", checkIds: [] })).toThrow();
    expect(() => parseAcceptance({ kind: "local_flags", requiredCount: -1 })).toThrow();
    expect(() => parseGoalConfig({ acceptance_by_code: { a: { kind: "checks", checkIds: ["missing"] } } })).toThrow();
  });
});
