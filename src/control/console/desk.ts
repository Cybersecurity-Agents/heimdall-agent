import { taskKey, activeJob } from "../../shared/task-ref.js";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Config } from "../../shared/config.js";
import { classifyChallenge } from "../../shared/classify.js";
import type { TaskStatus } from "../../shared/task-status.js";
import { isLoopDirectCode, isLoopDirectType, observerWarmupCfgSec } from "../../shared/config.js";
import { Database } from "../../shared/db.js";
import { createBench, TsecError } from "../../platforms/index.js";
import { loopEffectiveSlots, regularSlotBudget } from "../../platforms/tsec/preset.js";
import {
  addrsFromRow,
  codeForUrl,
  ensureDirectChallenge,
  isDirectCode,
  isDirectRow,
  normalizeTargetUrl,
} from "../../platforms/direct.js";
import { loadFlags, scoredCorrect, recordLocalFlag } from "../../shared/completion.js";
import { goalRequest, managedGoal, parseAcceptance } from "../../shared/goal.js";
import { pendingRecap, recordAcceptedSubmit } from "../../observer/recap-state.js";
import { runObserverFinalizer } from "../observer-finalize.js";
import { nowSec, rmTree } from "../../shared/fsutil.js";
import { Daemon, type RunJobOpts } from "../daemon.js";
import { loopBudgetLeft } from "../lab-start.js";
import * as graphs from "./graphs.js";
import * as llmIo from "./llm-io.js";
import * as platform from "./platform.js";
import * as progress from "./progress.js";
import * as promptcat from "./prompts.js";
import * as sessionboard from "./sessions.js";
import * as settings from "./settings.js";
import * as tokenboard from "./tokens.js";
import * as vpnio from "./vpn.js";
import * as workspace from "./workspace.js";

type RunRec = { code: string; project_id?: string | null; status: string; result: Record<string, unknown> | null };
type CampaignRec = Record<string, unknown> & {
  project_id: string;
  status: string;
  pending: string[];
  running: string[];
  finished: string[];
  codes: string[];
  kinds: Record<string, string>;
  workspace_by_code: Record<string, string>;
  url_by_code: Record<string, string>;
};

export class Desk {
  cfg: Config;
  db: Database;
  private daemon: Daemon;
  runs = new Map<string, RunRec>();
  campaigns = new Map<string, CampaignRec>();
  private campaignRetryAt = new Map<string, number>();
  loopCohort: Set<string> | null = null;
  private cohortProjectId: string | null = null;

  constructor(cfg: Config, db: Database) {
    this.cfg = cfg;
    this.db = db;
    this.daemon = new Daemon(cfg, db, createBench(cfg, db));
    this.daemon.cleanupDeletedProjects();
    const recovery = setInterval(() => { void this.daemon.resumeGoals().catch(e => console.warn(`goal recovery: ${e}`)); }, 5000);
    recovery.unref();
  }

  private sched(projectId?: string | null): Daemon {
    const pid = workspace.safeProjectId(projectId);
    const overrides: Record<string, unknown> = {};
    if (pid) {
      const root = workspace.projectWorkspacesDir(this.cfg, pid);
      overrides.workspace_root = root;
      overrides.workspaces_dir = root;
      overrides.project_id = pid;
    }
    const d = Object.keys(overrides).length ? this.daemon.withOverlay(overrides) : this.daemon;
    d.loopCohort = this.loopCohort;
    return d;
  }

  private projectWsRoot(projectId?: string | null): string {
    const pid = workspace.safeProjectId(projectId);
    return pid ? workspace.projectWorkspacesDir(this.cfg, pid) : this.cfg.workspaces_dir;
  }

  private needPlatform(): string | null {
    if (!(this.cfg.base_url || "").trim() || !(this.cfg.token || "").trim()) {
      return "在设置里填写题库平台地址和 Token";
    }
    return null;
  }

  status(): Record<string, unknown> {
    try {
      for (const row of this.db.listJobs({ status: "running", limit: 20 })) progress.harvestJob(this.db, row);
    } catch {
      /* ignore */
    }
    const ch = this.db.listChallenges();
    const done = ch.filter((r) => r.is_completed).length;
    const projects = workspace.listProjects(this.cfg);
    return {
      ok: true,
      service: "heimdall-console",
      challenges: ch.length,
      completed: done,
      active_jobs: this.db.countActiveJobs(),
      settings: settings.snapshot(this.cfg),
      observe: Boolean(this.cfg.observe_enabled),
      runtime: this.cfg.agent_runtime,
      backend: this.cfg.agent_backend,
      loop_backend: this.cfg.loop_backend,
      project_count: projects.length,
      task_count: projects.reduce((n, p) => n + Number(p.task_count || 0), 0),
      tokens: tokenboard.board(this.cfg).total,
    };
  }

  challenges(): Record<string, unknown>[] {
    const rows = this.db.listChallenges();
    const maps = Object.fromEntries(graphs.listTrafficMaps(this.cfg.workspaces_dir).map((i) => [i.code, i]));
    const out: Record<string, unknown>[] = [];
    for (const r of rows) {
      const code = String(r.unique_code || "");
      const jobs = code ? this.db.listJobsForCode(code) : [];
      const latest = jobs[jobs.length - 1] || null;
      const item: Record<string, unknown> = { ...r };
      item.has_graph = Boolean((maps[code] as Record<string, unknown> | undefined)?.has_graph);
      item.latest_job = latest;
      item.active = Boolean(latest && ["queued", "starting", "running", "stopping"].includes(String(latest.status || "")));
      item.direct = isDirectRow(item);
      if (item.direct) item.target_url = (addrsFromRow(item) || [item.description])[0];
      out.push(item);
    }
    return out;
  }

