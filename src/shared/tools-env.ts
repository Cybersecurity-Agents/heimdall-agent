import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { LLM_OPTION_SUFFIXES } from "./llm-options.js";

// Only model configuration is inherited by Docker executors. Do not copy host
// runtime controls, proxy settings or unrelated credentials into tools_env.
const MODEL_ENV_KEYS = new Set([
  "HEIMDALL_AGENT_MODEL", "HEIMDALL_SMALL_MODEL",
  ...["HEIMDALL_LLM_", "ANTHROPIC_", "OPENAI_"].flatMap(prefix =>
    ["BASE_URL", "API_KEY", "AUTH_TOKEN", "MODEL", "API", "PROVIDER"].map(key => prefix + key)),
  ...LLM_OPTION_SUFFIXES.map(key => "HEIMDALL_" + key),
  ...["LOOP", "COACH"]
    .flatMap(role => ["BASE_URL", "API_KEY", "AUTH_TOKEN", "MODEL", "API", "PROVIDER", "SMALL_MODEL", ...LLM_OPTION_SUFFIXES]
      .map(key => `HEIMDALL_${role}_${key}`)),
]);

/** Normalize each configuration layer before merging so saved canonical fields
 * override environment aliases. */
function normalizeModelAliases(values: Record<string, string>): Record<string, string> {
  const out = { ...values };
  // A saved ANTHROPIC_* alias must override the corresponding HEIMDALL_* env
  // value too, otherwise Pi and SDK can select different primary connections.
  for (const names of [
    ["HEIMDALL_LLM_BASE_URL", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"],
    ["HEIMDALL_LLM_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
    ["HEIMDALL_AGENT_MODEL", "OPENAI_MODEL", "ANTHROPIC_MODEL"],
  ]) {
    const value = names.map(name => values[name]).find(value => value?.trim());
    if (value) for (const name of names) out[name] = value;
  }
  return out;
}

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

export function loadToolsEnv(path: string, inherited: NodeJS.ProcessEnv = {}): ToolsEnv {
  let values: Record<string, string> = {};
  if (existsSync(path)) {
    try {
      const raw = parseYaml(readFileSync(path, "utf8")) as unknown;
      if (raw && typeof raw === "object") values = flatten(raw as Record<string, unknown>);
    } catch {
      values = {};
    }
  }
  const modelEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (MODEL_ENV_KEYS.has(key)) put(modelEnv, key, value);
  }
  values = { ...normalizeModelAliases(modelEnv), ...normalizeModelAliases(values) };
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
