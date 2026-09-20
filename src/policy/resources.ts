import { classifyChallenge } from "../shared/classify.js";
import { isPlatformActive } from "./inventory.js";
import type { ChallengeRow, PolicyCfg } from "./types.js";

export const HOST_MUTEX_TYPES = new Set(["intranet", "pentest"]);

export function addrHost(addr: string): string {
  let s = String(addr || "").trim();
  if (!s) return "";
  s = s.split(",")[0]!.trim();
  if (s.includes("://")) s = s.split("://", 2)[1] || "";
  s = s.split("/")[0]!.trim();
  if (!s) return "";
  if (s.startsWith("[") && s.includes("]")) return s.slice(1, s.indexOf("]")).trim();
  if ((s.match(/:/g) || []).length === 1) return s.split(":").slice(0, -1).join(":").trim();
  return s.split(":")[0]!.trim();
}

export function addrPort(addr: string): string {
  let s = String(addr || "").trim();
  if (!s) return "";
  s = s.split(",")[0]!.trim();
  if (s.includes("://")) s = s.split("://", 2)[1] || "";
  s = s.split("/")[0]!.trim();
  if (!s) return "";
  if (s.startsWith("[") && s.includes("]")) {
    const rest = s.slice(s.indexOf("]") + 1).trim();
    return rest.startsWith(":") ? rest.slice(1).trim() : "";
  }
  if ((s.match(/:/g) || []).length === 1) return s.split(":").pop()!.trim();
  return "";
}

function asItems(addrs: unknown): unknown[] {
  if (typeof addrs === "string") {
    const s = addrs.trim();
    if (s.startsWith("[")) {
      try {
        const parsed = JSON.parse(s) as unknown;
        if (Array.isArray(parsed)) return parsed;
      } catch {
        return [addrs];
      }
    }
    return [addrs];
  }
  if (Array.isArray(addrs)) return addrs;
  return [];
}

export function firstHost(addrs: unknown): string {
  if (typeof addrs === "string") {
    const raw = addrs;
    if (raw.trim().startsWith("[")) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) addrs = parsed;
        else return addrHost(raw);
      } catch {
        return addrHost(raw);
      }
    } else {
      return addrHost(raw);
    }
  }
  if (!Array.isArray(addrs)) return "";
  for (const item of addrs) {
    const host = addrHost(String(item));
    if (host) return host;
  }
  return "";
}

export function firstEndpoint(addrs: unknown): string {
  const host = firstHost(addrs);
  if (!host) return "";
  const items = asItems(addrs);
  for (const item of items) {
    const port = addrPort(String(item));
    if (port) return `${host}:${port}`;
  }
  return host;
}

export function isHostMutexType(ctype?: string | null): boolean {
  return HOST_MUTEX_TYPES.has((ctype || "").trim().toLowerCase());
}

function addrItems(addrs: unknown): string[] {
  return asItems(addrs).map((x) => String(x));
}

export function occupancyKeys(addrs: unknown, ctype?: string | null): Set<string> {
  const items = addrItems(addrs);
  if (isHostMutexType(ctype)) {
    return new Set(items.map(addrHost).filter(Boolean));
  }
  const keys = new Set<string>();
  for (const item of items) {
    const host = addrHost(item);
    const port = addrPort(item);
    if (host && port) keys.add(`${host}:${port}`);
  }
  return keys;
}

export function occupancyKey(addrs: unknown, ctype?: string | null): string {
  const keys = occupancyKeys(addrs, ctype);
  if (!keys.size) {
    return isHostMutexType(ctype) ? firstHost(addrs) : firstEndpoint(addrs);
  }
  const pref = isHostMutexType(ctype) ? firstHost(addrs) : firstEndpoint(addrs);
  if (keys.has(pref)) return pref;
  return [...keys].sort()[0]!;
}

function splitOccupancy(key: string): [string, string] {
  const s = String(key || "").trim();
  if (!s) return ["", ""];
  if ((s.match(/:/g) || []).length === 1) {
    const [host, port] = s.split(":");
    if (/^\d+$/.test(port || "")) return [(host || "").trim(), (port || "").trim()];
  }
  return [s, ""];
}

