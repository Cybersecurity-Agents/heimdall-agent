import { TsecError } from "../platforms/types.js";

const CAPACITY_RE =
  /max\s+active|max active challenge|active challenge instances reached|please close an existing challenge/i;

const TRANSIENT_START_RE =
  /504|502|503|408|gateway time-?out|bad gateway|service unavailable|cloudflare|openresty|temporar|timed?\s*out|timeout|connection reset|connection refused|network error/i;

export function isCapacityError(exc?: unknown, opts: { message?: string | null } = {}): boolean {
  let msg = opts.message || "";
  let code: string | null = null;
  let status: number | null = null;
  if (exc instanceof TsecError) {
    code = exc.code;
    status = exc.status;
    msg = msg || String(exc);
  } else if (exc != null) {
    msg = msg || String(exc);
  }
  if (status === 409 && CAPACITY_RE.test(msg || "")) return true;
  if (CAPACITY_RE.test(msg || "")) return true;
  if (code === "invalid_state" && CAPACITY_RE.test(msg || "")) return true;
  return false;
}

export function isCapacityErrorText(text?: string | null): boolean {
  return Boolean(text && CAPACITY_RE.test(text));
}

export function isTransientStartError(exc?: unknown, opts: { message?: string | null } = {}): boolean {
  if (exc instanceof Error && exc.name === "TimeoutError") return true;
  const status = exc && typeof exc === "object" ? Number((exc as { status?: unknown }).status) : NaN;
  if ([408, 500, 502, 503, 504].includes(status)) return true;
  const msg = opts.message || (exc != null ? String(exc) : "");
  return Boolean(TRANSIENT_START_RE.test(msg || ""));
}

export const TERMINAL_DEFERRED_START = "deferred_start";
export const TERMINAL_SUCCEEDED = "succeeded";
export const TERMINAL_AGENT_FAILED = "agent_failed";
export const TERMINAL_TIMEOUT = "timeout";
export const TERMINAL_DEFERRED_CAPACITY = "deferred_capacity";
export const TERMINAL_DEFERRED_ADDR = "deferred_addr";
export const TERMINAL_INFRA_ERROR = "infra_error";
export const TERMINAL_START_REJECTED = "start_rejected";
export const TERMINAL_TIMEOUT_ESCALATED = "timeout_escalated";
export const TERMINAL_FAILED_ESCALATED = "failed_escalated";
export const TERMINAL_LOOP_SUCCEEDED = "loop_succeeded";
export const TERMINAL_LOOP_TIMEOUT = "loop_timeout";
export const TERMINAL_LOOP_EXHAUSTED = "loop_exhausted";

export function deferredStartResult(uniqueCode: string, opts: { error?: string | null } = {}): Record<string, unknown> {
  return {
    unique_code: uniqueCode,
    status: "deferred_start",
    terminal_reason: TERMINAL_DEFERRED_START,
    counts_as_attempt: 0,
    completed: false,
    requeue: true,
    error: opts.error || "start transient failure",
  };
}

export function countsAsAttemptForReason(terminalReason?: string | null): number {
  return [
    TERMINAL_SUCCEEDED,
    TERMINAL_AGENT_FAILED,
    TERMINAL_TIMEOUT,
    TERMINAL_TIMEOUT_ESCALATED,
    TERMINAL_FAILED_ESCALATED,
    TERMINAL_LOOP_SUCCEEDED,
    TERMINAL_LOOP_TIMEOUT,
    TERMINAL_LOOP_EXHAUSTED,
  ].includes(String(terminalReason || ""))
    ? 1
    : 0;
}

export function deferredCapacityResult(uniqueCode: string, opts: { error?: string | null } = {}): Record<string, unknown> {
  return {
    unique_code: uniqueCode,
    status: "deferred_capacity",
    terminal_reason: TERMINAL_DEFERRED_CAPACITY,
    counts_as_attempt: 0,
    completed: false,
    error: opts.error || "platform capacity full",
  };
}

export function deferredAddrResult(
  uniqueCode: string,
  opts: { occupants?: string[] | null; occupancyKey?: string | null; error?: string | null } = {},
): Record<string, unknown> {
  const hits = (opts.occupants || []).map((c) => String(c).trim()).filter(Boolean);
  return {
    unique_code: uniqueCode,
    status: "deferred_addr",
    terminal_reason: TERMINAL_DEFERRED_ADDR,
    counts_as_attempt: 0,
    completed: false,
    occupants: hits,
    occupancy_key: opts.occupancyKey || "",
    error: opts.error || (hits.length ? `addr mutex collision with ${hits.join(",")}` : "addr mutex collision"),
  };
}
