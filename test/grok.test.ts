import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveLlmApi, resolveLlmOptions } from "../src/shared/llm-options.js";
import { resolveCapability, validateCatalog, BUILTIN_CATALOG } from "../src/shared/model-capabilities.js";
import { adaptLlmRequest } from "../src/shared/llm-request-adapter.js";
import { applyCoachLlmEnv, buildModelsDoc, firstLlmKey } from "../src/shared/pi-workspace.js";
import { effectiveOptions, applyPayload, snapshot } from "../src/control/console/llm-io.js";
import { loadToolsEnv } from "../src/shared/tools-env.js";
import type { Config } from "../src/shared/config.js";
import { PiBackend } from "../src/agent/backends/pi.js";
import { PiRpcBackend } from "../src/agent/backends/pi-rpc.js";
import type { Backend } from "../src/agent/backends/types.js";
import { EventSink } from "../src/shared/events.js";
import { startLlmTap } from "../src/taps/llm-tap.js";
import { extractUsage, readTotals, UsageScanner } from "../src/shared/llm-usage.js";
import { flattenMessages, ReplyCollector } from "../src/shared/llm-session.js";
import { injectMapIntoMessages, injectBriefIntoMessages, requestHasRealInject } from "../src/shared/inject.js";

const dirs: string[] = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), "heimdall-grok-")); dirs.push(dir); return dir; }
afterEach(() => { vi.unstubAllEnvs(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
const native = { HEIMDALL_LLM_BASE_URL: "https://api.x.ai/v1" };
const encrypted = { id: "rs_fixture", type: "reasoning", summary: [], encrypted_content: "fixture-ciphertext-opaque" };
const usage = { input_tokens: 100, output_tokens: 30, total_tokens: 130, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 20 } };
const map = "<heimdall-map>\nLOCK: fixture\n</heimdall-map>\n";
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }

describe("Grok model configuration", () => {
  it("recognizes official and regional endpoints while preserving explicit protocols", () => {
    for (const host of ["api.x.ai", "us.api.x.ai"]) {
      expect(resolveLlmApi(`https://${host}/v1`)).toBe("openai-responses");
      expect(resolveLlmApi(`https://${host}/v1`, "openai")).toBe("openai-completions");
    }
    expect(resolveLlmApi("https://gateway.example/v1", "responses")).toBe("openai-responses");
    expect(resolveLlmApi("https://api.x.ai.evil.invalid/v1")).toBe("openai-completions");
    expect(firstLlmKey({ XAI_API_KEY: "fixture-xai" })).toBe("fixture-xai");
    const observer = { ...native, HEIMDALL_AGENT_MODEL: "grok-4.7", HEIMDALL_LOOP_BASE_URL: native.HEIMDALL_LLM_BASE_URL, HEIMDALL_LOOP_MODEL: "grok-4.7" };
    applyCoachLlmEnv(observer);
    expect((observer as any).HEIMDALL_COACH_API).toBe("openai-responses");
    const tapped = { HEIMDALL_LLM_BASE_URL: "http://127.0.0.1:9009", HEIMDALL_LLM_UPSTREAM: native.HEIMDALL_LLM_BASE_URL,
      HEIMDALL_LLM_TAP_PORT: "9009", HEIMDALL_AGENT_MODEL: "grok-4.7", HEIMDALL_LOOP_API: "anthropic" };
    applyCoachLlmEnv(tapped); applyCoachLlmEnv(tapped);
    expect((tapped as any).HEIMDALL_COACH_API).toBe("openai-responses");
    expect(tapped.HEIMDALL_LLM_UPSTREAM).toBe(native.HEIMDALL_LLM_BASE_URL);
  });
  it.each([
    ["grok-4.7", "xhigh", 500000], ["grok-4.6", "xhigh", 500000], ["grok-4.5", "high", 500000], ["grok-4.3", "high", 1000000],
    ["grok-build-0.1", "high", 256000], ["grok-code-fast-1", "high", 256000], ["grok-4.20", "high", 1000000], ["grok-4.20-non-reasoning", "off", 1000000],
  ])("resolves %s using exact metadata", (model, thinking, contextWindow) => {
    expect(resolveLlmOptions({ ...native, HEIMDALL_THINKING: "max" }, String(model))).toMatchObject({ thinking, contextWindow, protocol: "openai-responses", input: ["text", "image"] });
  });
  it("keeps aliases scoped, new names opaque, and new-model context independent", () => {
    expect(resolveCapability({ HEIMDALL_CAPABILITY_PROVIDER: "other" }, "grok-code-fast-1").record).toBeUndefined();
    const opts = resolveLlmOptions({ ...native, HEIMDALL_CAPABILITY_PROFILE: "grok", HEIMDALL_THINKING: "max" }, "vendor/grok-next:preview");
    expect(opts).toMatchObject({ thinking: "xhigh", contextWindow: 128000, capabilitySource: "manual", catalogModel: null });
    expect(adaptLlmRequest({ model: opts.model }, opts).model).toBe("vendor/grok-next:preview");
    expect(validateCatalog(BUILTIN_CATALOG).models.some(m => m.id === "grok-4.7")).toBe(true);
  });
  it("enforces off restrictions, preserves retired defaults, and omits unsupported effort", () => {
    expect(() => resolveLlmOptions({ ...native, HEIMDALL_THINKING: "off" }, "grok-4.7")).toThrow(/cannot disable/);
    const off = resolveLlmOptions({ ...native, HEIMDALL_THINKING: "off" }, "grok-4.3");
    expect(adaptLlmRequest({ model: off.model }, off).reasoning).toEqual({ effort: "none" });
    expect(resolveLlmOptions(native, "grok-4-0709").thinking).toBe("low");
    expect(resolveLlmOptions(native, "grok-3").thinking).toBe("off");
    for (const model of ["grok-build-0.1", "grok-4.20"]) {
      const opts = resolveLlmOptions(native, model);
      const wire = adaptLlmRequest({ model, reasoning: { effort: "high" }, thinking: { type: "enabled" }, reasoning_effort: "high" }, opts);
      expect(opts.reasoning).toBe(true); expect(opts.effort).toBeNull();
      expect(wire.reasoning).toBeUndefined(); expect(wire.thinking).toBeUndefined(); expect(wire.reasoning_effort).toBeUndefined();
    }
    expect(() => resolveLlmOptions(native, "grok-4.20-multi-agent")).toThrow(/client-side function calling/);
  });
  it("separates native Pi configuration from the Claude gateway slot", () => {
    expect(effectiveOptions({ ...native, ANTHROPIC_MODEL: "grok-4.7" })).toMatchObject({ solver: { protocol: "openai-responses" }, loop: null, loop_error: expect.stringContaining("Anthropic-compatible gateway") });
    expect(() => effectiveOptions({ ...native, ANTHROPIC_MODEL: "grok-4.7", HEIMDALL_LOOP_BASE_URL: native.HEIMDALL_LLM_BASE_URL })).toThrow(/Anthropic-compatible gateway/);
    expect(() => effectiveOptions({ ...native, ANTHROPIC_MODEL: "grok-4.7", HEIMDALL_LOOP_CONTEXT_WINDOW: "bad" })).toThrow(/integer/);
    expect(resolveLlmOptions({ HEIMDALL_CAPABILITY_PROFILE: "claude-adaptive", ANTHROPIC_BASE_URL: "https://gateway.example/anthropic" }, "grok-4.7", "sdk")).toMatchObject({ protocol: "anthropic-messages", capabilitySource: "manual" });
    const cliproxy = { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317", HEIMDALL_LLM_API: "anthropic", HEIMDALL_CAPABILITY_PROVIDER: "xai", HEIMDALL_THINKING: "max" };
    const gateway = resolveLlmOptions(cliproxy, "grok-4.7");
    expect(gateway).toMatchObject({ protocol: "anthropic-messages", profileId: "grok", adapter: "claude-adaptive", thinking: "xhigh", contextWindow: 500000, capabilitySource: "catalog" });
    expect(adaptLlmRequest({ model: "grok-4.7", temperature: 1 }, gateway)).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "xhigh" } });
    expect(() => resolveLlmOptions({ ...native, HEIMDALL_LLM_API: "anthropic" }, "grok-4.7")).toThrow(/requires openai-responses/);
    const dir = temp(), cfg = { data_dir: dir, tools_env: loadToolsEnv(join(dir, "env.yaml")) } as Config;
    applyPayload(cfg, { ANTHROPIC_BASE_URL: native.HEIMDALL_LLM_BASE_URL, ANTHROPIC_MODEL: "grok-4.7", HEIMDALL_LLM_API: "responses" });
    expect((snapshot(cfg).effective as any).solver.protocol).toBe("openai-responses");
  });
  it("uses Responses max_output_tokens without dropping encrypted input or other reasoning fields", () => {
    const opts = resolveLlmOptions({ ...native, HEIMDALL_THINKING: "max", HEIMDALL_MAX_OUTPUT_TOKENS: "8192" }, "grok-4.7");
    const result = adaptLlmRequest({ model: opts.model, max_output_tokens: 16384, max_tokens: 16384, thinking: {}, reasoning_effort: "high",
      reasoning: { summary: "auto", custom: "preserved" }, input: [encrypted], presence_penalty: 1, stop: ["x"], include: ["other"] }, opts);
    expect(result).toMatchObject({ reasoning: { effort: "xhigh", custom: "preserved" }, max_output_tokens: 8192, input: [encrypted], include: ["other", "reasoning.encrypted_content"] });
    for (const key of ["max_tokens", "thinking", "reasoning_effort", "presence_penalty", "stop"]) expect(result).not.toHaveProperty(key);
    const doc = buildModelsDoc({ modelId: "grok-4.7", baseUrl: native.HEIMDALL_LLM_BASE_URL, env: native }) as any;
    expect(doc.providers.xai).toMatchObject({ api: "openai-responses", models: [{ input: ["text", "image"], contextWindow: 500000 }] });
  });
});

