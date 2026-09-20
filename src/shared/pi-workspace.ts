import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envStr, flagOn } from "./env.js";

export const DEFAULT_MODEL = "";
export const DEFAULT_BASE_URL = "";
export const DEFAULT_PROVIDER = "aliyun";
export const DEFAULT_THINKING = "high";

export const CONTEXT_WINDOW = 1_000_000;
export const COMPACT_RATIO = 0.7;
export const COMPACT_THRESHOLD = COMPACT_RATIO * 100;

export const COMPACTION = {
  enabled: true,
  reserveTokens: Math.trunc(CONTEXT_WINDOW * (1 - COMPACT_RATIO)),
  keepRecentTokens: 250_000,
} as const;

/**
 * Claude Code model id. DeepSeek / Kimi accept `name[1m]` for the 1M window.
 * Zhipu GLM's Anthropic catalog does not — `glm-…[1m]` is 400 modelCode 不存在.
 */
export function sdkModelId(model?: string | null): string {
  const raw = (model || "").trim();
  if (!raw) return "";
  if (/^glm/i.test(raw)) return raw.replace(/\[1m\]$/i, "");
  if (raw.toLowerCase().includes("[1m]")) return raw;
  return `${raw}[1m]`;
}

/** Claude Code / loop SDK: fire auto-compact at the same 70% as Pi. */
export function claudeAutocompactEnv(model?: string | null): Record<string, string> {
  const modelId = sdkModelId(model);
  const env: Record<string, string> = {
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(Math.round(COMPACT_THRESHOLD)),
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(CONTEXT_WINDOW),
  };
  if (modelId) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = process.env.HEIMDALL_SMALL_MODEL?.trim() || modelId;
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

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

const KEY_CANDIDATES = [
  "HEIMDALL_LLM_API_KEY",
  "OPENAI_API_KEY",
  "DASHSCOPE_API_KEY",
  "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "HEIMDALL_COACH_API_KEY",
] as const;

const THINKING: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

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
  if (raw.includes("/")) raw = raw.split("/", 2)[1] ?? raw;
  if (raw.includes(":")) raw = raw.split(":", 2)[0] ?? raw;
  return raw || DEFAULT_MODEL;
}