  async sync(): Promise<Record<string, unknown>> {
    const miss = this.needPlatform();
    if (miss) return { ok: false, error: miss };
    try {
      const n = await this.daemon.sync();
      return { ok: true, synced: n };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  private queuedLoop(code: string, projectId: string | null = null): Record<string, unknown> | null {
    const entry = this.db.getLoopEntry(code, projectId);
    if (!entry) return null;
    if (String(entry.status || "").toLowerCase() !== "queued") return null;
    return entry;
  }

  private shouldResumeLoop(code: string, projectId?: string | null): boolean {
    if (!this.daemon.loopFeatureOn()) return false;
    if (!this.queuedLoop(code, projectId || null)) return false;
    const jobs = this.db.listJobsForCode(code, workspace.safeProjectId(projectId));
    const latest = jobs[jobs.length - 1];
    if (!latest) return false;
    return ["timeout_escalated", "failed_escalated"].includes(String(latest.terminal_reason || ""));
  }

  private async followLoop(
    code: string,
    result: Record<string, unknown> | null,
    sched: Daemon,
    jobOpts: RunJobOpts = {},
  ): Promise<Record<string, unknown> | null> {
    if (!sched.loopFeatureOn() && sched.cfg.goal.persistence !== "until_satisfied") return result;
    let last = result;
    while (true) {
      if (jobOpts.projectId && (this.db.projectDeleted(jobOpts.projectId) || !workspace.getProject(this.cfg, jobOpts.projectId))) return last;
      if (sched.stopRequested(code)) return last;
      if ((last || {}).completed) return last;
      const queued = this.queuedLoop(code, jobOpts.projectId || null);
      if (!queued) return last;
      if (Number(queued.enqueued_at || 0) > Date.now()/1000) {
        await sleep(Math.min(5000, Number(queued.enqueued_at) * 1000 - Date.now()));
        continue;
      }
      if (["deferred_capacity", "deferred_addr", "deferred_start", "already_running"].includes(String(last?.status))) return last;
      const goal = this.db.getGoal(workspace.challengeWorkspace(this.cfg, code, jobOpts.projectId));
      if (last && goal && ["cancelled", "blocked", "paused_budget"].includes(goal.state)) return last;
      if (goal && goal.nextRunAt > Date.now()) await new Promise(r => setTimeout(r, Math.min(5000, goal.nextRunAt - Date.now())));
      const nxt = await sched.runNextLoop(code, { ...jobOpts, resumeGoal: jobOpts.resumeGoal === true || last !== null });
      if (!nxt) return last;
      last = nxt;
      if (["deferred_capacity", "deferred_addr", "already_running"].includes(String(nxt.status || ""))) {
        return last;
      }
    }
  }

  start(payload: Record<string, unknown>): Record<string, unknown> {
    const rawUrl = String(payload.url || payload.target || "").trim();
    let targetUrl: string | null = null;
    if (rawUrl) {
      try {
        targetUrl = normalizeTargetUrl(rawUrl);
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }
    let code = graphs.safeWsCode(String(payload.code || "")) || "";
    if (targetUrl) {
      code = code || codeForUrl(targetUrl);
    } else if (!code) {
      return { ok: false, error: "need a target URL or a challenge code" };
    }
    if (!targetUrl && !isDirectCode(code)) {
      const miss = this.needPlatform();
      if (miss) return { ok: false, error: miss };
    }
    const closeAfter = Boolean(payload.close_after ?? true) && !targetUrl;
    let timeoutSec = payload.timeout_sec != null ? Number(payload.timeout_sec) : null;
    if (timeoutSec != null) {
      timeoutSec = Number.parseInt(String(timeoutSec), 10);
      if (timeoutSec < 60) return { ok: false, error: "timeout_sec must be >= 60" };
    }
    const rawWs = payload.workspace || payload.challenge_type;
    const projectId = workspace.safeProjectId(String(payload.project_id || ""));
    if (payload.project_id && !projectId) return { ok: false, error: "invalid project_id" };
    if (projectId && (!workspace.getProject(this.cfg, projectId) || this.db.projectDeleted(projectId))) return { ok: false, error: "project not found" };
    const sched = this.sched(projectId);
    const val = String(rawWs || "").trim().toLowerCase();
    const challengeType = val === "auto" && projectId
      ? workspace.resolveWorkspace(workspace.getProjectStrategy(this.cfg, projectId), code)
      : val && val !== "auto" ? workspace.normalizeWorkspace(val)
        : classifyChallenge(code, sched.cfg, { level: this.db.getChallenge(code)?.level as number });
    let acceptance;
    try {
      acceptance = payload.acceptance === undefined ? undefined : parseAcceptance(payload.acceptance);
      const ids = acceptance?.kind === "checks" ? acceptance.checkIds : acceptance?.kind === "local_flags" && acceptance.validatorId ? [acceptance.validatorId] : [];
      for (const id of ids) if (!sched.cfg.goal.checks[id]) throw new Error(`Unknown registered check: ${id}`);
    } catch (e) { return { ok: false, error: String(e) }; }

    let followLoop = Boolean(payload.follow_loop ?? true);
    let forceLoop = String(payload.job_kind || "").trim().toLowerCase() === "loop";
    const loopDirect = sched.loopFeatureOn() && (
      isLoopDirectCode(sched.cfg, code, challengeType) ||
      Boolean(challengeType && isLoopDirectType(sched.cfg, challengeType))
    );
    if (forceLoop && !sched.loopFeatureOn()) return { ok: false, error: "Loop is disabled" };
    const current = this.runs.get(taskKey(code, projectId));
    if (current && current.status === "running") {
      return { ok: false, error: `${code} is already running` };
    }
    const capacity = this.campaignSlotFree();
    if (!capacity.free) return { ok: false, accepted: false, status: "deferred_capacity", error: "All execution slots are occupied; retry after an active task finishes" };
    if (targetUrl) ensureDirectChallenge(this.db, code, targetUrl);
    if (loopDirect) forceLoop = true;
    if (forceLoop) {
      followLoop = true;
      try {
        this.db.enqueueLoop(code, { reason: "direct_loop", projectId });
      } catch (e) {
        return { ok: false, error: `Cannot queue loop for ${code}: ${e}` };
      }
    }
    sched.clearStop(code);
    const rec: RunRec = { code, project_id: projectId, status: "running", result: null };
    this.runs.set(taskKey(code, projectId), rec);
    void (async () => {
      try {
        let result: Record<string, unknown> | null = null;
        // Skip Pi only when we will actually run the queued loop (or job_kind=loop).
        // follow_loop=false is an explicit regular retry and must not no-op.
        let resumeLoop = forceLoop || (!targetUrl && this.shouldResumeLoop(code, projectId));
        if (!followLoop && !forceLoop) resumeLoop = false;
        if (!resumeLoop) {
          result = await sched.runJob(code, "regular", {
            syncBeforeStart: !targetUrl,
            resumeGoal: payload.resume_goal === true,
            acceptance,
            timeoutSec,
            challengeType,
            targetUrl,
            projectId,
            closeAfter,
          });
        }
        if (followLoop) {
          result = await this.followLoop(code, result, sched, {
            syncBeforeStart: !targetUrl,
            resumeGoal: payload.resume_goal === true,
            acceptance,
            timeoutSec,
            challengeType,
            targetUrl,
            projectId,
            closeAfter,
          });
        }
        rec.status = "done";
        rec.result = result;
      } catch (e) {
        rec.status = "error";
        rec.result = { error: String(e) };
      }
    })();
    return {
      ok: true,
      accepted: true,
      code,
      direct: Boolean(targetUrl || isDirectCode(code)),
      target_url: targetUrl,
      workspace: challengeType,
    };
  }

  stop(payload: Record<string, unknown>): Record<string, unknown> {
    const code = graphs.safeWsCode(String(payload.code || ""));
    if (!code) return { ok: false, error: "need a challenge code" };
    let projectId = workspace.safeProjectId(String(payload.project_id || ""));
    if (payload.project_id && !projectId) return { ok: false, error: "invalid project_id" };
    if (!("project_id" in payload)) {
      const scopes = new Set([...this.db.listJobsForCode(code).map(j => String(j.project_id || "")),
        ...[...this.runs.values()].filter(r => r.code === code).map(r => r.project_id || ""),
        ...workspace.listProjects(this.cfg).filter(p => workspace.listTasks(this.cfg, String(p.id)).some(t => t.code === code)).map(p => String(p.id))]);
      if (scopes.size > 1) return { ok: false, error: "Ambiguous task: project_id is required" };
      projectId = [...scopes][0] || null;
    }
    const rec = this.daemon.stopCode(code, projectId);
    const current = this.runs.get(taskKey(code, projectId));
    if (current) {
      current.status = "stopped";
      current.result = { status: "cancelled", ...rec };
    }
    const pending = this.db.listJobsForCode(code, projectId).some(activeJob);
    return { ok: true, code, ...rec, pending, status: pending ? "stopping" : "cancelled" };
  }

  attachHomeProgress(items: Record<string, unknown>[]): void {
    for (const p of items) {
      const pid = String(p.id || "");
      const tasks = pid ? workspace.listTasks(this.cfg, pid) : [];
      const states = this.taskStates(pid, tasks.map(t => String(t.code || "")), this.campaigns.get(pid));
      const values = Object.values(states);
      p.progress = { done: values.filter(s => s.state === "succeeded").length,
        total: tasks.length, live: values.filter(s => s.state === "running").length };
    }
  }

  campaignView(projectId: string): Record<string, unknown> {
    const rec = this.campaigns.get((projectId || "").trim());
    if (!rec) {
      return this.campaignPublic({ project_id: projectId, status: "idle", pending: [], running: [],
        finished: [], codes: workspace.listTasks(this.cfg, projectId).map(t => String(t.code || "")).filter(Boolean),
        kinds: {}, workspace_by_code: {}, url_by_code: {} });
    }
    return this.campaignPublic(rec);
  }

  private uniqueCodes(raw: unknown): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of (raw as unknown[]) || []) {
      const code = String(item || "").trim();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      out.push(code);
    }
    return out;
  }

  private appendFinished(rec: CampaignRec, codes: string[]): void {
    const done = Array.isArray(rec.finished) ? rec.finished : [];
    rec.finished = done;
    const seen = new Set(done.map((x) => String(x).trim()).filter(Boolean));
    for (const code of codes) {
      const c = String(code || "").trim();
      if (c && !seen.has(c)) {
        done.push(c);
        seen.add(c);
      }
    }
  }

  private runDeferred(code: string, projectId: string | null): boolean {
    const rec = this.runs.get(taskKey(code, projectId));
    if (!rec || rec.status === "running") return false;
    const deferred = ["deferred_capacity", "deferred_addr", "deferred_start"];
    return deferred.includes(String(rec.result?.status || ""))
      || deferred.includes(String(rec.result?.terminal_reason || ""));
  }

  private runCountsFinished(code: string, projectId: string | null): boolean {
    const rec = this.runs.get(taskKey(code, projectId)) || { status: "", result: null };
    if (rec.status === "running") return false;
    if (this.runDeferred(code, projectId)) return false;
    return ["done", "error", "stopped"].includes(rec.status);
  }

  private taskStates(projectId: string, codes: string[], rec?: CampaignRec): Record<string, TaskStatus> {
    const latest = new Map(this.db.listJobsForProject(projectId).map(j => [String(j.unique_code), j]));
    const goals = new Map(this.db.listGoals().map(g => [g.workspace, g]));
    const loops = new Map(this.db.listLoopQueue(undefined, projectId).map(l => [String(l.unique_code), l]));
    const completed = new Set(this.db.listChallenges().filter(c => Number(c.is_completed)).map(c => String(c.unique_code)));
    const states: Record<string, TaskStatus> = {};
    for (const code of this.uniqueCodes(codes)) {
      const job = latest.get(code);
      const goal = goals.get(String(job?.workspace_path || workspace.challengeWorkspace(this.cfg, code, projectId)));
      const loop = loops.get(code);
      const run = this.runs.get(taskKey(code, projectId));
      const result = run?.result;
      const status = String(job?.status || result?.status || "");
      const stopped = goal && ["cancelled", "blocked", "paused_budget"].includes(goal.state);
      const persistent = goal?.spec.persistence === "until_satisfied";
      const retryAvailable = persistent && goal?.state === "retry_wait"
        || loop?.status === "queued" && (persistent || this.cfg.loop_enabled && loopBudgetLeft(loop, this.cfg.loop_max_per_challenge));
      let state: TaskStatus["state"] = "idle";
      let reason = String(goal?.reason || job?.terminal_reason || result?.terminal_reason || status);
      if (status === "stopping") {
        state = "running"; reason = "stopping";
      } else if (goal?.state === "succeeded" && goal.verdict.state === "satisfied"
        || !goal && (completed.has(code) || status === "succeeded" || result?.completed === true)) {
        state = "succeeded";
      } else if (stopped) {
        state = "unfinished";
        reason = goal.reason === "Bounded attempt limit reached" ? "attempt_limit" : goal.state;
      } else if (["queued", "starting", "running", "stopping"].includes(status)) {
        state = "running";
      } else if (retryAvailable) {
        state = "retry_wait";
        reason = status === "timeout" ? "timeout" : status === "failed" ? "failed" : "retry_wait";
      } else if (run?.status === "running") {
        state = "running";
      } else if (rec?.pending.includes(code)) {
        state = "pending";
      } else if (job || goal || rec?.finished.includes(code) || result) {
        state = "unfinished";
        reason = loop?.status === "done" && !goal ? "attempt_limit" : status || "failed";
      }
      states[code] = { state, reason, job_kind: String(job?.job_kind || rec?.kinds[code] || "regular"),
        loop_n: Number(loop?.loop_n || 0), retry_kind: this.cfg.loop_enabled ? "loop" : "regular" };
    }
    return states;
  }

  private campaignPublic(rec: CampaignRec): Record<string, unknown> {
    const codes = this.uniqueCodes(rec.codes);
    const taskStates = this.taskStates(rec.project_id, codes, rec);
    const pick = (state: TaskStatus["state"]) => codes.filter(code => taskStates[code]?.state === state);
    const pending = pick("pending");
    const running = pick("running");
    const finished = pick("succeeded");
    return {
      status: rec.status || "idle",
      synced: Number(rec.synced || 0),
      created: Number(rec.created || 0),
      queued: pending.length,
      running,
      finished: finished.length,
      pending,
      done: finished,
      retry_wait: pick("retry_wait"),
      unfinished: pick("unfinished"),
      task_states: taskStates,
      codes,
      total: codes.length,
      error: rec.error,
      started_at: rec.started_at,
      updated_at: rec.updated_at,
    };
  }

  private bookUnsolvedCodes(sched: Daemon): string[] {
    const skip = new Set(sched.cfg.skip_codes.map((c) => c.trim()).filter(Boolean));
    const maxAttempts = Number(sched.cfg.max_attempts_per_challenge || 1) || 1;
    const codes: string[] = [];
    for (const row of this.db.listChallenges({ incompleteOnly: true })) {
      const code = String(row.unique_code || "").trim();
      if (!code || skip.has(code) || isDirectCode(code)) continue;
      let attempts = 0;
      try {
        attempts = this.db.nextAttemptN(code) - 1;
      } catch {
        attempts = 0;
      }
      if (attempts >= maxAttempts) continue;
      codes.push(code);
    }
    return codes.sort((a, b) => {
      const sa = Number(this.db.getChallenge(a)?.total_score || 0);
      const sb = Number(this.db.getChallenge(b)?.total_score || 0);
      return sa - sb || a.localeCompare(b);
    });
  }

  private campaignQueue(sched: Daemon, projectId: string): {
    codes: string[];
    workspaceByCode: Record<string, string>;
    urlByCode: Record<string, string>;
  } {
    const skip = new Set(sched.cfg.skip_codes.map((c) => c.trim()).filter(Boolean));
    const maxAttempts = Number(sched.cfg.max_attempts_per_challenge || 1) || 1;
    const tsec: string[] = [];
    const urls: string[] = [];
    const workspaceByCode: Record<string, string> = {};
    const urlByCode: Record<string, string> = {};
    const seen = new Set<string>();
    const tasks = workspace
      .listTasks(this.cfg, projectId)
      .slice()
      .sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0));
    for (const task of tasks) {
      const kind = String(task.kind || "").trim().toLowerCase();
      let code = String(task.code || "").trim();
      const ws = String(task.workspace || "auto").trim() || "auto";
      if (kind === "url") {
        const url = String(task.url || "").trim();
        if (!url) continue;
        if (!code) {
          try {
            code = codeForUrl(url);
          } catch {
            continue;
          }
        }
        if (seen.has(code)) continue;
        seen.add(code);
        urls.push(code);
        urlByCode[code] = url;
        workspaceByCode[code] = ws;
        continue;
      }
      if (kind !== "tsec" || !code || skip.has(code) || seen.has(code)) continue;
      const row = this.db.getChallenge(code) || {};
      if (Number(row.is_completed || 0)) continue;
      if (this.db.nextAttemptN(code, projectId) - 1 >= maxAttempts) continue;
      seen.add(code);
      tsec.push(code);
      workspaceByCode[code] = ws;
    }
    tsec.sort((a, b) => {
      const sa = Number(this.db.getChallenge(a)?.total_score || 0);
      const sb = Number(this.db.getChallenge(b)?.total_score || 0);
      return sa - sb || a.localeCompare(b);
    });
    return { codes: [...tsec, ...urls], workspaceByCode, urlByCode };
  }

  private emptyCampaign(
    pid: string,
    extra: {
      synced?: number;
      created?: number;
      workspaceByCode?: Record<string, string>;
      urlByCode?: Record<string, string>;
    } = {},
  ): Record<string, unknown> {
    this.clearLoopCohort(pid);
    const rec: CampaignRec = {
      project_id: pid,
      status: "done",
      synced: extra.synced || 0,
      created: extra.created || 0,
      codes: [],
      pending: [],
      running: [],
      finished: [],
      kinds: {},
      workspace_by_code: { ...(extra.workspaceByCode || {}) },
      url_by_code: { ...(extra.urlByCode || {}) },
      error: null,
      started_at: nowSec(),
      updated_at: nowSec(),
    };
    this.campaigns.set(pid, rec);
    return { ok: true, accepted: false, empty: true, synced: rec.synced, created: rec.created, campaign: this.campaignPublic(rec) };
  }

  private clearLoopCohort(projectId?: string | null): void {
    const pid = (projectId || "").trim();
    if (pid && this.cohortProjectId && pid !== this.cohortProjectId) return;
    this.loopCohort = null;
    this.cohortProjectId = null;
    this.daemon.loopCohort = null;
  }

  async importUnsolved(projectId: string): Promise<Record<string, unknown>> {
    const pid = (projectId || "").trim();
    const proj = workspace.getProject(this.cfg, pid);
    if (!proj) return { ok: false, error: "project not found" };
    const miss = this.needPlatform();
    if (miss) return { ok: false, error: miss };
    const cur = this.campaigns.get(pid);
    if (cur && ["running", "stopping"].includes(String(cur.status))) {
      return { ok: false, error: "project campaign already running", campaign: this.campaignPublic(cur) };
    }
    let synced = 0;
    try {
      synced = Number(await this.daemon.sync()) || 0;
    } catch (e) {
      const detail = String(e).trim() || "tsec error";
      const status = e instanceof TsecError ? e.status : null;
      if (status) return { ok: false, error: `同步题库失败（HTTP ${status}）：${detail}` };
      return { ok: false, error: `同步题库失败：${detail}` };
    }
    const codes = this.bookUnsolvedCodes(this.daemon);
    const names: Record<string, string> = {};
    for (const code of codes) {
      const label = String((this.db.getChallenge(code) || {}).description || "").trim();
      if (label) names[code] = label;
    }
    const booked = workspace.ensureTsecTasks(this.cfg, pid, codes, names);
    return {
      ok: true,
      synced,
      created: booked.created.length,
      existing: booked.existing.length,
      codes,
      project: workspace.getProject(this.cfg, pid),
    };
  }

  async startCampaign(projectId: string, opts: { resume?: boolean } = {}): Promise<Record<string, unknown>> {
    const pid = (projectId || "").trim();
    const proj = workspace.getProject(this.cfg, pid);
    if (!proj) return { ok: false, error: "project not found" };
    const cur = this.campaigns.get(pid);
    if (cur && ["running", "stopping"].includes(String(cur.status))) {
      return { ok: false, error: "project campaign already running", campaign: this.campaignPublic(cur) };
    }
    const tasks = workspace.listTasks(this.cfg, pid);
    const hasTsec = tasks.some(
      (t) => String(t.kind || "").trim().toLowerCase() === "tsec" && String(t.code || "").trim(),
    );
    let synced = 0;
    if (hasTsec) {
      const miss = this.needPlatform();
      if (miss) return { ok: false, error: miss };
      try {
        synced = Number(await this.daemon.sync()) || 0;
      } catch (e) {
        const detail = String(e).trim() || "tsec error";
        const status = e instanceof TsecError ? e.status : null;
        if (status) return { ok: false, error: `同步题库失败（HTTP ${status}）：${detail}` };
        return { ok: false, error: `同步题库失败：${detail}` };
      }
    }
    const sched = this.sched(pid);
    const queue = this.campaignQueue(sched, pid);
    const { workspaceByCode, urlByCode } = queue;
    const codes = opts.resume ? queue.codes.filter(code => {
      const goal = this.db.getGoal(workspace.challengeWorkspace(this.cfg, code, pid));
      return !goal || !["cancelled", "succeeded", "blocked", "paused_budget"].includes(goal.state);
    }) : queue.codes;
    if (!opts.resume) {
      try {
        sched.resetCampaignLeftovers(codes);
      } catch (e) {
        console.warn(`campaign ${pid} leftover reset failed: ${e}`);
      }
    }
    this.loopCohort = new Set(codes.filter(Boolean));
    this.cohortProjectId = pid;
    sched.loopCohort = this.loopCohort;
    if (!codes.length) {
      return this.emptyCampaign(pid, { synced, workspaceByCode, urlByCode });
    }
    const rec: CampaignRec = {
      project_id: pid,
      status: "running",
      synced,
      resume_goals: Boolean(opts.resume),
      created: 0,
      codes: [...codes],
      pending: [...codes],
      running: [],
      finished: [],
      kinds: {},
      workspace_by_code: workspaceByCode,
      url_by_code: urlByCode,
      error: null,
      started_at: nowSec(),
      updated_at: nowSec(),
    };
    this.campaigns.set(pid, rec);
    void this.campaignWork(pid);
    return { ok: true, accepted: true, synced, created: 0, campaign: this.campaignPublic(rec) };
  }

  stopCampaign(projectId: string): Record<string, unknown> {
    const pid = (projectId || "").trim();
    const rec = this.campaigns.get(pid);
    if (!rec || !["running", "stopping"].includes(String(rec.status))) {
      return { ok: false, error: "no running campaign" };
    }
    rec.status = "stopping";
    rec.pending = [];
    rec.updated_at = nowSec();
    const live = [...(rec.running || [])];
    for (const code of live) this.stop({ code, project_id: pid });
    return { ok: true, campaign: this.campaignPublic(rec) };
  }

  private pathUnder(path: string, root: string): boolean {
    try {
      const rel = relative(resolve(root), resolve(path));
      return Boolean(rel) && !rel.startsWith("..");
    } catch {
      return false;
    }
  }

  purgeProject(projectId: string): Record<string, unknown> {
    const pid = workspace.safeProjectId(projectId);
    if (!pid || !workspace.getProject(this.cfg, pid)) return { ok: false, error: "project not found" };
    const campaign = this.campaigns.get(pid);
    if (campaign) { campaign.status = "stopping"; campaign.pending = []; campaign.running = []; }
    const jobs = this.db.listJobsForProject(pid);
    this.daemon.stopProjectJobs(pid);
    // Persist the deletion fence before removing files or allowing callbacks to finish.
    this.daemon.reconcileJobs();
    const stats = this.db.purgeProjectRecords(pid, workspace.projectWorkspacesDir(this.cfg, pid));
    if (!workspace.deleteProject(this.cfg, pid)) return { ok: false, error: "project not found" };
    let jobDirs = 0;
    for (const job of jobs) {
      if (this.db.getJob(String(job.id)) && activeJob(this.db.getJob(String(job.id))!)) continue;
      const raw = String(job.job_dir || "").trim();
      if (!raw || !this.pathUnder(raw, this.cfg.jobs_dir)) continue;
      if (rmTree(raw)) jobDirs += 1;
    }
    const root = workspace.projectRootDir(this.cfg, pid);
    const pendingStop = this.db.listJobsForProject(pid).some(activeJob);
    const wsOk = pendingStop ? false : rmTree(root);
    for (const [code, run] of this.runs) {
      if (run.project_id === pid) { run.status = "stopped"; this.runs.delete(code); }
    }
    this.campaigns.delete(pid);
    if (this.cohortProjectId === pid) this.clearLoopCohort(pid);
    return { ok: true, id: pid, ...stats, pending_stop: pendingStop, job_dirs: jobDirs, workspace: Boolean(wsOk) };
  }

  private campaignQueuedLoops(codes: string[], projectId: string): string[] {
    const allow = new Set(codes.map((c) => c.trim()).filter(Boolean));
    if (!allow.size) return [];
    return this.daemon
      .db.listLoopQueue("queued", projectId)
      .map((r) => String(r.unique_code || "").trim())
      .filter((c) => c && allow.has(c));
  }

  private campaignReap(rec: CampaignRec): { pending: string[]; still: string[] } {
    const projectId = rec.project_id;
    const still: string[] = [];
    const newly: string[] = [];
    for (const code of rec.running || []) {
      const st = (this.runs.get(taskKey(code, projectId)) || {}).status;
      if (st === "running") still.push(code);
      else if (this.runCountsFinished(code, projectId)) newly.push(code);
      else if (rec.status === "running" && this.runDeferred(code, projectId) && rec.kinds[code] !== "loop") {
        // A rejected start has no job/goal for recovery to resume. Keep it in
        // the campaign until capacity returns, with a delay to avoid hot retries.
        if (!rec.pending.includes(code)) rec.pending.push(code);
        this.campaignRetryAt.set(taskKey(code, projectId), Date.now() + Math.max(1, this.cfg.capacity_backoff_initial_sec || 2) * 1000);
      }
    }
    rec.running = still;
    this.appendFinished(rec, newly);
    const kinds = rec.kinds || {};
    rec.kinds = kinds;
    for (const code of Object.keys(kinds)) {
      if (!still.includes(code)) delete kinds[code];
    }
    return { pending: [...(rec.pending || [])], still };
  }

  private campaignSlotFree(): { maxSlots: number; free: number } {
    const active = new Set(this.db.listActiveJobs().map(j => taskKey(String(j.unique_code), String(j.project_id || ""))));
    for (const run of this.runs.values()) if (run.status === "running") active.add(taskKey(run.code, run.project_id));
    const globalN = active.size;
    const maxSlots = Math.max(1, Number(this.cfg.max_slots || 1) || 1);
    return { maxSlots, free: Math.max(0, maxSlots - globalN) };
  }

  private campaignPlan(
    sched: Daemon,
    rec: CampaignRec,
    pending: string[],
    still: string[],
    queued: string[],
    free: number,
  ): { regular: string[]; loop: string[] } {
    const kinds = rec.kinds || {};
    const regularRunning = still.filter((c) => kinds[c] !== "loop");
    const loopRunning = still.filter((c) => kinds[c] === "loop");
    const hasLoopWork = Boolean(queued.length || loopRunning.length);
    const regularBudget = regularSlotBudget(sched.cfg, { hasLoopWork, hasRegular: Boolean(pending.length) });
    const loopBudget = loopEffectiveSlots(sched.cfg, {
      regularIdle: !regularRunning.length,
    });
    const regularRoom = Math.max(0, Math.min(free, regularBudget - regularRunning.length, pending.length));
    const regularLaunch = pending.filter(c => (this.campaignRetryAt.get(taskKey(c, rec.project_id)) || 0) <= Date.now()).slice(0, regularRoom);
    const freeAfter = Math.max(0, free - regularLaunch.length);
    const loopRoom = Math.max(0, Math.min(freeAfter, loopBudget - loopRunning.length));
    const loopLaunch: string[] = [];
    const flying = new Set([...still, ...regularLaunch]);
    const codes = (rec.codes || []).map((c) => String(c).trim()).filter(Boolean);
    for (let i = 0; i < loopRoom; i++) {
      const picked = this.campaignPickLoop(sched, codes, flying, rec.project_id);
      if (!picked) break;
      loopLaunch.push(picked);
      flying.add(picked);
    }
    return { regular: regularLaunch, loop: loopLaunch };
  }

  private campaignPickLoop(sched: Daemon, codes: string[], flying: Set<string>, projectId: string): string | null {
    const allow = new Set(codes.map((c) => c.trim()).filter(Boolean));
    if (!allow.size) return null;
    const foreign = new Set<string>();
    for (const row of sched.db.listLoopQueue("queued", projectId)) {
      const code = String(row.unique_code || "").trim();
      if (code && !allow.has(code)) foreign.add(code);
    }
    const picked = sched.pickLoopCode(new Set([...flying, ...foreign]));
    if (picked && allow.has(picked) && !flying.has(picked)) return picked;
    return null;
  }

  private campaignStartOne(
    projectId: string,
    rec: CampaignRec,
    code: string,
    kind: string,
    followLoop: boolean,
    jobKind?: string,
  ): string | null {
    const taskWs = (rec.workspace_by_code || {})[code] || "auto";
    const payload: Record<string, unknown> = {
      code,
      workspace: taskWs,
      project_id: projectId,
      close_after: true,
      follow_loop: followLoop,
      resume_goal: rec.resume_goals === true,
    };
    const url = String((rec.url_by_code || {})[code] || "").trim();
    if (url) payload.url = url;
    if (jobKind) payload.job_kind = jobKind;
    const out = this.start(payload);
    if (rec.status !== "running") return code;
    const err = String(out.error || "").toLowerCase();
    if (out.ok || err.includes("already running")) {
      if (!rec.running.includes(code)) rec.running.push(code);
      rec.kinds[code] = kind;
    } else if (["deferred_capacity", "deferred_addr", "deferred_start"].includes(String(out.status))) {
      if (kind !== "loop" && !rec.pending.includes(code)) rec.pending.push(code);
      this.campaignRetryAt.set(taskKey(code, projectId), Date.now() + 2000);
    } else {
      this.appendFinished(rec, [code]);
      delete rec.kinds[code];
      console.warn(`campaign ${projectId} skip ${code}: ${out.error}`);
    }
    return null;
  }

  private async campaignDrainLoops(projectId: string, rec: CampaignRec): Promise<void> {
    const sched = this.sched(projectId);
    const codes = (rec.codes || []).map((c) => String(c).trim()).filter(Boolean);
    if (!codes.length || !sched.loopFeatureOn()) return;
    try {
      sched.enqueueDirectLoopChallenges();
    } catch (e) {
      console.warn(`campaign ${projectId} drain direct loop enqueue: ${e}`);
    }
    let spins = 0;
    while (true) {
      if (rec.status !== "running") return;
      const { still } = this.campaignReap(rec);
      const { free } = this.campaignSlotFree();
      const queued = this.campaignQueuedLoops(codes, projectId);
      const { loop: loopLaunch } = this.campaignPlan(sched, rec, [], still, queued, free);
      rec.updated_at = nowSec();
      if (!queued.length && !still.length) return;
      if (!loopLaunch.length) {
        if (!still.length) return;
        await sleep(200);
        continue;
      }
      for (const code of loopLaunch) {
        const stopCode = this.campaignStartOne(projectId, rec, code, "loop", true, "loop");
        if (stopCode) {
          this.stop({ code: stopCode, project_id: projectId });
          return;
        }
      }
      spins += 1;
      if (spins >= 60 && !still.length) return;
      await sleep(200);
    }
  }

  private async campaignWork(projectId: string): Promise<void> {
    const rec = this.campaigns.get(projectId);
    if (!rec) return;
    try {
      const sched = this.sched(projectId);
      const codes = (rec.codes || []).map((c) => String(c).trim()).filter(Boolean);
      while (true) {
        if (rec.status === "stopping") {
          rec.pending = [];
          for (const code of [...(rec.running || [])]) this.stop({ code, project_id: projectId });
          break;
        }
        const reaped = this.campaignReap(rec);
        if (rec.status !== "running") break;
        try {
          sched.enqueueDirectLoopChallenges(new Set(reaped.still));
        } catch (e) {
          console.warn(`campaign ${projectId} direct loop enqueue: ${e}`);
        }
        const { pending, still } = this.campaignReap(rec);
        let queued = this.campaignQueuedLoops(codes, projectId);
        const queuedSet = new Set(queued);
        const pendingFiltered = queuedSet.size ? pending.filter((c) => !queuedSet.has(c)) : pending;
        rec.pending = pendingFiltered;
        const { free } = this.campaignSlotFree();
        let { regular: regularLaunch, loop: loopLaunch } = this.campaignPlan(
          sched,
          rec,
          pendingFiltered,
          still,
          queued,
          free,
        );
        if (rec.status !== "running") {
          regularLaunch = [];
          loopLaunch = [];
        } else if (regularLaunch.length) {
          const launched = new Set(regularLaunch);
          rec.pending = pendingFiltered.filter(c => !launched.has(c));
        }
        rec.updated_at = nowSec();
        const hasWork = Boolean(rec.pending.length || rec.running.length || regularLaunch.length || loopLaunch.length);
        if (rec.status !== "running") break;
        if (!hasWork) break;
        let halted = false;
        for (const code of regularLaunch) {
          const stopCode = this.campaignStartOne(projectId, rec, code, "regular", false);
          if (stopCode) {
            this.stop({ code: stopCode, project_id: projectId });
            halted = true;
            break;
          }
        }
        if (!halted) {
          for (const code of loopLaunch) {
            const stopCode = this.campaignStartOne(projectId, rec, code, "loop", true, "loop");
            if (stopCode) {
              this.stop({ code: stopCode, project_id: projectId });
              halted = true;
              break;
            }
          }
        }
        if (halted) break;
        await sleep(200);
      }
      if (rec.status === "running") await this.campaignDrainLoops(projectId, rec);
      if (rec.status === "stopping") {
        for (const code of rec.codes || []) {
          if ((this.runs.get(taskKey(code, projectId)) || {}).status === "running") this.stop({ code, project_id: projectId });
        }
      }
      const still = (rec.running || []).filter((c) => (this.runs.get(taskKey(c, projectId)) || {}).status === "running");
      const done = (rec.running || []).filter((c) => !still.includes(c) && this.runCountsFinished(c, projectId));
      rec.running = still;
      this.appendFinished(rec, done);
      if (rec.status !== "error") rec.status = "done";
      rec.updated_at = nowSec();
      this.clearLoopCohort(projectId);
    } catch (e) {
      rec.status = "error";
      rec.error = String(e);
      rec.updated_at = nowSec();
      this.clearLoopCohort(projectId);
    }
  }

  async submitFlag(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const code = graphs.safeWsCode(String(payload.code || ""));
    const flag = String(payload.flag || "").trim();
    const pid = workspace.safeProjectId(String(payload.project_id || ""));
    if (payload.project_id && (!pid || !workspace.getProject(this.cfg, pid) || this.db.projectDeleted(pid))) return { ok: false, error: "project not found" };
    if (!code || !flag) return { ok: false, error: "need code and flag" };
    const managedWorkspace = workspace.challengeWorkspace(this.cfg, code, String(payload.project_id || "") || null);
    const goal = this.db.getGoal(managedWorkspace);
    if (goal && managedGoal(managedWorkspace) && ["running", "waiting_verification"].includes(goal.state)) {
      try { return { ok: true, ...await goalRequest(managedWorkspace, "submit", flag) }; }
      catch (e) { return { ok: false, error: String(e) }; }
    }
    const row = this.db.getChallenge(code);
    if (isDirectCode(code) || isDirectRow(row)) {
      const ws = workspace.challengeWorkspace(this.cfg, code, String(payload.project_id || "") || null);
      recordLocalFlag(ws, flag);
      this.db.addFlag({ jobId: null, projectId: workspace.safeProjectId(String(payload.project_id || "")), uniqueCode: code, flagValue: flag, source: "direct", submitCorrect: null });
      return { ok: true, recorded: true, correct: null, duplicate: false, awarded: 0, direct: true };
    }
    if (!(this.cfg.base_url || "").trim() || !(this.cfg.token || "").trim()) {
      return { ok: false, error: "在设置里填写题库平台地址和 Token" };
    }
    const res = await this.daemon.client.submit(code, flag);
    try {
      const ws = workspace.challengeWorkspace(this.cfg, code, String(payload.project_id || "") || null);
      if (existsSync(ws) && recordAcceptedSubmit(ws, code, flag, res)) {
        const request = pendingRecap(ws);
        if (request) void runObserverFinalizer(this.cfg, ws, request)
          .catch((error) => console.warn(`[observer] desk recap failed: ${error}`));
      }
    } catch (error) { console.warn(`[observer] cannot record desk submission: ${error}`); }
    this.db.addFlag({
      jobId: null,
      projectId: workspace.safeProjectId(String(payload.project_id || "")),
      uniqueCode: code,
      flagValue: flag,
      source: "console",
      submitCorrect: res.correct,
      awarded: res.awarded,
      matchedFlagIndex: res.matched_flag_index,
    });
    return { ok: true, correct: Boolean(res.correct), duplicate: Boolean(res.duplicate), awarded: res.awarded, raw: res.raw };
  }

  flags(code?: string | null, projectId?: string | null): Record<string, unknown>[] {
    const pid = workspace.safeProjectId(projectId);
    let rows = this.db.listFlags(code || null, pid);
    rows = rows.slice().sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0));
    if (code) {
      const ws = workspace.challengeWorkspace(this.cfg, code, pid);
      const seen = new Set(rows.map((r) => String(r.flag_value || "").trim()).filter(Boolean));
      for (const item of loadFlags(ws)) {
        const val = String(item.flag || "").trim();
        if (!val || seen.has(val)) continue;
        seen.add(val);
        rows.push({
          flag_value: val,
          submit_correct: item.source === "direct" ? null : scoredCorrect(item.correct) ? 1 : 0,
          source: item.source === "direct" ? "direct" : item.via || item.source || "workspace",
        });
      }
    }
    return rows;
  }

  jobs(code?: string | null, projectId?: string | null, limit = 40): Record<string, unknown>[] {
    const pid = workspace.safeProjectId(projectId);
    if (code) return this.db.listJobsForCode(code, pid).slice().reverse().slice(0, limit);
    return this.db.listJobs({ limit: -1 }).filter(j => String(j.project_id || "") === (pid || "")).slice(0, limit);
  }

  graph(code: string, projectId?: string | null): Record<string, unknown> {
    const jobs = this.db.listJobsForCode(code, workspace.safeProjectId(projectId));
    const warmup = observerWarmupCfgSec(this.cfg, jobs[jobs.length - 1]?.job_kind === "loop");
    const rec = graphs.loadTrafficGraph(this.projectWsRoot(projectId), code, warmup);
    if (rec == null) return { error: "bad_code", code };
    return rec;
  }

  nodeEvidence(code: string, nodeId: string, revision: string, projectId?: string | null) {
    if (projectId && !workspace.safeProjectId(projectId)) return { error: "bad_request" };
    return graphs.loadNodeEvidence(this.projectWsRoot(projectId), code, nodeId, revision);
  }

  progress(code: string, projectId?: string | null): Record<string, unknown> {
    return progress.snapshot(this.cfg, this.db, code, workspace.safeProjectId(projectId));
  }

  tokens(): Record<string, unknown> {
    return tokenboard.board(this.cfg);
  }

  sessions(projectId?: string | null): Record<string, unknown> {
    return sessionboard.board(this.cfg, projectId);
  }

  sessionCalls(code: string, projectId?: string | null): Record<string, unknown> {
    return sessionboard.challengeCalls(this.cfg, code, { projectId });
  }

  sessionCall(code: string, callId: string, projectId?: string | null): Record<string, unknown> {
    return sessionboard.challengeCall(this.cfg, code, callId, { projectId });
  }

  settingsBundle(): Record<string, unknown> {
    const custom = llmIo.readPrompt(this.cfg);
    return {
      settings: settings.snapshot(this.cfg),
      llm: llmIo.snapshot(this.cfg),
      platform: platform.snapshot(this.cfg),
      prompt: {
        system_prompt: custom,
        using_default: !custom.trim(),
        default_protocol: promptcat.defaultProtocol(),
      },
    };
  }

  updateSettings(payload: Record<string, unknown>): Record<string, unknown> {
    if (Object.keys(settings.FIELDS).some((k) => k in payload) || "agent_runtime" in payload) {
      settings.applyPayload(this.cfg, payload);
      settings.save(this.cfg);
    }
    if (payload.llm && typeof payload.llm === "object") llmIo.applyPayload(this.cfg, payload.llm);
    if (payload.platform && typeof payload.platform === "object") {
      platform.applyPayload(this.cfg, payload.platform);
      this.daemon = new Daemon(this.cfg, this.db, createBench(this.cfg, this.db));
    }
    if ("system_prompt" in payload) llmIo.writePrompt(this.cfg, String(payload.system_prompt || ""));
    else if (payload.prompt && typeof payload.prompt === "object" && "system_prompt" in (payload.prompt as Record<string, unknown>)) {
      llmIo.writePrompt(this.cfg, String((payload.prompt as Record<string, unknown>).system_prompt || ""));
    }
    return { ...this.settingsBundle(), ok: true };
  }

  projectBundle(projectId: string): Record<string, unknown> | null {
    const proj = workspace.getProject(this.cfg, projectId);
    if (!proj) return null;
    proj.tasks = workspace.listTasks(this.cfg, String(proj.id));
    proj.settings_fields = [...settings.PROJECT_FIELDS];
    proj.settings_defaults = settings.projectDefaults(this.cfg);
    proj.workspace_catalog = workspace.listWorkspaceCatalog(this.cfg.repo_root);
    proj.campaign = this.campaignView(String(proj.id));
    return proj;
  }

  updateProjectSettings(projectId: string, payload: Record<string, unknown>): Record<string, unknown> {
    const raw = payload.settings && typeof payload.settings === "object" ? payload.settings : payload;
    const overrides = settings.projectOverlay(raw || {});
    const rec = workspace.setProjectSettings(this.cfg, projectId, overrides);
    if (!rec) return { ok: false, error: "project not found" };
    rec.settings_fields = [...settings.PROJECT_FIELDS];
    rec.settings_defaults = settings.projectDefaults(this.cfg);
    rec.ok = true;
    return rec;
  }

  updateProjectStrategy(projectId: string, payload: Record<string, unknown>): Record<string, unknown> {
    let raw: Record<string, unknown> =
      payload.workspace_strategy && typeof payload.workspace_strategy === "object"
        ? { ...(payload.workspace_strategy as Record<string, unknown>) }
        : { ...payload };
    if (payload.preset && !("preset" in raw)) raw.preset = payload.preset;
    const rec = workspace.setProjectStrategy(this.cfg, projectId, raw);
    if (!rec) return { ok: false, error: "project not found" };
    rec.workspace_catalog = workspace.listWorkspaceCatalog(this.cfg.repo_root);
    rec.ok = true;
    return rec;
  }

  promptList(): Record<string, unknown> {
    return { ok: true, items: promptcat.listPrompts(this.cfg) };
  }

  promptGet(promptId: string): Record<string, unknown> {
    const rec = promptcat.getPrompt(this.cfg, promptId);
    if (!rec) return { ok: false, error: "unknown prompt" };
    return { ...rec, ok: true };
  }

  promptSave(promptId: string, payload: Record<string, unknown>): Record<string, unknown> {
    return { ...promptcat.writePrompt(this.cfg, promptId, String(payload.content || "")), ok: true };
  }

  promptReset(promptId: string): Record<string, unknown> {
    return { ...promptcat.resetPrompt(this.cfg, promptId), ok: true };
  }

  vpnStatus(): Record<string, unknown> {
    return { ...vpnio.snapshot(this.cfg), ok: true };
  }

  async vpnUpload(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (payload.action === "disconnect") {
      await vpnio.disconnect(this.cfg);
      return this.vpnStatus();
    }
    if (vpnio.isConnecting()) throw new Error("VPN is connecting. Disconnect before replacing its profile.");
    const text = String(payload.content || payload.ovpn || "");
    const connect = Boolean(payload.connect ?? true);
    let path: string;
    if (text.trim()) path = vpnio.saveOvpn(this.cfg, text);
    else {
      path = vpnio.destPath(this.cfg);
      if (!existsSync(path)) throw new Error("先选择平台下的 .ovpn 文件");
    }
    if (connect) vpnio.connectAsync(this.cfg, true);
    return { ...vpnio.snapshot(this.cfg), ok: true, saved: path };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
