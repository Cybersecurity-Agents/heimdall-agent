import { hasObservationPublication } from "../shared/observation-publication.js";
import { resourcePath } from "../shared/resources.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalType } from "../shared/classify.js";
import { flagProgress } from "../shared/handoff.js";
import { nowSec } from "../shared/fsutil.js";
import { atomicWrite } from "./render.js";
import { lootJson, sprayCredsTxt, sprayMetaJson, sprayPasswordsTxt, sprayUsersTxt, workspaceDir } from "../shared/paths.js";

function workspaceInput(workspace?: string | null): Record<string, unknown> {
  const p = join(workspaceDir(workspace), "input.json");
  if (!existsSync(p)) return {};
  try {
    const doc = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Multi-flag jobs and jobs using the intranet playbook collect loot and publish dictionaries. */
export function sprayEnabled(workspace?: string | null): boolean {
  const input = workspaceInput(workspace);
  return flagProgress(input).flag_count > 1 || canonicalType(String(input.challenge_type || "")) === "intranet";
}

export type SprayDictStatus = "empty" | "ready" | "updated";

export type SprayDictMeta = {
  rev: number;
  status: SprayDictStatus;
  creds: number;
  users: number;
  passwords: number;
  sha256: string;
  generated_at: number;
  updated_at: number;
};

const YEAR_LOOKBACK = 5;
const PRODUCT_INSTALL_PATTERNS = ["{Product}@{Year}", "{Product}@123", "{Org}@{Year}", "{Org}@123"];
const FILE_SERVICE_LOGINS = ["file", "ftp", "ftpuser"] as const;
const SERVICE_LOGINS = new Set([
  "admin",
  "administrator",
  "root",
  ...FILE_SERVICE_LOGINS,
  "webapp",
  "editor",
  "viewer",
  "system",
  "sysadmin",
  "ubuntu",
  "mysql",
  "www",
  "www-data",
  "test",
  "guest",
  "user",
  "operator",
  "contact",
  "info",
  "support",
  "hr",
  "sales",
  "mail",
  "webmaster",
]);
const BRAND_STOP = new Set([
  "openssh",
  "vsftpd",
  "nginx",
  "apache",
  "flask",
  "gunicorn",
  "php",
  "ubuntu",
  "debian",
  "centos",
  "mysql",
  "mariadb",
  "postgres",
  "http",
  "https",
  "server",
  "system",
  "linux",
  "windows",
  "docker",
  "information",
  "office",
  "platform",
  "management",
  "application",
  "software",
  "ssh",
  "sftp",
  "ftp",
  "smtp",
  "vpn",
  "apt",
]);
const LOOT_BUCKETS = [
  "users",
  "passwords",
  "hosts",
  "patterns",
  "password_patterns",
  "creds",
  "org_names",
  "products",
  "emails",
] as const;

const PATTERN_TOKEN: Record<string, "name" | "year" | "product" | "org" | "initials"> = {
  name: "name",
  user: "name",
  year: "year",
  product: "product",
  org: "org",
  initials: "initials",
  initial: "initials",
};

export function emptyLoot(): Record<string, unknown> {
  const out: Record<string, unknown> = { updated_at: 0 };
  for (const key of LOOT_BUCKETS) out[key] = [];
  return out;
}

export const LOGIN_PASSWORDS_FILE = "passwords.txt";

export function wordlistsDir(): string {
  const env = (process.env.HEIMDALL_WORDLISTS || "").trim();
  if (env) return env;
  return resourcePath("wordlists");
}

export function loadDefaultLoginPasswords(): string[] {
  const p = join(wordlistsDir(), LOGIN_PASSWORDS_FILE);
  if (!existsSync(p)) return [];
  return uniqCap(
    readFileSync(p, "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#")),
  );
}

export function loadLoot(workspace?: string | null): Record<string, unknown> {
  const p = lootJson(workspace);
  if (!existsSync(p)) return emptyLoot();
  try {
    const doc = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return emptyLoot();
    const rec = doc as Record<string, unknown>;
    const out = emptyLoot();
    for (const key of LOOT_BUCKETS) {
      const raw = rec[key];
      if (Array.isArray(raw)) out[key] = raw.filter((x) => x != null);
    }
    const orgsAlias = rec.orgs;
    if (Array.isArray(orgsAlias)) {
      out.org_names = [...(out.org_names as unknown[]), ...orgsAlias.filter((x) => x != null)];
    }
    for (const alias of ["names", "people", "display_names", "usernames", "logins", "accounts"] as const) {
      const extra = rec[alias];
      if (Array.isArray(extra)) {
        out.users = [...(out.users as unknown[]), ...extra.filter((x) => x != null)];
      }
    }
    for (const alias of ["password_rules", "rules"] as const) {
      const extra = rec[alias];
      if (Array.isArray(extra)) {
        out.password_patterns = [...(out.password_patterns as unknown[]), ...extra.filter((x) => x != null)];
      }
    }
    out.updated_at = Number(rec.updated_at || 0) || 0;
    return out;
  } catch {
    return emptyLoot();
  }
}

function itemValues(items: unknown, fields: string[]): string[] {
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      const text = item.trim();
      if (text) out.push(text);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    for (const field of fields) {
      const raw = rec[field];
      if (typeof raw === "string" && raw.trim()) {
        out.push(raw.trim());
        break;
      }
    }
  }
  return out;
}

