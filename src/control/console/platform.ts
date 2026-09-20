import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Config } from "../../shared/config.js";
import { atomicWrite } from "../../shared/fsutil.js";

/** Example compatible API; never auto-filled into saved settings. */
export const EXAMPLE_BASE_URL = "https://tsecbench.zc.tencent.com";
export const DEFAULT_BASE_URL = "";

export function overlayPath(cfg: Config): string {
  return join(cfg.data_dir, "console", "platform.yaml");
}

function readOverlay(cfg: Config): Record<string, unknown> {
  const path = overlayPath(cfg);
  if (!existsSync(path)) return {};
  try {
    const raw = parseYaml(readFileSync(path, "utf8")) || {};
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function snapshot(cfg: Config): Record<string, unknown> {
  const token = (cfg.token || "").trim();
  const url = (cfg.base_url || "").trim();
  let preview = "";
  if (token) preview = token.length > 8 ? `••••${token.slice(-4)}` : "••••";
  return {
    base_url: url,
    default_base_url: EXAMPLE_BASE_URL,
    token_set: Boolean(token),
    token_preview: preview,
  };
}

export function applySaved(cfg: Config): Config {
  const raw = readOverlay(cfg);
  const url = String(raw.base_url || cfg.base_url || "").trim();
  cfg.base_url = url.replace(/\/+$/, "");
  if ("token" in raw && String(raw.token || "").trim()) cfg.token = String(raw.token).trim();
  else if (!(cfg.token || "").trim()) cfg.token = "";
  return cfg;
}

export function applyPayload(cfg: Config, payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("platform settings must be an object");
  }
  const rec = payload as Record<string, unknown>;
  const current = readOverlay(cfg);
  if (rec.base_url !== undefined) {
    const text = String(rec.base_url).trim().replace(/\/+$/, "");
    current.base_url = text;
  }
  if (rec.token !== undefined) {
    const text = String(rec.token).trim();
    if (text && !text.startsWith("••••")) current.token = text;
  }
  atomicWrite(overlayPath(cfg), stringifyYaml(current, { sortMapEntries: true }));
  applySaved(cfg);
  return snapshot(cfg);
}
