export function labAddrsLive(
  ch: { container_status?: unknown } | null | undefined,
  addrs: string[],
): boolean {
  if (!addrs.length) return false;
  const st = String(ch?.container_status || "").trim().toLowerCase();
  return !st || st === "available" || st === "running";
}

export function shouldStartLab(opts: {
  kind: "regular" | "loop";
  direct: boolean;
  skipStart?: boolean;
  loopDirect: boolean;
  hasLiveAddrs: boolean;
}): boolean {
  if (opts.direct || opts.skipStart) return false;
  if (opts.kind === "loop") return !opts.hasLiveAddrs;
  return !opts.loopDirect;
}

export function loopBudgetLeft(
  entry: { loop_n?: unknown; status?: unknown } | null | undefined,
  maxLoop: number,
): boolean {
  const n = Number(entry?.loop_n || 0) || 0;
  const maxN = Math.max(1, Number(maxLoop || 2) || 2);
  return n < maxN;
}

/** First-time intranet enqueue. Never reopen a finished or exhausted loop row. */
export function loopDirectEnqueueOk(
  entry: { status?: unknown; loop_n?: unknown } | null | undefined,
  maxLoop: number,
): boolean {
  if (!entry) return true;
  const st = String(entry.status || "").trim().toLowerCase();
  if (st === "queued" || st === "running") return false;
  if (st === "done" || st === "cancelled" || st === "failed") return false;
  return loopBudgetLeft(entry, maxLoop);
}
