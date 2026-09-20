import { startupOwnerAlive, findLocalJob } from "../local-process.js";
import { inspectLocalProcess, signalOwnedProcesses } from "../local-process.js";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Config } from "../../shared/config.js";
import type { Database } from "../../shared/db.js";
import { billed, emptyUsage, readTotals } from "../../shared/llm-usage.js";
import { observerWarmupCfgSec } from "../../shared/config.js";
import { challengeWorkspace } from "./workspace.js";

const ACTIVE = new Set(["queued", "starting", "running", "stopping"]);
const SNIPPET = 220;
const LINE_LIMIT = 16;
const TOOL_KEYS = ["command", "cmd", "skill", "url", "path", "file_path", "query", "pattern", "description"] as const;

function oneLine(text: unknown, limit = SNIPPET): string {
  const s = String(text || "").split(/\s+/).join(" ");
  if (s.length <= limit) return s;
  return `${s.slice(0, limit - 1)}…`;
}

function wsPath(cfg: Config, code: string, projectId?: string | null): string {
  if (projectId) return challengeWorkspace(cfg, code, projectId);
  return join(cfg.workspaces_dir, code);
}

function payloadOf(rec: Record<string, unknown>): Record<string, unknown> {
  return rec.payload && typeof rec.payload === "object" && !Array.isArray(rec.payload)
    ? (rec.payload as Record<string, unknown>)
    : {};
}

function messageType(rec: Record<string, unknown>, payload: Record<string, unknown>): string {
  return String(rec.message_type || payload.type || "").toLowerCase();
}

function isNoiseRecord(rec: Record<string, unknown>): boolean {
  if (String(rec.kind || "") !== "message") return false;
  const payload = payloadOf(rec);
  const mt = messageType(rec, payload);
  const nested = payload.data && typeof payload.data === "object" ? (payload.data as Record<string, unknown>) : null;
  const subtype = String(payload.subtype || nested?.subtype || "").toLowerCase();
  if (subtype === "thinking_tokens") return true;
  if (mt === "system" || mt === "systemmessage") return true;
  if (mt === "user" || mt === "usermessage") return true;
  if (mt === "result" || mt.includes("task") || mt === "tool_progress") return true;
  return false;
}

function isAssistant(rec: Record<string, unknown>, payload: Record<string, unknown>): boolean {
  const mt = messageType(rec, payload);
  return mt === "assistant" || mt === "assistantmessage";
}

function contentBlocks(payload: Record<string, unknown>): Record<string, unknown>[] {
  const nested =
    payload.message && typeof payload.message === "object" && !Array.isArray(payload.message)
      ? (payload.message as Record<string, unknown>)
      : null;
  const content = payload.content ?? nested?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x));
}

function toolSnippet(part: Record<string, unknown>): string | null {
  const ptype = String(part.type || "").toLowerCase();
  const name = String(part.name || part.toolName || "");
  const input = part.input || part.arguments || part.tool_input;
  const isTool =
    ptype === "tool_use" ||
    ptype === "toolcall" ||
    (ptype.includes("tool") && !ptype.includes("result")) ||
    Boolean(name && input && typeof input === "object");
  if (!isTool) return null;
  const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  let cmd = "";
  for (const key of TOOL_KEYS) {
    if (args[key]) {
      cmd = String(args[key]);
      break;
    }
  }
  return `${name || "tool"} ${oneLine(cmd)}`.trim();
}

function summarizeBlocks(blocks: Record<string, unknown>[]): { line: string; kind: "tool" | "text" | "think" } | null {
  let tool: string | null = null;
  let text: string | null = null;
  let think: string | null = null;
  for (const part of blocks) {
    const snippet = toolSnippet(part);
    if (snippet) {
      tool = snippet;
      continue;
    }
    const ptype = String(part.type || "").toLowerCase();
    if (ptype === "text" || typeof part.text === "string") {
      const s = oneLine(part.text);
      if (s) text = s;
    } else if (ptype === "thinking" || typeof part.thinking === "string") {
      const s = oneLine(part.thinking, 72);
      if (s) think = s;
    }
  }
  if (tool) return { line: tool, kind: "tool" };
  if (text) return { line: text, kind: "text" };
  if (think) return { line: `思考 ${think}`, kind: "think" };
  return null;
}