export function parseCred(item: unknown): { user: string; password: string } | null {
  if (typeof item === "string") {
    const text = item.trim();
    const idx = text.indexOf(":");
    if (idx <= 0 || idx >= text.length - 1) return null;
    return { user: text.slice(0, idx).trim(), password: text.slice(idx + 1) };
  }
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  const user = String(rec.user ?? rec.username ?? rec.name ?? "").trim();
  const password = String(rec.password ?? rec.pass ?? rec.passwd ?? "").trim();
  if (user && password) return { user, password };
  const value = String(rec.value ?? "").trim();
  return value.includes(":") ? parseCred(value) : null;
}

function parseCreds(items: unknown): { user: string; password: string }[] {
  if (!Array.isArray(items)) return [];
  const out: { user: string; password: string }[] = [];
  for (const item of items) {
    const pair = parseCred(item);
    if (pair) out.push(pair);
  }
  return out;
}

function looksLikeLogin(user: string): boolean {
  return isServiceLogin(user) || loginHandles(user).logins.length > 0;
}

/** Observer sometimes dumps `user:pass` into loot.passwords instead of creds. */
function splitLootPasswords(items: unknown): { passwords: string[]; pairs: { user: string; password: string }[] } {
  const passwords: string[] = [];
  const pairs: { user: string; password: string }[] = [];
  if (!Array.isArray(items)) return { passwords, pairs };
  for (const item of items) {
    const pair = parseCred(item);
    if (pair && looksLikeLogin(pair.user) && looksLikePassword(pair.password) && !pair.user.includes("/") && !pair.password.startsWith("//")) {
      pairs.push(pair);
      passwords.push(pair.password);
      continue;
    }
    if (typeof item === "string") {
      const text = item.trim();
      if (text) passwords.push(text);
      continue;
    }
    passwords.push(...itemValues([item], ["value", "password", "pass"]));
  }
  return { passwords, pairs };
}

function emailUsers(items: unknown): string[] {
  const out: string[] = [];
  for (const email of itemValues(items, ["value", "email"])) {
    const local = email.split("@")[0]?.trim() || "";
    if (local) out.push(local);
  }
  return out;
}

function looksLikePassword(text: string): boolean {
  if (text.length < 3 || text.length > 64) return false;
  if (/\s/.test(text)) return false;
  if (text.includes("/")) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}\b/.test(text)) return false;
  return true;
}

export function recentYears(now = new Date()): string[] {
  const year = now.getFullYear();
  const out: string[] = [];
  for (let y = year; y >= year - YEAR_LOOKBACK; y--) out.push(String(y));
  return out;
}

function yearsFromTexts(texts: string[], now = new Date()): string[] {
  const found: string[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(/(?:^|[^0-9])((?:19|20)\d{2})(?![0-9])/g)) {
      if (match[1]) found.push(match[1]);
    }
  }
  return uniqCap([...recentYears(now), ...found]);
}

