import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbeddedVpn } from "../src/control/console/vpn-process.js";
import { vpnMode } from "../src/control/console/vpn.js";
import type { Config } from "../src/shared/config.js";

const dirs: string[] = [];
const clients: EmbeddedVpn[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(v => v.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(code: string, body = "client\n") {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-vpn-test-")); dirs.push(dir);
  const command = join(dir, "fake-openvpn");
  writeFileSync(command, `#!${process.execPath}\n${code}\n`, { mode: 0o755 });
  const profile = join(dir, "client.ovpn"), log = join(dir, "vpn.log");
  writeFileSync(profile, body);
  const vpn = new EmbeddedVpn({ command, capability: () => null, stopTimeoutMs: 100 }); clients.push(vpn);
  return { vpn, profile, log };
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("embedded OpenVPN lifecycle", () => {
  it("waits for this process's complete handshake line and tracks reconnects", async () => {
    const { vpn, profile, log } = fixture(`
      console.log('tun0 created');
      process.stdout.write('Initialization Sequence ');
      setTimeout(() => console.log('Completed'), 180);
      setTimeout(() => console.log('SIGUSR1[soft,ping-restart] received'), 450);
      setTimeout(() => console.log('Initialization Sequence Completed'), 750);
      setInterval(() => {}, 1000);
    `);
    writeFileSync(log, "Initialization Sequence Completed\n");
    const ready = vpn.start(profile, log, 2000);
    await wait(80);
    expect(vpn.snapshot().ready).toBe(false);
    await ready;
    expect(vpn.snapshot().ready).toBe(true);
    await expect.poll(() => vpn.snapshot().ready).toBe(false);
    await expect.poll(() => vpn.snapshot().ready).toBe(true);
    await vpn.stop();
    expect(vpn.snapshot()).toEqual({ running: false, ready: false, error: "" });
  });

  it("times out and kills an unresponsive process without accepting stale logs", async () => {
    const { vpn, profile, log } = fixture(`process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
    writeFileSync(log, "Initialization Sequence Completed\n");
    await expect(vpn.start(profile, log, 200)).rejects.toThrow("timed out");
    expect(vpn.snapshot().running).toBe(false);
  });

  it("cancels a pending connection and allows the next connection", async () => {
    const { vpn, profile, log } = fixture(`setTimeout(() => console.log('Initialization Sequence Completed'), 300); setInterval(() => {}, 1000);`);
    const abort = new AbortController();
    const pending = expect(vpn.start(profile, log, 2000, abort.signal)).rejects.toThrow();
    await wait(80); abort.abort(); await pending;
    expect(vpn.snapshot().running).toBe(false);
    await vpn.start(profile, log, 2000);
    expect(vpn.snapshot().ready).toBe(true);
  });

  it("replaces the old process and reads an immutable profile snapshot", async () => {
    const { vpn, profile, log } = fixture(`
      const fs = require('node:fs');
      setTimeout(() => { console.log(fs.readFileSync(process.argv[3], 'utf8').trim()); console.log('Initialization Sequence Completed'); }, 120);
      setInterval(() => {}, 1000);
    `, "client\nfirst-profile\nlog /tmp/ignored\nlog-append /tmp/ignored\nsyslog\n");
    const ready = vpn.start(profile, log, 2000);
    await wait(50); writeFileSync(profile, "client\nsecond-profile\n");
    await ready;
    expect(readFileSync(log, "utf8")).toContain("first-profile");
    expect(readFileSync(log, "utf8")).not.toContain("/tmp/ignored");
    expect(readFileSync(log, "utf8")).not.toContain("syslog");
    expect(readFileSync(log, "utf8")).not.toContain("second-profile");
    await vpn.start(profile, log, 2000);
    expect(readFileSync(log, "utf8")).toContain("second-profile");
    expect(readFileSync(log, "utf8")).not.toContain("first-profile");
  });

  it("reports authentication failure and cleans up on exit", async () => {
    const { vpn, profile, log } = fixture(`console.log('AUTH_FAILED'); process.exitCode = 1;`);
    await expect(vpn.start(profile, log, 2000)).rejects.toThrow("AUTH_FAILED");
    expect(vpn.snapshot().running).toBe(false);
  });

  it("rejects profiles that escape foreground ownership", async () => {
    const { vpn, profile, log } = fixture("", "client\ndaemon\n");
    await expect(vpn.start(profile, log, 2000)).rejects.toThrow("daemon");
    expect(vpn.snapshot().running).toBe(false);
  });

  it("reports missing executables without leaving a running process", async () => {
    const { profile, log } = fixture("");
    const vpn = new EmbeddedVpn({ command: "/does-not-exist/openvpn", capability: () => null }); clients.push(vpn);
    await expect(vpn.start(profile, log, 2000)).rejects.toThrow("ENOENT");
    expect(vpn.snapshot().running).toBe(false);
  });

  it("resolves auto mode by runtime and preserves explicit off", () => {
    const cfg = { vpn_enabled: true, vpn_mode: "auto", agent_runtime: "local" } as Config;
    expect(vpnMode(cfg)).toBe("embedded");
    expect(vpnMode({ ...cfg, agent_runtime: "docker" })).toBe("sidecar");
    expect(vpnMode({ ...cfg, vpn_enabled: false })).toBe("off");
    expect(vpnMode({ ...cfg, vpn_mode: "off" })).toBe("off");
  });
});
