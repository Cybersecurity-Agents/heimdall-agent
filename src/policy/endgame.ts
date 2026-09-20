import { classifyChallenge, canonicalTimeoutType } from "../shared/classify.js";
import { sortCodes } from "./order.js";
import type { ChallengeRow, LoopDb, PolicyCfg } from "./types.js";

export function labTypes(cfg: PolicyCfg): Set<string> {
  const types = cfg.lab_exclusive_types || [];
  return new Set(types.map((t) => String(t).trim().toLowerCase()).filter(Boolean));
}

export function challengeTypeOf(uniqueCode: string, cfg: PolicyCfg, ch?: ChallengeRow | null): string {
  let desc: string | null = null;
  let levelI: number | null = null;
  if (ch) {
    desc = ch.description == null ? null : String(ch.description);
    const level = ch.level;
    const n = Number.parseInt(String(level ?? ""), 10);
    levelI = Number.isFinite(n) && String(level ?? "") !== "" ? n : null;
  }
  return classifyChallenge(uniqueCode, cfg, { description: desc, level: levelI });
}

export function isLabCode(uniqueCode: string, cfg: PolicyCfg, opts: { ch?: ChallengeRow | null } = {}): boolean {
  return labTypes(cfg).has(challengeTypeOf(uniqueCode, cfg, opts.ch));
}

export function isLoopDirectCode(uniqueCode: string, cfg: PolicyCfg, opts: { ch?: ChallengeRow | null } = {}): boolean {
  const ctype = challengeTypeOf(uniqueCode, cfg, opts.ch);
  if (typeof cfg.is_loop_direct_code === "function") {
    return Boolean(cfg.is_loop_direct_code(uniqueCode, ctype));
  }
  const named = new Set((cfg.loop_direct_codes || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean));
  if (named.has(String(uniqueCode || "").trim().toLowerCase())) return true;
  if (typeof cfg.is_loop_direct_type === "function") {
    return Boolean(cfg.is_loop_direct_type(ctype));
  }
  const allowed = new Set(
    (cfg.loop_direct_types || []).map((x) => canonicalTimeoutType(x) || x).filter(Boolean),
  );
  if (!allowed.size) return false;
  return allowed.has(canonicalTimeoutType(ctype) || "all");
}

function skipCodes(cfg: PolicyCfg): Set<string> {
  return new Set((cfg.skip_codes || []).map((c) => String(c).trim()).filter(Boolean));
}

export function incompleteLabCodes(rows: Iterable<ChallengeRow>, cfg: PolicyCfg): string[] {
  const skip = skipCodes(cfg);
  const out: string[] = [];
  for (const row of rows) {
    const code = String(row?.unique_code || "").trim();
    const done = Boolean(row?.is_completed);
    if (!code || done || skip.has(code)) continue;
    if (isLabCode(code, cfg, { ch: row })) out.push(code);
  }
  return out;
}

export function incompleteLabFromDb(db: LoopDb, cfg: PolicyCfg): string[] {
  try {
    const rows = db.listChallenges?.({ incompleteOnly: true }) || [];
    return incompleteLabCodes(rows, cfg);
  } catch {
    return [];
  }
}

