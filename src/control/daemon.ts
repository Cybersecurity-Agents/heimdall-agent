import { processIdentity } from "./local-process.js";
import { getProject, listTasks, projectSolveOverlay } from "./console/workspace.js";
import { projectDefaults, projectOverlay } from "./console/settings.js";
import { taskKey, activeJob } from "../shared/task-ref.js";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { GoalController } from "./goal-controller.js";
import { pendingVerdict, parseAcceptance, type Acceptance, type GoalRecord, type GoalSpec } from "../shared/goal.js";
import { harvestJob } from "./console/progress.js";
import { knownProjectIds, workspaceProjectId } from "./project-lifecycle.js";
import type { Config } from "../shared/config.js";
import {
  hintFirstLoop,
  isLoopDirectCode,
  jobTimeoutSec,
  loopHintAfterSecFor,
  overlayConfig,
} from "../shared/config.js";
import { canonicalType, classifyChallenge } from "../shared/classify.js";
import { resetHintClock } from "../observer/hint.js";
import { recordAcceptedSubmit, requestTerminalRecap } from "../observer/recap-state.js";
import { recoverObserverFinalizers, runObserverFinalizer } from "./observer-finalize.js";
import { resetEventsCursor } from "../observer/delta.js";
import { Database } from "../shared/db.js";
import { TsecError, type Bench } from "../platforms/types.js";
import {
  loopEffectiveSlots,
  loopSlotsIdle,
  regularSlotBudget,
  shouldHoldInstanceForLoop,
} from "../platforms/tsec/preset.js";
import { forgetStaleCorrectFlags, isChallengeComplete, isDirectWorkspace, isLocalSubmit, loadFlags, scoredCorrect } from "../shared/completion.js";
import { beginAttempt, flagProgressForAttempt } from "../shared/handoff.js";
import { isDirectCode } from "../platforms/direct.js";
import { looksLikeFlag, scrapeWorkspace } from "../shared/flag-scraper.js";
import { afterSubmitShouldStop, capSubmitList } from "../tools/tsec-policy.js";
import { planDispatch } from "../policy/admission.js";
import { countsAsAttemptForReason, isCapacityError, isTransientStartError } from "../policy/capacity.js";
import {
  challengeMapFromDb,
  filterLoopQueueForPolicy,
  isLoopDirectCode as policyLoopDirect,
  orderDispatchCodes,
  shouldDeferLabLoop,
  shouldScoutTimeout,
  sortLoopCodes,
} from "../policy/endgame.js";
import { PlatformInventory } from "../policy/inventory.js";
import { applyResourceFilter, occupancyKeys, occupancyKey } from "../policy/resources.js";
import { countLiveRegularInFlight, jobOverdue } from "../policy/job-clock.js";
import { prepareWorkspace, runLocal, imageFor, stopRunningJob, type RunSpec } from "./runner.js";
import { ensureVpnHostGateway, runDocker, dockerJobName } from "./docker-runner.js";
import { labAddrsLive, loopBudgetLeft, loopDirectEnqueueOk, shouldStartLab } from "./lab-start.js";
import { canSkipStart, closeVerified, isOccupying } from "./close.js";
import { copyIfExists, rmTree } from "../shared/fsutil.js";
import {
  latestFinishedLoopJob,
  loopHandoffUsable,
  loopParentUsable,
  resetStaleLoopWorkspace,
  writePriorBrief,
} from "../agent/loop-brief.js";
import { ensureGeneratedBrief } from "../agent/brief-summarizer.js";
import { writeBrief } from "../agent/observe.js";
import { applyCoachLlmEnv, syncLlmEnv } from "../shared/pi-workspace.js";
import { generatedBriefMd, advisorBriefMd } from "../shared/paths.js";
import { loadSession as loadAgentSession } from "../shared/session.js";

