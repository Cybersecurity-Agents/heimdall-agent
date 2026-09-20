import { mkdirSync, readdirSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { Database } from "../shared/db.js";
import type { Bench, Challenge } from "../platforms/types.js";
import { loadFlags, scoredCorrect } from "../shared/completion.js";
import { looksLikeFlag } from "../shared/flag-scraper.js";
import { recordAcceptedSubmit } from "../observer/recap-state.js";
import { atomicJson, goalDir, pendingVerdict, readJsonObject,
  type GoalCheck, type GoalConfig, type GoalRecord, type GoalSnapshot } from "../shared/goal.js";

/** Only this controller writes authoritative acceptance to the database. Public
 * status.json and flags.json are projections/candidates, never completion proof. */
export class GoalController {
  private timer?: ReturnType<typeof setInterval>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private work: Promise<void> | null = null;
  private stopped = false;
  private lastRefresh = 0;
  private lastSweep = 0;
  private platform: Challenge | null = null;
  private platformError = "";
  private checker = new AbortController();
  private signalled = false;
  readonly owner = randomUUID();

  constructor(readonly db: Database, readonly client: Bench, readonly config: GoalConfig,
    readonly record: GoalRecord, private readonly onStop: () => void) {}

  start(): boolean {
    if (!this.db.claimGoal(this.record, this.owner)) return false;
    for (const name of ["requests", "responses"]) mkdirSync(join(goalDir(this.record.workspace), name), { recursive: true });
    this.publish();
    this.heartbeat = setInterval(() => {
      try { this.publish(); } catch (error) { console.warn(`goal heartbeat: ${error}`); this.checker.abort(); this.onStop(); }
    }, 1000);
    this.timer = setInterval(() => { void this.tick().catch(error => { console.warn(`goal tick: ${error}`); this.checker.abort(); this.onStop(); }); }, 250);
    return true;
  }

  private publish(): void {
    if (this.stopped) return;
    const stored = this.db.getGoal(this.record.workspace);
    if (stored?.state === "cancelled") {
      this.record.state = "cancelled"; this.record.reason = "operator_stop";
      this.checker.abort();
      if (!this.signalled) { this.signalled = true; this.onStop(); }
    }
    if (!this.db.saveGoal(this.record, this.owner)) {
      this.stopped = true;
      this.checker.abort();
      if (this.timer) clearInterval(this.timer);
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (!this.signalled) { this.signalled = true; this.onStop(); }
      return;
    }
    const snapshot: GoalSnapshot = { jobId: this.record.jobId!, spec: this.record.spec, verdict: this.record.verdict,
      state: this.record.state, heartbeatAt: Date.now() };
    try { atomicJson(join(goalDir(this.record.workspace), "status.json"), snapshot); }
    catch (e) {
      // A removed/unwritable workspace must not throw out of a timer and take
      // down the entire control plane. Stop this attempt and retain its goal.
      this.record.reason = `Cannot publish goal status: ${e}`;
      this.record.state = "waiting_verification";
      this.record.verdict = { ...this.record.verdict, state: "unknown", reason: this.record.reason };
      this.db.saveGoal(this.record, this.owner);
      if (!this.signalled) { this.signalled = true; this.onStop(); }
    }
  }

  private async refresh(): Promise<void> {
    this.lastRefresh = Date.now();
    if (this.record.spec.acceptance.kind !== "platform_flags") return;
    try {
      const all = await this.client.listChallenges();
      this.db.upsertChallenges(all);
      this.platform = all.find(c => c.unique_code === this.record.spec.code) || null;
      this.platformError = this.platform ? "" : "Challenge missing from platform response";
    } catch (e) { this.platformError = String(e); }
  }

  private async check(id: string, flag?: string): Promise<boolean> {
    const check = this.config.checks[id];
    if (!check) throw new Error(`Unknown registered goal check: ${id}`);
    return runGoalCheck(check, this.record.workspace, { task: this.record.spec, flag }, this.checker.signal);
  }

  async evaluate(refresh = false): Promise<void> {
    if (refresh) await this.refresh();
    const { spec } = this.record;
    const acceptance = spec.acceptance;
    const receipts = this.db.goalReceipts(spec);
    const verdict = pendingVerdict(spec);
    if (acceptance.kind === "checks") {
      try {
        // Always re-run checks. No model-provided or prior-revision success cache.
        for (const id of acceptance.checkIds) if (await this.check(id)) verdict.count++;
        verdict.requiredCount = acceptance.checkIds.length;
        verdict.assurance = "locally_verified";
        verdict.state = verdict.count === verdict.requiredCount ? "satisfied" : "unsatisfied";
        verdict.reason = `${verdict.count}/${verdict.requiredCount} registered checks passed`;
      } catch (e) { verdict.state = "unknown"; verdict.reason = String(e); }
    } else if (acceptance.kind === "local_flags") {
      verdict.count = receipts.filter(r => acceptance.validatorId ? r.verified === true : r.recorded === true).length;
      verdict.requiredCount = acceptance.requiredCount;
      verdict.assurance = acceptance.validatorId ? "locally_verified" : "recorded";
      verdict.state = verdict.count >= acceptance.requiredCount ? "satisfied" : "unsatisfied";
      verdict.reason = `${verdict.count}/${acceptance.requiredCount} ${acceptance.validatorId ? "validated flags" : "recorded candidates (not platform verified)"}`;
    } else {
      const accepted = receipts.filter(r => r.correct === true);
      const uniqueAccepted = new Set(accepted.map(r => r.matched_flag_index == null ? `flag:${r.flag}` : `index:${r.matched_flag_index}`)).size;
      const receiptTotal = Math.max(0, ...receipts.map(r => Number(r.total_flag_count || 0)));
      // Totals come from the controller's task context, platform or submit response,
      // never from solver edits to input.json. runOptions is captured before spawn.
      const total = acceptance.requiredCount ?? (this.platform?.flag_count || receiptTotal || Number(this.record.runOptions.flagCount || 0) || null);
      const receiptCount = Math.max(0, ...receipts.map(r => Number(r.correct_flag_count || 0)));
      verdict.count = Math.max(uniqueAccepted, receiptCount, this.platform?.correct_flag_count || 0);
      verdict.requiredCount = total;
      verdict.assurance = "platform_verified";
      const complete = this.platform?.is_completed === true || (total !== null && total > 0 && verdict.count >= total);
      verdict.state = complete ? "satisfied" : this.platformError ? "unknown" : "unsatisfied";
      verdict.reason = complete ? "Platform acceptance satisfied" : this.platformError || `${verdict.count}/${total ?? "unknown"} flags accepted; challenge is not complete`;
    }
    this.record.verdict = verdict;
    if (this.record.state !== "cancelled") {
      this.record.state = verdict.state === "satisfied" ? "succeeded" : verdict.state === "unknown" ? "waiting_verification" : "running";
      this.record.reason = verdict.reason;
    }
    this.publish();
    if (!this.stopped && this.record.state === "succeeded" && !this.signalled) {
      this.signalled = true;
      this.onStop();
    }
  }

  async submit(flag: string): Promise<Record<string, unknown>> {
    if (!looksLikeFlag(flag) || flag.length > 8192) throw new Error("Invalid flag candidate");
    if (this.record.state === "cancelled" || this.stopped) throw new Error("Task cancelled or controller stopped");
    const { spec } = this.record;
    const known = this.db.goalReceipts(spec).find(r => r.flag === flag);
    if (known) return known;
    if (this.record.verdict.state === "satisfied") return { skipped: true, reason: "complete" };
    let receipt: Record<string, unknown>;
    let submission: Awaited<ReturnType<Bench["submit"]>> | null = null;
    if (spec.acceptance.kind === "platform_flags") {
      // Ambiguous network failures aren't recorded as rejected flags: a later
      // refresh/retry must reconcile them with the platform.
      const result = await this.client.submit(spec.code, flag);
      submission = result;
      receipt = { ...result, correct: result.correct === true, via: "heimdall-submit" };
    } else if (spec.acceptance.kind === "local_flags") {
      const verified = spec.acceptance.validatorId ? await this.check(spec.acceptance.validatorId, flag) : null;
      receipt = { source: "direct", via: "heimdall-submit", recorded: true, correct: null, verified };
    } else throw new Error("This goal uses registered checks, not flag submission");
    const stored = this.db.getGoal(this.record.workspace);
    if (this.stopped || !stored || stored.state === "cancelled") throw new Error("Task stopped during submission; reconcile on resume");
    if (submission) {
      try { recordAcceptedSubmit(this.record.workspace, spec.code, flag, submission, this.record.jobId || undefined); } catch { /* evidence is retained in DB */ }
    }
    this.db.putGoalReceipt(spec, flag, receipt);
    this.db.addFlag({ jobId: this.record.jobId || "", uniqueCode: spec.code, flagValue: flag,
      source: spec.acceptance.kind === "local_flags" ? "direct" : "heimdall-submit",
      submitCorrect: receipt.correct == null ? null : scoredCorrect(receipt.correct), awarded: Number(receipt.awarded || 0) });
    const rows = loadFlags(this.record.workspace).filter(r => r.flag !== flag);
    atomicJson(join(this.record.workspace, "flags.json"), [...rows, { flag, ...receipt }]);
    await this.evaluate();
    return { flag, ...receipt };
  }

  tick(): Promise<void> {
    if (this.work) return this.work;
    if (this.stopped) return Promise.resolve();
    this.work = this.pump().catch(e => {
      this.record.reason = `Acceptance service: ${e}`;
      this.record.verdict = { ...this.record.verdict, state: "unknown", reason: this.record.reason };
      this.record.state = "waiting_verification";
      this.publish();
    }).finally(() => { this.work = null; });
    return this.work;
  }

  private async pump(): Promise<void> {
    if (this.record.state === "cancelled") return;
    const dir = goalDir(this.record.workspace);
    const names = readdirSync(join(dir, "requests")).filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).slice(0, 32);
    for (const name of names) {
      const path = join(dir, "requests", name);
      let response: Record<string, unknown>;
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.size > 16384) throw new Error("Invalid goal request");
        const request = readJsonObject(path);
        unlinkSync(path);
        if (request.jobId !== this.record.jobId) throw new Error("Stale goal request");
        if (request.op === "submit") response = await this.submit(String(request.flag || ""));
        else if (request.op === "status" || request.op === "check") {
          await this.evaluate(request.op === "check" || Date.now() - this.lastRefresh >= 5000);
          response = { ...this.record.verdict };
        } else throw new Error("Unknown goal operation");
      } catch (e) { response = { error: String(e) }; try { unlinkSync(path); } catch { /* consumed */ } }
      if (!this.stopped) atomicJson(join(dir, "responses", name), response);
    }
    if (this.stopped || this.record.state === "succeeded") return;
    if (Date.now() - this.lastSweep >= 2000 && this.record.spec.acceptance.kind !== "checks") {
      this.lastSweep = Date.now();
      const known = new Set(this.db.goalReceipts(this.record.spec).map(r => String(r.flag)));
      const candidates = [...new Set(loadFlags(this.record.workspace).map(r => String(r.flag || "").trim()))].filter(f => looksLikeFlag(f) && !known.has(f)).slice(0, 3);
      for (const flag of candidates) { await this.submit(flag); if (this.record.verdict.state === "satisfied") break; }
    }
    if (Date.now() - this.lastRefresh >= 5000) await this.evaluate(true);
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.stopped = true;
    this.checker.abort();
    try { await this.work; } finally { this.db.releaseGoal(this.record.workspace, this.owner); }
  }

  async settle(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.work;
    this.lastSweep = 0;
    await this.tick();
    await this.evaluate(true);
  }
}

export function runGoalCheck(check: GoalCheck, workspace: string, input: unknown, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Check cancelled")); return; }
    // Commands are registered by the operator; candidate data is stdin, never shell code.
    const child = spawn(check.command, check.args, { cwd: workspace, shell: false, detached: true,
      env: { PATH: process.env.PATH, HEIMDALL_WORKSPACE: workspace }, stdio: ["pipe", "ignore", "ignore"] });
    let expired = false;
    const stop = () => { expired = true; try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
    const timer = setTimeout(stop, check.timeoutSec * 1000);
    signal.addEventListener("abort", stop, { once: true });
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } };
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(input));
    child.once("error", e => { cleanup(); reject(e); });
    child.once("exit", code => { cleanup(); if (expired) reject(new Error("Acceptance check timed out or was cancelled")); else resolve(code === 0); });
  });
}
