import { GROK_MODELS, GROK_PROFILES, XAI_HOSTS } from "./grok-catalog.js";
import { XAI_MODELS } from "@earendil-works/pi-ai/providers/xai.models";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { MOONSHOTAI_MODELS } from "@earendil-works/pi-ai/providers/moonshotai.models";
import { ZAI_MODELS } from "@earendil-works/pi-ai/providers/zai.models";

export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Level = typeof LEVELS[number];
export const ADAPTERS = ["none", "deepseek", "openai-effort", "thinking-toggle", "anthropic-budget", "claude-adaptive", "grok", "reasoning-default"] as const;
export type Profile = {
  adapter: typeof ADAPTERS[number]; levels: Level[]; aliases?: Partial<Record<Level, Level>>;
};
export const LLM_PROTOCOLS = ["anthropic-messages", "openai-completions", "openai-responses"] as const;
export type LlmProtocol = typeof LLM_PROTOCOLS[number];
export type ModelRecord = {
  provider: string; id: string; aliases?: string[]; profile: string; contextWindow?: number; maxTokens?: number;
  input?: ("text" | "image")[]; protocols?: LlmProtocol[]; supportsTools?: boolean; defaultThinking?: Level;
};
export type CapabilityCatalog = { schemaVersion: 1; version: string; profiles: Record<string, Profile>; models: ModelRecord[] };
const pinned = { anthropic: ANTHROPIC_MODELS, deepseek: DEEPSEEK_MODELS, moonshotai: MOONSHOTAI_MODELS, zai: ZAI_MODELS, xai: XAI_MODELS } as Record<string, Record<string, Model<Api>>>;
const profiles: Record<string, Profile> = {
  ...GROK_PROFILES,
  none: { adapter: "none", levels: ["off"] },
  deepseek: { adapter: "deepseek", levels: ["off", "low", "high", "max"], aliases: { minimal: "low", medium: "high", xhigh: "high" } },
  // GLM-5.3 family and Kimi K3: reasoning is always on, top-level
  // reasoning_effort low/high/max (no medium, no off). The deepseek adapter
  // carries both wire contracts (chat: thinking.type + reasoning_effort;
  // Anthropic: thinking.type + output_config.effort).
  "zai-effort": { adapter: "deepseek", levels: ["low", "high", "max"], aliases: { minimal: "low", medium: "high", xhigh: "max" } },
  "kimi-effort": { adapter: "deepseek", levels: ["low", "high", "max"], aliases: { minimal: "low", medium: "high", xhigh: "max" } },
  "thinking-toggle": { adapter: "thinking-toggle", levels: ["off", "high"] },
  "anthropic-budget": { adapter: "anthropic-budget", levels: ["off", "minimal", "low", "medium", "high"] },
  "claude-adaptive": { adapter: "claude-adaptive", levels: ["off", "low", "medium", "high", "xhigh", "max"], aliases: { minimal: "low" } },
  "openai-effort": { adapter: "openai-effort", levels: ["off", "low", "medium", "high"], aliases: { minimal: "low", xhigh: "high", max: "high" } },
};
const models: ModelRecord[] = [];
for (const [provider, entries] of Object.entries(pinned)) {
  if (provider === "xai") continue; // Curated below; bundled xAI metadata predates Grok 4.7.
  for (const model of Object.values(entries)) {
    const compat = model.compat as { forceAdaptiveThinking?: boolean; supportsReasoningEffort?: boolean } | undefined;
    const adapter = !model.reasoning ? "none" : provider === "anthropic" ? compat?.forceAdaptiveThinking ? "claude-adaptive" : "anthropic-budget"
      : compat?.supportsReasoningEffort === false ? "thinking-toggle" : provider === "deepseek" ? "deepseek" : "openai-effort";
    const supported = getSupportedThinkingLevels(model);
    const levels = adapter === "thinking-toggle" ? supported.includes("off") ? ["off", "high"] as Level[] : ["high"] as Level[]
      : ["claude-adaptive", "openai-effort", "deepseek"].includes(adapter) ? supported.filter(v => v !== "minimal") : supported;
    const profile = `${provider}:${model.id}`;
    profiles[profile] = { adapter, levels, ...(adapter === "deepseek" ? { aliases: { minimal: "low", medium: "high", xhigh: "high" } as Profile["aliases"] } : {}) };
    // Filter aliases for older profiles which do not support low.
    for (const [key, target] of Object.entries(profiles[profile]!.aliases || {})) {
      if (!levels.includes(target)) delete profiles[profile]!.aliases![key as Level];
    }
    models.push({ provider, id: model.id, profile, contextWindow: model.contextWindow, maxTokens: model.maxTokens });
  }
}
// Official V4.1 Flash contract. Model aliases are scoped to the DeepSeek provider.
for (const id of ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
  const index = models.findIndex(m => m.provider === "deepseek" && m.id === id);
  if (index >= 0) models.splice(index, 1);
}
models.push({ provider: "deepseek", id: "deepseek-flash", aliases: ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"], profile: "deepseek", contextWindow: 1_000_000, maxTokens: 384_000 });
// Aggregator gateways serve the same three vendors under display-cased IDs
// (GLM-5.3, Kimi-K3, DeepSeek-V4.1-Flash) instead of the official API IDs.
// Enrich the pinned records with those gateway aliases plus the documented
// capacities (checked 2026-10-16; sources in docs/model-settings.md), and
// remap their profiles onto the deepseek adapter so both wire contracts work:
// chat completions (thinking.type + reasoning_effort) and Anthropic Messages
// (thinking.type + output_config.effort). Case matching stays provider-scoped.
for (const model of models) {
  if (model.provider === "zai" && model.id === "glm-5.3") {
    model.profile = "zai-effort"; model.aliases = ["GLM-5.3", "glink/GLM-5.3:glink_domestic"];
    model.protocols = ["openai-completions", "anthropic-messages"]; model.defaultThinking = "max";
  } else if (model.provider === "zai" && model.id === "glm-5.3-flash") {
    model.profile = "zai-effort"; model.aliases = ["GLM-5.3-Flash", "glm-5.3-flashx", "GLM-5.3-FlashX"];
    model.input = ["text", "image"]; model.protocols = ["openai-completions", "anthropic-messages"]; model.defaultThinking = "max";
  } else if (model.provider === "moonshotai" && model.id === "kimi-k3") {
    model.profile = "kimi-effort"; model.aliases = ["Kimi-K3", "glink/Kimi-K3:glink_domestic"];
    model.input = ["text", "image"]; model.protocols = ["openai-completions", "anthropic-messages"]; model.defaultThinking = "max";
  }
}
// The DeepSeek display ID some gateways use for the same V4.1 Flash contract.
models.push({ provider: "deepseek", id: "DeepSeek-V4.1-Flash", aliases: ["deepseek-v4.1-flash"], profile: "deepseek", contextWindow: 1_000_000, maxTokens: 384_000, protocols: ["openai-completions", "anthropic-messages"], defaultThinking: "max" });
models.push(...GROK_MODELS);
export const BUILTIN_CATALOG: CapabilityCatalog = { schemaVersion: 1, version: "2026-10-16.1", profiles, models };
export const CATALOG_ENV = "HEIMDALL_CAPABILITY_CATALOG";
export const MAX_CATALOG_BYTES = 96 * 1024;

export function validateProfile(value: unknown): Profile {
  const p = value as Profile;
  if (!p || typeof p !== "object" || !ADAPTERS.includes(p.adapter) || !Array.isArray(p.levels) || !p.levels.length || p.levels.some(l => !LEVELS.includes(l)) || new Set(p.levels).size !== p.levels.length) throw new Error("Invalid capability profile adapter/levels");
  if (p.adapter === "none" && (p.levels.length !== 1 || p.levels[0] !== "off")) throw new Error("none profile only supports off");
  if (!["none", "grok"].includes(p.adapter) && !p.levels.some(l => l !== "off")) throw new Error("Reasoning profile needs an enabled level");
  if (p.adapter === "reasoning-default" && (p.levels.length !== 1 || p.levels[0] !== "high")) throw new Error("reasoning-default profile supports enabled thinking only, without effort controls");
  if (p.adapter === "thinking-toggle" && p.levels.some(l => !["off", "high"].includes(l))) throw new Error("Toggle profiles support off/high only; high means enabled, not effort");
  if (["claude-adaptive", "openai-effort", "deepseek", "grok"].includes(p.adapter) && p.levels.includes("minimal")) throw new Error("Use a minimal alias to a native effort level");
  if (p.aliases && (typeof p.aliases !== "object" || Array.isArray(p.aliases) || Object.entries(p.aliases).some(([k, v]) => !LEVELS.includes(k as Level) || !p.levels.includes(v) || ((k === "off") !== (v === "off"))))) throw new Error("Profile aliases must target a supported level");
  return { adapter: p.adapter, levels: LEVELS.filter(l => p.levels.includes(l)), ...(p.aliases ? { aliases: { ...p.aliases } } : {}) };
}
export function validateCatalog(value: unknown): CapabilityCatalog {
  if (Buffer.byteLength(JSON.stringify(value) || "") > MAX_CATALOG_BYTES) throw new Error("Capability catalog exceeds 96 KiB");
  const c = value as CapabilityCatalog;
  if (!c || c.schemaVersion !== 1 || typeof c.version !== "string" || !/^[\w.:-]{1,80}$/.test(c.version) || !c.profiles || typeof c.profiles !== "object" || Array.isArray(c.profiles) || !Array.isArray(c.models)) throw new Error("Invalid capability catalog schema/version");
  const safeProfiles: Record<string, Profile> = Object.create(null);
  for (const [id, profile] of Object.entries(c.profiles)) {
    if (!/^[\w.:-]{1,160}$/.test(id) || ["__proto__", "constructor", "prototype", "auto", "custom"].includes(id)) throw new Error("Invalid profile ID");
    safeProfiles[id] = validateProfile(profile);
  }
  const seen = new Set<string>();
  const safeModels = c.models.map(m => {
    if (!m || typeof m.provider !== "string" || !/^[a-z0-9-]{1,80}$/.test(m.provider) || !Object.hasOwn(safeProfiles, m.profile)) throw new Error("Invalid model provider/profile");
    if (m.input !== undefined && (!Array.isArray(m.input) || !m.input.length || m.input.some(v => !["text", "image"].includes(v)))) throw new Error("Invalid model input modalities");
    if (m.protocols !== undefined && (!Array.isArray(m.protocols) || !m.protocols.length || m.protocols.some(v => !LLM_PROTOCOLS.includes(v)))) throw new Error("Invalid model protocols");
    if (m.supportsTools !== undefined && typeof m.supportsTools !== "boolean") throw new Error("Invalid model tool capability");
    if (m.defaultThinking !== undefined && !safeProfiles[m.profile]!.levels.includes(m.defaultThinking)) throw new Error("Invalid model default thinking");
    if (m.aliases !== undefined && !Array.isArray(m.aliases)) throw new Error("Invalid model aliases");
    for (const id of [m.id, ...(m.aliases || [])]) {
      const key = `${m.provider}\0${id}`;
      if (typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 256 || /[\x00-\x1f]/.test(id) || seen.has(key)) throw new Error("Invalid or duplicate provider-scoped model ID/alias");
      seen.add(key);
    }
    for (const key of ["contextWindow", "maxTokens"] as const) if (m[key] !== undefined && (!Number.isSafeInteger(m[key]) || m[key]! < (key === "contextWindow" ? 8192 : 1024) || m[key]! > 10_000_000)) throw new Error(`Invalid model ${key}`);
    if (m.contextWindow && m.maxTokens && m.maxTokens > m.contextWindow) throw new Error("Model output capacity cannot exceed context capacity");
    return { provider: m.provider, id: m.id, profile: m.profile, ...(m.aliases ? { aliases: [...m.aliases] } : {}), ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}), ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}), ...(m.input ? { input: [...m.input] } : {}), ...(m.protocols ? { protocols: [...m.protocols] } : {}), ...(m.supportsTools !== undefined ? { supportsTools: m.supportsTools } : {}), ...(m.defaultThinking ? { defaultThinking: m.defaultThinking } : {}) };
  });
  return { schemaVersion: 1, version: c.version, profiles: safeProfiles, models: safeModels };
}
export function catalogFromEnv(env: Record<string, string | undefined>): CapabilityCatalog {
  return env[CATALOG_ENV] ? validateCatalog(JSON.parse(env[CATALOG_ENV]!)) : BUILTIN_CATALOG;
}
export function providerScope(env: Record<string, string | undefined>): string {
  const explicit = env.HEIMDALL_CAPABILITY_PROVIDER?.trim().toLowerCase();
  if (explicit) return explicit;
  try {
    const host = new URL(env.HEIMDALL_LLM_UPSTREAM || env.HEIMDALL_LLM_BASE_URL || env.OPENAI_BASE_URL || env.ANTHROPIC_BASE_URL || "").hostname;
    return ({ ...Object.fromEntries(XAI_HOSTS.map(host => [host, "xai"])), "api.deepseek.com": "deepseek", "api.anthropic.com": "anthropic", "api.moonshot.ai": "moonshotai", "api.moonshot.cn": "moonshotai", "api.z.ai": "zai", "open.bigmodel.cn": "zai" } as Record<string, string>)[host] || "";
  } catch { return ""; }
}
export function resolveCapability(env: Record<string, string | undefined>, model: string) {
  const catalog = catalogFromEnv(env), provider = providerScope(env);
  // Aliases match only within a provider namespace. Catalog IDs are opaque
  // upstream values, but aggregator gateways commonly serve display-cased IDs
  // (GLM-5.3 for glm-5.3), so IDs fold case when the exact record is unique.
  const matches = catalog.models.filter(m => {
    const id = m.id === model || m.id.toLowerCase() === model.toLowerCase();
    return provider ? m.provider === provider && (id || m.aliases?.includes(model)) : id;
  });
  const record = matches.length === 1 ? matches[0] : undefined;
  const selection = env.HEIMDALL_CAPABILITY_PROFILE?.trim() || "auto";
  const manual = selection !== "auto";
  const profileId = manual ? selection : record?.profile;
  const profile = selection === "custom" ? validateProfile(JSON.parse(env.HEIMDALL_CAPABILITY_CUSTOM || "{}")) : profileId && Object.hasOwn(catalog.profiles, profileId) ? catalog.profiles[profileId] : undefined;
  if (manual && !profile) throw new Error(`Unknown capability profile: ${selection}`);
  return { record, profile, profileId: profileId || null, provider: provider || record?.provider || null, catalogVersion: catalog.version,
    capabilitySource: manual ? "manual" : record ? provider ? "catalog" : "catalog-unverified" : "unknown" };
}
/** Pinned transport quirks, scoped independently from request model IDs. */
export function pinnedModel(model: string, provider?: string | null): Model<Api> | undefined {
  if (provider) return pinned[provider]?.[model];
  const found = Object.values(pinned).flatMap(p => p[model] ? [p[model]!] : []);
  return found.length === 1 ? found[0] : undefined;
}
