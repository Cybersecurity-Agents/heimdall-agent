#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { defaultRegistryPath, dispatchTransaction, loadRegistry, pickIface } from "./demux.js";
import { pcapEndianAndLinktype, TcpHttpAssembler } from "./http-parse.js";
import { ByteReader } from "./http-tap.js";

function readyPath(): string {
  const raw = (process.env.HEIMDALL_DEMUX_READY || "").trim();
  if (raw) return raw;
  const data = (process.env.HEIMDALL_DATA_DIR || "").trim();
  if (data) return join(data, "http_demux.ready");
  return join(dirname(defaultRegistryPath()), "http_demux.ready");
}

function setReady(ok: boolean): void {
  const p = readyPath();
  try {
    if (ok) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, `${Date.now() / 1000}\n`);
    } else if (existsSync(p)) {
      unlinkSync(p);
    }
  } catch (exc) {
    console.log(`WARN: http_demux ready: ${exc}`);
  }
}

function findTcpdump(): string | null {
  const path = process.env.PATH || "";
  for (const dir of path.split(":")) {
    if (!dir) continue;
    const cand = join(dir, "tcpdump");
    if (existsSync(cand)) return cand;
  }
  for (const cand of ["/usr/bin/tcpdump", "/usr/sbin/tcpdump", "/bin/tcpdump"]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function idle(): Promise<void> {
  return new Promise(() => {
    setInterval(() => undefined, 3_600_000);
  });
}

async function spawnTcpdump(bin: string, iface: string): Promise<ChildProcess | null> {
  for (const extra of [["--immediate-mode"], [] as string[]]) {
    const proc = spawn(bin, ["-i", iface, "-nn", "-s", "0", "-U", "-w", "-", ...extra, "tcp"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    await sleep(150);
    if (proc.exitCode == null && proc.signalCode == null) return proc;
  }
  return null;
}

async function pump(stdout: Readable): Promise<void> {
  const reader = new ByteReader(stdout);
  const hdr = await reader.read(24);
  if (!hdr) return;
  const parsed = pcapEndianAndLinktype(hdr);
  if (!parsed) return;
  const asm = new TcpHttpAssembler();
  const registryPath = defaultRegistryPath();
  let jobs: Record<string, unknown> = {};
  let lastLoad = 0;
  while (true) {
    const ph = await reader.read(16);
    if (!ph || ph.length < 16) break;
    const tsSec = parsed.le ? ph.readUInt32LE(0) : ph.readUInt32BE(0);
    const tsUsec = parsed.le ? ph.readUInt32LE(4) : ph.readUInt32BE(4);
    const incl = parsed.le ? ph.readUInt32LE(8) : ph.readUInt32BE(8);
    const data = await reader.read(incl);
    if (!data || data.length < incl) break;
    const now = Date.now() / 1000;
    if (now - lastLoad >= 1.0) {
      const doc = loadRegistry(registryPath);
      jobs = doc.jobs || {};
      lastLoad = now;
    }
    if (!Object.keys(jobs).length) continue;
    const ts = tsSec + tsUsec / 1_000_000;
    for (const tx of asm.feedFrame(ts, parsed.linktype, data)) {
      dispatchTransaction(tx, jobs);
    }
  }
}

export async function runHttpDemux(): Promise<number> {
  const tcpdump = findTcpdump();
  if (!tcpdump) {
    console.log("WARN: tcpdump not found; http_demux idle");
    setReady(false);
    await idle();
    return 0;
  }
  const iface = pickIface();
  console.log(`http_demux iface=${iface} registry=${defaultRegistryPath()}`);
  const proc = await spawnTcpdump(tcpdump, iface);
  if (!proc) {
    console.log("WARN: tcpdump spawn failed");
    setReady(false);
    await idle();
    return 0;
  }
  setReady(true);
  const stop = () => {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    if (proc.stdout) await pump(proc.stdout);
  } catch (e) {
    console.log(`WARN: http_demux stream: ${e}`);
  } finally {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  return 0;
}

function isMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    if (argv1 === fileURLToPath(import.meta.url)) return true;
  } catch {
    /* ignore */
  }
  return argv1.endsWith("http-demux.js") || argv1.endsWith("http-demux.ts");
}

if (isMain()) {
  void runHttpDemux()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
