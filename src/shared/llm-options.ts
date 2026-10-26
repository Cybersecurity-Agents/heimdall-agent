import { XAI_HOSTS } from "./grok-catalog.js";
import { resolveCapability, pinnedModel, LEVELS, type Level, type LlmProtocol } from "./model-capabilities.js";
/** One resolver for console validation, workspace files and both transports. No network calls. */
export const THINKING_LEVELS = LEVELS;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export const LLM_OPTION_SUFFIXES = [
  "THINKING", "THINKING_MODE", "THINKING_BUDGET", "CONTEXT_WINDOW", "MAX_OUTPUT_TOKENS",
  "COMPACT_ENABLED", "COMPACT_PCT", "COMPACT_KEEP_RECENT_TOKENS", "REASONING",
  "CAPABILITY_PROFILE", "CAPABILITY_PROVIDER", "CAPABILITY_CUSTOM",
] as const;
export class SdkEndpointError extends Error {}
type Env = Record<string, string | undefined>;
export const modelCapabilities = pinnedModel;

export function llmOptionKeys(loop = false): string[] {
  return LLM_OPTION_SUFFIXES.map(key => `HEIMDALL_${loop ? "LOOP_" : ""}${key}`);
}

export function resolveLlmApi(baseUrl: string, explicit = ""): LlmProtocol {
  const protocol = explicit.trim().toLowerCase();
  if (["responses", "openai-responses"].includes(protocol)) return "openai-responses";
  if (["anthropic", "anthropic-messages", "messages"].includes(protocol)) return "anthropic-messages";
  if (["openai", "openai-completions", "openai-compatible", "compatible"].includes(protocol)) return "openai-completions";
  if (protocol && protocol !== "auto") throw new Error("HEIMDALL_LLM_API: unsupported API protocol");
  if (/\/responses\/?$/i.test(baseUrl)) return "openai-responses";
  if (/\/anthropic|\/messages\/?$/i.test(baseUrl)) return "anthropic-messages";
  try {
    const host = new URL(baseUrl).hostname;
    if (host === "api.anthropic.com") return "anthropic-messages";
    if ((XAI_HOSTS as readonly string[]).includes(host)) return "openai-responses";
  } catch { /* empty or incomplete URL */ }
  return "openai-completions";
}

/** Loop tuning is independent; empty values use backend defaults, not solver tuning. */
export function applyLoopOptions(env: Env): void {
  for (const suffix of LLM_OPTION_SUFFIXES) env[`HEIMDALL_${suffix}`] = env[`HEIMDALL_LOOP_${suffix}`] || "";
  env.HEIMDALL_THINKING ||= "max";
}

