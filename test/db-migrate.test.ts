import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

function node22(): string | null {
  const candidates = [
    process.env.HEIMDALL_NODE,
    "/home/who/.local/lib/heimdall-node/bin/node",
    process.execPath,
  ].filter(Boolean) as string[];
  for (const bin of candidates) {
    if (!existsSync(bin)) continue;
    try {
      const ver = execFileSync(bin, ["-p", "process.versions.node"], { encoding: "utf8" }).trim();
      if (Number.parseInt(ver.split(".")[0] || "0", 10) >= 22) return bin;
    } catch {
      continue;
    }
  }
  return null;
}

const TS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NODE22 = node22();

describe.skipIf(!NODE22)("sqlite migrate", () => {
  it("adds job columns and loop_queue on an old schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "heimdall-db-"));
    dirs.push(dir);
    const path = join(dir, "old.db");
    const script = `
import { DatabaseSync } from "node:sqlite";
import { Database } from ${JSON.stringify(join(TS_ROOT, "src/shared/db.ts"))};
const path = ${JSON.stringify(path)};
const raw = new DatabaseSync(path);
raw.exec(\`CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  unique_code TEXT NOT NULL,
  mode TEXT,
  attempt_n INTEGER DEFAULT 1,
  status TEXT NOT NULL,
  image TEXT,
  container_id TEXT,
  workspace_path TEXT,
  job_dir TEXT,
  started_at REAL,
  finished_at REAL,
  exit_code INTEGER,
  error TEXT,
  created_at REAL
)\`);
raw.close();
const db = new Database(path);
db.enqueueLoop("task-1", { reason: "migrate" });
if (!db.getLoopEntry("task-1")) throw new Error("loop_queue missing");
const id = db.createJob({
  uniqueCode: "task-1",
  attemptN: 1,
  status: "queued",
  image: "heimdall:console",
  workspacePath: "/tmp",
  jobDir: "/tmp",
  projectId: "p_test",
  jobKind: "regular",
  timeoutSec: 1800,
});
const job = db.getJob(id);
if (!job || job.project_id !== "p_test" || job.job_kind !== "regular") {
  throw new Error("jobs columns missing: " + JSON.stringify(job));
}
`;
    const out = execFileSync(NODE22!, ["--import", "tsx", "-e", script], {
      cwd: TS_ROOT,
      encoding: "utf8",
    });
    expect(out).toBeDefined();
  });
});
