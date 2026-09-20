import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const PLACEHOLDER = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

const PROXY_CLEAR_KEYS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
]);

function empty(val: unknown): boolean {
  return val === null || val === undefined || (typeof val === "string" && val.trim() === "");
}

function put(out: Record<string, string>, key: string, val: unknown): void {
  if (empty(val)) {
    if (PROXY_CLEAR_KEYS.has(key)) out[key] = "";
    return;
  }
  if (typeof val === "boolean") {
    out[key] = val ? "true" : "false";
    return;
  }
  const s = String(val);
  if (PLACEHOLDER.test(s.trim())) return;
  out[key] = s;
}

function flatten(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const section of ["claude", "coach", "loop", "proxy"]) {
    const block = raw[section];
    if (block && typeof block === "object") {
      for (const [k, v] of Object.entries(block as Record<string, unknown>)) put(out, k, v);
    }
  }
  const tools = raw.tools;
  if (tools && typeof tools === "object") {
    for (const block of Object.values(tools as Record<string, unknown>)) {
      if (block && typeof block === "object") {
        for (const [k, v] of Object.entries(block as Record<string, unknown>)) put(out, k, v);
      }
    }
  }
  const env = raw.env;
  if (env && typeof env === "object") {
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) put(out, k, v);
  }
  return out;
}

export type ToolsEnv = {
  path: string;
  values: Record<string, string>;
  mergeInto: (env: Record<string, string>, opts?: { overwrite?: boolean }) => void;
};

export function defaultToolsEnvPath(repoRoot: string): string {
  return join(repoRoot, "tools.env.yaml");
}

export function loadToolsEnv(path: string): ToolsEnv {
  let values: Record<string, string> = {};
  if (existsSync(path)) {
    try {
      const raw = parseYaml(readFileSync(path, "utf8")) as unknown;
      if (raw && typeof raw === "object") values = flatten(raw as Record<string, unknown>);
    } catch {
      values = {};
    }
  }
  return {
    path,
    values,
    mergeInto(env, opts = {}) {
      const overwrite = opts.overwrite !== false;
      for (const [k, v] of Object.entries(values)) {
        if (!overwrite && env[k] !== undefined && String(env[k]).trim() !== "") continue;
        env[k] = v;
      }
    },
  };
}