function readFileTail(path: string, maxBytes: number): { text: string; size: number; hitStart: boolean } {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { text: "", size: 0, hitStart: true };
  }
  try {
    const size = fstatSync(fd).size;
    if (size <= 0) return { text: "", size, hitStart: true };
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return { text, size, hitStart: start === 0 };
  } finally {
    closeSync(fd);
  }
}

function parseJsonlRecords(text: string, skipNoise: boolean): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (skipNoise && t.includes("thinking_tokens")) continue;
    try {
      const rec = JSON.parse(t) as unknown;
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
      const row = rec as Record<string, unknown>;
      if (skipNoise && isNoiseRecord(row)) continue;
      rows.push(row);
    } catch {
      continue;
    }
  }
  return rows;
}

function recentRecords(path: string, want: number): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  let bytes = 512 * 1024;
  const maxBytes = 8 * 1024 * 1024;
  let rows: Record<string, unknown>[] = [];
  for (;;) {
    const { text, hitStart } = readFileTail(path, bytes);
    rows = parseJsonlRecords(text, true);
    if (rows.length >= want || hitStart || bytes >= maxBytes) return rows.slice(-want);
    bytes = Math.min(maxBytes, bytes * 2);
  }
}

function tailJsonl(path: string, maxLines = 80): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  const { text } = readFileTail(path, Math.max(256_000, maxLines * 8192));
  return parseJsonlRecords(text, false).slice(-maxLines);
}

function pushLine(out: string[], line: string): void {
  if (!line) return;
  if (out.length && out[out.length - 1] === line) return;
  const prev = out[out.length - 1];
  if (line.startsWith("思考 ") && prev && prev.startsWith("思考 ")) {
    out[out.length - 1] = line;
    return;
  }
  out.push(line);
}

export function summarizeEvents(path: string, limit = LINE_LIMIT): string[] {
  const out: string[] = [];
  let turns = 0;
  for (const rec of recentRecords(path, 120)) {
    const kind = String(rec.kind || "");
    const payload = payloadOf(rec);
    if (kind === "agent_start") {
      pushLine(out, `启动 ${String(payload.backend_chosen || payload.backend_requested || "agent")}`);
    } else if (kind === "sdk_start") {
      pushLine(out, "启动 sdk");
    } else if (kind === "pi_start") {
      pushLine(out, "启动 pi");
    } else if (kind === "sdk_error" || kind === "pi_error") {
      const err = oneLine(payload.error, 96);
      pushLine(out, `${kind === "sdk_error" ? "sdk" : "pi"} 失败${err ? ` ${err}` : ""}`);
    } else if (kind === "message" && isAssistant(rec, payload)) {
      const bit = summarizeBlocks(contentBlocks(payload));
      if (!bit) continue;
      if (bit.kind === "think") {
        pushLine(out, bit.line);
      } else {
        if (out.length && out[out.length - 1]!.startsWith("思考 ")) out.pop();
        turns += 1;
        const n = Number(payload.turn);
        const tag = Number.isFinite(n) && n > 0 ? n : turns;
        pushLine(out, `#${tag} ${bit.line}`);
      }
    } else if (kind === "pi_turn_end") {
      const bit = summarizeBlocks(contentBlocks(payload));
      if (!bit) continue;
      if (bit.kind === "think") {
        pushLine(out, bit.line);
      } else {
        if (out.length && out[out.length - 1]!.startsWith("思考 ")) out.pop();
        const n = Number(payload.turn);
        turns += 1;
        const tag = Number.isFinite(n) && n > 0 ? n : turns;
        pushLine(out, `#${tag} ${bit.line}`);
      }
    } else if (kind === "agent_done") {
      const extra = payload.turns != null ? ` 轮次 ${payload.turns}` : "";
      const flag = payload.has_correct_submit ? " 已交 flag" : "";
      pushLine(out, `结束 exit=${payload.exit_code}${extra}${flag}`);
    }
  }
  return out.slice(-limit);
}

