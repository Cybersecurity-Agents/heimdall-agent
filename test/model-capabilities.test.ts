import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { BUILTIN_CATALOG, CATALOG_ENV, resolveCapability, validateCatalog } from "../src/shared/model-capabilities.js";
import { resolveLlmOptions } from "../src/shared/llm-options.js";
import { adaptLlmRequest, startLlmAdapter } from "../src/shared/llm-request-adapter.js";
import { readCatalogState, snapshotCapabilities, updateCatalog } from "../src/control/capability-catalog.js";
import { loadToolsEnv } from "../src/shared/tools-env.js";
import type { Config } from "../src/shared/config.js";
import { PiBackend } from "../src/agent/backends/pi.js";
import { PiRpcBackend } from "../src/agent/backends/pi-rpc.js";
import { EventSink } from "../src/shared/events.js";
const dirs: string[] = [];
function temp() { const d = mkdtempSync(join(tmpdir(), "heimdall-capabilities-")); dirs.push(d); return d; }
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const futureModel = "vendor/deepseek-v4.2:preview";

describe("capability contracts", () => {
  it.each(["GLM-5.3", "GLM-5.3-Flash", "Kimi-K3", "DeepSeek-V4.1-Flash"])("maps current gateway model %s on both protocols", model => {
    for (const protocol of ["anthropic", "openai"]) {
      const opts = resolveLlmOptions({ HEIMDALL_LLM_API: protocol, HEIMDALL_THINKING: "max" }, model);
      const wire = adaptLlmRequest({ model, max_tokens: 4096, thinking: { type: "adaptive" } }, opts);
      expect(opts).toMatchObject({ adapter: "deepseek", thinking: "max", contextWindow: model === "Kimi-K3" ? 1048576 : 1000000 });
      expect(wire.model).toBe(model);
      expect(wire.thinking).toEqual({ type: "enabled" });
      expect(protocol === "anthropic" ? (wire.output_config as any).effort : wire.reasoning_effort).toBe("max");
    }
  });
  it("validates the bundled catalog and matches aliases only within the provider", () => {
    expect(validateCatalog(BUILTIN_CATALOG).models.length).toBeGreaterThan(20);
    expect(BUILTIN_CATALOG.models.filter(m => m.provider === "deepseek" && m.id === "deepseek-flash")).toHaveLength(1);
    expect(resolveCapability({ HEIMDALL_CAPABILITY_PROVIDER: "deepseek" }, "deepseek-v4-flash").record?.id).toBe("deepseek-flash");
    expect(resolveCapability({ HEIMDALL_CAPABILITY_PROVIDER: "other" }, "deepseek-v4-flash").record).toBeUndefined();
    expect(resolveCapability({}, "deepseek-v4-flash").record).toBeUndefined();
    expect(resolveCapability({ HEIMDALL_LLM_BASE_URL: "https://api.deepseek.com.evil.invalid" }, "deepseek-flash").capabilitySource).toBe("catalog-unverified");
    expect(resolveLlmOptions({ HEIMDALL_LLM_BASE_URL: "https://api.deepseek.com" }, "deepseek-flash")).toMatchObject({ contextWindow: 1000000, supportedThinking: ["off", "low", "high", "max"] });
  });
  it("accepts large output capacities while enforcing context and integer bounds", () => {
    const catalog = { ...BUILTIN_CATALOG, models: [{ provider: "moonshotai", id: "fixture", profile: "openai-effort", contextWindow: 1048576, maxTokens: 1048576 }] };
    expect(validateCatalog(catalog).models[0]?.maxTokens).toBe(1048576);
    for (const maxTokens of [1048577, 10_000_001, 1024.5]) {
      expect(() => validateCatalog({ ...catalog, models: [{ ...catalog.models[0]!, maxTokens }] })).toThrow(/capacity|Invalid model maxTokens/);
    }
  });
  it.each(["openai", "anthropic"])("maps future model effort explicitly on %s without inheriting capacity", protocol => {
    for (const [level, mapped] of [["low", "low"], ["high", "high"], ["max", "max"], ["minimal", "low"], ["medium", "high"], ["xhigh", "high"]]) {
      const opts = resolveLlmOptions({ HEIMDALL_CAPABILITY_PROFILE: "deepseek", HEIMDALL_THINKING: level, HEIMDALL_LLM_API: protocol }, futureModel);
      expect(opts).toMatchObject({ thinking: mapped, contextWindow: 128000, contextSource: "fallback", capabilitySource: "manual", catalogModel: null });
      const body = adaptLlmRequest({ model: futureModel, thinking: { type: "adaptive", budget_tokens: 9000 }, reasoning_effort: "max", output_config: { effort: "max", format: "fixture" } }, opts);
      expect(body.model).toBe(futureModel);
      expect(body.thinking).toEqual({ type: "enabled" });
      expect(protocol === "openai" ? body.reasoning_effort : (body.output_config as any).effort).toBe(mapped);
      expect((body.output_config as any).format).toBe("fixture");
    }
  });
  it("does not infer capability or capacity from version strings or suffixes", () => {
    const opts = resolveLlmOptions({}, "vendor/model-v999[1m]");
    expect(opts).toMatchObject({ capabilitySource: "unknown", contextWindow: 128000, effort: null });
    const body = adaptLlmRequest({ model: opts.model, thinking: { type: "enabled" }, reasoning_effort: "high" }, opts);
    expect(body.thinking).toBeUndefined(); expect(body.reasoning_effort).toBeUndefined();
    expect(adaptLlmRequest({ model: "small-model", thinking: "keep" }, opts).thinking).toBe("keep");
  });
  it("does not send effort for toggle-only Kimi and GLM models", () => {
    for (const model of ["kimi-k2.6", "glm-4.7"]) {
      const opts = resolveLlmOptions({ HEIMDALL_THINKING: "max" }, model);
      expect(opts.adapter).toBe("thinking-toggle"); expect(opts.effort).toBeNull();
      const body = adaptLlmRequest({ model, reasoning_effort: "max" }, opts);
      expect(body.thinking).toEqual({ type: "enabled" }); expect(body.reasoning_effort).toBeUndefined();
    }
    expect(() => resolveLlmOptions({ HEIMDALL_THINKING: "off" }, "kimi-k3")).toThrow(/cannot disable/);
  });
  it("validates custom profiles and rejects protocol mismatches", () => {
    const env = { HEIMDALL_CAPABILITY_PROFILE: "custom", HEIMDALL_CAPABILITY_CUSTOM: JSON.stringify({ adapter: "deepseek", levels: ["off", "high", "max"], aliases: { medium: "high" } }) };
    expect(resolveLlmOptions(env, futureModel).profileId).toBe("custom");
    expect(() => resolveLlmOptions({ ...env, HEIMDALL_CAPABILITY_CUSTOM: '{"adapter":"shell"}' }, futureModel)).toThrow();
    expect(() => resolveLlmOptions({ HEIMDALL_CAPABILITY_PROFILE: "anthropic-budget", HEIMDALL_LLM_API: "openai" }, futureModel)).toThrow(/does not support/);
  });
});

