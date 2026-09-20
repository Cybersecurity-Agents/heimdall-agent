import { envBool, envInt } from "../shared/env.js";

export type AgentSettings = {
  backend: "pi" | "sdk" | "cli" | "auto";
  workspace: string;
  uniqueCode: string;
  jobId: string;
  attemptN: number;
  permissionMode: string;
  maxTurns: number;
  model: string | null;
  allowCliFallback: boolean;
  loop: boolean;
  loopTimeoutSec: number;
  sessionId: string | null;
  allowSdkFallback: boolean;
  sessionFile: string | null;
  piTransport: "sdk" | "rpc";
};

export function heimdallDir(ws: string): string {
  return `${ws.replace(/\/+$/, "")}/.heimdall`;
}

export function loadSettings(): AgentSettings {
  const workspace = (process.env.HEIMDALL_WORKSPACE || "/workspace").replace(/\/+$/, "");
  let backend = (process.env.HEIMDALL_AGENT_BACKEND || "pi").trim().toLowerCase();
  if (!["pi", "sdk", "cli", "auto"].includes(backend)) backend = "pi";
  let model =
    process.env.HEIMDALL_AGENT_MODEL ||
    process.env.OPENAI_MODEL ||
    process.env.ANTHROPIC_MODEL ||
    null;
  if (model !== null && !String(model).trim()) model = null;
  const transport = (process.env.HEIMDALL_PI_TRANSPORT || "sdk").trim().toLowerCase();
  return {
    backend: backend as AgentSettings["backend"],
    workspace,
    uniqueCode: process.env.UNIQUE_CODE || "",
    jobId: process.env.HEIMDALL_JOB_ID || "",
    attemptN: envInt("ATTEMPT_N", 1),
    permissionMode: (process.env.HEIMDALL_PERMISSION_MODE || "bypassPermissions").trim(),
    maxTurns: envInt("HEIMDALL_MAX_TURNS", 0),
    model,
    allowCliFallback: envBool("HEIMDALL_ALLOW_CLI_FALLBACK", true),
    loop: envBool("HEIMDALL_LOOP", false),
    loopTimeoutSec: envInt("HEIMDALL_LOOP_TIMEOUT_SEC", 3600),
    sessionId: (process.env.HEIMDALL_SESSION_ID || "").trim() || null,
    allowSdkFallback: envBool("HEIMDALL_ALLOW_SDK_FALLBACK", false),
    sessionFile: (process.env.HEIMDALL_SESSION_FILE || "").trim() || null,
    piTransport: transport === "rpc" ? "rpc" : "sdk",
  };
}
