#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalType } from "../shared/classify.js";
import { flagOn } from "../shared/env.js";
import { trafficDir, workspaceDir } from "../shared/paths.js";

export const DLT_NULL = 0;
export const DLT_EN10MB = 1;
export const DLT_RAW = 12;
export const DLT_RAW_BSD = 14;
export const DLT_RAW_LINUX = 101;
export const DLT_LINUX_SLL = 113;
export const DLT_IPV4 = 228;
export const DLT_IPV6 = 229;
export const DLT_LINUX_SLL2 = 276;

const PCAP_MAGIC_NATIVE = 0xa1b2c3d4;
const PCAP_MAGIC_SWAP = 0xd4c3b2a1;
const PCAP_MAGIC_NSEC = 0xa1b23c4d;
const PCAP_MAGIC_NSEC_SWAP = 0x4d3cb2a1;

const HTTP_METHODS = [
  "GET ",
  "POST ",
  "PUT ",
  "DELETE ",
  "HEAD ",
  "OPTIONS ",
  "PATCH ",
  "CONNECT ",
  "TRACE ",
];

const JSONL_MAX_BYTES = 32 * 1024 * 1024;
const BODY_KEEP = 512;
const HTTP_OBSERVE_TYPES = new Set(["all", "web", "cve"]);

const PASSWD_RE = /^root:[^:\n]*:[0-9]+:[0-9]+:/m;
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const PHP_RE = /<\?php/i;
const TB_RE = /Traceback \(most recent call last\)/;
const FLAG_RE = /flag\{[^}]{0,200}\}/i;
const TRAV_RE = /(\.\.\/|%2e%2e|etc\/passwd|proc\/self)/i;
const SQLERR_RE =
  /(SQL syntax|mysql_|PostgreSQL|SQLITE_ERROR|ORA-\d{5}|Unclosed quotation mark|You have an error in your SQL)/i;

export type Addr = { host: string; port: number | null };

export type HttpTransaction = {
  ts: number;
  src: string;
  sport: number;
  dst: string;
  dport: number;
  method: string;
  url: string;
  status: number | null;
  reqHeaders: Record<string, string>;
  respHeaders: Record<string, string>;
  reqBody: Buffer;
  respBody: Buffer;
  complete: boolean;
};

type HttpFields =
  | { kind: "request"; method: string; target: string; headers: Record<string, string>; body: Buffer }
  | { kind: "response"; status: number; headers: Record<string, string>; body: Buffer };

