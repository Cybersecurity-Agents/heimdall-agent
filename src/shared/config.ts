import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { type TypeRule, canonicalTimeoutType } from "./classify.js";
import { strategyToTypes } from "./workspace-strategy.js";
import { isPreset, presetTypeRules } from "../platforms/tsec/preset.js";
import { defaultToolsEnvPath, loadToolsEnv, type ToolsEnv } from "./tools-env.js";
import { parseGoalConfig } from "./goal.js";

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export const DEFAULT_HINT_FIRST_LOOP_TYPES = [
  "web",
  "all",
  "cve",
  "pwn",
  "evasion",
  "ai",
  "llm",
  "aiagent",
  "ai-agent",
];

export const DEFAULT_LOOP_DIRECT_TYPES = ["intranet", "pentest"];

function expandEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_PATTERN, (_m, name: string) => process.env[name] || "");
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, expandEnv(v)]),
    );
  }
  return value;
}

function optionalInt(values: unknown[], fallback: number): number {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && !value.trim()) continue;
    const n = Number.parseInt(String(value), 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function parseSecMap(raw: unknown, typeAlias = false): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k == null || v == null) continue;
    const sec = Number.parseInt(String(v), 10);
    if (!Number.isFinite(sec) || sec < 1) continue;
    let key = String(k).trim().toLowerCase();
    if (!key) continue;
    if (typeAlias) key = canonicalTimeoutType(key) || key;
    out[key] = sec;
  }
  return out;
}

function parseDispatchWaves(raw: unknown): string[][] {
  if (!Array.isArray(raw)) return [];
  const waves: string[][] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const fam = item.trim().toLowerCase();
      if (fam) waves.push([fam]);
      continue;
    }
    if (Array.isArray(item)) {
      const fams = item.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
      if (fams.length) waves.push(fams);
    }
  }
  return waves;
}

export type ImageRule = { match: string; image: string };

function defaultImageRules(): ImageRule[] {
  return [
    { match: "(?i)(pwn|binary|re)[_-]", image: "pwn" },
    { match: "(?i)(web|api)[_-]", image: "default" },
  ];
}

function parseImageRules(raw: unknown): ImageRule[] {
  if (!Array.isArray(raw)) return defaultImageRules();
  const out: ImageRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const match = String(rec.match || "").trim();
    const image = String(rec.image || "").trim();
    if (match && image) out.push({ match, image });
  }
  return out;
}

export function resolveImage(cfg: { image_default: string; image_pwn: string }, keyOrName: string): string {
  if (keyOrName === "default") return cfg.image_default;
  if (keyOrName === "pwn") return cfg.image_pwn;
  return keyOrName;
}

function parseStrList(raw: unknown): string[] {
  if (raw == null) return [];
  const items = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const val = String(item).trim().toLowerCase();
    if (!val || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
  }
  return out;
}

function lookupSec(
  byCode: Record<string, number> | undefined,
  byType: Record<string, number> | undefined,
  opts: { uniqueCode?: string | null; challengeType?: string | null; default: number },
): number {
  const code = (opts.uniqueCode || "").trim().toLowerCase();
  if (code && byCode?.[code] && byCode[code]! > 0) return byCode[code]!;
  const ctype = canonicalTimeoutType(opts.challengeType);
  if (ctype && byType?.[ctype] && byType[ctype]! > 0) return byType[ctype]!;
  return Math.max(1, Number(opts.default || 1) || 1);
}

function loadDotenv(root: string): void {
  const envFile = join(root, ".env");
  if (!existsSync(envFile)) return;
  try {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    /* ignore */
  }
}

function loadStrategyTypes(cfgPath: string): Record<string, unknown> {
  const candidates: string[] = [];
  if (process.env.HEIMDALL_WS_STRATEGY_FILE) candidates.push(process.env.HEIMDALL_WS_STRATEGY_FILE);
  candidates.push(join(dirname(cfgPath), "workspace_strategy.yaml"));
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const raw = parseYaml(readFileSync(path, "utf8")) as unknown;
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Record<string, unknown>;
      if (rec.types && typeof rec.types === "object") return rec.types as Record<string, unknown>;
      if (rec.workspace_strategy && typeof rec.workspace_strategy === "object") return strategyToTypes(rec.workspace_strategy);
      const rules = Array.isArray(rec.rules) ? rec.rules : [];
      if (rules.some(r => r && typeof r === "object" && "workspace" in r)
        || "preset" in rec && !rules.length && !("overrides" in rec)) return strategyToTypes(rec);
      if ("overrides" in rec || "rules" in rec || "default" in rec) return rec;
    } catch {
      continue;
    }
  }
  return {};
}

