import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Config } from "../shared/config.js";
import { defaultRegistryPath, registerJob, unregisterJob } from "../taps/demux.js";

export function registryPath(cfg: Config): string {
  const raw = (process.env.HEIMDALL_DEMUX_REGISTRY || "").trim();
  if (raw) return raw;
  return join(cfg.data_dir, "http_demux.json");
}

export function pidPath(cfg: Config): string {
  return join(cfg.data_dir, "http_demux.pid");
}

export function readyPath(cfg: Config): string {
  const raw = (process.env.HEIMDALL_DEMUX_READY || "").trim();
  if (raw) return raw;
  return join(cfg.data_dir, "http_demux.ready");
}

function pidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(path: string): number {
  try {
    return Number.parseInt(readFileSync(path, "utf8").trim() || "0", 10) || 0;
  } catch {
    return 0;
  }
}

function pidIsDemux(pid: number): boolean {
  if (!pidAlive(pid)) return false;
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`);
    const cmd = raw.toString("utf8").replace(/\0/g, " ");
    return cmd.includes("http-demux") || cmd.includes("heimdall-demux") || cmd.includes("heimdall_http_demux");
  } catch {
    return false;
  }
}

export function demuxWanted(cfg: Config): boolean {
  if (!cfg.observe_enabled) return false;
  return String(cfg.agent_runtime || "docker").trim().toLowerCase() === "local";
}

export function demuxIsReady(cfg: Config, timeoutSec = 2): boolean {
  const marker = readyPath(cfg);
  const file = pidPath(cfg);
  const deadline = Date.now() + Math.max(0, timeoutSec) * 1000;
  while (true) {
    if (!pidIsDemux(readPid(file))) return false;
    try {
      if (existsSync(marker) && readFileSync(marker).length > 0) return true;
    } catch {
      /* ignore */
    }
    if (Date.now() >= deadline) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

function wrapper(cfg: Config): string | null {
  for (const cand of [
    join(cfg.repo_root, "bin", "heimdall-demux"),
    "/opt/heimdall/bin/heimdall-demux",
  ]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

export function ensureHttpDemux(cfg: Config): boolean {
  if (!demuxWanted(cfg)) return false;
  mkdirSync(cfg.data_dir, { recursive: true });
  const wrap = wrapper(cfg);
  if (!wrap) {
    console.log("WARN: http_demux wrapper missing");
    return false;
  }
  const file = pidPath(cfg);
  const existing = readPid(file);
  if (pidIsDemux(existing)) return true;
  const reg = registryPath(cfg);
  const ready = readyPath(cfg);
  try {
    if (existsSync(ready)) unlinkSync(ready);
  } catch {
    /* ignore */
  }
  const env = {
    ...process.env,
    HEIMDALL_DEMUX_REGISTRY: reg,
    HEIMDALL_DEMUX_READY: ready,
    HEIMDALL_DATA_DIR: cfg.data_dir,
  };
  const logPath = join(cfg.data_dir, "http_demux.log");
  let fd: number | null = null;
  try {
    fd = openSync(logPath, "a");
    const proc = spawn(wrap, [], {
      cwd: cfg.repo_root,
      env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    proc.unref();
    writeFileSync(file, `${proc.pid}\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    if (!pidIsDemux(proc.pid || 0)) {
      console.log(`WARN: http_demux exited immediately; see ${logPath}`);
      return false;
    }
    console.log(`http_demux started pid=${proc.pid} registry=${reg}`);
    return true;
  } catch (exc) {
    console.log(`WARN: http_demux start failed: ${exc}`);
    return false;
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function registerDemuxJob(
  cfg: Config,
  spec: { jobId: string; workspace: string; containerAddr: string[]; challengeType?: string },
): boolean {
  return registerJob({
    jobId: spec.jobId,
    workspace: spec.workspace,
    addrs: spec.containerAddr,
    challengeType: spec.challengeType || "all",
    path: registryPath(cfg),
  });
}

export function unregisterDemuxJob(cfg: Config, jobId: string): void {
  unregisterJob(jobId, registryPath(cfg));
}

export { defaultRegistryPath };
