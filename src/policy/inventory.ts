import type { ChallengeRow } from "./types.js";

export function isPlatformActive(ch: ChallengeRow | null | undefined): boolean {
  if (!ch) return false;
  const status = String(ch.container_status || "").toLowerCase();
  const addr = ch.container_addr ?? ch.container_addr_json;
  let addrNonempty = false;
  if (typeof addr === "string") {
    const s = addr.trim();
    addrNonempty = Boolean(s && s !== "[]" && s !== "null");
  } else {
    addrNonempty = Boolean(addr && (Array.isArray(addr) ? addr.length : true));
  }
  if (["pending", "available", "stop_pending", "starting", "running", "booting"].includes(status)) {
    return true;
  }
  if (["stopped", "closed", ""].includes(status)) {
    return status === "" ? addrNonempty : false;
  }
  return addrNonempty;
}

function codeOf(ch: ChallengeRow): string {
  return String(ch.unique_code || "");
}

function completedOf(ch: ChallengeRow): boolean {
  return Boolean(ch.is_completed);
}

export class PlatformInventory {
  platform_cap: number;
  challenges: ChallengeRow[];
  constructor(opts: { platformCap?: number; challenges?: ChallengeRow[] } = {}) {
    this.platform_cap = opts.platformCap ?? 3;
    this.challenges = opts.challenges || [];
  }
  static fromChallenges(challenges: Iterable<ChallengeRow>, opts: { platformCap?: number } = {}): PlatformInventory {
    return new PlatformInventory({ platformCap: opts.platformCap ?? 3, challenges: [...challenges] });
  }
  get active(): ChallengeRow[] {
    return this.challenges.filter((c) => isPlatformActive(c));
  }
  get active_codes(): Set<string> {
    return new Set(this.active.map(codeOf).filter(Boolean));
  }
  get platform_active(): number {
    return this.active_codes.size;
  }
  get platform_free(): number {
    return Math.max(0, Math.trunc(this.platform_cap) - this.platform_active);
  }
  completedAvailable(): ChallengeRow[] {
    return this.challenges.filter((c) => completedOf(c) && isPlatformActive(c));
  }
  incompleteAvailable(): ChallengeRow[] {
    return this.challenges.filter((c) => !completedOf(c) && isPlatformActive(c));
  }
}
