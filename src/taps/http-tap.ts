#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  appendRecord,
  hostInScope,
  parseContainerAddrs,
  pcapEndianAndLinktype,
  shouldStartHttpTap,
  TcpHttpAssembler,
  transactionToRecord,
  type Addr,
} from "./http-parse.js";
import { trafficDir, workspaceDir } from "../shared/paths.js";

export class ByteReader {
  private buf = Buffer.alloc(0);
  private wait: (() => void) | null = null;
  private ended = false;

  constructor(stream: Readable) {
    stream.on("data", (c: Buffer) => {
      this.buf = Buffer.concat([this.buf, c]);
      this.wait?.();
    });
    stream.on("end", () => {
      this.ended = true;
      this.wait?.();
    });
    stream.on("error", () => {
      this.ended = true;
      this.wait?.();
    });
  }

  async read(n: number): Promise<Buffer | null> {
    while (this.buf.length < n && !this.ended) {
      await new Promise<void>((r) => {
        this.wait = r;
      });
      this.wait = null;
    }
    if (this.buf.length < n) return null;
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return Buffer.from(out);
  }
}

function pickIface(): string {
  const forced = (process.env.HEIMDALL_HTTP_TAP_IFACE || "").trim();
  if (forced) return forced;
  if (existsSync("/sys/class/net/tun0")) return "tun0";
  for (const name of ["eth0", "ens3", "enp0s3", "any"]) {
    if (name === "any" || existsSync(`/sys/class/net/${name}`)) return name;
  }
  return "any";
}

function tcpdumpFilter(addrs: Addr[]): string {
  const hosts = [...new Set(addrs.map((a) => a.host).filter(Boolean))].sort();
  if (!hosts.length) return "tcp";
  return hosts.map((h) => `host ${h}`).join(" or ");
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

async function spawnTcpdump(bin: string, iface: string, bpf: string): Promise<ChildProcess | null> {
  for (const extra of [["--immediate-mode"], [] as string[]]) {
    const proc = spawn(bin, ["-i", iface, "-nn", "-s", "0", "-U", "-w", "-", ...extra, bpf], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    await sleep(150);
    if (proc.exitCode == null && proc.signalCode == null) return proc;
  }
  return null;
}

async function readPcapStream(stdout: Readable, addrs: Addr[], workspace: string): Promise<void> {
  const reader = new ByteReader(stdout);
  const hdr = await reader.read(24);
  if (!hdr) return;
  const parsed = pcapEndianAndLinktype(hdr);
  if (!parsed) return;
  const asm = new TcpHttpAssembler();
  while (true) {
    const ph = await reader.read(16);
    if (!ph || ph.length < 16) break;
    const tsSec = parsed.le ? ph.readUInt32LE(0) : ph.readUInt32BE(0);
    const tsUsec = parsed.le ? ph.readUInt32LE(4) : ph.readUInt32BE(4);
    const incl = parsed.le ? ph.readUInt32LE(8) : ph.readUInt32BE(8);
    const data = await reader.read(incl);
    if (!data || data.length < incl) break;
    const ts = tsSec + tsUsec / 1_000_000;
    for (const tx of asm.feedFrame(ts, parsed.linktype, data)) {
      let urlHost: string | null = null;
      try {
        urlHost = new URL(tx.url).hostname;
      } catch {
        urlHost = null;
      }
      if (!hostInScope(tx.dst, addrs) && !hostInScope(urlHost, addrs)) continue;
      appendRecord(workspace, transactionToRecord(tx, "pcap"));
    }
  }
}

export async function runHttpTap(): Promise<number> {
  const ctype = (process.env.HEIMDALL_CHALLENGE_TYPE || "all").trim().toLowerCase();
  const addrs = parseContainerAddrs(process.env.CONTAINER_ADDR);
  if (!shouldStartHttpTap({ challengeType: ctype, addrs })) {
    console.log("http_tap skip (not web or no CONTAINER_ADDR)");
    return 0;
  }
  const tcpdump = findTcpdump();
  if (!tcpdump) {
    console.log("WARN: tcpdump not found; http_tap idle");
    await idle();
    return 0;
  }
  const iface = pickIface();
  const bpf = tcpdumpFilter(addrs);
  const workspace = workspaceDir(process.env.HEIMDALL_WORKSPACE);
  const tdir = trafficDir(workspace);
  const probe = join(tdir, ".write_probe");
  try {
    writeFileSync(probe, "ok\n");
    unlinkSync(probe);
  } catch (exc) {
    console.log(`http_tap ERROR: traffic dir not writable (${tdir}): ${exc}`);
  }
  console.log(`http_tap iface=${iface} filter=${JSON.stringify(bpf)}`);
  const proc = await spawnTcpdump(tcpdump, iface, bpf);
  if (!proc) {
    console.log("WARN: tcpdump spawn failed");
    await idle();
    return 0;
  }
  const stopPath = join(workspace, ".heimdall", "http_tap.stop");
  const stop = () => {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const watch = setInterval(() => {
    if (existsSync(stopPath)) {
      stop();
      clearInterval(watch);
    }
  }, 400);
  try {
    if (proc.stdout) await readPcapStream(proc.stdout, addrs, workspace);
  } catch (e) {
    console.log(`WARN: http_tap stream: ${e}`);
  } finally {
    clearInterval(watch);
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
  return argv1.endsWith("http-tap.js") || argv1.endsWith("http-tap.ts");
}

if (isMain()) {
  void runHttpTap()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
