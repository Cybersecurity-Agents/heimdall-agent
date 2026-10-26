import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyCoachLlmEnv,
  applyLoopLlmEnv,
  claudeAutocompactEnv,
  resolveProviderFromUrl,
  sdkModelId,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  inferApi,
  seedPiWorkspace,
  sdkInheritAgents,
  syncLlmEnv,
  sdkModelOverrides,
} from "../src/shared/pi-workspace.js";
import { seedClaudeWorkspace } from "../src/agent/backends/claude.js";

const KEYS = [
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "HEIMDALL_LLM_BASE_URL",
  "HEIMDALL_LLM_API",
  "HEIMDALL_CAPABILITY_PROFILE",
  "HEIMDALL_LLM_PROVIDER",
  "ANTHROPIC_MODEL",
  "OPENAI_MODEL",
  "HEIMDALL_AGENT_MODEL",
  "PI_CODING_AGENT_DIR",
] as const;

const saved: Record<string, string | undefined> = {};

function swap(env: Record<string, string | null>): void {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    const v = env[k];
    if (v === undefined) continue;
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(() => {
  for (const k of KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("seedPiWorkspace", () => {
  it("writes SYSTEM.md, models.json, compaction, tools", () => {
    swap({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:18181/compatible-mode/v1",
      OPENAI_BASE_URL: null,
      HEIMDALL_LLM_BASE_URL: null,
      HEIMDALL_LLM_API: null,
      HEIMDALL_LLM_PROVIDER: null,
      ANTHROPIC_MODEL: "anthropic/grok-4.6:high",
      OPENAI_MODEL: null,
      HEIMDALL_AGENT_MODEL: null,
      PI_CODING_AGENT_DIR: null,
    });
    const td = mkdtempSync(join(tmpdir(), "heimdall-pi-"));
    const agent = seedPiWorkspace(td, { systemPrompt: "You are a CTF agent.\n" });
    const system = readFileSync(join(td, ".pi", "SYSTEM.md"), "utf8");
    expect(system.startsWith("You are a CTF agent.")).toBe(true);
    const settings = JSON.parse(readFileSync(join(td, ".pi", "settings.json"), "utf8")) as {
      skills: string[];
    };
    expect(settings.skills).toEqual(["../.claude/skills"]);
    expect(agent).toBe(join(td, ".heimdall", "pi"));
    const models = JSON.parse(readFileSync(join(agent, "models.json"), "utf8")) as {
      providers: { openai: { api: string; baseUrl: string; models: { id: string }[] } };
    };
    const prov = models.providers.openai;
    expect(prov.api).toBe("openai-completions");
    expect(prov.baseUrl).toBe("http://127.0.0.1:18181/compatible-mode/v1");
    expect(prov.models[0]?.id).toBe("anthropic/grok-4.6:high");
    const trust = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")) as {
      defaultProjectTrust: string;
      compaction: { keepRecentTokens: number };
      defaultTools: string[];
    };
    expect(trust.defaultProjectTrust).toBe("always");
    expect(trust.compaction.keepRecentTokens).toBe(32000);
    expect(trust.defaultTools).toContain("bash");
  });

  it("does not supply a model or endpoint without platform configuration", () => {
    swap({
      ANTHROPIC_BASE_URL: null,
      OPENAI_BASE_URL: null,
      HEIMDALL_LLM_BASE_URL: null,
      HEIMDALL_LLM_API: null,
      HEIMDALL_LLM_PROVIDER: null,
      ANTHROPIC_MODEL: null,
      OPENAI_MODEL: null,
      HEIMDALL_AGENT_MODEL: null,
      PI_CODING_AGENT_DIR: null,
    });
    expect(DEFAULT_BASE_URL).toBe("");
    expect(DEFAULT_MODEL).toBe("");
    expect(inferApi(DEFAULT_BASE_URL)).toBe("openai-completions");
    const td = mkdtempSync(join(tmpdir(), "heimdall-pi-"));
    const agent = seedPiWorkspace(td, { systemPrompt: "solver\n" });
    const models = JSON.parse(readFileSync(join(agent, "models.json"), "utf8")) as {
      providers: Record<string, { api: string; baseUrl: string; models: { id: string; contextWindow: number }[]; compat: { thinkingFormat: string } }>;
    };
    const aliyun = models.providers.openai!;
    expect(aliyun.api).toBe("openai-completions");
    expect(aliyun.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(aliyun.models[0]?.id).toBe(DEFAULT_MODEL);
    expect(aliyun.compat.thinkingFormat).toBeUndefined();
    expect(aliyun.models[0]?.contextWindow).toBe(128000);
    const trust = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")) as {
      compaction: { reserveTokens: number; keepRecentTokens: number };
    };
    expect(trust.compaction.reserveTokens).toBe(38_400);
    expect(trust.compaction.keepRecentTokens).toBe(32_000);
  });

  it("detects anthropic-messages from /anthropic gateway", () => {
    swap({
      ANTHROPIC_BASE_URL: "http://api.deepseek.com.example.invalid/anthropic",
      OPENAI_BASE_URL: null,
      HEIMDALL_LLM_BASE_URL: null,
      HEIMDALL_LLM_API: null,
      HEIMDALL_LLM_PROVIDER: null,
      ANTHROPIC_MODEL: "deepseek-v4-flash",
      OPENAI_MODEL: null,
      HEIMDALL_AGENT_MODEL: null,
      PI_CODING_AGENT_DIR: null,
    });
    const td = mkdtempSync(join(tmpdir(), "heimdall-pi-"));
    const agent = seedPiWorkspace(td, { systemPrompt: "solver\n" });
    const models = JSON.parse(readFileSync(join(agent, "models.json"), "utf8")) as {
      providers: { anthropic: { api: string; baseUrl: string; models: { id: string }[] } };
    };
    const anth = models.providers.anthropic;
    expect(anth.api).toBe("anthropic-messages");
    expect(anth.baseUrl.endsWith("/anthropic")).toBe(true);
    expect(anth.models[0]?.id).toBe("deepseek-v4-flash");
  });
});

describe("applyLoopLlmEnv", () => {
  it("only remaps when HEIMDALL_LOOP is on", () => {
    const regular: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: "sk-pi",
      ANTHROPIC_BASE_URL: "http://api.deepseek.com.example.invalid/anthropic",
      ANTHROPIC_MODEL: "deepseek-v4-pro[1m]",
      HEIMDALL_LOOP_API_KEY: "sk-loop",
      HEIMDALL_LOOP_BASE_URL: "http://api.moonshot.cn.example.invalid/anthropic",
      HEIMDALL_LOOP_MODEL: "kimi-k3[1m]",
    };
    applyLoopLlmEnv(regular);
    expect(regular.ANTHROPIC_API_KEY).toBe("sk-pi");
    expect(regular.ANTHROPIC_MODEL).toBe("deepseek-v4-pro[1m]");

    const loop = { ...regular, HEIMDALL_LOOP: "1" };
    applyLoopLlmEnv(loop);
    expect(loop.ANTHROPIC_API_KEY).toBe("sk-loop");
    expect(loop.ANTHROPIC_AUTH_TOKEN).toBe("sk-loop");
    expect(loop.ANTHROPIC_BASE_URL).toBe("http://api.moonshot.cn.example.invalid/anthropic");
    expect(loop.HEIMDALL_LLM_UPSTREAM).toBe(loop.ANTHROPIC_BASE_URL);
    expect(loop.ANTHROPIC_MODEL).toBe("kimi-k3[1m]");
    expect(loop.HEIMDALL_AGENT_MODEL).toBe("kimi-k3[1m]");
    expect(loop.HEIMDALL_THINKING).toBe("max");
  });

  it("does not unwrap an already-rewritten llm-tap client URL", () => {
    const env: NodeJS.ProcessEnv = {
      HEIMDALL_LOOP: "1",
      HEIMDALL_LLM_TAP_PORT: "18448",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:18448",
      OPENAI_BASE_URL: "http://127.0.0.1:18448",
      HEIMDALL_LLM_BASE_URL: "http://127.0.0.1:18448",
      HEIMDALL_LLM_UPSTREAM: "http://127.0.0.1:8317",
      HEIMDALL_LOOP_BASE_URL: "http://api.moonshot.cn.example.invalid/anthropic",
      HEIMDALL_LOOP_MODEL: "kimi-k3[1m]",
      HEIMDALL_LOOP_API_KEY: "sk-loop",
    };
    applyLoopLlmEnv(env);
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:18448");
    expect(env.OPENAI_BASE_URL).toBe("http://127.0.0.1:18448");
    expect(env.HEIMDALL_LLM_BASE_URL).toBe("http://127.0.0.1:18448");
    expect(env.HEIMDALL_LLM_UPSTREAM).toBe("http://api.moonshot.cn.example.invalid/anthropic");
    expect(env.ANTHROPIC_MODEL).toBe("kimi-k3[1m]");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-loop");
  });
});

describe("applyCoachLlmEnv", () => {
  it("prefers LOOP_* key and endpoint over COACH_* and Pi", () => {
    const env: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: "sk-pi",
      ANTHROPIC_BASE_URL: "http://api.deepseek.com.example.invalid/anthropic",
      ANTHROPIC_MODEL: "deepseek-v4-flash",
      HEIMDALL_COACH_API_KEY: "sk-coach",
      HEIMDALL_COACH_BASE_URL: "http://api.deepseek.com.example.invalid/anthropic",
      HEIMDALL_COACH_MODEL: "deepseek-v4-flash",
      HEIMDALL_LOOP_API_KEY: "sk-loop",
      HEIMDALL_LOOP_BASE_URL: "http://open.bigmodel.cn.example.invalid/api/anthropic",
      HEIMDALL_LOOP_MODEL: "glm-5.3-flash",
      HEIMDALL_LOOP_API: "anthropic",
    };
    applyCoachLlmEnv(env);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-loop");
    expect(env.HEIMDALL_COACH_API_KEY).toBe("sk-loop");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://open.bigmodel.cn.example.invalid/api/anthropic");
    expect(env.ANTHROPIC_MODEL).toBe("glm-5.3-flash");
  });

  it("maps COACH_* onto the Pi-visible solver vars and infers provider from the URL", () => {
    const env: NodeJS.ProcessEnv = {
      HEIMDALL_LLM_PROVIDER: "deepseek",
      OPENAI_API_KEY: "sk-stale",
      HEIMDALL_COACH_BASE_URL: "http://api.deepseek.com.example.invalid/anthropic",
      HEIMDALL_COACH_MODEL: "deepseek-v4-pro[1m]",
      HEIMDALL_COACH_API_KEY: "sk-coach",
    };
    applyCoachLlmEnv(env);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-coach");
    expect(env.OPENAI_API_KEY).toBe("sk-coach");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://api.deepseek.com.example.invalid/anthropic");
    expect(env.ANTHROPIC_MODEL).toBe("deepseek-v4-pro[1m]");
    expect(env.HEIMDALL_AGENT_MODEL).toBe("deepseek-v4-pro[1m]");
    expect(env.HEIMDALL_LLM_API).toBe("anthropic-messages");
    expect(env.HEIMDALL_LLM_PROVIDER).toBe("anthropic");
    expect(resolveProviderFromUrl(env.HEIMDALL_COACH_BASE_URL, env.HEIMDALL_LLM_API)).toBe("anthropic");
  });
});

describe("loop SDK autocompact", () => {
  it("overrides Claude auto-compact at 70%", () => {
    const env = claudeAutocompactEnv();
    expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("70");
    expect(env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT).toBe("0");
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("");
    const td = mkdtempSync(join(tmpdir(), "heimdall-sdk-"));
    swap({ HEIMDALL_CAPABILITY_PROFILE: "thinking-toggle" });
    const { settings } = seedClaudeWorkspace(td, "glm-5.3-flash");
    expect((settings.env as Record<string, string>).CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("70");
    expect((settings.env as Record<string, string>).ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-5.3-flash");
    expect(settings.model).toBe("glm-5.3-flash");
    const written = JSON.parse(readFileSync(join(td, ".claude", "settings.json"), "utf8")) as {
      env: Record<string, string>;
      model: string;
    };
    expect(written.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("70");
    expect(written.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("glm-5.3-flash");
    expect(written.model).toBe("glm-5.3-flash");
  });

  it("pins Agent types to inherit and remaps claude-opus-5 onto the main model", () => {
    const agents = sdkInheritAgents();
    expect(agents["general-purpose"]?.model).toBe("inherit");
    expect(agents.Explore?.model).toBe("inherit");
    expect(agents.Plan?.model).toBe("inherit");
    const overrides = sdkModelOverrides("glm-5.3-flash[1m]");
    expect(overrides["claude-opus-5"]).toBe("glm-5.3-flash[1m]");
    expect(overrides.opus).toBe("glm-5.3-flash[1m]");
    const td = mkdtempSync(join(tmpdir(), "heimdall-sdk-agents-"));
    swap({ HEIMDALL_CAPABILITY_PROFILE: "thinking-toggle" });
    const { settings } = seedClaudeWorkspace(td, "glm-5.3-flash");
    expect((settings.modelOverrides as Record<string, string>)["claude-opus-5"]).toBe("glm-5.3-flash");
    expect((settings.agents as Record<string, { model: string }>)["general-purpose"].model).toBe("inherit");
    expect(JSON.stringify(settings)).not.toMatch(/disallowedTools/);
  });

  it("preserves model suffixes without implying context capacity", () => {
    expect(sdkModelId("deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(sdkModelId("kimi-k3[1m]")).toBe("kimi-k3[1m]");
    expect(sdkModelId("glm-5.3-flash")).toBe("glm-5.3-flash");
    expect(sdkModelId("glm-5.3-flash[1m]")).toBe("glm-5.3-flash[1m]");
    const env: NodeJS.ProcessEnv = {
      HEIMDALL_LOOP: "1",
      HEIMDALL_LOOP_MODEL: "glm-5.3-flash[1m]",
      HEIMDALL_LOOP_API_KEY: "sk-loop",
    };
    applyLoopLlmEnv(env);
    expect(env.ANTHROPIC_MODEL).toBe("glm-5.3-flash[1m]");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-5.3-flash[1m]");
  });
});


describe("explicit model environment", () => {
  it("leaves missing model and endpoint unset", () => {
    const env: NodeJS.ProcessEnv = {};
    syncLlmEnv(env);
    expect(env.HEIMDALL_AGENT_MODEL).toBeUndefined();
    expect(env.OPENAI_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("propagates the configured endpoint and opaque model ID", () => {
    const env: NodeJS.ProcessEnv = {
      HEIMDALL_LLM_BASE_URL: "https://model.example/v1",
      HEIMDALL_AGENT_MODEL: "provider/fixture:high",
    };
    syncLlmEnv(env);
    expect(env.OPENAI_BASE_URL).toBe("https://model.example/v1");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://model.example/v1");
    expect(env.OPENAI_MODEL).toBe("provider/fixture:high");
    expect(env.ANTHROPIC_MODEL).toBe("provider/fixture:high");
  });
});


it("uses the loop credential even when a canonical regular key was initialized", () => {
  const env = { HEIMDALL_LOOP: "1", HEIMDALL_LLM_API_KEY: "regular-fixture", HEIMDALL_LOOP_API_KEY: "loop-fixture" };
  applyLoopLlmEnv(env);
  expect(env.HEIMDALL_LLM_API_KEY).toBe("loop-fixture");
});