export function occupanciesOverlap(left: string, right: string): boolean {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const [ha, pa] = splitOccupancy(a);
  const [hb, pb] = splitOccupancy(b);
  if (ha !== hb) return false;
  if (!pa || !pb) return true;
  return pa === pb;
}

function codeOf(ch: ChallengeRow): string {
  return String(ch.unique_code || "");
}

function addrsOf(ch: ChallengeRow): unknown {
  return ch.container_addr ?? ch.container_addr_json ?? [];
}

function completedOf(ch: ChallengeRow): boolean {
  return Boolean(ch.is_completed);
}

export function challengeTypeOf(ch: ChallengeRow, cfg: PolicyCfg): string {
  const code = codeOf(ch);
  const desc = ch.description == null ? null : String(ch.description);
  const level = ch.level;
  const n = Number.parseInt(String(level ?? ""), 10);
  const levelI = Number.isFinite(n) && String(level ?? "") !== "" ? n : null;
  return classifyChallenge(code, cfg, { description: desc, level: levelI });
}

export type LiveOcc = string | Iterable<string>;

export function contextFromChallenges(
  challenges: Iterable<ChallengeRow>,
  cfg: PolicyCfg,
): { typeOf: Record<string, string>; liveOcc: Record<string, LiveOcc> } {
  const typeOf: Record<string, string> = {};
  const liveOcc: Record<string, LiveOcc> = {};
  for (const ch of challenges) {
    const code = codeOf(ch);
    if (!code) continue;
    typeOf[code] = challengeTypeOf(ch, cfg);
    if (completedOf(ch)) continue;
    if (!isPlatformActive(ch)) continue;
    const keys = occupancyKeys(addrsOf(ch), typeOf[code]);
    if (keys.size) liveOcc[code] = keys;
  }
  return { typeOf, liveOcc };
}

function keysOf(val: LiveOcc | undefined): string[] {
  if (!val) return [];
  if (typeof val === "string") return val ? [val] : [];
  return [...val].map((x) => String(x)).filter((x) => x.trim());
}

export function filterEligible(
  eligible: string[],
  opts: {
    typeOf: Record<string, string>;
    inFlight: Iterable<string>;
    liveHostByCode: Record<string, LiveOcc>;
    labTypes?: Iterable<string>;
    labMax?: number;
    addrMutex?: boolean;
  },
): string[] {
  const lab = new Set([...(opts.labTypes || ["intranet", "pentest"])].map((t) => String(t).trim().toLowerCase()).filter(Boolean));
  const flying = new Set([...opts.inFlight].map((c) => String(c).trim()).filter(Boolean));
  const labInUse = [...flying].filter((c) => lab.has((opts.typeOf[c] || "").trim().toLowerCase())).length;
  const taken: string[] = [];
  const takenHas = (key: string) => taken.some((t) => occupanciesOverlap(key, t));
  if (opts.addrMutex !== false) {
    const eligibleSet = new Set(eligible.map((c) => String(c).trim()));
    for (const [code, key] of Object.entries(opts.liveHostByCode)) {
      if (flying.has(code) || !eligibleSet.has(code)) taken.push(...keysOf(key));
    }
    for (const code of flying) taken.push(...keysOf(opts.liveHostByCode[code]));
  }
  const out: string[] = [];
  let labKept = 0;
  const budget = Math.max(0, Math.trunc(opts.labMax ?? 1) - labInUse);
  for (const raw of eligible) {
    const code = String(raw).trim();
    if (!code) continue;
    const ctype = (opts.typeOf[code] || "").trim().toLowerCase();
    if (lab.has(ctype) && (budget <= 0 || labKept >= budget)) continue;
    if (opts.addrMutex !== false) {
      if (keysOf(opts.liveHostByCode[code]).some(takenHas)) continue;
    }
    out.push(code);
    if (lab.has(ctype)) labKept += 1;
    if (opts.addrMutex !== false) taken.push(...keysOf(opts.liveHostByCode[code]));
  }
  return out;
}

