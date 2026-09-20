import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export function claudeConfigDir(workspace: string): string {
  return join(workspace, ".heimdall", "claude");
}

export function sessionPath(workspace: string): string {
  return join(workspace, ".heimdall", "session.json");
}

export function piSessionsDir(workspace: string): string {
  return join(workspace, ".heimdall", "pi", "sessions");
}

export function loadSession(workspace: string): Record<string, unknown> {
  const path = sessionPath(workspace);
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function clearSession(workspace: string, reason?: string): void {
  const path = sessionPath(workspace);
  mkdirSync(dirname(path), { recursive: true });
  const doc: Record<string, unknown> = { dead: true, updated_at: Date.now() / 1000 };
  if (reason) doc.dead_reason = reason.slice(0, 400);
  try {
    writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", "utf8");
  } catch {
    /* ignore */
  }
}

export function saveSession(
  workspace: string,
  sessionId?: string | null,
  extra: Record<string, unknown> = {},
): void {
  if (!sessionId && Object.keys(extra).length === 0) return;
  const path = sessionPath(workspace);
  mkdirSync(dirname(path), { recursive: true });
  const doc = loadSession(workspace);
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null) doc[k] = v;
  }
  if (sessionId) doc.session_id = String(sessionId);
  doc.updated_at = Date.now() / 1000;
  try {
    writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", "utf8");
  } catch {
    /* ignore */
  }
}

function anyJsonl(root: string): boolean {
  if (!existsSync(root)) return false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(dir, name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) stack.push(p);
        else if (name.endsWith(".jsonl")) return true;
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

export function sessionTranscriptsExist(workspace: string): boolean {
  if (anyJsonl(join(claudeConfigDir(workspace), "projects"))) return true;
  if (anyJsonl(piSessionsDir(workspace))) return true;
  const raw = loadSession(workspace).session_file;
  if (raw) {
    try {
      return existsSync(String(raw));
    } catch {
      return false;
    }
  }
  return false;
}