export type Config = {
  goal: import("./goal.js").GoalConfig;
  base_url: string;
  token: string;
  max_slots: number;
  default_timeout_sec: number;
  timeout_by_type: Record<string, number>;
  timeout_by_code: Record<string, number>;
  max_attempts_per_challenge: number;
  auto_hint: boolean;
  poll_interval_sec: number;
  dual_capacity: boolean;
  platform_cap: number;
  reconcile_close_completed: boolean;
  reconcile_reattach_available: boolean;
  reconcile_close_orphans: boolean;
  close_verify_attempts: number;
  start_gate_timeout_sec: number;
  start_budget_sec: number;
  kill_timeout_sec: number;
  capacity_backoff_initial_sec: number;
  capacity_backoff_max_sec: number;
  skip_codes: string[];
  dispatch_waves: string[][];
  image_default: string;
  image_pwn: string;
  image_rules: ImageRule[];
  type_default: string;
  type_by_level: Record<number, string>;
  type_overrides: Record<string, string>;
  type_rules: TypeRule[];
  agent_runtime: string;
  docker_runtime_mounts: "image" | "source";
  observe_enabled: boolean;
  observer_every_sec: number;
  observer_loop_every_sec: number;
  observer_warmup_sec: number;
  observer_loop_warmup_sec: number;
  data_dir: string;
  repo_root: string;
  workspace_root: string | null;
  tools_env_path: string;
  tools_env: ToolsEnv;
  enforce_tools_required: boolean;
  agent_backend: string;
  agent_permission_mode: string;
  agent_max_turns: number;
  agent_allow_cli_fallback: boolean;
  agent_allow_sdk_fallback: boolean;
  loop_enabled: boolean;
  loop_slots: number;
  loop_expand_when_idle: boolean;
  loop_timeout_sec: number;
  loop_timeout_by_type: Record<string, number>;
  loop_timeout_by_code: Record<string, number>;
  loop_escalate_on_timeout: boolean;
  loop_max_queue: number;
  loop_max_per_challenge: number;
  loop_backend: string;
  loop_hint_after_sec: number;
  loop_hint_after_by_type: Record<string, number>;
  loop_hint_after_by_code: Record<string, number>;
  loop_hint_first_loop_types: string[];
  loop_hint_first_loop_codes: string[];
  loop_skip_first_loop_hint_codes: string[];
  loop_direct_types: string[];
  loop_direct_codes: string[];
  loop_max_by_type: Record<string, string>;
  loop_remaining_flags_cap: number;
  resources_enabled: boolean;
  lab_exclusive_types: string[];
  lab_exclusive_max: number;
  lab_scout_timeout_sec: number;
  lab_defer_loop_until_scouted: boolean;
  addr_mutex: boolean;
  dry_run: boolean;
  db_path: string;
  jobs_dir: string;
  workspaces_dir: string;
  project_id: string | null;
  vpn_enabled: boolean;
  vpn_mode: string;
  vpn_image: string;
  vpn_container_name: string;
  vpn_config: string | null;
  vpn_ready_timeout_sec: number;
  vpn_privileged: boolean;
};

export function jobTimeoutSec(
  cfg: Config,
  opts: { challengeType?: string | null; jobKind?: string; uniqueCode?: string | null } = {},
): number {
  const kind = (opts.jobKind || "regular").trim().toLowerCase() || "regular";
  if (kind === "loop") {
    return lookupSec(cfg.loop_timeout_by_code, cfg.loop_timeout_by_type, {
      uniqueCode: opts.uniqueCode,
      challengeType: opts.challengeType,
      default: cfg.loop_timeout_sec || 3600,
    });
  }
  return lookupSec(cfg.timeout_by_code, cfg.timeout_by_type, {
    uniqueCode: opts.uniqueCode,
    challengeType: opts.challengeType,
    default: cfg.default_timeout_sec || 2400,
  });
}

export function observerCadenceSec(cfg: Config, loop = false): number {
  const fallback = loop ? 660 : 300;
  const n = Number(loop ? cfg.observer_loop_every_sec : cfg.observer_every_sec);
  return Math.max(30, Number.isFinite(n) && n > 0 ? n : fallback);
}