function sendResponses(res: ServerResponse, turn: number) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const event = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event("response.created", { response: { id: `resp_${turn}`, status: "in_progress" } });
  const output: any[] = [];
  if (turn === 1) {
    output.push(encrypted);
    event("response.output_item.added", { output_index: 0, item: { ...encrypted, encrypted_content: undefined } });
    event("response.output_item.done", { output_index: 0, item: encrypted });
    const tool = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "read", arguments: JSON.stringify({ path: "fixture.txt" }), status: "completed" };
    output.push(tool);
    event("response.output_item.added", { output_index: 1, item: { ...tool, arguments: "" } });
    event("response.function_call_arguments.delta", { output_index: 1, delta: tool.arguments });
    event("response.output_item.done", { output_index: 1, item: tool });
  } else {
    const msg = { type: "message", id: `msg_${turn}`, role: "assistant", content: [{ type: "output_text", text: "fixture complete", annotations: [] }], status: "completed" };
    output.push(msg);
    event("response.output_item.added", { output_index: 0, item: { ...msg, content: [] } });
    event("response.output_text.delta", { output_index: 0, content_index: 0, delta: "fixture complete" });
    event("response.output_item.done", { output_index: 0, item: msg });
  }
  event("response.completed", { response: { id: `resp_${turn}`, status: "completed", output, usage } });
  res.end();
}
function sendChat(res: ServerResponse, turn: number) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta: unknown, reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: `chat_${turn}`, object: "chat.completion.chunk", model: "grok-4.7", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
  if (turn === 1) {
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "fixture.txt" }) } }] });
    chunk({}, "tool_calls");
  } else { chunk({ role: "assistant", content: "fixture complete" }); chunk({}, "stop"); }
  res.end("data: [DONE]\n\n");
}

