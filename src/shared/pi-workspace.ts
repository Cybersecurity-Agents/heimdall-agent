import { XAI_HOSTS } from "./grok-catalog.js";
import { llmSdkBaseUrl } from "./llm-endpoint.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envStr, flagOn } from "./env.js";
import { applyLoopOptions, resolveLlmOptions, piCompaction, modelCapabilities, LLM_OPTION_SUFFIXES, resolveLlmApi } from "./llm-options.js";

export const DEFAULT_MODEL = "";
export const DEFAULT_BASE_URL = "";
export const DEFAULT_PROVIDER = "aliyun";
/** Model IDs are opaque provider values, including slashes, colons and suffixes. */
export function sdkModelId(model?: string | null): string { return (model || "").trim(); }

/** Claude Code controls are kept here so workspace settings and the query environment agree. */
export function claudeAutocompactEnv(model?: string | null, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const modelId = sdkModelId(model);
  const options = resolveLlmOptions(source, modelId, "sdk");
  const catalogWindow = modelCapabilities(modelId)?.api !== "anthropic-messages" && options.catalogModel ? options.contextWindow : null;
  const windowOverride = options.explicitContext ?? catalogWindow;
  const env: Record<string, string> = {
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(options.compactPct),
    DISABLE_AUTO_COMPACT: options.compactEnabled ? "0" : "1",
    // Empty values clear inherited overrides when returning to SDK defaults.
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: windowOverride ? String(windowOverride) : "",
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: windowOverride ? "1" : "0",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: options.maxOutputTokens ? String(options.maxOutputTokens) : "",
  };
  if (modelId) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = source.HEIMDALL_SMALL_MODEL?.trim() || modelId;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = modelId;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = modelId;
  }
  return env;
}

const INHERIT_AGENT_TYPES = ["general-purpose", "Explore", "Plan", "code-reviewer"] as const;

/** Built-in Agent types follow the main session model. Do not send claude-opus-*. */
export function sdkInheritAgents(): Record<string, { description: string; prompt: string; model: "inherit" }> {
  const out: Record<string, { description: string; prompt: string; model: "inherit" }> = {};
  for (const name of INHERIT_AGENT_TYPES) {
    out[name] = {
      description: `${name} (inherit main model)`,
      prompt: "Follow the parent solver. Use the same model as the main session.",
      model: "inherit",
    };
  }
  return out;
}

const OVERRIDE_MODEL_KEYS = [
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "opus",
  "sonnet",
  "haiku",
] as const;

/** Map Anthropic aliases / ids the Agent tool emits onto the live gateway model. */
export function sdkModelOverrides(model?: string | null): Record<string, string> {
  const modelId = sdkModelId(model);
  if (!modelId) return {};
  const out: Record<string, string> = {};
  for (const key of OVERRIDE_MODEL_KEYS) out[key] = modelId;
  const small = process.env.HEIMDALL_SMALL_MODEL?.trim();
  if (small) { out.haiku = small; out["claude-haiku-4-5"] = small; }
  return out;
}

export const RETRY = {
  enabled: true,
  maxRetries: 5,
  baseDelayMs: 2000,
  provider: {
    timeoutMs: 600_000,
    maxRetries: 0,
    maxRetryDelayMs: 60_000,
  },
} as const;

export const SOLVER_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

const KEY_CANDIDATES = [
  "HEIMDALL_LLM_API_KEY",
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "DASHSCOPE_API_KEY",
  "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "HEIMDALL_COACH_API_KEY",
] as const;

export function piProjectDir(workspace: string): string {
  return join(workspace, ".pi");
}

export function piAgentDir(workspace: string): string {
  const override = (process.env.PI_CODING_AGENT_DIR || "").trim();
  if (override) return override;
  return join(workspace, ".heimdall", "pi");
}

