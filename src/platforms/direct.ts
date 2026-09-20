import { createHash } from "node:crypto";
import type { Database } from "../shared/db.js";
import { challengeFromDict, emptySubmit, type Bench, type Challenge, type SubmitResult } from "./types.js";

export const DIRECT_PREFIX = "url-";

export function isDirectCode(code: string | null | undefined): boolean {
  return String(code || "").trim().toLowerCase().startsWith(DIRECT_PREFIX);
}

export function isDirectRow(row: Record<string, unknown> | null | undefined): boolean {
  if (!row) return false;
  if (isDirectCode(String(row.unique_code || ""))) return true;
  return String(row.container_status || "").trim().toLowerCase() === "direct";
}

export function normalizeTargetUrl(raw: string): string {
  let s = (raw || "").trim();
  if (!s) throw new Error("need a target URL");
  if (!s.includes("://")) s = `http://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error("need a target URL");
  }
  const scheme = u.protocol.replace(":", "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") throw new Error("only http/https targets");
  if (!u.host) throw new Error("URL needs a host");
  const path = u.pathname || "/";
  return `${scheme}://${u.host}${path}${u.search}`;
}

export function codeForUrl(url: string): string {
  const canon = normalizeTargetUrl(url);
  const digest = createHash("sha1").update(canon).digest("hex").slice(0, 10);
  return `${DIRECT_PREFIX}${digest}`;
}

export function addrsFromRow(row: Record<string, unknown> | null | undefined): string[] {
  if (!row) return [];
  let raw: unknown = row.container_addr;
  if (raw == null) raw = row.container_addr_json;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (text.startsWith("[") || text.startsWith("{")) {
      try {
        raw = JSON.parse(text) as unknown;
      } catch {
        raw = text ? [text] : [];
      }
    } else {
      raw = text ? [text] : [];
    }
  }
  if (typeof raw === "string") raw = [raw];
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const s = String(item || "").trim();
      if (s) out.push(s);
    }
  }
  if (!out.length) {
    const desc = String(row.description || "").trim();
    if (desc.startsWith("http://") || desc.startsWith("https://")) out.push(desc);
  }
  return out;
}

export function ensureDirectChallenge(db: Database, uniqueCode: string, url: string): void {
  const addr = normalizeTargetUrl(url);
  const code = (uniqueCode || "").trim() || codeForUrl(addr);
  const ch: Challenge = {
    unique_code: code,
    description: addr,
    difficulty: null,
    level: 0,
    total_score: 0,
    flag_count: 0,
    correct_flag_count: 0,
    is_completed: false,
    container_status: "direct",
    container_addr: [addr],
  };
  db.upsertChallenges([ch]);
}

/** Local URL targets: no platform start/close/hint. Sync does not wipe the ledger. */
export class DirectBench implements Bench {
  constructor(readonly db?: Database) {}

  async listChallenges(): Promise<Challenge[]> {
    if (!this.db) return [];
    const out: Challenge[] = [];
    for (const row of this.db.listChallenges()) {
      try {
        out.push(
          challengeFromDict({
            ...row,
            container_addr: addrsFromRow(row),
          }),
        );
      } catch {
        /* skip malformed */
      }
    }
    return out;
  }

  async start(id: string): Promise<Record<string, unknown>> {
    const row = this.db?.getChallenge(id) || null;
    return { container_addr: addrsFromRow(row), container_status: "direct" };
  }

  async close(_id: string): Promise<unknown> {
    return { closed: true };
  }

  async hint(_id: string): Promise<string | null> {
    return null;
  }

  async submit(_id: string, _flag: string): Promise<SubmitResult> {
    return emptySubmit({ raw: { source: "direct" } });
  }
}
