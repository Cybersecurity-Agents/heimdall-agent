import { randomUUID } from "node:crypto";
import { ownLocalProcess, processIdentity, recordLocalProcess, signalOwnedProcesses, stopPersistedLocal } from "./local-process.js";
import { snapshotConsolePrompts } from "./prompt-snapshot.js";
import { workspaceCapability } from "../shared/runtime-capabilities.js";
import { clearProxyEnv } from "../shared/network-env.js";
import { ensureVpnReady, wantsEmbeddedVpn } from "./console/vpn.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { Config } from "../shared/config.js";
import { jobTimeoutSec, observerCadenceSec, observerWarmupCfgSec, resolveImage } from "../shared/config.js";
import { canonicalType, classifyChallenge, typeToImageKey } from "../shared/classify.js";
import { routeImage } from "../policy/image-router.js";
import { seedJobSteer } from "../observer/job-steer.js";
import { seedWorkspace } from "./seed.js";
import { applyLoopLlmEnv, syncLlmEnv } from "../shared/pi-workspace.js";
import { stopDockerJob } from "./docker-runner.js";
import { demuxIsReady, ensureHttpDemux, registerDemuxJob, registryPath, unregisterDemuxJob } from "./demux-ctl.js";

export type RunSpec = {
  uniqueCode: string;
  jobId: string;
  attemptN: number;
  workspace: string;
  jobDir: string;
  containerAddr: string[];
  challengeType: string;
  description?: string;
  timeoutSec: number;
  loop?: boolean;
  image?: string;
  extraEnv?: Record<string, string>;
  onLaunching?: () => void;
  isCancelled?: () => boolean;
  onStarted?: (containerId: string) => void;
};

export type RunResult = {
  containerId: string;
  exitCode: number | null;
  timedOut: boolean;
  logPath: string;
  error: string | null;
};

export function prepareWorkspace(
  cfg: Config,
  uniqueCode: string,
  opts: { resume?: boolean; description?: string | null; level?: number | null; challengeType?: string | null } = {},
): { workspace: string; challengeType: string } {
  const challengeType = opts.challengeType
    ? canonicalType(opts.challengeType)
    : classifyChallenge(uniqueCode, cfg, { level: opts.level });
  const root = cfg.workspace_root || cfg.workspaces_dir;
  const workspace = join(root, uniqueCode);
  mkdirSync(workspace, { recursive: true });
  seedWorkspace(workspace, cfg.repo_root, {
    challengeType,
    forceClaudeMd: !opts.resume,
  });
  return { workspace, challengeType };
}

const PROCESS_OWNERS = new WeakMap<ChildProcess, string>();
const LIVE = new Map<string, ChildProcess>();
const LIVE_BY_CODE = new Map<string, Set<string>>();

function track(jobId: string, code: string, proc: ChildProcess): () => void {
  LIVE.set(jobId, proc);
  const set = LIVE_BY_CODE.get(code) || new Set<string>();
  set.add(jobId);
  LIVE_BY_CODE.set(code, set);
  const drop = () => {
    LIVE.delete(jobId);
    const left = LIVE_BY_CODE.get(code);
    if (left) {
      left.delete(jobId);
      if (!left.size) LIVE_BY_CODE.delete(code);
    }
  };
  return drop;
}

function killProc(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  signalOwnedProcesses(PROCESS_OWNERS.get(proc) || "", signal);
  try {
    if (proc.pid) process.kill(-proc.pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      /* ignore */
    }
  }
}

function destroyStdio(proc: ChildProcess): void {
  try {
    proc.stdout?.destroy();
  } catch {
    /* ignore */
  }
  try {
    proc.stderr?.destroy();
  } catch {
    /* ignore */
  }
}

export function stopRunningJob(opts: { jobId?: string; uniqueCode?: string; containerId?: string | null; jobDir?: string }): number {
  let killed = 0;
  const ids = new Set<string>();
  if (opts.jobId) ids.add(opts.jobId);
  if (opts.uniqueCode) {
    for (const id of LIVE_BY_CODE.get(opts.uniqueCode) || []) ids.add(id);
  }
  for (const id of ids) {
    const proc = LIVE.get(id);
    if (!proc) {
      if (opts.jobDir && stopPersistedLocal(id, opts.jobDir, "SIGTERM")) {
        killed++;
        setTimeout(() => stopPersistedLocal(id, opts.jobDir!, "SIGKILL"), 2000).unref();
      }
      continue;
    }
    killProc(proc, "SIGTERM");
    const child = proc;
    setTimeout(() => {
      if (!LIVE.has(id)) return;
      killProc(child, "SIGKILL");
      destroyStdio(child);
    }, 2000);
    killed += 1;
  }
  const cid = String(opts.containerId || "").trim();
  if (!cid || !cid.startsWith("local-") && !cid.startsWith("host-")) {
    killed += stopDockerJob({ jobId: opts.jobId, uniqueCode: opts.uniqueCode, containerId: cid });
  }
  return killed;
}

