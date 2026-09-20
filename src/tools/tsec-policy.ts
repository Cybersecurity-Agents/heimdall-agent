export const MAX_SUBMIT_BATCH = 8;
export const MAX_WRONG_STREAK = 5;

export function capSubmitList(flags: string[], max = MAX_SUBMIT_BATCH): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of flags) {
    const flag = String(raw || "").trim();
    if (!flag || seen.has(flag)) continue;
    seen.add(flag);
    out.push(flag);
    if (out.length >= Math.max(0, max)) break;
  }
  return out;
}

export function afterSubmitShouldStop(opts: {
  complete: boolean;
  correct: boolean;
  wrongStreak: number;
  maxWrong?: number;
}): boolean {
  if (opts.complete) return true;
  if (!opts.correct && opts.wrongStreak >= (opts.maxWrong ?? MAX_WRONG_STREAK)) return true;
  return false;
}
