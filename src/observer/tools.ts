import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ContextSchema, SubmitSchema, parseSubmission, ObservationValidationError, type ObservationSubmit } from "./contract.js";
import { compileObservation, observationArtifacts, type ObservationInputs } from "./compile.js";
import { loadObservation, mergeObservation, submissionHash, type ObservationCursor } from "./state.js";
import { collectEvidence, redactEvidence } from "./evidence.js";
import { acceptedReceipts, currentJobId, readRecord } from "./recap-state.js";
import { loadCursor, saveCursor } from "./delta.js";
import { deltaMd, graphJson, readText, trafficDir, turnsJsonl } from "../shared/paths.js";
import { jobHintText } from "../shared/paths.js";
import { commitObservationPublication, publishedArtifact } from "../shared/observation-publication.js";
import { sprayEnabled } from "./spray.js";
import type { Evidence, NodeDetails } from "../shared/observer-contract.js";

const pendingPath = (ws: string) => join(trafficDir(ws), "observe_cursor.pending.json");
const clearPending = (ws: string): void => {
  for (const path of [pendingPath(ws), join(trafficDir(ws), "observe_excerpts.pending.json")]) if (existsSync(path)) unlinkSync(path);
};

/** Repair the cursor cache after a crash between the publication commit and cursor cleanup. */
export function recoverObservationCursor(ws: string): void {
  const state = loadObservation(ws);
  const graph = readRecord<{ publication?: { jobId: string; phase: string } }>(graphJson(ws));
  if (state.revision && graph?.publication?.jobId === state.jobId && graph.publication.phase !== "observe") {
    saveCursor(ws, state.cursor);
    clearPending(ws);
    return;
  }
  const pending = readRecord<ObservationCursor>(pendingPath(ws));
  if (state.revision && pending && pending.events_byte === state.cursor.events_byte && pending.http_byte === state.cursor.http_byte && (pending.turns_byte || 0) === state.cursor.turns_byte) {
    saveCursor(ws, state.cursor);
    clearPending(ws);
  }
}

function frozenEvidence(ws: string): Record<string, Evidence> {
  const refs = new Set<string>(["input:task"]);
  if (existsSync(join(ws, "hint.txt"))) refs.add("input:hint");
  if (existsSync(turnsJsonl(ws))) for (const line of readFileSync(turnsJsonl(ws), "utf8").split("\n")) {
    try { const row = JSON.parse(line); if (Number.isSafeInteger(row.n) && row.n > 0) refs.add(`turn:${row.n}`); } catch { /* corrupt ledger row */ }
  }
  const receipts = acceptedReceipts(ws, currentJobId(ws));
  for (const receipt of receipts) refs.add(`receipt:${receipt.id}`);
  const current = Object.fromEntries(Object.entries(collectEvidence(ws, [{ evidenceRefs: [...refs], steps: [], summary: { conclusion: "", basis: "", uncertainty: null } }], receipts)).filter(([, item]) => item.jobId === currentJobId(ws)));
  const previous = readRecord<{ publication: { jobId: string }; items: Record<string, Evidence> }>(publishedArtifact(ws, "evidence.json"));
  if (previous?.publication.jobId === currentJobId(ws)) {
    for (const [ref, item] of Object.entries(previous.items)) {
      if (item.jobId === currentJobId(ws) && item.kind === "excerpt") current[ref] = item;
    }
  }
  return current;
}

export type SubmitOutcome = { ok: boolean; revision?: string; unchanged?: boolean; warnings?: string[]; errors?: { path: string; code: string; message: string }[] };

/** One fixed input window and at most one successful publication per observer tick. */
export class ObservationTurn {
  readonly base;
  readonly cursor: ObservationCursor;
  readonly input: ObservationInputs;
  readonly delta: string;
  readonly task: Record<string, unknown>;
  attempts = 0;
  published: SubmitOutcome | null = null;
  lastFailure: SubmitOutcome | null = null;
  private acceptedHash: string | null = null;
  private closed = false;

  constructor(readonly ws: string, private readonly owns: () => boolean = () => true) {
    this.base = loadObservation(ws);
    const pending = readRecord<ObservationCursor>(pendingPath(ws)) || loadCursor(ws);
    this.cursor = { events_byte: pending.events_byte, http_byte: pending.http_byte, turns_byte: pending.turns_byte || 0 };
    const task = readRecord<Record<string, unknown>>(join(ws, "input.json")) || {};
    this.task = Object.fromEntries(["unique_code", "name", "title", "description", "url", "target", "flag_count"].filter(k => task[k] !== undefined).map(k => [k, task[k]]));
    this.input = { evidence: frozenEvidence(ws), receipts: acceptedReceipts(ws, currentJobId(ws)), hint: jobHintText(ws),
      code: String(task.unique_code || ""), dictionaryEnabled: sprayEnabled(ws) };
    this.delta = readText(deltaMd(ws));
  }

  close(): void { this.closed = true; }

  isActive(): boolean {
    return !this.closed && this.owns() && currentJobId(this.ws) === this.base.jobId
      && !existsSync(join(this.ws, ".heimdall", "observer.stop"));
  }