export function parseContainerAddrs(raw: string | Iterable<string> | null | undefined): Addr[] {
  if (raw == null) return [];
  const parts = typeof raw === "string"
    ? raw.replace(/;/g, ",").split(",").map((p) => p.trim()).filter(Boolean)
    : [...raw].map((p) => String(p).trim()).filter(Boolean);
  const out: Addr[] = [];
  const seen = new Set<string>();
  for (const item of parts) {
    const addr = oneAddr(item);
    if (!addr.host) continue;
    const key = `${addr.host.toLowerCase()}|${addr.port ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

function oneAddr(item: string): Addr {
  const text = item.trim();
  if (!text) return { host: "", port: null };
  if (text.includes("://")) {
    try {
      const u = new URL(text);
      const port = u.port ? Number.parseInt(u.port, 10) : Number.NaN;
      return { host: u.hostname || "", port: Number.isFinite(port) ? port : null };
    } catch {
      return { host: "", port: null };
    }
  }
  if (text.startsWith("[") && text.includes("]")) {
    const end = text.indexOf("]");
    const host = text.slice(1, end);
    const rest = text.slice(end + 1);
    if (rest.startsWith(":")) {
      const n = Number.parseInt(rest.slice(1), 10);
      return { host, port: Number.isFinite(n) ? n : null };
    }
    return { host, port: null };
  }
  if ((text.match(/:/g) || []).length === 1) {
    const idx = text.indexOf(":");
    const host = text.slice(0, idx);
    const n = Number.parseInt(text.slice(idx + 1), 10);
    return { host, port: Number.isFinite(n) ? n : null };
  }
  return { host: text, port: null };
}

export function addrHosts(addrs: Addr[]): Set<string> {
  const out = new Set<string>();
  for (const a of addrs) {
    if (a.host) out.add(a.host.toLowerCase());
  }
  return out;
}

export function hostInScope(host: string | null | undefined, addrs: Addr[]): boolean {
  if (!host) return false;
  return addrHosts(addrs).has(host.toLowerCase());
}

export function isHttpObserveType(challengeType?: string | null): boolean {
  return HTTP_OBSERVE_TYPES.has(canonicalType(challengeType || "all"));
}

export function jobListenPort(jobId: string | null | undefined, opts: { base: number; span?: number } = { base: 18000 }): number {
  const raw = (jobId || "").trim() || "default";
  const digest = createHash("sha256").update(raw).digest();
  const span = Math.max(1, opts.span ?? 1000);
  return opts.base + digest.readUInt16BE(0) % span;
}

export function llmTapPort(jobId: string | null | undefined, opts: { base?: number; span?: number } = {}): number {
  return jobListenPort(jobId, { base: opts.base ?? 18000, span: opts.span ?? 1000 });
}

export function shouldStartHttpTap(opts: {
  challengeType?: string | null;
  addrs?: Addr[] | null;
  disable?: boolean | null;
}): boolean {
  let disable = opts.disable;
  if (disable == null) disable = flagOn(process.env.HEIMDALL_DISABLE_HTTP_TAP);
  if (disable) return false;
  if (!isHttpObserveType(opts.challengeType)) return false;
  return Boolean(opts.addrs && opts.addrs.length);
}

export function pcapEndianAndLinktype(header24: Buffer): { le: boolean; linktype: number } | null {
  if (header24.length < 24) return null;
  const magic = header24.readUInt32LE(0);
  let le: boolean;
  if (magic === PCAP_MAGIC_NATIVE || magic === PCAP_MAGIC_NSEC) le = true;
  else if (magic === PCAP_MAGIC_SWAP || magic === PCAP_MAGIC_NSEC_SWAP) le = false;
  else return null;
  const linktype = le ? header24.readUInt32LE(20) : header24.readUInt32BE(20);
  return { le, linktype };
}

function ethPayload(frame: Buffer): Buffer | null {
  if (frame.length < 14) return null;
  let proto = frame.readUInt16BE(12);
  let off = 14;
  if (proto === 0x8100 && frame.length >= 18) {
    proto = frame.readUInt16BE(16);
    off = 18;
  }
  if (proto !== 0x0800) return null;
  return frame.subarray(off);
}

function sllPayload(frame: Buffer): Buffer | null {
  if (frame.length < 16) return null;
  if (frame.readUInt16BE(14) !== 0x0800) return null;
  return frame.subarray(16);
}

function sll2Payload(frame: Buffer): Buffer | null {
  if (frame.length < 20) return null;
  if (frame.readUInt16BE(0) !== 0x0800) return null;
  return frame.subarray(20);
}

export function linkToIp(linktype: number, frame: Buffer): Buffer | null {
  if (linktype === DLT_RAW || linktype === DLT_RAW_BSD || linktype === DLT_RAW_LINUX || linktype === DLT_IPV4) {
    return frame;
  }
  if (linktype === DLT_EN10MB) return ethPayload(frame);
  if (linktype === DLT_LINUX_SLL) return sllPayload(frame);
  if (linktype === DLT_LINUX_SLL2) return sll2Payload(frame);
  if (linktype === DLT_NULL && frame.length >= 5) return frame.subarray(4);
  return null;
}

export function parseIpv4Tcp(
  ipPkt: Buffer,
): { src: string; sport: number; dst: string; dport: number; seq: number; payload: Buffer } | null {
  if (ipPkt.length < 20) return null;
  const vihl = ipPkt.readUInt8(0);
  if (vihl >> 4 !== 4) return null;
  const ihl = (vihl & 0x0f) * 4;
  if (ihl < 20 || ipPkt.length < ihl + 20) return null;
  if (ipPkt.readUInt8(9) !== 6) return null;
  const src = `${ipPkt.readUInt8(12)}.${ipPkt.readUInt8(13)}.${ipPkt.readUInt8(14)}.${ipPkt.readUInt8(15)}`;
  const dst = `${ipPkt.readUInt8(16)}.${ipPkt.readUInt8(17)}.${ipPkt.readUInt8(18)}.${ipPkt.readUInt8(19)}`;
  const tcp = ipPkt.subarray(ihl);
  const sport = tcp.readUInt16BE(0);
  const dport = tcp.readUInt16BE(2);
  const seq = tcp.readUInt32BE(4);
  const doff = (tcp.readUInt8(12) >> 4) * 4;
  if (doff < 20 || tcp.length < doff) return null;
  return { src, sport, dst, dport, seq, payload: tcp.subarray(doff) };
}

function headerDict(raw: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.toString("latin1").split("\r\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    if (!key || key.toLowerCase() in out) continue;
    out[key.toLowerCase()] = line.slice(idx + 1).trim();
  }
  return out;
}

function splitHeadBody(buf: Buffer): { head: Buffer; rest: Buffer } | null {
  const idx = buf.indexOf("\r\n\r\n");
  if (idx < 0) return null;
  return { head: buf.subarray(0, idx), rest: buf.subarray(idx + 4) };
}

function decodeChunked(body: Buffer): Buffer | null {
  const out: Buffer[] = [];
  let pos = 0;
  while (pos < body.length) {
    const nl = body.indexOf("\r\n", pos);
    if (nl < 0) return null;
    const sizeTok = body.subarray(pos, nl).toString("latin1").split(";", 1)[0]?.trim() || "";
    const size = Number.parseInt(sizeTok, 16);
    if (!Number.isFinite(size)) return null;
    pos = nl + 2;
    if (size === 0) return Buffer.concat(out);
    if (pos + size + 2 > body.length) return null;
    out.push(body.subarray(pos, pos + size));
    pos += size + 2;
  }
  return null;
}

function chunkedWireLen(body: Buffer): number | null {
  let pos = 0;
  while (pos < body.length) {
    const nl = body.indexOf("\r\n", pos);
    if (nl < 0) return null;
    const sizeTok = body.subarray(pos, nl).toString("latin1").split(";", 1)[0]?.trim() || "";
    const size = Number.parseInt(sizeTok, 16);
    if (!Number.isFinite(size)) return null;
    pos = nl + 2;
    if (size === 0) {
      const end = body.indexOf("\r\n", pos);
      if (end < 0) return null;
      return end + 2;
    }
    if (pos + size + 2 > body.length) return null;
    pos += size + 2;
  }
  return null;
}

function contentLength(headers: Record<string, string>): number | null {
  const raw = headers["content-length"];
  if (raw == null) return null;
  const n = Number.parseInt((raw.split(",", 1)[0] || "").trim(), 10);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

function startLineFields(start: Buffer, headers: Record<string, string>, body: Buffer): HttpFields {
  const text = start.toString("latin1");
  const parts = text.split(" ");
  if (text.startsWith("HTTP/")) {
    let status = 0;
    if (parts.length >= 2) {
      const n = Number.parseInt(parts[1] || "0", 10);
      status = Number.isFinite(n) ? n : 0;
    }
    return { kind: "response", status, headers, body };
  }
  return {
    kind: "request",
    method: parts[0] || "",
    target: parts[1] || "/",
    headers,
    body,
  };
}

export function tryParseHttpMessage(buf: Buffer): { fields: HttpFields; consumed: number } | null {
  const split = splitHeadBody(buf);
  if (!split) return null;
  const { head, rest } = split;
  const lines = splitLines(head);
  const start = lines[0];
  if (!start || !start.length) return null;
  const headers = headerDict(Buffer.concat(joinHeaderLines(lines.slice(1))));
  const te = (headers["transfer-encoding"] || "").toLowerCase();
  if (te.includes("chunked")) {
    const decoded = decodeChunked(rest);
    if (decoded == null) return null;
    const consumedBody = chunkedWireLen(rest);
    if (consumedBody == null) return null;
    return { fields: startLineFields(start, headers, decoded), consumed: head.length + 4 + consumedBody };
  }
  const startLatin = start.toString("latin1");
  if (
    startLatin.startsWith("GET ") ||
    startLatin.startsWith("HEAD ") ||
    startLatin.startsWith("DELETE ") ||
    startLatin.startsWith("OPTIONS ")
  ) {
    const cl = contentLength(headers);
    if (cl == null) {
      return { fields: startLineFields(start, headers, Buffer.alloc(0)), consumed: head.length + 4 };
    }
  }
  const cl = contentLength(headers);
  if (cl == null) {
    if (startLatin.startsWith("HTTP/")) {
      const status = Number.parseInt(startLatin.split(" ")[1] || "0", 10) || 0;
      if (status === 204 || status === 304) {
        return { fields: startLineFields(start, headers, Buffer.alloc(0)), consumed: head.length + 4 };
      }
    }
    return null;
  }
  if (rest.length < cl) return null;
  return { fields: startLineFields(start, headers, rest.subarray(0, cl)), consumed: head.length + 4 + cl };
}

function splitLines(head: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  while (start <= head.length) {
    const idx = head.indexOf("\r\n", start);
    if (idx < 0) {
      out.push(head.subarray(start));
      break;
    }
    out.push(head.subarray(start, idx));
    start = idx + 2;
  }
  return out;
}

function joinHeaderLines(lines: Buffer[]): Buffer[] {
  if (!lines.length) return [Buffer.alloc(0)];
  const parts: Buffer[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i) parts.push(Buffer.from("\r\n"));
    parts.push(lines[i] || Buffer.alloc(0));
  }
  return parts;
}

export function absoluteUrl(target: string, headers: Record<string, string>, dst: string, dport: number): string {
  if (target.startsWith("http://") || target.startsWith("https://")) return target;
  let host = headers.host || dst;
  if (!host.includes(":") && dport !== 80 && dport !== 0) host = `${host}:${dport}`;
  const path = target.startsWith("/") ? target : `/${target}`;
  return `http://${host}${path}`;
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname || "/";
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return url;
  }
}

