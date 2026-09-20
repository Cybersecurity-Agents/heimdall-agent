import { hasObservationPublication } from "../shared/observation-publication.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { wrapBrief } from "../agent/observe.js";
import { atomicWrite, nowSec } from "../shared/fsutil.js";
import {
  advisorBriefMd,
  confirmedMd,
  generatedBriefMd,
  injectTxt,
  mapMd,
  trafficDir,
  workspaceDir,
} from "../shared/paths.js";
import { currentJobId } from "./recap-state.js";
import { sprayEnabled } from "./spray.js";
import { stripSpraySummaries } from "./spray-stamp.js";

export type JobSteerOpts = {
  jobId?: string;
  challengeType?: string;
};

function steerJobPath(workspace?: string | null): string {
  return join(trafficDir(workspace), "steer_job.json");
}

function readText(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function rewrite(path: string, next: string): void {
  if (!next) return;
  const prev = readText(path);
  if (prev === next) return;
  atomicWrite(path, next);
}

function scrub(text: string): string {
  return stripSpraySummaries(text);
}

/**
 * At job start, drop leftover DICT / spray_*.txt todos when dictionaries are disabled
 * so the solver does not treat the previous attempt's dictionary as a duty.
 * Idempotent per jobId. Does not delete spray files.
 * Cleanup never creates a coverage map or marks one as published.
 */
export function seedJobSteer(workspace?: string | null, opts: JobSteerOpts = {}): boolean {
  if (hasObservationPublication(workspace)) return false;
  const ws = workspaceDir(workspace);
  const jobId = String(opts.jobId || currentJobId(ws) || "").trim();
  if (!jobId) return false;
  const marker = steerJobPath(ws);
  try {
    if (existsSync(marker)) {
      const prev = JSON.parse(readFileSync(marker, "utf8")) as { jobId?: string };
      if (String(prev.jobId || "") === jobId) return false;
    }
  } catch {
    /* rewrite */
  }
  const dictionaryEnabled = sprayEnabled(ws);
  if (!dictionaryEnabled) {
    const inj = injectTxt(ws);
    if (existsSync(inj)) rewrite(inj, scrub(readText(inj)));
    const confirmed = confirmedMd(ws);
    if (existsSync(confirmed)) rewrite(confirmed, scrub(readText(confirmed)));
    const map = mapMd(ws);
    if (existsSync(map)) rewrite(map, scrub(readText(map)));
    const brief = generatedBriefMd(ws);
    if (existsSync(brief) && readText(brief).trim()) {
      const next = scrub(readText(brief));
      rewrite(brief, next.endsWith("\n") ? next : next + "\n");
      const wrapped = wrapBrief(next, ws);
      if (wrapped) rewrite(advisorBriefMd(ws), wrapped);
    }
  }
  atomicWrite(
    marker,
    JSON.stringify(
      {
        jobId,
        challengeType: String(opts.challengeType || "").trim(),
        spray: dictionaryEnabled,
        seededAt: nowSec(),
      },
      null,
      2,
    ) + "\n",
  );
  return true;
}
