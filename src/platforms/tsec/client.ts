import { scoredCorrect } from "../../shared/completion.js";
import {
  TsecError,
  challengeFromDict,
  type Bench,
  type Challenge,
  type SubmitResult,
} from "../types.js";

async function parseJson(resp: Response): Promise<unknown> {
  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export class TsecClient implements Bench {
  baseUrl: string;
  token: string;
  timeoutMs: number;

  constructor(baseUrl?: string | null, token?: string | null, timeoutSec = 30) {
    this.baseUrl = (baseUrl || process.env.BENCHMARK_BASE_URL || "").replace(/\/+$/, "");
    this.token = token || process.env.BENCHMARK_TOKEN || "";
    this.timeoutMs = timeoutSec * 1000;
  }

  private url(path: string, params?: Record<string, string>): string {
    if (!this.baseUrl) throw new TsecError("BENCHMARK_BASE_URL is required");
    if (!this.token) throw new TsecError("BENCHMARK_TOKEN is required");
    const u = new URL(this.baseUrl + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    }
    return u.toString();
  }

  private async request(
    method: string,
    path: string,
    opts: { params?: Record<string, string>; json?: Record<string, unknown> } = {},
  ): Promise<unknown> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const resp = await fetch(this.url(path, opts.params), {
        method,
        headers: {
          BENCHMARK_TOKEN: this.token,
          ...(opts.json ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.json ? JSON.stringify(opts.json) : undefined,
        signal: ac.signal,
      });
      if (resp.status === 422) {
        throw new TsecError("validation error", {
          code: "validation_error",
          status: 422,
          detail: await parseJson(resp),
        });
      }
      if (resp.status >= 400) {
        const body = await parseJson(resp);
        const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
        throw new TsecError(String(rec.message || resp.statusText || "error"), {
          code: rec.code ? String(rec.code) : null,
          status: resp.status,
          detail: rec.detail,
        });
      }
      return await parseJson(resp);
    } catch (e) {
      if (e instanceof TsecError) throw e;
      throw new TsecError(`network error: ${e}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async listChallenges(): Promise<Challenge[]> {
    const data = (await this.request("GET", "/openapi/v1/challenges")) as unknown;
    return Array.isArray(data) ? data.map((x) => challengeFromDict(x as Record<string, unknown>)) : [];
  }

  async start(uniqueCode: string): Promise<Record<string, unknown>> {
    const data = await this.request("POST", "/openapi/v1/challenges/start", {
      params: { unique_code: uniqueCode },
    });
    return (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  }

  async close(uniqueCode: string): Promise<unknown> {
    return this.request("POST", "/openapi/v1/challenges/close", {
      params: { unique_code: uniqueCode },
    });
  }

  async hint(uniqueCode: string): Promise<string | null> {
    const data = (await this.request("GET", "/openapi/v1/challenges/hint", {
      params: { unique_code: uniqueCode },
    })) as Record<string, unknown> | null;
    const hint = data?.hint;
    return hint == null ? null : String(hint);
  }

  async submit(uniqueCode: string, flag: string): Promise<SubmitResult> {
    try {
      const data = ((await this.request("POST", "/openapi/v1/challenges/submit", {
        json: { unique_code: uniqueCode, flag },
      })) || {}) as Record<string, unknown>;
      return {
        correct: scoredCorrect(data.correct),
        awarded: Number.parseInt(String(data.awarded || 0), 10) || 0,
        cumulative_score: Number.parseInt(String(data.cumulative_score || 0), 10) || 0,
        correct_flag_count: Number.parseInt(String(data.correct_flag_count || 0), 10) || 0,
        total_flag_count: Number.parseInt(String(data.total_flag_count || 0), 10) || 0,
        matched_flag_index: data.matched_flag_index == null ? null : Number(data.matched_flag_index),
        duplicate: false,
        raw: data,
      };
    } catch (e) {
      if (e instanceof TsecError && e.code === "duplicate") {
        const detail = e.detail && typeof e.detail === "object" ? e.detail as Record<string, unknown> : {};
        return {
          // A duplicate alone doesn't prove it was an accepted value. The goal
          // controller reconciles the challenge's authoritative count/status.
          correct: scoredCorrect(detail.correct),
          awarded: 0,
          cumulative_score: 0,
          correct_flag_count: 0,
          total_flag_count: 0,
          matched_flag_index: null,
          duplicate: true,
          raw: { code: "duplicate", message: e.message },
        };
      }
      throw e;
    }
  }
}
