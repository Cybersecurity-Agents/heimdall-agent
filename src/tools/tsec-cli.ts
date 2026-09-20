#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isChallengeComplete, isDirectWorkspace, loadJson, recordLocalFlag } from "../shared/completion.js";
import { recordAcceptedSubmit } from "../observer/recap-state.js";
import { looksLikeFlag } from "../shared/flag-scraper.js";
import { hintCliDecision, maybeTakeHint } from "../observer/hint.js";
import { TsecClient, TsecError } from "../platforms/index.js";
import { afterSubmitShouldStop, capSubmitList, MAX_WRONG_STREAK } from "./tsec-policy.js";
import { atomicJson, goalRequest, managedGoal } from "../shared/goal.js";

function workspaceDir(): string {
  return (process.env.HEIMDALL_WORKSPACE || "").trim() || "/workspace";
}

function uniqueCode(arg?: string | null): string {
  if (arg?.trim()) return arg.trim();
  const env = (process.env.UNIQUE_CODE || "").trim();
  if (env) return env;
  const inp = join(workspaceDir(), "input.json");
  if (existsSync(inp)) {
    try {
      const doc = JSON.parse(readFileSync(inp, "utf8")) as { unique_code?: string };
      if (doc.unique_code) return String(doc.unique_code);
    } catch {
      /* ignore */
    }
  }
  throw new TsecError("UNIQUE_CODE is required");
}

function loadFlagItems(): Array<Record<string, unknown> | string> {
  const path = join(workspaceDir(), "flags.json");
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (Array.isArray(data)) return data as Array<Record<string, unknown> | string>;
    if (data && typeof data === "object") return [data as Record<string, unknown>];
  } catch {
    /* ignore */
  }
  return [];
}

function pendingFlags(): string[] {
  const out: string[] = [];
  for (const item of loadFlagItems()) {
    if (typeof item === "string") {
      if (item.trim()) out.push(item.trim());
      continue;
    }
    if (item.via || item.source) continue;
    if (item.correct === false) continue;
    const flag = String(item.flag || "").trim();
    if (flag) out.push(flag);
  }
  return out;
}

function appendFlag(flag: string, correct: boolean): void {
  const path = join(workspaceDir(), "flags.json");
  const items = loadFlagItems();
  const rec = { flag, correct, via: "heimdall-submit" };
  let found = false;
  const next = items.map((item) => {
    if (typeof item === "string") return item === flag ? rec : item;
    if (String(item.flag || "") === flag) {
      found = true;
      return { ...item, ...rec };
    }
    return item;
  });
  if (!found) next.push(rec);
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
}

function voidUnsubmitted(keep: Set<string>): void {
  const path = join(workspaceDir(), "flags.json");
  const items = loadFlagItems();
  let changed = false;
  const next = items.map((item) => {
    if (typeof item === "string") {
      const flag = item.trim();
      if (!flag || keep.has(flag)) return item;
      changed = true;
      return { flag, correct: false, via: "heimdall-submit" };
    }
    const flag = String(item.flag || "").trim();
    if (!flag || keep.has(flag) || item.via || item.source || item.correct === false) return item;
    changed = true;
    return { ...item, correct: false, via: "heimdall-submit" };
  });
  if (changed) writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
}

async function submitOne(code: string, flag: string): Promise<Record<string, unknown>> {
  if (managedGoal(workspaceDir())) {
    if (code !== uniqueCode()) throw new Error("Managed submissions must target the current task");
    return goalRequest(workspaceDir(), "submit", flag);
  }
  if (isDirectWorkspace(workspaceDir(), code)) {
    return { ...recordLocalFlag(workspaceDir(), flag), unique_code: code, direct: true, awarded: 0 };
  }
  const client = new TsecClient();
  const rec = await client.submit(code, flag);
  appendFlag(flag, rec.correct);
  try { recordAcceptedSubmit(workspaceDir(), code, flag, rec); }
  catch (error) { console.warn(`[observer] cannot record accepted submit: ${error}`); }
  return { ...rec, unique_code: code, flag };
}

