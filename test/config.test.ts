import { afterEach, describe, expect, it } from "vitest";
import { loadSettings } from "../src/agent/config.js";
import { resolveBackend } from "../src/agent/backends/index.js";

const KEYS = [
  "HEIMDALL_WORKSPACE",
  "HEIMDALL_AGENT_BACKEND",
  "HEIMDALL_PI_TRANSPORT",
  "HEIMDALL_LOOP",
  "ATTEMPT_N",
];

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

describe("agent settings", () => {
  it("defaults to pi + native sdk transport", () => {
    swap({
      HEIMDALL_WORKSPACE: "/tmp/ws",
      HEIMDALL_AGENT_BACKEND: null,
      HEIMDALL_PI_TRANSPORT: null,
      HEIMDALL_LOOP: null,
      ATTEMPT_N: null,
    });
    const s = loadSettings();
    expect(s.backend).toBe("pi");
    expect(s.piTransport).toBe("sdk");
    expect(s.workspace).toBe("/tmp/ws");
    const { name, backend } = resolveBackend(s);
    expect(name).toBe("pi");
    expect(backend.name).toBe("pi");
  });

  it("rpc transport is an explicit rollback", () => {
    swap({
      HEIMDALL_WORKSPACE: "/tmp/ws",
      HEIMDALL_AGENT_BACKEND: "pi",
      HEIMDALL_PI_TRANSPORT: "rpc",
      HEIMDALL_LOOP: null,
      ATTEMPT_N: "3",
    });
    const s = loadSettings();
    expect(s.piTransport).toBe("rpc");
    expect(s.attemptN).toBe(3);
    expect(resolveBackend(s).backend.constructor.name).toBe("PiRpcBackend");
  });

  it("selects Claude SDK backend for loop jobs", () => {
    swap({
      HEIMDALL_WORKSPACE: "/tmp/ws",
      HEIMDALL_AGENT_BACKEND: "sdk",
      HEIMDALL_PI_TRANSPORT: null,
      HEIMDALL_LOOP: "1",
      ATTEMPT_N: null,
    });
    const { name, backend } = resolveBackend(loadSettings());
    expect(name).toBe("sdk");
    expect(backend.name).toBe("sdk");
  });
});
