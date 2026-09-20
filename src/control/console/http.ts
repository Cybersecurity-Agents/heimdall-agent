import { LedgerError } from "../../shared/project-ledger.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import type { Config } from "../../shared/config.js";
import { Database } from "../../shared/db.js";
import { TsecError } from "../../platforms/types.js";
import * as settings from "./settings.js";
import * as platform from "./platform.js";
import * as llmIo from "./llm-io.js";
import * as workspace from "./workspace.js";
import { Desk } from "./desk.js";
import { resumeVpn, shutdownVpn } from "./vpn.js";

const DEFAULT_PORT = 8700;

const CTYPE: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function lanDeskUrls(port: number): string[] {
  const urls: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) {
      const v4 = a.family === "IPv4" || (a.family as unknown) === 4;
      if (!v4 || a.internal) continue;
      urls.push(`http://${a.address}:${port}/`);
    }
  }
  return urls;
}

export function parseListen(spec: string): { host: string; port: number } {
  const s = (spec || "").trim();
  if (s.includes("://")) {
    const u = new URL(s);
    return { host: u.hostname || "0.0.0.0", port: Number.parseInt(u.port || String(DEFAULT_PORT), 10) || DEFAULT_PORT };
  }
  if (s.includes(":")) {
    const i = s.lastIndexOf(":");
    return { host: s.slice(0, i) || "0.0.0.0", port: Number.parseInt(s.slice(i + 1), 10) || DEFAULT_PORT };
  }
  return { host: "0.0.0.0", port: Number.parseInt(s || String(DEFAULT_PORT), 10) || DEFAULT_PORT };
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8") || "{}";
      try {
        const data = JSON.parse(raw) as unknown;
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          reject(new Error("body must be an object"));
          return;
        }
        resolveBody(data as Record<string, unknown>);
      } catch {
        reject(new Error("body must be JSON"));
      }
    });
  });
}

function send(res: ServerResponse, status: number, body: Buffer | string, contentType: string, head = false): void {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
    Connection: "close",
  });
  if (head) {
    res.end();
    return;
  }
  res.end(buf);
}

function sendJson(res: ServerResponse, status: number, obj: unknown, head = false): void {
  send(res, status, JSON.stringify(obj), "application/json; charset=utf-8", head);
}

function staticRoots(cfg: Config): string[] {
  const spa = join(cfg.repo_root, "console", "spa");
  return existsSync(join(spa, "index.html")) ? [spa] : [];
}

function readStatic(cfg: Config, path: string): { body: Buffer; type: string } | null {
  let rel = path.replace(/^\/+/, "") || "index.html";
  if (rel === "desk" || rel === "desk/") rel = "index.html";
  if (rel.includes("..")) return null;
  const ctype = CTYPE[extname(rel).toLowerCase()] || "application/octet-stream";
  for (const root of staticRoots(cfg)) {
    const fp = resolve(join(root, rel));
    try {
      if (relative(resolve(root), fp).startsWith("..")) continue;
    } catch {
      continue;
    }
    if (existsSync(fp)) {
      try {
        if (!statSync(fp).isFile()) continue;
      } catch {
        continue;
      }
      return { body: readFileSync(fp), type: ctype };
    }
  }
  const spaIndex = join(cfg.repo_root, "console", "spa", "index.html");
  if (existsSync(spaIndex) && !extname(rel.split("/").pop() || rel)) {
    return { body: readFileSync(spaIndex), type: "text/html; charset=utf-8" };
  }
  return null;
}

function qs(url: URL, name: string): string | null {
  const v = url.searchParams.get(name);
  return v == null ? null : v;
}

export function applyConsoleOverlays(cfg: Config): Config {
  settings.loadOverlay(cfg);
  platform.applySaved(cfg);
  llmIo.loadOverlay(cfg);
  return cfg;
}