async function cmdSubmit(args: string[]): Promise<number> {
  let code: string | undefined;
  const flags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--code") {
      code = args[++i];
      continue;
    }
    if (args[i] && !args[i]!.startsWith("-")) flags.push(args[i]!);
  }
  const ws = workspaceDir();
  if (isChallengeComplete(ws)) {
    console.log(JSON.stringify({ skipped: true, reason: "complete" }));
    return 0;
  }
  const unique = uniqueCode(code);
  const batch = capSubmitList(flags.length ? flags : pendingFlags()).filter(looksLikeFlag);
  const recs: Record<string, unknown>[] = [];
  let failed = false;
  let wrongStreak = 0;
  for (const flag of batch) {
    if (isChallengeComplete(ws)) break;
    const rec = await submitOne(unique, flag);
    recs.push(rec);
    if (rec.correct || rec.recorded) {
      wrongStreak = 0;
    } else {
      failed = true;
      wrongStreak += 1;
    }
    if (!flags.length) {
      /* flush path prints once */
    } else {
      console.log(JSON.stringify(rec));
    }
    if (
      afterSubmitShouldStop({
        complete: isChallengeComplete(ws),
        correct: Boolean(rec.correct),
        wrongStreak,
      })
    ) {
      if (!isChallengeComplete(ws) && wrongStreak >= MAX_WRONG_STREAK) {
        voidUnsubmitted(new Set(recs.map((r) => String(r.flag || "").trim()).filter(Boolean)));
      }
      break;
    }
  }
  if (!flags.length) {
    console.log(JSON.stringify({ flushed: recs.length, results: recs }));
    return recs.length && recs.every((r) => r.correct || r.recorded) ? 0 : recs.length ? 1 : 0;
  }
  return failed ? 1 : 0;
}

async function cmdHint(args: string[]): Promise<number> {
  let code: string | undefined;
  if (args.includes("--code")) code = args[args.indexOf("--code") + 1];
  const ws = workspaceDir();
  const unique = uniqueCode(code);
  if (isDirectWorkspace(ws, unique)) {
    console.log(JSON.stringify({ unique_code: unique, hint: null, source: "direct" }));
    return 0;
  }
  const decision = hintCliDecision(ws);
  if (decision.action === "deny") {
    console.error(JSON.stringify({ error: "hint_not_permitted", reason: decision.reason, unique_code: unique }));
    return 1;
  }
  if (decision.action === "reuse") {
    const dest = join(ws, "hint.txt");
    writeFileSync(dest, decision.hint.endsWith("\n") ? decision.hint : decision.hint + "\n");
    console.log(JSON.stringify({ unique_code: unique, hint: decision.hint, reused: true }));
    return 0;
  }
  const hint = await maybeTakeHint(ws);
  console.log(JSON.stringify({ unique_code: unique, hint: hint || null }));
  return hint ? 0 : 1;
}

async function cmdChallenge(args: string[]): Promise<number> {
  let code: string | undefined;
  if (args.includes("--code")) code = args[args.indexOf("--code") + 1];
  const unique = uniqueCode(code);
  if (isDirectWorkspace(workspaceDir(), unique)) {
    console.log(JSON.stringify(loadJson(join(workspaceDir(), "input.json")) || { unique_code: unique, source: "direct" }));
    return 0;
  }
  const client = new TsecClient();
  const all = await client.listChallenges();
  const ch = all.find((c) => c.unique_code === unique);
  if (ch && !managedGoal(workspaceDir())) {
    const input = loadJson(join(workspaceDir(), "input.json"));
    atomicJson(join(workspaceDir(), "input.json"), { ...(input && typeof input === "object" ? input : {}),
      flag_count: ch.flag_count, correct_flag_count: ch.correct_flag_count, is_completed: ch.is_completed });
  }
  console.log(JSON.stringify(ch || { error: "not_found", unique_code: unique }));
  return ch ? 0 : 1;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const cmd = argv[0] || "submit";
  const rest = argv[0] && ["submit", "hint", "challenge"].includes(argv[0]) ? argv.slice(1) : argv;
  try {
    if (cmd === "hint") return await cmdHint(rest);
    if (cmd === "challenge") return await cmdChallenge(rest);
    return await cmdSubmit(cmd === "submit" ? rest : argv);
  } catch (e) {
    const err = e as TsecError;
    console.error(JSON.stringify({ error: err.message, code: err.code, status: err.status }));
    return err.status && err.status < 500 ? 1 : 2;
  }
}

if (process.argv[1]?.endsWith("tsec-cli.js") || process.argv[1]?.endsWith("tsec-cli.ts")) {
  main().then((c) => process.exit(c));
}
