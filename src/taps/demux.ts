import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  appendRecord,
  isHttpObserveType,
  parseContainerAddrs,
  transactionToRecord,
  type HttpTransaction,
} from "./http-parse.js";

// Load the Node builtin directly; older bundlers do not recognize node:sqlite.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export type DemuxRegistry = { jobs: Record<string, Record<string, unknown>> };

export function defaultRegistryPath(): string {
  const raw = (process.env.HEIMDALL_DEMUX_REGISTRY || "").trim();
  if (raw) return raw;
  const data = (process.env.HEIMDALL_DATA_DIR || "").trim();
  if (data) return join(data, "http_demux.json");
  return "/opt/heimdall/data/http_demux.json";
}

export function emptyRegistry(): DemuxRegistry {
  return { jobs: {} };
}

export function loadRegistry(path?: string | null): DemuxRegistry {
  const p = path || defaultRegistryPath();
  if (!existsSync(p)) return emptyRegistry();
  try {
    const doc = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return emptyRegistry();
    const rec = doc as Record<string, unknown>;
    if (!rec.jobs || typeof rec.jobs !== "object" || Array.isArray(rec.jobs)) rec.jobs = {};
    return rec as DemuxRegistry;
  } catch {
    return emptyRegistry();
  }
}

export function saveRegistry(doc: DemuxRegistry, path?: string | null): void {
  const p = path || defaultRegistryPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
  renameSync(tmp, p);
}

/** SQLite locks are released by the OS on crash; no stale sentinel/PID cleanup. */
function withFileLock<T>(path: string, fn: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(`${path}.lock.sqlite`, { timeout: 5000 });
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally { db.close(); }
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

function normalizeWs(raw: string): string {
  try {
    return realpathSync(raw);
  } catch {
    return resolve(raw);
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function sweepStaleUnlocked(doc: DemuxRegistry): number {
  const jobs = doc.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
    doc.jobs = {};
    return 0;
  }
  const keep: Record<string, Record<string, unknown>> = {};
  let dropped = 0;
  for (const [jid, rec] of Object.entries(jobs)) {
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
      dropped += 1;
      continue;
    }
    const pid = Number.parseInt(String(rec.pid || 0), 10) || 0;
    if (pid && !pidAlive(pid)) {
      dropped += 1;
      continue;
    }
    const ws = rec.workspace;
    if (ws && !isDir(String(ws))) {
      dropped += 1;
      continue;
    }
    keep[String(jid)] = rec;
  }
  if (dropped) doc.jobs = keep;
  return dropped;
}

export function sweepStale(path?: string | null): number {
  const p = path || defaultRegistryPath();
  return withFileLock(p, () => {
    const doc = loadRegistry(p);
    const n = sweepStaleUnlocked(doc);
    if (n) saveRegistry(doc, p);
    return n;
  });
}

export function registerJob(opts: {
  jobId: string;
  workspace: string;
  addrs?: string | Iterable<string> | null;
  challengeType: string;
  path?: string | null;
  pid?: number | null;
}): boolean {
  if (!isHttpObserveType(opts.challengeType)) return false;
  const hosts = [
    ...new Set(parseContainerAddrs(opts.addrs).map((a) => a.host.toLowerCase()).filter(Boolean)),
  ].sort();
  if (!hosts.length) return false;
  const p = opts.path || defaultRegistryPath();
  const jid = (opts.jobId || "").trim();
  if (!jid) return false;
  const ws = normalizeWs(String(opts.workspace));
  const hostSet = new Set(hosts);
  withFileLock(p, () => {
    const doc = loadRegistry(p);
    sweepStaleUnlocked(doc);
    const jobs = doc.jobs || {};
    const kept: Record<string, Record<string, unknown>> = {};
    for (const [oldId, rec] of Object.entries(jobs)) {
      if (String(oldId) === jid) continue;
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
      const oldHosts = new Set((Array.isArray(rec.hosts) ? rec.hosts : []).map((h) => String(h).toLowerCase()));
      let overlap = false;
      for (const h of hostSet) {
        if (oldHosts.has(h)) {
          overlap = true;
          break;
        }
      }
      if (overlap) continue;
      kept[String(oldId)] = rec;
    }
    const entry: Record<string, unknown> = {
      workspace: ws,
      hosts,
      type: (opts.challengeType || "all").trim().toLowerCase(),
      ts: Date.now() / 1000,
    };
    if (opts.pid) entry.pid = Number(opts.pid);
    kept[jid] = entry;
    doc.jobs = kept;
    saveRegistry(doc, p);
  });
  return true;
}

export function unregisterJob(jobId: string, path?: string | null): void {
  const p = path || defaultRegistryPath();
  const jid = (jobId || "").trim();
  if (!jid) return;
  withFileLock(p, () => {
    const doc = loadRegistry(p);
    const jobs = doc.jobs || {};
    if (jid in jobs) {
      delete jobs[jid];
      doc.jobs = jobs;
      saveRegistry(doc, p);
    }
  });
}

export function routeWorkspace(host: string | null | undefined, jobs: Record<string, unknown>): string | null {
  if (!host) return null;
  const needle = host.toLowerCase();
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const rec of Object.values(jobs)) {
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
    const row = rec as Record<string, unknown>;
    const hosts = Array.isArray(row.hosts) ? row.hosts : [];
    if (!hosts.some((h) => String(h).toLowerCase() === needle)) continue;
    const ws = row.workspace;
    if (!ws) continue;
    const key = normalizeWs(String(ws));
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(String(ws));
  }
  if (hits.length === 1) return hits[0]!;
  return null;
}

export function dispatchTransaction(tx: HttpTransaction, jobs: Record<string, unknown>): string | null {
  let ws = routeWorkspace(tx.dst, jobs);
  if (!ws) {
    try {
      ws = routeWorkspace(new URL(String(tx.url || "")).hostname, jobs);
    } catch {
      ws = null;
    }
  }
  if (!ws) return null;
  appendRecord(ws, transactionToRecord(tx, "demux"));
  return ws;
}

export function pickIface(): string {
  const forced = (process.env.HEIMDALL_HTTP_TAP_IFACE || "").trim();
  if (forced) return forced;
  if (isDir("/sys/class/net/tun0")) return "tun0";
  for (const name of ["eth0", "ens3", "enp0s3", "any"]) {
    if (name === "any" || isDir(`/sys/class/net/${name}`)) return name;
  }
  return "any";
}
