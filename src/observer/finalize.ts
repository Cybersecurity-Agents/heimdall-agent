import { join } from "node:path";
import { PiBackend } from "../agent/backends/pi.js";
import { EventSink } from "../shared/events.js";
import { applyCoachLlmEnv } from "../shared/pi-workspace.js";
import { acquireObserverLease } from "./lease.js";
import { observePiDir, observerEnabled, seedObserverDir } from "./loop.js";
import { pendingRecap, readRecapState, setRecapState } from "./recap-state.js";
import { RECAP_TOOLS, runRecap } from "./recap.js";

/** Separate process: does not inherit solver timeout or mutate daemon LLM env. */
export async function finalizeObserver(ws: string, retry = false): Promise<boolean> {
  const request = pendingRecap(ws);
  if (!request) return true;
  if (process.env.HEIMDALL_RECAP_REQUEST_ID && request.id !== process.env.HEIMDALL_RECAP_REQUEST_ID) return true;
  if (!observerEnabled()) { setRecapState(ws, request, "disabled"); return true; }
  const state = readRecapState(ws);
  if (!retry && state?.requestId === request.id && state.status === "published") return true;
  const lease = acquireObserverLease(ws);
  // Another process owns publication; the control plane will recover if it dies.
  if (!lease) return true;
  const terminate = (): void => { lease.release(); process.exit(1); };
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  const events = new EventSink(join(ws, ".heimdall", "observer.events.jsonl"), join(ws, ".heimdall", "observer.log"));
  const backend = new PiBackend({ tools: [...RECAP_TOOLS], noContextFiles: true,
    skipWorkspaceSeed: true, persistSession: false, agentDir: observePiDir });
  try {
    applyCoachLlmEnv();
    seedObserverDir(ws);
    return await runRecap(ws, request, backend, events, lease.owns);
  } finally {
    await backend.close();
    events.close();
    lease.release();
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGINT", terminate);
  }
}