export function resolveLlmOptions(env: Env, model: string, backend: "pi" | "sdk" = "pi") {
  const get = (key: string) => ((key === "THINKING" ? env.HEIMDALL_THINKING ?? env.HEIMDALL_THINKING_LEVEL : env[`HEIMDALL_${key}`]) || "").trim().toLowerCase();
  function choice<T extends string>(key: string, choices: readonly T[], fallback: T): T {
    const value = get(key) || fallback;
    if (!choices.includes(value as T)) throw new Error(`HEIMDALL_${key}: expected ${choices.join(" / ")}`);
    return value as T;
  }
  function integer(key: string, min: number, max: number): number | null {
    const raw = get(key);
    if (!raw || raw === "auto") return null;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) {
      throw new Error(`HEIMDALL_${key}: expected an integer between ${min} and ${max}, or auto`);
    }
    return Number(raw);
  }
  const capability = resolveCapability(env, model);
  const known = capability.record;
  const profile = capability.profile;
  let adapter = profile?.adapter ?? "none";
  const requestedThinking = choice("THINKING", THINKING_LEVELS, known?.defaultThinking ?? "high");
  if (known?.supportsTools === false) throw new Error(`${model} does not support client-side function calling required by the solver; choose a standard Grok text model`);
  const reasoningSetting = choice("REASONING", ["auto", "true", "false"], "auto");
  if (reasoningSetting === "true" && !profile) throw new Error("Select a capability profile to enable reasoning for an unknown model");
  const reasoning = reasoningSetting !== "false" && adapter !== "none" && !!profile?.levels.some(l => l !== "off");
  const mode = choice("THINKING_MODE", ["auto", "adaptive", "enabled", "disabled"], "auto");
  const explicitContext = integer("CONTEXT_WINDOW", 8192, 10_000_000);
  const contextWindow = explicitContext ?? (known?.contextWindow ?? (backend === "pi" ? 128_000 : null));
  const explicitOutput = integer("MAX_OUTPUT_TOKENS", 1024, 1_000_000);
  const outputDefault = Math.min(known?.maxTokens ?? 32768, 32768, Math.floor((contextWindow ?? 128000) / 4));
  const maxOutputTokens = explicitOutput ?? (backend === "pi" ? outputDefault : null);
  const outputLimit = maxOutputTokens ?? known?.maxTokens ?? null;
  if (explicitOutput && known?.maxTokens && explicitOutput > known.maxTokens) throw new Error("MAX_OUTPUT_TOKENS exceeds the model catalog limit");
  if (contextWindow && maxOutputTokens && maxOutputTokens + 4096 >= contextWindow) throw new Error("CONTEXT_WINDOW must leave room for input beyond MAX_OUTPUT_TOKENS + 4096");
  const compactEnabled = choice("COMPACT_ENABLED", ["true", "false"], "true") === "true";
  const compactPct = integer("COMPACT_PCT", 10, 90) ?? 70;
  const reserveTokens = contextWindow ? Math.ceil(contextWindow * (100 - compactPct) / 100) : null;
  if (compactEnabled && reserveTokens && maxOutputTokens && reserveTokens < maxOutputTokens + 1024) {
    throw new Error("COMPACT_PCT leaves insufficient room for output; lower the threshold or output limit");
  }
  const keepRecentTokens = integer("COMPACT_KEEP_RECENT_TOKENS", 1024, 2_000_000)
    ?? (contextWindow ? Math.min(250000, Math.floor(contextWindow / 4)) : null);
  if (contextWindow && keepRecentTokens && keepRecentTokens >= contextWindow - (reserveTokens ?? 0)) {
    throw new Error("COMPACT_KEEP_RECENT_TOKENS must be below the compaction trigger");
  }
  const baseUrl = env.HEIMDALL_LLM_UPSTREAM || env.HEIMDALL_LLM_BASE_URL || env.OPENAI_BASE_URL || env.ANTHROPIC_BASE_URL || "";
  let nativeXai = false;
  try { nativeXai = (XAI_HOSTS as readonly string[]).includes(new URL(baseUrl).hostname); } catch { /* unset URL */ }
  if (backend === "sdk" && nativeXai) throw new SdkEndpointError("Claude SDK requires an Anthropic-compatible gateway; use Pi for the native xAI API");
  const protocol = backend === "sdk" ? "anthropic-messages" : resolveLlmApi(baseUrl, env.HEIMDALL_LLM_API);
  // CLIProxy and similar gateways accept Anthropic Messages and translate effort upstream.
  // Native api.x.ai does not. Keep catalog levels; emit adaptive thinking on that wire.
  const gatewayGrok = protocol === "anthropic-messages" && !nativeXai && adapter === "grok";
  if (gatewayGrok) adapter = "claude-adaptive";
  // Explicit manual gateway profiles may select a different wire contract than native metadata.
  if (known?.protocols && capability.capabilitySource !== "manual" && !known.protocols.includes(protocol) && !gatewayGrok) throw new (backend === "sdk" ? SdkEndpointError : Error)(`${model} requires ${known.protocols.join(" / ")}; for Claude SDK choose an Anthropic gateway and its documented capability profile`);
  if (profile && ((["anthropic-budget", "claude-adaptive"].includes(adapter) && protocol !== "anthropic-messages") || (["openai-effort", "grok", "reasoning-default"].includes(adapter) && protocol === "anthropic-messages") || (["deepseek", "thinking-toggle"].includes(adapter) && protocol === "openai-responses"))) {
    throw new Error(`Capability profile ${capability.profileId} does not support ${protocol}`);
  }
  const supportedThinking: Level[] = reasoning ? [...profile!.levels] : ["off"];
  const off = mode === "disabled" || requestedThinking === "off" || !reasoning;
  if (off && profile && !profile.levels.includes("off")) throw new Error("This capability profile cannot disable thinking");
  const alias = profile?.aliases?.[requestedThinking];
  const thinking: Level = off ? "off" : alias || (supportedThinking.includes(requestedThinking) ? requestedThinking
    : supportedThinking.find(l => l !== "off" && LEVELS.indexOf(l) >= LEVELS.indexOf(requestedThinking)) || supportedThinking.at(-1)!);
  const adaptive = adapter === "claude-adaptive";
  const requiresAdaptive = adaptive;
  const explicitBudget = integer("THINKING_BUDGET", 1024, 999_999);
  if (explicitBudget && adapter !== "anthropic-budget") throw new Error("THINKING_BUDGET requires an anthropic-budget capability profile");
  if (mode === "adaptive" && !adaptive) throw new Error("Adaptive thinking requires a claude-adaptive capability profile");
  if (mode === "enabled" && adaptive) throw new Error("This profile requires adaptive thinking");
  if (mode !== "auto" && mode !== "disabled" && !reasoning) throw new Error("Select a reasoning capability profile first");
  if (explicitBudget && outputLimit && explicitBudget > outputLimit - 1024) throw new Error("THINKING_BUDGET must leave at least 1024 output tokens for the answer");
  const thinkingMode = thinking === "off" ? "disabled" : adaptive ? "adaptive" : "enabled";
  const thinkingLevelMap = Object.fromEntries(LEVELS.map(level => [level, supportedThinking.includes(level) ? level : null]));
  const defaultBudget = backend === "pi"
    ? thinking === "minimal" ? 1024 : thinking === "low" ? 2048 : thinking === "medium" ? 8192 : 16384
    : requestedThinking === "minimal" ? 2048 : thinking === "low" ? 4096 : thinking === "medium" ? 8192 : 32768;
  const thinkingBudget = explicitBudget ?? Math.min(defaultBudget, (outputLimit ?? 65536) - 1024);
  const effort = (["deepseek", "openai-effort", "claude-adaptive", "grok"].includes(adapter) && thinking !== "off" ? thinking : null) as "low" | "medium" | "high" | "xhigh" | "max" | null;
  return {
    backend, model, protocol, adapter, input: known?.input ?? ["text"], profileId: capability.profileId, capabilitySource: capability.capabilitySource,
    catalogVersion: capability.catalogVersion, capabilityProvider: capability.provider, catalogModel: known?.id ?? null, requestedThinking, thinking, supportedThinking,
    reasoning, thinkingLevelMap, supportsAdaptive: adaptive, requiresAdaptive, thinkingMode, thinkingBudget, explicitBudget, effort,
    contextWindow, contextSource: explicitContext ? "custom" : known?.contextWindow ? "catalog" : backend === "pi" ? "fallback" : "sdk",
    explicitContext, maxOutputTokens, compactEnabled, compactPct, reserveTokens, keepRecentTokens,
  };
}

export type LlmOptions = ReturnType<typeof resolveLlmOptions>;

export function piCompaction(options: LlmOptions) {
  return { enabled: options.compactEnabled, reserveTokens: options.reserveTokens!, keepRecentTokens: options.keepRecentTokens! };
}

export function claudeThinkingOptions(options: LlmOptions) {
  if (options.capabilitySource === "unknown") return {};
  if (options.thinkingMode === "disabled") return { thinking: { type: "disabled" as const } };
  return {
    thinking: options.thinkingMode === "adaptive" ? { type: "adaptive" as const }
      : { type: "enabled" as const, budgetTokens: options.thinkingBudget },
    ...(options.effort ? { effort: options.effort } : {}),
  };
}
