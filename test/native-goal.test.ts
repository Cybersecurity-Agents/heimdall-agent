import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeBackend } from "../src/agent/backends/claude.js";
import { EventSink } from "../src/shared/events.js";
import { runAgent } from "../src/agent/runner.js";
import { loadSettings } from "../src/agent/config.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function workspace() { const dir = mkdtempSync("/tmp/heimdall-native-goal-"); dirs.push(dir); return dir; }

describe("native Claude goal", () => {
  it.each(["claude-opus-4-7", "vendor/deepseek-v4.2:preview", "grok-4.7"])("uses the real SDK goal hook and wire profile with %s", { timeout: 25000 }, async (model) => {
    const future = model.startsWith("vendor/");
    const dir = workspace();
    mkdirSync(join(dir, ".claude", "skills", "fixture-goal-skill"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "fixture-goal-skill", "SKILL.md"), "---\nname: fixture-goal-skill\ndescription: Local goal fixture\n---\nUse only for the local fixture.\n");
    let mainTurns = 0, checks = 0;
    const requests: string[] = [];
    const mainBodies: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      let raw = ""; req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        if (!req.url?.startsWith("/v1/messages")) { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return; }
        const body = JSON.parse(raw); requests.push(body.model);
        const evaluator = body.model === "fixture-evaluator";
        if (!evaluator) mainBodies.push(body);
        const text = evaluator ? JSON.stringify({ ok: ++checks >= 2, reason: checks >= 2 ? "Fixture accepted" : "Fixture still incomplete; continue working" })
          : `Fixture work turn ${++mainTurns}`;
        const message = { id: `fixture-${requests.length}`, type: "message", role: "assistant", model: body.model,
          content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 } };
        if (!body.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(message)); return; }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const event = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data as object })}\n\n`);
        event("message_start", { message: { ...message, content: [], stop_reason: null } });
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
        event("content_block_stop", { index: 0 });
        event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
        event("message_stop", {}); res.end();
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    mkdirSync(join(dir, "home"), { recursive: true });
    const env = { HOME: join(dir, "home"), CLAUDE_CONFIG_DIR: join(dir, "config"), ANTHROPIC_API_KEY: "fixture-only",
      ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      HEIMDALL_SMALL_MODEL: "fixture-evaluator", HEIMDALL_THINKING: "xhigh", HEIMDALL_THINKING_MODE: future ? "auto" : "adaptive", HEIMDALL_CAPABILITY_PROFILE: future ? "deepseek" : model === "grok-4.7" ? "claude-adaptive" : "auto",
      HEIMDALL_MAX_OUTPUT_TOKENS: "4096", HEIMDALL_CONTEXT_WINDOW: "64000", HEIMDALL_COMPACT_PCT: "60", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const backend = new ClaudeBackend();
    try {
      const result = await backend.run({ workspace: dir, systemPrompt: "Local protocol fixture. Never use tools.", userPrompt: "Perform fixture work",
        goal: "The local fixture is accepted", model, maxTurns: 6, permissionMode: "default",
        events: new EventSink(join(dir, "events.jsonl")), signal: AbortSignal.timeout(18000) });
      expect(result.ok, JSON.stringify({ result, mainTurns, checks, requests })).toBe(true);
      expect(checks).toBeGreaterThanOrEqual(2);
      expect(mainTurns).toBeGreaterThanOrEqual(2);
      expect(mainBodies.every(body => body.model === model && body.max_tokens === 4096)).toBe(true);
      expect(mainBodies.every(body => (body.thinking as { type: string })?.type === (future ? "enabled" : "adaptive"))).toBe(true);
      expect(readFileSync(join(dir, "events.jsonl"), "utf8")).toContain("Goal set:");
      expect(readFileSync(join(dir, "events.jsonl"), "utf8")).toContain("fixture-goal-skill");
      expect(mainBodies.every(body => (body.output_config as { effort?: string })?.effort === (future ? "high" : "xhigh"))).toBe(true);
      expect(result.extra?.goal_driver).toBe("native");
    } finally { backend.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  });

  it("re-arms native goal after SDK success with no accepted flag", { timeout: 8000 }, async () => {
    const dir = workspace();
    writeFileSync(join(dir, "input.json"), JSON.stringify({ unique_code: "task-1", flag_count: 1 }));
    const run = vi.spyOn(ClaudeBackend.prototype, "run").mockImplementation(async opts => {
      expect(opts.goal).toBeTruthy();
      if (run.mock.calls.length === 2) writeFileSync(join(dir, "flags.json"), JSON.stringify([{ flag: "flag{accepted}", correct: true, via: "heimdall-submit" }]));
      return { backend: "sdk", ok: true, exitCode: 0, turns: 3, toolUses: 3, extra: { session_id: "fixture-session" } };
    });
    vi.stubEnv("HEIMDALL_SUBMIT_BIN", "/bin/true"); vi.stubEnv("HEIMDALL_GOAL_DRIVER", "native_required");
    const exit = await runAgent({ ...loadSettings(), workspace: dir, backend: "sdk", loopTimeoutSec: 6 });
    expect(exit).toBe(0); expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0].resume).toBe("fixture-session");
  });

  it("aborts a still-running query as soon as all flags are accepted", { timeout: 5000 }, async () => {
    const dir = workspace();
    writeFileSync(join(dir, "input.json"), JSON.stringify({ unique_code: "task-1", flag_count: 1 }));
    let signal: AbortSignal | undefined;
    vi.spyOn(ClaudeBackend.prototype, "run").mockImplementation(opts => {
      signal = opts.signal;
      setTimeout(() => writeFileSync(join(dir, "flags.json"), JSON.stringify([{ flag: "flag{accepted}", correct: true, via: "heimdall-submit" }])), 50);
      return new Promise(() => {});
    });
    const close = vi.spyOn(ClaudeBackend.prototype, "close");
    vi.stubEnv("HEIMDALL_SUBMIT_BIN", "/bin/true");
    expect(await runAgent({ ...loadSettings(), workspace: dir, backend: "sdk", loopTimeoutSec: 3 })).toBe(0);
    expect(signal?.aborted).toBe(true); expect(close).toHaveBeenCalled();
  });
});
