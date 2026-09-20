import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runRecap } from "../src/observer/recap.js";
import { recordAcceptedSubmit, requestTerminalRecap, readRecapState, recapDir, writeRecord } from "../src/observer/recap-state.js";
import { trafficDir, graphJson } from "../src/shared/paths.js";
import { EventSink } from "../src/shared/events.js";
import type { Backend } from "../src/agent/backends/types.js";
import * as publisher from "../src/observer/publish.js";

vi.mock("../src/observer/publish.js", async original => ({ ...await original<typeof import("../src/observer/publish.js")>() }));
const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const ok = { backend: "fake", ok: true, exitCode: 0 };
function fixture() {
  const ws = mkdtempSync(join(tmpdir(), "heimdall-recap-")); dirs.push(ws);
  const dir = trafficDir(ws);
  writeFileSync(join(ws, "input.json"), JSON.stringify({ job_id: "job-1", unique_code: "fixture", description: "Authorized fixture", flag_count: 1 }));
  writeFileSync(join(dir, "turns.jsonl"), JSON.stringify({ n: 1, jobId: "job-1", detail: "The tool recovered the requested data", sources: [] }) + "\n");
  const receipt = recordAcceptedSubmit(ws, "fixture", "flag{fixture}", { correct: true, matched_flag_index: 0, correct_flag_count: 1, total_flag_count: 1, duplicate: false } as never)!;
  const request = requestTerminalRecap(ws, "job-1", "succeeded")!;
  const events = new EventSink(join(ws, "recap-events.jsonl"));
  const node = (id: string, kind: string, refs: string[]) => ({ id, kind, label: id,
    summary: { conclusion: "Observed fixture result", basis: "Recorded evidence", uncertainty: null }, evidenceRefs: refs, steps: [] });
  const dag = { schemaVersion: 2, nodes: [node("start", "start", ["input:task"]), node("recon", "recon", ["input:task"]),
    { ...node("verified", "direction", ["turn:1"]), coverage: "tried-hit", steps: [{ id: "attempt-1", action: "Read fixture data", result: "Requested data was returned", assessment: null, evidenceRefs: ["turn:1"] }] },
    node("accepted", "flag", [`receipt:${receipt.id}`])], edges: [{ from: "start", to: "recon" }, { from: "recon", to: "verified" }, { from: "verified", to: "accepted" }] };
  const draft = () => writeFileSync(join(dir, "recap_dag.json"), JSON.stringify(dag));
  const report = () => writeFileSync(join(dir, "recap.md"), "Verified fixture path; platform accepted 1/1. Evidence: turn:1.");
  const run = (backend: Backend, owns?: () => boolean) => runRecap(ws, request, backend, events, owns);
  return { ws, dir, request, draft, report, run, dag };
}

describe("durable final recap", () => {
  it("preserves the draft and corrects more than three rejected results before publishing", async () => {
    const f = fixture(); let calls = 0;
    const close = vi.fn();
    const backend: Backend = { name: "fake", close, run: async opts => {
      expect(opts.maxTurns).toBe(0);
      if (++calls === 1) f.draft();
      else expect(JSON.parse(readFileSync(join(f.dir, "recap_dag.json"), "utf8"))).toEqual(f.dag);
      if (calls < 6) { expect(readRecapState(f.ws)?.status).toBe("running"); expect(existsSync(graphJson(f.ws))).toBe(false); }
      else { expect(opts.userPrompt).toContain("recap.md missing or empty"); f.report(); }
      return ok;
    } };
    expect(await f.run(backend)).toBe(true);
    expect(calls).toBe(6); expect(close).toHaveBeenCalledOnce();
    expect(readRecapState(f.ws)).toMatchObject({ status: "published", attempts: 6 });
    expect(JSON.parse(readFileSync(graphJson(f.ws), "utf8")).publication.phase).toBe("final");
  });

  it("retries a timed-out call with the existing draft instead of ending the recap", async () => {
    vi.useFakeTimers(); vi.stubEnv("HEIMDALL_OBSERVER_FINALIZE_SEC", "5");
    const f = fixture(); let calls = 0;
    const work = f.run({ name: "fake", run: async opts => {
      if (++calls === 1) {
        f.draft();
        await new Promise<void>(resolve => opts.signal!.addEventListener("abort", () => resolve(), { once: true }));
      } else {
        expect(existsSync(join(f.dir, "recap_dag.json"))).toBe(true); f.report();
      }
      return ok;
    } });
    await vi.advanceTimersByTimeAsync(6100);
    expect(await work).toBe(true); expect(calls).toBe(2);
    expect(readRecapState(f.ws)?.status).toBe("published");
  });

  it("resumes a persisted partial window after loss of the worker lease", async () => {
    vi.useFakeTimers(); const f = fixture(); let owns = true;
    const work = f.run({ name: "old-worker", run: async opts => {
      f.draft(); owns = false;
      await new Promise<void>(resolve => opts.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return ok;
    } }, () => owns);
    await vi.advanceTimersByTimeAsync(300);
    expect(await work).toBe(false);
    const restored = { name: "new-worker", run: vi.fn(async () => { expect(existsSync(join(f.dir, "recap_dag.json"))).toBe(true); f.report(); return ok; }) };
    expect(await f.run(restored)).toBe(true);
    expect(restored.run).toHaveBeenCalledOnce();
  });

  it("retries storage publication without regenerating valid artifacts", async () => {
    vi.useFakeTimers(); const f = fixture();
    const publish = publisher.publishObserverGraph;
    const spy = vi.spyOn(publisher, "publishObserverGraph").mockImplementationOnce(() => { throw new Error("transient disk failure"); }).mockImplementation(publish);
    const backend = { name: "fake", run: vi.fn(async () => { f.draft(); f.report(); return ok; }) };
    const work = f.run(backend);
    await vi.advanceTimersByTimeAsync(1100);
    expect(await work).toBe(true); expect(spy).toHaveBeenCalledTimes(2); expect(backend.run).toHaveBeenCalledOnce();
  });

  it("does not publish an empty or unevidenced success graph", async () => {
    const f = fixture(); let calls = 0;
    expect(await f.run({ name: "fake", run: async opts => {
      if (++calls === 1) {
        f.report(); writeFileSync(join(f.dir, "recap_dag.json"), JSON.stringify({ ...f.dag, nodes: f.dag.nodes.slice(0, 2), edges: [f.dag.edges[0]] }));
      } else {
        expect(opts.userPrompt).toContain("missing from graph"); expect(existsSync(graphJson(f.ws))).toBe(false); f.draft();
      }
      return ok;
    } })).toBe(true);
    expect(calls).toBe(2);
  });

  it("interrupts a stale request without overwriting its replacement", async () => {
    vi.useFakeTimers(); const f = fixture();
    const replacement = { ...f.request, id: "replacement" };
    const work = f.run({ name: "fake", run: async opts => {
      writeRecord(join(recapDir(f.ws), "request.json"), replacement);
      writeRecord(join(recapDir(f.ws), "state.json"), { requestId: replacement.id, status: "pending" });
      await new Promise<void>(resolve => opts.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return ok;
    } });
    await vi.advanceTimersByTimeAsync(300);
    expect(await work).toBe(false);
    expect(readRecapState(f.ws)).toMatchObject({ requestId: replacement.id, status: "pending" });
    expect(existsSync(graphJson(f.ws))).toBe(false);
  });
});