class Flow {
  nextSeq: number | null = null;
  buf = Buffer.alloc(0);
  hold = new Map<number, Buffer>();

  push(seq: number, payload: Buffer): void {
    if (!payload.length) return;
    if (this.nextSeq === null) this.nextSeq = seq;
    this.hold.set(seq, payload);
    while (this.nextSeq !== null && this.hold.has(this.nextSeq)) {
      const chunk = this.hold.get(this.nextSeq);
      if (!chunk) break;
      this.hold.delete(this.nextSeq);
      this.buf = Buffer.concat([this.buf, chunk]);
      this.nextSeq += chunk.length;
    }
    if (this.hold.size > 32) this.hold.clear();
  }
}

function flowKey(src: string, sport: number, dst: string, dport: number): string {
  return `${src}|${sport}|${dst}|${dport}`;
}

export class TcpHttpAssembler {
  private flows = new Map<string, Flow>();
  private pending = new Map<
    string,
    { ts: number; src: string; sport: number; dst: string; dport: number; method: string; target: string; headers: Record<string, string>; body: Buffer }
  >();

  feedTcp(
    ts: number,
    src: string,
    sport: number,
    dst: string,
    dport: number,
    seq: number,
    payload: Buffer,
  ): HttpTransaction[] {
    if (!payload.length) return [];
    const key = flowKey(src, sport, dst, dport);
    let flow = this.flows.get(key);
    if (!flow) {
      flow = new Flow();
      this.flows.set(key, flow);
    }
    flow.push(seq, payload);
    const found: HttpTransaction[] = [];
    while (true) {
      const parsed = tryParseHttpMessage(flow.buf);
      if (!parsed) {
        if (flow.buf.length > 1_000_000) {
          flow.buf = Buffer.alloc(0);
          flow.nextSeq = null;
        }
        break;
      }
      flow.buf = flow.buf.subarray(parsed.consumed);
      const fields = parsed.fields;
      if (fields.kind === "request") {
        const rev = flowKey(dst, dport, src, sport);
        this.pending.set(rev, {
          ts,
          src,
          sport,
          dst,
          dport,
          method: fields.method,
          target: fields.target,
          headers: fields.headers,
          body: fields.body,
        });
      } else {
        const req = this.pending.get(key);
        this.pending.delete(key);
        if (!req) continue;
        const url = absoluteUrl(req.target, req.headers, req.dst, req.dport);
        found.push({
          ts: req.ts,
          src: req.src,
          sport: req.sport,
          dst: req.dst,
          dport: req.dport,
          method: req.method,
          url: normalizeUrl(url),
          status: fields.status,
          reqHeaders: req.headers,
          respHeaders: fields.headers,
          reqBody: req.body,
          respBody: fields.body,
          complete: true,
        });
      }
    }
    return found;
  }