function runtimeResourceKeys(addrs: unknown, challengeType: string): string[] {
  const keys = [...occupancyKeys(addrs, challengeType)];
  const fallback = occupancyKey(addrs, challengeType);
  return keys.length ? keys : fallback ? [fallback] : [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function writeInput(workspace: string, ch: Record<string, unknown>, extra: Record<string, unknown>): void {
  writeFileSync(
    join(workspace, "input.json"),
    JSON.stringify({ ...ch, ...extra }, null, 2) + "\n",
  );
}

export type JobKind = "regular" | "loop";

export type RunJobOpts = {
  syncBeforeStart?: boolean;
  timeoutSec?: number | null;
  challengeType?: string | null;
  targetUrl?: string | null;
  projectId?: string | null;
  closeAfter?: boolean;
  skipStart?: boolean;
  acceptance?: Acceptance;
  resumeGoal?: boolean;
};

export class Daemon {
  private projectId: string | null = null;
  get tasks() { return this.db.forProject(this.projectId); }

  private stop = false;
  private inFlight = new Set<string>();
  private loopFlight = new Set<string>();
  private jobFlight = new Set<string>();
  private cancelCodes = new Set<string>();
  private platformBlockUntil = 0;
  private capacityBackoffSec: number;
  private loggedInventory = false;
  loopCohort: Set<string> | null = null;
  cfg: Config;
  private readonly capacityCfg: Config;

  constructor(
    cfg: Config,
    readonly db: Database,
    readonly client: Bench,
  ) {
    this.cfg = cfg;
    this.capacityCfg = cfg;
    this.capacityBackoffSec = Number(cfg.capacity_backoff_initial_sec || 2);
  }

  requestStop(): void {
    this.stop = true;
  }

  withOverlay(overrides: Record<string, unknown>): Daemon {
    if (!overrides || !Object.keys(overrides).length) return this;
    const clone = Object.create(Object.getPrototypeOf(this)) as Daemon;
    Object.assign(clone, this);
    let projectConfig: Record<string, unknown> = {};
    if ("project_id" in overrides) {
      const pid = String(overrides.project_id || "");
      const base = this.capacityCfg;
      projectConfig = {
        ...projectDefaults(base),
        type_default: base.type_default, type_overrides: { ...base.type_overrides },
        type_rules: base.type_rules, type_by_level: base.type_by_level,
        loop_direct_types: [...base.loop_direct_types],
      };
      if (pid) {
        const project = getProject(base, pid);
        if (project) {
          try { Object.assign(projectConfig, projectOverlay(project.settings || {})); }
          catch { /* Invalid legacy settings keep the global defaults. */ }
          Object.assign(projectConfig, projectSolveOverlay(project, listTasks(base, pid)));
        }
      }
    }
    clone.cfg = overlayConfig(this.cfg, { ...projectConfig, ...overrides });
    if ("project_id" in overrides) clone.projectId = String(overrides.project_id || "") || null;
    return clone;
  }

  private persistent(code: string): boolean {
    return this.cfg.goal.persistence === "until_satisfied" || this.db.listGoals().some(g => g.workspace === join(this.cfg.workspace_root || this.cfg.workspaces_dir, code) && g.spec.persistence === "until_satisfied");
  }

  private goalConfiguration(): string {
    // Persist only a digest, never credentials. A changed configuration gives a
    // blocked task one new attempt; unchanged invalid credentials don't hot-loop.
    return createHash("sha256").update(JSON.stringify({ goal: this.cfg.goal, tools: this.cfg.tools_env.values,
      platform: [this.cfg.base_url, this.cfg.token], runtime: this.cfg.agent_runtime })).digest("hex");
  }

  private goalPaused(code: string): boolean {
    if (this.stopRequested(code)) return true;
    const goal = this.db.getGoal(join(this.cfg.workspace_root || this.cfg.workspaces_dir, code));
    return Boolean(goal && (["cancelled", "succeeded", "blocked", "paused_budget"].includes(goal.state) || goal.nextRunAt > Date.now()));
  }

  /** Recover persisted tasks without resurrecting a cancelled task or duplicating a live runtime. */
  async resumeGoals(): Promise<void> {
    this.reconcileJobs();
    this.cleanupDeletedProjects();
    const projects = knownProjectIds(this.cfg);
    recoverObserverFinalizers(this.cfg, this.db);
    for (const record of this.db.listGoals()) {
      const projectId = String(record.runOptions.projectId || workspaceProjectId(this.cfg, record.workspace) || "");
      if (projectId && (!projects?.has(projectId) || this.db.projectDeleted(projectId, record.workspace))) continue;
      const code = record.spec.code;
      if (record.spec.persistence !== "until_satisfied" || ["cancelled", "succeeded", "paused_budget"].includes(record.state)
        || (record.state === "blocked" && record.runOptions.configuration === this.goalConfiguration())
        || record.nextRunAt > Date.now() || this.jobFlight.has(taskKey(code, projectId)) || this.stopRequested(code, projectId) || this.cfg.skip_codes.includes(code)) continue;
      const jobs = this.db.listJobsForCode(code, projectId || null);
      const active = jobs.filter(j => ["running", "starting", "stopping"].includes(String(j.status)));
      if (active.some(j => ["running", "starting", "stopping"].includes(String(harvestJob(this.db, j).status)))) continue;
      if (Math.max(this.jobFlight.size, this.db.countActiveJobs()) >= this.cfg.max_slots) break;
      const sched = this.withOverlay({ workspace_root: dirname(record.workspace), workspaces_dir: dirname(record.workspace), project_id: projectId });
      sched.tasks.enqueueLoop(code, { reason: "goal_recovery", sourceJobId: record.jobId || undefined });
      void sched.runNextLoop(code, { ...record.runOptions, projectId: projectId || null, resumeGoal: true } as RunJobOpts)
        .catch(e => console.warn(`goal recovery ${code}: ${e}`));
    }
  }

  reconcileJobs(): void {
    for (const job of this.db.listActiveJobs()) {
      if (job.status === "stopping") stopRunningJob({ jobId: String(job.id), containerId: String(job.container_id || job.runtime_name || "") || null, jobDir: String(job.job_dir || "") });
      harvestJob(this.db, job);
    }
  }

  /** Only an explicit deletion tombstone authorizes destructive cleanup. */
  cleanupDeletedProjects(): void {
    for (const project of this.db.deletedProjects()) {
      this.stopProjectJobs(project.project_id);
      const jobs = this.db.listJobsForProject(project.project_id);
      this.db.purgeProjectRecords(project.project_id, project.workspace_root || undefined);
      for (const job of jobs) {
        if (activeJob(job)) continue;
        const path = String(job.job_dir || "");
        const rel = relative(this.cfg.jobs_dir, path);
        if (path && rel && !rel.startsWith("..") && !isAbsolute(rel)) rmTree(path);
      }
      if (!this.db.listJobsForProject(project.project_id).some(activeJob)) {
        rmTree(join(this.cfg.data_dir, "projects", project.project_id));
      }
    }
  }

  stopProjectJobs(projectId: string): void {
    for (const job of this.db.listJobsForProject(projectId)) {
      if (["queued", "starting", "running", "stopping"].includes(String(job.status))) {
        this.stopCode(String(job.unique_code), projectId);
      }
    }
  }

  private projectUnavailable(opts: RunJobOpts): boolean {
    const pid = opts.projectId;
    const known = knownProjectIds(this.cfg);
    return Boolean(pid && (this.db.projectDeleted(pid) || known !== null && !known.has(pid)));
  }

  loopFeatureOn(): boolean {
    return Boolean(this.cfg.loop_enabled);
  }

  /** Includes recovery and starts that have not created their job row yet. */
  activeJobCodes(): Set<string> {
    const codes = new Set([...this.jobFlight].map(key => String(JSON.parse(key)[1])));
    for (const status of ["queued", "starting", "running", "stopping"]) {
      for (const job of this.db.listJobs({ status, limit: -1 })) codes.add(String(job.unique_code));
    }
    return codes;
  }

  requestStopCode(code: string, projectId: string | null = this.projectId): void {
    const c = (code || "").trim();
    if (c) {
      this.cancelCodes.add(taskKey(c, projectId)); this.db.cancelGoals(c, projectId);
      this.db.updateLoop(c, { status: "blocked", hold_instance: 0, reason: "operator_stop" }, projectId);
    }
  }

  stopRequested(code: string, projectId: string | null = this.projectId): boolean {
    return this.cancelCodes.has(taskKey((code || "").trim(), projectId)) || this.db.taskStopped((code || "").trim(), projectId);
  }

  clearStop(code: string, projectId: string | null = this.projectId): void {
    this.cancelCodes.delete(taskKey((code || "").trim(), projectId));
    this.db.clearTaskStop((code || "").trim(), projectId);
  }

  stopCode(code: string, projectId: string | null = this.projectId): { killed: number; cancelled: number } {
    const c = (code || "").trim();
    this.requestStopCode(c, projectId);
    let killed = 0;
    let cancelled = 0;
    for (const row of this.db.listJobsForCode(c, projectId)) {
      const status = String(row.status || "");
      if (!["queued", "starting", "running", "stopping"].includes(status)) continue;
      killed += stopRunningJob({
        jobId: String(row.id || ""),
        containerId: String(row.container_id || row.runtime_name || "") || null,
        jobDir: String(row.job_dir || ""),
      });
      this.db.updateJob(String(row.id), {
        status: "stopping",
        terminal_reason: "operator_stop",
        error: "stopped from desk",
      });
      cancelled += 1;
    }
    return { killed, cancelled };
  }

  async sync(): Promise<number> {
    const chs = await this.client.listChallenges();
    this.db.upsertChallenges(chs);
    for (const ch of chs) {
      const t = classifyChallenge(ch.unique_code, this.cfg, { level: ch.level });
      this.db.setPreferredImage(ch.unique_code, imageFor(this.cfg, t, ch.unique_code));
    }
    return chs.length;
  }

  private noteCapacityDefer(): void {
    const now = Date.now() / 1000;
    this.capacityBackoffSec = Math.min(
      this.capacityBackoffSec * 2,
      Number(this.cfg.capacity_backoff_max_sec || 30),
    );
    this.platformBlockUntil = Math.max(this.platformBlockUntil, now + this.capacityBackoffSec);
  }

  private noteStartSuccess(): void {
    this.capacityBackoffSec = Number(this.cfg.capacity_backoff_initial_sec || 2);
    this.platformBlockUntil = 0;
  }

  private inventory(): PlatformInventory {
    return PlatformInventory.fromChallenges(this.db.listChallenges() as Array<Record<string, unknown>>, {
      platformCap: this.cfg.platform_cap,
    });
  }

  private resourceEligible(codes: string[], inFlight: Iterable<string>, inv?: PlatformInventory): string[] {
    const inventory = inv || this.inventory();
    const flying = new Set([...inFlight].map((c) => String(c).trim()).filter(Boolean));
    for (const c of this.db.loopOwnedCodes()) flying.add(c);
    return applyResourceFilter(codes, this.cfg, { challenges: inventory.challenges, inFlight: flying });
  }

  private eligibleRegular(): string[] {
    const rows = this.db.listChallenges({ incompleteOnly: true });
    const blocked = this.loopFeatureOn() ? this.tasks.loopBlockedCodes() : new Set<string>();
    const chMap = challengeMapFromDb(this.db, rows.map((r) => String(r.unique_code || "")));
    const out: string[] = [];
    for (const r of rows) {
      const code = String(r.unique_code || "");
      if (!code || this.inFlight.has(code) || this.cfg.skip_codes.includes(code) || this.goalPaused(code)) continue;
      if (isDirectCode(code) || blocked.has(code)) continue;
      if (policyLoopDirect(code, this.cfg, { ch: chMap[code] || r })) continue;
      if (this.tasks.nextAttemptN(code) - 1 >= this.cfg.max_attempts_per_challenge) continue;
      const active = this.tasks.listJobsForCode(code).some((j) =>
        ["queued", "starting", "running", "stopping"].includes(String(j.status || "")),
      );
      if (active) continue;
      out.push(code);
    }
    return orderDispatchCodes(out, this.cfg, chMap);
  }

  private async scrapeAndSubmit(workspace: string, code: string, jobId: string, _logPath?: string | null): Promise<void> {
    if (isDirectWorkspace(workspace, code)) {
      for (const row of loadFlags(workspace).filter(isLocalSubmit)) {
        this.db.addFlag({ jobId, uniqueCode: code, flagValue: String(row.flag), source: "direct", submitCorrect: null });
      }
      return;
    }
    if (isChallengeComplete(workspace) || Boolean(this.db.getChallenge(code)?.is_completed)) return;
    const known = new Set(
      this.tasks.listFlags(code).map((r) => String(r.flag_value || "").trim()).filter(Boolean),
    );
    const candidates = scrapeWorkspace(workspace);
    for (const item of loadFlags(workspace)) {
      const flag = String(item.flag || "").trim();
      if (flag && !candidates.includes(flag)) candidates.push(flag);
    }
    let wrongStreak = 0;
    for (const flag of capSubmitList(candidates.filter((f) => looksLikeFlag(f) && !known.has(f)))) {
      if (isChallengeComplete(workspace) || Boolean(this.db.getChallenge(code)?.is_completed)) return;
      const row = loadFlags(workspace).find((item) => String(item.flag || "").trim() === flag);
      const via = String(row?.via || row?.source || "").trim();
      if (via) {
        this.db.addFlag({
          jobId,
          uniqueCode: code,
          flagValue: flag,
          source: via,
          submitCorrect: scoredCorrect(row?.correct),
          awarded: Number(row?.awarded || 0),
        });
        known.add(flag);
        continue;
      }
      try {
        const rec = await this.client.submit(code, flag);
        try { recordAcceptedSubmit(workspace, code, flag, rec, jobId); }
        catch (error) { console.warn(`[observer] cannot record accepted submit: ${error}`); }
        this.db.addFlag({
          jobId,
          uniqueCode: code,
          flagValue: flag,
          source: "scrape",
          submitCorrect: rec.correct || rec.duplicate,
          awarded: rec.awarded,
        });
        known.add(flag);
        const ok = Boolean(rec.correct || rec.duplicate);
        wrongStreak = ok ? 0 : wrongStreak + 1;
        if (
          afterSubmitShouldStop({
            complete: isChallengeComplete(workspace) || Boolean(this.db.getChallenge(code)?.is_completed),
            correct: ok,
            wrongStreak,
          })
        ) {
          return;
        }
      } catch (e) {
        console.warn(`submit ${code} failed: ${e}`);
      }
    }
  }

  orderedLoopQueue(inFlight: Set<string>, inv?: PlatformInventory): string[] {
    const flying = new Set([...inFlight].map((c) => c.trim()).filter(Boolean));
    const queuedRows = this.tasks.listLoopQueue("queued").filter((r) => r.unique_code && Number(r.enqueued_at || 0) <= Date.now()/1000);
    let queued = queuedRows
      .map((r) => String(r.unique_code || "").trim())
      .filter((c) => c && !flying.has(c));
    if (!queued.length) return [];
    const cohort = this.loopCohort;
    if (cohort) {
      const scoped = queued.filter((c) => cohort.has(c));
      if (scoped.length) queued = scoped;
    }
    const maxLoop = Math.max(1, Number(this.cfg.loop_max_per_challenge || 2) || 2);
    queued = queued.filter((c) => {
      const row = queuedRows.find((r) => String(r.unique_code || "") === c);
      return !this.goalPaused(c) && (this.persistent(c) || loopBudgetLeft(row, maxLoop));
    });
    if (!queued.length) return [];
    queued = orderDispatchCodes(queued, this.cfg, challengeMapFromDb(this.db, queued));
    if (this.cfg.lab_defer_loop_until_scouted !== false) {
      queued = queued.filter((c) => !shouldDeferLabLoop(this.tasks, this.cfg, c));
      if (!queued.length) return [];
    }
    const chMap: Record<string, Record<string, unknown> | null> = {};
    const nMap: Record<string, number> = {};
    for (const row of queuedRows) {
      const code = String(row.unique_code || "");
      if (!queued.includes(code)) continue;
      chMap[code] = this.db.getChallenge(code);
      nMap[code] = Number(row.loop_n || 0) || 0;
    }
    queued = filterLoopQueueForPolicy(queued, this.tasks, this.cfg, {
      loopNByCode: nMap,
      challengesByCode: chMap,
      codes: cohort ? [...cohort] : null,
    });
    if (!queued.length) return [];
    queued = sortLoopCodes(queued, this.cfg, { challengesByCode: chMap, loopNByCode: nMap });
    return this.resourceEligible(queued, flying, inv);
  }

  pickLoopCode(inFlight: Set<string>, inv?: PlatformInventory): string | null {
    return this.orderedLoopQueue(inFlight, inv)[0] || null;
  }

  countLoopQueuedAhead(code: string, flying?: Set<string>): number {
    const fly = new Set(
      [...(flying || new Set([...this.inFlight, ...this.loopFlight]))].map((c) => String(c).trim()).filter(Boolean),
    );
    fly.delete(code);
    const ordered = this.orderedLoopQueue(fly);
    const idx = ordered.indexOf(code);
    return idx < 0 ? ordered.length + 1 : idx;
  }

  liveRegularInFlight(exclude?: string): number {
    const codes = [...this.inFlight].filter((c) => c !== exclude);
    const grace = Math.max(5, this.cfg.kill_timeout_sec || 10);
    return countLiveRegularInFlight(
      codes,
      (c) => this.tasks.listJobsForCode(c),
      Date.now() / 1000,
      grace,
    );
  }

  reapOverdueJobs(): string[] {
    const now = Date.now() / 1000;
    const grace = Math.max(5, this.cfg.kill_timeout_sec || 10);
    const reaped: string[] = [];
    for (const job of this.db.listJobs({ status: "running", limit: 500 })) {
      if (!jobOverdue(job, now, grace)) continue;
      const code = String(job.unique_code || "");
      const jobId = String(job.id || "");
      stopRunningJob({
        jobId,
        containerId: job.container_id ? String(job.container_id) : null,
      });
      if (code) reaped.push(code);
    }
    return reaped;
  }

  loopHoldDecision(code: string): { hold: boolean; loopBudget: number; queuedAhead: number } {
    const regularN = this.liveRegularInFlight(code);
    const loopN = [...this.loopFlight].filter((c) => c !== code).length;
    const loopBudget = loopEffectiveSlots(this.cfg, {
      regularIdle: loopSlotsIdle({ regularInFlight: regularN }),
    });
    const flying = new Set([...this.inFlight, ...this.loopFlight]);
    flying.delete(code);
    const queuedAhead = this.countLoopQueuedAhead(code, flying);
    return {
      hold: shouldHoldInstanceForLoop({ loopBudget, loopInFlight: loopN, queuedAhead }),
      loopBudget,
      queuedAhead,
    };
  }

  async releaseOccupyingQueuedLoops(): Promise<string[]> {
    if (!this.loopFeatureOn()) return [];
    const released: string[] = [];
    for (const row of this.tasks.listLoopQueue("queued")) {
      const code = String(row.unique_code || "").trim();
      if (!code || this.loopFlight.has(code) || this.inFlight.has(code) || this.db.listJobsForCode(code).some(activeJob)) continue;
      const ch = this.db.getChallenge(code);
      if (!isOccupying(ch) && !canSkipStart(ch)) continue;
      const { hold } = this.loopHoldDecision(code);
      this.tasks.updateLoop(code, { hold_instance: hold ? 1 : 0 });
      if (hold) continue;
      try {
        await closeVerified(this.client, code, { attempts: this.cfg.close_verify_attempts || 3 });
        released.push(code);
      } catch {
        /* keep trying next tick */
      }
    }
    if (released.length) {
      try {
        const live = await this.client.listChallenges();
        this.db.upsertChallenges(live);
      } catch {
        /* inventory refresh is best-effort */
      }
    }
    return released;
  }

  enqueueDirectLoopChallenges(liveCodes: Set<string> = new Set()): { scanned: number; enqueued: number; skipped: number } {
    const stats = { scanned: 0, enqueued: 0, skipped: 0 };
    if (!this.loopFeatureOn()) return stats;
    const skip = new Set(this.cfg.skip_codes.map((c) => c.trim()).filter(Boolean));
    for (const row of this.db.listChallenges({ incompleteOnly: true })) {
      const code = String(row.unique_code || "").trim();
      if (!code || skip.has(code) || isDirectCode(code)) continue;
      const ctype = classifyChallenge(code, this.cfg, { level: row.level as number });
      if (!isLoopDirectCode(this.cfg, code, ctype)) continue;
      stats.scanned += 1;
      if (this.loopCohort && !this.loopCohort.has(code)) {
        stats.skipped += 1;
        continue;
      }
      if (liveCodes.has(code)) {
        stats.skipped += 1;
        continue;
      }
      const entry = this.tasks.getLoopEntry(code);
      if (this.goalPaused(code) || !loopDirectEnqueueOk(entry, this.cfg.loop_max_per_challenge)) {
        stats.skipped += 1;
        continue;
      }
      this.tasks.enqueueLoop(code, { reason: "direct_loop" });
      stats.enqueued += 1;
    }
    return stats;
  }

  resetCampaignLeftovers(codes: string[]): { dropped_loops: number; cleared_flags: number } {
    let dropped = 0;
    let cleared = 0;
    const seen = new Set<string>();
    const liveJob = (code: string) =>
      this.tasks.listJobsForCode(code).some((j) => ["queued", "starting", "running", "stopping"].includes(String(j.status || "")));
    for (const entry of this.tasks.listLoopQueue("running")) {
      const code = String(entry.unique_code || "").trim();
      if (!code || liveJob(code)) continue;
      this.tasks.deleteLoopEntry(code);
      dropped += 1;
      seen.add(code);
    }
    for (const raw of codes) {
      const code = String(raw || "").trim();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      const entry = this.tasks.getLoopEntry(code);
      if (entry && !liveJob(code)) {
        this.tasks.deleteLoopEntry(code);
        dropped += 1;
      }
      const row = this.db.getChallenge(code);
      if (row?.is_completed) continue;
      const ws = join(this.cfg.workspaces_dir, code);
      try {
        resetStaleLoopWorkspace(ws);
      } catch {
        /* ignore */
      }
      try {
        if (forgetStaleCorrectFlags(ws, { force: true, chRow: row })) cleared += 1;
      } catch {
        /* ignore */
      }
    }
    return { dropped_loops: dropped, cleared_flags: cleared };
  }

  async prepareLoopContext(
    workspace: string,
    jobDir: string,
    uniqueCode: string,
    opts: { currentJobId?: string | null; challengeType?: string | null } = {},
  ): Promise<Record<string, unknown>> {
    const entry = this.tasks.getLoopEntry(uniqueCode);
    let parentId = entry?.source_job_id ? String(entry.source_job_id) : "";
    let parent = parentId ? this.db.getJob(parentId) : null;
    if (parent && String(parent.project_id || "") !== (this.projectId || "")) parent = null;
    if (!loopHandoffUsable(parent) && !loopParentUsable(parent)) {
      const fallback = latestFinishedLoopJob(this.tasks.listJobsForCode(uniqueCode), {
        excludeId: opts.currentJobId,
      });
      if (fallback) {
        parent = fallback;
        parentId = String(fallback.id || parentId);
      }
    }
    const parentUsable = loopParentUsable(parent);
    const fromLoop = loopHandoffUsable(parent);
    const chRow = this.db.getChallenge(uniqueCode) || {};
    const ctype = opts.challengeType || classifyChallenge(uniqueCode, this.cfg, { level: chRow.level as number });
    const skipPi =
      String(entry?.reason || "") === "direct_loop" || isLoopDirectCode(this.cfg, uniqueCode, ctype);
    const parentDir = parentUsable || fromLoop ? String(parent?.job_dir || "") : "";
    const directFirst = skipPi && !parentUsable && !fromLoop;
    if (parentDir && existsSync(parentDir)) {
      copyIfExists(join(parentDir, "agent.log"), join(jobDir, "prior_agent.log"));
      copyIfExists(join(parentDir, "events.jsonl"), join(jobDir, "prior_events.jsonl"));
      copyIfExists(join(parentDir, "result.json"), join(jobDir, "prior_result.json"));
    }
    const briefPath = writePriorBrief(workspace, {
      parentJobDir: parentDir || null,
      uniqueCode,
      sourceJobId: parentUsable || fromLoop ? parentId || null : null,
      directFirst,
      fromLoop,
    });
    copyIfExists(briefPath, join(jobDir, "prior_brief.md"));
    // A repeat loop already has its prior brief, workspace and solver session.
    // Do not block its launch on another model call or replace that session with a summarizer.
    if (!directFirst && !fromLoop) {
      try {
        const env: NodeJS.ProcessEnv = { ...process.env };
        this.cfg.tools_env.mergeInto(env as Record<string, string>, { overwrite: true });
        applyCoachLlmEnv(env);
        syncLlmEnv(env);
        await ensureGeneratedBrief(workspace, uniqueCode, env);
      } catch {
        /* fail-open */
      }
    }
    let advisorPath: string | null = null;
    try {
      advisorPath = writeBrief(workspace, { uniqueCode });
    } catch {
      advisorPath = null;
    }
    copyIfExists(generatedBriefMd(workspace), join(jobDir, "generated_brief.md"));
    if (advisorPath) copyIfExists(advisorPath, join(jobDir, "advisor_brief.md"));
    const session = loadAgentSession(workspace);
    return {
      parent_job_id: parentId || null,
      parent_job_dir: parentDir || null,
      session_id: session.session_id || null,
      session_file: session.session_file || null,
      brief_path: briefPath,
      advisor_brief_path: advisorPath,
      skip_pi: skipPi,
      loop_from_loop: fromLoop,
      direct_first: directFirst,
    };
  }

  async runJob(code: string, kind: JobKind, opts: RunJobOpts = {}): Promise<Record<string, unknown>> {
    const projectId = opts.projectId === undefined ? this.projectId : opts.projectId;
    if (projectId !== this.projectId) {
      const root = projectId ? join(this.cfg.data_dir, "projects", projectId, "workspaces") : join(this.cfg.data_dir, "workspaces");
      return this.withOverlay({ project_id: projectId, workspace_root: root, workspaces_dir: root }).runJob(code, kind, opts);
    }
    opts = { ...opts, projectId };
    if (projectId && knownProjectIds(this.cfg) === null) return { code, status: "blocked", terminal_reason: "ledger_unavailable", completed: false };
    if (this.projectUnavailable(opts)) return { code, status: "cancelled", terminal_reason: "project_deleted", completed: false };
    if (this.stopRequested(code)) {
      return { code, status: "cancelled", terminal_reason: "operator_stop", completed: false };
    }
    if (this.jobFlight.has(taskKey(code, this.projectId))) {
      return { code, status: "already_running", terminal_reason: "already_running", completed: false };
    }
    if (opts.syncBeforeStart) {
      try { await this.sync(); } catch (error) { console.warn(`sync before start ${code}: ${error}`); }
      if (this.projectUnavailable(opts)) return { code, status: "cancelled", terminal_reason: "project_deleted", completed: false };
      if (this.stopRequested(code)) return { code, status: "cancelled", terminal_reason: "operator_stop", completed: false };
    }
    this.reconcileJobs();
    const ch = this.db.getChallenge(code) || {};
    const priorGoal = (opts.resumeGoal ?? kind === "loop")
      ? this.db.getGoal(join(this.cfg.workspace_root || this.cfg.workspaces_dir, code)) : null;
    const selectedType = opts.challengeType || priorGoal?.runOptions.challengeType;
    const ctype = selectedType && String(selectedType).trim().toLowerCase() !== "auto"
      ? canonicalType(String(selectedType)) : classifyChallenge(code, this.cfg, { level: ch.level as number });
    // Resolve once, before admission, and persist the same type for every retry.
    opts = { ...opts, challengeType: ctype };
    const addresses = opts.targetUrl ? [opts.targetUrl] : String(ch.container_addr_json || "[]");
    const keys = this.cfg.resources_enabled && this.cfg.addr_mutex !== false ? runtimeResourceKeys(addresses, ctype) : [];
    const reserved = this.db.reserveJob({ uniqueCode: code, attemptN: 1, image: imageFor(this.cfg, ctype, code),
      workspacePath: join(this.cfg.workspace_root || this.cfg.workspaces_dir, code), jobDir: this.cfg.jobs_dir,
      jobKind: kind, projectId, timeoutSec: opts.timeoutSec || jobTimeoutSec(this.cfg, { challengeType: ctype, jobKind: kind, uniqueCode: code }) }, {
      maxSlots: this.capacityCfg.max_slots, runtime: this.cfg.agent_runtime,
      owner: JSON.stringify(processIdentity(process.pid)), keys, challengeType: ctype,
      platform: !isDirectCode(code) && !opts.targetUrl,
      labTypes: this.cfg.resources_enabled ? this.cfg.lab_exclusive_types : [], labMax: this.cfg.lab_exclusive_max,
    });
    if (!("jobId" in reserved)) return { code, status: reserved.status, terminal_reason: reserved.status, completed: false };
    const jobId = reserved.jobId;
    const row = this.db.getJob(jobId)!;
    const jobDir = join(this.cfg.jobs_dir, `${code}-${kind}-${row.attempt_n}-${jobId}`);
    this.jobFlight.add(taskKey(code, this.projectId));
    let outcome: Record<string, unknown> | undefined;
    try {
      this.db.updateJob(jobId, { job_dir: jobDir, runtime_name: this.cfg.agent_runtime === "docker" ? dockerJobName(code, jobId) : `local-${jobId}` });
      outcome = await this.runJobOnce(code, kind, opts, jobId);
      return outcome;
    } catch (error) {
      const cancelled = this.stopRequested(code) || this.db.getJob(jobId)?.status === "stopping" || this.projectUnavailable(opts);
      outcome = { code, status: cancelled ? "cancelled" : "failed", terminal_reason: cancelled ? "operator_stop" : "startup_failed", error: String(error), completed: false, job_id: jobId };
      return outcome;
    } finally {
      const current = this.db.getJob(jobId);
      if (current && activeJob(current)) {
        // This path covers every early return and exception, including failures
        // before the goal controller and after a possibly successful spawn.
        let terminal = true;
        if (Number(current.runtime_launching)) {
          this.db.updateJob(jobId, { status: "stopping", terminal_reason: String(outcome?.terminal_reason || "startup_failed"), container_id: current.container_id || current.runtime_name || null, error: String(outcome?.error || outcome?.terminal_reason || "runtime reconciliation required") });
          stopRunningJob({ jobId, containerId: String(current.container_id || current.runtime_name || ""), jobDir });
          const reconciled = harvestJob(this.db, this.db.getJob(jobId)!);
          terminal = !activeJob(reconciled);
        }
        if (terminal && current.platform_started && opts.closeAfter !== false) {
          try { await closeVerified(this.client, code, { attempts: this.cfg.close_verify_attempts || 3 }); }
          catch (error) { console.warn(`startup cleanup ${code}: ${error}`); }
        }
        if (terminal) this.db.updateJob(jobId, { status: String(outcome?.status || "failed"), finished_at: Date.now()/1000,
          terminal_reason: String(outcome?.terminal_reason || "startup_failed"), error: outcome?.error || null, counts_as_attempt: 0 });
        const loop = this.tasks.getLoopEntry(code);
        if (kind === "loop" && loop?.loop_job_id === jobId) {
          const cancelled = outcome?.status === "cancelled";
          this.tasks.updateLoop(code, { status: cancelled ? "blocked" : "queued", reason: cancelled ? "operator_stop" : "startup_failed",
            loop_n: Math.max(0, Number(loop.loop_n || 0) - (current.container_id ? 0 : 1)),
            hold_instance: 0, enqueued_at: Date.now()/1000 + 5 });
        }
        const goal = this.db.getGoal(String(current.workspace_path));
        if (goal?.jobId === jobId && !["cancelled", "succeeded", "blocked", "paused_budget"].includes(goal.state)) {
          goal.state = outcome?.status === "cancelled" ? "cancelled" : "retry_wait";
          goal.reason = String(outcome?.error || outcome?.terminal_reason || "startup_failed");
          goal.nextRunAt = Date.now() + 5000;
          const owner = randomUUID();
          if (this.db.claimGoal(goal, owner)) this.db.releaseGoal(goal.workspace, owner);
        }
      }
      this.jobFlight.delete(taskKey(code, this.projectId));
      if (this.db.projectDeleted(projectId || "")) this.cleanupDeletedProjects();
    }
  }

  private async runJobOnce(code: string, kind: JobKind, opts: RunJobOpts, jobId: string): Promise<Record<string, unknown>> {
    if (this.stopRequested(code) || this.db.getJob(jobId)?.status === "stopping" || this.projectUnavailable(opts)) throw new Error("startup_cancelled");
    const ch = this.db.getChallenge(code) || {};
    const priorWorkspace = join(this.cfg.workspace_root || this.cfg.workspaces_dir, code);
    const priorGoal = this.db.getGoal(priorWorkspace);
    if (this.db.goalOwned(priorWorkspace)) return { code, status: "already_running", completed: false };
    if (opts.resumeGoal && priorGoal && (["cancelled", "succeeded", "paused_budget"].includes(priorGoal.state)
      || (priorGoal.state === "blocked" && priorGoal.runOptions.configuration === this.goalConfiguration()))) {
      return { code, status: priorGoal.state, completed: priorGoal.state === "succeeded" };
    }
    for (const job of this.tasks.listJobsForCode(code)) {
      if (job.id === jobId) continue;
      if (!["running", "starting", "stopping"].includes(String(job.status))) continue;
      const live = harvestJob(this.db, job);
      if (["running", "starting", "stopping"].includes(String(live.status))) return { code, status: "already_running", completed: false };
    }
    const ctype = String(opts.challengeType);
    let timeout = opts.timeoutSec && opts.timeoutSec >= 60
      ? opts.timeoutSec
      : jobTimeoutSec(this.cfg, { challengeType: ctype, jobKind: kind, uniqueCode: code });
    if (
      kind === "regular" &&
      !(opts.timeoutSec && opts.timeoutSec >= 60) &&
      shouldScoutTimeout(this.cfg, this.tasks, { challengeType: ctype })
    ) {
      timeout = Math.min(timeout, Math.max(60, Number(this.cfg.lab_scout_timeout_sec || 2400)));
    }
    const { workspace } = prepareWorkspace(this.cfg, code, {
      challengeType: ctype,
      description: ch.description as string,
      level: ch.level as number,
    });
    if (kind === "regular") {
      const ev = join(workspace, ".heimdall", "events.jsonl");
      if (existsSync(ev)) {
        try {
          renameSync(ev, join(workspace, ".heimdall", `events.prev.jsonl`));
          resetEventsCursor(workspace);
        } catch {
          /* keep appending if rotate fails */
        }
      }
    }
    let addrs: string[] = [];
    try {
      addrs = JSON.parse(String(ch.container_addr_json || "[]")) as string[];
    } catch {
      addrs = [];
    }
    if (opts.targetUrl) addrs = [opts.targetUrl];
    const direct = isDirectCode(code) || Boolean(opts.targetUrl);
    const loopDirect = isLoopDirectCode(this.cfg, code, ctype);
    const wantStart = shouldStartLab({
      kind,
      direct,
      skipStart: Boolean(opts.skipStart),
      loopDirect,
      hasLiveAddrs: labAddrsLive(ch, addrs),
    });
    const restartedInstance = wantStart && !labAddrsLive(ch, addrs) && Boolean(priorGoal);
    if (wantStart) {
      try {
        const started = await this.client.start(code);
        this.db.updateJob(jobId, { platform_started: 1 });
        const live = started.container_addr;
        if (Array.isArray(live) && live.length) {
          addrs = live.map(String);
          ch.container_addr_json = JSON.stringify(addrs);
          ch.container_status = "available";
          this.db.upsertChallenges([
            {
              unique_code: code,
              description: ch.description == null ? null : String(ch.description),
              difficulty: ch.difficulty == null ? null : String(ch.difficulty),
              level: Number(ch.level || 0),
              total_score: Number(ch.total_score || 0),
              flag_count: Number(ch.flag_count || 0),
              correct_flag_count: Number(ch.correct_flag_count || 0),
              is_completed: Boolean(ch.is_completed),
              container_status: "available",
              container_addr: addrs,
            },
          ]);
        }
      } catch (e) {
        if (isCapacityError(e) || (e instanceof TsecError && e.status === 409)) {
          this.noteCapacityDefer();
          return { code, status: "deferred_capacity", terminal_reason: "deferred_capacity", completed: false };
        }
        if (isTransientStartError(e)) {
          return { code, status: "deferred_start", terminal_reason: "deferred_start", completed: false };
        }
        throw e;
      }
    } else if (opts.skipStart && addrs.length) {
      ch.container_status = "available";
    }
    if (this.projectUnavailable(opts)) return { code, status: "cancelled", terminal_reason: "project_deleted", completed: false };
    if (this.stopRequested(code) || this.db.getJob(jobId)?.status === "stopping") throw new Error("startup_cancelled");
    if (this.cfg.resources_enabled && this.cfg.addr_mutex !== false && !this.db.reserveAddresses(jobId, runtimeResourceKeys(addrs, ctype))) {
      return { code, status: "deferred_addr", terminal_reason: "deferred_addr", completed: false };
    }
    if (kind === "loop") {
      const entry = this.tasks.getLoopEntry(code);
      const parentId = entry?.source_job_id ? String(entry.source_job_id) : "";
      let parent = parentId ? this.db.getJob(parentId) : null;
      if (parent && String(parent.project_id || "") !== (this.projectId || "")) parent = null;
      if (!loopParentUsable(parent) && !loopHandoffUsable(parent)) {
        parent = latestFinishedLoopJob(this.tasks.listJobsForCode(code));
      }
      const firstLoop = !loopParentUsable(parent) && !loopHandoffUsable(parent);
      if (firstLoop) resetStaleLoopWorkspace(workspace);
    }
    const hold = kind === "loop" ? Boolean(Number(this.tasks.getLoopEntry(code)?.hold_instance || 0)) : false;
    const attemptMeta = beginAttempt(workspace, {
      uniqueCode: code,
      addrs,
      jobKind: kind,
      holdInstance: hold,
      chRow: ch,
      instanceRestarted: restartedInstance,
    });
    if (priorGoal?.spec.persistence === "until_satisfied" && !attemptMeta.instance_rotated) attemptMeta.session_reusable = true;
    const attempt = Number(this.db.getJob(jobId)!.attempt_n);
    const jobDir = String(this.db.getJob(jobId)!.job_dir);
    this.db.updateJob(jobId, { timeout_sec: timeout });
    mkdirSync(jobDir, { recursive: true });
    this.db.updateJob(jobId, { job_dir: jobDir });
    const extraEnv: Record<string, string> = {
      HEIMDALL_GOAL_DRIVER: this.cfg.goal.driver,
      ...(this.cfg.goal.smallModel ? { HEIMDALL_SMALL_MODEL: this.cfg.goal.smallModel } : {}),
    };
    let loopN = 0;
    let loopCtx: Record<string, unknown> = {};
    if (kind === "loop") {
      extraEnv.HEIMDALL_LOOP = "1";
      extraEnv.HEIMDALL_HINT_AFTER_SEC = String(Math.max(60, loopHintAfterSecFor(this.cfg, ctype, code)));
      extraEnv.HEIMDALL_HINT_FIRST_LOOP = hintFirstLoop(this.cfg, ctype, code) ? "1" : "0";
      resetHintClock(workspace);
      extraEnv.HEIMDALL_ALLOW_CLI_FALLBACK = "0";
      extraEnv.HEIMDALL_ALLOW_SDK_FALLBACK = "0";
      extraEnv.HEIMDALL_LOOP_THINKING = "max";
      extraEnv.HEIMDALL_THINKING = "max";
      extraEnv.HEIMDALL_AGENT_BACKEND = this.cfg.loop_backend;
      this.tasks.updateLoop(code, { status: "running", started_at: Date.now() / 1000, loop_job_id: jobId });
      loopN = this.tasks.bumpLoopN(code);
      extraEnv.HEIMDALL_LOOP_N = String(loopN);
      loopCtx = await this.prepareLoopContext(workspace, jobDir, code, { currentJobId: jobId, challengeType: ctype });
    }
    if (this.projectUnavailable(opts)) return { code, status: "cancelled", terminal_reason: "project_deleted", completed: false };
    const flagProg = flagProgressForAttempt(workspace, ch);
    writeInput(workspace, ch, {
      job_id: jobId,
      unique_code: code,
      challenge_type: ctype,
      attempt_n: attempt,
      loop: kind === "loop",
      job_kind: kind,
      target_mode: direct ? "direct" : "platform",
      goal_managed: true,
      direct,
      container_addr: addrs,
      project_id: opts.projectId || null,
      loop_n: kind === "loop" ? loopN : undefined,
      session_reusable: Boolean(attemptMeta.session_reusable),
      instance_rotated: Boolean(attemptMeta.instance_rotated),
      skip_pi: kind === "loop" && (Boolean(loopCtx.skip_pi) || loopDirect),
      loop_from_loop: kind === "loop" && Boolean(loopCtx.loop_from_loop),
      flag_count: flagProg.flag_count,
      correct_flag_count: flagProg.correct_flag_count,
      is_completed: flagProg.is_completed,
      parent_job_id: loopCtx.parent_job_id || null,
    });
    const acceptance = parseAcceptance(opts.acceptance || this.cfg.goal.acceptanceByCode[code] || priorGoal?.spec.acceptance ||
      (direct ? { kind: "local_flags", requiredCount: Number(ch.flag_count || 1) } : { kind: "platform_flags" }));
    const revised = Boolean(priorGoal && (JSON.stringify(priorGoal.spec.acceptance) !== JSON.stringify(acceptance) || ["cancelled", "succeeded", "paused_budget"].includes(priorGoal.state)));
    const createdAt = !priorGoal || revised ? Date.now() : priorGoal.spec.createdAt;
    const goalSpec: GoalSpec = {
      taskId: priorGoal?.spec.taskId || randomUUID(), revision: (priorGoal?.spec.revision || 1) + Number(revised),
      instanceEpoch: !priorGoal || attemptMeta.instance_rotated ? randomUUID() : priorGoal.spec.instanceEpoch,
      code, acceptance, persistence: this.cfg.goal.persistence, createdAt,
      deadlineAt: priorGoal && !revised ? priorGoal.spec.deadlineAt : this.cfg.goal.maxDurationSec > 0 ? createdAt + this.cfg.goal.maxDurationSec * 1000 : null,
      objective: acceptance.kind === "checks" ? "Complete the authorized task and pass every registered acceptance check"
        : acceptance.kind === "local_flags" ? `Collect ${acceptance.requiredCount} unique ${acceptance.validatorId ? "validator-accepted flags" : "locally recorded flag candidates (collection only; no platform correctness claim)"}`
          : acceptance.requiredCount ? `Submit ${acceptance.requiredCount} unique flags accepted by the authorized platform` : "Complete the current authorized platform challenge, including every required flag",
    };
    const goalRecord: GoalRecord = { spec: goalSpec, state: "running", verdict: pendingVerdict(goalSpec),
      workspace, jobId, runOptions: { ...opts, acceptance, configuration: this.goalConfiguration(), flagCount: Number(ch.flag_count || 0), targetUrl: opts.targetUrl || (direct ? addrs[0] : null) }, nextRunAt: 0, reason: "" };
    let runtimeStopRequested = false;
    const controller = new GoalController(this.db, this.client, this.cfg.goal, goalRecord, () => {
      runtimeStopRequested = true;
      stopRunningJob({ jobId });
    });
    try {
      if (!controller.start()) {
        return { code, status: "already_running", completed: false };
      }
      const spec: RunSpec = {
        uniqueCode: code,
        jobId,
        attemptN: attempt,
        workspace,
        jobDir,
        containerAddr: addrs,
        challengeType: ctype,
        description: ch.description ? String(ch.description) : undefined,
        timeoutSec: goalSpec.deadlineAt === null ? timeout : Math.max(1, Math.min(timeout, (goalSpec.deadlineAt - Date.now()) / 1000)),
        loop: kind === "loop",
        image: imageFor(this.cfg, ctype, code),
        extraEnv,
        isCancelled: () => runtimeStopRequested || this.stopRequested(code) || this.db.getJob(jobId)?.status === "stopping" || this.projectUnavailable(opts),
        onLaunching: () => {
          const row = this.db.getJob(jobId);
          if (runtimeStopRequested || this.stopRequested(code) || row?.status !== "starting" || this.projectUnavailable(opts)) throw new Error("startup_cancelled");
          if (Number(row.startup_deadline) < Date.now()/1000) throw new Error("startup_deadline_exceeded");
          this.db.updateJob(jobId, { runtime_launching: 1 });
        },
        onStarted: (cid) => {
          const cancelled = runtimeStopRequested || this.stopRequested(code) || this.db.getJob(jobId)?.status !== "starting" || this.projectUnavailable(opts);
          this.db.updateJob(jobId, { status: cancelled ? "stopping" : "running", counts_as_attempt: 1, started_at: Date.now() / 1000, container_id: cid });
          if (goalRecord.verdict.state === "satisfied" || cancelled) stopRunningJob({ jobId, containerId: cid });
        },
      };
      if (this.stopRequested(code)) {
        stopRunningJob({ jobId });
        this.db.updateJob(jobId, {
          status: "cancelled",
          finished_at: Date.now() / 1000,
          terminal_reason: "operator_stop",
          error: "stopped from desk",
        });
        return { code, status: "cancelled", terminal_reason: "operator_stop", completed: false, job_id: jobId };
      }
      if (this.cfg.agent_runtime === "docker") ensureVpnHostGateway(this.cfg);
      await controller.tick();
      if (this.projectUnavailable(opts)) return { code, status: "cancelled", terminal_reason: "project_deleted", completed: false };
      if (goalRecord.verdict.state !== "satisfied" && spec.isCancelled?.()) throw new Error("startup_cancelled");
      const budgetExpired = goalSpec.deadlineAt !== null && Date.now() >= goalSpec.deadlineAt;
      const result = goalRecord.verdict.state === "satisfied" || budgetExpired
        ? { containerId: "", exitCode: budgetExpired ? 1 : 0, timedOut: false, logPath: "", error: budgetExpired ? "task_deadline" : null }
        : this.cfg.agent_runtime === "docker" ? await runDocker(this.cfg, spec) : await runLocal(this.cfg, spec);
      await controller.settle();
      if (this.projectUnavailable(opts)) return { code, status: "cancelled", terminal_reason: "project_deleted", completed: false };
      const done = goalRecord.verdict.state === "satisfied";
      let status = "failed";
      if (this.stopRequested(code) || this.db.getJob(jobId)?.status === "stopping" || goalRecord.state === "cancelled") status = "cancelled";
      else if (done) status = "succeeded";
      else if (result.timedOut) status = "timeout";
      else if (result.exitCode === 2) status = "blocked";
      if (!done && goalSpec.deadlineAt !== null && Date.now() >= goalSpec.deadlineAt && status !== "cancelled") status = "paused_budget";
      let reason = status === "cancelled" ? "operator_stop" : done ? "succeeded"
        : status === "blocked" ? "backend_blocked" : status === "paused_budget" ? "task_deadline"
          : result.timedOut ? "timeout" : "goal_unsatisfied";
      const persist = goalSpec.persistence === "until_satisfied";
      const canRetry = !done && !["cancelled", "blocked", "paused_budget"].includes(status);
      goalRecord.state = status === "cancelled" ? "cancelled" : done ? "succeeded" : status === "blocked" ? "blocked"
        : status === "paused_budget" ? "paused_budget" : canRetry ? "retry_wait" : "blocked";
      goalRecord.reason = result.error || (canRetry ? "Goal not satisfied; attempt ended" : reason);
      goalRecord.nextRunAt = Date.now() + 5000;
      this.db.saveGoal(goalRecord, controller.owner);
      let keepLab = false;
      if (kind === "regular" && canRetry && (persist || (this.cfg.loop_enabled && this.cfg.loop_escalate_on_timeout))) {
        this.tasks.enqueueLoop(code, { sourceJobId: jobId, reason: status });
        reason = `${reason}_escalated`;
        const decision = this.loopHoldDecision(code);
        keepLab = decision.hold;
        this.tasks.updateLoop(code, { hold_instance: keepLab ? 1 : 0 });
      }
      // The same terminal status shown by the desk owns final recap eligibility.
      // The runtime has exited and drained its logs; no solver timeout applies here.
      try {
        const request = !canRetry || !persist ? requestTerminalRecap(workspace, jobId, status) : null;
        if (request) void runObserverFinalizer(this.cfg, workspace, request)
          .catch(error => console.warn(`[observer] finalizer: ${error}`));
      } catch (error) { console.warn(`[observer] cannot request final recap: ${error}`); }
      if (kind === "loop") {
        const n = Number(this.tasks.getLoopEntry(code)?.loop_n || loopN || 0);
        const exhausted =
          !canRetry || (!persist && !loopBudgetLeft({ loop_n: n }, this.cfg.loop_max_per_challenge));
        this.tasks.updateLoop(code, {
          status: exhausted ? "done" : "queued",
          finished_at: Date.now() / 1000,
          loop_job_id: jobId,
        });
        if (!exhausted) {
          this.tasks.enqueueLoop(code, { sourceJobId: jobId, reason: "repeat" });
          const decision = this.loopHoldDecision(code);
          keepLab = decision.hold;
          this.tasks.updateLoop(code, { loop_n: n, hold_instance: keepLab ? 1 : 0 });
        } else if (canRetry) {
          goalRecord.state = "blocked";
          goalRecord.reason = "Bounded attempt limit reached";
          this.db.saveGoal(goalRecord, controller.owner);
        }
      }
      if (opts.closeAfter !== false && !direct && (done || !keepLab)) {
        try {
          await closeVerified(this.client, code, { attempts: this.cfg.close_verify_attempts || 3 });
        } catch {
          /* ignore */
        }
      }
      this.db.updateJob(jobId, {
        status,
        finished_at: Date.now() / 1000,
        exit_code: result.exitCode,
        error: result.error,
        counts_as_attempt: Number(this.db.getJob(jobId)?.counts_as_attempt) ? countsAsAttemptForReason(reason) : 0,
        terminal_reason: reason,
      });
      if (status === "succeeded" || status === "timeout" || status === "failed") this.noteStartSuccess();
      return {
        code,
        status,
        completed: done && status !== "cancelled",
        goal_state: goalRecord.state,
        acceptance: goalRecord.verdict,
        terminal_reason: String(this.db.getJob(jobId)?.terminal_reason || reason),
        job_id: jobId,
      };
    } finally { await controller.close(); }
  }

  async runNextLoop(code: string, opts: RunJobOpts = {}): Promise<Record<string, unknown> | null> {
    if (opts.projectId !== undefined && opts.projectId !== this.projectId) {
      const root = opts.projectId ? join(this.cfg.data_dir, "projects", opts.projectId, "workspaces") : join(this.cfg.data_dir, "workspaces");
      return this.withOverlay({ project_id: opts.projectId, workspace_root: root, workspaces_dir: root }).runNextLoop(code, opts);
    }
    let entry = this.tasks.getLoopEntry(code);
    if (opts.resumeGoal === false && entry?.status === "blocked" && entry.reason === "operator_stop") {
      this.clearStop(code);
      this.tasks.enqueueLoop(code, { sourceJobId: entry.source_job_id ? String(entry.source_job_id) : undefined, reason: "explicit_restart" });
      entry = this.tasks.getLoopEntry(code);
    }
    if (!entry || String(entry.status || "").toLowerCase() !== "queued") return null;
    if (!this.persistent(code) && !loopBudgetLeft(entry, this.cfg.loop_max_per_challenge)) {
      this.tasks.updateLoop(code, { status: "done" });
      return null;
    }
    if (this.jobFlight.has(taskKey(code, this.projectId))) return null;
    return this.runJob(code, this.cfg.loop_enabled ? "loop" : "regular", { ...opts, resumeGoal: opts.resumeGoal ?? true });
  }

  async tick(): Promise<void> {
    await this.resumeGoals();
    try {
      await this.sync();
    } catch (e) {
      console.warn(`sync failed: ${e}`);
    }
    const enq = this.enqueueDirectLoopChallenges(new Set([...this.inFlight, ...this.loopFlight]));
    if (enq.enqueued) {
      console.log(
        `loop enqueue direct scanned=${enq.scanned} enqueued=${enq.enqueued} skipped=${enq.skipped}`,
      );
    }
    const reaped = this.reapOverdueJobs();
    if (reaped.length) {
      console.warn(`overdue reap ${reaped.join(",")}`);
    }
    const regular = this.eligibleRegular();
    const hasLoop = this.tasks.loopQueuedCount() > 0 || this.loopFlight.size > 0 || this.tasks.loopRunningCount() > 0;
    const regularIdle = loopSlotsIdle({ regularInFlight: this.liveRegularInFlight() });
    const regularBudget = regularSlotBudget(this.cfg, {
      hasLoopWork: hasLoop,
      hasRegular: regular.length > 0,
    });
    const loopBudget = loopEffectiveSlots(this.cfg, { regularIdle });
    const inv = this.inventory();
    const dual = Boolean(this.cfg.dual_capacity);
    const blocked = dual && Date.now() / 1000 < this.platformBlockUntil;
    const availableIncomplete = inv
      .incompleteAvailable()
      .filter((c) => canSkipStart(c))
      .map((c) => String(c.unique_code || ""))
      .filter(Boolean);
    const filtered = this.resourceEligible(regular, this.inFlight, inv);
    if (!this.loggedInventory) {
      this.loggedInventory = true;
      const rows = this.db.listChallenges({ incompleteOnly: true });
      const types: Record<string, number> = {};
      const direct: string[] = [];
      for (const row of rows) {
        const code = String(row.unique_code || "");
        if (!code) continue;
        const t = classifyChallenge(code, this.cfg, { level: row.level as number });
        types[t] = (types[t] || 0) + 1;
        if (isLoopDirectCode(this.cfg, code, t)) direct.push(code);
      }
      const loopUrl = this.cfg.tools_env.values.HEIMDALL_LOOP_BASE_URL || process.env.HEIMDALL_LOOP_BASE_URL || "";
      const loopModel = this.cfg.tools_env.values.HEIMDALL_LOOP_MODEL || process.env.HEIMDALL_LOOP_MODEL || "";
      const loopKey = Boolean(
        (this.cfg.tools_env.values.HEIMDALL_LOOP_API_KEY || process.env.HEIMDALL_LOOP_API_KEY || "").trim(),
      );
      console.log(
        `inventory incomplete=${rows.length} types=${JSON.stringify(types)} direct_loop=${direct.join(",") || "-"} ` +
          `regular=${regular.length} loop_queue=${this.tasks.loopQueuedCount()} ` +
          `loop_llm=${loopKey ? "key" : "NO_KEY"} url=${loopUrl} model=${loopModel}`,
      );
    }
    const released = await this.releaseOccupyingQueuedLoops();
    if (released.length) {
      console.log(`loop release orphans ${released.join(",")}`);
    }
    const invAfter = released.length ? this.inventory() : inv;
    const availableAfter = released.length
      ? invAfter
          .incompleteAvailable()
          .filter((c) => canSkipStart(c))
          .map((c) => String(c.unique_code || ""))
          .filter(Boolean)
      : availableIncomplete;
    const filteredAfter = released.length ? this.resourceEligible(regular, this.inFlight, invAfter) : filtered;
    const plan = planDispatch(filteredAfter, {
      maxSlots: regularBudget,
      inFlightCount: this.inFlight.size,
      platformFree: invAfter.platform_free,
      dualCapacity: dual,
      reattachEnabled: Boolean(this.cfg.reconcile_reattach_available),
      availableIncomplete: availableAfter,
      blocked,
    });
    for (const [code, skipStart] of plan.planned_codes()) {
      if (this.inFlight.has(code) || this.loopFlight.has(code)) continue;
      this.inFlight.add(code);
      console.log(`regular start ${code} backend=${this.cfg.agent_backend} skip_start=${skipStart}`);
      void this.runJob(code, "regular", { skipStart }).catch(error => console.warn(`job ${code}: ${error}`)).finally(() => this.inFlight.delete(code));
    }
    while (this.loopFlight.size < loopBudget) {
      const flying = new Set([...this.inFlight, ...this.loopFlight]);
      const code = this.pickLoopCode(flying, invAfter);
      if (!code) break;
      this.loopFlight.add(code);
      const loopUrl = this.cfg.tools_env.values.HEIMDALL_LOOP_BASE_URL || process.env.HEIMDALL_LOOP_BASE_URL || "";
      const loopModel = this.cfg.tools_env.values.HEIMDALL_LOOP_MODEL || process.env.HEIMDALL_LOOP_MODEL || "";
      console.log(`loop start ${code} backend=${this.cfg.loop_backend} url=${loopUrl} model=${loopModel}`);
      void this.runJob(code, "loop").catch(error => console.warn(`job ${code}: ${error}`)).finally(() => this.loopFlight.delete(code));
    }
  }

  async run(): Promise<void> {
    console.log(
      `heimdall daemon runtime=${this.cfg.agent_runtime} backend=${this.cfg.agent_backend} loop=${this.cfg.loop_backend} observe=${this.cfg.observe_enabled} slots=${this.cfg.max_slots}`,
    );
    while (!this.stop) {
      await this.tick();
      await sleep(this.cfg.poll_interval_sec * 1000);
    }
  }
}
