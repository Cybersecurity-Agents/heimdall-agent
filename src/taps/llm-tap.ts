#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { composeBriefBlob } from "../agent/observe.js";
import {
  composeInjectBlob,
  injectBriefIntoMessages,
  injectMapIntoMessages,
  requestHasRealInject,
} from "../shared/inject.js";
import { envBool } from "../shared/env.js";
import { recordCallSession, ReplyCollector } from "../shared/llm-session.js";
import { recordCall, UsageScanner } from "../shared/llm-usage.js";

const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

const RESP_SKIP = new Set(["transfer-encoding", "connection", "content-length"]);

function isMessagesPost(path: string): boolean {
  const raw = (path || "").split("?", 1)[0]!.replace(/\/+$/, "") || "/";
  return /\/(messages|chat\/completions|responses)$/.test(raw);
}

function upstreamPath(upstream: string, reqPath: string): string {
  const u = new URL(upstream);
  const prefix = u.pathname.replace(/\/+$/, "");
  if (!prefix || prefix === "/") return reqPath;
  if (reqPath.startsWith(prefix)) return reqPath;
  if (reqPath === "/") return prefix + "/";
  return prefix + reqPath;
}

function logLlm(workspace: string, rec: unknown): void {
  const path = join(workspace, ".heimdall", "llm", "calls.jsonl");
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(rec).slice(0, 20000) + "\n");
  } catch {
    /* ignore */
  }
}

function copyReqHeaders(src: http.IncomingHttpHeaders, host: string): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(src)) {
    if (!v || HOP.has(k.toLowerCase())) continue;
    headers[k] = Array.isArray(v) ? v.join(",") : v;
  }
  headers.host = host;
  return headers;
}

function copyRespHeaders(src: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(src)) {
    if (!v) continue;
    const key = k.toLowerCase();
    if (HOP.has(key) || RESP_SKIP.has(key)) continue;
    headers[k] = v;
  }
  return headers;
}

function sendTapError(res: http.ServerResponse, err: unknown): void {
  const msg = JSON.stringify({
    type: "error",
    error: { type: "tap_upstream", message: String(err).slice(0, 200) },
  });
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.writeHead(502, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(msg),
  });
  res.end(msg);
}

function proxyUpstream(opts: {
  upstream: string;
  method: string;
  path: string;
  headers: http.OutgoingHttpHeaders;
  body: Buffer;
  res: http.ServerResponse;
}): Promise<{ status: number; usage: ReturnType<UsageScanner["finish"]>; reply: string }> {
  const u = new URL(opts.upstream);
  const isHttps = u.protocol === "https:";
  const port = u.port ? Number.parseInt(u.port, 10) : isHttps ? 443 : 80;
  const lib = isHttps ? https : http;
  const headers = { ...opts.headers };
  if (opts.body.length) headers["content-length"] = opts.body.length;
  const scanner = new UsageScanner();
  const collector = new ReplyCollector();

  return new Promise((resolve) => {
    let done = false;
    const finish = (status: number) => {
      if (done) return;
      done = true;
      const usage = scanner.finish();
      const reply = collector.finish();
      if (!opts.res.writableEnded && !opts.res.destroyed) opts.res.end();
      resolve({ status, usage, reply });
    };

    const upReq = lib.request(
      {
        hostname: u.hostname,
        port,
        path: opts.path,
        method: opts.method,
        headers,
        timeout: 600_000,
        agent: false, // native http; do not honor HTTP_PROXY
      },
      (upRes) => {
        const status = upRes.statusCode || 502;
        if (!opts.res.headersSent) {
          opts.res.writeHead(status, copyRespHeaders(upRes.headers));
        }
        if (opts.method === "HEAD") {
          upRes.resume();
          upRes.on("end", () => finish(status));
          upRes.on("error", () => finish(status));
          return;
        }
        upRes.on("data", (chunk: Buffer) => {
          scanner.feed(chunk);
          collector.feed(chunk);
          if (opts.res.destroyed || opts.res.writableEnded) return;
          if (!opts.res.write(chunk)) {
            upRes.pause();
            opts.res.once("drain", () => upRes.resume());
          }
        });
        upRes.on("end", () => finish(status));
        upRes.on("error", () => finish(status));
      },
    );
    upReq.on("timeout", () => {
      upReq.destroy();
      sendTapError(opts.res, "timeout");
      finish(502);
    });
    upReq.on("error", (e) => {
      sendTapError(opts.res, e);
      finish(502);
    });
    if (opts.body.length && opts.method !== "GET" && opts.method !== "HEAD") upReq.write(opts.body);
    upReq.end();
  });
}

