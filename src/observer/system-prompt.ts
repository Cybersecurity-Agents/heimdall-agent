import { loadPrompt } from "../shared/resources.js";
import { sprayEnabled } from "./spray.js";
import { OBSERVATION_EXAMPLE, OBSERVATION_TRIED_EXAMPLE } from "./contract.js";

const FALLBACK = "You are the CTF Observer. Call observation_context, judge the evidence, then observation_submit. The host generates CONFIRMED.md and the map.\n";

function joinPromptParts(base: string, extra: string): string {
  const head = base.trimEnd();
  const tail = extra.trim();
  if (!tail) return head ? head + "\n" : "";
  return (head ? head + "\n\n" : "") + tail + "\n";
}

/** Baseline observer system prompt with the credential dictionary module when enabled. */
export function loadObserverSystem(workspace?: string | null): string {
  let base = FALLBACK;
  try {
    base = loadPrompt("observer");
  } catch {
    /* bundled prompt missing in a broken install */
  }
  base = joinPromptParts(base, "Tool-call requirements: pass upserts/retireIds/attempts/evidenceRefs as native JSON arrays and guidance as a native JSON object, never JSON-encoded strings. Keep each update small. IDs start, recon, spray-dict and the host-flag- prefix belong to the host; choose a specific judgment ID such as auth-logic or service-discovery. Do not submit these system nodes. A response with ok:false is a failed publication; continue correcting the reported fields until ok:true means a new map is available. Do not replace evidence-backed judgments with an empty update merely to bypass errors.");
  base = joinPromptParts(base, "Submission example (replace its judgments and references with this job’s real evidence):\n```json\n" + JSON.stringify(OBSERVATION_EXAMPLE, null, 2) + "\n```");
  base = joinPromptParts(base, "Tried-judgment example: unlike inferred-open, a tried status requires an actual attempt with execution evidence. These are fictional example facts; replace every action, result and reference with this window’s real evidence:\n```json\n" + JSON.stringify(OBSERVATION_TRIED_EXAMPLE, null, 2) + "\n```");
  if (!sprayEnabled(workspace)) return base.endsWith("\n") ? base : base + "\n";
  try {
    return joinPromptParts(base, loadPrompt("observer-spray"));
  } catch {
    return base.endsWith("\n") ? base : base + "\n";
  }
}
