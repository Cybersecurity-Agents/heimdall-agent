#!/usr/bin/env node
import { ensureDirs, loadConfig, type Config } from "../shared/config.js";
import { Database } from "../shared/db.js";
import { createBench, hasRemoteBench, TsecClient } from "../platforms/index.js";
import { classifyChallenge } from "../shared/classify.js";
import { Daemon } from "./daemon.js";
import { serveConsole } from "./console/http.js";
import { listProjects, getProjectStrategy, strategyToTypes } from "./console/workspace.js";
import { atomicWrite } from "../shared/fsutil.js";
import { dirname, isAbsolute, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { pendingRecap, recordAcceptedSubmit } from "../observer/recap-state.js";
import { runObserverFinalizer } from "./observer-finalize.js";
import YAML from "yaml";
import { clearProxyEnv } from "../shared/network-env.js";

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string | boolean>; rest: string[] } {
  let cmd = "";
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config" || a === "-c") {
      flags.config = argv[++i] || "";
      continue;
    }
    if (a === "-v" || a === "--verbose") {
      flags.verbose = true;
      continue;
    }
    if (a.startsWith("--") && argv[i + 1] && !argv[i + 1]!.startsWith("-")) {
      flags[a.slice(2)] = argv[++i]!;
      continue;
    }
    if (a.startsWith("--")) {
      flags[a.slice(2)] = true;
      continue;
    }
    if (!cmd) cmd = a;
    else rest.push(a);
  }
  return { cmd, flags, rest };
}

function boot(flags: Record<string, string | boolean>): { cfg: Config; db: Database } {
  const repo = process.env.HEIMDALL_REPO_ROOT || process.cwd();
  const cfg = loadConfig(typeof flags.config === "string" ? flags.config : undefined, repo);
  ensureDirs(cfg);
  return { cfg, db: new Database(cfg.db_path) };
}

