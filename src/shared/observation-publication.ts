import { existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const root = (ws?: string | null): string => join(ws || process.env.HEIMDALL_WORKSPACE || "/workspace", ".heimdall", "traffic");
export const observationPointer = (ws?: string | null): string => join(root(ws), "observation-current");

/** Resolve once when reading several artifacts: every file then belongs to one revision. */
export function publicationDir(ws?: string | null): string {
  const dir = root(ws);
  if (!existsSync(observationPointer(ws))) return dir;
  const relative = readlinkSync(observationPointer(ws));
  if (!/^observations\/[a-f0-9-]{36}$/.test(relative)) throw new Error("invalid observation publication pointer");
  return join(dir, relative);
}
export function publishedArtifact(ws: string | null | undefined, name: string): string {
  return join(publicationDir(ws), name);
}
export function hasObservationPublication(ws?: string | null): boolean {
  return existsSync(observationPointer(ws));
}

function point(ws: string, revision: string): void {
  const temp = `${observationPointer(ws)}.${randomUUID()}.tmp`;
  try {
    symlinkSync(`observations/${revision}`, temp);
    renameSync(temp, observationPointer(ws));
  } finally { rmSync(temp, { force: true }); }
}

/** Immutable artifacts first; a single symlink rename commits every artifact, including legacy file aliases. */
export function commitObservationPublication(ws: string, revision: string, artifacts: Record<string, string>): void {
  if (!/^[a-f0-9-]{36}$/.test(revision)) throw new Error("invalid observation revision");
  const dir = join(root(ws), "observations", revision);
  mkdirSync(join(root(ws), "observations"), { recursive: true });
  mkdirSync(dir);
  try {
    for (const [name, body] of Object.entries(artifacts)) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error("invalid observation artifact name");
      writeFileSync(join(dir, name), body, { mode: 0o644 });
    }
    if (!hasObservationPublication(ws)) {
      // Preserve existing files while installing aliases on the first structured publication.
      const previous = randomUUID(), bootstrap = join(root(ws), "observations", previous);
      mkdirSync(bootstrap);
      for (const name of Object.keys(artifacts)) {
        const old = join(root(ws), name);
        if (existsSync(old)) writeFileSync(join(bootstrap, name), readFileSync(old), { mode: 0o644 });
      }
      point(ws, previous);
    }
    for (const name of Object.keys(artifacts)) {
      const alias = join(root(ws), name), target = `observation-current/${name}`;
      try { if (readlinkSync(alias) === target) continue; } catch { /* replace legacy regular file */ }
      const temp = `${alias}.${randomUUID()}.tmp`;
      try { symlinkSync(target, temp); renameSync(temp, alias); }
      finally { rmSync(temp, { force: true }); }
    }
    point(ws, revision);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
