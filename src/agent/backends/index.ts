import type { AgentSettings } from "../config.js";
import { ClaudeBackend } from "./claude.js";
import { PiBackend } from "./pi.js";
import { PiRpcBackend } from "./pi-rpc.js";
import type { Backend } from "./types.js";

export type { AgentRunResult, Backend, BackendRunOpts } from "./types.js";
export { PiBackend } from "./pi.js";
export { PiRpcBackend } from "./pi-rpc.js";
export { ClaudeBackend } from "./claude.js";

export function resolveBackend(settings: AgentSettings): { name: string; backend: Backend } {
  if (settings.backend === "sdk") {
    return { name: "sdk", backend: new ClaudeBackend() };
  }
  if (settings.backend === "cli") {
    throw new Error("cli backend is not ported; use pi or sdk");
  }
  if (settings.piTransport === "rpc") {
    return { name: "pi", backend: new PiRpcBackend() };
  }
  return { name: "pi", backend: new PiBackend({ noContextFiles: true }) };
}
