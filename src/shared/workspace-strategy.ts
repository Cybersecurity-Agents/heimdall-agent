import { canonicalType, classifyChallenge } from "./classify.js";
import { isPreset, prefixToRegex, workspaceStrategy as tsecWorkspaceStrategy } from "../platforms/tsec/preset.js";

export const WORKSPACE_IDS = ["all", "web", "pwn", "intranet", "cve", "evasion"] as const;
const PREFIX_RE = /^[A-Za-z][A-Za-z0-9]*$/;
const MAX_STRATEGY_RULES = 64;
const MAX_RULE_TOKENS = 128;

export type StrategyRule = { workspace?: string; codes?: string[]; prefix?: string[]; match?: string };
export type WorkspaceStrategy = { default?: string; preset?: string; rules?: StrategyRule[] };

export function normalizeWorkspace(name: string | null | undefined, fallback = "all"): string {
  let raw = (name || fallback || "all").trim().toLowerCase() || fallback;
  raw = canonicalType(raw);
  if (!(WORKSPACE_IDS as readonly string[]).includes(raw)) return fallback;
  return raw;
}

export function normalizeTaskWorkspace(name: string | null | undefined): string {
  const raw = (name || "").trim().toLowerCase();
  if (!raw || raw === "auto") return "auto";
  return normalizeWorkspace(raw);
}

function cleanTokens(raw: unknown, limit = MAX_RULE_TOKENS): string[] {
  let parts: string[] = [];
  if (typeof raw === "string") parts = raw.split(/[,\s]+/);
  else if (Array.isArray(raw)) parts = raw.map((p) => String(p));
  else return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const tok = String(p || "").trim();
    if (!tok || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= limit) break;
  }
  return out;
}

export function normalizeStrategy(strategy: unknown): Record<string, unknown> {
  if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) {
    return { default: "all", rules: [] };
  }
  const rec = strategy as Record<string, unknown>;
  const defaultWs = normalizeWorkspace(String(rec.default || "all"));
  const rules: Record<string, unknown>[] = [];
  const rulesRaw = rec.rules;
  if (Array.isArray(rulesRaw)) {
    for (const item of rulesRaw) {
      if (!item || typeof item !== "object" || Array.isArray(item) || rules.length >= MAX_STRATEGY_RULES) continue;
      const row = item as Record<string, unknown>;
      const ws = normalizeWorkspace(String(row.workspace || "all"));
      const rule: Record<string, unknown> = { workspace: ws };
      const codes = cleanTokens(row.codes);
      const prefix = cleanTokens(row.prefix).map((p) => p.toLowerCase()).filter((p) => PREFIX_RE.test(p));
      let match = String(row.match || "").trim();
      if (match) {
        try {
          new RegExp(match);
        } catch {
          match = "";
        }
      }
      if (!codes.length && !prefix.length && !match) continue;
      if (codes.length) rule.codes = codes;
      if (prefix.length) rule.prefix = prefix;
      if (match) rule.match = match;
      rules.push(rule);
    }
  }
  const presetRaw = String(rec.preset || "").trim().toLowerCase();
  const preset = isPreset(presetRaw) ? "tsecbench-v1" : "";
  if (preset && !rules.length) {
    const filled = tsecWorkspaceStrategy();
    return { default: filled.default, preset, rules: filled.rules };
  }
  const out: Record<string, unknown> = { default: defaultWs, rules };
  if (preset) out.preset = preset;
  return out;
}

export function strategyToTypes(strategy: unknown): {
  default: string;
  overrides: Record<string, string>;
  rules: { match: string; type: string }[];
} {
  const norm = normalizeStrategy(strategy);
  const overrides: Record<string, string> = {};
  const rules: { match: string; type: string }[] = [];
  for (const rule of (norm.rules as Record<string, unknown>[]) || []) {
    const ws = String(rule.workspace || "all");
    for (const code of (rule.codes as string[]) || []) overrides[code.toLowerCase()] ??= ws;
    for (const prefix of (rule.prefix as string[]) || []) {
      rules.push({ match: `(?i)${prefixToRegex(prefix)}`, type: ws });
    }
    if (rule.match) rules.push({ match: `(?i)${String(rule.match)}`, type: ws });
  }
  return { default: String(norm.default || "all"), overrides, rules };
}

/** UI, scheduler overlays and exported config use the same matching semantics. */
export function resolveWorkspace(strategy: unknown, code: string): string {
  const types = strategyToTypes(strategy);
  return classifyChallenge(code, {
    type_default: types.default,
    type_overrides: types.overrides,
    type_rules: types.rules,
  });
}
