import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { publishedArtifact } from "./observation-publication.js";

export function workspaceDir(raw?: string | null): string {
  if (raw) return raw;
  return process.env.HEIMDALL_WORKSPACE || "/workspace";
}

export function trafficDir(workspace?: string | null): string {
  const d = join(workspaceDir(workspace), ".heimdall", "traffic");
  mkdirSync(d, { recursive: true });
  return d;
}

export function injectTxt(workspace?: string | null): string {
  trafficDir(workspace);
  return publishedArtifact(workspace, "inject.txt");
}

export function mapJson(workspace?: string | null): string {
  return join(trafficDir(workspace), "map.json");
}

export function mapMd(workspace?: string | null): string {
  trafficDir(workspace);
  return publishedArtifact(workspace, "map.md");
}

export function generatedBriefMd(workspace?: string | null): string {
  return join(trafficDir(workspace), "generated_brief.md");
}

export function advisorBriefMd(workspace?: string | null): string {
  return join(trafficDir(workspace), "advisor_brief.md");
}

export function confirmedMd(workspace?: string | null): string {
  const d = trafficDir(workspace);
  const dest = publishedArtifact(workspace, "CONFIRMED.md");
  if (existsSync(dest)) return dest;
  const legacy = join(d, "facts.md");
  if (existsSync(legacy)) return legacy;
  return dest;
}

export function hintTxt(workspace?: string | null): string {
  return join(workspaceDir(workspace), "hint.txt");
}

export function readText(path: string, max = 0): string {
  if (!existsSync(path)) return "";
  try {
    let text = readFileSync(path, "utf8");
    if (max > 0 && text.length > max) text = text.slice(0, max) + "\n…(truncated)…\n";
    return text;
  } catch {
    return "";
  }
}

export function jobHintText(workspace?: string | null): string {
  const ws = workspaceDir(workspace);
  for (const cand of [join(ws, "hint.txt"), platformHintJson(ws)]) {
    if (!existsSync(cand)) continue;
    let raw = readText(cand).trim();
    if (cand.endsWith(".json")) {
      try {
        const doc = JSON.parse(raw) as { hint?: unknown; text?: unknown };
        raw = String(doc.hint || doc.text || "").trim();
      } catch {
        raw = "";
      }
    }
    if (raw) return raw;
  }
  return "";
}

export function observerOkPath(workspace?: string | null): string {
  return publishedArtifact(workspace, "observer.ok");
}

export function graphJson(workspace?: string | null): string {
  trafficDir(workspace);
  return publishedArtifact(workspace, "graph.json");
}

export function mapMmd(workspace?: string | null): string {
  return join(trafficDir(workspace), "map.mmd");
}

export function mapHtml(workspace?: string | null): string {
  trafficDir(workspace);
  return publishedArtifact(workspace, "map.html");
}

export function llmDir(workspace?: string | null): string {
  return join(workspaceDir(workspace), ".heimdall", "llm");
}

export function eventsJsonl(workspace?: string | null): string {
  return join(workspaceDir(workspace), ".heimdall", "events.jsonl");
}

export function startedAtPath(workspace?: string | null): string {
  return join(workspaceDir(workspace), ".heimdall", "started_at");
}

export function platformHintJson(workspace?: string | null): string {
  return join(workspaceDir(workspace), ".heimdall", "platform_hint.json");
}

export function lootJson(workspace?: string | null): string {
  trafficDir(workspace);
  return publishedArtifact(workspace, "loot.json");
}

export function sprayUsersTxt(workspace?: string | null): string {
  trafficDir(workspace);
  return publishedArtifact(workspace, "spray_users.txt");
}

export function sprayPasswordsTxt(workspace?: string | null): string {
  trafficDir(workspace);
  return publishedArtifact(workspace, "spray_passwords.txt");
}

export function sprayCredsTxt(workspace?: string | null): string {
  trafficDir(workspace);
  return publishedArtifact(workspace, "spray_creds.txt");
}

export function sprayMetaJson(workspace?: string | null): string {
  trafficDir(workspace);
  return publishedArtifact(workspace, "spray_meta.json");
}

export function httpJsonl(workspace?: string | null): string {
  return join(trafficDir(workspace), "http.jsonl");
}

export function coverJson(workspace?: string | null): string {
  return join(trafficDir(workspace), "cover.json");
}

export function steerJson(workspace?: string | null): string {
  trafficDir(workspace);
  return publishedArtifact(workspace, "steer.json");
}

export function graphPrevJson(workspace?: string | null): string {
  trafficDir(workspace);
  return publishedArtifact(workspace, "graph.prev.json");
}

export function dagJson(workspace?: string | null): string {
  trafficDir(workspace);
  return publishedArtifact(workspace, "dag.json");
}

export function observeDagJson(workspace?: string | null): string {
  trafficDir(workspace);
  return publishedArtifact(workspace, "observe_dag.json");
}

export function migrateConfirmedMd(workspace?: string | null): string {
  const d = trafficDir(workspace);
  const dest = publishedArtifact(workspace, "CONFIRMED.md");
  const legacy = join(d, "facts.md");
  if (!existsSync(dest) && existsSync(legacy)) {
    try {
      renameSync(legacy, dest);
    } catch {
      /* ignore */
    }
  }
  return confirmedMd(workspace);
}

export function jobFlagsMd(workspace?: string | null): string {
  return join(trafficDir(workspace), "job_flags.md");
}

export function deltaMd(workspace?: string | null): string {
  return join(trafficDir(workspace), "delta.md");
}

export function turnsJsonl(workspace?: string | null): string {
  return join(trafficDir(workspace), "turns.jsonl");
}

export function turnsMd(workspace?: string | null): string {
  return join(trafficDir(workspace), "turns.md");
}

export function observeCursorJson(workspace?: string | null): string {
  return join(trafficDir(workspace), "observe_cursor.json");
}

export function observeExcerptsPendingJson(workspace?: string | null): string {
  return join(trafficDir(workspace), "observe_excerpts.pending.json");
}

export function validateErrPath(workspace?: string | null): string {
  return join(trafficDir(workspace), "validate.err");
}

export function observePiDir(workspace?: string | null): string {
  return join(workspaceDir(workspace), ".heimdall", "observe-pi");
}

export function usageJsonPath(workspace?: string | null): string {
  return join(llmDir(workspace), "usage.json");
}
