import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OBSERVATION_EXAMPLE, SubmitSchema, parseSubmission, ObservationValidationError, type Assessment, type ObservationSubmit } from "../src/observer/contract.js";
import { ObservationTurn, recoverObservationCursor } from "../src/observer/tools.js";
import { loadObservation } from "../src/observer/state.js";
import { executeObservationTick, OBSERVER_TOOLS } from "../src/observer/loop.js";
import { prepareTick } from "../src/observer/publish.js";
import { compileObservation } from "../src/observer/compile.js";
import { graphJson, injectTxt, eventsJsonl, observeDagJson, trafficDir } from "../src/shared/paths.js";
import { observationPointer, publicationDir } from "../src/shared/observation-publication.js";
import { loadNodeEvidence } from "../src/control/console/graphs.js";
import { composeInjectBlob, injectMapIntoMessages, findInjectHits } from "../src/shared/inject.js";
import * as delta from "../src/observer/delta.js";
import { EventSink } from "../src/shared/events.js";
import type { Backend } from "../src/agent/backends/types.js";
import { startLlmTap } from "../src/taps/llm-tap.js";
import { seedJobSteer } from "../src/observer/job-steer.js";
import { buildUserPrompt, loopFollowupPrompt } from "../src/agent/prompts.js";

vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>() }));

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function workspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "heimdall-structured-")); dirs.push(ws);
  mkdirSync(join(ws, ".heimdall", "traffic"), { recursive: true });
  writeFileSync(join(ws, "input.json"), JSON.stringify({ job_id: "job-1", unique_code: "fixture", description: "A login surface", flag_count: 1, api_key: "must-not-be-in-context" }));
  writeFileSync(join(ws, ".heimdall", "traffic", "turns.jsonl"), [1, 2, 3].map(n => JSON.stringify({ n, jobId: "job-1", detail: `Tool result ${n}: observed login behavior`, sources: [] })).join("\n") + "\n");
  return ws;
}
const assessment = (id = "auth", patch: Partial<Assessment> = {}): Assessment => ({
  id, subject: "Authentication logic", status: "tried-hit", conclusion: "An authentication boundary was crossed", basis: "Observed tool output", uncertainty: null,
  evidenceRefs: ["turn:1"], attempts: [{ id: "attempt-1", action: "Check the authentication boundary", result: "The response changed", evidenceRefs: ["turn:1"] }], ...patch,
});
const request = (turn: ObservationTurn, upserts: Assessment[] = [assessment()]): ObservationSubmit => ({ baseRevision: turn.base.revision, upserts, retireIds: [] });
const read = (ws: string, name: string): string => readFileSync(join(publicationDir(ws), name), "utf8");
function userPrompt(ws: string): string {
  return buildUserPrompt({ workspace: ws, inputDoc: JSON.parse(readFileSync(join(ws, "input.json"), "utf8")), uniqueCode: "fixture", attemptN: 1 });
}
function receipt(ws: string): string {
  const id = "a".repeat(64), dir = join(ws, ".heimdall/recap/receipts"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, jobId: "job-1", code: "fixture", acceptedAt: 100, flagIndex: 1, correctCount: 1, totalCount: 4, duplicate: false }));
  return `receipt:${id}`;
}

