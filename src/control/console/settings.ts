import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import type { Config } from "../../shared/config.js";
import { atomicWrite } from "../../shared/fsutil.js";
import { runtimeCapabilities } from "../../shared/runtime-capabilities.js";

export const FIELDS: Record<string, "int" | "float" | "bool"> = {
  max_slots: "int",
  default_timeout_sec: "int",
  loop_timeout_sec: "int",
  loop_hint_after_sec: "int",
  loop_slots: "int",
  loop_enabled: "bool",
  loop_max_per_challenge: "int",
  max_attempts_per_challenge: "int",
  poll_interval_sec: "float",
  start_gate_timeout_sec: "float",
  kill_timeout_sec: "float",
  agent_max_turns: "int",
  observer_every_sec: "float",
  observer_loop_every_sec: "float",
};

const MIN: Record<string, number> = {
  max_slots: 1,
  default_timeout_sec: 60,
  loop_timeout_sec: 60,
  loop_hint_after_sec: 60,
  loop_slots: 1,
  loop_max_per_challenge: 0,
  max_attempts_per_challenge: 1,
  poll_interval_sec: 1,
  start_gate_timeout_sec: 1,
  kill_timeout_sec: 1,
  agent_max_turns: 0,
  observer_every_sec: 60,
  observer_loop_every_sec: 60,
};

export const PROJECT_FIELDS = [
  "default_timeout_sec",
  "loop_timeout_sec",
  "loop_hint_after_sec",
  "loop_max_per_challenge",
  "max_attempts_per_challenge",
  "agent_max_turns",
  "observer_every_sec",
  "observer_loop_every_sec",
] as const;

const RUNTIMES = new Set(["local", "docker"]);

export function coerceField(name: string, raw: unknown): number | boolean {
  const typ = FIELDS[name];
  if (!typ) throw new Error(`unknown settings field ${name}`);
  let val: number | boolean;
  if (typ === "bool") {
    val = typeof raw === "string" ? ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase()) : Boolean(raw);
  } else if (typ === "int") {
    val = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(val)) throw new Error(`${name} must be a number`);
  } else {
    val = Number.parseFloat(String(raw));
    if (!Number.isFinite(val)) throw new Error(`${name} must be a number`);
  }
  const floor = MIN[name];
  if (floor != null && typ !== "bool" && (val as number) < floor) {
    throw new Error(`${name} must be >= ${floor}`);
  }
  return val;
}

export function projectOverlay(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("project settings must be an object");
  }
  const rec = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const name of PROJECT_FIELDS) {
    if (!(name in rec)) continue;
    const raw = rec[name];
    if (raw == null || (typeof raw === "string" && !raw.trim())) continue;
    out[name] = coerceField(name, raw);
  }
  return out;
}

export function projectDefaults(cfg: Config): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of PROJECT_FIELDS) {
    out[name] = (cfg as unknown as Record<string, unknown>)[name];
  }
  return out;
}

export function settingsPath(cfg: Config): string {
  return join(cfg.data_dir, "console-settings.yaml");
}

export function snapshot(cfg: Config): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(FIELDS)) {
    out[name] = (cfg as unknown as Record<string, unknown>)[name];
  }
  const rt = String(cfg.agent_runtime || "docker").trim().toLowerCase();
  out.agent_runtime = RUNTIMES.has(rt) ? rt : "docker";
  out.runtime_capabilities = runtimeCapabilities();
  return out;
}

export function applyPayload(cfg: Config, payload: unknown, validateRuntime = true): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("settings must be an object");
  }
  const rec = payload as Record<string, unknown>;
  if ("agent_runtime" in rec) {
    const rt = String(rec.agent_runtime || "").trim().toLowerCase();
    if (!RUNTIMES.has(rt)) throw new Error("agent_runtime must be local or docker");
    // Docker is a selectable deployment preference even before its engine is
    // connected. The runner checks readiness before creating any executor.
    if (validateRuntime && rt === "local") {
      const capability = runtimeCapabilities().local;
      if (!capability.available) throw new Error(capability.reason);
    }
    cfg.agent_runtime = rt;
  }
  for (const name of Object.keys(FIELDS)) {
    if (!(name in rec)) continue;
    (cfg as unknown as Record<string, unknown>)[name] = coerceField(name, rec[name]);
  }
  return snapshot(cfg);
}

export function save(cfg: Config): string {
  const path = settingsPath(cfg);
  const { runtime_capabilities: _capabilities, ...settings } = snapshot(cfg);
  atomicWrite(path, stringifyYaml(settings, { sortMapEntries: true }));
  return path;
}

export function loadOverlay(cfg: Config): Config {
  const path = settingsPath(cfg);
  if (!existsSync(path)) return cfg;
  try {
    const raw = parseYaml(readFileSync(path, "utf8")) || {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      // Preserve operator choice through a temporary daemon outage; the runner
      // checks availability again before starting any work.
      applyPayload(cfg, raw, false);
    }
  } catch {
    return cfg;
  }
  return cfg;
}
