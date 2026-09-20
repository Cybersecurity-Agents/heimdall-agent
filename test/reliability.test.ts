import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Database } from "../src/shared/db.js";
import { loadConfig } from "../src/shared/config.js";
import { taskKey } from "../src/shared/task-ref.js";
import { readLedger, writeLedger, ledgerPath, LedgerError } from "../src/shared/project-ledger.js";
import * as workspace from "../src/control/console/workspace.js";
import { Desk } from "../src/control/console/desk.js";
import { Daemon } from "../src/control/daemon.js";
import { processIdentity, recordLocalProcess } from "../src/control/local-process.js";
import { harvestJob } from "../src/control/console/progress.js";
import * as runner from "../src/control/runner.js";
import { GoalController } from "../src/control/goal-controller.js";
import { challengeFromDict } from "../src/platforms/types.js";
vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));
const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(f => f()); });
function fixture() {
  const dir = mkdtempSync("/tmp/heimdall-reliability-"); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "fixture.yaml");
  writeFileSync(path, JSON.stringify({ paths: { data_dir: dir, tools_env: join(dir, "absent") } }));
  const cfg = loadConfig(path, process.cwd());
  Object.assign(cfg, { max_slots: 1, agent_runtime: "local", observe_enabled: false, vpn_enabled: false, loop_enabled: false, resources_enabled: false });
  const db = new Database(cfg.db_path); cleanup.push(() => db["db"].close());
  const desk = new Desk(cfg, db), daemon = desk["daemon"];
  vi.spyOn(daemon.client, "close").mockResolvedValue({});
  vi.spyOn(daemon.client, "listChallenges").mockResolvedValue([]);
  const project = (name: string) => String(workspace.createProject(cfg, name).id);
  return { dir, cfg, db, desk, daemon, project };
}
function reservation(f: ReturnType<typeof fixture>, code: string, projectId: string | null = null, db = f.db) {
  return db.reserveJob({ uniqueCode: code, attemptN: 1, image: "fixture", workspacePath: workspace.challengeWorkspace(f.cfg, code, projectId), jobDir: join(f.dir, code), projectId },
    { maxSlots: f.cfg.max_slots, runtime: "local", owner: JSON.stringify(processIdentity(process.pid)), keys: [], challengeType: "web", platform: false, labTypes: [], labMax: 1 });
}
const result = { containerId: "", exitCode: 2, timedOut: false, logPath: "", error: "fixture backend unavailable" };

describe("project metadata preservation", () => {
  it("never initializes on read; corruption, absence and invalid structure preserve project jobs", async () => {
    const f = fixture(); expect(workspace.listProjects(f.cfg)).toEqual([]); expect(existsSync(ledgerPath(f.cfg))).toBe(false);
    const pid = f.project("saved"); const job = reservation(f, "url-safe", pid); expect(job).toHaveProperty("jobId");
    const path = ledgerPath(f.cfg), good = readFileSync(path, "utf8");
    for (const bad of ["broken JSON", JSON.stringify({ projects: [], tasks: [{ id: "lost", project_id: pid }] })]) {
      writeFileSync(path, bad); expect(() => workspace.listProjects(f.cfg)).toThrow(LedgerError);
      expect(() => workspace.createProject(f.cfg, "must not replace")).toThrow(LedgerError);
      await f.daemon.resumeGoals(); expect(readFileSync(path, "utf8")).toBe(bad);
      expect(f.db.listJobsForProject(pid)).toHaveLength(1); expect(f.db.projectDeleted(pid)).toBe(false);
    }
    rmSync(path); expect(() => workspace.listProjects(f.cfg)).toThrow(LedgerError);
    writeFileSync(path, good); expect(workspace.listProjects(f.cfg)).toHaveLength(1);
  });
  it("backs up valid writes and rejects lost updates from another desk", () => {
    const f = fixture(); f.project("first"); const before = readFileSync(ledgerPath(f.cfg), "utf8");
    const stale = readLedger(f.cfg); f.project("second");
    expect(readFileSync(`${ledgerPath(f.cfg)}.bak`, "utf8")).toBe(before);
    stale.projects[0]!.name = "stale"; expect(() => writeLedger(f.cfg, stale)).toThrow(LedgerError);
    expect(workspace.listProjects(f.cfg).map(p => p.name).sort()).toEqual(["first", "second"]);
  });
});

