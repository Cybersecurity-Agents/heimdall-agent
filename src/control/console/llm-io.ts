import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Config } from "../../shared/config.js";
import { atomicWrite } from "../../shared/fsutil.js";

export const GROUPS: Record<string, string[]> = {
  solver: [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "HEIMDALL_AGENT_MODEL",
    "HEIMDALL_THINKING",
  ],
  loop: [
    "HEIMDALL_LOOP_BASE_URL",
    "HEIMDALL_LOOP_MODEL",
    "HEIMDALL_LOOP_API_KEY",
    "HEIMDALL_LOOP_AUTH_TOKEN",
    "HEIMDALL_LOOP_THINKING",
  ],
  coach: ["HEIMDALL_COACH_BASE_URL", "HEIMDALL_COACH_MODEL", "HEIMDALL_COACH_API_KEY", "HEIMDALL_COACH"],
};

const SECRET_SUFFIX = ["KEY", "TOKEN", "SECRET", "PASSWORD", "AUTH"];

const OVERLAY_FILES: Record<string, string> = {
  "solver-protocol": "system_prompt.md",
  "solver-user": "user_prompt.md",
  "solver-loop": "loop_followup.md",
};

function providerFromUrl(url: string): string {
  const u = (url || "").toLowerCase();
  if (u.includes("deepseek")) return "deepseek";
  if (u.includes("moonshot") || u.includes("kimi")) return "moonshot";
  if (u.includes("anthropic.com") && !u.includes("tsecbench")) return "anthropic";
  return "";
}

function apiFromUrl(url: string): string {
  const u = (url || "").toLowerCase();
  if (u.includes("/anthropic") || u.replace(/\/+$/, "").endsWith("/messages")) return "anthropic";
  return "";
}

export function syncPiAgentAliases(values: Record<string, string>): void {
  const url = String(values.ANTHROPIC_BASE_URL || "").trim();
  const key =
    String(values.ANTHROPIC_API_KEY || "").trim() ||
    String(values.ANTHROPIC_AUTH_TOKEN || "").trim() ||
    String(values.OPENAI_API_KEY || "").trim();
  const model =
    String(values.ANTHROPIC_MODEL || "").trim() || String(values.HEIMDALL_AGENT_MODEL || "").trim();
  if (url) {
    for (const name of ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "HEIMDALL_LLM_BASE_URL", "HEIMDALL_LLM_UPSTREAM"]) {
      values[name] = url;
    }
    const prov = providerFromUrl(url);
    if (prov) values.HEIMDALL_LLM_PROVIDER = prov;
    const api = apiFromUrl(url);
    if (api) values.HEIMDALL_LLM_API = api;
  }
  if (key) {
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "HEIMDALL_LLM_API_KEY"]) {
      values[name] = key;
    }
  }
  if (model) {
    for (const name of ["ANTHROPIC_MODEL", "OPENAI_MODEL", "HEIMDALL_AGENT_MODEL"]) {
      values[name] = model;
    }
  }
  syncCoachFromLoop(values);
}

/** Observer follows the loop slot, not the regular Pi Agent. */
function syncCoachFromLoop(values: Record<string, string>): void {
  const url = String(values.HEIMDALL_LOOP_BASE_URL || "").trim();
  const key =
    String(values.HEIMDALL_LOOP_API_KEY || "").trim() ||
    String(values.HEIMDALL_LOOP_AUTH_TOKEN || "").trim();
  const model = String(values.HEIMDALL_LOOP_MODEL || "").trim();
  if (url) {
    values.HEIMDALL_COACH_BASE_URL = url;
    const prov = providerFromUrl(url);
    if (prov) values.HEIMDALL_COACH_PROVIDER = prov;
    const api = apiFromUrl(url);
    if (api) values.HEIMDALL_COACH_API = api;
  }
  if (key) {
    values.HEIMDALL_COACH_API_KEY = key;
    values.HEIMDALL_COACH_AUTH_TOKEN = key;
  }
  if (model) values.HEIMDALL_COACH_MODEL = model;
}

export function overlayPath(cfg: Config): string {
  return join(cfg.data_dir, "console", "llm.yaml");
}

export function promptPath(cfg: Config): string {
  return join(cfg.data_dir, "console", "system_prompt.md");
}