export function resolveBaseUrl(): string {
  return (
    envStr("HEIMDALL_LLM_BASE_URL", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL") ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
}

export function inferApi(baseUrl: string, explicit?: string | null): string {
  const raw = (
    explicit ||
    process.env.HEIMDALL_LLM_API ||
    ""
  )
    .trim()
    .toLowerCase();
  if (["openai", "openai-completions", "openai-compatible", "compatible"].includes(raw)) {
    return "openai-completions";
  }
  if (["anthropic", "anthropic-messages", "messages"].includes(raw)) {
    return "anthropic-messages";
  }
  const u = (baseUrl || "").toLowerCase();
  if (u.includes("/anthropic") || u.replace(/\/+$/, "").endsWith("/messages")) {
    return "anthropic-messages";
  }
  return "openai-completions";
}

export function resolveProviderFromUrl(baseUrl?: string | null, api?: string | null): string {
  const url = (baseUrl || "").trim();
  const kind = api || inferApi(url, null);
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
  const api = inferApi(
    url,
    String(env.HEIMDALL_LOOP_API || "").trim() ||
      String(env.HEIMDALL_COACH_API || "").trim() ||
      (url ? (url.toLowerCase().includes("/anthropic") || url.replace(/\/+$/, "").endsWith("/messages") ? "anthropic" : "openai") : env.HEIMDALL_LLM_API || ""),
  );
  if (url) {
    env.HEIMDALL_COACH_BASE_URL = url;
    env.HEIMDALL_LLM_BASE_URL = url;
    env.HEIMDALL_LLM_UPSTREAM = url;
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
  env.HEIMDALL_COACH_API = api.includes("anthropic") ? "anthropic" : "openai";
  const provider = resolveProviderFromUrl(url, api);
  env.HEIMDALL_LLM_PROVIDER = provider;
  env.HEIMDALL_COACH_PROVIDER = provider;
  return env;
}

export function seedCoachAgentDir(agentDir: string, environ: NodeJS.ProcessEnv = process.env): string {
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify(
      {
        defaultProjectTrust: "always",
        compaction: { ...COMPACTION },
        retry: structuredClone(RETRY),
        enableInstallTelemetry: false,
      },
      null,
      2,
    ) + "\n",
  );
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
  const prev = process.env.HEIMDALL_LLM_API;
  process.env.HEIMDALL_LLM_API = api;
  try {
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify(
        buildModelsDoc({
          modelId: resolveModelId(model),
          baseUrl: url,
          provider,
        }),
        null,
        2,
      ) + "\n",
    );
  } finally {
    if (prev === undefined) delete process.env.HEIMDALL_LLM_API;
    else process.env.HEIMDALL_LLM_API = prev;
  }
  return agentDir;
}

export function resolveThinking(): ThinkingLevel {
  const raw = (
    process.env.HEIMDALL_THINKING ||
    process.env.HEIMDALL_THINKING_LEVEL ||
    DEFAULT_THINKING
  )
    .trim()
    .toLowerCase();
  return (THINKING.has(raw) ? raw : DEFAULT_THINKING) as ThinkingLevel;
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
  const think =
    String(env.HEIMDALL_LOOP_THINKING || "").trim() ||
    String(env.HEIMDALL_THINKING || "").trim() ||
    "max";
  env.HEIMDALL_LOOP_THINKING = think;
  env.HEIMDALL_THINKING = think;
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
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(CONTEXT_WINDOW);
  }
  if (api) env.HEIMDALL_LLM_API = api;
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

export function piAgentSettings(): Record<string, unknown> {
  return {
    defaultProjectTrust: "always",
    defaultProvider: resolveProvider(),
    defaultModel: resolveModelId(),
    defaultThinkingLevel: resolveThinking(),
    defaultTools: [...SOLVER_TOOLS],
    compaction: { ...COMPACTION },
    retry: structuredClone(RETRY),
    enableInstallTelemetry: false,
  };
}

function openaiProvider(modelId: string, baseUrl: string): Record<string, unknown> {
  return {
    baseUrl,
    api: "openai-completions",
    apiKey: "$OPENAI_API_KEY",
    authHeader: true,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
      requiresToolResultName: true,
      thinkingFormat: "deepseek",
    },
    models: [
      {
        id: modelId,
        name: modelId,
        reasoning: true,
        input: ["text"],
        contextWindow: CONTEXT_WINDOW,
        maxTokens: 32768,
        thinkingLevelMap: {
          off: "off",
          minimal: "low",
          low: "low",
          medium: "high",
          high: "high",
          xhigh: "max",
          max: "max",
        },
      },
    ],
  };
}

function anthropicProvider(modelId: string, baseUrl: string): Record<string, unknown> {
  const provider: Record<string, unknown> = {
    apiKey: "$ANTHROPIC_API_KEY",
    api: "anthropic-messages",
    compat: { supportsEagerToolInputStreaming: false },
    models: [
      {
        id: modelId,
        name: modelId,
        reasoning: false,
        input: ["text"],
        contextWindow: CONTEXT_WINDOW,
        maxTokens: 16384,
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
}): Record<string, unknown> {
  const api = inferApi(opts.baseUrl);
  const name = (opts.provider || "").trim() || resolveProvider(opts.baseUrl, api);
  if (api === "openai-completions") {
    return { providers: { [name]: openaiProvider(opts.modelId, opts.baseUrl) } };
  }
  return { providers: { [name]: anthropicProvider(opts.modelId, opts.baseUrl) } };
}

function writeJson(path: string, doc: unknown): void {
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", "utf8");
}

export function seedPiWorkspace(
  workspace: string,
  opts: { systemPrompt: string; model?: string | null },
): string {
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
      compaction: { ...COMPACTION },
    });
  } catch {
    /* ignore */
  }
  try {
    writeJson(join(agent, "settings.json"), piAgentSettings());
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
