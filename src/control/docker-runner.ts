import { snapshotCapabilities } from "./capability-catalog.js";
import { runtimeLayout } from "../shared/resources.js";
import { clearProxyEnv } from "../shared/network-env.js";
import { snapshotConsolePrompts } from "./prompt-snapshot.js";
import {
  existsSync,
  mkdirSync,
  cpSync,
  chmodSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { observerCadenceSec, observerWarmupCfgSec, type Config } from "../shared/config.js";
import { ensureVpnReady, vpnMode } from "./console/vpn.js";
import { applyLoopLlmEnv, claudeAutocompactEnv, syncLlmEnv } from "../shared/pi-workspace.js";
import { seedJobSteer } from "../observer/job-steer.js";
import type { RunResult, RunSpec } from "./runner.js";

const LIVE_CID = new Map<string, string>();
const STOPPING = new Set<string>();
const LIVE_CODE = new Map<string, Set<string>>();


function sh(cmd: string, args: string[], opts: { timeout?: number } = {}): string {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: opts.timeout ?? 20000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const extra = err.stderr ? String(err.stderr) : "";
    throw new Error(`${cmd} ${args.join(" ")}: ${err.message || e}${extra ? ` ${extra}` : ""}`);
  }
}

function dockerOk(): boolean {
  try {
    sh("docker", ["info"], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

/** Each job gets a complete, immutable runtime snapshot; no shared stale overlay. */
export function refreshStaging(cfg: Config, spec: Pick<RunSpec, "jobDir">): string {
  const dest = join(spec.jobDir, "runtime");
  const layout = runtimeLayout(cfg.repo_root);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const name of layout.directories) {
    cpSync(join(cfg.repo_root, name), join(dest, name), { recursive: true, force: true, dereference: false });
  }
  const wl = join(dest, "resources/wordlists");
  for (const name of readdirSync(wl)) {
    if (!layout.defaultWordlists.includes(name)) rmSync(join(wl, name), { recursive: true, force: true });
  }
  for (const name of layout.defaultWordlists) {
    if (!existsSync(join(wl, name))) throw new Error(`Missing runtime dictionary: ${name}`);
  }
  for (const [from, to] of Object.entries(layout.compatibility)) {
    const target = join(dest, to);
    if (!existsSync(target)) throw new Error(`Missing runtime compatibility target: ${to}`);
    const path = join(dest, from);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(relative(dirname(path), target), path);
  }
  return dest;
}

function dockerEnv(cfg: Config, spec: RunSpec): Record<string, string> {
  const env: Record<string, string> = {
    UNIQUE_CODE: spec.uniqueCode,
    HEIMDALL_JOB_ID: spec.jobId,
    ATTEMPT_N: String(spec.attemptN),
    CONTAINER_ADDR: spec.containerAddr.join(","),
    BENCHMARK_BASE_URL: cfg.base_url,
    BENCHMARK_TOKEN: cfg.token,
    HEIMDALL_WORKSPACE: "/workspace",
    HEIMDALL_REPO_ROOT: "/opt/heimdall",
    HEIMDALL_CHALLENGE_TYPE: spec.challengeType || "all",
    HEIMDALL_AGENT_BACKEND: spec.loop ? cfg.loop_backend : cfg.agent_backend,
    HEIMDALL_PERMISSION_MODE: cfg.agent_permission_mode,
    HEIMDALL_MAX_TURNS: String(cfg.agent_max_turns),
    HEIMDALL_LOOP: spec.loop ? "1" : "0",
    HEIMDALL_LOOP_TIMEOUT_SEC: String(spec.timeoutSec),
    CLAUDE_CONFIG_DIR: "/workspace/.heimdall/claude",
    PI_CODING_AGENT_DIR: "/workspace/.heimdall/pi",
    PI_OFFLINE: "1",
    PYTHONPATH: "/opt/heimdall",
    HOME: "/root",
    USER: "root",
    LOGNAME: "root",
    IS_SANDBOX: "1",
    GHIDRA_INSTALL_DIR: "/opt/heimdall/ghidra",
    GHIDRA_HOME: "/opt/heimdall/ghidra",
    JAVA_TOOL_OPTIONS: "-Duser.home=/root",
    PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
    PWTEST_CLI_GLOBAL_CONFIG: "/opt/heimdall",
    HEIMDALL_OBSERVER_WARMUP_SEC: String(observerWarmupCfgSec(cfg, spec.loop)),
    HEIMDALL_OBSERVER_EVERY_SEC: String(observerCadenceSec(cfg, spec.loop)),
    ...claudeAutocompactEnv(),
    PATH: "/opt/heimdall/proxy:/opt/heimdall/bin:/opt/heimdall/node_modules/.bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
  if (spec.description) env.CHALLENGE_DESCRIPTION = spec.description.slice(0, 4000);
  if (spec.loop) env.HEIMDALL_AGENT_BACKEND = cfg.loop_backend;
  cfg.tools_env.mergeInto(env, { overwrite: true });
  env.HEIMDALL_OBSERVER_WARMUP_SEC = String(observerWarmupCfgSec(cfg, Boolean(spec.loop)));
  env.HEIMDALL_OBSERVER_EVERY_SEC = String(observerCadenceSec(cfg, Boolean(spec.loop)));
  Object.assign(env, spec.extraEnv || {});
  env.HEIMDALL_CAPTURE_LOG = "1";
  clearProxyEnv(env);
  if (!cfg.observe_enabled) {
    env.HEIMDALL_COACH = "0";
    env.HEIMDALL_DISABLE_HTTP_TAP = "1";
    env.HEIMDALL_DISABLE_LLM_TAP = "1";
  }
  snapshotCapabilities(cfg, spec.workspace, env);
  applyLoopLlmEnv(env);
  syncLlmEnv(env);
  return env;
}

function vpnNetworkMode(cfg: Config): string {
  try {
    return sh("docker", ["inspect", "-f", "{{.HostConfig.NetworkMode}}", vpnName(cfg)]).trim();
  } catch {
    return "";
  }
}

function rewriteDockerInternal(env: Record<string, string>, host: string): void {
  for (const [k, v] of Object.entries(env)) {
    if (v.includes("host.docker.internal")) env[k] = v.split("host.docker.internal").join(host);
  }
}

export function volumeArgs(cfg: Config, spec: RunSpec): string[] {
  // --mount fails if the daemon cannot see the source. -v silently creates an
  // empty directory, which hid incorrect host/DinD path mappings.
  const args: string[] = ["--mount", `type=bind,src=${spec.workspace},dst=/workspace`];
  if (cfg.docker_runtime_mounts !== "source") return args;
  const staging = refreshStaging(cfg, spec);
  for (const name of ["bin", "scripts", "resources", "tools", "entrypoints", "workspaces", "deploy/install", "deploy/vpn"]) {
    args.push("-v", `${join(staging, name)}:/opt/heimdall/${name}:ro`);
  }
  const distDir = join(cfg.repo_root, "dist");
  if (existsSync(distDir)) args.push("-v", `${distDir}:/opt/heimdall/dist:ro`);
  // Bind-mounted dist resolves ESM imports from /opt/heimdall/node_modules.
  // Overlay the host tree so @anthropic-ai/claude-agent-sdk matches that dist.
  const nmDir = join(cfg.repo_root, "node_modules");
  if (existsSync(nmDir)) args.push("-v", `${nmDir}:/opt/heimdall/node_modules:ro`);
  return args;
}

function vpnName(cfg: Config): string {
  return cfg.vpn_container_name || "heimdall-tsec-vpn";
}

function vpnRunning(cfg: Config): boolean {
  try {
    const st = sh("docker", ["inspect", "-f", "{{.State.Running}}", vpnName(cfg)]);
    return st.trim() === "true";
  } catch {
    return false;
  }
}

function trackCid(jobId: string, code: string, cid: string): void {
  LIVE_CID.set(jobId, cid);
  const set = LIVE_CODE.get(code) || new Set<string>();
  set.add(jobId);
  LIVE_CODE.set(code, set);
}

function untrack(jobId: string, code: string): void {
  LIVE_CID.delete(jobId);
  const left = LIVE_CODE.get(code);
  if (left) {
    left.delete(jobId);
    if (!left.size) LIVE_CODE.delete(code);
  }
}

export function stopDockerJob(opts: { jobId?: string; uniqueCode?: string; containerId?: string | null }): number {
  const ids = new Set<string>();
  if (opts.jobId && LIVE_CID.has(opts.jobId)) ids.add(LIVE_CID.get(opts.jobId)!);
  if (opts.uniqueCode) {
    for (const jid of LIVE_CODE.get(opts.uniqueCode) || []) {
      const cid = LIVE_CID.get(jid);
      if (cid) ids.add(cid);
    }
  }
  const extra = String(opts.containerId || "").trim();
  if (extra && !extra.startsWith("local-") && !extra.startsWith("host-")) ids.add(extra);
  let n = 0;
  for (const cid of ids) {
    try {
      if (STOPPING.has(cid)) continue;
      STOPPING.add(cid);
      const stop = spawn("docker", ["stop", "-t", "8", cid], { stdio: "ignore", timeout: 20000 });
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        const state = inspectExit(cid);
        if (state.running !== false) {
          try {
            const kill = spawn("docker", ["kill", cid], { stdio: "ignore", timeout: 10000 });
            kill.once("error", () => STOPPING.delete(cid));
            kill.once("close", () => STOPPING.delete(cid));
          } catch { STOPPING.delete(cid); }
        } else STOPPING.delete(cid);
      };
      stop.once("error", finish);
      stop.once("close", finish);
      n += 1;
    } catch {
      STOPPING.delete(cid);
    }
  }
  return n;
}

export function inspectExit(cid: string): { running: boolean | null; exit: number | null } {
  try {
    const raw = sh("docker", ["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", cid]);
    const [running, code] = raw.split(/\s+/);
    return { running: running === "true" ? true : running === "false" ? false : null, exit: code != null ? Number.parseInt(code, 10) : null };
  } catch (error) {
    return { running: /No such (object|container)/i.test(String(error)) ? false : null, exit: null };
  }
}

export const dockerJobName = (code: string, jobId: string): string => `heimdall-${code.slice(0, 40)}-${jobId}`.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 63);

export async function runDocker(cfg: Config, spec: RunSpec): Promise<RunResult> {
  if (spec.isCancelled?.()) throw new Error("startup_cancelled");
  snapshotConsolePrompts(cfg, spec.workspace);
  mkdirSync(spec.jobDir, { recursive: true });
  mkdirSync(join(spec.workspace, ".heimdall", "claude"), { recursive: true });
  mkdirSync(join(spec.workspace, ".heimdall", "pi"), { recursive: true });
  seedJobSteer(spec.workspace, { jobId: spec.jobId, challengeType: spec.challengeType });
  const logPath = join(spec.jobDir, "run.log");
  writeFileSync(logPath, `=== docker ${spec.uniqueCode} job=${spec.jobId} ===\n`, { flag: "a" });
  if (!dockerOk()) {
    return { containerId: "", exitCode: 2, timedOut: false, logPath, error: "docker engine not reachable" };
  }
  const name = dockerJobName(spec.uniqueCode, spec.jobId);
  try {
    sh("docker", ["rm", "-f", name], { timeout: 15000 });
  } catch {
    /* ignore */
  }
  const env = dockerEnv(cfg, spec);
  if (vpnMode(cfg) === "embedded") {
    return { containerId: "", exitCode: 2, timedOut: false, logPath, error: "Built-in VPN requires workspace execution. Use sidecar mode for Docker executors." };
  }
  const wantVpn = vpnMode(cfg) === "sidecar";
  if (wantVpn) {
    const ready = await ensureVpnReady(cfg);
    if (!ready || !vpnRunning(cfg)) {
      appendFileSync(logPath, "vpn sidecar not ready; refuse to start without lab net\n");
      return { containerId: "", exitCode: 2, timedOut: false, logPath, error: "vpn sidecar not ready" };
    }
    ensureVpnHostGateway(cfg);
  }
  const joinVpn = wantVpn && vpnRunning(cfg);
  if (joinVpn) {
    // container:vpn cannot set extra_hosts. Pin LLM URLs at the gateway
    // the netns can actually reach.
    rewriteDockerInternal(env, vpnNetworkMode(cfg) === "host" ? "127.0.0.1" : "172.17.0.1");
  }
  const args = [
    "run",
    "-d",
    "--name",
    name,
    "--entrypoint",
    "bash",
    "-w",
    "/workspace",
    "--user",
    "0:0",
    "--init",
    "--shm-size",
    "1g",
    ...volumeArgs(cfg, spec),
  ];
  if (joinVpn) {
    args.push("--network", `container:${vpnName(cfg)}`);
  } else {
    args.push("--add-host", "host.docker.internal:host-gateway");
  }
  for (const [k, v] of Object.entries(env)) {
    args.push("-e", `${k}=${v}`);
  }
  args.push(spec.image || cfg.image_default || "ghcr.io/qiantangcredit/heimdall:executor-latest", "/opt/heimdall/scripts/runtime/ctf-agent.sh");
  if (spec.isCancelled?.()) throw new Error("startup_cancelled");
  let cid = "";
  try {
    spec.onLaunching?.();
    cid = sh("docker", args, { timeout: 45000 });
  } catch (e) {
    appendFileSync(logPath, `docker run failed: ${e}\n`);
    // The CLI can fail after the daemon created the container. Keep its name
    // available for inspection and stopping instead of assuming no runtime.
    const state = inspectExit(name);
    if (state.running !== false) {
      stopDockerJob({ containerId: name });
      throw new Error("Docker launch outcome unknown; runtime reconciliation required");
    }
    return { containerId: "", exitCode: 2, timedOut: false, logPath, error: "Docker launch failed" };
  }
  trackCid(spec.jobId, spec.uniqueCode, cid);
  try { spec.onStarted?.(cid); }
  catch (error) { stopDockerJob({ jobId: spec.jobId }); throw error; }
  if (spec.isCancelled?.()) stopDockerJob({ jobId: spec.jobId });
  const logs: ChildProcess = spawn("docker", ["logs", "-f", cid], { stdio: ["ignore", "pipe", "pipe"] });
  const pump = (buf: Buffer) => {
    try {
      appendFileSync(logPath, buf);
      appendFileSync(join(spec.workspace, ".heimdall", "agent.log"), buf);
    } catch {
      /* ignore */
    }
  };
  logs.on("error", () => { /* Runtime inspection still owns completion. */ });
  logs.stdout?.on("data", pump);
  logs.stderr?.on("data", pump);

  const deadline = Date.now() + spec.timeoutSec * 1000;
  let timedOut = false;
  let exitCode: number | null = null;
  try {
    while (Date.now() < deadline) {
      const st = inspectExit(cid);
      if (st.running === false) {
        exitCode = st.exit;
        break;
      }
      if (joinVpn && !vpnRunning(cfg)) {
        appendFileSync(logPath, "vpn sidecar died; stopping job so the solver does not keep hitting a dead lab\n");
        try {
          sh("docker", ["stop", "-t", "8", cid], { timeout: 20000 });
        } catch {
          /* ignore */
        }
        const ended = inspectExit(cid);
        if (ended.running !== false) throw new Error("VPN lost; runtime stop unconfirmed");
        exitCode = ended.exit;
        return {
          containerId: cid,
          exitCode: exitCode ?? 2,
          timedOut: false,
          logPath,
          error: "vpn sidecar died",
        };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (exitCode == null) {
      const st = inspectExit(cid);
      if (st.running !== false) {
        timedOut = true;
        try {
          sh("docker", ["stop", "-t", "8", cid], { timeout: 20000 });
        } catch {
          try {
            sh("docker", ["kill", cid], { timeout: 8000 });
          } catch {
            /* ignore */
          }
        }
        exitCode = inspectExit(cid).exit;
      } else {
        exitCode = st.exit;
      }
    }
  } finally {
    try {
      logs.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    if (inspectExit(cid).running === false) untrack(spec.jobId, spec.uniqueCode);
  }
  if (inspectExit(cid).running !== false) throw new Error("Runtime stop unconfirmed; Docker unavailable or container still active");
  return {
    containerId: cid,
    exitCode,
    timedOut,
    logPath,
    error: timedOut ? "timeout" : null,
  };
}

export function ensureVpnHostGateway(cfg: Config): void {
  if (!cfg.vpn_enabled) return;
  const name = vpnName(cfg);
  try {
    const hosts = sh("docker", ["exec", name, "getent", "hosts", "host.docker.internal"]);
    if (hosts.includes("172.17.0.1") || hosts.includes("host-gateway")) return;
  } catch {
    /* missing */
  }
  try {
    sh("docker", [
      "exec",
      name,
      "sh",
      "-c",
      "grep -q 'host.docker.internal' /etc/hosts || echo '172.17.0.1 host.docker.internal' >> /etc/hosts; sed -i 's/^[0-9.]*[[:space:]]*host.docker.internal/172.17.0.1 host.docker.internal/' /etc/hosts",
    ]);
  } catch {
    /* ignore */
  }
}