describe("real Grok-compatible Pi wire transports", () => {
  it.each([["sdk", "responses"], ["rpc", "responses"], ["sdk", "openai"], ["rpc", "openai"]])("executes a tool, continues and resumes over %s / %s", { timeout: 25000 }, async (transport, protocol) => {
    const dir = temp(), bodies: any[] = [], paths: string[] = [];
    writeFileSync(join(dir, "fixture.txt"), "fixture-tool-result");
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      bodies.push(JSON.parse(Buffer.concat(chunks).toString())); paths.push(req.url || "");
      if (protocol === "responses") sendResponses(res, bodies.length); else sendChat(res, bodies.length);
    });
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as any).port}/v1`;
    const tap = startLlmTap({ workspace: dir, upstream: upstreamUrl, inject: false }); await once(tap, "listening");
    for (const [key, value] of Object.entries({ PI_OFFLINE: "1", HEIMDALL_LLM_API: protocol, HEIMDALL_LLM_PROVIDER: "xai", HEIMDALL_CAPABILITY_PROVIDER: "xai",
      HEIMDALL_LLM_BASE_URL: `http://127.0.0.1:${(tap.address() as any).port}`, HEIMDALL_LLM_UPSTREAM: upstreamUrl,
      HEIMDALL_AGENT_MODEL: "grok-4.7", HEIMDALL_THINKING: "max", HEIMDALL_MAX_OUTPUT_TOKENS: "8192", HEIMDALL_LLM_API_KEY: "fixture", OPENAI_API_KEY: "fixture",
      PI_CODING_AGENT_DIR: join(dir, "agent"), HEIMDALL_PI_CLI: resolve("node_modules/.bin/pi"), HEIMDALL_COMPACT_ENABLED: "false" })) vi.stubEnv(key, value);
    const makeBackend = (): Backend => transport === "sdk" ? new PiBackend({ noSkills: true, noContextFiles: true }) : new PiRpcBackend();
    let backend = makeBackend(); const events = new EventSink(join(dir, "events.jsonl"));
    const opts = { workspace: dir, systemPrompt: "Local fixture", userPrompt: "Read fixture.txt", model: "grok-4.7", maxTurns: 0, permissionMode: "default", events, signal: AbortSignal.timeout(20000) };
    try {
      const result = await backend.run(opts);
      expect(result.ok, result.error || "backend failed").toBe(true);
      expect(bodies).toHaveLength(2);
      expect(paths.every(p => p === (protocol === "responses" ? "/v1/responses" : "/v1/chat/completions"))).toBe(true);
      expect(bodies.every(b => b.model === "grok-4.7" && (protocol === "responses" ? b.reasoning.effort : b.reasoning_effort) === "xhigh")).toBe(true);
      if (protocol === "responses") {
        expect(bodies[1].input).toContainEqual(encrypted);
        expect(bodies[1].input.some((item: any) => item.type === "function_call_output" && JSON.stringify(item.output).includes("fixture-tool-result"))).toBe(true);
        expect(bodies[0].max_output_tokens).toBe(8192); expect(bodies[0].store).toBe(false);
        expect(bodies[0].include).toContain("reasoning.encrypted_content");
        expect(readTotals(dir)).toMatchObject({ input_tokens: 80, output_tokens: 60, cache_read_tokens: 120, calls: 2 });
      } else expect(bodies[1].messages.some((m: any) => m.role === "tool" && String(m.content).includes("fixture-tool-result"))).toBe(true);
      const session = String(result.extra?.session_file || ""); expect(session).not.toBe("");
      await backend.close?.(); backend = makeBackend();
      const resumed = await backend.run({ ...opts, userPrompt: "Continue", resume: session });
      expect(resumed.ok, resumed.error || "resume failed").toBe(true); expect(bodies).toHaveLength(3);
      if (protocol === "responses") expect(bodies[2].input).toContainEqual(encrypted);
    } finally { await backend.close?.(); events.close(); await close(tap); await close(upstream); }
  });
});