function caseVariants(token: string): string[] {
  const lower = token.toLowerCase();
  const titled = lower.charAt(0).toUpperCase() + lower.slice(1);
  return uniqCap([token, lower, titled]);
}

/** Latin login only: `alice.smith` → logins + initials `as`. No CJK/pinyin invention. */
export function loginHandles(raw: string): { logins: string[]; initials: string[] } {
  const text = raw.trim();
  if (!/^[A-Za-z][A-Za-z0-9._-]{1,31}$/.test(text)) return { logins: [], initials: [] };
  const compact = text.replace(/[._-]/g, "");
  const logins = caseVariants(compact);
  const parts = text.split(/[._-]+/).filter(Boolean);
  const initials = parts.length >= 2 ? [parts.map((p) => (p[0] || "").toLowerCase()).join("")] : [];
  return { logins, initials };
}

export function brandTokens(texts: string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (!/\s/.test(trimmed) && looksLikePassword(trimmed) && trimmed.length <= 24) {
      out.push(...caseVariants(trimmed));
    }
    for (const match of trimmed.matchAll(/[A-Za-z][A-Za-z0-9._-]{2,23}/g)) {
      const raw = match[0];
      const low = raw.toLowerCase();
      if (BRAND_STOP.has(low.split(/[._-]/)[0] || "")) continue;
      if (/\d/.test(raw)) continue;
      out.push(...caseVariants(raw));
    }
  }
  return uniqCap(out);
}

export function inferPasswordTemplates(password: string, user?: string): string[] {
  const pass = password.trim();
  if (!looksLikePassword(pass)) return [];
  const out: string[] = [];
  const u = (user || "").trim();
  const service = Boolean(u && isServiceLogin(u));
  if (u && !service && pass.toLowerCase().startsWith(u.toLowerCase()) && pass.length > u.length) {
    out.push("{Name}" + pass.slice(u.length));
  }
  let match = pass.match(/^([A-Za-z]{2,24})(\d{3,8})$/);
  if (match && !service && !isServiceLogin(match[1] || "")) out.push("{Name}" + match[2]);
  match = pass.match(/^([A-Za-z]{1,4})(\d{3,8})$/);
  if (match && !service) out.push("{Initials}" + match[2]);
  match = pass.match(/^([A-Za-z][A-Za-z0-9]*)@(\d{3,4})$/);
  if (match?.[2]) {
    const tail = match[2];
    const headIsService = isServiceLogin(match[1] || "");
    if (tail.length === 4) {
      if (!service && !headIsService) out.push("{Name}@{Year}");
      out.push("{Product}@{Year}");
    } else {
      if (!service && !headIsService) out.push("{Name}@" + tail);
      out.push("{Product}@" + tail);
    }
  }
  return uniqCap(out);
}