describe("project task boundaries", () => {
  it("scopes stops, flags, retries and history while rejecting ambiguous legacy stops", () => {
    const f = fixture(); f.cfg.max_slots = 3; const a = f.project("a"), b = f.project("b"), code = "url-shared";
    const ja = reservation(f, code, a), jb = reservation(f, code, b); if (!("jobId" in ja && "jobId" in jb)) throw Error("fixture");
    for (const [pid, jobId] of [[a, ja.jobId], [b, jb.jobId]]) {
      f.db.enqueueLoop(code, { projectId: pid, sourceJobId: jobId });
      f.db.addFlag({ projectId: pid, uniqueCode: code, flagValue: `flag{${pid}}` });
    }
    expect(f.desk.stop({ code }).ok).toBe(false);
    expect(f.desk.stop({ code, project_id: a }).ok).toBe(true);
    expect(f.db.getJob(ja.jobId)?.status).toBe("stopping"); expect(f.db.getJob(jb.jobId)?.status).toBe("starting");
    expect(f.db.getLoopEntry(code, a)?.status).toBe("blocked"); expect(f.db.getLoopEntry(code, b)?.status).toBe("queued");
    expect(f.desk.flags(code, a).map(r => r.flag_value)).toEqual([`flag{${a}}`]); expect(f.desk.flags(code, null)).toEqual([]);
    expect(f.db.listJobsForCode(code, null)).toEqual([]); expect(f.db.listJobsForCode(code, b)).toHaveLength(1);
  });
  it("migrates legacy queue ownership, preserves ambiguous rows and remains restartable", () => {
    const f = fixture(); f.cfg.max_slots = 4; const a = f.project("a"), b = f.project("b");
    reservation(f, "url-shared", a); reservation(f, "url-shared", b); const own = reservation(f, "url-owned", a);
    if (!("jobId" in own)) throw Error("fixture");
    const sql = f.db["db"];
    sql.exec("DROP TABLE loop_queue; ALTER TABLE loop_queue_legacy RENAME TO loop_queue; DROP TABLE flags; ALTER TABLE flags_legacy RENAME TO flags;");
    sql.prepare("INSERT INTO loop_queue(unique_code,status,loop_n) VALUES(?,'queued',3)").run("url-shared");
    sql.prepare("INSERT INTO loop_queue(unique_code,status,source_job_id,loop_n) VALUES(?,'queued',?,2)").run("url-owned", own.jobId);
    const reopened = new Database(f.cfg.db_path); cleanup.push(() => reopened["db"].close());
    expect(reopened.getLoopEntry("url-shared")).toMatchObject({ project_id: "@legacy", status: "blocked", loop_n: 3 });
    expect(reopened.getLoopEntry("url-owned", a)).toMatchObject({ status: "queued", loop_n: 2, source_job_id: own.jobId });
    expect(reopened.getLoopEntry("url-owned", b)).toBeNull();
    expect(reopened["db"].prepare("SELECT count(*) AS n FROM loop_queue_legacy").get()).toEqual({ n: 2 });
    const again = new Database(f.cfg.db_path); cleanup.push(() => again["db"].close());
    expect(again.listLoopQueue()).toEqual(reopened.listLoopQueue());
  });
});

