import type { TypeRule } from "../shared/classify.js";

export type PolicyCfg = {
  type_overrides?: Record<string, string>;
  type_by_level?: Record<number, string>;
  type_rules?: TypeRule[];
  type_default?: string;
  skip_codes?: string[];
  dispatch_waves?: string[][];
  lab_exclusive_types?: string[];
  lab_exclusive_max?: number;
  lab_scout_timeout_sec?: number;
  lab_defer_loop_until_scouted?: boolean;
  resources_enabled?: boolean;
  addr_mutex?: boolean;
  loop_direct_types?: string[];
  loop_direct_codes?: string[];
  is_loop_direct_code?: (uniqueCode: string, challengeType?: string | null) => boolean;
  is_loop_direct_type?: (challengeType?: string | null) => boolean;
};

export type ChallengeRow = Record<string, unknown> & {
  unique_code?: string;
  is_completed?: unknown;
  description?: unknown;
  level?: unknown;
  total_score?: unknown;
  flag_count?: unknown;
  correct_flag_count?: unknown;
  container_status?: unknown;
  container_addr?: unknown;
  container_addr_json?: unknown;
};

export type LoopDb = {
  listChallenges?: (opts?: { incompleteOnly?: boolean }) => ChallengeRow[];
  getLoopEntry?: (code: string) => Record<string, unknown> | null;
  nextAttemptN?: (code: string) => number;
  getChallenge?: (code: string) => ChallengeRow | null;
};
