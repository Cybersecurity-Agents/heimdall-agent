import { classifyChallenge } from "../shared/classify.js";
import type { ChallengeRow, PolicyCfg } from "./types.js";

export function codeFamily(uniqueCode: string): string {
  const head = String(uniqueCode || "").trim().toLowerCase().split("-")[0] || "";
  if (!head) return "";
  const first = head[0]!;
  if ("abcdef".includes(first)) return first;
  return head;
}

function challengeType(uniqueCode: string, cfg?: PolicyCfg | null, ch?: ChallengeRow | null): string {
  if (!cfg) return "";
  let levelI: number | null = null;
  if (ch) {
    const level = ch.level;
    const n = Number.parseInt(String(level ?? ""), 10);
    levelI = Number.isFinite(n) && String(level ?? "") !== "" ? n : null;
  }
  return classifyChallenge(uniqueCode, cfg, { level: levelI });
}

export function waveIndex(
  uniqueCode: string,
  waves: string[][],
  opts: { cfg?: PolicyCfg | null; ch?: ChallengeRow | null } = {},
): number {
  const family = codeFamily(uniqueCode);
  const ctype = challengeType(uniqueCode, opts.cfg, opts.ch);
  for (let i = 0; i < waves.length; i++) {
    const names = new Set((waves[i] || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean));
    if (ctype && names.has(ctype)) return i;
    if (names.has(family)) return i;
  }
  return waves.length;
}

export function sortCodes(
  codes: string[],
  cfg: PolicyCfg,
  challengesByCode?: Record<string, ChallengeRow | null> | null,
): string[] {
  const waves = cfg.dispatch_waves || [];
  const chs = challengesByCode || {};
  const score = (code: string): number => {
    const ch = chs[code];
    if (!ch) return 0;
    const n = Number.parseInt(String(ch.total_score || 0), 10);
    return Number.isFinite(n) ? n : 0;
  };
  const indexed = codes
    .map((c, i) => [i, String(c).trim()] as const)
    .filter((item) => item[1]);
  indexed.sort((a, b) => {
    const wa = waves.length ? waveIndex(a[1], waves, { cfg, ch: chs[a[1]] }) : 0;
    const wb = waves.length ? waveIndex(b[1], waves, { cfg, ch: chs[b[1]] }) : 0;
    return wa - wb || score(a[1]) - score(b[1]) || a[0] - b[0];
  });
  return indexed.map((item) => item[1]);
}