export async function serveConsole(cfg: Config, db: Database, listen: string): Promise<void> {
  applyConsoleOverlays(cfg);
  try { workspace.ensureDefault(cfg); } catch (error) { if (!(error instanceof LedgerError)) throw error; console.error(error.message); }
  const desk = new Desk(cfg, db);
  const { host, port } = parseListen(listen);
  const server = createServer((req, res) => {
    void handle(cfg, desk, req, res);
  });
  server.keepAliveTimeout = 5000;
  await new Promise<void>((ok, err) => {
    server.on("error", err);
    server.listen(port, host || "0.0.0.0", () => {
      const bind = host || "0.0.0.0";
      const lan = bind === "0.0.0.0" || bind === "::" ? lanDeskUrls(port) : [];
      const extra = lan.length ? `  lan ${lan.join(" ")}` : "";
      console.log(`console on http://${bind}:${port}  desk http://127.0.0.1:${port}/${extra}`);
      ok();
    });
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    server.close();
    server.closeAllConnections();
    void shutdownVpn().finally(() => { process.exit(0); });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  resumeVpn(cfg);
}

async function handle(cfg: Config, desk: Desk, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const head = req.method === "HEAD";
  try {
    const url = new URL(req.url || "/", "http://console.local");
    const path = url.pathname || "/";
    const method = (req.method || "GET").toUpperCase();
    if (method === "GET" || method === "HEAD") {
      await handleGet(cfg, desk, path, url, res, head);
      return;
    }
    if (method === "POST" || method === "PUT") {
      const body = await readBody(req);
      await handlePost(desk, path, body, res);
      return;
    }
    if (method === "DELETE") {
      handleDelete(desk, path, res);
      return;
    }
    sendJson(res, 405, { ok: false, error: "method not allowed" });
  } catch (e) {
    if (e instanceof LedgerError) { sendJson(res, e.code === "ledger_conflict" ? 409 : 503, { ok: false, code: e.code, error: e.message }, head); return; }
    if (e instanceof Error && (e.message === "body must be JSON" || e.message === "body must be an object")) {
      sendJson(res, 400, { ok: false, error: e.message }, head);
      return;
    }
    if (e instanceof TsecError) {
      sendJson(res, 502, { ok: false, error: String(e) }, head);
      return;
    }
    console.error(`console handler ${req.method} ${req.url}:`, e);
    try {
      sendJson(res, 500, { ok: false, error: "console handler crash" }, head);
    } catch {
      /* ignore */
    }
  }
}

async function handleGet(
  cfg: Config,
  desk: Desk,
  path: string,
  url: URL,
  res: ServerResponse,
  head: boolean,
): Promise<void> {
  if (path === "/api/health" || path === "/health" || path === "/api/status") {
    sendJson(res, 200, desk.status(), head);
    return;
  }
  if (path === "/api/challenges") {
    sendJson(res, 200, { items: desk.challenges() }, head);
    return;
  }
  if (path === "/api/settings") {
    sendJson(res, 200, desk.settingsBundle(), head);
    return;
  }
  if (path === "/api/vpn") {
    sendJson(res, 200, desk.vpnStatus(), head);
    return;
  }
  if (path === "/api/prompts") {
    sendJson(res, 200, desk.promptList(), head);
    return;
  }
  if (path.startsWith("/api/prompts/")) {
    const pid = path.slice("/api/prompts/".length).replace(/\/+$/, "");
    const rec = desk.promptGet(pid);
    sendJson(res, rec.ok ? 200 : 404, rec, head);
    return;
  }
  if (path === "/api/workspaces") {
    sendJson(res, 200, { items: workspace.listWorkspaceCatalog(desk.cfg.repo_root) }, head);
    return;
  }
  if (path === "/api/tokens") {
    sendJson(res, 200, desk.tokens(), head);
    return;
  }
  if (path === "/api/sessions") {
    sendJson(res, 200, desk.sessions(qs(url, "project")), head);
    return;
  }
  if (path.startsWith("/api/sessions/")) {
    const parts = path.slice("/api/sessions/".length).replace(/\/+$/, "").split("/").filter(Boolean);
    const pid = qs(url, "project");
    if (parts.length === 1) {
      const rec = desk.sessionCalls(parts[0]!, pid);
      sendJson(res, rec.ok ? 200 : 400, rec, head);
      return;
    }
    if (parts.length === 2) {
      const rec = desk.sessionCall(parts[0]!, parts[1]!, pid);
      sendJson(res, rec.ok ? 200 : 404, rec, head);
      return;
    }
    sendJson(res, 404, { ok: false, error: "not found" }, head);
    return;
  }
  if (path === "/api/projects") {
    const items = workspace.listProjects(desk.cfg);
    for (const p of items) p.campaign = desk.campaignView(String(p.id || ""));
    desk.attachHomeProgress(items);
    sendJson(res, 200, { items }, head);
    return;
  }
  if (path.startsWith("/api/projects/")) {
    const parts = path.slice("/api/projects/".length).replace(/\/+$/, "").split("/").filter(Boolean);
    if (!parts.length) {
      sendJson(res, 404, { ok: false, error: "not found" }, head);
      return;
    }
    const proj = workspace.getProject(desk.cfg, parts[0]!);
    if (!proj) {
      sendJson(res, 404, { ok: false, error: "project not found" }, head);
      return;
    }
    if (parts.length === 1) {
      sendJson(res, 200, desk.projectBundle(String(proj.id)), head);
      return;
    }
    if (parts.length === 2 && parts[1] === "tasks") {
      sendJson(res, 200, { items: workspace.listTasks(desk.cfg, String(proj.id)) }, head);
      return;
    }
    if (parts.length === 2 && ["run", "stop", "import"].includes(parts[1]!)) {
      sendJson(res, 405, { ok: false, error: "use POST" }, head);
      return;
    }
    sendJson(res, 404, { ok: false, error: "not found" }, head);
    return;
  }
  if (path.startsWith("/api/tasks/")) {
    const tid = path.slice("/api/tasks/".length).replace(/\/+$/, "");
    const rec = workspace.getTask(desk.cfg, tid);
    if (!rec) {
      sendJson(res, 404, { ok: false, error: "task not found" }, head);
      return;
    }
    sendJson(res, 200, rec, head);
    return;
  }
  if (path === "/api/flags") {
    sendJson(res, 200, { items: desk.flags(qs(url, "code"), qs(url, "project")) }, head);
    return;
  }
  if (path === "/api/jobs") {
    sendJson(res, 200, { items: desk.jobs(qs(url, "code"), qs(url, "project")) }, head);
    return;
  }
  if (path.startsWith("/api/node-evidence/")) {
    let code: string;
    try { code = decodeURIComponent(path.slice("/api/node-evidence/".length)); }
    catch { sendJson(res, 400, { error: "bad_request" }, head); return; }
    const rec = desk.nodeEvidence(code, qs(url, "node") || "", qs(url, "revision") || "", qs(url, "project"));
    sendJson(res, rec.error === "bad_request" ? 400 : rec.error === "stale_revision" ? 409 : rec.error ? 404 : 200, rec, head);
    return;
  }
  if (path.startsWith("/api/graph/")) {
    const code = path.slice("/api/graph/".length).replace(/\/+$/, "");
    const rec = desk.graph(code, qs(url, "project"));
    sendJson(res, rec.error === "bad_code" ? 400 : 200, rec, head);
    return;
  }
  if (path.startsWith("/api/progress/")) {
    const code = graphsSafe(path.slice("/api/progress/".length).replace(/\/+$/, ""));
    if (!code) {
      sendJson(res, 400, { ok: false, error: "bad_code" }, head);
      return;
    }
    sendJson(res, 200, desk.progress(code, qs(url, "project")), head);
    return;
  }
  if (path === "/favicon.ico" || path === "/robots.txt") {
    send(res, 204, Buffer.alloc(0), "text/plain", head);
    return;
  }
  const staticFile = readStatic(cfg, path);
  if (staticFile) {
    send(res, 200, staticFile.body, staticFile.type, head);
    return;
  }
  const index = readStatic(cfg, "index.html");
  if (index && !path.startsWith("/api/")) {
    send(res, 200, index.body, index.type, head);
    return;
  }
  sendJson(res, 404, { ok: false, error: "not found" }, head);
}

function graphsSafe(code: string): string {
  const c = (code || "").trim();
  if (!c || c.includes("/") || c.includes("\\") || c.includes("..")) return "";
  return c;
}

async function handlePost(
  desk: Desk,
  path: string,
  body: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  if (path === "/api/sync") {
    sendJson(res, 200, await desk.sync());
    return;
  }
  if (path === "/api/run" || path === "/api/start") {
    sendJson(res, 200, desk.start(body));
    return;
  }
  if (path === "/api/stop") {
    sendJson(res, 200, desk.stop(body));
    return;
  }
  if (path === "/api/flags") {
    sendJson(res, 200, await desk.submitFlag(body));
    return;
  }
  if (path === "/api/settings") {
    try {
      sendJson(res, 200, desk.updateSettings(body));
    } catch (e) {
      if (e instanceof LedgerError) throw e;
      sendJson(res, 400, { ok: false, error: String(e instanceof Error ? e.message : e) });
    }
    return;
  }
  if (path === "/api/vpn") {
    try {
      sendJson(res, 200, await desk.vpnUpload(body));
    } catch (e) {
      if (e instanceof LedgerError) throw e;
      sendJson(res, 400, { ok: false, error: String(e instanceof Error ? e.message : e) });
    }
    return;
  }
  if (path.startsWith("/api/prompts/")) {
    const parts = path.slice("/api/prompts/".length).replace(/\/+$/, "").split("/").filter(Boolean);
    if (!parts.length) {
      sendJson(res, 404, { ok: false, error: "not found" });
      return;
    }
    if (parts.length === 2 && parts[1] === "reset") {
      try {
        sendJson(res, 200, desk.promptReset(parts[0]!));
      } catch (e) {
        if (e instanceof LedgerError) throw e;
        sendJson(res, 400, { ok: false, error: String(e instanceof Error ? e.message : e) });
      }
      return;
    }
    if (parts.length === 1) {
      try {
        sendJson(res, 200, desk.promptSave(parts[0]!, body));
      } catch (e) {
        if (e instanceof LedgerError) throw e;
        sendJson(res, 400, { ok: false, error: String(e instanceof Error ? e.message : e) });
      }
      return;
    }
    sendJson(res, 404, { ok: false, error: "not found" });
    return;
  }
  if (path === "/api/projects") {
    try {
      const rec = workspace.createProject(desk.cfg, String(body.name || ""), String(body.note || ""));
      sendJson(res, 200, { ok: true, project: rec });
    } catch (e) {
      if (e instanceof LedgerError) throw e;
      sendJson(res, 400, { ok: false, error: String(e instanceof Error ? e.message : e) });
    }
    return;
  }
  if (path.startsWith("/api/projects/")) {
    const parts = path.slice("/api/projects/".length).replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts.length === 2 && parts[1] === "settings") {
      const rec = desk.updateProjectSettings(parts[0]!, body);
      sendJson(res, rec.ok ? 200 : 404, rec);
      return;
    }
    if (parts.length === 2 && parts[1] === "strategy") {
      const rec = desk.updateProjectStrategy(parts[0]!, body);
      sendJson(res, rec.ok ? 200 : 404, rec);
      return;
    }
    if (parts.length === 2 && parts[1] === "run") {
      const rec = await desk.startCampaign(parts[0]!, { resume: body.resume === true });
      sendJson(res, rec.error === "project not found" ? 404 : 200, rec);
      return;
    }
    if (parts.length === 2 && parts[1] === "import") {
      const rec = await desk.importUnsolved(parts[0]!);
      sendJson(res, rec.error === "project not found" ? 404 : 200, rec);
      return;
    }
    if (parts.length === 2 && parts[1] === "stop") {
      const rec = desk.stopCampaign(parts[0]!);
      sendJson(res, rec.error === "project not found" ? 404 : 200, rec);
      return;
    }
    if (parts.length === 2 && parts[1] === "tasks") {
      try {
        const rec = workspace.createTask(desk.cfg, {
          projectId: parts[0]!,
          name: String(body.name || ""),
          kind: String(body.kind || "url"),
          url: String(body.url || ""),
          code: String(body.code || ""),
          workspace: String(body.workspace || "auto"),
        });
        sendJson(res, 200, { ok: true, task: rec });
      } catch (e) {
        if (e instanceof LedgerError) throw e;
        sendJson(res, 400, { ok: false, error: String(e instanceof Error ? e.message : e) });
      }
      return;
    }
    sendJson(res, 404, { ok: false, error: "not found" });
    return;
  }
  if (path.startsWith("/api/tasks/")) {
    const tid = path.slice("/api/tasks/".length).replace(/\/+$/, "");
    const rec = workspace.updateTask(desk.cfg, tid, { workspace: body.workspace, name: body.name });
    if (!rec) {
      sendJson(res, 404, { ok: false, error: "task not found" });
      return;
    }
    sendJson(res, 200, { ok: true, task: rec });
    return;
  }
  sendJson(res, 404, { ok: false, error: "not found" });
}

function handleDelete(desk: Desk, path: string, res: ServerResponse): void {
  if (path.startsWith("/api/projects/") && !path.includes("/tasks")) {
    const pid = path.slice("/api/projects/".length).replace(/\/+$/, "");
    const rec = desk.purgeProject(pid);
    sendJson(res, rec.ok ? 200 : 404, rec);
    return;
  }
  if (path.startsWith("/api/tasks/")) {
    const tid = path.slice("/api/tasks/".length).replace(/\/+$/, "");
    const ok = workspace.deleteTask(desk.cfg, tid);
    sendJson(res, ok ? 200 : 404, { ok });
    return;
  }
  sendJson(res, 404, { ok: false, error: "not found" });
}