function buildEnv(cfg: Config, spec: RunSpec): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    UNIQUE_CODE: spec.uniqueCode,
    HEIMDALL_JOB_ID: spec.jobId,
    ATTEMPT_N: String(spec.attemptN),
    CONTAINER_ADDR: spec.containerAddr.join(","),
    BENCHMARK_BASE_URL: cfg.base_url,
    BENCHMARK_TOKEN: cfg.token,
    HEIMDALL_WORKSPACE: spec.workspace,
    HEIMDALL_REPO_ROOT: cfg.repo_root,
    HEIMDALL_CHALLENGE_TYPE: spec.challengeType || "all",
    HEIMDALL_AGENT_BACKEND: spec.loop ? cfg.loop_backend : cfg.agent_backend,
    HEIMDALL_PERMISSION_MODE: cfg.agent_permission_mode,
    HEIMDALL_MAX_TURNS: String(cfg.agent_max_turns),
    HEIMDALL_LOOP: spec.loop ? "1" : "0",
    HEIMDALL_LOOP_TIMEOUT_SEC: String(spec.timeoutSec),
    HEIMDALL_OBSERVER_WARMUP_SEC: String(observerWarmupCfgSec(cfg, Boolean(spec.loop))),
    HEIMDALL_OBSERVER_EVERY_SEC: String(observerCadenceSec(cfg, Boolean(spec.loop))),
    PI_CODING_AGENT_DIR: join(spec.workspace, ".heimdall", "pi"),
    CLAUDE_CONFIG_DIR: join(spec.workspace, ".heimdall", "claude"),
    PI_OFFLINE: "1",
    IS_SANDBOX: "1",
    HOME: join(spec.workspace, ".heimdall", "home"),
  };
  if (spec.loop) env.HEIMDALL_AGENT_BACKEND = cfg.loop_backend;
  cfg.tools_env.mergeInto(env, { overwrite: true });
  env.HEIMDALL_OBSERVER_WARMUP_SEC = String(observerWarmupCfgSec(cfg, Boolean(spec.loop)));
  env.HEIMDALL_OBSERVER_EVERY_SEC = String(observerCadenceSec(cfg, Boolean(spec.loop)));
  Object.assign(env, spec.extraEnv || {});
  env.HEIMDALL_CAPTURE_LOG = "1";
  if (!cfg.observe_enabled) env.HEIMDALL_COACH = "0";
  clearProxyEnv(env);
  applyLoopLlmEnv(env);
  syncLlmEnv(env);
  const pathParts = [
    join(cfg.repo_root, "bin"),
    "/opt/heimdall/bin",
    env.PATH || process.env.PATH || "/usr/bin",
  ];
  env.PATH = pathParts.join(":");
  return env;
}

function entrypoint(cfg: Config): string {
  const a = join(cfg.repo_root, "scripts/runtime", "ctf-agent.sh");
  if (existsSync(a)) return a;
  return "/opt/heimdall/scripts/runtime/ctf-agent.sh";
}