export function observerWarmupCfgSec(cfg: Config, loop = false): number {
  const fallback = loop ? 660 : 60;
  const n = Number(loop ? cfg.observer_loop_warmup_sec : cfg.observer_warmup_sec);
  return Math.max(30, Number.isFinite(n) && n > 0 ? n : fallback);
}

export function loopHintAfterSecFor(
  cfg: Config,
  challengeType?: string | null,
  uniqueCode?: string | null,
): number {
  return Math.max(
    60,
    lookupSec(cfg.loop_hint_after_by_code, cfg.loop_hint_after_by_type, {
      uniqueCode,
      challengeType,
      default: cfg.loop_hint_after_sec || 1800,
    }),
  );
}

export function hintFirstLoop(
  cfg: Config,
  challengeType?: string | null,
  uniqueCode?: string | null,
): boolean {
  const code = (uniqueCode || "").trim().toLowerCase();
  if (code && cfg.loop_skip_first_loop_hint_codes.includes(code)) return false;
  if (code && cfg.loop_hint_first_loop_codes.includes(code)) return true;
  const allowed = new Set(
    cfg.loop_hint_first_loop_types.map((x) => canonicalTimeoutType(x) || x),
  );
  if (!allowed.size) return false;
  return allowed.has(canonicalTimeoutType(challengeType) || "all");
}

export function isLoopDirectType(cfg: Config, challengeType?: string | null): boolean {
  const allowed = new Set(cfg.loop_direct_types.map((x) => canonicalTimeoutType(x) || x));
  if (!allowed.size) return false;
  return allowed.has(canonicalTimeoutType(challengeType) || "all");
}

export function isLoopDirectCode(
  cfg: Config,
  uniqueCode?: string | null,
  challengeType?: string | null,
): boolean {
  const code = (uniqueCode || "").trim().toLowerCase();
  if (code && cfg.loop_direct_codes.includes(code)) return true;
  return isLoopDirectType(cfg, challengeType);
}

