import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../shared/config.js";
import { atomicWrite } from "../shared/fsutil.js";
import { BUILTIN_CATALOG, CATALOG_ENV, MAX_CATALOG_BYTES, validateCatalog, type CapabilityCatalog } from "../shared/model-capabilities.js";

type State = { active: CapabilityCatalog; history: CapabilityCatalog[]; source: string };
const pathOf = (cfg: Config) => join(cfg.data_dir, "console", "model-capabilities.json");
export function readCatalogState(cfg: Config): State {
  if (!existsSync(pathOf(cfg))) return { active: validateCatalog(BUILTIN_CATALOG), history: [], source: "builtin" };
  const raw = JSON.parse(readFileSync(pathOf(cfg), "utf8"));
  return { active: validateCatalog(raw.active), history: raw.history.map(validateCatalog), source: String(raw.source || "import") };
}
export function catalogEnv(cfg: Config): Record<string, string> {
  return { [CATALOG_ENV]: JSON.stringify(readCatalogState(cfg).active) };
}
/** Persist once per workspace, including resume; the child never reads the mutable console catalog. */
export function snapshotCapabilities(cfg: Config, workspace: string, env: NodeJS.ProcessEnv): void {
  const path = join(workspace, ".heimdall", "model-capabilities.json");
  const catalog = existsSync(path) ? validateCatalog(JSON.parse(readFileSync(path, "utf8"))) : readCatalogState(cfg).active;
  if (!existsSync(path)) atomicWrite(path, JSON.stringify(catalog));
  env[CATALOG_ENV] = JSON.stringify(catalog);
}
export async function updateCatalog(cfg: Config, body: Record<string, unknown>, validate: (catalog: CapabilityCatalog) => void): Promise<State> {
  // Capture the active version before network IO to reject conflicting concurrent writes.
  const before = readCatalogState(cfg);
  let candidate: CapabilityCatalog;
  let source = "import";
  if (body.action === "rollback") {
    const old = before.history.find(c => c.version === body.version);
    if (!old) throw new Error("Catalog rollback version is unavailable");
    candidate = old; source = "rollback";
  } else if (body.action === "refresh") {
    const url = new URL(String(body.url || ""));
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Catalog source must be an HTTPS URL without credentials");
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "error" });
    if (!response.ok || !response.body) throw new Error(`Catalog refresh failed: HTTP ${response.status}`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_CATALOG_BYTES) throw new Error("Capability catalog exceeds 96 KiB");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    candidate = validateCatalog(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    // Do not persist query tokens from a signed download URL.
    source = url.origin + url.pathname;
  } else if (body.action === "import") candidate = validateCatalog(body.catalog);
  else throw new Error("Expected catalog action: import / refresh / rollback");
  validate(candidate);
  if (JSON.stringify(readCatalogState(cfg)) !== JSON.stringify(before)) throw new Error("Catalog changed during refresh; retry with the current version");
  const known = [before.active, ...before.history].find(c => c.version === candidate.version);
  if (known && JSON.stringify(known) !== JSON.stringify(candidate)) throw new Error("A catalog version is immutable; use a new version for changed content");
  if (candidate.version === before.active.version) return before;
  const state = { active: candidate, history: [before.active, ...before.history.filter(c => c.version !== candidate.version)].slice(0, 5), source };
  atomicWrite(pathOf(cfg), JSON.stringify(state, null, 2) + "\n");
  return state;
}