describe("structured observer contract", () => {
  it.each(["web", "cve", "pwn", "intranet", "all", "evasion"])("does not create or inject a startup map for %s", challenge_type => {
    const ws = workspace();
    writeFileSync(join(ws, "input.json"), JSON.stringify({ job_id: "job-1", unique_code: "fixture", challenge_type }));
    expect(seedJobSteer(ws)).toBe(true);
    expect(seedJobSteer(ws)).toBe(false);
    expect(existsSync(injectTxt(ws))).toBe(false);
    expect(existsSync(join(trafficDir(ws), "inject.published.txt"))).toBe(false);
    expect(composeInjectBlob(ws)).toBeNull();
    expect(findInjectHits(userPrompt(ws), ["map"])).toHaveLength(0);
    expect(findInjectHits(loopFollowupPrompt(1, ws), ["map"])).toHaveLength(0);
  });

  it("ignores legacy startup files and drafts until a valid current-job publication", () => {
    const ws = workspace();
    const legacy = "<heimdall-map>\nCONFIRMED:\n- leftover spray_*.txt does not enable spraying on this job\nLOCK:\nANGLES:\n- 登录注入 / 鉴权逻辑（少量引号、恒真、改请求形态）先于口令喷洒与密钥伪造\n</heimdall-map>\n";
    for (const name of ["inject.txt", "inject.published.txt", "CONFIRMED.md", "map.md"]) writeFileSync(join(trafficDir(ws), name), legacy);
    const assertUnpublished = () => {
      expect(composeInjectBlob(ws)).toBeNull();
      for (const prompt of [userPrompt(ws), loopFollowupPrompt(1, ws)]) {
        expect(findInjectHits(prompt, ["map"])).toHaveLength(0);
        expect(prompt).not.toContain("leftover spray_");
        expect(prompt).not.toContain("少量引号");
      }
    };
    assertUnpublished(); // Also covers existing workspaces without running startup cleanup.
    seedJobSteer(ws);
    assertUnpublished();
    rmSync(join(trafficDir(ws), "inject.txt"));
    assertUnpublished(); // No fallback to CONFIRMED.md or map.md.
    const turn = new ObservationTurn(ws);
    expect(turn.submit(request(turn, [assessment("recon")])).ok).toBe(false);
    assertUnpublished();
    expect(turn.submit({ ...request(turn), guidance: { hypothesis: null, lock: null, angleIds: [], confirmedIds: ["auth"], tension: [] } }).ok).toBe(true);
    for (const prompt of [composeInjectBlob(ws), userPrompt(ws), loopFollowupPrompt(1, ws)]) {
      expect(prompt).toContain("An authentication boundary was crossed");
      expect(prompt).not.toContain("leftover spray_");
    }
    expect(seedJobSteer(ws)).toBe(false);
    expect(composeInjectBlob(ws)).toContain("An authentication boundary was crossed");
    writeFileSync(join(ws, "input.json"), JSON.stringify({ job_id: "job-2", unique_code: "fixture" }));
    assertUnpublished();
  });

  it("keeps platform hints available before observation without promoting a legacy map", () => {
    const ws = workspace();
    writeFileSync(injectTxt(ws), "<heimdall-map>\nCONFIRMED:\n- unvalidated draft\n</heimdall-map>\n");
    writeFileSync(join(ws, "hint.txt"), "Platform-provided hint");
    for (const prompt of [composeInjectBlob(ws), userPrompt(ws), loopFollowupPrompt(1, ws)]) {
      expect(prompt).toContain("PLATFORM HINT:");
      expect(prompt).toContain("Platform-provided hint");
      expect(prompt).not.toContain("unvalidated draft");
      expect(prompt).not.toContain("CONFIRMED:");
    }
  });

  it("does not use a publication with missing job metadata", () => {
    const ws = workspace(), turn = new ObservationTurn(ws);
    expect(turn.submit(request(turn)).ok).toBe(true);
    rmSync(join(publicationDir(ws), "observation.json"));
    expect(composeInjectBlob(ws)).toBeNull();
    expect(findInjectHits(userPrompt(ws), ["map"])).toHaveLength(0);
  });

  it("permits complete text with whole-string constrained decoders while rejecting blank judgments", () => {
    const pattern = SubmitSchema.properties.upserts.items.properties.subject.pattern!;
    const constrained = new RegExp(`^(?:${pattern})$`);
    for (const text of ["Authentication logic", "鉴权逻辑", "First observation\nsecond observation"]) {
      expect(constrained.test(text)).toBe(true);
      expect(parseSubmission({ ...OBSERVATION_EXAMPLE, upserts: [{ ...OBSERVATION_EXAMPLE.upserts[0], subject: text }] }).upserts[0]?.subject).toBe(text);
    }
    for (const text of ["", "  ", "\n\t"]) expect(() => parseSubmission({ ...OBSERVATION_EXAMPLE, upserts: [{ ...OBSERVATION_EXAMPLE.upserts[0], subject: text }] })).toThrow();
  });
  it("reports rejected publications as tool errors and permits a corrected submission", async () => {
    const ws = workspace(), turn = new ObservationTurn(ws);
    const tool = turn.tools().find(t => t.name === "observation_submit")!;
    const bad = turn.prepare(request(turn, [assessment("recon")]));
    await expect(tool.execute("bad", bad, undefined, undefined, {} as never)).rejects.toThrow(/reserved_id/);
    expect(turn.published).toBeNull();
    expect(turn.lastFailure?.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "reserved_id" })]));
    const valid = turn.prepare({ ...request(turn), guidance: { hypothesis: null, lock: null, angleIds: [], confirmedIds: ["auth"], tension: [] } });
    await expect(tool.execute("good", valid, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { ok: true } });
    expect(composeInjectBlob(ws)).toContain("An authentication boundary was crossed");
  });

  it("logs malformed argument diagnostics when no graph can be published", async () => {
    const ws = workspace(), turn = new ObservationTurn(ws);
    const log = join(ws, "observer.log");
    const events = new EventSink(join(ws, "observer.events.jsonl"), log);
    const controller = new AbortController();
    const backend: Backend = { name: "fake", run: async () => {
      expect(() => turn.prepare({ ...request(turn), upserts: "[{broken" })).toThrow(/must be array/);
      controller.abort();
      return { backend: "fake", ok: true, exitCode: 0 };
    } };
    try {
      expect(await executeObservationTick(turn, backend, { workspace: ws, events, systemPrompt: "", userPrompt: "", permissionMode: "bypassPermissions", maxTurns: 20, model: null, signal: controller.signal })).toBe(false);
      expect(readFileSync(log, "utf8")).toContain("must be array");
      expect(composeInjectBlob(ws)).toBeNull();
    } finally { events.close(); }
  });

  it("reports every misplaced field instead of pretending lists exceed their limits", () => {
    const bad: any = structuredClone(OBSERVATION_EXAMPLE);
    bad.upserts[0].summary = { evidenceRefs: bad.upserts[0].evidenceRefs, steps: [] };
    delete bad.upserts[0].evidenceRefs; delete bad.upserts[0].attempts;
    let caught: unknown;
    try { parseSubmission(bad); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ObservationValidationError);
    const issues = (caught as ObservationValidationError).issues;
    expect(issues.filter(e => e.code === "misplaced_field").map(e => e.path)).toEqual(["/upserts/0/evidenceRefs", "/upserts/0/attempts"]);
    expect(issues.some(e => e.path === "/upserts/0/summary")).toBe(true);
  });

  it("exposes structured and workspace tools with the pinned task/evidence", () => {
    const ws = workspace(), turn = new ObservationTurn(ws);
    expect(OBSERVER_TOOLS).toEqual(["observation_context", "observation_submit", "read", "write", "edit", "grep", "find", "ls"]);
    expect(turn.tools().map(t => t.name)).toEqual(["observation_context", "observation_submit"]);
    const context = turn.context({ evidenceRefs: ["turn:1", "turn:999"] });
    expect(JSON.stringify(context)).not.toContain("must-not-be-in-context");
    expect(context.evidence[0]).toMatchObject({ ref: "turn:1", text: expect.stringContaining("Tool result") });
    expect(context.evidence[1]).toMatchObject({ unavailable: "unknown_evidence" });
  });

  it("freezes references and permits correction beyond the former submission limit", () => {
    const ws = workspace(), turn = new ObservationTurn(ws);
    writeFileSync(join(trafficDir(ws), "turns.jsonl"), JSON.stringify({ n: 999, jobId: "job-1", detail: "New output" }) + "\n", { flag: "a" });
    const bad = request(turn, [assessment("auth", { evidenceRefs: ["turn:999"] })]);
    expect(turn.submit(bad).errors?.some(e => e.code === "unknown_evidence")).toBe(true);
    expect(turn.submit({}).ok).toBe(false);
    expect(turn.submit(request(turn)).ok).toBe(true);
    expect(turn.attempts).toBe(3);
    const retried = new ObservationTurn(ws);
    for (let i = 0; i < 8; i++) expect(retried.submit({}).ok).toBe(false);
    expect(retried.submit(request(retried)).ok).toBe(true);
    expect(retried.attempts).toBe(9);
  });
});