async function main(): Promise<number> {
  clearProxyEnv(process.env);
  const { cmd, flags, rest } = parseArgs(process.argv.slice(2));
  const { cfg, db } = boot(flags);
  if (!cmd || cmd === "help" || flags.help) {
    console.log("heimdall sync|challenges|run|queue|status|submit|close|daemon|console|loop|attempts|export-strategy");
    return 0;
  }
  if (cmd === "sync") {
    const n = await new Daemon(cfg, db, createBench(cfg, db)).sync();
    console.log(`synced ${n} challenges → ${cfg.db_path}`);
    return 0;
  }
  if (cmd === "challenges") {
    const rows = db.listChallenges({ incompleteOnly: Boolean(flags.incomplete) });
    if (flags.json) console.log(JSON.stringify(rows, null, 2));
    else {
      for (const r of rows) {
        console.log(
          `${r.unique_code}\t${r.total_score}\t${r.is_completed ? "done" : "open"}\t${classifyChallenge(String(r.unique_code), cfg, { level: r.level as number })}`,
        );
      }
    }
    return 0;
  }
  if (cmd === "status") {
    console.log(
      JSON.stringify(
        {
          runtime: cfg.agent_runtime,
          backend: cfg.agent_backend,
          loop_backend: cfg.loop_backend,
          loop_timeout: cfg.loop_timeout_sec,
          observe: cfg.observe_enabled,
          slots: cfg.max_slots,
          active: db.countActiveJobs(),
          challenges: db.listChallenges().length,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (cmd === "daemon") {
    const d = new Daemon(cfg, db, createBench(cfg, db));
    process.on("SIGINT", () => d.requestStop());
    process.on("SIGTERM", () => d.requestStop());
    await d.run();
    return 0;
  }
  if (cmd === "console") {
    await serveConsole(cfg, db, String(flags.listen || "127.0.0.1:8700"));
    return 0;
  }
  if (cmd === "submit") {
    const code = String(flags.code || rest[0] || "");
    const flag = String(flags.flag || rest[1] || "");
    if (!hasRemoteBench(cfg)) {
      console.error("submit needs BENCHMARK_BASE_URL and BENCHMARK_TOKEN");
      return 2;
    }
    const rec = await new TsecClient(cfg.base_url, cfg.token).submit(code, flag);
    try {
      const ws = join(cfg.workspace_root || cfg.workspaces_dir, code);
      if (existsSync(ws) && recordAcceptedSubmit(ws, code, flag, rec)) {
        const request = pendingRecap(ws);
        if (request) await runObserverFinalizer(cfg, ws, request);
      }
    } catch (error) { console.warn(`[observer] cannot record host submission: ${error}`); }
    db.addFlag({ uniqueCode: code, flagValue: flag, source: "host_cli", submitCorrect: rec.correct });
    console.log(JSON.stringify(rec));
    return rec.correct ? 0 : 1;
  }
  if (cmd === "close") {
    const code = String(flags.code || rest[0] || "");
    if (!hasRemoteBench(cfg)) {
      console.error("close needs BENCHMARK_BASE_URL and BENCHMARK_TOKEN");
      return 2;
    }
    const rec = await new TsecClient(cfg.base_url, cfg.token).close(code);
    console.log(JSON.stringify({ unique_code: code, closed: rec }));
    return 0;
  }
  if (cmd === "run") {
    const code = String(flags.code || rest[0] || "");
    const d = new Daemon(cfg, db, createBench(cfg, db));
    const result = await d.runJob(code, "regular", { closeAfter: !flags["no-close"] });
    console.log(JSON.stringify(result, null, 2));
    return result.completed ? 0 : 1;
  }
  if (cmd === "queue") {
    const d = new Daemon(cfg, db, createBench(cfg, db));
    await d.sync();
    await d.tick();
    console.log(JSON.stringify({ active: db.countActiveJobs() }));
    return 0;
  }
  if (cmd === "attempts" && rest[0] === "repair") {
    const n = db.repairCapacityAttempts();
    console.log(`repaired ${n} capacity-related job rows (counts_as_attempt=0)`);
    return 0;
  }
  if (cmd === "loop") {
    const sub = rest[0] || "";
    if (sub === "enqueue") {
      db.enqueueLoop(String(flags.code || rest[1] || ""), { reason: "manual" });
      console.log("enqueued");
      return 0;
    }
    if (sub === "cancel") {
      const code = String(flags.code || rest[1] || "");
      const entry = db.getLoopEntry(code);
      if (!entry) {
        console.error(`not in loop queue: ${code}`);
        return 1;
      }
      if (String(entry.status || "") === "running") {
        console.error("cannot cancel a running loop job; stop the agent container");
        return 2;
      }
      db.updateLoop(code, { status: "cancelled", hold_instance: 0, finished_at: Date.now() / 1000 });
      console.log(JSON.stringify({ unique_code: code, status: "cancelled" }));
      return 0;
    }
    const running = db.listLoopQueue("running");
    const queued = db.listLoopQueue("queued");
    console.log(
      `loop: enabled=${cfg.loop_enabled} running=${running[0]?.unique_code || "-"} queue=[${queued.map((r) => r.unique_code).join(",") || "-"}] timeout=${cfg.loop_timeout_sec}`,
    );
    for (const r of db.listLoopQueue()) {
      console.log(`  ${r.unique_code} status=${r.status} n=${r.loop_n} reason=${r.reason || "-"}`);
    }
    return 0;
  }
  if (cmd === "export-strategy") {
    const picked = String(flags.project || "").trim();
    let strategy: Record<string, unknown> = { default: "all", rules: [] };
    if (picked) {
      const projects = listProjects(cfg);
      const match = projects.find((p) => p.id === picked || p.name === picked);
      if (!match) {
        console.error(`project not found: ${picked}`);
        return 2;
      }
      strategy = getProjectStrategy(cfg, String(match.id));
      console.log(`project=${match.name} (${match.id})`);
    }
    const typesBlock = strategyToTypes(strategy);
    let outPath = String(flags.out || "workspace_strategy.yaml");
    if (!isAbsolute(outPath)) outPath = join(cfg.repo_root, outPath);
    mkdirSync(dirname(outPath), { recursive: true });
    atomicWrite(outPath, YAML.stringify({ types: typesBlock }, { sortMapEntries: true }));
    const nOver = Object.keys(typesBlock.overrides || {}).length;
    const nRules = (typesBlock.rules || []).length;
    console.log(`wrote ${outPath} default=${typesBlock.default} overrides=${nOver} rules=${nRules}`);
    return 0;
  }
  console.error(`unknown command ${cmd}`);
  return 2;
}

main().then((c) => {
  if (["daemon", "console"].includes(parseArgs(process.argv.slice(2)).cmd)) return;
  process.exit(c);
});