describe("versioned catalog", () => {
  function cfg() { const dir = temp(); return { data_dir: dir, tools_env: loadToolsEnv(join(dir, "env.yaml")) } as Config; }
  const validate = () => {};
  it("activates atomically, rolls back, and pins existing workspaces across resume", async () => {
    const config = cfg(), workspace = temp(), env: NodeJS.ProcessEnv = {};
    snapshotCapabilities(config, workspace, env);
    const before = env[CATALOG_ENV];
    const next = { ...readCatalogState(config).active, version: "fixture-2" };
    await updateCatalog(config, { action: "import", catalog: next }, validate);
    snapshotCapabilities(config, workspace, env);
    expect(env[CATALOG_ENV]).toBe(before);
    const other: NodeJS.ProcessEnv = {}; snapshotCapabilities(config, temp(), other);
    expect(JSON.parse(other[CATALOG_ENV]!).version).toBe("fixture-2");
    await updateCatalog(config, { action: "rollback", version: BUILTIN_CATALOG.version }, validate);
    expect(readCatalogState(config).active.version).toBe(BUILTIN_CATALOG.version);
    expect(JSON.parse(readFileSync(join(workspace, ".heimdall/model-capabilities.json"), "utf8")).version).toBe(BUILTIN_CATALOG.version);
  });
  it("keeps the previous catalog after validation, download, or version conflicts", async () => {
    const config = cfg(), before = readCatalogState(config);
    await expect(updateCatalog(config, { action: "import", catalog: { ...before.active, version: "new", models: [{ provider: "x", id: "m", profile: "missing" }] } }, validate)).rejects.toThrow();
    await expect(updateCatalog(config, { action: "import", catalog: { ...before.active, version: "new" } }, () => { throw new Error("active settings incompatible"); })).rejects.toThrow(/incompatible/);
    await expect(updateCatalog(config, { action: "import", catalog: { ...before.active, models: [] } }, validate)).rejects.toThrow(/immutable/);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    try { await expect(updateCatalog(config, { action: "refresh", url: "https://catalog.example/models.json" }, validate)).rejects.toThrow(/offline/); }
    finally { vi.unstubAllGlobals(); }
    expect(readCatalogState(config)).toEqual(before);
  });
});

