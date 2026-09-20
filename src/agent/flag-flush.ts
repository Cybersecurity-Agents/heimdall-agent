import { spawn, type ChildProcess } from "node:child_process";
import { isChallengeComplete } from "../shared/completion.js";
import { managedGoal } from "../shared/goal.js";

const running = new Map<string, { child: ChildProcess; done: Promise<void> }>();

export function flushWorkspace(workspace: string): Promise<void> {
  // The controller submits managed candidates with one serialized ledger.
  if (managedGoal(workspace) || isChallengeComplete(workspace)) return Promise.resolve();
  const existing = running.get(workspace);
  if (existing) return existing.done;
  const child = spawn(process.env.HEIMDALL_SUBMIT_BIN || "heimdall-submit", [], { cwd: workspace, env: process.env, stdio: "ignore" });
  const done = new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const finish = () => { clearTimeout(timer); running.delete(workspace); resolve(); };
    child.once("error", finish); child.once("close", finish);
  });
  running.set(workspace, { child, done });
  return done;
}

export function watchFlags(workspace: string, intervalSec = 2): () => void {
  if (managedGoal(workspace)) return () => {};
  const timer = setInterval(() => { void flushWorkspace(workspace); }, Math.max(1, intervalSec) * 1000);
  timer.unref();
  return () => { clearInterval(timer); running.get(workspace)?.child.kill("SIGKILL"); };
}