describe("atomic execution admission and lifecycle", () => {
  it("enforces one slot across independent connections, including stopping jobs", () => {
    const f = fixture(); const other = new Database(f.cfg.db_path); cleanup.push(() => other["db"].close());
    const first = reservation(f, "url-first"); if (!("jobId" in first)) throw Error("fixture");
    expect(reservation(f, "url-second", null, other)).toEqual({ status: "deferred_capacity" });
    f.db.updateJob(first.jobId, { status: "stopping" }); expect(reservation(f, "url-third", null, other)).toEqual({ status: "deferred_capacity" });
    f.db.updateJob(first.jobId, { status: "cancelled" }); expect(reservation(f, "url-fourth", null, other)).toHaveProperty("jobId");
  });
  it("serializes admission from separate control processes", async () => {
    const f = fixture();
    const source = `import { Database } from ${JSON.stringify(join(process.cwd(), "src/shared/db.ts"))};
      const db = new Database(${JSON.stringify(f.cfg.db_path)});
      const result = db.reserveJob({uniqueCode:'url-'+process.pid,attemptN:1,image:'fixture',workspacePath:'/tmp/fixture-'+process.pid,jobDir:'/tmp/fixture-'+process.pid},
        {maxSlots:1,runtime:'local',owner:'{}',keys:[],challengeType:'web',platform:false,labTypes:[],labMax:1});
      process.stdout.write(JSON.stringify(result)); db.db.close();`;
    const results = await Promise.all(Array.from({ length: 4 }, () => new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source]);
      let out = "", err = ""; child.stdout.on("data", data => out += data); child.stderr.on("data", data => err += data);
      child.on("error", reject); child.on("close", code => code ? reject(Error(err)) : resolve(JSON.parse(out)));
    })));
    expect(results.filter(r => r.jobId)).toHaveLength(1); expect(f.db.countActiveJobs()).toBe(1);
  });
  it("holds a direct target host even when its URL omits the default port", async () => {
    const f = fixture(); Object.assign(f.cfg, { max_slots: 2, resources_enabled: true, addr_mutex: true, lab_exclusive_types: [] });
    let finish!: () => void;
    const run = vi.spyOn(runner, "runLocal").mockImplementation(() => new Promise(resolve => finish = () => resolve(result)));
    const pending = f.daemon.runJob("url-one", "regular", { targetUrl: "http://example.invalid/one", challengeType: "web" });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(await f.daemon.runJob("url-two", "regular", { targetUrl: "http://example.invalid/two", challengeType: "web" })).toMatchObject({ status: "deferred_addr" });
    expect(run).toHaveBeenCalledOnce(); finish(); await pending;
  });
  it("caps rapid manual starts and exposes capacity refusal", async () => {
    const f = fixture(); let finish!: () => void;
    vi.spyOn(runner, "runLocal").mockImplementation(() => new Promise(resolve => finish = () => resolve(result)));
    const first = f.desk.start({ url: "http://127.0.0.1:9/one", follow_loop: false });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(f.desk.start({ url: "http://127.0.0.1:9/two" })).toMatchObject({ ok: false, status: "deferred_capacity" });
    expect(f.db.countActiveJobs()).toBe(1); finish();
    await vi.waitFor(() => expect(f.desk.runs.get(taskKey(String(first.code)))?.status).toBe("done"));
    expect(f.db.countActiveJobs()).toBe(0);
  });
  it.each(["workspace", "platform", "controller", "runner"])("finalizes %s startup failure without phantom slots or consuming attempts", async phase => {
    const f = fixture();
    const run = vi.spyOn(runner, "runLocal").mockRejectedValue(Error("fixture runner failure"));
    if (phase === "workspace") vi.spyOn(runner, "prepareWorkspace").mockImplementation(() => { throw Error("fixture disk failure"); });
    if (phase === "platform") vi.spyOn(f.daemon.client, "start").mockRejectedValue(Error("fixture platform failure"));
    if (phase === "controller") vi.spyOn(GoalController.prototype, "start").mockImplementation(() => { throw Error("fixture controller failure"); });
    const code = phase === "platform" ? "a-05" : "url-failure";
    const out = await f.daemon.runJob(code, "regular", phase === "platform" ? {} : { targetUrl: "http://127.0.0.1:9" });
    expect(out.status).toBe("failed"); expect(f.db.countActiveJobs()).toBe(0);
    expect(f.db.listJobsForCode(code)[0]).toMatchObject({ status: "failed", counts_as_attempt: 0 });
    expect(f.db.nextAttemptN(code, null)).toBe(1); expect(f.db.goalOwned(workspace.challengeWorkspace(f.cfg, code))).toBe(false);
    if (phase !== "runner") expect(run).not.toHaveBeenCalled();
  });
  it("returns loop preparation failure to the same project queue without spending its budget", async () => {
    const f = fixture(), pid = f.project("loop"); f.cfg.loop_enabled = true;
    const sched = f.daemon.withOverlay({ project_id: pid, workspace_root: workspace.projectWorkspacesDir(f.cfg, pid) });
    vi.spyOn(sched as unknown as { prepareLoopContext: () => Promise<unknown> }, "prepareLoopContext").mockRejectedValue(Error("fixture summary failed"));
    f.db.enqueueLoop("url-loop", { projectId: pid });
    expect(await sched.runJob("url-loop", "loop", { projectId: pid, targetUrl: "http://127.0.0.1:9" })).toMatchObject({ status: "failed" });
    expect(f.db.getLoopEntry("url-loop", pid)).toMatchObject({ status: "queued", loop_n: 0 });
    expect(f.db.getLoopEntry("url-loop", null)).toBeNull(); expect(f.db.countActiveJobs()).toBe(0);
  });
  it("releases a claimed goal lease when controller initialization fails", async () => {
    const f = fixture();
    vi.spyOn(GoalController.prototype, "start").mockImplementation(function (this: GoalController) {
      expect(this.db.claimGoal(this.record, this.owner)).toBe(true); throw Error("fixture publication failure");
    });
    await f.daemon.runJob("url-claim", "regular", { targetUrl: "http://127.0.0.1:9" });
    expect(f.db.goalOwned(workspace.challengeWorkspace(f.cfg, "url-claim"))).toBe(false); expect(f.db.countActiveJobs()).toBe(0);
  });
  it("stops a late runtime callback and keeps capacity until its actual exit", async () => {
    const f = fixture(); let spec!: runner.RunSpec, finish!: () => void;
    vi.spyOn(runner, "runLocal").mockImplementation((_cfg, input) => { spec = input; return new Promise(resolve => finish = () => resolve(result)); });
    const stop = vi.spyOn(runner, "stopRunningJob").mockReturnValue(1);
    const pending = f.daemon.runJob("url-late", "regular", { targetUrl: "http://127.0.0.1:9" });
    await vi.waitFor(() => expect(spec).toBeDefined()); f.daemon.stopCode("url-late");
    spec.onStarted?.(`local-${spec.jobId}`);
    expect(stop).toHaveBeenCalledWith({ jobId: spec.jobId, containerId: `local-${spec.jobId}` });
    expect(f.db.getJob(spec.jobId)?.status).toBe("stopping"); expect(f.db.countActiveJobs()).toBe(1);
    finish(); expect(await pending).toMatchObject({ status: "cancelled" }); expect(f.db.countActiveJobs()).toBe(0);
  });
  it("fences an operator stop during asynchronous platform startup", async () => {
    const f = fixture(); f.db.upsertChallenges([challengeFromDict({ unique_code: "a-05" })]);
    let finish!: (r: Record<string, unknown>) => void;
    vi.spyOn(f.daemon.client, "start").mockImplementation(() => new Promise(resolve => finish = resolve));
    const run = vi.spyOn(runner, "runLocal"); const pending = f.daemon.runJob("a-05", "regular");
    expect(f.db.countActiveJobs()).toBe(1); f.daemon.stopCode("a-05");
    expect(f.db.countActiveJobs()).toBe(1); finish({ container_addr: ["127.0.0.1:9"] });
    expect(await pending).toMatchObject({ status: "cancelled" }); expect(run).not.toHaveBeenCalled(); expect(f.db.countActiveJobs()).toBe(0);
  });
  it("persists a stop made before any goal exists across controller restarts", async () => {
    const f = fixture(); f.daemon.stopCode("url-stopped"); expect(f.db.listGoals()).toEqual([]);
    const restarted = new Daemon(f.cfg, f.db, f.daemon.client);
    const run = vi.spyOn(runner, "runLocal").mockResolvedValue(result);
    expect(await restarted.runJob("url-stopped", "regular", { targetUrl: "http://127.0.0.1:9" })).toMatchObject({ status: "cancelled" });
    expect(run).not.toHaveBeenCalled();
    restarted.clearStop("url-stopped");
    await restarted.runJob("url-stopped", "regular", { targetUrl: "http://127.0.0.1:9" });
    expect(run).toHaveBeenCalledOnce();
  });
  it("recovers a dead startup owner but keeps a live owner reserved", () => {
    const f = fixture(); const reserved = reservation(f, "url-starting"); if (!("jobId" in reserved)) throw Error("fixture");
    f.db.updateJob(reserved.jobId, { startup_deadline: 1 });
    expect(harvestJob(f.db, f.db.getJob(reserved.jobId)!).status).toBe("starting");
    f.db.updateJob(reserved.jobId, { startup_owner: JSON.stringify({ pid: -1, boot: "old", namespace: "old", start: "old" }) });
    expect(harvestJob(f.db, f.db.getJob(reserved.jobId)!)).toMatchObject({ status: "failed", terminal_reason: "startup_lost", counts_as_attempt: 0 });
    expect(f.db.countActiveJobs()).toBe(0);
  });
  it("keeps deletion pending until the runtime is known to have exited", () => {
    const f = fixture(), pid = f.project("active"); const reserved = reservation(f, "url-active", pid); if (!("jobId" in reserved)) throw Error("fixture");
    vi.spyOn(runner, "stopRunningJob").mockReturnValue(1);
    const row = f.db.getJob(reserved.jobId)!; mkdirSync(String(row.workspace_path), { recursive: true });
    expect(f.desk.purgeProject(pid)).toMatchObject({ ok: true, pending_stop: true }); expect(f.db.countActiveJobs()).toBe(1);
    recordLocalProcess(String(row.job_dir), { jobId: reserved.jobId, identity: null, state: "exited", exit: 0, error: null, timedOut: false });
    f.db.updateJob(reserved.jobId, { container_id: `local-${reserved.jobId}` });
    f.daemon.reconcileJobs(); f.daemon.cleanupDeletedProjects();
    expect(f.db.countActiveJobs()).toBe(0); expect(f.db.getJob(reserved.jobId)).toBeNull(); expect(existsSync(String(row.workspace_path))).toBe(false);
  });
});
