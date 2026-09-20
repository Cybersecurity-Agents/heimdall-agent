import { scoredCorrect } from "../shared/completion.js";

export class BenchError extends Error {
  code: string | null;
  status: number | null;
  detail: unknown;
  constructor(message: string, opts: { code?: string | null; status?: number | null; detail?: unknown } = {}) {
    super(message);
    this.name = "BenchError";
    this.code = opts.code ?? null;
    this.status = opts.status ?? null;
    this.detail = opts.detail;
  }
}

/** TSec HTTP errors keep this name so capacity/close checks stay instanceof-stable. */
export class TsecError extends BenchError {
  constructor(message: string, opts: { code?: string | null; status?: number | null; detail?: unknown } = {}) {
    super(message, opts);
    this.name = "TsecError";
  }
}

export type Challenge = {
  unique_code: string;
  description: string | null;
  difficulty: string | null;
  level: number;
  total_score: number;
  flag_count: number;
  correct_flag_count: number;
  is_completed: boolean;
  container_status: string;
  container_addr: string[];
};

export type Target = Challenge;

export function challengeFromDict(d: Record<string, unknown>): Challenge {
  return {
    unique_code: String(d.unique_code),
    description: d.description == null ? null : String(d.description),
    difficulty: d.difficulty == null ? null : String(d.difficulty),
    level: Number.parseInt(String(d.level || 0), 10) || 0,
    total_score: Number.parseInt(String(d.total_score || 0), 10) || 0,
    flag_count: Number.parseInt(String(d.flag_count || 0), 10) || 0,
    correct_flag_count: Number.parseInt(String(d.correct_flag_count || 0), 10) || 0,
    is_completed: scoredCorrect(d.is_completed),
    container_status: String(d.container_status || "stopped"),
    container_addr: Array.isArray(d.container_addr) ? d.container_addr.map(String) : [],
  };
}

export type SubmitResult = {
  correct: boolean;
  awarded: number;
  cumulative_score: number;
  correct_flag_count: number;
  total_flag_count: number;
  matched_flag_index: number | null;
  duplicate: boolean;
  raw: Record<string, unknown>;
};

export type Bench = {
  listChallenges(): Promise<Challenge[]>;
  start(id: string): Promise<Record<string, unknown>>;
  close(id: string): Promise<unknown>;
  submit(id: string, flag: string): Promise<SubmitResult>;
  hint?(id: string): Promise<string | null>;
};

export function emptySubmit(extra: Partial<SubmitResult> = {}): SubmitResult {
  return {
    correct: false,
    awarded: 0,
    cumulative_score: 0,
    correct_flag_count: 0,
    total_flag_count: 0,
    matched_flag_index: null,
    duplicate: false,
    raw: {},
    ...extra,
  };
}
