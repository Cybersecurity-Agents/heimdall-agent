import { EventEmitter } from "node:events";
import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Database } from "../src/shared/db.js";
import { loadConfig } from "../src/shared/config.js";
import { acquireObserverLease } from "../src/observer/lease.js";
import { recapDir, requestTerminalRecap, readRecapState, setRecapState } from "../src/observer/recap-state.js";
import { recoverObserverFinalizers, runObserverFinalizer } from "../src/control/observer-finalize.js";

vi.mock("node:sqlite", () => createRequire(import.meta.url)("node:sqlite"));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>() }));
const cleanups: (() => void)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) clean(); await Promise.resolve(); vi.restoreAllMocks(); });
function fixture(status = "succeeded") {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-finalizer-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "config.yaml"); writeFileSync(config, JSON.stringify({ paths: { data_dir: dir, tools_env: join(dir, "absent") } }));
  const cfg = loadConfig(config, process.cwd()); cfg.observe_enabled = true;
  const db = new Database(cfg.db_path); cleanups.push(() => db["db"].close());
  const ws = join(dir, "workspace"); mkdirSync(join(ws, ".heimdall"), { recursive: true });
  const id = db.createJob({ uniqueCode: "fixture", attemptN: 1, status, image: "fixture", workspacePath: ws, jobDir: join(dir, "job") });
  writeFileSync(join(ws, "input.json"), JSON.stringify({ job_id: id, unique_code: "fixture" }));
  const children: (EventEmitter & { unref: ReturnType<typeof vi.fn> })[] = [];
  const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() }); children.push(child);
    return child as unknown as childProcess.ChildProcess;
  });
  cleanups.push(() => children.forEach(child => child.emit("close", 0)));
  return { cfg, db, ws, id, children, spawn };
}

describe("independent recap recovery", () => {
  it("recovers a terminal job after a crash before its request was written, with no duplicate workers", async () => {
    const f = fixture();
    expect(existsSync(join(recapDir(f.ws), "request.json"))).toBe(false);
    recoverObserverFinalizers(f.cfg, f.db);
    recoverObserverFinalizers(f.cfg, f.db);
    await Promise.resolve();
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.children[0]!.unref).toHaveBeenCalledOnce();
    const options = f.spawn.mock.calls[0]![2] as childProcess.SpawnOptions;
    expect(options.detached).toBe(true);
    expect((options.stdio as unknown[])[1]).toEqual(expect.any(Number)); // Durable file, no parent-owned pipe.
    const request = requestTerminalRecap(f.ws, f.id, "succeeded")!;
    const first = runObserverFinalizer(f.cfg, f.ws, request);
    f.children[0]!.emit("close", 1);
    await first;
    expect(readRecapState(f.ws)?.status).toBe("failed");
    recoverObserverFinalizers(f.cfg, f.db); await Promise.resolve();
    expect(f.spawn).toHaveBeenCalledTimes(2);
    const second = runObserverFinalizer(f.cfg, f.ws, request);
    setRecapState(f.ws, request, "published");
    f.children[1]!.emit("close", 0); await second;
    recoverObserverFinalizers(f.cfg, f.db); await Promise.resolve();
    expect(f.spawn).toHaveBeenCalledTimes(2);
  });

  it("leaves a surviving writer alone after restart and resumes after lease release", async () => {
    const f = fixture(), request = requestTerminalRecap(f.ws, f.id, "succeeded")!;
    const lease = acquireObserverLease(f.ws)!; cleanups.push(() => lease.release());
    setRecapState(f.ws, request, "running");
    recoverObserverFinalizers(f.cfg, f.db); await Promise.resolve(); expect(f.spawn).not.toHaveBeenCalled();
    lease.release();
    recoverObserverFinalizers(f.cfg, f.db); await Promise.resolve(); expect(f.spawn).toHaveBeenCalledOnce();
  });

  it("never resumes an old job after its workspace has been reassigned", async () => {
    const f = fixture(), request = requestTerminalRecap(f.ws, f.id, "succeeded")!;
    writeFileSync(join(f.ws, "input.json"), JSON.stringify({ job_id: "replacement", unique_code: "fixture" }));
    recoverObserverFinalizers(f.cfg, f.db); await runObserverFinalizer(f.cfg, f.ws, request);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("does not invent a terminal recap for a timed-out attempt awaiting continuation", async () => {
    const f = fixture("timeout");
    vi.spyOn(f.db, "getGoal").mockReturnValue({ state: "retry_wait" } as never);
    recoverObserverFinalizers(f.cfg, f.db); await Promise.resolve();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(existsSync(join(recapDir(f.ws), "request.json"))).toBe(false);
  });
});
