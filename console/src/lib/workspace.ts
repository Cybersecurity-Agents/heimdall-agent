export { resolveWorkspace, type StrategyRule, type WorkspaceStrategy } from "../../../src/shared/workspace-strategy";

export const CLOCK_KEYS: [string, string][] = [
  ["default_timeout_sec", "s"],
  ["loop_timeout_sec", "s"],
  ["loop_hint_after_sec", "s"],
  ["max_slots", ""],
  ["loop_slots", ""],
  ["loop_max_per_challenge", ""],
  ["max_attempts_per_challenge", ""],
  ["poll_interval_sec", "s"],
  ["start_gate_timeout_sec", "s"],
  ["kill_timeout_sec", "s"],
  ["agent_max_turns", "inf"],
  ["observer_every_sec", "s"],
  ["observer_loop_every_sec", "s"],
];

export const PROJECT_CLOCK_KEYS: [string, string][] = [
  ["default_timeout_sec", "s"],
  ["loop_timeout_sec", "s"],
  ["loop_hint_after_sec", "s"],
  ["loop_max_per_challenge", ""],
  ["max_attempts_per_challenge", ""],
  ["agent_max_turns", "inf"],
  ["observer_every_sec", "s"],
  ["observer_loop_every_sec", "s"],
];