export function resolveModelId(model?: string | null): string {
  let raw =
    (model ||
      process.env.HEIMDALL_AGENT_MODEL ||
      process.env.OPENAI_MODEL ||
      process.env.ANTHROPIC_MODEL ||
      DEFAULT_MODEL) ?? "";
  raw = String(raw).trim();
  return raw || DEFAULT_MODEL;
}

export function resolveBaseUrl(): string {
  return (
    envStr("HEIMDALL_LLM_BASE_URL", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL") ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
}

export function inferApi(baseUrl: string, explicit?: string | null): string {
  return resolveLlmApi(baseUrl, explicit || process.env.HEIMDALL_LLM_API || "");
}

export function resolveProviderFromUrl(baseUrl?: string | null, api?: string | null): string {
  const url = (baseUrl || "").trim();
  const kind = api || inferApi(url, null);
  try { if ((XAI_HOSTS as readonly string[]).includes(new URL(url).hostname)) return "xai"; } catch { /* unset URL */ }
  if (kind === "anthropic-messages") return "anthropic";
  if (url.toLowerCase().includes("aliyun") || url.toLowerCase().includes("maas.aliyuncs.com")) {
    return DEFAULT_PROVIDER;
  }
  return "openai";
}

export function resolveProvider(baseUrl?: string | null, api?: string | null): string {
  const env = (process.env.HEIMDALL_LLM_PROVIDER || "").trim();
  if (env) return env;
  return resolveProviderFromUrl(baseUrl ?? resolveBaseUrl(), api);
}

/** Observer + loop summarizer: LOOP_* key/url/model first, then COACH_*, then Pi. */
export function applyCoachLlmEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Connections are shared; solver/SDK budgets must not leak into the observer's Pi session.
  for (const suffix of LLM_OPTION_SUFFIXES) env[`HEIMDALL_${suffix}`] = env[`HEIMDALL_COACH_${suffix}`] || "";
  env.HEIMDALL_THINKING ||= "high";
  const url = (
    String(env.HEIMDALL_LOOP_BASE_URL || "").trim() ||
    String(env.HEIMDALL_COACH_BASE_URL || "").trim() ||
    String(env.HEIMDALL_LLM_BASE_URL || "").trim() ||
    String(env.ANTHROPIC_BASE_URL || "").trim() ||
    String(env.OPENAI_BASE_URL || "").trim()
  ).replace(/\/+$/, "");
  const model = (
    String(env.HEIMDALL_LOOP_MODEL || "").trim() ||
    String(env.HEIMDALL_COACH_MODEL || "").trim() ||
    String(env.ANTHROPIC_MODEL || "").trim() ||
    String(env.HEIMDALL_AGENT_MODEL || "").trim() ||
    String(env.OPENAI_MODEL || "").trim()
  );
  const key = (
    String(env.HEIMDALL_LOOP_API_KEY || "").trim() ||
    String(env.HEIMDALL_LOOP_AUTH_TOKEN || "").trim() ||
    String(env.HEIMDALL_COACH_API_KEY || "").trim() ||
    String(env.HEIMDALL_COACH_AUTH_TOKEN || "").trim() ||
    firstLlmKey(env)
  );
  const separateConnection = Boolean(env.HEIMDALL_LOOP_BASE_URL?.trim() || env.HEIMDALL_COACH_BASE_URL?.trim());
  const sourceUpstream = env.HEIMDALL_LLM_UPSTREAM;
  const api = resolveLlmApi(
    separateConnection ? url : sourceUpstream || url,
    ((env.HEIMDALL_LOOP_BASE_URL || env.HEIMDALL_LOOP_MODEL) ? String(env.HEIMDALL_LOOP_API || "").trim() : "") ||
      ((env.HEIMDALL_COACH_BASE_URL || env.HEIMDALL_COACH_MODEL) ? String(env.HEIMDALL_COACH_API || "").trim() : "") ||
      (separateConnection ? "" : env.HEIMDALL_LLM_API || ""),
  );
  if (url) {
    env.HEIMDALL_COACH_BASE_URL = url;
    env.HEIMDALL_LLM_BASE_URL = url;
    env.HEIMDALL_LLM_UPSTREAM = isLlmTapClientUrl(url, env) ? sourceUpstream || url : url;
    env.OPENAI_BASE_URL = url;
    env.ANTHROPIC_BASE_URL = url;
  }
  if (model) {
    env.HEIMDALL_COACH_MODEL = model;
    env.ANTHROPIC_MODEL = model;
    env.OPENAI_MODEL = model;
    env.HEIMDALL_AGENT_MODEL = model;
  }
  if (key) {
    env.HEIMDALL_COACH_API_KEY = key;
    env.HEIMDALL_COACH_AUTH_TOKEN = key;
    for (const name of KEY_CANDIDATES) env[name] = key;
  }
  env.HEIMDALL_LLM_API = api;
  env.HEIMDALL_COACH_API = api === "openai-responses" ? "openai-responses" : api.includes("anthropic") ? "anthropic" : "openai";
  const provider = resolveProviderFromUrl(url, api);
  env.HEIMDALL_LLM_PROVIDER = provider;
  env.HEIMDALL_COACH_PROVIDER = provider;
  return env;
}

export function seedCoachAgentDir(agentDir: string, environ: NodeJS.ProcessEnv = process.env): string {
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  const url = (
    String(environ.HEIMDALL_LOOP_BASE_URL || "").trim() ||
    String(environ.HEIMDALL_COACH_BASE_URL || "").trim() ||
    String(environ.HEIMDALL_LLM_BASE_URL || "").trim() ||
    String(environ.ANTHROPIC_BASE_URL || "").trim() ||
    ""
  ).replace(/\/+$/, "");
  const model =
    String(environ.HEIMDALL_LOOP_MODEL || "").trim() ||
    String(environ.HEIMDALL_COACH_MODEL || "").trim() ||
    String(environ.ANTHROPIC_MODEL || "").trim() ||
    "";
  const api = inferApi(url, environ.HEIMDALL_LOOP_API || environ.HEIMDALL_COACH_API || environ.HEIMDALL_LLM_API || "");
  const provider = resolveProviderFromUrl(url, api);
  const coachEnv = { ...environ, HEIMDALL_LLM_API: api };
  writeJson(join(agentDir, "settings.json"), piAgentSettings(model, coachEnv));
  writeJson(join(agentDir, "models.json"), buildModelsDoc({
    modelId: resolveModelId(model), baseUrl: url, provider,
    env: coachEnv,
  }));
  return agentDir;
}


export function firstLlmKey(env: NodeJS.ProcessEnv = process.env): string {
  for (const name of KEY_CANDIDATES) {
    const val = String(env[name] || "").trim();
    if (val) return val;
  }
  return "";
}

export function isLlmTapClientUrl(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const port = String(env.HEIMDALL_LLM_TAP_PORT || "").trim();
  const raw = (url || "").trim();
  if (!port || !raw) return false;
  try {
    const u = new URL(raw);
    const host = (u.hostname || "").toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return false;
    return u.port === port;
  } catch {
    return false;
  }
}

export function applyLoopLlmEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!flagOn(env.HEIMDALL_LOOP)) return env;
  applyLoopOptions(env);
  const key =
    String(env.HEIMDALL_LOOP_API_KEY || "").trim() ||
    String(env.HEIMDALL_LOOP_AUTH_TOKEN || "").trim();
  const url = String(env.HEIMDALL_LOOP_BASE_URL || "").trim().replace(/\/+$/, "");
  const model = String(env.HEIMDALL_LOOP_MODEL || "").trim();
  const api = String(env.HEIMDALL_LOOP_API || "").trim();
  const provider = String(env.HEIMDALL_LOOP_PROVIDER || "").trim();
  if (!key && !url && !model) return env;
  if (key) {
    for (const name of [
      "HEIMDALL_LLM_API_KEY",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "DASHSCOPE_API_KEY",
      "DEEPSEEK_API_KEY",
    ]) {
      env[name] = key;
    }
  }
  if (url) {
    env.HEIMDALL_LLM_UPSTREAM = url;
    const clients = [
      String(env.ANTHROPIC_BASE_URL || ""),
      String(env.OPENAI_BASE_URL || ""),
      String(env.HEIMDALL_LLM_BASE_URL || ""),
    ];
    // Entrypoint already rewrote the solver URL to the per-job llm-tap.
    // Keep the wrap so session logs / inject still see the traffic.
    if (!clients.some((u) => isLlmTapClientUrl(u, env))) {
      env.HEIMDALL_LLM_BASE_URL = url;
      env.OPENAI_BASE_URL = url;
      env.ANTHROPIC_BASE_URL = url;
    }
  }
  if (model) {
    const requestModel = sdkModelId(model);
    env.ANTHROPIC_MODEL = requestModel;
    env.OPENAI_MODEL = requestModel;
    env.HEIMDALL_AGENT_MODEL = requestModel;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = env.HEIMDALL_SMALL_MODEL?.trim() || requestModel;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = requestModel;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = requestModel;
  }
  if (api || url) env.HEIMDALL_LLM_API = api || resolveLlmApi(url);
  if (provider) env.HEIMDALL_LLM_PROVIDER = provider;
  return env;
}