export function classifyCode(uniqueCode: string, cfg: PolicyCfg): string {
  return classifyChallenge(uniqueCode, cfg);
}

export function applyResourceFilter(
  eligible: string[],
  cfg: PolicyCfg,
  opts: { challenges: Iterable<ChallengeRow>; inFlight: Iterable<string> },
): string[] {
  if (!cfg.resources_enabled) {
    return eligible.map((c) => String(c).trim()).filter(Boolean);
  }
  const { typeOf, liveOcc } = contextFromChallenges(opts.challenges, cfg);
  for (const code of eligible) {
    const c = String(code).trim();
    if (c && !(c in typeOf)) typeOf[c] = classifyCode(c, cfg);
  }
  const types = cfg.lab_exclusive_types || ["intranet"];
  return filterEligible(eligible, {
    typeOf,
    inFlight: opts.inFlight,
    liveHostByCode: liveOcc,
    labTypes: types,
    labMax: Number.parseInt(String(cfg.lab_exclusive_max ?? 1), 10) || 0,
    addrMutex: cfg.addr_mutex !== false,
  });
}

export function collidingLiveCodes(
  uniqueCode: string,
  addrs: string[],
  challenges: Iterable<ChallengeRow>,
  opts: { cfg?: PolicyCfg | null; typeOf?: Record<string, string> | null } = {},
): string[] {
  const types = { ...(opts.typeOf || {}) };
  if (opts.cfg) {
    if (!(uniqueCode in types)) types[uniqueCode] = classifyCode(uniqueCode, opts.cfg);
    for (const ch of challenges) {
      const code = codeOf(ch);
      if (code && !(code in types)) types[code] = challengeTypeOf(ch, opts.cfg);
    }
  }
  const mine = occupancyKeys([...addrs], types[uniqueCode]);
  if (!mine.size) return [];
  const hits: string[] = [];
  for (const ch of challenges) {
    const code = codeOf(ch);
    if (!code || code === uniqueCode) continue;
    if (completedOf(ch) || !isPlatformActive(ch)) continue;
    const other = occupancyKeys(addrsOf(ch), types[code]);
    if (other.size && [...mine].some((a) => [...other].some((b) => occupanciesOverlap(a, b)))) {
      hits.push(code);
    }
  }
  return hits;
}

export type AddrPark = {
  code: string;
  occupancy_key: string;
  occupants: string[];
  occupancy_keys: string[];
};

export class AddrParkBook {
  private parks = new Map<string, AddrPark>();

  park(code: string, occupancyKey: string, occupants: string[], occupancyKeys?: Iterable<string> | null): AddrPark {
    const keys = [...(occupancyKeys != null ? occupancyKeys : [occupancyKey])]
      .map((x) => String(x).trim())
      .filter(Boolean);
    const item: AddrPark = {
      code: String(code).trim(),
      occupancy_key: String(occupancyKey || keys[0] || "").trim(),
      occupants: occupants.map((c) => String(c).trim()).filter(Boolean),
      occupancy_keys: keys,
    };
    if (!item.code) return item;
    this.parks.set(item.code, item);
    return item;
  }

  parkedCodes(): Set<string> {
    return new Set(this.parks.keys());
  }

  refresh(challenges: Iterable<ChallengeRow>, cfg: PolicyCfg): Set<string> {
    const { liveOcc } = contextFromChallenges(challenges, cfg);
    const still = new Map<string, AddrPark>();
    for (const [code, item] of this.parks) {
      const mine = item.occupancy_keys.length ? item.occupancy_keys : item.occupancy_key ? [item.occupancy_key] : [];
      let held = false;
      for (const [other, key] of Object.entries(liveOcc)) {
        if (other === code) continue;
        const theirs = keysOf(key);
        if (mine.some((a) => theirs.some((b) => occupanciesOverlap(a, b)))) {
          held = true;
          break;
        }
      }
      if (held) still.set(code, item);
    }
    this.parks = still;
    return new Set(still.keys());
  }
}
