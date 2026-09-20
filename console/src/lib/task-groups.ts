import type { Campaign, Task } from "../types";

export function taskGroups(tasks: Task[], campaign: Campaign) {
  const seen = new Set<string>();
  const byCode = new Map(tasks.filter(t => t.code).map(t => [t.code!, t]));
  const pick = (codes: string[] = []) => codes.flatMap(code => {
    const task = byCode.get(code);
    if (!task || seen.has(task.id)) return [];
    seen.add(task.id);
    return [task];
  });
  const live = pick(campaign.running);
  const retry = pick(campaign.retry_wait);
  const queue = pick(campaign.pending);
  const done = pick(campaign.done);
  const unfinished = pick(campaign.unfinished);
  const remaining = tasks.filter(t => !seen.has(t.id));
  return { live, retry, queue, done, unfinished,
    urls: remaining.filter(t => t.kind === "url"), rest: remaining.filter(t => t.kind !== "url") };
}
