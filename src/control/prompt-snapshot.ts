import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../shared/config.js";
import { atomicWrite } from "../shared/fsutil.js";
import { readOverlayPrompt } from "./console/llm-io.js";

/** Refresh only desk-owned files; never overwrite a manual operator prompt. */
export function snapshotConsolePrompts(cfg: Config, workspace: string): void {
  const dir = join(workspace, ".heimdall", "console-prompts");
  mkdirSync(dir, { recursive: true });
  for (const [id, name] of Object.entries({
    "solver-protocol": "operator_prompt.md",
    "solver-user": "operator_user_prompt.md",
    "solver-loop": "operator_loop_followup.md",
  })) {
    const text = readOverlayPrompt(cfg, id);
    const path = join(dir, name);
    if (text.trim()) atomicWrite(path, text);
    else rmSync(path, { force: true });
  }
}