export function loadConfig(path?: string | null, repoRoot?: string | null): Config {
  const root = resolve(repoRoot || process.cwd());
  loadDotenv(root);
  const cfgPath = path ? resolve(path) : join(root, "config.yaml");
  let raw: Record<string, unknown> = {};
  if (existsSync(cfgPath)) {
    raw = (expandEnv(parseYaml(readFileSync(cfgPath, "utf8")) || {}) || {}) as Record<string, unknown>;
  }
  const bench = (raw.benchmark || {}) as Record<string, unknown>;
  const sched = (raw.scheduler || {}) as Record<string, unknown>;
  const images = (raw.images || {}) as Record<string, unknown>;
  const docker = (raw.docker || {}) as Record<string, unknown>;
  const paths = (raw.paths || {}) as Record<string, unknown>;
  let typesCfg = (raw.types || {}) as Record<string, unknown>;

  let typeRules: TypeRule[] = [];
  if (!("rules" in typesCfg)) {
    typeRules = [];
  } else {
    for (const r of (typesCfg.rules as unknown[]) || []) {
      if (r && typeof r === "object" && (r as TypeRule).match && (r as TypeRule).type) {
        typeRules.push({ match: String((r as TypeRule).match), type: String((r as TypeRule).type) });
      }
    }
  }
  const typeOverrides: Record<string, string> = {};
  for (const [k, v] of Object.entries((typesCfg.overrides || {}) as Record<string, unknown>)) {
    if (k && v) typeOverrides[String(k)] = String(v).trim().toLowerCase();
  }
  let typeDefault = String(typesCfg.default || "all").trim().toLowerCase() || "all";
  const typesPreset = String(typesCfg.preset || "").trim().toLowerCase();
  if (isPreset(typesPreset)) {
    const have = new Set(typeRules.map((r) => r.match));
    const extra: TypeRule[] = [];
    for (const rule of presetTypeRules()) {
      if (!have.has(rule.match)) {
        extra.push(rule);
        have.add(rule.match);
      }
    }
    typeRules = extra.concat(typeRules);
  }
  const strat = loadStrategyTypes(cfgPath);
  if (Object.keys(strat).length) {
    for (const [k, v] of Object.entries((strat.overrides || {}) as Record<string, unknown>)) {
      if (k && v) typeOverrides[String(k)] = String(v).trim().toLowerCase();
    }
    const have = new Set(typeRules.map((r) => r.match));
    for (const r of (strat.rules as unknown[]) || []) {
      if (!(r && typeof r === "object" && (r as TypeRule).match && (r as TypeRule).type)) continue;
      const match = String((r as TypeRule).match);
      if (have.has(match)) continue;
      typeRules.push({ match, type: String((r as TypeRule).type) });
      have.add(match);
    }
    const sd = String(strat.default || "").trim().toLowerCase();
    if (sd) typeDefault = sd;
  }

  let dataDir = String(paths.data_dir || "data");
  if (!isAbsolute(dataDir)) dataDir = join(root, dataDir);

  let toolsEnvPath = String(paths.tools_env || docker.tools_env || "tools.env.yaml");
  if (!isAbsolute(toolsEnvPath)) toolsEnvPath = join(root, toolsEnvPath);
  if (!existsSync(toolsEnvPath)) {
    const alt = defaultToolsEnvPath(root);
    if (existsSync(alt)) toolsEnvPath = alt;
  }

  const agent = (raw.agent || {}) as Record<string, unknown>;
  let agentBackend = String(agent.backend || process.env.HEIMDALL_AGENT_BACKEND || "pi")
    .trim()
    .toLowerCase();
  if (!["pi", "sdk", "cli", "auto"].includes(agentBackend)) agentBackend = "pi";

  const loopRaw = (sched.loop && typeof sched.loop === "object" ? sched.loop : {}) as Record<
    string,
    unknown
  >;
  const loopEnv = (process.env.HEIMDALL_LOOP || "").trim().toLowerCase();
  let loopEnabled = true;
  if (["0", "false", "no", "off"].includes(loopEnv)) loopEnabled = false;
  else if (["1", "true", "yes", "on"].includes(loopEnv)) loopEnabled = true;
  else loopEnabled = Boolean(loopRaw.enabled ?? true);

  let loopTimeout = Number.parseInt(String(loopRaw.timeout_sec || 3600), 10);
  if (!Number.isFinite(loopTimeout) || loopTimeout < 1) loopTimeout = 3600;
  let loopBackend = String(loopRaw.backend || "sdk").trim().toLowerCase() || "sdk";
  if (!["sdk", "pi"].includes(loopBackend)) loopBackend = "sdk";
  let loopHintAfter = Number.parseInt(String(loopRaw.hint_after_sec || 1800), 10);
  if (!Number.isFinite(loopHintAfter) || loopHintAfter < 60) loopHintAfter = 1800;

  let loopDirectTypes =
    "direct_types" in loopRaw
      ? parseStrList(loopRaw.direct_types).map((x) => canonicalTimeoutType(x) || x)
      : [...DEFAULT_LOOP_DIRECT_TYPES];
  const loopHintFirst =
    "hint_first_loop_types" in loopRaw
      ? parseStrList(loopRaw.hint_first_loop_types)
      : [...DEFAULT_HINT_FIRST_LOOP_TYPES];

  const obsRaw = (raw.observe && typeof raw.observe === "object" ? raw.observe : {}) as Record<
    string,
    unknown
  >;
  const obsEnv = (process.env.HEIMDALL_OBSERVE || "").trim().toLowerCase();
  let observeEnabled = true;
  if (["0", "false", "no", "off"].includes(obsEnv)) observeEnabled = false;
  else if (["1", "true", "yes", "on"].includes(obsEnv)) observeEnabled = true;
  else observeEnabled = Boolean(obsRaw.enabled ?? true);

  let runtime = String(process.env.HEIMDALL_AGENT_RUNTIME || docker.runtime || "docker")
    .trim()
    .toLowerCase() || "docker";
  if (!["docker", "host", "local"].includes(runtime)) runtime = "docker";

  const vpnRaw = (docker.vpn && typeof docker.vpn === "object" ? docker.vpn : {}) as Record<
    string,
    unknown
  >;
  const vpnEnv = (process.env.HEIMDALL_VPN_ENABLED || process.env.HEIMDALL_VPN_SIDECAR || "").trim().toLowerCase();
  let vpnEnabled = Boolean(vpnRaw.enabled ?? true);
  if (["1", "true", "yes", "on"].includes(vpnEnv)) vpnEnabled = true;
  else if (["0", "false", "no", "off"].includes(vpnEnv)) vpnEnabled = false;
  let vpnMode = String(process.env.HEIMDALL_VPN_MODE || vpnRaw.mode || "auto").trim().toLowerCase() || "auto";
  if (["host", "off", "disabled", "none"].includes(vpnMode)) {
    vpnEnabled = false;
    vpnMode = "off";
  } else if (!["auto", "embedded", "sidecar"].includes(vpnMode)) {
    vpnMode = "sidecar";
  }
  const vpnCfgRaw = vpnRaw.config;
  const vpnCfgPath = vpnCfgRaw == null || String(vpnCfgRaw).trim() === "" ? null : String(vpnCfgRaw).trim();

  const reconcile = (sched.reconcile || {}) as Record<string, unknown>;
  const backoff = (sched.capacity_backoff || {}) as Record<string, unknown>;
  const resRaw = (sched.resources || {}) as Record<string, unknown>;
  const labRaw = (resRaw.lab_exclusive || {}) as Record<string, unknown>;

  const cfg: Config = {
    goal: parseGoalConfig(raw.goal),
    base_url: String(bench.base_url || process.env.BENCHMARK_BASE_URL || "").replace(/\/+$/, ""),
    token: String(bench.token || process.env.BENCHMARK_TOKEN || ""),
    max_slots: Number.parseInt(String(sched.max_slots || 3), 10) || 3,
    default_timeout_sec: Number.parseInt(String(sched.default_timeout_sec || 2400), 10) || 2400,
    timeout_by_type:
      "timeout_by_type" in sched ? parseSecMap(sched.timeout_by_type, true) : {},
    timeout_by_code: parseSecMap(sched.timeout_by_code),
    max_attempts_per_challenge:
      Number.parseInt(String(sched.max_attempts_per_challenge || 3), 10) || 3,
    auto_hint: Boolean(sched.auto_hint ?? false),
    poll_interval_sec: Number(sched.poll_interval_sec || 5),
    dual_capacity: Boolean(sched.dual_capacity ?? true),
    platform_cap: Number.parseInt(String(sched.platform_cap || 3), 10) || 3,
    reconcile_close_completed: Boolean(reconcile.close_completed ?? true),
    reconcile_reattach_available: Boolean(reconcile.reattach_available ?? true),
    reconcile_close_orphans: Boolean(reconcile.close_orphans ?? true),
    close_verify_attempts:
      Number.parseInt(String(reconcile.close_verify_attempts || sched.close_verify_attempts || 3), 10) ||
      3,
    start_gate_timeout_sec: Number(sched.start_gate_timeout_sec || 30),
    start_budget_sec: Number(sched.start_budget_sec || 45),
    kill_timeout_sec: Number(sched.kill_timeout_sec || 10),
    capacity_backoff_initial_sec: Number(backoff.initial_sec || 2),
    capacity_backoff_max_sec: Number(backoff.max_sec || 30),
    skip_codes: (Array.isArray(sched.skip_codes) ? sched.skip_codes : [])
      .map((x) => String(x).trim())
      .filter(Boolean),
    dispatch_waves: parseDispatchWaves(sched.dispatch_waves),
    image_default: String(process.env.HEIMDALL_EXECUTOR_IMAGE || images.default || "ghcr.io/qiantangcredit/heimdall:executor-latest"),
    image_pwn: String(process.env.HEIMDALL_EXECUTOR_IMAGE || images.pwn || images.default || "ghcr.io/qiantangcredit/heimdall:executor-latest"),
    image_rules: parseImageRules(images.rules),
    type_default: typeDefault,
    type_by_level: {},
    type_overrides: typeOverrides,
    type_rules: typeRules,
    agent_runtime: runtime,
    docker_runtime_mounts: docker.runtime_mounts === "source" ? "source" : "image",
    observe_enabled: observeEnabled,
    observer_every_sec: Number(obsRaw.every_sec || 300),
    observer_loop_every_sec: Number(obsRaw.loop_every_sec || 660),
    observer_warmup_sec: Number(obsRaw.warmup_sec || 60),
    observer_loop_warmup_sec: Number(obsRaw.loop_warmup_sec || 660),
    data_dir: dataDir,
    repo_root: root,
    workspace_root: null,
    tools_env_path: toolsEnvPath,
    tools_env: loadToolsEnv(toolsEnvPath),
    enforce_tools_required: Boolean(docker.enforce_tools_required ?? true),
    agent_backend: agentBackend,
    agent_permission_mode: String(
      agent.permission_mode || process.env.HEIMDALL_PERMISSION_MODE || "bypassPermissions",
    ),
    agent_max_turns: optionalInt([agent.max_turns, process.env.HEIMDALL_MAX_TURNS], 0),
    agent_allow_cli_fallback: Boolean(agent.allow_cli_fallback ?? true),
    agent_allow_sdk_fallback: Boolean(agent.allow_sdk_fallback ?? false),
    loop_enabled: loopEnabled,
    loop_slots: Math.max(1, Number.parseInt(String(loopRaw.slots || 1), 10) || 1),
    loop_expand_when_idle: Boolean(loopRaw.expand_when_idle ?? true),
    loop_timeout_sec: loopTimeout,
    loop_timeout_by_type: parseSecMap(loopRaw.timeout_by_type, true),
    loop_timeout_by_code: parseSecMap(loopRaw.timeout_by_code),
    loop_escalate_on_timeout: Boolean(loopRaw.escalate_on_timeout ?? true),
    loop_max_queue: Number.parseInt(String(loopRaw.max_queue || 32), 10) || 32,
    loop_max_per_challenge: Number.parseInt(String(loopRaw.max_loop_per_challenge || 2), 10) || 2,
    loop_backend: loopBackend,
    loop_hint_after_sec: loopHintAfter,
    loop_hint_after_by_type: parseSecMap(loopRaw.hint_after_by_type, true),
    loop_hint_after_by_code: parseSecMap(loopRaw.hint_after_by_code),
    loop_hint_first_loop_types: loopHintFirst,
    loop_hint_first_loop_codes: parseStrList(loopRaw.hint_first_loop_codes),
    loop_skip_first_loop_hint_codes: parseStrList(loopRaw.skip_first_loop_hint_codes),
    loop_direct_types: loopDirectTypes,
    loop_direct_codes: "direct_codes" in loopRaw ? parseStrList(loopRaw.direct_codes) : [],
    loop_max_by_type: {},
    loop_remaining_flags_cap: Math.max(1, Number.parseInt(String(loopRaw.remaining_flags_cap || 3), 10) || 3),
    resources_enabled: Boolean(resRaw.enabled ?? false),
    lab_exclusive_types: parseStrList(labRaw.types),
    lab_exclusive_max: Number.parseInt(String(labRaw.max_concurrent || 1), 10) || 1,
    lab_scout_timeout_sec: Number.parseInt(String(labRaw.scout_timeout_sec || 0), 10) || 0,
    lab_defer_loop_until_scouted: labRaw.defer_loop_until_scouted == null ? true : Boolean(labRaw.defer_loop_until_scouted),
    addr_mutex: Boolean(resRaw.addr_mutex ?? true),
    dry_run: Boolean(docker.dry_run ?? false),
    db_path: join(dataDir, "heimdall.db"),
    jobs_dir: join(dataDir, "jobs"),
    workspaces_dir: join(dataDir, "workspaces"),
    project_id: null,
    vpn_enabled: vpnEnabled,
    vpn_mode: vpnMode,
    vpn_image: String(vpnRaw.image || "ghcr.io/qiantangcredit/heimdall:vpn-latest"),
    vpn_container_name: String(vpnRaw.container_name || "heimdall-tsec-vpn"),
    vpn_config: vpnCfgPath,
    vpn_ready_timeout_sec: Number(vpnRaw.ready_timeout_sec || 90) || 90,
    vpn_privileged: Boolean(vpnRaw.privileged ?? false),
  };
  return cfg;
}