function eventTotals(path: string): { turns: number | null; tools: number | null } {
  let turns = 0;
  let tools = 0;
  let seen = false;
  for (const rec of recentRecords(path, 200)) {
    const payload = payloadOf(rec);
    if (rec.kind === "agent_done" && payload.turns != null) {
      return { turns: Number(payload.turns), tools: Number(payload.tool_uses || tools) };
    }
    if (rec.kind === "pi_turn_end") {
      seen = true;
      turns += 1;
      for (const part of contentBlocks(payload)) {
        if (toolSnippet(part)) tools += 1;
      }
    } else if (rec.kind === "message" && isAssistant(rec, payload)) {
      let used = false;
      for (const part of contentBlocks(payload)) {
        if (toolSnippet(part)) {
          tools += 1;
          used = true;
        } else if (String(part.type || "") === "text" && String(part.text || "").trim()) {
          used = true;
        }
      }
      if (used) {
        seen = true;
        turns += 1;
      }
    }
  }
  return seen ? { turns, tools } : { turns: null, tools: null };
}

export function inspectContainer(cid: string): { status: string | null; exit: number | null } {
  if (!cid) return { status: null, exit: null };
  if (cid.startsWith("local-")) return { status: null, exit: null };
  try {
    const out = execFileSync("docker", ["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", cid], {
      encoding: "utf8",
      timeout: 4000,
    }).trim();
    const [st, code] = out.split(/\s+/);
    return { status: st || null, exit: code != null ? Number.parseInt(code, 10) : null };
  } catch (e) {
    const msg = String(e);
    if (msg.includes("No such object") || msg.includes("no such container")) return { status: "missing", exit: null };
    return { status: null, exit: null };
  }
}

export function harvestJob(db: Database, job: Record<string, unknown>): Record<string, unknown> {
  const status = String(job.status || "").toLowerCase();
  if (!ACTIVE.has(status)) return job;
  let cid = String(job.container_id || "").trim();
  const cancelled = status === "stopping" && ["operator_stop", "project_deleted"].includes(String(job.terminal_reason));
  if (!cid && job.startup_owner) {
    if (startupOwnerAlive(job.startup_owner) !== false) {
      if (Number(job.startup_deadline) < Date.now()/1000) {
        const error = "Startup deadline exceeded; waiting for the owning controller to release the reservation";
        db.updateJob(String(job.id), { error }); return { ...job, error };
      }
      return job;
    }
    if (!Number(job.runtime_launching)) {
      const update = { status: cancelled ? "cancelled" : "failed", finished_at: Date.now()/1000,
        terminal_reason: cancelled ? "operator_stop" : "startup_lost", counts_as_attempt: 0,
        error: "Control process exited before runtime launch" };
      db.updateJob(String(job.id), update); return { ...job, ...update };
    }
    cid = String(job.runtime_name || "");
    if (job.runtime_kind === "local" && !existsSync(join(String(job.job_dir), "runtime.json"))) {
      const processes = findLocalJob(String(job.id));
      if (processes === null || processes.length) return job;
      const update = { status: cancelled ? "cancelled" : "failed", finished_at: Date.now()/1000,
        terminal_reason: cancelled ? "operator_stop" : "startup_lost", counts_as_attempt: 0, error: "No owned runtime survived startup" };
      db.updateJob(String(job.id), update); return { ...job, ...update };
    }
  }
  const started = Number(job.started_at || 0);
  const age = started ? Date.now() / 1000 - started : 0;
  const ws = String(job.workspace_path || "");
  const goal = db.getGoal(ws);
  const verified = goal !== null && goal.jobId === job.id && goal.state === "succeeded" && goal.verdict.state === "satisfied";
  const events = join(ws, ".heimdall", "events.jsonl");
  const doneRows = tailJsonl(events, 30).filter((r) => r.kind === "agent_done"
    && Number(r.ts || 0) >= started && (!r.job_id || r.job_id === job.id));
  const last = doneRows[doneRows.length - 1];
  const done = last && last.payload && typeof last.payload === "object" ? (last.payload as Record<string, unknown>) : null;
  let st: string | null = null;
  let exitCode: number | null = null;
  if (cid.startsWith("local-") || cid.startsWith("host-")) {
    const local = inspectLocalProcess(String(job.id), String(job.job_dir || ""));
    if (local.status === "running" || local.status === "unknown") return job;
    if (local.owner) signalOwnedProcesses(local.owner, "SIGKILL");
    // Runner finalization owns normal completion. Recovery only uses evidence
    // from this job's runtime record, never another attempt's workspace events.
    st = local.status;
    exitCode = local.exit;
    const timedOut = Boolean(local.timedOut);
    const newStatus = cancelled ? "cancelled" : verified ? "succeeded" : timedOut ? "timeout" : "failed";
    const update = { status: newStatus, finished_at: Date.now() / 1000, exit_code: exitCode,
      terminal_reason: cancelled ? "operator_stop" : local.status === "missing" ? "process_lost" : "runtime_recovered",
      error: local.error || (local.status === "missing" ? "Workspace process no longer exists" : null), counts_as_attempt: Number(job.counts_as_attempt ?? 1) };
    db.updateJob(String(job.id), update);
    return { ...job, ...update };
  }
  if (cid) {
    const inspected = inspectContainer(cid);
    st = inspected.status;
    exitCode = inspected.exit;
    if (st === "running") return job;
    // An unavailable Docker daemon is not proof that a container exited.
    if (st == null) {
      const error = "Docker runtime state unavailable; capacity remains reserved until exit is confirmed";
      db.updateJob(String(job.id), { error }); return { ...job, error };
    }
    if (st === "created" || st === "restarting" || st === "paused") return job;
  } else if (age < 20 && !done) {
    return job;
  } else if (!cid && !done) {
    // Legacy rows without trustworthy runtime metadata require inspection, never
    // an invented completion or silent permanent "running" state.
    const error = "Runtime identity unavailable; inspect the executor before retrying";
    db.updateJob(String(job.id), { error });
    return { ...job, error };
  }
  if (done && exitCode == null && done.exit_code != null) exitCode = Number(done.exit_code);
  const ok = verified;
  const newStatus = cancelled ? "cancelled" : ok ? "succeeded" : "failed";
  let finished = Date.now() / 1000;
  if (last?.ts) {
    const ts = Number(last.ts);
    if (Number.isFinite(ts)) finished = ts;
  }
  try {
    db.updateJob(String(job.id), {
      status: newStatus,
      finished_at: finished,
      exit_code: exitCode,
      terminal_reason: cancelled ? "operator_stop" : "harvested",
      counts_as_attempt: Number(job.counts_as_attempt ?? 1),
      error: ok ? null : job.error || "container exited",
    });
  } catch {
    return job;
  }
  return { ...job, status: newStatus, finished_at: finished, exit_code: exitCode, terminal_reason: cancelled ? "operator_stop" : "harvested" };
}