export function overlayPromptPath(cfg: Config, promptId: string): string {
  const name = OVERLAY_FILES[promptId];
  if (!name) throw new Error("unknown overlay prompt");
  return join(cfg.data_dir, "console", name);
}

export function readOverlayPrompt(cfg: Config, promptId: string): string {
  const path = overlayPromptPath(cfg, promptId);
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function writeOverlayPrompt(cfg: Config, promptId: string, text: string): string {
  const path = overlayPromptPath(cfg, promptId);
  const body = text ?? "";
  mkdirSync(join(cfg.data_dir, "console"), { recursive: true });
  writeFileSync(path, body, "utf8");
  return body;
}

function valuesOf(cfg: Config): Record<string, string> {
  const raw = cfg.tools_env?.values || {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = v == null ? "" : String(v);
  return out;
}

function redact(key: string, value: string): string {
  if (!value) return "";
  if (!SECRET_SUFFIX.some((s) => key.toUpperCase().includes(s))) return value;
  if (value.length <= 8) return "••••";
  return `••••${value.slice(-4)}`;
}

export function snapshot(cfg: Config): Record<string, unknown> {
  const vals = valuesOf(cfg);
  const out: Record<string, unknown> = {};
  for (const [group, keys] of Object.entries(GROUPS)) {
    const block: Record<string, unknown> = {};
    for (const key of keys) {
      const val = vals[key] || "";
      const secret = SECRET_SUFFIX.some((s) => key.toUpperCase().includes(s));
      block[key] = {
        set: Boolean(val.trim()),
        value: secret ? "" : val,
        preview: secret ? redact(key, val) : val,
      };
    }
    out[group] = block;
  }
  return out;
}

export function loadOverlay(cfg: Config): void {
  const path = overlayPath(cfg);
  if (!existsSync(path)) return;
  try {
    const raw = parseYaml(readFileSync(path, "utf8")) || {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    if (!cfg.tools_env || typeof cfg.tools_env.values !== "object") return;
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      if (val == null) continue;
      cfg.tools_env.values[String(key)] = String(val);
    }
    syncPiAgentAliases(cfg.tools_env.values);
  } catch {
    /* ignore */
  }
}

export function applyPayload(cfg: Config, payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("llm settings must be an object");
  }
  const allowed = new Set(Object.values(GROUPS).flat());
  if (!cfg.tools_env) throw new Error("tools.env is not loaded");
  if (!cfg.tools_env.values) cfg.tools_env.values = {};
  const path = overlayPath(cfg);
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const raw = parseYaml(readFileSync(path, "utf8")) || {};
      if (raw && typeof raw === "object" && !Array.isArray(raw)) current = raw as Record<string, unknown>;
    } catch {
      current = {};
    }
  }
  for (const [key, raw] of Object.entries(payload as Record<string, unknown>)) {
    if (!allowed.has(key) || raw == null) continue;
    const text = String(raw);
    const secret = SECRET_SUFFIX.some((s) => key.toUpperCase().includes(s));
    if (secret && (!text.trim() || text.startsWith("••••"))) continue;
    cfg.tools_env.values[key] = text;
    current[key] = text;
  }
  syncPiAgentAliases(cfg.tools_env.values);
  for (const name of [
    "ANTHROPIC_AUTH_TOKEN",
    "HEIMDALL_LLM_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    "HEIMDALL_AGENT_MODEL",
    "HEIMDALL_LLM_BASE_URL",
    "HEIMDALL_LLM_UPSTREAM",
    "HEIMDALL_LLM_PROVIDER",
    "HEIMDALL_LLM_API",
    "HEIMDALL_COACH_BASE_URL",
    "HEIMDALL_COACH_MODEL",
    "HEIMDALL_COACH_API_KEY",
    "HEIMDALL_COACH_AUTH_TOKEN",
    "HEIMDALL_COACH_PROVIDER",
    "HEIMDALL_COACH_API",
  ]) {
    if (name in cfg.tools_env.values) current[name] = cfg.tools_env.values[name];
  }
  atomicWrite(path, stringifyYaml(current, { sortMapEntries: true }));
  return snapshot(cfg);
}

export function readPrompt(cfg: Config): string {
  const path = promptPath(cfg);
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function writePrompt(cfg: Config, text: string): string {
  const body = text ?? "";
  mkdirSync(join(cfg.data_dir, "console"), { recursive: true });
  writeFileSync(promptPath(cfg), body, "utf8");
  return body;
}