describe("solve judgments compile into a useful graph", () => {
  it("keeps endpoint, path, successful dependency chain, open angles and real receipt nodes", () => {
    const ws = workspace(), ref = receipt(ws), turn = new ObservationTurn(ws);
    const update = request(turn, [
      assessment("login", { role: "endpoint", subject: "POST /login", api: "POST /login" }),
      assessment("auth", { dependsOn: ["login"], evidenceRefs: ["turn:1", ref] }),
      assessment("config", { role: "path", subject: "Configuration file", dependsOn: ["auth"] }),
      assessment("untried", { status: "inferred-open", subject: "Configuration boundary", attempts: [], dependsOn: ["config"] }),
    ]);
    update.guidance = { hypothesis: "Authentication controls access to configuration", lock: "Authentication | access boundary | configuration", angleIds: ["untried"], confirmedIds: ["auth"], tension: [] };
    const result = turn.submit(update); expect(result.ok).toBe(true);
    const dag = JSON.parse(readFileSync(observeDagJson(ws), "utf8"));
    expect(dag.nodes.find((n: any) => n.id === "login")).toMatchObject({ kind: "endpoint", api: "POST /login" });
    expect(dag.nodes.find((n: any) => n.id === "config")).toMatchObject({ kind: "path" });
    expect(dag.edges).toEqual(expect.arrayContaining([{ from: "login", to: "auth" }, { from: "auth", to: "config" }, { from: "config", to: "untried" }, { from: "auth", to: `host-flag-${"a".repeat(64)}` }]));
    expect(read(ws, "inject.txt")).toContain("Configuration boundary");
    expect(read(ws, "CONFIRMED.md")).toContain("An authentication boundary was crossed");
    const graph = JSON.parse(read(ws, "graph.json")), evidence = JSON.parse(read(ws, "evidence.json"));
    expect(graph.publication).toEqual(evidence.publication);
    const root = join(ws, "..");
    expect(loadNodeEvidence(root, ws.split("/").pop()!, "auth", result.revision!).items?.map(e => e.ref)).toEqual(expect.arrayContaining(["turn:1", ref]));
  });

  it("accepts multiple independent scan classes and does not fabricate flag success", () => {
    const ws = workspace(), turn = new ObservationTurn(ws);
    expect(turn.submit(request(turn, [assessment("scan1", { status: "scan-class" }), assessment("scan2", { status: "scan-class" })])).ok).toBe(true);
    const dag = JSON.parse(read(ws, "observe_dag.json"));
    expect(dag.nodes.filter((n: any) => n.kind === "scan")).toHaveLength(2);
    expect(dag.nodes.filter((n: any) => n.kind === "flag")).toHaveLength(0);
  });

  it("rejects unsupported execution, cycles and duplicate attempt IDs without changing published artifacts", () => {
    const ws = workspace(), first = new ObservationTurn(ws); expect(first.submit(request(first)).ok).toBe(true);
    const active = publicationDir(ws), next = new ObservationTurn(ws);
    const bad = request(next, [assessment("a", { dependsOn: ["b"], attempts: [{ id: "same", action: "a", result: "b", evidenceRefs: ["input:task"] }, { id: "same", action: "a", result: "b", evidenceRefs: ["input:task"] }] }), assessment("b", { dependsOn: ["a"] })]);
    const codes = next.submit(bad).errors?.map(e => e.code);
    expect(codes).toEqual(expect.arrayContaining(["duplicate_id", "execution_evidence_required", "cycle"]));
    expect(publicationDir(ws)).toBe(active);
  });

  it("retains meaningful attempts on incremental updates and archives superseded phases", () => {
    const ws = workspace(), first = new ObservationTurn(ws); expect(first.submit(request(first)).ok).toBe(true);
    const second = new ObservationTurn(ws);
    expect(second.submit(request(second, [assessment("auth", { attempts: [{ id: "attempt-2", action: "Second check", result: "No further progress", evidenceRefs: ["turn:2"] }] })])).ok).toBe(true);
    expect(loadObservation(ws).assessments[0]!.attempts.map(a => a.id)).toEqual(["attempt-1", "attempt-2"]);
    const third = new ObservationTurn(ws);
    expect(third.submit({ ...request(third, []), retireIds: ["auth"] }).ok).toBe(true);
    expect(loadObservation(ws).assessments).toHaveLength(0);
    expect(loadObservation(ws).retired[0]!.attempts).toHaveLength(2);
  });

  it("renders uncertain/empty guidance as a usable graph instead of demanding invented open nodes", () => {
    const ws = workspace(); writeFileSync(join(ws, "hint.txt"), "A platform hint\n");
    const turn = new ObservationTurn(ws);
    const compiled = compileObservation(turn.base, turn.input);
    expect(compiled.warnings).toContain("A platform hint is available; consider updating LOCK.");
    expect(turn.submit(request(turn, [])).ok).toBe(true);
    expect(JSON.parse(read(ws, "observe_dag.json")).nodes).toHaveLength(2);
    expect(read(ws, "inject.txt")).toContain("PLATFORM HINT");
  });

});

