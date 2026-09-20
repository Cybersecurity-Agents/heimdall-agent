import { existsSync, readFileSync, chmodSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "../../shared/config.js";
import { clearProxyEnv } from "../../shared/network-env.js";
import { EmbeddedVpn, embeddedVpnUnavailable } from "./vpn-process.js";

const embedded = new EmbeddedVpn();
let operation: Promise<void> | null = null;
let controller: AbortController | null = null;

export function vpnMode(cfg: Config): "embedded" | "sidecar" | "off" {
  if (!cfg.vpn_enabled || cfg.vpn_mode === "off") return "off";
  if (cfg.vpn_mode === "auto") return cfg.agent_runtime === "local" ? "embedded" : "sidecar";
  return cfg.vpn_mode === "embedded" ? "embedded" : "sidecar";
}

function wantedPath(cfg: Config): string { return join(cfg.data_dir, "vpn", "connection.json"); }
export function wantsEmbeddedVpn(cfg: Config): boolean {
  return vpnMode(cfg) === "embedded" && existsSync(wantedPath(cfg));
}

const execFileAsync = promisify(execFile);
const MAX_OVPN_BYTES = 64_000;
const DEFAULT_NAME = "heimdall-tsec-vpn";
const DEFAULT_IMAGE = "ghcr.io/qiantangcredit/heimdall:vpn-latest";

let connecting = false;
let connectError = "";
let stopping: Promise<void> | null = null;
let shuttingDown = false;

export function destPath(cfg: Config): string {
  const raw = cfg.vpn_config;
  const root = cfg.repo_root;
  if (raw) return isAbsolute(raw) ? raw : join(root, raw);
  if (vpnMode(cfg) === "embedded") return join(cfg.data_dir, "vpn", "client.ovpn");
  const tsec = join(root, "tsecbench");
  if (existsSync(tsec)) {
    try {
      const found = readdirSync(tsec).filter((n) => n.endsWith(".ovpn")).sort();
      if (found[0]) return join(tsec, found[0]);
    } catch {
      /* fall through */
    }
  }
  return join(root, "tsecbench", "client.ovpn");
}

export function parseRemote(text: string): string {
  const m = (text || "").match(/^[ \t]*remote[ \t]+(\S+)(?:[ \t]+(\d+))?/m);
  if (!m) return "";
  return m[2] ? `${m[1]}:${m[2]}` : String(m[1]);
}

export function saveOvpn(cfg: Config, text: string): string {
  const body = `${(text || "").replace(/\r\n/g, "\n").trim()}\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_OVPN_BYTES) throw new Error("ovpn too large");
  if (!/^[ \t]*client[ \t]*$/m.test(body)) throw new Error("not an OpenVPN client profile");
  if (!/^[ \t]*remote[ \t]+\S+/m.test(body)) throw new Error("ovpn missing remote");
  if (!body.includes("<ca>") && !/^[ \t]*ca[ \t]+/m.test(body)) throw new Error("ovpn missing CA");
  const path = destPath(cfg);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
  return path;
}

function dockerInspect(name: string): { running: boolean; ready: boolean; status?: string; error?: string } {
  try {
    const raw = execFileSync("docker", ["inspect", name, "--format", "{{json .}}"], {
      encoding: "utf8",
      timeout: 8000,
    });
    const doc = JSON.parse(raw) as Record<string, unknown>;
    const state = (doc.State || {}) as Record<string, unknown>;
    const running = String(state.Status || "") === "running" || Boolean(state.Running);
    return { running, ready: running, status: String(state.Status || "") };
  } catch (e) {
    return { running: false, ready: false, error: String(e) };
  }
}

export function snapshot(cfg: Config): Record<string, unknown> {
  const path = destPath(cfg);
  let text = "";
  if (existsSync(path)) {
    try {
      text = readFileSync(path, "utf8");
    } catch {
      text = "";
    }
  }
  const out: Record<string, unknown> = {
    ok: true,
    enabled: vpnMode(cfg) !== "off",
    mode: vpnMode(cfg),
    ovpn_set: Boolean(text.trim()),
    ovpn_name: text.trim() ? path.split(/[/\\]/).pop() : "",
    remote: parseRemote(text),
    running: false,
    ready: false,
    connecting,
    error: connectError,
  };
  if (!out.enabled) {
    out.error = connectError || "config.yaml 里 docker.vpn.enabled 是关的";
    return out;
  }
  if (vpnMode(cfg) === "embedded") {
    const state = embedded.snapshot();
    const unavailable = embeddedVpnUnavailable();
    return { ...out, ...state, error: connectError || state.error,
      available: !unavailable, capability_error: unavailable || "" };
  }
  const st = dockerInspect(cfg.vpn_container_name || DEFAULT_NAME);
  out.running = st.running;
  out.ready = Boolean(st.running && vpnReady(cfg.vpn_container_name || DEFAULT_NAME));
  if (st.error && !out.error) out.error = st.error;
  return out;
}

function vpnReady(name: string): boolean {
  try {
    const out = execFileSync("docker", ["exec", name, "sh", "-c", "ip -br a"], {
      encoding: "utf8",
      timeout: 5000,
    });
    return /\btun/.test(out);
  } catch {
    return false;
  }
}

async function connect(cfg: Config, restart: boolean, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (vpnMode(cfg) === "off") throw new Error("VPN disabled (docker.vpn.enabled=false)");
  if (vpnMode(cfg) === "embedded") {
    if (cfg.agent_runtime !== "local") throw new Error("Built-in VPN requires workspace execution. Use sidecar mode for Docker executors.");
    if (!restart && embedded.snapshot().ready) return;
    await embedded.start(destPath(cfg), join(cfg.data_dir, "logs", "openvpn.log"), cfg.vpn_ready_timeout_sec * 1000, signal);
    return;
  }
  const name = cfg.vpn_container_name || DEFAULT_NAME;
  const image = cfg.vpn_image || DEFAULT_IMAGE;
  const ovpn = destPath(cfg);
  if (!existsSync(ovpn)) throw new Error(`vpn config not found: ${ovpn}`);
  const st = dockerInspect(name);
  if (!restart && st.running && vpnReady(name)) return;
  try {
    await execFileAsync("docker", ["image", "inspect", image], { timeout: 10000, signal });
  } catch {
    signal.throwIfAborted();
    await execFileAsync("docker", ["pull", image], { timeout: 300000, signal });
  }
  signal.throwIfAborted();
  try {
    await execFileAsync("docker", ["rm", "-f", name], { timeout: 20000, signal });
  } catch {
    /* ignore */
  }
  signal.throwIfAborted();
  const logPath = join(cfg.data_dir, "logs", "tsec-vpn.log");
  mkdirSync(join(cfg.data_dir, "logs"), { recursive: true });
  try {
    writeFileSync(logPath, "", { flag: "a" });
  } catch {
    /* ignore */
  }
  const args = [
    "run",
    "-d",
    "--name",
    name,
    "--restart",
    "unless-stopped",
    "--network",
    "host",
    "--cap-add=NET_ADMIN",
    "--device=/dev/net/tun",
    "--add-host",
    "host.docker.internal:host-gateway",
    "-e",
    "HEIMDALL_VPN_CONFIG=/vpn/client.ovpn",
    "-v",
    `${ovpn}:/vpn/client.ovpn:ro`,
    "-v",
    `${logPath}:/var/log/openvpn-client.log`,
  ];
  const directEnv: Record<string, string> = {};
  clearProxyEnv(directEnv);
  for (const [key, value] of Object.entries(directEnv)) args.push("-e", `${key}=${value}`);
  if (cfg.vpn_privileged) args.push("--privileged");
  args.push(image);
  await execFileAsync("docker", args, { timeout: 30000, signal });
  for (let i = 0; i < 30; i++) {
    signal.throwIfAborted();
    if (vpnReady(name)) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("vpn sidecar started but tun is not up (OpenVPN handshake)");
}

export function connectAsync(cfg: Config, restart = false): void {
  if (operation || stopping || shuttingDown) throw new Error("VPN is busy. Wait for the current connection or disconnect first.");
  const request = new AbortController();
  if (vpnMode(cfg) === "embedded") {
    mkdirSync(join(cfg.data_dir, "vpn"), { recursive: true });
    writeFileSync(wantedPath(cfg), JSON.stringify({ connect: true }) + "\n", { mode: 0o600 });
  }
  controller = request;
  connecting = true;
  connectError = "";
  operation = connect(cfg, restart, request.signal)
    .catch((e) => { if (!request.signal.aborted) connectError = String(e instanceof Error ? e.message : e); })
    .finally(() => {
      connecting = false;
      operation = null;
      controller = null;
    });
}

export function isConnecting(): boolean { return operation !== null || stopping !== null || shuttingDown; }

export async function disconnect(cfg: Config): Promise<void> {
  if (stopping) return stopping;
  rmSync(wantedPath(cfg), { force: true });
  stopping = (async () => {
    controller?.abort();
    await embedded.stop();
    await operation;
    if (vpnMode(cfg) === "sidecar") {
      const name = cfg.vpn_container_name || DEFAULT_NAME;
      if (dockerInspect(name).running) await execFileAsync("docker", ["stop", "-t", "8", name], { timeout: 20000 });
    }
    connectError = "";
    connecting = false;
  })().finally(() => { stopping = null; });
  return stopping;
}

/** Container shutdown cleans up routes but retains the user's reconnect preference. */
export async function shutdownVpn(): Promise<void> {
  shuttingDown = true;
  await stopping;
  controller?.abort();
  await embedded.stop();
  await operation;
}

export function resumeVpn(cfg: Config): void {
  try {
    if (wantsEmbeddedVpn(cfg) && existsSync(destPath(cfg))) connectAsync(cfg);
  } catch (error) { connectError = String(error); }
}

export async function ensureVpnReady(cfg: Config): Promise<boolean> {
  if (vpnMode(cfg) === "off") return true;
  if (stopping || shuttingDown) return false;
  if (operation) await operation;
  // Only the console owns embedded OpenVPN. A task/CLI must never spawn a
  // second client or undo a failed/cancelled connection implicitly.
  if (vpnMode(cfg) === "embedded") return wantsEmbeddedVpn(cfg) && embedded.snapshot().ready;
  if (vpnMode(cfg) === "sidecar" && dockerInspect(cfg.vpn_container_name || DEFAULT_NAME).running && vpnReady(cfg.vpn_container_name || DEFAULT_NAME)) return true;
  connectAsync(cfg);
  await operation;
  return Boolean(snapshot(cfg).ready);
}