  feedFrame(ts: number, linktype: number, frame: Buffer): HttpTransaction[] {
    const ip = linkToIp(linktype, frame);
    if (!ip) return [];
    const tcp = parseIpv4Tcp(ip);
    if (!tcp) return [];
    return this.feedTcp(ts, tcp.src, tcp.sport, tcp.dst, tcp.dport, tcp.seq, tcp.payload);
  }
}

function pickHdr(headers: Record<string, string>, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  for (const k of keys) {
    const v = lower[k];
    if (v != null) out[k] = v.slice(0, 200);
  }
  return out;
}

function truncateText(raw: Buffer | string, n: number): string {
  let text = typeof raw === "string" ? raw : raw.toString("utf8");
  text = text.replace(/\x00/g, "");
  if (text.length > n) return `${text.slice(0, n)}…`;
  return text;
}

export function classifySignals(url: string, status: number | null, body: Buffer): string[] {
  const latin = body.toString("latin1");
  const sigs: string[] = [];
  if (PASSWD_RE.test(latin)) sigs.push("passwd-like");
  if (PHP_RE.test(latin)) sigs.push("php-source");
  if (TB_RE.test(latin)) sigs.push("traceback");
  if (FLAG_RE.test(latin)) sigs.push("flag-string");
  if (JWT_RE.test(latin) || JWT_RE.test(url)) sigs.push("jwt");
  if (TRAV_RE.test(url) && status === 200) sigs.push("traversal-200");
  if (SQLERR_RE.test(latin)) sigs.push("sql-error");
  if (status === 500) sigs.push("http-500");
  return sigs;
}

