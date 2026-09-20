import { hasObservationPublication } from "../shared/observation-publication.js";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { envBool } from "../shared/env.js";
import { atomicWrite, nowSec } from "../shared/fsutil.js";
import {
  injectTxt,
  jobHintText,
  platformHintJson,
  startedAtPath,
  workspaceDir,
} from "../shared/paths.js";
import { mergeHintIntoInject } from "./render.js";

export const DEFAULT_AFTER_SEC = 1800;

export class HintUnavailable extends Error {
  reason: string;
  terminal: boolean;
  constructor(reason: string, opts: { terminal?: boolean } = {}) {
    super(reason);
    this.name = "HintUnavailable";
    this.reason = reason;
    this.terminal = Boolean(opts.terminal);
  }
}

export function isLoopJob(): boolean {
  return envBool("HEIMDALL_LOOP", false);
}

export function hintAfterSec(): number {
  const raw = (process.env.HEIMDALL_HINT_AFTER_SEC || "").trim();
  if (!raw) return DEFAULT_AFTER_SEC;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? Math.max(60, n) : DEFAULT_AFTER_SEC;
}

function challengeType(workspace?: string | null): string {
  let raw = (process.env.HEIMDALL_CHALLENGE_TYPE || "").trim().toLowerCase();
  if (!raw) {
    const inp = join(workspaceDir(workspace), "input.json");
    if (existsSync(inp)) {
      try {
        const doc = JSON.parse(readFileSync(inp, "utf8")) as { challenge_type?: unknown };
        if (doc && typeof doc === "object") raw = String(doc.challenge_type || "").trim().toLowerCase();
      } catch {
        raw = "";
      }
    }
  }
  if (raw === "pentest") return "intranet";
  if (["ai", "llm", "aiagent", "ai-agent"].includes(raw)) return "web";
  return raw;
}

export function hintOnFirstLoop(workspace?: string | null): boolean {
  const raw = (process.env.HEIMDALL_HINT_FIRST_LOOP || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  const ctype = challengeType(workspace);
  if (ctype === "intranet" || ctype === "pentest") return false;
  return true;
}

/** Start the hint clock for this loop visit. Leftover stamps from Pi / loop 1 must not fire /hint early. */
export function resetHintClock(workspace?: string | null): void {
  const p = startedAtPath(workspace);
  try {
    unlinkSync(p);
  } catch {
    /* ignore */
  }
}

export function loopRound(workspace?: string | null): number {
  if (!isLoopJob()) return 0;
  const raw = (process.env.HEIMDALL_LOOP_N || "").trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) return Math.max(0, n);
  }
  const inp = join(workspaceDir(workspace), "input.json");
  if (existsSync(inp)) {
    try {
      const doc = JSON.parse(readFileSync(inp, "utf8")) as { loop_n?: unknown };
      if (doc && typeof doc === "object" && doc.loop_n != null) {
        const n = Number.parseInt(String(doc.loop_n), 10);
        if (Number.isFinite(n)) return Math.max(0, n);
      }
    } catch {
      /* ignore */
    }
  }
  return 1;
}

export function hintPermitted(workspace?: string | null): [boolean, string] {
  if (!isLoopJob()) return [false, "not_loop"];
  if (challengeComplete(workspace)) return [false, "complete"];
  const n = loopRound(workspace);
  if (n < 2 && !hintOnFirstLoop(workspace)) return [false, "wait_second_loop"];
  if (jobAgeSec(workspace) < hintAfterSec()) return [false, "too_early"];
  return [true, "due"];
}

export function jobAgeSec(workspace?: string | null): number {
  ensureStartedAt(workspace);
  const p = startedAtPath(workspace);
  if (existsSync(p)) {
    try {
      return Math.max(0, nowSec() - Number.parseFloat(readFileSync(p, "utf8").trim()));
    } catch {
      /* ignore */
    }
  }
  return 0;
}

function challengeComplete(workspace?: string | null): boolean {
  const ws = workspaceDir(workspace);
  let doc: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(join(ws, "input.json"), "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) doc = raw as Record<string, unknown>;
  } catch {
    doc = {};
  }
  if (doc.is_completed) return true;
  const fc = Number.parseInt(String(doc.flag_count || 0), 10) || 0;
  if (fc <= 0) return false;
  try {
    const flags = JSON.parse(readFileSync(join(ws, "flags.json"), "utf8")) as unknown;
    const items = Array.isArray(flags)
      ? flags
      : flags && typeof flags === "object"
        ? ((flags as { flags?: unknown[] }).flags || [])
        : [];
    const n = items.filter((x) => x && typeof x === "object" && (x as { correct?: unknown }).correct).length;
    return n >= fc;
  } catch {
    return false;
  }
}

