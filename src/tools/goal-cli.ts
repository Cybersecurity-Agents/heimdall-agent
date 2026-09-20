import { join } from "node:path";
import { goalRequest, managedGoal, readJsonObject, atomicJson } from "../shared/goal.js";
import { isChallengeComplete, isDirectWorkspace } from "../shared/completion.js";
import { TsecClient } from "../platforms/tsec/client.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const workspace = process.env.HEIMDALL_WORKSPACE || process.cwd();
  try {
    if (argv[0] && !["status", "check"].includes(argv[0])) throw new Error("Usage: heimdall-goal status|check [--json] [--refresh]");
    let verdict: Record<string, unknown>;
    if (managedGoal(workspace)) verdict = await goalRequest(workspace, argv[0] === "check" || argv.includes("--refresh") ? "check" : "status");
    else {
      const input = readJsonObject(join(workspace, "input.json"));
      if (!isDirectWorkspace(workspace) && (argv[0] === "check" || argv.includes("--refresh"))) {
        const challenge = (await new TsecClient().listChallenges()).find(c => c.unique_code === input.unique_code);
        if (!challenge) throw new Error("Challenge not found on platform");
        atomicJson(join(workspace, "input.json"), { ...input, is_completed: challenge.is_completed, flag_count: challenge.flag_count,
          correct_flag_count: challenge.correct_flag_count });
      }
      verdict = { state: isChallengeComplete(workspace) ? "satisfied" : "unsatisfied", assurance: isDirectWorkspace(workspace) ? "recorded" : "platform_verified" };
    }
    console.log(JSON.stringify(verdict));
    return verdict.state === "satisfied" ? 0 : verdict.state === "unsatisfied" ? 1 : 2;
  } catch (e) { console.log(JSON.stringify({ state: "unknown", reason: String(e) })); return 2; }
}
if (/goal-cli\.(js|ts)$/.test(process.argv[1] || "")) void main().then(code => { process.exitCode = code; });
