import type { Database } from "../shared/db.js";
import { DirectBench } from "./direct.js";
import { TsecClient } from "./tsec/client.js";
import type { Bench } from "./types.js";

export type { Bench, Challenge, SubmitResult, Target } from "./types.js";
export { BenchError, TsecError, challengeFromDict, emptySubmit } from "./types.js";
export { TsecClient } from "./tsec/client.js";
export {
  PREFIX_TYPES,
  PRESET_NAMES,
  isPreset,
  loopEffectiveSlots,
  prefixToRegex,
  presetTypeRules,
  regularSlotBudget,
  workspaceStrategy,
} from "./tsec/preset.js";
export {
  DIRECT_PREFIX,
  DirectBench,
  addrsFromRow,
  codeForUrl,
  ensureDirectChallenge,
  isDirectCode,
  isDirectRow,
  normalizeTargetUrl,
} from "./direct.js";

export function hasRemoteBench(cfg: { base_url?: string; token?: string }): boolean {
  return Boolean((cfg.base_url || "").trim() && (cfg.token || "").trim());
}

export function createBench(cfg: { base_url: string; token: string }, db?: Database): Bench {
  if (hasRemoteBench(cfg)) return new TsecClient(cfg.base_url, cfg.token);
  return new DirectBench(db);
}