export function syncLlmEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const key = firstLlmKey(env);
  if (key) {
    for (const name of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "DASHSCOPE_API_KEY",
    ]) {
      if (!String(env[name] || "").trim()) env[name] = key;
    }
  }
  const url = (
    String(env.HEIMDALL_LLM_BASE_URL || "").trim() ||
    String(env.OPENAI_BASE_URL || "").trim() ||
    String(env.ANTHROPIC_BASE_URL || "").trim() ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
  if (url) {
    if (!String(env.HEIMDALL_LLM_BASE_URL || "").trim()) env.HEIMDALL_LLM_BASE_URL = url;
    if (!String(env.OPENAI_BASE_URL || "").trim()) env.OPENAI_BASE_URL = url;
    if (!String(env.ANTHROPIC_BASE_URL || "").trim()) env.ANTHROPIC_BASE_URL = url;
  }
  const given =
    String(env.HEIMDALL_AGENT_MODEL || "").trim() ||
    String(env.OPENAI_MODEL || "").trim() ||
    String(env.ANTHROPIC_MODEL || "").trim();
  const model = given ? resolveModelId(given) : "";
  if (model) {
    if (!String(env.ANTHROPIC_MODEL || "").trim()) env.ANTHROPIC_MODEL = model;
    if (!String(env.OPENAI_MODEL || "").trim()) env.OPENAI_MODEL = model;
    if (!String(env.HEIMDALL_AGENT_MODEL || "").trim()) env.HEIMDALL_AGENT_MODEL = model;
  }
  return env;
}

