import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { clearProxyEnv } from "../../shared/network-env.js";
import { executableOnPath } from "../../shared/runtime-capabilities.js";

export function embeddedVpnUnavailable(): string | null {
  if (!existsSync("/.dockerenv") && !existsSync("/run/.containerenv")) {
    return "Built-in VPN requires the Heimdall container. Host installations can use docker.vpn.mode: sidecar.";
  }
  if (!executableOnPath("openvpn")) return "OpenVPN is missing from the container image.";
  if (!existsSync("/dev/net/tun")) return "VPN requires /dev/net/tun. Recreate the container with the current Compose file.";
  try {
    const caps = readFileSync("/proc/self/status", "utf8").match(/^CapEff:\s*([0-9a-f]+)/im)?.[1];
    if (!caps || !(BigInt(`0x${caps}`) & (1n << 12n))) {
      return "VPN requires NET_ADMIN. Recreate the container with the current Compose file.";
    }
  } catch {
    return "Cannot verify VPN network permissions.";
  }
  return null;
}

/** Owns one foreground OpenVPN process in the solver's network namespace. */
export class EmbeddedVpn {
  private proc: ChildProcess | null = null;
  private connected = false;
  private lastError = "";
  private closing: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(private readonly options: {
    command?: string;
    capability?: () => string | null;
    stopTimeoutMs?: number;
  } = {}) {}

  snapshot(): { running: boolean; ready: boolean; error: string } {
    const running = !!this.proc && this.proc.exitCode === null && this.proc.signalCode === null;
    return { running, ready: running && this.connected, error: this.lastError };
  }

  async start(profile: string, logPath: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const unavailable = (this.options.capability || embeddedVpnUnavailable)();
    if (unavailable) throw new Error(unavailable);
    const body = readFileSync(profile, "utf8");
    // Daemonizing would escape process ownership and make stop/readiness unreliable.
    if (/^\s*(?:--)?daemon(?:\s|$)/im.test(body)) throw new Error("Remove the daemon directive from the VPN profile; Heimdall manages the process.");
    await this.stop();
    signal?.throwIfAborted();
    const generation = ++this.generation;
    this.lastError = "";
    this.connected = false;
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, "", { mode: 0o600 });
    const runDir = mkdtempSync(join(tmpdir(), "heimdall-vpn-"));
    const config = join(runDir, "client.ovpn");
    // Keep logs on inherited stdout: Node pipes are Unix sockets on Linux, so
    // OpenVPN cannot reopen /dev/stdout with --log (ENXIO). Ignore profile log sinks.
    const foregroundBody = body.replace(/^\s*(?:--)?(?:log|log-append|syslog)(?:[ \t]+[^\r\n]*)?$/gm, "");
    writeFileSync(config, foregroundBody, { mode: 0o600 });
    const env = { ...process.env };
    clearProxyEnv(env);
    const proc = spawn(this.options.command || "openvpn", [
      "--config", config, "--verb", "3", "--mute", "0",
      "--suppress-timestamps", "--auth-nocache",
      "--auth-retry", "none", "--script-security", "1",
    ], { cwd: dirname(profile), env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    let settleReady: () => void;
    let failReady: (error: Error) => void;
    let settled = false;
    const ready = new Promise<void>((resolve, reject) => {
      settleReady = () => { if (!settled) { settled = true; resolve(); } };
      failReady = (error) => { if (!settled) { settled = true; reject(error); } };
    });
    const streams = new Map<string, string>();
    const consume = (stream: string, chunk: Buffer) => {
      const text = chunk.toString("utf8");
      try { appendFileSync(logPath, text); } catch { /* process readiness remains observable */ }
      const lines = ((streams.get(stream) || "") + text).split(/\r?\n/);
      streams.set(stream, lines.pop()!.slice(-8192));
      if (generation !== this.generation) return;
      for (const line of lines) {
        if (/Initialization Sequence Completed/.test(line)) {
          this.connected = true;
          this.lastError = "";
          settleReady();
        } else if (/AUTH_FAILED|TLS Error|SIGUSR1|Restart pause|Inactivity timeout|Exiting due to fatal error|Options error|ERROR:/.test(line)) {
          this.connected = false;
          this.lastError = line.slice(0, 500);
        }
      }
    };
    proc.stdout?.on("data", (chunk: Buffer) => consume("stdout", chunk));
    proc.stderr?.on("data", (chunk: Buffer) => consume("stderr", chunk));
    proc.on("error", (error) => {
      if (generation === this.generation) this.lastError = error.message;
      failReady(error);
    });
    this.closing = new Promise<void>((resolve) => proc.once("close", (code, signal) => {
      rmSync(runDir, { recursive: true, force: true });
      if (this.proc === proc) {
        this.proc = null;
        this.connected = false;
        if (generation === this.generation && !this.lastError) this.lastError = `OpenVPN exited (${signal || code}).`;
      }
      failReady(new Error(this.lastError || "VPN connection cancelled."));
      resolve();
    }));
    const timer = setTimeout(() => failReady(new Error(this.lastError || "VPN handshake timed out.")), timeoutMs);
    const abort = () => { void this.stop(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await ready;
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async stop(): Promise<void> {
    ++this.generation;
    this.connected = false;
    this.lastError = "";
    const proc = this.proc;
    if (!proc) return;
    const closing = this.closing;
    const signal = (value: NodeJS.Signals) => {
      if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;
      try { process.kill(-proc.pid, value); } catch { proc.kill(value); }
    };
    signal("SIGTERM");
    const timer = setTimeout(() => signal("SIGKILL"), this.options.stopTimeoutMs ?? 8000);
    try { await closing; } finally { clearTimeout(timer); }
  }
}
