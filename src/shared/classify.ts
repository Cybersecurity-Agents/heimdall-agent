export type TypeRule = { match: string; type: string };

export const TYPE_TO_IMAGE_KEY: Record<string, string> = {
  all: "default",
  web: "default",
  pwn: "pwn",
  ai: "default",
  aiagent: "default",
  intranet: "default",
  cve: "default",
  evasion: "pwn",
};

export function canonicalType(name: string): string {
  const raw = (name || "all").trim().toLowerCase() || "all";
  if (["full", "unified", "default"].includes(raw)) return "all";
  if (["ai", "aiagent", "ai-agent", "llm"].includes(raw)) return "web";
  if (["blockchain", "chain", "web3"].includes(raw)) return "all";
  if (raw === "pentest") return "intranet";
  if (["vuln", "generic"].includes(raw)) return "cve";
  if (
    [
      "av-evasion",
      "anti-av",
      "antievasion",
      "antivirus",
      "edr",
      "packer",
      "fud",
      "defense-evasion",
      "avbypass",
      "av-bypass",
      "bypass-av",
    ].includes(raw)
  ) {
    return "evasion";
  }
  return raw;
}

export function canonicalTimeoutType(challengeType: string | null | undefined): string {
  return canonicalType(challengeType || "");
}

export type ClassifyCfg = {
  type_overrides?: Record<string, string>;
  type_by_level?: Record<number, string>;
  type_rules?: TypeRule[];
  type_default?: string;
};

/** Compile a Python `re` pattern (`(?i)…`) so type rules stay byte-compatible. */
export function pyRe(pattern: string): RegExp | null {
  let src = pattern || "";
  let flags = "";
  const inline = src.match(/^\(\?([a-z]+)\)(.*)$/s);
  if (inline) {
    const pyFlags = inline[1] || "";
    src = inline[2] || "";
    if (pyFlags.includes("i")) flags += "i";
    if (pyFlags.includes("m")) flags += "m";
    if (pyFlags.includes("s")) flags += "s";
  }
  try {
    return new RegExp(src, flags);
  } catch {
    return null;
  }
}

export function classifyChallenge(
  uniqueCode: string,
  cfg: ClassifyCfg,
  opts: { level?: number | null; description?: string | null } = {},
): string {
  void opts.description;
  const code = (uniqueCode || "").trim();
  const folded = code.toLowerCase();
  const overrides = cfg.type_overrides || {};
  if (code && (overrides[code] || overrides[folded])) {
    return canonicalType(
      String(overrides[code] || overrides[folded])
        .trim()
        .toLowerCase() || cfg.type_default || "all",
    );
  }
  const lv = opts.level;
  const byLevel = cfg.type_by_level || {};
  if (lv !== undefined && lv !== null) {
    const mapped = byLevel[lv] ?? (byLevel as Record<string, string>)[String(lv)];
    if (mapped) {
      const t = String(mapped).trim().toLowerCase();
      if (t) return canonicalType(t);
    }
  }
  for (const rule of cfg.type_rules || []) {
    if (!rule.match) continue;
    const re = pyRe(rule.match);
    if (re && re.test(folded)) {
      return canonicalType((rule.type || cfg.type_default || "all").trim().toLowerCase());
    }
  }
  return canonicalType((cfg.type_default || "all").trim().toLowerCase());
}

export function typeToImageKey(challengeType: string): string {
  return TYPE_TO_IMAGE_KEY[canonicalType(challengeType)] || "default";
}