describe("Responses observation and accounting", () => {
  it("injects and refreshes only instruction text without changing encrypted or tool items", () => {
    const input = [{ role: "system", content: [{ type: "input_text", text: "base\n" + map }] }, encrypted,
      { type: "function_call_output", call_id: "call_fixture", output: "unchanged" }, { role: "user", content: "question" }];
    const raw = Buffer.from(JSON.stringify({ model: "grok-4.7", input }));
    const newMap = map.replace("fixture", "updated");
    const next = injectBriefIntoMessages(injectMapIntoMessages(raw, newMap, "responses"), "<heimdall-brief>\nbrief\n</heimdall-brief>", "responses");
    const doc = JSON.parse(next.toString());
    expect(doc).not.toHaveProperty("system"); expect(doc.input[1]).toEqual(encrypted); expect(doc.input[2]).toEqual(input[2]);
    expect(doc.input[0].content[0].text).toContain("updated"); expect(requestHasRealInject(next)).toBe(true);
    expect(JSON.stringify(flattenMessages(doc))).not.toContain(encrypted.encrypted_content);
    expect(requestHasRealInject(injectMapIntoMessages(next, null, "responses"))).toBe(false);
    const stringInput = JSON.parse(injectMapIntoMessages(Buffer.from('{"input":"hello"}'), map, "responses").toString());
    expect(stringInput.input[0]).toEqual({ role: "user", content: "hello" });
    const chat = JSON.parse(injectMapIntoMessages(Buffer.from('{"messages":[{"role":"user","content":"hello"}]}'), map, "chat").toString());
    expect(chat.system).toBeUndefined(); expect(chat.messages[1].role).toBe("system");
  });
  it("collects nested terminal usage without counting cached tokens twice", () => {
    expect(extractUsage({ type: "response.completed", response: { usage } })).toMatchObject({ input_tokens: 40, cache_read_tokens: 60, output_tokens: 30 });
    const scanner = new UsageScanner(); scanner.feed(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage } })}\n\n`);
    expect(scanner.finish()).toMatchObject({ input_tokens: 40, cache_read_tokens: 60, output_tokens: 30 });
    const replies = new ReplyCollector();
    replies.feed('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n');
    replies.feed('event: response.completed\ndata: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}]}}\n\n');
    expect(replies.finish()).toBe("hello");
    const unicode = new ReplyCollector();
    const bytes = Buffer.from('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"中文正常"}\n\n');
    for (const byte of bytes) unicode.feed(Buffer.from([byte]));
    expect(unicode.finish()).toBe("中文正常");
    const json = new ReplyCollector(); json.feed(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "plain JSON" }] }] }));
    expect(json.finish()).toBe("plain JSON");
  });
});
