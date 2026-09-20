import { occupanciesOverlap, occupancyKeys } from "../policy/resources.js";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import type { Challenge } from "../platforms/types.js";
import type { GoalRecord, GoalSpec } from "./goal.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS task_stops (
  project_id TEXT NOT NULL DEFAULT '', unique_code TEXT NOT NULL,
  PRIMARY KEY(project_id, unique_code)
);
CREATE TABLE IF NOT EXISTS deleted_projects (
  project_id TEXT PRIMARY KEY, workspace_root TEXT
);
CREATE TABLE IF NOT EXISTS task_goals (
  workspace TEXT PRIMARY KEY, record_json TEXT NOT NULL,
  owner TEXT, lease_until REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS goal_receipts (
  task_id TEXT NOT NULL, revision INTEGER NOT NULL, epoch TEXT NOT NULL,
  flag TEXT NOT NULL, receipt_json TEXT NOT NULL,
  PRIMARY KEY(task_id, revision, epoch, flag)
);
CREATE TABLE IF NOT EXISTS challenges (
  unique_code TEXT PRIMARY KEY,
  description TEXT,
  difficulty TEXT,
  level INTEGER DEFAULT 0,
  total_score INTEGER DEFAULT 0,
  flag_count INTEGER DEFAULT 0,
  correct_flag_count INTEGER DEFAULT 0,
  is_completed INTEGER DEFAULT 0,
  container_status TEXT,
  container_addr_json TEXT,
  preferred_image TEXT,
  updated_at REAL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  unique_code TEXT NOT NULL,
  mode TEXT,
  attempt_n INTEGER DEFAULT 1,
  status TEXT NOT NULL,
  image TEXT,
  container_id TEXT,
  workspace_path TEXT,
  job_dir TEXT,
  project_id TEXT,
  started_at REAL,
  finished_at REAL,
  exit_code INTEGER,
  error TEXT,
  created_at REAL,
  terminal_reason TEXT,
  counts_as_attempt INTEGER,
  job_kind TEXT,
  parent_job_id TEXT,
  timeout_sec INTEGER
);
CREATE TABLE IF NOT EXISTS flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  unique_code TEXT NOT NULL,
  flag_value TEXT NOT NULL,
  source TEXT,
  submit_correct INTEGER,
  awarded INTEGER DEFAULT 0,
  matched_flag_index INTEGER,
  created_at REAL,
  UNIQUE(unique_code, flag_value)
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_code ON jobs(unique_code);
CREATE TABLE IF NOT EXISTS loop_queue (
  unique_code TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  enqueued_at REAL,
  started_at REAL,
  finished_at REAL,
  source_job_id TEXT,
  loop_job_id TEXT,
  hold_instance INTEGER DEFAULT 0,
  reason TEXT,
  loop_n INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_loop_queue_status ON loop_queue(status);
`;

function rowObj(row: Record<string, unknown> | undefined): Record<string, unknown> | null {
  return row ? { ...row } : null;
}

function underRoot(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export class Database {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 60000 });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA busy_timeout=60000");
    this.db.exec(SCHEMA);
    this.db.exec("BEGIN IMMEDIATE");
    try { this.migrate(); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  forProject(projectId: string | null): TaskStore { return new TaskStore(this, projectId); }

  getGoal(workspace: string): GoalRecord | null {
    const row = this.db.prepare("SELECT record_json FROM task_goals WHERE workspace=?").get(workspace) as { record_json: string } | undefined;
    return row ? JSON.parse(String(row.record_json)) as GoalRecord : null;
  }

  listGoals(): GoalRecord[] {
    return (this.db.prepare("SELECT record_json FROM task_goals").all() as Array<{ record_json: string }>).map(row => JSON.parse(row.record_json) as GoalRecord);
  }

  goalOwned(workspace: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM task_goals WHERE workspace=? AND owner IS NOT NULL AND lease_until>=?").get(workspace, Date.now()));
  }

  /** A lease fences off stale controllers; callers also inspect the old runtime before takeover. */
  claimGoal(record: GoalRecord, owner: string): boolean {
    if (this.projectDeleted(String(record.runOptions.projectId || ""), record.workspace)) return false;
    const now = Date.now();
    return Number(this.db.prepare(`INSERT INTO task_goals(workspace,record_json,owner,lease_until) VALUES(?,?,?,?)
      ON CONFLICT(workspace) DO UPDATE SET record_json=excluded.record_json,owner=excluded.owner,lease_until=excluded.lease_until
      WHERE task_goals.owner IS NULL OR task_goals.lease_until < ?`).run(record.workspace, JSON.stringify(record), owner, now + 60_000, now).changes) === 1;
  }

  saveGoal(record: GoalRecord, owner: string): boolean {
    return Number(this.db.prepare("UPDATE task_goals SET record_json=?,lease_until=? WHERE workspace=? AND owner=?")
      .run(JSON.stringify(record), Date.now() + 60_000, record.workspace, owner).changes) === 1;
  }

  releaseGoal(workspace: string, owner: string): void {
    this.db.prepare("UPDATE task_goals SET owner=NULL,lease_until=0 WHERE workspace=? AND owner=?").run(workspace, owner);
  }

  private goalProject(record: GoalRecord): string {
    if ("projectId" in record.runOptions) return String(record.runOptions.projectId || "");
    return String(this.getJob(record.jobId || "")?.project_id || /[/\\]projects[/\\]([^/\\]+)[/\\]workspaces[/\\]/.exec(record.workspace)?.[1] || "");
  }

  taskStopped(code: string, projectId: string | null): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM task_stops WHERE project_id=? AND unique_code=?").get(projectId || "", code));
  }

  clearTaskStop(code: string, projectId: string | null): void {
    this.db.prepare("DELETE FROM task_stops WHERE project_id=? AND unique_code=?").run(projectId || "", code);
  }

  cancelGoals(code: string, projectId: string | null = null): void {
    this.db.prepare("INSERT OR IGNORE INTO task_stops VALUES(?,?)").run(projectId || "", code);
    for (const record of this.listGoals().filter(g => g.spec.code === code && this.goalProject(g) === (projectId || ""))) {
      record.state = "cancelled"; record.reason = "operator_stop";
      this.db.prepare("UPDATE task_goals SET record_json=? WHERE workspace=?").run(JSON.stringify(record), record.workspace);
    }
  }

  goalReceipts(spec: GoalSpec): Array<Record<string, unknown>> {
    return (this.db.prepare("SELECT flag,receipt_json FROM goal_receipts WHERE task_id=? AND revision=? AND epoch=?")
      .all(spec.taskId, spec.revision, spec.instanceEpoch) as Array<{ flag: string; receipt_json: string }>).map(row => ({ ...JSON.parse(row.receipt_json), flag: row.flag }));
  }

  putGoalReceipt(spec: GoalSpec, flag: string, receipt: Record<string, unknown>): void {
    this.db.prepare(`INSERT INTO goal_receipts VALUES(?,?,?,?,?) ON CONFLICT(task_id,revision,epoch,flag)
      DO UPDATE SET receipt_json=excluded.receipt_json`).run(spec.taskId, spec.revision, spec.instanceEpoch, flag, JSON.stringify(receipt));
  }

  private tableCols(table: string): Set<string> {
    const names = new Set<string>();
    try {
      const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const name = row.name ?? row[1];
        if (name != null) names.add(String(name));
      }
    } catch {
      /* missing table */
    }
    return names;
  }

  private migrate(): void {
    const cols = this.tableCols("jobs");
    const add = (name: string, sql: string) => {
      if (!cols.has(name)) this.db.exec(sql);
    };
    add("terminal_reason", "ALTER TABLE jobs ADD COLUMN terminal_reason TEXT");
    add("counts_as_attempt", "ALTER TABLE jobs ADD COLUMN counts_as_attempt INTEGER");
    add("job_kind", "ALTER TABLE jobs ADD COLUMN job_kind TEXT");
    add("parent_job_id", "ALTER TABLE jobs ADD COLUMN parent_job_id TEXT");
    add("timeout_sec", "ALTER TABLE jobs ADD COLUMN timeout_sec INTEGER");
    add("project_id", "ALTER TABLE jobs ADD COLUMN project_id TEXT");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS loop_queue (
        unique_code TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        enqueued_at REAL,
        started_at REAL,
        finished_at REAL,
        source_job_id TEXT,
        loop_job_id TEXT,
        hold_instance INTEGER DEFAULT 0,
        reason TEXT,
        loop_n INTEGER DEFAULT 0
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_loop_queue_status ON loop_queue(status)");
    const lq = this.tableCols("loop_queue");
    if (!lq.has("loop_n")) this.db.exec("ALTER TABLE loop_queue ADD COLUMN loop_n INTEGER DEFAULT 0");
    for (const name of ["runtime_kind", "runtime_name", "startup_owner", "resource_keys", "challenge_type"]) add(name, `ALTER TABLE jobs ADD COLUMN ${name} TEXT`);
    add("platform_started", "ALTER TABLE jobs ADD COLUMN platform_started INTEGER DEFAULT 0");
    add("runtime_launching", "ALTER TABLE jobs ADD COLUMN runtime_launching INTEGER DEFAULT 0");
    add("startup_deadline", "ALTER TABLE jobs ADD COLUMN startup_deadline REAL");
    this.migrateTaskScope();
  }

  /** Upgrade atomically; retain the original rows for inspection/recovery. */
  private migrateTaskScope(): void {
    if (!this.tableCols("loop_queue").has("project_id")) {
      const rows = this.listLoopQueue();
      this.db.exec(`ALTER TABLE loop_queue RENAME TO loop_queue_legacy;
        DROP INDEX IF EXISTS idx_loop_queue_status;
        CREATE TABLE loop_queue (
          project_id TEXT NOT NULL DEFAULT '', unique_code TEXT NOT NULL,
          status TEXT NOT NULL, enqueued_at REAL, started_at REAL, finished_at REAL,
          source_job_id TEXT, loop_job_id TEXT, hold_instance INTEGER DEFAULT 0,
          reason TEXT, loop_n INTEGER DEFAULT 0, PRIMARY KEY(project_id, unique_code));
        CREATE INDEX idx_loop_queue_status ON loop_queue(status);`);
      for (const row of rows) {
        const referenced = [row.source_job_id, row.loop_job_id].filter(Boolean).map(id => this.getJob(String(id))).filter(Boolean);
        const scopes = new Set(referenced.map(job => String(job!.project_id || "")));
        if (!scopes.size) {
          for (const job of this.listJobsForCode(String(row.unique_code))) scopes.add(String(job.project_id || ""));
          for (const goal of this.listGoals().filter(g => g.spec.code === row.unique_code)) scopes.add(this.goalProject(goal));
        }
        const ambiguous = scopes.size > 1 || [row.source_job_id, row.loop_job_id].filter(Boolean).length !== referenced.length;
        const scope = ambiguous ? "@legacy" : [...scopes][0] || "";
        this.db.prepare(`INSERT INTO loop_queue VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
          scope, row.unique_code, ambiguous ? "blocked" : row.status, row.enqueued_at, row.started_at, row.finished_at,
          row.source_job_id, row.loop_job_id, ambiguous ? 0 : row.hold_instance, ambiguous ? "migration_ambiguous_project" : row.reason, row.loop_n);
      }
    }
    if (!this.tableCols("flags").has("project_id")) {
      this.db.exec(`ALTER TABLE flags RENAME TO flags_legacy;
        CREATE TABLE flags (
          id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, project_id TEXT NOT NULL DEFAULT '',
          unique_code TEXT NOT NULL, flag_value TEXT NOT NULL, source TEXT, submit_correct INTEGER,
          awarded INTEGER DEFAULT 0, matched_flag_index INTEGER, created_at REAL,
          UNIQUE(project_id, unique_code, flag_value));
        INSERT INTO flags SELECT f.id,f.job_id,COALESCE(j.project_id,''),f.unique_code,f.flag_value,
          f.source,f.submit_correct,f.awarded,f.matched_flag_index,f.created_at
          FROM flags_legacy f LEFT JOIN jobs j ON j.id=f.job_id;`);
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_project_code ON jobs(project_id,unique_code)");

  }

  upsertChallenges(challenges: Challenge[]): number {
    const now = Date.now() / 1000;
    const stmt = this.db.prepare(`
      INSERT INTO challenges (
        unique_code, description, difficulty, level, total_score,
        flag_count, correct_flag_count, is_completed,
        container_status, container_addr_json, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(unique_code) DO UPDATE SET
        description=excluded.description,
        difficulty=excluded.difficulty,
        level=excluded.level,
        total_score=excluded.total_score,
        flag_count=excluded.flag_count,
        correct_flag_count=excluded.correct_flag_count,
        is_completed=excluded.is_completed,
        container_status=excluded.container_status,
        container_addr_json=excluded.container_addr_json,
        updated_at=excluded.updated_at
    `);
    for (const ch of challenges) {
      stmt.run(
        ch.unique_code,
        ch.description,
        ch.difficulty,
        ch.level,
        ch.total_score,
        ch.flag_count,
        ch.correct_flag_count,
        ch.is_completed ? 1 : 0,
        ch.container_status,
        JSON.stringify(ch.container_addr),
        now,
      );
    }
    return challenges.length;
  }

  listChallenges(opts: { incompleteOnly?: boolean } = {}): Record<string, unknown>[] {
    const q = opts.incompleteOnly
      ? "SELECT * FROM challenges WHERE is_completed=0 ORDER BY total_score ASC, unique_code ASC"
      : "SELECT * FROM challenges ORDER BY total_score ASC, unique_code ASC";
    return this.db.prepare(q).all() as Record<string, unknown>[];
  }

  getChallenge(code: string): Record<string, unknown> | null {
    return rowObj(this.db.prepare("SELECT * FROM challenges WHERE unique_code=?").get(code) as Record<string, unknown> | undefined);
  }

  setPreferredImage(code: string, image: string): void {
    this.db.prepare("UPDATE challenges SET preferred_image=? WHERE unique_code=?").run(image, code);
  }

  createJob(opts: {
    uniqueCode: string;
    attemptN: number;
    image: string;
    workspacePath: string;
    jobDir: string;
    status?: string;
    jobKind?: string;
    parentJobId?: string | null;
    timeoutSec?: number | null;
    projectId?: string | null;
  }): string {
    if (this.projectDeleted(opts.projectId || "", opts.workspacePath)) throw new Error("project_deleted");
    const id = randomBytes(6).toString("hex");
    const now = Date.now() / 1000;
    this.db.prepare(
      `INSERT INTO jobs (
        id, unique_code, attempt_n, status, image,
        workspace_path, job_dir, created_at, job_kind, parent_job_id, timeout_sec, project_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      opts.uniqueCode,
      opts.attemptN,
      opts.status || "queued",
      opts.image,
      opts.workspacePath,
      opts.jobDir,
      now,
      opts.jobKind || "regular",
      opts.parentJobId ?? null,
      opts.timeoutSec ?? null,
      opts.projectId || null,
    );
    return id;
  }

  /** The check and starting row are one transaction, including across processes. */
  reserveJob(opts: Parameters<Database["createJob"]>[0], admission: {
    maxSlots: number; runtime: string; owner: string; keys: string[]; challengeType: string;
    platform: boolean; labTypes: string[]; labMax: number;
  }): { jobId: string } | { status: "deferred_capacity" | "deferred_addr" | "already_running" } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const active = this.listActiveJobs();
      const held = this.listLoopQueue("queued").filter(q => Number(q.hold_instance) &&
        (String(q.project_id || "") !== (opts.projectId || "") || q.unique_code !== opts.uniqueCode))
        .map(q => this.getJob(String(q.source_job_id || ""))).filter((j): j is Record<string, unknown> => Boolean(j));
      const occupiers = [...active, ...held];
      let status: "deferred_capacity" | "deferred_addr" | "already_running" | undefined;
      if (active.some(j => j.unique_code === opts.uniqueCode && String(j.project_id || "") === (opts.projectId || ""))) status = "already_running";
      else if (active.length >= Math.max(1, admission.maxSlots)) status = "deferred_capacity";
      else if (admission.platform && occupiers.some(j => j.unique_code === opts.uniqueCode)) status = "deferred_addr";
      else if (admission.labTypes.includes(admission.challengeType) && active.filter(j => admission.labTypes.includes(String(j.challenge_type))).length >= admission.labMax) status = "deferred_addr";
      else if (occupiers.some(j => {
        const keys = this.jobResourceKeys(j);
        return admission.keys.some(a => keys.some(b => occupanciesOverlap(a, b)));
      })) status = "deferred_addr";
      if (status) { this.db.exec("COMMIT"); return { status }; }
      const jobId = this.createJob({ ...opts, attemptN: this.nextAttemptN(opts.uniqueCode, opts.projectId || null), status: "starting" });
      this.updateJob(jobId, { runtime_kind: admission.runtime, startup_owner: admission.owner,
        startup_deadline: Date.now() / 1000 + 300, resource_keys: JSON.stringify(admission.keys), challenge_type: admission.challengeType,
        counts_as_attempt: 0 });
      this.db.exec("COMMIT"); return { jobId };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private jobResourceKeys(job: Record<string, unknown>): string[] {
    if (job.resource_keys != null) return JSON.parse(String(job.resource_keys)) as string[];
    // Legacy live jobs have no saved lock keys; conservatively hold their hosts.
    return [...occupancyKeys(this.getChallenge(String(job.unique_code))?.container_addr_json, "intranet")];
  }

  /** Recheck addresses returned by the platform before launching the solver. */
  reserveAddresses(jobId: string, keys: string[]): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getJob(jobId)!;
      const held = this.listLoopQueue("queued").filter(q => Number(q.hold_instance) &&
        (q.project_id !== (current.project_id || "") || q.unique_code !== current.unique_code))
        .map(q => this.getJob(String(q.source_job_id || ""))).filter((j): j is Record<string, unknown> => Boolean(j));
      const conflict = [...this.listActiveJobs().filter(j => j.id !== jobId), ...held].some(j =>
        keys.some(a => this.jobResourceKeys(j).some(b => occupanciesOverlap(a, b))));
      if (!conflict) this.updateJob(jobId, { resource_keys: JSON.stringify(keys) });
      this.db.exec("COMMIT"); return !conflict;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  updateJob(jobId: string, fields: Record<string, unknown>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const cols = keys.map((k) => `${k}=?`).join(", ");
    this.db.prepare(`UPDATE jobs SET ${cols} WHERE id=?`).run(...keys.map((k) => fields[k]), jobId);
  }

  getJob(jobId: string): Record<string, unknown> | null {
    return rowObj(this.db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId) as Record<string, unknown> | undefined);
  }

  listJobs(opts: { status?: string; limit?: number } = {}): Record<string, unknown>[] {
    const limit = opts.limit ?? 50;
    if (opts.status) {
      return this.db.prepare("SELECT * FROM jobs WHERE status=? ORDER BY created_at DESC LIMIT ?").all(opts.status, limit) as Record<string, unknown>[];
    }
    return this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[];
  }

  listActiveJobs(): Record<string, unknown>[] {
    return this.db.prepare("SELECT * FROM jobs WHERE status IN ('queued','starting','running','stopping')").all() as Record<string, unknown>[];
  }

  countActiveJobs(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS c FROM jobs WHERE status IN ('queued','starting','running','stopping')",
    ).get() as { c: number };
    return Number(row.c || 0);
  }

  enqueueLoop(code: string, opts: { sourceJobId?: string; reason?: string; projectId?: string | null } = {}): void {
    const source = opts.sourceJobId ? this.getJob(opts.sourceJobId) : null;
    if (opts.sourceJobId && !source) return;
    const pid = opts.projectId === undefined ? String(source?.project_id || "") : opts.projectId || "";
    if (this.projectDeleted(pid) || source && String(source.project_id || "") !== pid) return;
    this.db.prepare(`INSERT INTO loop_queue(project_id,unique_code,status,enqueued_at,source_job_id,reason,loop_n)
      VALUES(?,?,'queued',?,?,?,0) ON CONFLICT(project_id,unique_code) DO UPDATE SET
      status='queued',enqueued_at=excluded.enqueued_at,source_job_id=excluded.source_job_id,
      reason=excluded.reason,finished_at=NULL,loop_job_id=NULL`).run(pid,code,Date.now()/1000,opts.sourceJobId || null,opts.reason || null);
  }

  listLoopQueue(status?: string, projectId?: string | null): Record<string, unknown>[] {
    const where: string[] = [], args: string[] = [];
    if (status) { where.push("status=?"); args.push(status); }
    if (projectId !== undefined) { where.push("project_id=?"); args.push(projectId || ""); }
    return this.db.prepare(`SELECT * FROM loop_queue${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY enqueued_at ASC`).all(...args) as Record<string, unknown>[];
  }

  /** Omitting scope is a compatibility lookup only when a code has one owner. */
  getLoopEntry(code: string, projectId?: string | null): Record<string, unknown> | null {
    const rows = (projectId === undefined
      ? this.db.prepare("SELECT * FROM loop_queue WHERE unique_code=?").all(code)
      : this.db.prepare("SELECT * FROM loop_queue WHERE unique_code=? AND project_id=?").all(code,projectId || "")) as Record<string, unknown>[];
    if (rows.length > 1) throw new Error("Ambiguous task: project_id is required");
    return rows[0] ? { ...rows[0] } : null;
  }

  updateLoop(code: string, fields: Record<string, unknown>, projectId?: string | null): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const pid = projectId === undefined ? this.getLoopEntry(code)?.project_id : projectId || "";
    if (pid === undefined) return;
    const cols = keys.map(k => `${k}=?`).join(", ");
    this.db.prepare(`UPDATE loop_queue SET ${cols} WHERE unique_code=? AND project_id=?`).run(...keys.map(k=>fields[k]),code,pid);
  }

  loopQueuedCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM loop_queue WHERE status='queued'").get() as { c: number };
    return Number(row.c || 0);
  }

  loopRunningCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM loop_queue WHERE status='running'").get() as { c: number };
    return Number(row.c || 0);
  }

  loopOwnedCodes(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT unique_code FROM loop_queue
         WHERE status='running' OR (status='queued' AND hold_instance=1)`,
      )
      .all() as Array<{ unique_code: string }>;
    return new Set(rows.map((r) => String(r.unique_code || "")).filter(Boolean));
  }

  loopBlockedCodes(projectId: string | null = null): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT unique_code, status, loop_n FROM loop_queue
         WHERE status IN ('queued', 'running', 'done', 'failed') AND project_id=?`,
      )
      .all(projectId || "") as Array<{ unique_code: string; status: string; loop_n: number }>;
    const out = new Set<string>();
    for (const r of rows) {
      const st = String(r.status || "").toLowerCase();
      if (st === "queued" || st === "running") out.add(r.unique_code);
      else if ((st === "done" || st === "failed") && (Number(r.loop_n) || 0) >= 1) out.add(r.unique_code);
    }
    return out;
  }

  bumpLoopN(code: string, projectId?: string | null): number {
    const pid = projectId === undefined ? this.getLoopEntry(code)?.project_id : projectId || "";
    if (pid === undefined) return 1;
    this.db.prepare("UPDATE loop_queue SET loop_n=COALESCE(loop_n,0)+1 WHERE unique_code=? AND project_id=?").run(code,pid);
    return Math.max(1, Number(this.getLoopEntry(code,String(pid))?.loop_n || 1));
  }

  repairCapacityAttempts(): number {
    const info = this.db
      .prepare(
        `UPDATE jobs SET counts_as_attempt=0
         WHERE terminal_reason IN ('deferred_capacity','deferred_addr','deferred_start','start_rejected','infra_error')
           AND COALESCE(counts_as_attempt,1)!=0`,
      )
      .run();
    return Number(info.changes || 0);
  }

  addFlag(opts: {
    jobId?: string | null;
    projectId?: string | null;
    uniqueCode: string;
    flagValue: string;
    source?: string;
    submitCorrect?: boolean | null;
    awarded?: number;
    matchedFlagIndex?: number | null;
  }): void {
      this.db.prepare(
        `INSERT INTO flags (job_id, project_id, unique_code, flag_value, source, submit_correct, awarded, matched_flag_index, created_at)
         VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,unique_code,flag_value) DO NOTHING`,
      ).run(
        opts.jobId || null,
        opts.projectId === undefined ? String(this.getJob(opts.jobId || "")?.project_id || "") : opts.projectId || "",
        opts.uniqueCode,
        opts.flagValue,
        opts.source || null,
        opts.submitCorrect == null ? null : opts.submitCorrect ? 1 : 0,
        opts.awarded || 0,
        opts.matchedFlagIndex ?? null,
        Date.now() / 1000,
      );
  }

  listFlags(uniqueCode?: string | null, projectId?: string | null): Record<string, unknown>[] {
    const where: string[] = [], args: string[] = [];
    if (uniqueCode) { where.push("unique_code=?"); args.push(uniqueCode); }
    if (projectId !== undefined) { where.push("project_id=?"); args.push(projectId || ""); }
    return this.db.prepare(`SELECT * FROM flags${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC${uniqueCode ? "" : " LIMIT 200"}`).all(...args) as Record<string, unknown>[];
  }

  listJobsForCode(code: string, projectId?: string | null): Record<string, unknown>[] {
    const pid = (projectId || "").trim();
    if (projectId !== undefined) {
      return this.db.prepare(
        "SELECT * FROM jobs WHERE unique_code=? AND COALESCE(project_id,'')=? ORDER BY created_at ASC",
      ).all(code, pid) as Record<string, unknown>[];
    }
    return this.db.prepare("SELECT * FROM jobs WHERE unique_code=? ORDER BY created_at ASC").all(code) as Record<string, unknown>[];
  }

  listJobsForProject(projectId: string): Record<string, unknown>[] {
    const pid = (projectId || "").trim();
    if (!pid) return [];
    return this.db.prepare("SELECT * FROM jobs WHERE project_id=? ORDER BY created_at ASC").all(pid) as Record<string, unknown>[];
  }

  nextAttemptN(code: string, projectId?: string | null): number {
    const pid = (projectId || "").trim();
    const rows = (
      projectId !== undefined
        ? this.db.prepare(
            "SELECT attempt_n, status, error, counts_as_attempt FROM jobs WHERE unique_code=? AND COALESCE(project_id,'')=?",
          ).all(code, pid)
        : this.db.prepare(
            "SELECT attempt_n, status, error, counts_as_attempt FROM jobs WHERE unique_code=?",
          ).all(code)
    ) as { attempt_n: number; status: string; error: string | null; counts_as_attempt: number | null }[];
    let maxN = 0;
    for (const r of rows) {
      if (r.counts_as_attempt != null) {
        if (Number(r.counts_as_attempt) === 1) maxN = Math.max(maxN, Number(r.attempt_n || 0));
        continue;
      }
      const status = (r.status || "").toLowerCase();
      if (!["succeeded", "failed", "timeout"].includes(status)) continue;
      maxN = Math.max(maxN, Number(r.attempt_n || 0));
    }
    return maxN + 1;
  }

  deletedProjects(): { project_id: string; workspace_root: string | null }[] {
    return this.db.prepare("SELECT * FROM deleted_projects").all() as { project_id: string; workspace_root: string | null }[];
  }

  projectDeleted(projectId: string, workspace?: string): boolean {
    if (projectId && this.db.prepare("SELECT 1 FROM deleted_projects WHERE project_id=?").get(projectId)) return true;
    if (!workspace) return false;
    const rows = this.db.prepare("SELECT workspace_root FROM deleted_projects WHERE workspace_root IS NOT NULL").all() as { workspace_root: string }[];
    return rows.some(r => underRoot(workspace, r.workspace_root));
  }

  purgeProjectRecords(projectId: string, workspaceRoot?: string): { jobs: number; flags: number; loops: number; goals: number; receipts: number } {
    const pid = (projectId || "").trim();
    if (!pid) return { jobs: 0, flags: 0, loops: 0, goals: 0, receipts: 0 };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO deleted_projects VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET workspace_root=COALESCE(excluded.workspace_root,deleted_projects.workspace_root)")
        .run(pid, workspaceRoot || null);
      const jobs = this.listJobsForProject(pid);
      const jobIds = jobs.map((j) => String(j.id || "")).filter(Boolean);
      const workspaces = new Set(jobs.map(j => String(j.workspace_path || "")));
      const goals = this.listGoals().filter(g => String(g.runOptions.projectId || "") === pid || workspaces.has(g.workspace)
        || workspaceRoot && underRoot(g.workspace, workspaceRoot));
      let receiptsN = 0;
      for (const goal of goals) {
        receiptsN += Number(this.db.prepare("DELETE FROM goal_receipts WHERE task_id=?").run(goal.spec.taskId).changes || 0);
        this.db.prepare("DELETE FROM task_goals WHERE workspace=?").run(goal.workspace);
      }
      let flagsN = 0;
      let loopsN = 0;
      for (let i = 0; i < jobIds.length; i += 200) {
        const chunk = jobIds.slice(i, i + 200);
        const q = chunk.map(() => "?").join(",");
        const info = this.db.prepare(`DELETE FROM flags WHERE job_id IN (${q})`).run(...chunk);
        flagsN += Number(info.changes || 0);
      }
      const jobsInfo = this.db.prepare("DELETE FROM jobs WHERE project_id=? AND status NOT IN ('queued','starting','running','stopping')").run(pid);
      flagsN += Number(this.db.prepare("DELETE FROM flags WHERE project_id=?").run(pid).changes);
      loopsN += Number(this.db.prepare("DELETE FROM loop_queue WHERE project_id=?").run(pid).changes);
      this.db.prepare("DELETE FROM task_stops WHERE project_id=?").run(pid);
      this.db.exec("COMMIT");
      return { jobs: Number(jobsInfo.changes || 0), flags: flagsN, loops: loopsN, goals: goals.length, receipts: receiptsN };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  deleteLoopEntry(code: string, projectId?: string | null): void {
    const pid = projectId === undefined ? this.getLoopEntry(code)?.project_id : projectId || "";
    if (pid !== undefined) this.db.prepare("DELETE FROM loop_queue WHERE unique_code=? AND project_id=?").run(code,pid);
  }
}

/** Project-bound task queries; physical platform inventory remains global. */
export class TaskStore {
  constructor(readonly db: Database, readonly projectId: string | null) {}
  getLoopEntry(code: string) { return this.db.getLoopEntry(code, this.projectId); }
  listLoopQueue(status?: string) { return this.db.listLoopQueue(status, this.projectId); }
  enqueueLoop(code: string, opts: { sourceJobId?: string; reason?: string } = {}) { this.db.enqueueLoop(code, { ...opts, projectId: this.projectId }); }
  updateLoop(code: string, fields: Record<string, unknown>) { this.db.updateLoop(code, fields, this.projectId); }
  deleteLoopEntry(code: string) { this.db.deleteLoopEntry(code, this.projectId); }
  bumpLoopN(code: string) { return this.db.bumpLoopN(code, this.projectId); }
  loopBlockedCodes() { return this.db.loopBlockedCodes(this.projectId); }
  loopQueuedCount() { return this.listLoopQueue("queued").length; }
  loopRunningCount() { return this.listLoopQueue("running").length; }
  listJobsForCode(code: string) { return this.db.listJobsForCode(code, this.projectId); }
  nextAttemptN(code: string) { return this.db.nextAttemptN(code, this.projectId); }
  listFlags(code: string) { return this.db.listFlags(code, this.projectId); }
  getChallenge(code: string) { return this.db.getChallenge(code); }
  listChallenges(opts: { incompleteOnly?: boolean } = {}) { return this.db.listChallenges(opts); }
}