export function harvestCode(cfg: Config, db: Database, code: string): void {
  for (const job of db.listJobsForCode(code)) harvestJob(db, job);
}

export function snapshot(
  cfg: Config,
  db: Database,
  code: string,
  projectId?: string | null,
): Record<string, unknown> {
  harvestCode(cfg, db, code);
  const jobs = [...db.listJobsForCode(code, projectId)].reverse();
  let job = jobs[0] || null;
  if (job) job = harvestJob(db, job);
  let ws = job ? String(job.workspace_path || "") : "";
  if (!ws || !existsSync(ws)) ws = wsPath(cfg, code, projectId);
  const events = join(ws, ".heimdall", "events.jsonl");
  const traffic = join(ws, ".heimdall", "traffic");
  const hasGraph = ["graph.json", "map.json", "cover.json"].some((n) => existsSync(join(traffic, n)));
  const totals = eventTotals(events);
  const started = Number((job || {}).started_at || 0);
  const finished = Number((job || {}).finished_at || 0);
  const now = Date.now() / 1000;
  const elapsed = started ? Math.trunc((finished || now) - started) : null;
  const warmup = observerWarmupCfgSec(cfg, job?.job_kind === "loop");
  const status = String((job || {}).status || "");
  let wait: number | null = null;
  if (ACTIVE.has(status) && started && !hasGraph) wait = Math.max(0, warmup - Math.trunc(now - started));
  const usage = readTotals(ws) || emptyUsage();
  const tokens: Record<string, unknown> = { ...usage, total_tokens: billed(usage) };
  return {
    ok: true,
    code,
    job,
    goal: db.getGoal(ws),
    goal_state: db.getGoal(ws)?.state || null,
    status: status || "idle",
    turns: totals.turns,
    tools: totals.tools,
    elapsed_sec: elapsed,
    has_graph: hasGraph,
    observer_warmup_sec: warmup,
    observer_wait_sec: wait,
    lines: summarizeEvents(events),
    tokens,
  };
}