function uniqueCode(workspace?: string | null): string {
  const env = (process.env.UNIQUE_CODE || "").trim();
  if (env) return env;
  const inp = join(workspaceDir(workspace), "input.json");
  if (existsSync(inp)) {
    try {
      const doc = JSON.parse(readFileSync(inp, "utf8")) as { unique_code?: unknown };
      if (doc && typeof doc === "object") return String(doc.unique_code || "").trim();
    } catch {
      /* ignore */
    }
  }
  return "";
}

export function ensureStartedAt(workspace?: string | null): void {
  const p = startedAtPath(workspace);
  if (existsSync(p)) {
    try {
      Number.parseFloat(readFileSync(p, "utf8").trim());
      return;
    } catch {
      /* rewrite */
    }
  }
  try {
    atomicWrite(p, `${nowSec()}\n`);
  } catch {
    /* ignore */
  }
}

export function loadHintRecord(workspace?: string | null): Record<string, unknown> | null {
  const p = platformHintJson(workspace);
  if (!existsSync(p)) return null;
  try {
    const doc = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractHint(doc: unknown): string {
  if (typeof doc === "string") return doc.trim();
  if (!doc || typeof doc !== "object") return "";
  const rec = doc as Record<string, unknown>;
  for (const key of ["hint", "Hint"]) {
    const val = rec[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  if (rec.data && typeof rec.data === "object") return extractHint(rec.data);
  return "";
}

export type HintCliDecision =
  | { action: "fetch"; reason: string }
  | { action: "reuse"; reason: string; hint: string }
  | { action: "deny"; reason: string };

export function hintCliDecision(workspace?: string | null): HintCliDecision {
  const rec = loadHintRecord(workspace);
  const [done, text] = recordIsFinal(rec, workspace);
  if (done && text) return { action: "reuse", reason: "already_taken", hint: text };
  if (done) return { action: "deny", reason: "already_taken" };
  const [ok, reason] = hintPermitted(workspace);
  if (!ok) return { action: "deny", reason };
  return { action: "fetch", reason: "due" };
}

function recordIsFinal(rec: Record<string, unknown> | null, workspace?: string | null): [boolean, string] {
  const disk = jobHintText(workspace);
  if (disk) return [true, disk];
  if (!rec) return [false, ""];
  const text = String(rec.hint || "").trim();
  if (text) return [true, text];
  if (rec.ok === true || rec.terminal) return [true, ""];
  return [false, ""];
}

export async function maybeTakeHint(workspace?: string | null): Promise<string> {
  const rec = loadHintRecord(workspace);
  const [done, text] = recordIsFinal(rec, workspace);
  if (done) {
    if (text) ensureHintArtifacts(workspace, text);
    return text;
  }
  const [ok] = hintPermitted(workspace);
  if (!ok) return "";
  try {
    const fetched = await fetchHintAsync(workspace);
    persist(workspace, fetched || null, { ok: true });
    if (fetched) {
      refreshInject(workspace, fetched);
      console.log(`platform_hint taken (${fetched.length} chars)`);
    } else {
      console.log("platform_hint empty");
    }
    return fetched;
  } catch (exc) {
    if (exc instanceof HintUnavailable && exc.terminal) {
      persist(workspace, null, { ok: true, terminal: true, error: exc.reason });
      console.log(`platform_hint terminal (${exc.reason})`);
      return "";
    }
    const reasonText = exc instanceof HintUnavailable ? exc.reason : String(exc);
    persistAttempt(workspace, reasonText);
    console.log(`platform_hint retry (${reasonText})`);
    return "";
  }
}

async function fetchHintAsync(workspace?: string | null): Promise<string> {
  const base = (process.env.BENCHMARK_BASE_URL || "").trim().replace(/\/+$/, "");
  const token = (process.env.BENCHMARK_TOKEN || "").trim();
  const code = uniqueCode(workspace);
  if (!(base && token && code)) {
    throw new HintUnavailable(
      "missing_env" +
        (base ? "" : ":BENCHMARK_BASE_URL") +
        (token ? "" : ":BENCHMARK_TOKEN") +
        (code ? "" : ":UNIQUE_CODE"),
    );
  }
  const url = `${base}/openapi/v1/challenges/hint?unique_code=${encodeURIComponent(code)}`;
  let status = 0;
  let raw = "";
  try {
    const resp = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL(url);
      const lib = u.protocol === "https:" ? httpsRequest : httpRequest;
      const req = lib(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: u.pathname + u.search,
          method: "GET",
          headers: { BENCHMARK_TOKEN: token },
          timeout: 20_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c as Buffer));
          res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("error", (e) => reject(new HintUnavailable(`net:${e}`)));
      req.on("timeout", () => {
        req.destroy();
        reject(new HintUnavailable("net:timeout"));
      });
      req.end();
    });
    status = resp.status;
    raw = resp.body;
  } catch (exc) {
    if (exc instanceof HintUnavailable) throw exc;
    throw new HintUnavailable(`net:${exc}`);
  }
  if (status === 409) throw new HintUnavailable(`http_${status}`, { terminal: true });
  if (status && status !== 200) throw new HintUnavailable(`http_${status}`);
  let doc: unknown = {};
  try {
    doc = raw ? JSON.parse(raw) : {};
  } catch {
    throw new HintUnavailable("bad_json");
  }
  return extractHint(doc);
}

function persist(
  workspace: string | null | undefined,
  hint: string | null,
  opts: { ok: boolean; terminal?: boolean; error?: string },
): void {
  const rec: Record<string, unknown> = {
    taken: Boolean(opts.ok),
    ok: Boolean(opts.ok),
    terminal: Boolean(opts.terminal),
    ts: nowSec(),
    hint: hint || null,
  };
  if (opts.error) rec.error = opts.error;
  atomicWrite(platformHintJson(workspace), JSON.stringify(rec, null, 2) + "\n");
  if (hint) atomicWrite(join(workspaceDir(workspace), "hint.txt"), hint + "\n");
}

function persistAttempt(workspace: string | null | undefined, error: string): void {
  const prev = loadHintRecord(workspace) || {};
  let attempts = 1;
  try {
    attempts = (Number.parseInt(String(prev.attempts || 0), 10) || 0) + 1;
  } catch {
    attempts = 1;
  }
  atomicWrite(
    platformHintJson(workspace),
    JSON.stringify(
      {
        taken: false,
        ok: false,
        terminal: false,
        ts: nowSec(),
        hint: null,
        error,
        attempts,
      },
      null,
      2,
    ) + "\n",
  );
}

function ensureHintArtifacts(workspace: string | null | undefined, hint: string): void {
  if (!hint) return;
  const ht = join(workspaceDir(workspace), "hint.txt");
  let current = "";
  try {
    current = existsSync(ht) ? readFileSync(ht, "utf8").trim() : "";
  } catch {
    current = "";
  }
  if (current !== hint) {
    try {
      atomicWrite(ht, hint + "\n");
    } catch {
      /* ignore */
    }
  }
  let body = "";
  try {
    body = existsSync(injectTxt(workspace)) ? readFileSync(injectTxt(workspace), "utf8") : "";
  } catch {
    body = "";
  }
  const probe = hint.trim().split("\n")[0]?.trim().slice(0, 48) || "";
  if (!probe || !body.includes(probe)) refreshInject(workspace, hint);
}

function refreshInject(workspace: string | null | undefined, hint: string): void {
  if (hasObservationPublication(workspace)) return;
  if (!hint) return;
  try {
    let body = "";
    try {
      body = existsSync(injectTxt(workspace)) ? readFileSync(injectTxt(workspace), "utf8") : "";
    } catch {
      body = "";
    }
    const blob = mergeHintIntoInject(body, hint);
    if (blob) atomicWrite(injectTxt(workspace), blob);
  } catch (exc) {
    console.log(`hint inject refresh failed: ${exc}`);
  }
}

export function watchHint(workspace?: string | null, interval = 8): () => void {
  const [ok, reason] = hintPermitted(workspace);
  if (!ok && reason !== "too_early") return () => undefined;
  const poll = Math.max(3, interval);
  let stopped = false;
  let backoff = poll;
  const tick = async (): Promise<void> => {
    while (!stopped) {
      try {
        ensureStartedAt(workspace);
        const rec = loadHintRecord(workspace);
        const [done, text] = recordIsFinal(rec, workspace);
        if (done) {
          if (text) ensureHintArtifacts(workspace, text);
          return;
        }
        const [permitted, why] = hintPermitted(workspace);
        if (["not_loop", "loop", "has_brief", "wait_second_loop", "complete"].includes(why)) return;
        if (why === "too_early") {
          const remaining = hintAfterSec() - jobAgeSec(workspace);
          const wait = Math.min(poll, Math.max(1, remaining));
          await sleep(wait * 1000);
          continue;
        }
        if (permitted) {
          const got = await maybeTakeHint(workspace);
          const rec2 = loadHintRecord(workspace);
          const [fin] = recordIsFinal(rec2, workspace);
          if (got || fin) return;
          await sleep(backoff * 1000);
          backoff = Math.min(backoff * 1.5, 60);
          continue;
        }
      } catch (exc) {
        console.log(`hint watch: ${exc}`);
      }
      await sleep(backoff * 1000);
      backoff = Math.min(backoff * 1.5, 60);
    }
  };
  void tick();
  return () => {
    stopped = true;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