export function startLlmTap(opts: {
  upstream: string;
  workspace: string;
  port?: number;
  inject?: boolean;
  jobId?: string;
}): http.Server {
  const injectOn = opts.inject !== false;
  const server = http.createServer((req, res) => {
    const url = req.url || "/";
    const method = (req.method || "GET").toUpperCase();
    if ((method === "GET" || method === "HEAD") && (url === "/tap/health" || url === "/health")) {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port || 0;
      const body = JSON.stringify({
        ok: true,
        service: "heimdall-llm-tap",
        upstream: opts.upstream,
        job_id: opts.jobId || "",
        port,
      });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      if (method === "HEAD") res.end();
      else res.end(body);
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("error", () => {
      if (!res.headersSent) res.writeHead(400);
      if (!res.writableEnded) res.end();
    });
    req.on("end", () => {
      void (async () => {
        let body: Buffer = Buffer.concat(chunks);
        let injected = false;
        let model = "";
        const role = String(req.headers["x-heimdall-coach"] || "").trim() === "1" ? "coach" : "solver";
        if (method === "POST" && isMessagesPost(url)) {
          try {
            const parsed = JSON.parse(body.toString("utf8")) as { model?: string };
            model = String(parsed.model || "");
          } catch {
            /* ignore */
          }
        }
        if (injectOn && method === "POST" && isMessagesPost(url)) {
          try {
            const format = /\/responses\/?(?:\?|$)/.test(url) ? "responses" : url.includes("/chat/completions") ? "chat" : "anthropic";
            const map = composeInjectBlob(opts.workspace);
            body = Buffer.from(injectMapIntoMessages(body, map, format));
            const brief = composeBriefBlob(opts.workspace);
            body = Buffer.from(injectBriefIntoMessages(body, brief, format));
            injected = requestHasRealInject(body, "map") || requestHasRealInject(body, "brief");
            logLlm(opts.workspace, { ts: Date.now() / 1000, path: url, injected });
          } catch {
            /* fail-open */
          }
        }
        const path = upstreamPath(opts.upstream, url);
        const u = new URL(opts.upstream);
        const headers = copyReqHeaders(req.headers, u.host);
        try {
          const { status, usage, reply } = await proxyUpstream({
            upstream: opts.upstream,
            method,
            path,
            headers,
            body,
            res,
          });
          if (method === "POST" && isMessagesPost(url) && status >= 200 && status < 300) {
            try {
              recordCallSession(opts.workspace, {
                requestBody: body,
                role,
                model,
                path: url,
                status,
                usage,
                reply,
                injected,
                jobId: opts.jobId,
                background: true,
              });
            } catch {
              /* fail-open */
            }
            try {
              recordCall(opts.workspace, usage, { role, model, path: url, status });
            } catch {
              /* fail-open */
            }
          }
        } catch (e) {
          sendTapError(res, e);
        }
      })();
    });
  });
  server.timeout = 620_000;
  const port = opts.port || 0;
  server.listen(port, "127.0.0.1");
  server.on("listening", () => {
    const addr = server.address();
    const p = typeof addr === "object" && addr ? addr.port : port;
    const meta = join(opts.workspace, ".heimdall", "llm_tap.json");
    try {
      mkdirSync(dirname(meta), { recursive: true });
      writeFileSync(meta, JSON.stringify({ port: p, job_id: opts.jobId || "", upstream: opts.upstream }) + "\n");
    } catch {
      /* ignore */
    }
    console.log(`llm_tap listen 127.0.0.1:${p} upstream=${opts.upstream}`);
  });
  return server;
}

function main(): void {
  const upstream =
    process.env.HEIMDALL_LLM_UPSTREAM ||
    process.env.ANTHROPIC_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    "";
  const workspace = process.env.HEIMDALL_WORKSPACE || "/workspace";
  if (!upstream) {
    console.error("HEIMDALL_LLM_UPSTREAM required");
    process.exit(2);
  }
  startLlmTap({
    upstream,
    workspace,
    port: Number.parseInt(process.env.HEIMDALL_LLM_TAP_PORT || "0", 10) || 0,
    inject: envBool("HEIMDALL_LLM_INJECT", true),
    jobId: process.env.HEIMDALL_JOB_ID,
  });
}

function isMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    if (argv1 === fileURLToPath(import.meta.url)) return true;
  } catch {
    /* ignore */
  }
  return argv1.endsWith("llm-tap.js") || argv1.endsWith("llm-tap.ts");
}

if (isMain()) {
  main();
}