describe("observation publication lifecycle", () => {
  it("forwards the latest published map in the solver HTTP request", async () => {
    const ws = workspace();
    const received: Array<{ system: Array<{ text: string }> }> = [];
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "message", role: "assistant", content: [{ type: "text", text: "received" }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const tap = startLlmTap({ workspace: ws, upstream: `http://127.0.0.1:${upstreamPort}`, port: 0, jobId: "job-1" });
    await once(tap, "listening");
    try {
      const url = `http://127.0.0.1:${(tap.address() as { port: number }).port}/v1/messages`;
      const send = async (system: string) => {
        const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "fixture", system, messages: [{ role: "user", content: "Continue" }] }) });
        expect(response.status).toBe(200); await response.text();
      };
      const first = new ObservationTurn(ws), guidance = { hypothesis: null, lock: null, angleIds: [], confirmedIds: ["auth"], tension: [] };
      expect(first.submit({ ...request(first), guidance }).ok).toBe(true);
      const oldBlob = composeInjectBlob(ws)!;
      await send("Solver system prompt");
      const second = new ObservationTurn(ws);
      expect(second.submit({ ...request(second, [assessment("auth", { conclusion: "The second publication includes new verified evidence" })]), guidance }).ok).toBe(true);
      await send(oldBlob);
      const system = received[1]!.system.map(b => b.text).join("\n");
      expect(findInjectHits(system, ["map"])).toHaveLength(1);
      expect(system).toContain("The second publication includes new verified evidence");
      expect(system).not.toContain("An authentication boundary was crossed");
    } finally {
      await Promise.all([new Promise<void>(resolve => tap.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
    }
  });

  it("continues the same window until publication and injects the new revision once", async () => {
    const ws = workspace(), first = new ObservationTurn(ws);
    const guidance = { hypothesis: null, lock: null, angleIds: [], confirmedIds: ["auth"], tension: [] };
    expect(first.submit({ ...request(first), guidance }).ok).toBe(true);
    const oldBlob = composeInjectBlob(ws)!;
    const oldRevision = loadObservation(ws).revision;
    const turn = new ObservationTurn(ws), close = vi.fn();
    const events = new EventSink(join(ws, "observer.events.jsonl"), join(ws, "observer.log"));
    let runs = 0;
    const backend: Backend = { name: "fake", close, run: async opts => {
      runs++;
      expect(opts.maxTurns).toBe(0);
      expect(close).not.toHaveBeenCalled();
      if (runs < 6) {
        if (runs > 1) expect(opts.userPrompt).toContain("must be array");
        expect(turn.submit({ ...request(turn), upserts: "[{broken" }).ok).toBe(false);
        expect(loadObservation(ws).revision).toBe(oldRevision);
      } else {
        expect(turn.submit({ ...request(turn, [assessment("auth", { conclusion: "New evidence changes the authentication conclusion" })]), guidance }).ok).toBe(true);
      }
      return { backend: "fake", ok: true, exitCode: 0, extra: { stop_reason: runs === 3 ? "max_tokens" : "stop" } };
    } };
    try {
      expect(await executeObservationTick(turn, backend, { workspace: ws, events, systemPrompt: "", userPrompt: "Observe", permissionMode: "bypassPermissions", maxTurns: 20, model: null })).toBe(true);
      expect(runs).toBe(6);
      expect(close).toHaveBeenCalledOnce();
      expect(loadObservation(ws).revision).not.toBe(oldRevision);
      const raw = Buffer.from(JSON.stringify({ system: [{ type: "text", text: oldBlob }, { type: "text", text: oldBlob }], messages: [{ role: "user", content: "Continue" }] }));
      const body = JSON.parse(injectMapIntoMessages(raw, composeInjectBlob(ws)).toString());
      const system = body.system.map((b: { text: string }) => b.text).join("\n");
      expect(findInjectHits(system, ["map"])).toHaveLength(1);
      expect(system).toContain("New evidence changes the authentication conclusion");
      expect(system).not.toContain("An authentication boundary was crossed");
    } finally { events.close(); }
  });

  it("interrupts an in-flight correction when the job stops", async () => {
    const ws = workspace(), turn = new ObservationTurn(ws);
    const events = new EventSink(join(ws, "observer.events.jsonl"), join(ws, "observer.log"));
    const backend: Backend = { name: "fake", run: async opts => {
      writeFileSync(join(ws, ".heimdall", "observer.stop"), "stop");
      return new Promise((_resolve, reject) => opts.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    } };
    try {
      expect(await executeObservationTick(turn, backend, { workspace: ws, events, systemPrompt: "", userPrompt: "Observe", permissionMode: "bypassPermissions", maxTurns: 0, model: null })).toBe(false);
      expect(turn.submit(request(turn)).errors?.[0]?.code).toBe("expired_window");
      expect(composeInjectBlob(ws)).toBeNull();
    } finally { events.close(); }
  });

  it("migrates the accepted graph and dependencies instead of a failed DAG draft", () => {
    const source = workspace(), first = new ObservationTurn(source);
    expect(first.submit(request(first, [assessment("login", { role: "endpoint", api: "POST /login" }), assessment("auth", { dependsOn: ["login"] })])).ok).toBe(true);
    const ws = workspace();
    writeFileSync(join(trafficDir(ws), "graph.json"), read(source, "graph.json"));
    writeFileSync(join(trafficDir(ws), "observe_dag.json"), "{ broken draft");
    const migrated = new ObservationTurn(ws);
    expect(migrated.base.assessments.find(a => a.id === "auth")).toMatchObject({ dependsOn: ["login"], attempts: [{ id: "attempt-1" }] });
    expect(migrated.base.assessments.find(a => a.id === "login")).toMatchObject({ role: "endpoint", api: "POST /login" });
    expect(migrated.submit(request(migrated, [])).ok).toBe(true);
  });

  it("keeps published excerpts stable after ledger rotation and redacts stored judgments", () => {
    const ws = workspace(), first = new ObservationTurn(ws);
    expect(first.submit(request(first, [assessment("auth", { conclusion: "Observed flag{fixture-secret}" })])).ok).toBe(true);
    for (const file of ["observation.json", "graph.json", "map.md", "inject.txt"]) expect(read(ws, file)).not.toContain("fixture-secret");
    writeFileSync(join(trafficDir(ws), "turns.jsonl"), JSON.stringify({ n: 1, jobId: "job-1", detail: "Unrelated replacement bytes" }) + "\n");
    const second = new ObservationTurn(ws);
    expect(second.context({ evidenceRefs: ["turn:1"] }).evidence[0]).toMatchObject({ text: expect.stringContaining("Tool result 1") });
    expect(second.submit(request(second, [])).ok).toBe(true);
  });

  it("does not carry judgments, execution evidence, or accepted flags into another job", () => {
    const ws = workspace(); receipt(ws);
    const first = new ObservationTurn(ws); expect(first.submit(request(first)).ok).toBe(true);
    writeFileSync(join(ws, "input.json"), JSON.stringify({ job_id: "job-2", unique_code: "fixture", description: "New task", flag_count: 1 }));
    expect(composeInjectBlob(ws)).toBeNull();
    const second = new ObservationTurn(ws);
    expect(second.base.assessments).toEqual([]); expect(second.input.receipts).toEqual([]);
    expect(second.context({ evidenceRefs: ["turn:1"] }).evidence[0]).toMatchObject({ unavailable: "unknown_evidence" });
    expect(second.submit(request(second, [])).ok).toBe(true);
    expect(JSON.parse(read(ws, "graph.json")).publication.jobId).toBe("job-2");
  });

  it("preserves legacy content if the first migration cannot commit", () => {
    const ws = workspace(); writeFileSync(join(trafficDir(ws), "inject.txt"), "legacy inject");
    const turn = new ObservationTurn(ws), rename = fs.renameSync;
    let switches = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === observationPointer(ws) && ++switches === 2) throw new Error("first commit interrupted");
      return rename(from, to);
    });
    expect(turn.submit(request(turn)).ok).toBe(false);
    expect(readFileSync(join(trafficDir(ws), "inject.txt"), "utf8")).toBe("legacy inject");
    vi.restoreAllMocks();
    expect(turn.submit(request(turn)).ok).toBe(true);
  });

  it("recognizes a durable publication despite backend and cleanup exceptions", async () => {
    const ws = workspace(), turn = new ObservationTurn(ws);
    const events = new EventSink(join(ws, "events.jsonl"), join(ws, "observer.log"));
    const backend: Backend = { name: "fake", close: async () => { throw new Error("cleanup failed"); }, run: async () => {
      expect(turn.submit(request(turn)).ok).toBe(true); throw new Error("transport disconnected after publication");
    } };
    try {
      expect(await executeObservationTick(turn, backend, { workspace: ws, events, systemPrompt: "", userPrompt: "", permissionMode: "bypassPermissions", maxTurns: 20, model: null })).toBe(true);
      expect(loadObservation(ws).revision).toBe(turn.published?.revision);
      expect(turn.submit(request(turn)).errors?.[0]?.code).toBe("expired_window");
    } finally { events.close(); }
  });

  it("keeps legacy paths readable and repeated submissions idempotent", () => {
    const ws = workspace(), turn = new ObservationTurn(ws), update = request(turn);
    const first = turn.submit(update), pointer = readlinkSync(observationPointer(ws));
    expect(first.ok).toBe(true);
    expect(turn.submit(update)).toEqual(first);
    expect(readlinkSync(observationPointer(ws))).toBe(pointer);
    expect(readFileSync(join(trafficDir(ws), "graph.json"), "utf8")).toBe(read(ws, "graph.json"));
    expect(readFileSync(join(trafficDir(ws), "CONFIRMED.md"), "utf8")).toBe(read(ws, "CONFIRMED.md"));
    expect(new ObservationTurn(ws).submit(update).revision).toBe(first.revision);
  });

  it("preserves the previous version on failed pointer switch and publishes a local retry", () => {
    const ws = workspace(), first = new ObservationTurn(ws); expect(first.submit(request(first)).ok).toBe(true);
    const oldDir = publicationDir(ws), oldGraph = read(ws, "graph.json");
    const turn = new ObservationTurn(ws), update = request(turn, [assessment("auth", { conclusion: "New conclusion" })]);
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === observationPointer(ws)) throw new Error("simulated interrupted commit");
      return rename(from, to);
    });
    expect(turn.submit(update).ok).toBe(false);
    expect(publicationDir(ws)).toBe(oldDir); expect(read(ws, "graph.json")).toBe(oldGraph);
    vi.restoreAllMocks();
    expect(turn.submit(update).ok).toBe(true);
    expect(read(ws, "graph.json")).toContain("New conclusion");
    expect(readFileSync(join(oldDir, "graph.json"), "utf8")).toBe(oldGraph);
  });

  it("commits no-change windows and recovers cursor cleanup after publication", () => {
    const ws = workspace(), first = new ObservationTurn(ws); expect(first.submit(request(first)).ok).toBe(true);
    writeFileSync(eventsJsonl(ws), JSON.stringify({ kind: "pi_turn_end", payload: { message: { content: [{ type: "text", text: "A new observation" }] } } }) + "\n");
    prepareTick(ws);
    const turn = new ObservationTurn(ws); expect(turn.cursor.events_byte).toBeGreaterThan(0);
    vi.spyOn(delta, "saveCursor").mockImplementationOnce(() => { throw new Error("cache write failed"); });
    const published = turn.submit(request(turn, [])); expect(published).toMatchObject({ ok: true, unchanged: true });
    expect(existsSync(join(trafficDir(ws), "observe_cursor.pending.json"))).toBe(true);
    vi.restoreAllMocks(); recoverObservationCursor(ws);
    expect(delta.loadCursor(ws)).toEqual(turn.cursor);
    expect(existsSync(join(trafficDir(ws), "observe_cursor.pending.json"))).toBe(false);
    expect(loadObservation(ws).assessments).toHaveLength(1);
  });

  it("overlays a changed platform hint without modifying the immutable publication", () => {
    const ws = workspace(); writeFileSync(join(ws, "hint.txt"), "Old hint\n");
    const turn = new ObservationTurn(ws); expect(turn.submit(request(turn)).ok).toBe(true);
    const previous = readFileSync(injectTxt(ws), "utf8");
    writeFileSync(join(ws, "hint.txt"), "New hint\n");
    expect(composeInjectBlob(ws)).toContain("New hint"); expect(composeInjectBlob(ws)).not.toContain("Old hint");
    expect(readFileSync(injectTxt(ws), "utf8")).toBe(previous);
  });

  it("expires stopped windows and refuses stale concurrent publications", () => {
    const ws = workspace(), first = new ObservationTurn(ws), stale = new ObservationTurn(ws);
    expect(first.submit(request(first)).ok).toBe(true);
    expect(stale.submit(request(stale, [assessment("other")])).errors?.[0]?.code).toBe("stale_revision");
    const stopped = new ObservationTurn(ws); stopped.close();
    expect(stopped.submit(request(stopped)).errors?.[0]?.code).toBe("expired_window");
    expect(new ObservationTurn(ws, () => false).submit({}).errors?.[0]?.code).toBe("expired_window");
  });

  it("does not republish an old DAG when the model exhausts output without submitting", async () => {
    const ws = workspace(), first = new ObservationTurn(ws); expect(first.submit(request(first)).ok).toBe(true);
    const revision = loadObservation(ws).revision, turn = new ObservationTurn(ws), close = vi.fn();
    const events = new EventSink(join(ws, "events.jsonl"), join(ws, "observer.log"));
    const controller = new AbortController();
    const backend: Backend = { name: "fake", close, run: async () => { controller.abort(); return { backend: "fake", ok: true, exitCode: 0, extra: { stop_reason: "max_tokens" } }; } };
    try {
      expect(await executeObservationTick(turn, backend, { workspace: ws, events, systemPrompt: "", userPrompt: "", permissionMode: "bypassPermissions", maxTurns: 20, model: null, signal: controller.signal })).toBe(false);
      expect(loadObservation(ws).revision).toBe(revision); expect(close).toHaveBeenCalledOnce();
      expect(readFileSync(join(ws, "observer.log"), "utf8")).toContain("max_tokens");
    } finally { events.close(); }
  });
});