function expandPattern(
  pattern: string,
  bags: { name: string[]; year: string[]; product: string[]; org: string[]; initials: string[] },
): string[] {
  const text = pattern.trim();
  if (!text) return [];
  if (!/\{[A-Za-z][A-Za-z0-9]*\}/.test(text)) {
    return looksLikePassword(text) ? [text] : [];
  }
  const tokens = [...text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((m) => (m[1] || "").toLowerCase());
  if (tokens.some((tok) => !PATTERN_TOKEN[tok])) return [];

  const parts: Array<{ lit?: string; key?: "name" | "year" | "product" | "org" | "initials" }> = [];
  const re = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const name = (match[1] || "").toLowerCase();
    if (match.index > last) parts.push({ lit: text.slice(last, match.index) });
    parts.push({ key: PATTERN_TOKEN[name] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ lit: text.slice(last) });

  let out = [""];
  for (const part of parts) {
    if (part.lit != null) {
      out = out.map((s) => s + part.lit);
      continue;
    }
    const vals = bags[part.key!];
    if (!vals.length) return [];
    const next: string[] = [];
    for (const prefix of out) {
      for (const val of vals) next.push(prefix + val);
    }
    out = next;
  }
  return out;
}

function uniqCap(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = value.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function uniqCapPairs(values: { user: string; password: string }[]): { user: string; password: string }[] {
  const seen = new Set<string>();
  const out: { user: string; password: string }[] = [];
  for (const pair of values) {
    const key = `${pair.user}:${pair.password}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pair);
  }
  return out;
}

function isServiceLogin(user: string): boolean {
  return SERVICE_LOGINS.has(user.trim().toLowerCase());
}

function challengeBrandHints(workspace?: string | null): string[] {
  if (!workspace) return [];
  const p = join(workspace, "input.json");
  if (!existsSync(p)) return [];
  try {
    const doc = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return [];
    const rec = doc as Record<string, unknown>;
    const texts = [rec.description, rec.name, rec.title].filter((x): x is string => typeof x === "string");
    return brandTokens(texts);
  } catch {
    return [];
  }
}

export function emptySprayMeta(): SprayDictMeta {
  return {
    rev: 0,
    status: "empty",
    creds: 0,
    users: 0,
    passwords: 0,
    sha256: "",
    generated_at: 0,
    updated_at: 0,
  };
}

export function loadSprayMeta(workspace?: string | null): SprayDictMeta {
  const p = sprayMetaJson(workspace);
  if (!existsSync(p)) return emptySprayMeta();
  try {
    const doc = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return emptySprayMeta();
    const rec = doc as Record<string, unknown>;
    const status = rec.status === "ready" || rec.status === "updated" || rec.status === "empty" ? rec.status : "empty";
    return {
      rev: Math.max(0, Number(rec.rev || 0) || 0),
      status,
      creds: Math.max(0, Number(rec.creds || 0) || 0),
      users: Math.max(0, Number(rec.users || 0) || 0),
      passwords: Math.max(0, Number(rec.passwords || 0) || 0),
      sha256: String(rec.sha256 || "").trim(),
      generated_at: Number(rec.generated_at || 0) || 0,
      updated_at: Number(rec.updated_at || 0) || 0,
    };
  } catch {
    return emptySprayMeta();
  }
}

function credsDigest(creds: string[]): string {
  if (!creds.length) return "";
  return createHash("sha256").update(creds.join("\n") + "\n", "utf8").digest("hex");
}

function nextSprayMeta(prev: SprayDictMeta, counts: { creds: string[]; users: string[]; passwords: string[] }): SprayDictMeta {
  const now = nowSec();
  const sha256 = credsDigest(counts.creds);
  const base = {
    creds: counts.creds.length,
    users: counts.users.length,
    passwords: counts.passwords.length,
    sha256,
    updated_at: now,
  };
  if (!counts.creds.length) {
    return { ...prev, ...base, status: "empty", sha256: "", updated_at: now };
  }
  if (prev.sha256 && sha256 === prev.sha256) {
    return { ...prev, ...base, status: "ready", updated_at: prev.updated_at || now };
  }
  if (prev.rev >= 1) {
    return {
      ...base,
      rev: prev.rev + 1,
      status: "updated",
      generated_at: prev.generated_at || now,
    };
  }
  return { ...base, rev: 1, status: "ready", generated_at: now };
}

export function rebuildSprayDict(workspace?: string | null, options: { loot?: Record<string, unknown>; write?: boolean } = {}): { files: Record<string, string>; meta: SprayDictMeta; contents: Record<string, string> } {
  const loot = options.loot || loadLoot(workspace);
  const fromPasswords = splitLootPasswords(loot.passwords);
  const pairs = uniqCapPairs([...parseCreds(loot.creds), ...fromPasswords.pairs]);
  const orgNames = itemValues(loot.org_names, ["value", "name"]);
  const products = itemValues(loot.products, ["value", "name"]);
  const productTokens = uniqCap([...brandTokens(products), ...challengeBrandHints(workspace)]);
  const orgTokens = brandTokens(orgNames);
  const rawUsers = uniqCap([
    ...itemValues(loot.users, ["value", "user", "username", "name"]),
    ...pairs.map((p) => p.user),
    ...emailUsers(loot.emails),
  ]);
  const extraLogins: string[] = [];
  const extraInitials: string[] = [];
  for (const user of rawUsers) {
    if (isServiceLogin(user)) continue;
    const handles = loginHandles(user);
    extraLogins.push(...handles.logins);
    extraInitials.push(...handles.initials);
  }
  const defaults = loadDefaultLoginPasswords();
  const lootPasswords = fromPasswords.passwords;
  const lootPatterns = [
    ...itemValues(loot.patterns, ["value", "pattern"]),
    ...itemValues(loot.password_patterns, ["value", "pattern"]),
  ];
  const years = yearsFromTexts([...lootPasswords, ...pairs.map((p) => p.password), ...lootPatterns]);
  const identityNames = uniqCap(extraLogins.length ? extraLogins : rawUsers.filter((u) => !isServiceLogin(u)));
  const names = uniqCap(identityNames);
  const bags = {
    name: names,
    year: years,
    product: productTokens,
    org: orgTokens,
    initials: uniqCap(extraInitials),
  };
  const installPatterns = productTokens.length || orgTokens.length ? PRODUCT_INSTALL_PATTERNS : [];
  const inferredPatterns = uniqCap([
    ...lootPasswords.flatMap((p) => inferPasswordTemplates(p)),
    ...pairs.flatMap((p) => inferPasswordTemplates(p.password, p.user)),
    ...lootPatterns,
    ...installPatterns,
  ]);
  const identityPasswords = inferredPatterns
    .flatMap((pat) => expandPattern(pat, { ...bags, name: identityNames }))
    .filter(looksLikePassword);
  const patternPasswords = inferredPatterns.flatMap((pat) => expandPattern(pat, bags));
  const brandPasswords = inferredPatterns
    .filter((pat) => /\{(?:Product|Org)\}/i.test(pat))
    .flatMap((pat) => expandPattern(pat, bags))
    .filter(looksLikePassword);
  const fileServices = brandPasswords.length ? [...FILE_SERVICE_LOGINS] : [];
  const users = uniqCap(["admin", ...rawUsers, ...extraLogins, ...extraInitials, ...fileServices]);
  const passwords = uniqCap([
    ...defaults,
    ...lootPasswords,
    ...pairs.map((p) => p.password),
    ...brandPasswords,
    ...identityPasswords,
    ...patternPasswords,
    ...orgTokens,
    ...productTokens.filter(looksLikePassword),
  ]);
  const serviceUsers = uniqCap([
    ...rawUsers.filter(isServiceLogin),
    ...(brandPasswords.length ? ["admin", ...FILE_SERVICE_LOGINS] : []),
  ]);
  const brandCreds = serviceUsers.flatMap((user) => brandPasswords.map((password) => `${user}:${password}`));
  const identityCreds = uniqCap([...identityNames, ...extraInitials]).flatMap((user) =>
    identityPasswords.map((password) => `${user}:${password}`),
  );
  const defaultCreds = defaults.map((password) => `admin:${password}`);
  const creds = uniqCap([
    ...defaultCreds,
    ...pairs.map((p) => `${p.user}:${p.password}`),
    ...brandCreds,
    ...identityCreds,
  ]);
  const files = {
    users: sprayUsersTxt(workspace),
    passwords: sprayPasswordsTxt(workspace),
    creds: sprayCredsTxt(workspace),
  };
  const meta = nextSprayMeta(loadSprayMeta(workspace), { creds, users, passwords });
  const contents = {
    "spray_users.txt": users.length ? users.join("\n") + "\n" : "",
    "spray_passwords.txt": passwords.length ? passwords.join("\n") + "\n" : "",
    "spray_creds.txt": creds.length ? creds.join("\n") + "\n" : "",
    "spray_meta.json": JSON.stringify(meta, null, 2) + "\n",
  };
  if (options.write !== false && !hasObservationPublication(workspace)) {
    atomicWrite(files.users, contents["spray_users.txt"]);
    atomicWrite(files.passwords, contents["spray_passwords.txt"]);
    atomicWrite(files.creds, contents["spray_creds.txt"]);
    atomicWrite(sprayMetaJson(workspace), contents["spray_meta.json"]);
  }
  return { files, meta, contents };
}