export function overlayConfig(cfg: Config, overrides: Record<string, unknown>): Config {
  if (!overrides || !Object.keys(overrides).length) return cfg;
  const next: Config = {
    ...cfg,
    type_overrides: { ...cfg.type_overrides },
    type_rules: [...cfg.type_rules],
    type_by_level: { ...cfg.type_by_level },
    timeout_by_type: { ...cfg.timeout_by_type },
    timeout_by_code: { ...cfg.timeout_by_code },
    loop_timeout_by_type: { ...cfg.loop_timeout_by_type },
    loop_timeout_by_code: { ...cfg.loop_timeout_by_code },
    loop_direct_types: [...cfg.loop_direct_types],
    loop_direct_codes: [...cfg.loop_direct_codes],
    skip_codes: [...cfg.skip_codes],
    dispatch_waves: cfg.dispatch_waves.map((w) => [...w]),
    image_rules: [...cfg.image_rules],
  };
  for (const [key, val] of Object.entries(overrides)) {
    if (val === undefined) continue;
    (next as unknown as Record<string, unknown>)[key] = val;
  }
  return next;
}

export function ensureDirs(cfg: Config): void {
  mkdirSync(cfg.data_dir, { recursive: true });
  mkdirSync(cfg.jobs_dir, { recursive: true });
  mkdirSync(cfg.workspaces_dir, { recursive: true });
}