export function piAgentSettings(model?: string | null, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const options = resolveLlmOptions(env, resolveModelId(model), "pi");
  return {
    defaultProjectTrust: "always",
    defaultProvider: resolveProvider(),
    defaultModel: resolveModelId(model),
    defaultThinkingLevel: options.thinking,
    defaultTools: [...SOLVER_TOOLS],
    compaction: piCompaction(options),
    ...(options.explicitBudget ? { thinkingBudgets: { minimal: options.thinkingBudget, low: options.thinkingBudget, medium: options.thinkingBudget, high: options.thinkingBudget } } : {}),
    retry: structuredClone(RETRY),
    enableInstallTelemetry: false,
  };
}

function openaiProvider(modelId: string, baseUrl: string, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const options = resolveLlmOptions(env, modelId, "pi");
  const known = modelCapabilities(modelId, options.capabilityProvider);
  return {
    baseUrl,
    api: options.protocol,
    apiKey: "$OPENAI_API_KEY",
    authHeader: true,
    compat: options.protocol === "openai-responses" ? {
      supportsDeveloperRole: true,
      supportsLongCacheRetention: false,
      ...(known?.api === "openai-responses" ? known.compat : {}),
    } : {
      supportsDeveloperRole: false,
      supportsReasoningEffort: options.effort !== null,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
      requiresToolResultName: true,

      ...(known?.api === "openai-completions" ? known.compat : {}),
    },
    models: [
      {
        id: modelId,
        name: modelId,
        reasoning: options.reasoning,
        input: options.input,
        contextWindow: options.contextWindow,
        maxTokens: options.maxOutputTokens,
        thinkingLevelMap: options.thinkingLevelMap,
      },
    ],
  };
}