export function isScouted(db: LoopDb, uniqueCode: string): boolean {
  try {
    if (db.getLoopEntry?.(uniqueCode)) return true;
  } catch {
    /* ignore */
  }
  try {
    if ((db.nextAttemptN?.(uniqueCode) || 1) > 1) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export function loopStarted(db: LoopDb, uniqueCode: string): boolean {
  try {
    const entry = db.getLoopEntry?.(uniqueCode);
    if (!entry) return false;
    return (Number.parseInt(String(entry.loop_n || 0), 10) || 0) >= 1;
  } catch {
    return false;
  }
}

/** First loop wall-clock finished (not merely started). bumpLoopN happens at start. */
export function loopFirstFinished(db: LoopDb, uniqueCode: string): boolean {
  try {
    const entry = db.getLoopEntry?.(uniqueCode);
    if (!entry) return false;
    const n = Number.parseInt(String(entry.loop_n || 0), 10) || 0;
    if (n < 1) return false;
    const st = String(entry.status || "").toLowerCase();
    if (n === 1 && (st === "running" || st === "starting")) return false;
    return true;
  } catch {
    return false;
  }
}

function filterIncompleteCodes(
  db: LoopDb,
  cfg: PolicyCfg,
  opts: {
    exceptCode?: string | null;
    codes?: Iterable<string> | null;
    keep: (code: string, row: ChallengeRow) => boolean;
  },
): string[] {
  const skip = skipCodes(cfg);
  const exceptC = String(opts.exceptCode || "").trim();
  let allow: Set<string> | null = null;
  if (opts.codes != null) {
    allow = new Set([...opts.codes].map((c) => String(c).trim()).filter(Boolean));
  }
  let rows: ChallengeRow[] = [];
  try {
    rows = db.listChallenges?.({ incompleteOnly: true }) || [];
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const row of rows) {
    const code = String(row?.unique_code || "").trim();
    if (!code || code === exceptC || skip.has(code)) continue;
    if (allow && !allow.has(code)) continue;
    if (opts.keep(code, row)) out.push(code);
  }
  return out;
}

export function firstLoopPendingCodes(
  db: LoopDb,
  cfg: PolicyCfg,
  opts: { exceptCode?: string | null; codes?: Iterable<string> | null } = {},
): string[] {
  return filterIncompleteCodes(db, cfg, {
    exceptCode: opts.exceptCode,
    codes: opts.codes,
    keep: (code) => !loopStarted(db, code),
  });
}

export function pendingDirectFirstLoopCodes(
  db: LoopDb,
  cfg: PolicyCfg,
  opts: { exceptCode?: string | null; codes?: Iterable<string> | null } = {},
): string[] {
  return filterIncompleteCodes(db, cfg, {
    exceptCode: opts.exceptCode,
    codes: opts.codes,
    keep: (code, row) =>
      isLoopDirectCode(code, cfg, { ch: row }) && !loopFirstFinished(db, code),
  });
}

export function filterLoopQueueForPolicy(
  queued: string[],
  db: LoopDb,
  cfg: PolicyCfg,
  opts: {
    loopNByCode?: Record<string, number> | null;
    challengesByCode?: Record<string, ChallengeRow | null> | null;
    codes?: Iterable<string> | null;
  } = {},
): string[] {
  const ns = opts.loopNByCode || {};
  const chs = opts.challengesByCode || {};
  const pendingDirect = pendingDirectFirstLoopCodes(db, cfg, { codes: opts.codes });
  const unstartedDirect = pendingDirect.filter((c) => !loopStarted(db, c));
  if (unstartedDirect.length) {
    return queued.filter(
      (c) => (ns[c] || 0) < 1 && isLoopDirectCode(c, cfg, { ch: chs[c] }),
    );
  }
  const pendingFirst = firstLoopPendingCodes(db, cfg, { codes: opts.codes });
  if (pendingFirst.length) return queued.filter((c) => (ns[c] || 0) < 1);
  return queued;
}

export function shouldDeferRepeatLoop(
  db: LoopDb,
  cfg: PolicyCfg,
  uniqueCode: string,
  loopN: number,
  opts: { codes?: Iterable<string> | null } = {},
): boolean {
  const n = Number.parseInt(String(loopN || 0), 10) || 0;
  if (n < 1) return false;
  if (pendingDirectFirstLoopCodes(db, cfg, { exceptCode: uniqueCode, codes: opts.codes }).length) {
    return true;
  }
  return firstLoopPendingCodes(db, cfg, { exceptCode: uniqueCode, codes: opts.codes }).length > 0;
}

export function unscoutedLabCodes(db: LoopDb, cfg: PolicyCfg, opts: { exceptCode?: string | null } = {}): string[] {
  const exceptC = String(opts.exceptCode || "").trim();
  return incompleteLabFromDb(db, cfg).filter((code) => code !== exceptC && !isScouted(db, code));
}

export function shouldScoutTimeout(cfg: PolicyCfg, db: LoopDb, opts: { challengeType: string }): boolean {
  const scout = Number.parseInt(String(cfg.lab_scout_timeout_sec ?? 2400), 10) || 0;
  if (scout < 1) return false;
  let ctype = (opts.challengeType || "").trim().toLowerCase();
  if (ctype === "pentest") ctype = "intranet";
  if (!labTypes(cfg).has(ctype)) return false;
  return incompleteLabFromDb(db, cfg).length >= 2;
}

export function shouldDeferLabLoop(db: LoopDb, cfg: PolicyCfg, uniqueCode: string): boolean {
  if (cfg.lab_defer_loop_until_scouted === false) return false;
  if (!isLabCode(uniqueCode, cfg)) return false;
  return Boolean(unscoutedLabCodes(db, cfg, { exceptCode: uniqueCode }).length);
}

function intField(chRow: ChallengeRow | null | undefined, key: string): number {
  if (!chRow) return 0;
  const n = Number.parseInt(String(chRow[key] || 0), 10);
  return Number.isFinite(n) ? n : 0;
}

export function labSizeKey(uniqueCode: string, chRow?: ChallengeRow | null): [number, number, string] {
  return [intField(chRow, "total_score"), intField(chRow, "flag_count"), String(uniqueCode)];
}

export function sortLabSmallestFirst(
  codes: string[],
  cfg: PolicyCfg,
  challengesByCode?: Record<string, ChallengeRow | null> | null,
): string[] {
  const ordered = codes.map((c) => String(c).trim()).filter(Boolean);
  const chs = challengesByCode || {};
  const labPos = ordered
    .map((code, i) => (isLabCode(code, cfg, { ch: chs[code] }) ? i : -1))
    .filter((i) => i >= 0);
  if (labPos.length <= 1) return ordered;
  const labs = labPos.map((i) => ordered[i]!);
  labs.sort((a, b) => {
    const ka = labSizeKey(a, chs[a]);
    const kb = labSizeKey(b, chs[b]);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
  });
  const out = [...ordered];
  labPos.forEach((idx, i) => {
    out[idx] = labs[i]!;
  });
  return out;
}

export function challengeMapFromDb(db: LoopDb, codes: string[]): Record<string, ChallengeRow | null> {
  const out: Record<string, ChallengeRow | null> = {};
  for (const raw of codes) {
    const code = String(raw || "").trim();
    if (!code) continue;
    try {
      out[code] = db.getChallenge?.(code) || null;
    } catch {
      out[code] = null;
    }
  }
  return out;
}

export function orderDispatchCodes(
  codes: string[],
  cfg: PolicyCfg,
  challengesByCode?: Record<string, ChallengeRow | null> | null,
): string[] {
  return sortLabSmallestFirst(sortCodes(codes, cfg, challengesByCode), cfg, challengesByCode);
}

export function remainingScore(chRow?: ChallengeRow | null): number {
  if (!chRow) return 0;
  const score = Number.parseInt(String(chRow.total_score || 0), 10) || 0;
  const flags = Number.parseInt(String(chRow.flag_count || 0), 10) || 0;
  const correct = Number.parseInt(String(chRow.correct_flag_count || 0), 10) || 0;
  if (flags > 0) {
    const rem = Math.max(0, flags - correct);
    return score ? Math.round((score * rem) / flags) : rem;
  }
  return correct <= 0 ? score : 0;
}

function directFirstLoopRank(
  uniqueCode: string,
  chRow: ChallengeRow | null | undefined,
  loopN: number,
  cfg?: PolicyCfg | null,
): number {
  if (!cfg || (Number(loopN) || 0) >= 1) return 1;
  return isLoopDirectCode(uniqueCode, cfg, { ch: chRow }) ? 0 : 1;
}

export function loopProgressKey(
  uniqueCode: string,
  chRow: ChallengeRow | null | undefined,
  loopN = 0,
  opts: { hasBrief?: boolean | null; cfg?: PolicyCfg | null } = {},
): [number, number, number, number, string] {
  void opts.hasBrief;
  return [
    directFirstLoopRank(uniqueCode, chRow, loopN, opts.cfg),
    Math.max(0, Math.trunc(loopN || 0)),
    intField(chRow, "total_score"),
    intField(chRow, "flag_count"),
    String(uniqueCode),
  ];
}

export function sortLoopCodes(
  codes: string[],
  cfg: PolicyCfg,
  opts: {
    challengesByCode?: Record<string, ChallengeRow | null> | null;
    loopNByCode?: Record<string, number> | null;
  } = {},
): string[] {
  const ordered = orderDispatchCodes(codes, cfg, opts.challengesByCode);
  const chs = opts.challengesByCode || {};
  const ns = opts.loopNByCode || {};
  const indexed = ordered.map((code, i) => [i, code] as const);
  indexed.sort((a, b) => {
    const ka = loopProgressKey(a[1], chs[a[1]], Number(ns[a[1]] || 0) || 0, { cfg });
    const kb = loopProgressKey(b[1], chs[b[1]], Number(ns[b[1]] || 0) || 0, { cfg });
    for (let i = 0; i < ka.length; i++) {
      const av = ka[i]!;
      const bv = kb[i]!;
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return a[0] - b[0];
  });
  return indexed.map((item) => item[1]);
}

