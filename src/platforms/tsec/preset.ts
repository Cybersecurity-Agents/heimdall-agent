import type { TypeRule } from "../../shared/classify.js";

export const PRESET_NAMES = new Set(["tsecbench-v1", "tsecbench", "v1"]);

export const PREFIX_TYPES: [string, string][] = [
  ["a", "web"],
  ["d", "web"],
  ["f", "pwn"],
  ["c", "cve"],
  ["b", "intranet"],
  ["e", "evasion"],
];

export function isPreset(name: string | null | undefined): boolean {
  return PRESET_NAMES.has(String(name || "").trim().toLowerCase());
}

export function prefixToRegex(prefix: string): string {
  const token = String(prefix || "").trim();
  if (!token) return "";
  const tail = /\d$/.test(token) ? "[-_]" : "[-_0-9]";
  return `^${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|${tail})`;
}

export function presetTypeRules(): TypeRule[] {
  return PREFIX_TYPES.map(([prefix, ws]) => ({
    match: prefixToRegex(prefix),
    type: ws,
  })).filter((r) => r.match);
}

export function workspaceStrategy(): {
  default: string;
  rules: { workspace: string; prefix: string[] }[];
} {
  const grouped = new Map<string, string[]>();
  const order: string[] = [];
  for (const [prefix, ws] of PREFIX_TYPES) {
    if (!grouped.has(ws)) {
      grouped.set(ws, []);
      order.push(ws);
    }
    grouped.get(ws)!.push(prefix);
  }
  return {
    default: "all",
    rules: order.map((ws) => ({ workspace: ws, prefix: grouped.get(ws) || [] })),
  };
}

export function regularSlotBudget(
  cfg: { max_slots?: number; loop_enabled?: boolean; loop_slots?: number },
  opts: { hasLoopWork: boolean; hasRegular: boolean },
): number {
  const maxS = Math.max(1, Number(cfg.max_slots || 3) || 3);
  if (!cfg.loop_enabled) return maxS;
  if (opts.hasLoopWork && opts.hasRegular) {
    return Math.max(0, maxS - Math.max(1, Number(cfg.loop_slots || 1) || 1));
  }
  if (opts.hasLoopWork) return 0;
  return maxS;
}

export function loopEffectiveSlots(
  cfg: { loop_slots?: number; loop_expand_when_idle?: boolean; max_slots?: number },
  opts: { regularIdle: boolean },
): number {
  const base = Math.max(1, Number(cfg.loop_slots || 1) || 1);
  if (opts.regularIdle && cfg.loop_expand_when_idle !== false) {
    return Math.max(base, Math.max(1, Number(cfg.max_slots || 3) || 3));
  }
  return base;
}

/** Regular leftover inventory does not block expand. Only in-flight regulars do. */
export function loopSlotsIdle(opts: { regularInFlight: number }): boolean {
  return (Number(opts.regularInFlight) || 0) <= 0;
}

/** Hold the lab only when this tick can actually start that loop. */
export function shouldHoldInstanceForLoop(opts: {
  loopBudget: number;
  loopInFlight: number;
  queuedAhead: number;
}): boolean {
  const budget = Math.max(0, Number(opts.loopBudget) || 0);
  const flying = Math.max(0, Number(opts.loopInFlight) || 0);
  const ahead = Math.max(0, Number(opts.queuedAhead) || 0);
  return flying + ahead < budget;
}