function anthropicProvider(modelId: string, baseUrl: string, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const options = resolveLlmOptions(env, modelId, "pi");
  const provider: Record<string, unknown> = {
    apiKey: "$ANTHROPIC_API_KEY",
    api: "anthropic-messages",
    compat: { ...(modelCapabilities(modelId)?.api === "anthropic-messages" ? modelCapabilities(modelId)?.compat : {}), supportsEagerToolInputStreaming: false },
    models: [
      {
        id: modelId,
        name: modelId,
        reasoning: options.reasoning,
        thinkingLevelMap: options.thinkingLevelMap,
        input: options.input,
        contextWindow: options.contextWindow,
        maxTokens: options.maxOutputTokens,
      },
    ],
  };
  if (baseUrl) provider.baseUrl = baseUrl;
  return provider;
}

export function buildModelsDoc(opts: {
  modelId: string;
  baseUrl: string;
  provider?: string | null;
  env?: NodeJS.ProcessEnv;
}): Record<string, unknown> {
  const source = opts.env ?? process.env;
  const env = { ...source, HEIMDALL_LLM_BASE_URL: source.HEIMDALL_LLM_BASE_URL || opts.baseUrl };
  const api = resolveLlmOptions(env, opts.modelId, "pi").protocol;
  const name = (opts.provider || "").trim() || resolveProvider(opts.baseUrl, api);
  const baseUrl = llmSdkBaseUrl(opts.baseUrl, api);
  if (api === "openai-completions" || api === "openai-responses") {
    return { providers: { [name]: openaiProvider(opts.modelId, baseUrl, env) } };
  }
  return { providers: { [name]: anthropicProvider(opts.modelId, baseUrl, env) } };
}

function writeJson(path: string, doc: unknown): void {
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", "utf8");
}

export function seedPiWorkspace(
  workspace: string,
  opts: { systemPrompt: string; model?: string | null },
): string {
  resolveLlmOptions(process.env, resolveModelId(opts.model), "pi");
  mkdirSync(workspace, { recursive: true });
  const project = piProjectDir(workspace);
  const agent = piAgentDir(workspace);
  mkdirSync(project, { recursive: true });
  mkdirSync(join(agent, "sessions"), { recursive: true });

  const prompt = (opts.systemPrompt || "").trim() + "\n";
  try {
    writeFileSync(join(project, "SYSTEM.md"), prompt, "utf8");
  } catch {
    /* resume-safe */
  }
  try {
    writeJson(join(project, "settings.json"), {
      skills: ["../.claude/skills"],
      compaction: piCompaction(resolveLlmOptions(process.env, resolveModelId(opts.model), "pi")),
    });
  } catch {
    /* ignore */
  }
  try {
    writeJson(join(agent, "settings.json"), piAgentSettings(opts.model));
  } catch {
    /* ignore */
  }
  try {
    writeJson(
      join(agent, "models.json"),
      buildModelsDoc({
        modelId: resolveModelId(opts.model),
        baseUrl: resolveBaseUrl(),
      }),
    );
  } catch {
    /* ignore */
  }
  return agent;
}