export async function runLocal(cfg: Config, spec: RunSpec): Promise<RunResult> {
  if (spec.isCancelled?.()) throw new Error("startup_cancelled");
  const capability = workspaceCapability();
  if (!capability.available) {
    mkdirSync(spec.jobDir, { recursive: true });
    const logPath = join(spec.jobDir, "run.log");
    writeFileSync(logPath, `${capability.reason}\n`, { flag: "a" });
    return Promise.resolve({ containerId: "", exitCode: 2, timedOut: false, logPath, error: capability.reason });
  }
  snapshotConsolePrompts(cfg, spec.workspace);
  mkdirSync(spec.jobDir, { recursive: true });
  mkdirSync(join(spec.workspace, ".heimdall"), { recursive: true });
  seedJobSteer(spec.workspace, { jobId: spec.jobId, challengeType: spec.challengeType });
  const logPath = join(spec.jobDir, "run.log");
  if (wantsEmbeddedVpn(cfg) && !await ensureVpnReady(cfg)) {
    const error = "VPN is not connected. Reconnect in Settings before starting lab tasks.";
    writeFileSync(logPath, `${error}\n`);
    return { containerId: "", exitCode: 2, timedOut: false, logPath, error };
  }
  if (spec.isCancelled?.()) throw new Error("startup_cancelled");
  const env = buildEnv(cfg, spec);
  env.HEIMDALL_PROCESS_OWNER = randomUUID();
  let demuxRegistered = false;
  try {
    if (ensureHttpDemux(cfg)) {
      env.HEIMDALL_DEMUX_REGISTRY = registryPath(cfg);
      if (registerDemuxJob(cfg, spec)) {
        demuxRegistered = true;
        if (demuxIsReady(cfg)) {
          env.HEIMDALL_DISABLE_HTTP_TAP = "1";
          env.HEIMDALL_HTTP_DEMUX = "1";
        }
      }
    }
  } catch (e) {
    console.log(`WARN: http_demux setup ${spec.uniqueCode}: ${e}`);
  }
  const script = entrypoint(cfg);
  writeFileSync(logPath, `=== workspace ${spec.uniqueCode} job=${spec.jobId} ===\n`, { flag: "a" });
  return new Promise((resolve) => {
    let timedOut = false;
    let proc: ChildProcess;
    try {
      spec.onLaunching?.();
      proc = spawn("bash", [script], {
        cwd: spec.workspace,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({
        containerId: `local-${spec.jobId}`,
        exitCode: 2,
        timedOut: false,
        logPath,
        error: String(e),
      });
      return;
    }
    PROCESS_OWNERS.set(proc, env.HEIMDALL_PROCESS_OWNER!);
    const append = (buf: Buffer) => {
      try {
        writeFileSync(logPath, buf, { flag: "a" });
        writeFileSync(join(spec.workspace, ".heimdall", "agent.log"), buf, { flag: "a" });
      } catch {
        /* ignore */
      }
    };
    const identity = proc.pid ? processIdentity(proc.pid) : null;
    const record = (exit: number | null, error: string | null, state: "running" | "exited") => {
      try { recordLocalProcess(spec.jobDir, { jobId: spec.jobId, identity, state, exit, error, timedOut, owner: env.HEIMDALL_PROCESS_OWNER }); }
      catch (e) { append(Buffer.from(`[runtime] Cannot persist process state: ${e}\n`)); }
    };
    const releaseOwnership = ownLocalProcess(spec.jobId);
    record(null, null, "running");
    const untrack = track(spec.jobId, spec.uniqueCode, proc);

    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);
    const killGraceMs = Math.max(1000, (cfg.kill_timeout_sec || 10) * 1000);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (code: number | null, error: string | null = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
      // stdout closing only proves the leader is done. Redirected background
      // children may still own listeners and must be stopped before releasing the job.
      killProc(proc, "SIGKILL");
      untrack();
      destroyStdio(proc);
      record(code, error || (timedOut ? "timeout" : null), "exited");
      releaseOwnership();
      if (demuxRegistered) {
        try {
          unregisterDemuxJob(cfg, spec.jobId);
        } catch {
          /* ignore */
        }
      }
      resolve({
        containerId: `local-${spec.jobId}`,
        exitCode: code,
        timedOut,
        logPath,
        error: error || (timedOut ? "timeout" : null),
      });
    };
    timer = setTimeout(() => {
      timedOut = true;
      killProc(proc, "SIGTERM");
      killTimer = setTimeout(() => {
        killProc(proc, "SIGKILL");
        destroyStdio(proc);
        setTimeout(() => finish(null), 1000);
      }, killGraceMs);
    }, spec.timeoutSec * 1000);
    // Drain final output, but do not wait forever for inherited background pipes.
    proc.once("exit", (code) => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      drainTimer = setTimeout(() => {
        killProc(proc, "SIGKILL");
        destroyStdio(proc);
        finish(code);
      }, killGraceMs);
    });
    // close follows stream draining; exit may arrive before the last log chunk.
    proc.on("error", (error) => finish(null, error.message));
    proc.on("close", (code) => finish(code));
    try {
      if (proc.pid) spec.onStarted?.(`local-${spec.jobId}`);
      if (spec.isCancelled?.()) killProc(proc);
    } catch (error) {
      killProc(proc, "SIGKILL");
      // Keep ownership until the actual close event drains the process.
      append(Buffer.from(`[runtime] Start callback failed: ${error}\n`));
    }
  });
}

export function imageFor(cfg: Config, challengeType: string, uniqueCode?: string | null): string {
  if (uniqueCode) {
    return routeImage(uniqueCode, cfg, { challengeType });
  }
  return resolveImage(cfg, typeToImageKey(challengeType));
}

export { jobTimeoutSec };