export function transactionToRecord(tx: HttpTransaction, srcTag = "pcap"): Record<string, unknown> {
  const body = tx.respBody || Buffer.alloc(0);
  return {
    ts: tx.ts,
    src: srcTag,
    method: tx.method,
    url: tx.url,
    status: tx.status,
    req_n: (tx.reqBody || Buffer.alloc(0)).length,
    resp_n: body.length,
    req_hdr: pickHdr(tx.reqHeaders, ["cookie", "content-type", "authorization"]),
    resp_hdr: pickHdr(tx.respHeaders, ["content-type", "set-cookie", "location"]),
    req_body: truncateText(tx.reqBody || Buffer.alloc(0), 256),
    resp_body: truncateText(body, BODY_KEEP),
    sig: classifySignals(tx.url, tx.status, body),
  };
}

export function recordFromProxy(opts: {
  method: string;
  url: string;
  status: number | null;
  reqBody?: Buffer | null;
  respBody?: Buffer | null;
  reqHeaders?: Record<string, string> | null;
  respHeaders?: Record<string, string> | null;
}): Record<string, unknown> {
  const body = opts.respBody || Buffer.alloc(0);
  const url = normalizeUrl(opts.url);
  return {
    ts: Date.now() / 1000,
    src: "proxy",
    method: opts.method.toUpperCase(),
    url,
    status: opts.status,
    req_n: (opts.reqBody || Buffer.alloc(0)).length,
    resp_n: body.length,
    req_hdr: pickHdr(opts.reqHeaders || {}, ["cookie", "content-type", "authorization"]),
    resp_hdr: pickHdr(opts.respHeaders || {}, ["content-type", "set-cookie", "location"]),
    req_body: truncateText(opts.reqBody || Buffer.alloc(0), 256),
    resp_body: truncateText(body, BODY_KEEP),
    sig: classifySignals(opts.url, opts.status, body),
  };
}

export function httpJsonl(workspace?: string | null): string {
  return join(trafficDir(workspace), "http.jsonl");
}

let appendWarned = false;

export function appendRecord(workspace: string | null | undefined, rec: Record<string, unknown>): boolean {
  const path = httpJsonl(workspace);
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && statSync(path).size >= JSONL_MAX_BYTES) return false;
    const neu = !existsSync(path);
    appendFileSync(path, JSON.stringify(rec) + "\n");
    if (neu) {
      try {
        chmodSync(path, 0o666);
      } catch {
        /* ignore */
      }
    }
    return true;
  } catch (exc) {
    if (!appendWarned) {
      appendWarned = true;
      console.log(`observe: cannot write ${path}: ${exc}`);
    }
    return false;
  }
}

export function maybeLogProxyHttp(opts: {
  method: string;
  url: string;
  status: number;
  reqBody?: Buffer | null;
  respBody?: Buffer | null;
  reqHeaders?: Record<string, string>;
  respHeaders?: Record<string, string>;
}): void {
  try {
    if (!isHttpObserveType(process.env.HEIMDALL_CHALLENGE_TYPE)) return;
    const addrs = parseContainerAddrs(process.env.CONTAINER_ADDR);
    let host: string | null = null;
    try {
      host = new URL(opts.url).hostname;
    } catch {
      host = null;
    }
    if (addrs.length && !hostInScope(host, addrs)) return;
    const rec = recordFromProxy(opts);
    appendRecord(workspaceDir(process.env.HEIMDALL_WORKSPACE), rec);
  } catch {
    /* fail-open */
  }
}
