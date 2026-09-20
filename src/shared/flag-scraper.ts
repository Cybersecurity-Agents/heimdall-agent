import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FLAG_PATTERNS = [
  /\bflag\{[^{}\n]{1,512}\}/gi,
  /\bctf\{[^{}\n]{1,512}\}/gi,
  /\bhack\{[^{}\n]{1,512}\}/gi,
];

export function looksLikeFlag(value: string): boolean {
  return /^(flag|ctf|hack)\{[^{}\n]{1,512}\}$/i.test(String(value || "").trim());
}

export function extractFromText(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const pat of FLAG_PATTERNS) {
    pat.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(text || ""))) {
      const flag = m[0]!.trim();
      if (!seen.has(flag)) {
        seen.add(flag);
        found.push(flag);
      }
    }
  }
  return found;
}

export function extractFromFlagsJson(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const out: string[] = [];
    const push = (item: unknown) => {
      if (typeof item === "string") out.push(item);
      else if (item && typeof item === "object" && (item as { flag?: unknown }).flag) {
        out.push(String((item as { flag: unknown }).flag));
      }
    };
    if (Array.isArray(data)) data.forEach(push);
    else if (data && typeof data === "object") {
      const rec = data as { flag?: unknown; flags?: unknown[] };
      if (rec.flag) out.push(String(rec.flag));
      (rec.flags || []).forEach(push);
    }
    return out;
  } catch {
    return [];
  }
}

export function scrapeWorkspace(workspace: string, extraFiles: string[] = []): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const addAll = (items: string[]) => {
    for (const raw of items) {
      const f = raw.trim();
      if (f && !seen.has(f)) {
        seen.add(f);
        candidates.push(f);
      }
    }
  };
  addAll(extractFromFlagsJson(join(workspace, "flags.json")));
  for (const rel of ["progress.md", "findings.json", "result.json", ...extraFiles]) {
    const p = rel.includes("/") || rel.startsWith("/") ? rel : join(workspace, rel);
    if (!existsSync(p)) continue;
    try {
      addAll(extractFromText(readFileSync(p, "utf8")));
    } catch {
      /* skip */
    }
  }
  const art = join(workspace, "artifacts");
  if (existsSync(art)) {
    const walk = (dir: string) => {
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const p = join(dir, name);
        try {
          const st = statSync(p);
          if (st.isDirectory()) walk(p);
          else if (st.isFile() && st.size < 2_000_000) {
            addAll(extractFromText(readFileSync(p, "utf8")));
          }
        } catch {
          /* skip */
        }
      }
    };
    walk(art);
  }
  return candidates;
}
