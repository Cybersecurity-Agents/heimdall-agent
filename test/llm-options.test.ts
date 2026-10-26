import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { PiRpcBackend } from "../src/agent/backends/pi-rpc.js";
import { EventSink } from "../src/shared/events.js";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyLoopOptions, claudeThinkingOptions, resolveLlmOptions } from "../src/shared/llm-options.js";
import { applyCoachLlmEnv, applyLoopLlmEnv, buildModelsDoc, claudeAutocompactEnv, seedPiWorkspace } from "../src/shared/pi-workspace.js";
import { applyPayload, loadOverlay, overlayPath, snapshot } from "../src/control/console/llm-io.js";
import { loadToolsEnv } from "../src/shared/tools-env.js";
import type { Config } from "../src/shared/config.js";

const dirs: string[] = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), "heimdall-llm-options-")); dirs.push(dir); return dir; }
function config() { const dir = temp(); return { data_dir: dir, tools_env: loadToolsEnv(join(dir, "tools.yaml")) } as Config; }
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("model-aware tuning", () => {
  it("uses the pinned catalog and reports unsupported thinking mappings", () => {
    expect(resolveLlmOptions({ HEIMDALL_THINKING: "medium" }, "deepseek-v4-pro")).toMatchObject({
      contextWindow: 1000000, contextSource: "catalog", requestedThinking: "medium", thinking: "high",
    });
    expect(resolveLlmOptions({}, "private-model")).toMatchObject({ contextWindow: 128000, contextSource: "fallback" });
    expect(resolveLlmOptions({}, "private-model", "sdk")).toMatchObject({ contextWindow: null, contextSource: "sdk" });
  });

  it("keeps Claude adaptive effort and fixed thinking budgets distinct", () => {
    expect(claudeThinkingOptions(resolveLlmOptions({ HEIMDALL_THINKING: "xhigh" }, "claude-opus-4-7", "sdk")))
      .toEqual({ thinking: { type: "adaptive" }, effort: "xhigh" });
    expect(claudeThinkingOptions(resolveLlmOptions({ HEIMDALL_CAPABILITY_PROFILE: "anthropic-budget", HEIMDALL_THINKING_MODE: "enabled", HEIMDALL_THINKING_BUDGET: "8192", HEIMDALL_MAX_OUTPUT_TOKENS: "16384" }, "private-model", "sdk")))
      .toEqual({ thinking: { type: "enabled", budgetTokens: 8192 } });
    expect(claudeThinkingOptions(resolveLlmOptions({ HEIMDALL_THINKING: "off" }, "private-model", "sdk")))
      .toEqual({});
  });

  it.each([
    { HEIMDALL_THINKING: "typo" }, { HEIMDALL_CONTEXT_WINDOW: "128000oops" },
    { HEIMDALL_CONTEXT_WINDOW: "128000.5" }, { HEIMDALL_COMPACT_ENABLED: "yes" },
    { HEIMDALL_COMPACT_PCT: "95" }, { HEIMDALL_MAX_OUTPUT_TOKENS: "-1" },
    { HEIMDALL_THINKING_MODE: "adaptive", HEIMDALL_THINKING_BUDGET: "8192" },
    { HEIMDALL_THINKING_BUDGET: "8192", HEIMDALL_MAX_OUTPUT_TOKENS: "8192" },
    { HEIMDALL_CONTEXT_WINDOW: "32000", HEIMDALL_MAX_OUTPUT_TOKENS: "32768" },
    { HEIMDALL_CONTEXT_WINDOW: "64000", HEIMDALL_MAX_OUTPUT_TOKENS: "16384", HEIMDALL_COMPACT_PCT: "90" },
    { HEIMDALL_CONTEXT_WINDOW: "64000", HEIMDALL_COMPACT_KEEP_RECENT_TOKENS: "60000" },
  ])("rejects invalid values and contradictory budgets: %j", values => {
    expect(() => resolveLlmOptions(values, "private-model", "sdk")).toThrow();
  });

  it("keeps loop overrides independent through repeated environment remapping", () => {
    const env = { HEIMDALL_LOOP: "1", HEIMDALL_LOOP_THINKING: "low", HEIMDALL_THINKING: "max",
      HEIMDALL_MAX_OUTPUT_TOKENS: "4096", HEIMDALL_CONTEXT_WINDOW: "64000", HEIMDALL_LOOP_CONTEXT_WINDOW: "256000" };
    applyLoopLlmEnv(env); applyLoopLlmEnv(env);
    expect(env.HEIMDALL_THINKING).toBe("low");
    expect(env.HEIMDALL_CONTEXT_WINDOW).toBe("256000");
    expect(env.HEIMDALL_MAX_OUTPUT_TOKENS).toBe("");
    const defaults = { HEIMDALL_THINKING: "low" };
    applyLoopOptions(defaults);
    expect(defaults.HEIMDALL_THINKING).toBe("max");
  });

  it("does not leak solver or Claude budgets into observer sessions", () => {
    const env = { HEIMDALL_THINKING_BUDGET: "8192", HEIMDALL_LOOP_THINKING_BUDGET: "8192",
      HEIMDALL_LOOP_THINKING_MODE: "adaptive", HEIMDALL_LOOP_MODEL: "private-model", HEIMDALL_LOOP_BASE_URL: "https://example.invalid/v1" };
    applyCoachLlmEnv(env);
    expect(env.HEIMDALL_THINKING_BUDGET).toBe("");
    expect(() => resolveLlmOptions(env, "private-model", "pi")).not.toThrow();
  });

  it("generates Pi model capability, fixed budget and compaction files together", () => {
    const values = { HEIMDALL_CAPABILITY_PROFILE: "anthropic-budget", HEIMDALL_LLM_API: "anthropic", HEIMDALL_AGENT_MODEL: "private-model", HEIMDALL_THINKING: "low",
      HEIMDALL_THINKING_BUDGET: "4096", HEIMDALL_CONTEXT_WINDOW: "64000", HEIMDALL_MAX_OUTPUT_TOKENS: "8192",
      HEIMDALL_COMPACT_ENABLED: "false", HEIMDALL_COMPACT_PCT: "60", HEIMDALL_COMPACT_KEEP_RECENT_TOKENS: "12000" };
    for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
    const dir = temp(); const agent = seedPiWorkspace(dir, { systemPrompt: "fixture" });
    const model = JSON.parse(readFileSync(join(agent, "models.json"), "utf8")).providers.anthropic.models[0];
    expect(model).toMatchObject({ reasoning: true, contextWindow: 64000, maxTokens: 8192 });
    const settings = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"));
    expect(settings.thinkingBudgets.low).toBe(4096);
    expect(settings.compaction).toEqual({ enabled: false, reserveTokens: 25600, keepRecentTokens: 12000 });
    expect(JSON.parse(readFileSync(join(dir, ".pi/settings.json"), "utf8")).compaction).toEqual(settings.compaction);
    expect(() => buildModelsDoc({ modelId: "private-model", baseUrl: "https://example.invalid/v1", env: { ...values, HEIMDALL_LLM_API: "openai" } })).toThrow(/does not support/);
  });

  it("honors disabled compaction in both RPC setup and the post-turn check", async () => {
    const dir = temp(); const log = join(dir, "commands.jsonl");
    for (const [key, value] of Object.entries({
      HEIMDALL_PI_CLI: resolve("test/fixtures/fake_pi_rpc.py"), HEIMDALL_AGENT_MODEL: "private-model",
      HEIMDALL_LLM_API: "anthropic", HEIMDALL_COMPACT_ENABLED: "false", FAKE_PI_CONTEXT_PCT: "95",
      FAKE_PI_COMMAND_LOG: log, PI_CODING_AGENT_DIR: join(dir, "agent"),
    })) vi.stubEnv(key, value);
    const backend = new PiRpcBackend(); const events = new EventSink(join(dir, "events.jsonl"));
    try {
      const result = await backend.run({ workspace: dir, systemPrompt: "fixture", userPrompt: "fixture", model: "private-model", maxTurns: 1, permissionMode: "default", events });
      expect(result.ok).toBe(true);
      expect(await backend.maybeCompact(1)).toBe(false);
      const commands = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(commands.find(command => command.type === "set_auto_compaction").enabled).toBe(false);
      expect(commands.some(command => command.type === "compact")).toBe(false);
    } finally { await backend.close(); events.close(); }
  });

  it("sets Claude overrides explicitly and clears stale overrides in auto mode", () => {
    expect(claudeAutocompactEnv("private-model", { HEIMDALL_CONTEXT_WINDOW: "128000", HEIMDALL_MAX_OUTPUT_TOKENS: "8192", HEIMDALL_COMPACT_ENABLED: "false" }))
      .toMatchObject({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "128000", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8192", DISABLE_AUTO_COMPACT: "1" });
    expect(claudeAutocompactEnv("private-model", {}))
      .toMatchObject({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "", DISABLE_AUTO_COMPACT: "0" });
  });
});

describe("console persistence", () => {
  it("round-trips tuning without redacting numeric token fields or exposing credentials", () => {
    const cfg = config();
    applyPayload(cfg, { ANTHROPIC_MODEL: "private-model", ANTHROPIC_API_KEY: "fixture-secret-key", HEIMDALL_MAX_OUTPUT_TOKENS: "8192", HEIMDALL_LOOP_THINKING: "low", HEIMDALL_LOOP_CAPABILITY_PROFILE: "deepseek" });
    const saved = snapshot(cfg) as any;
    expect(saved.solver.HEIMDALL_MAX_OUTPUT_TOKENS.value).toBe("8192");
    expect(saved.solver.ANTHROPIC_API_KEY.value).toBe("");
    expect(JSON.stringify(saved)).not.toContain("fixture-secret-key");
    expect(saved.effective.loop.thinking).toBe("low");
    const restored = { ...cfg, tools_env: loadToolsEnv(join(cfg.data_dir, "missing.yaml")) };
    loadOverlay(restored);
    expect(snapshot(restored)).toEqual(saved);
    // mergeInto closes over the original values object; saves must update it in place.
    const env: Record<string, string> = {};
    cfg.tools_env.mergeInto(env);
    expect(env.HEIMDALL_MAX_OUTPUT_TOKENS).toBe("8192");
  });

  it("rejects the whole candidate without partially changing memory or disk", () => {
    const cfg = config(); applyPayload(cfg, { HEIMDALL_THINKING: "low" });
    const before = { ...cfg.tools_env.values }, file = readFileSync(overlayPath(cfg), "utf8");
    expect(() => applyPayload(cfg, { HEIMDALL_THINKING: "high", HEIMDALL_CONTEXT_WINDOW: "garbage" })).toThrow();
    expect(cfg.tools_env.values).toEqual(before);
    expect(readFileSync(overlayPath(cfg), "utf8")).toBe(file);
    applyPayload(cfg, { HEIMDALL_CONTEXT_WINDOW: "64000", HEIMDALL_MAX_OUTPUT_TOKENS: "8192" });
    applyPayload(cfg, { HEIMDALL_CONTEXT_WINDOW: "", HEIMDALL_MAX_OUTPUT_TOKENS: "" });
    expect((snapshot(cfg).effective as any).solver.contextWindow).toBe(128000);
  });
});