describe("actual Pi transports", () => {
  it.each([ ["sdk", "anthropic"], ["sdk", "openai"], ["rpc", "anthropic"], ["rpc", "openai"] ])("sends a future model's contract through %s / %s", { timeout: 20000 }, async (transport, protocol) => {
    const dir = temp(), bodies: any[] = [];
    const server = createServer((req, res) => { let raw = ""; req.on("data", c => raw += c); req.on("end", () => {
      bodies.push(JSON.parse(raw)); res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "fixture invalid API key" } }));
    }); });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as any).port}${protocol === "openai" ? "/v1" : ""}`;
    for (const [key, value] of Object.entries({ PI_OFFLINE: "1", HEIMDALL_LLM_API: protocol, HEIMDALL_LLM_PROVIDER: protocol, HEIMDALL_LLM_BASE_URL: base,
      HEIMDALL_AGENT_MODEL: futureModel, HEIMDALL_CAPABILITY_PROFILE: "deepseek", HEIMDALL_THINKING: "xhigh", HEIMDALL_LLM_API_KEY: "fixture", OPENAI_API_KEY: "fixture", ANTHROPIC_API_KEY: "fixture",
      PI_CODING_AGENT_DIR: join(dir, "agent"), HEIMDALL_PI_CLI: resolve("node_modules/.bin/pi"), HEIMDALL_COMPACT_ENABLED: "false" })) vi.stubEnv(key, value);
    const backend = transport === "sdk" ? new PiBackend({ noSkills: true, noContextFiles: true }) : new PiRpcBackend();
    const events = new EventSink(join(dir, "events.jsonl"));
    try {
      await backend.run({ workspace: dir, systemPrompt: "Fixture", userPrompt: "Hello", model: futureModel, maxTurns: 1, permissionMode: "default", events, signal: AbortSignal.timeout(15000) });
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(body.model).toBe(futureModel); expect(body.thinking).toEqual({ type: "enabled" });
        expect(protocol === "openai" ? body.reasoning_effort : body.output_config.effort).toBe("high");
      }
    } finally { await backend.close(); events.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  });
  it("preserves streaming errors, path, query and auth headers through the adapter", async () => {
    let incoming: any;
    const server = createServer((req, res) => { req.resume(); req.on("end", () => { incoming = { url: req.url, auth: req.headers.authorization }; res.writeHead(429, { "content-type": "text/event-stream", "retry-after": "9" }); res.end("data: fixture\n\n"); }); });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const proxy = await startLlmAdapter(`http://127.0.0.1:${(server.address() as any).port}/gateway/v1`, resolveLlmOptions({ HEIMDALL_CAPABILITY_PROFILE: "deepseek" }, futureModel));
    try {
      const result = await fetch(`${proxy.baseUrl}/chat/completions?fixture=1`, { method: "POST", headers: { authorization: "Bearer fixture" }, body: JSON.stringify({ model: futureModel }) });
      expect(result.status).toBe(429); expect(result.headers.get("retry-after")).toBe("9"); expect(await result.text()).toBe("data: fixture\n\n");
      expect(incoming).toEqual({ url: "/gateway/v1/chat/completions?fixture=1", auth: "Bearer fixture" });
    } finally { await proxy.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  });
});
