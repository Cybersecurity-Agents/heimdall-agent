import { isCapacityError } from "../policy/capacity.js";
import { isPlatformActive } from "../policy/inventory.js";
import type { ChallengeRow } from "../policy/types.js";
import { TsecError } from "../platforms/types.js";

const RELEASED = new Set(["stopped", "closed", ""]);

export type ClosePostResult = {
  http_status: number | null;
  code: string | null;
  message: string;
  body_closed: boolean | null;
  error: TsecError | null;
};

export type CloseOutcome = {
  ok: boolean;
  via: string;
  still_occupying?: boolean;
  http_status?: number | null;
  code?: string | null;
  message?: string;
};

function statusOf(ch: ChallengeRow | null | undefined): string {
  return String(ch?.container_status || "").trim().toLowerCase();
}

function addrsOf(ch: ChallengeRow | null | undefined): unknown[] {
  if (!ch) return [];
  const raw = ch.container_addr ?? ch.container_addr_json ?? [];
  if (typeof raw === "string") {
    const s = raw.trim();
    return s && s !== "[]" && s !== "null" ? [raw] : [];
  }
  return Array.isArray(raw) ? raw : [];
}

export function isOccupying(ch: ChallengeRow | null | undefined): boolean {
  if (!ch) return false;
  if (isPlatformActive(ch)) return true;
  return addrsOf(ch).length > 0;
}

export function instanceReleased(ch: ChallengeRow | null | undefined, opts: { listComplete: boolean }): boolean {
  if (!ch) return opts.listComplete;
  if (addrsOf(ch).length) return false;
  return RELEASED.has(statusOf(ch));
}

export function canSkipStart(ch: ChallengeRow | null | undefined): boolean {
  if (!ch) return false;
  return statusOf(ch) === "available" && addrsOf(ch).length > 0;
}

function findCh(challenges: ChallengeRow[] | null | undefined, uniqueCode: string): ChallengeRow | null {
  if (!challenges) return null;
  return challenges.find((c) => String(c.unique_code || "") === uniqueCode) || null;
}

export function classifySnapshot(opts: {
  challenges?: ChallengeRow[] | null;
  uniqueCode: string;
  post?: ClosePostResult | null;
  listComplete: boolean;
  listError?: TsecError | null;
}): CloseOutcome {
  const post = opts.post || { http_status: null, code: null, message: "", body_closed: null, error: null };
  const http = post.http_status;
  const code = post.code;
  if (http === 404 && (code === "challenge_not_found" || code === "task_not_found" || !code)) {
    return { ok: true, via: "challenge_not_found", http_status: http, code };
  }
  if (http === 409 && isCapacityError(post.error, { message: post.message })) {
    return {
      ok: false,
      via: "capacity_conflict",
      still_occupying: true,
      http_status: http,
      code,
      message: post.message,
    };
  }
  const list409 = Boolean(opts.listError && opts.listError.status === 409 && opts.listError.code === "invalid_state");
  if (list409) {
    return {
      ok: true,
      via: "task_ended",
      http_status: http || 409,
      code: code || "invalid_state",
      message: String(opts.listError),
    };
  }
  if (!opts.listComplete) {
    return {
      ok: false,
      via: "list_incomplete",
      still_occupying: true,
      http_status: http,
      code,
      message: post.message,
    };
  }
  const ch = findCh(opts.challenges, opts.uniqueCode);
  const occupying = isOccupying(ch);
  const released = instanceReleased(ch, { listComplete: true });
  if (http === 503 || code === "resource_unavailable") {
    return { ok: false, via: "still_active", still_occupying: true, http_status: http, code, message: post.message };
  }
  if (http === 409 && code === "invalid_state") {
    if (occupying) {
      return { ok: false, via: "still_active", still_occupying: true, http_status: http, code, message: post.message };
    }
    if (released || !ch) {
      return { ok: true, via: "task_ended", http_status: http, code, message: post.message };
    }
    return { ok: false, via: "still_active", still_occupying: occupying, http_status: http, code, message: post.message };
  }
  if (released || !occupying) {
    return { ok: true, via: "released", http_status: http, code, message: post.message };
  }
  return { ok: false, via: "still_active", still_occupying: true, http_status: http, code, message: post.message };
}

export async function closeVerified(
  client: { close: (code: string) => Promise<unknown>; listChallenges: () => Promise<ChallengeRow[]> },
  uniqueCode: string,
  opts: { attempts?: number; sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<CloseOutcome> {
  const n = Math.max(1, opts.attempts ?? 3);
  const delays = [1000, 2000, 4000];
  let last: CloseOutcome = { ok: false, via: "still_active", still_occupying: true };
  for (let i = 0; i < n; i++) {
    let post: ClosePostResult;
    try {
      const data = await client.close(uniqueCode);
      const rec = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const closed = rec.closed;
      post = {
        http_status: 200,
        code: null,
        message: "",
        body_closed: closed == null ? Boolean(data) : Boolean(closed),
        error: null,
      };
    } catch (e) {
      const err = e instanceof TsecError ? e : new TsecError(String(e));
      post = {
        http_status: err.status,
        code: err.code,
        message: err.message,
        body_closed: null,
        error: err,
      };
    }
    if (post.http_status === 404) {
      return classifySnapshot({ uniqueCode, post, listComplete: true });
    }
    if (post.http_status === 409 && isCapacityError(post.error, { message: post.message })) {
      return classifySnapshot({ uniqueCode, post, listComplete: true });
    }
    let listError: TsecError | null = null;
    let snap: ChallengeRow[] | null = null;
    let complete = false;
    try {
      snap = await client.listChallenges();
      complete = true;
    } catch (e) {
      listError = e instanceof TsecError ? e : new TsecError(String(e));
      complete = false;
    }
    last = classifySnapshot({
      challenges: snap,
      uniqueCode,
      post,
      listComplete: complete,
      listError,
    });
    if (last.ok || last.via === "stop_pending") return last;
    if (i + 1 < n && (last.via === "still_active" || last.via === "list_incomplete")) {
      await (opts.sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms))))(delays[Math.min(i, delays.length - 1)]!);
      continue;
    }
    return last;
  }
  return last;
}
