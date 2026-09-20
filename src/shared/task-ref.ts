export type TaskRef = { projectId: string | null; code: string };

/** JSON encoding avoids collisions between project IDs and challenge codes. */
export function taskKey(code: string, projectId?: string | null): string {
  return JSON.stringify([projectId || "", code]);
}

export const ACTIVE_JOB_STATES = ["queued", "starting", "running", "stopping"] as const;
export const activeJob = (row: Record<string, unknown>): boolean =>
  (ACTIVE_JOB_STATES as readonly string[]).includes(String(row.status));