  context(options: { evidenceRefs?: string[]; assessmentIds?: string[] } = {}) {
    return { baseRevision: this.base.revision, window: this.cursor, task: this.task, hint: this.input.hint,
      delta: this.delta, guidance: this.base.guidance, submissionAttempts: this.attempts, published: this.published,
      lastErrors: this.lastFailure?.errors || [],
      assessments: this.base.assessments.map(a => options.assessmentIds?.includes(a.id) ? a : { ...a,
        attempts: a.attempts.slice(-3), totalAttempts: a.attempts.length }),
      retired: this.base.retired.map(a => ({ id: a.id, subject: a.subject, conclusion: a.conclusion })),
      evidence: (options.evidenceRefs || []).map(ref => this.input.evidence[ref] || { ref, unavailable: "unknown_evidence" }),
      receipts: this.input.receipts.map(r => ({ ref: `receipt:${r.id}`, flagIndex: r.flagIndex, acceptedAt: r.acceptedAt })),
      ...(this.input.dictionaryEnabled ? { loot: this.base.loot } : {}) };
  }

  /** Runs before Pi's generic argument validator, so every malformed submission receives our complete diagnostics. */
  prepare(raw: unknown): ObservationSubmit {
    if (!this.isActive()) throw new ObservationValidationError([{ path: "/", code: "expired_window", message: "This observation window no longer owns the job." }]);
    if (!this.published) this.attempts += 1;
    try { return parseSubmission(raw); }
    catch (error) { this.failure(error); throw error; }
  }

  submit(raw: unknown): SubmitOutcome {
    try { return this.submitPrepared(this.prepare(raw)); }
    catch (error) { return this.failure(error); }
  }

  submitPrepared(request: ObservationSubmit): SubmitOutcome {
    try {
      if (!this.isActive()) throw new ObservationValidationError([{ path: "/", code: "expired_window", message: "This observation window no longer owns the job." }]);
      const hash = submissionHash(request, this.cursor);
      if (this.published) {
        if (hash === this.acceptedHash) return this.published;
        throw new ObservationValidationError([{ path: "/", code: "already_published", message: "This tick already published. End the turn." }]);
      }
      const current = loadObservation(this.ws);
      if (current.submissionHash === hash) {
        this.acceptedHash = hash;
        return this.published = { ok: true, revision: current.revision!, unchanged: true };
      }
      if (current.revision !== this.base.revision) throw new ObservationValidationError([{ path: "/baseRevision", code: "stale_revision", message: "Another publication superseded this window." }]);
      const next = mergeObservation(this.base, request, this.input.evidence, this.input.dictionaryEnabled);
      const warnings = compileObservation(next, this.input).warnings;
      next.revision = randomUUID(); next.cursor = this.cursor;
      const previousGraph = existsSync(graphJson(this.ws)) ? readFileSync(graphJson(this.ws), "utf8") : null;
      const artifacts = observationArtifacts(this.ws, next, this.input, previousGraph);
      next.submissionHash = hash;
      artifacts["observation.json"] = JSON.stringify(next, (_key, value) => typeof value === "string" ? redactEvidence(value) : value, 2) + "\n";
      if (!this.owns()) throw new Error("observer lease lost before commit");
      commitObservationPublication(this.ws, next.revision, artifacts);
      this.acceptedHash = hash;
      this.published = { ok: true, revision: next.revision, unchanged: request.upserts.length === 0 && request.retireIds.length === 0 && !request.guidance && !request.loot?.length, warnings };
      // Publication is durable even if updating this cache fails. Next tick recovers from observation.json.
      try { saveCursor(this.ws, this.cursor); clearPending(this.ws); }
      catch { warnings.push("Published successfully; cursor cache will be recovered before the next tick."); }
      return this.published;
    } catch (error) { return this.failure(error); }
  }

  private failure(error: unknown): SubmitOutcome {
    return this.lastFailure = { ok: false, errors: error instanceof ObservationValidationError ? error.issues : [{ path: "/", code: "publish_failed", message: String(error) }] };
  }

  tools(): ToolDefinition[] {
    const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });
    const context: ToolDefinition<typeof ContextSchema> = { name: "observation_context", label: "Observation context", description: "Read the fixed evidence window, current judgments and receipt references. Expand selected evidence or assessments on demand.",
        parameters: ContextSchema, execute: async (_id, args) => result(this.context(args)) };
    const submit: ToolDefinition<typeof SubmitSchema> = { name: "observation_submit", label: "Publish observation", description: "Submit flat judgment updates. The host validates and generates all graph/text artifacts. Correct errors in this same window until ok:true. Attempts merge by ID; omitted judgments and attempts are retained.",
        parameters: SubmitSchema, executionMode: "sequential", prepareArguments: raw => this.prepare(raw),
        execute: async (_id, args, signal) => {
          signal?.throwIfAborted();
          const outcome = this.submitPrepared(args);
          if (!outcome.ok) throw new ObservationValidationError(outcome.errors || []);
          return result(outcome);
        } };
    return [context, submit];
  }
}
