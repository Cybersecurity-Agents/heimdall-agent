export function agentFree(maxSlots: number, inFlightCount: number): number {
  return Math.max(0, Math.trunc(maxSlots) - Math.trunc(inFlightCount));
}

export function newStartBudget(
  agentFreeN: number,
  platformFree: number,
  opts: { dualCapacity: boolean; blocked?: boolean },
): number {
  const af = Math.max(0, Math.trunc(agentFreeN));
  if (af <= 0) return 0;
  if (!opts.dualCapacity) return af;
  if (opts.blocked) return 0;
  return Math.min(af, Math.max(0, Math.trunc(platformFree)));
}

export function partitionReattach(
  eligible: string[],
  availableIncomplete: Iterable<string>,
  opts: { reattachEnabled: boolean },
): { reattach: string[]; start: string[] } {
  if (!opts.reattachEnabled) return { reattach: [], start: [...eligible] };
  const avail = new Set([...availableIncomplete].map((c) => String(c).trim()).filter(Boolean));
  const reattach: string[] = [];
  const start: string[] = [];
  for (const code of eligible) {
    const c = String(code).trim();
    if (!c) continue;
    if (avail.has(c)) reattach.push(c);
    else start.push(c);
  }
  return { reattach, start };
}

export type DispatchPlan = {
  reattach: string[];
  starts: string[];
  agent_free: number;
  platform_free: number;
  new_start_budget: number;
  blocked: boolean;
  planned_codes: () => Array<[string, boolean]>;
};

export function planDispatch(
  eligible: string[],
  opts: {
    maxSlots: number;
    inFlightCount: number;
    platformFree: number;
    dualCapacity: boolean;
    reattachEnabled: boolean;
    availableIncomplete: Iterable<string>;
    blocked?: boolean;
  },
): DispatchPlan {
  const af = agentFree(opts.maxSlots, opts.inFlightCount);
  const pf = opts.dualCapacity ? Math.max(0, Math.trunc(opts.platformFree)) : af;
  const budget = newStartBudget(af, pf, {
    dualCapacity: opts.dualCapacity,
    blocked: Boolean(opts.blocked),
  });
  const { reattach, start } = partitionReattach(eligible, opts.availableIncomplete, {
    reattachEnabled: opts.reattachEnabled,
  });
  const plan: DispatchPlan = {
    reattach,
    starts: start,
    agent_free: af,
    platform_free: opts.dualCapacity ? pf : af,
    new_start_budget: budget,
    blocked: Boolean(opts.blocked),
    planned_codes: () => {
      const out: Array<[string, boolean]> = [];
      let remainingAgent = plan.agent_free;
      for (const code of plan.reattach) {
        if (remainingAgent <= 0) break;
        out.push([code, true]);
        remainingAgent -= 1;
      }
      let started = 0;
      for (const code of plan.starts) {
        if (remainingAgent <= 0) break;
        if (started >= plan.new_start_budget) break;
        out.push([code, false]);
        remainingAgent -= 1;
        started += 1;
      }
      return out;
    },
  };
  return plan;
}
