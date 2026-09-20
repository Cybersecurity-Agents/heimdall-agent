export function flagOn(raw: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(raw ?? "").trim().toLowerCase());
}

export function envBool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return flagOn(raw);
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function envStr(...names: string[]): string {
  for (const name of names) {
    const v = (process.env[name] || "").trim();
    if (v) return v;
  }
  return "";
}
