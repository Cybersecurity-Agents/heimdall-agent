import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { recapDir } from "./recap-state.js";

export function observerLeaseActive(ws: string): boolean {
  try { return Date.now() - statSync(join(recapDir(ws), "writer.lock")).mtimeMs < 30_000; }
  catch { return false; }
}

/** A filesystem lease works across the host/container PID namespaces. */
export function acquireObserverLease(ws: string): { release(): void; owns(): boolean } | null {
  const parent = recapDir(ws);
  mkdirSync(parent, { recursive: true });
  const path = join(parent, "writer.lock");
  const token = randomUUID();
  try { mkdirSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      if (Date.now() - statSync(path).mtimeMs < 30_000) return null;
      const stale = `${path}.${token}.stale`;
      renameSync(path, stale);
      rmSync(stale, { recursive: true, force: true });
      mkdirSync(path);
    } catch { return null; }
  }
  writeFileSync(join(path, "owner"), token);
  const owns = (): boolean => {
    try { return readFileSync(join(path, "owner"), "utf8") === token; } catch { return false; }
  };
  const timer = setInterval(() => {
    if (owns()) { const now = new Date(); try { utimesSync(path, now, now); } catch { /* lost lease */ } }
  }, 3000);
  timer.unref();
  return {
    owns,
    release() { clearInterval(timer); if (owns()) rmSync(path, { recursive: true, force: true }); },
  };
}
