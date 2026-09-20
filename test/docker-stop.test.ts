import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../src/shared/config.js";
import { dockerJobName, inspectExit, runDocker } from "../src/control/docker-runner.js";
import { stopRunningJob } from "../src/control/runner.js";

// Explicitly enabled integration: no models, targets, VPN, host ports or project data.
describe.runIf(process.env.HEIMDALL_DOCKER_TEST === "1")("real Docker stop lifecycle", () => {
  let dir: string;
  const tag = `heimdall-stop-fixture:${process.pid}`;
  const containers: string[] = [];
  beforeAll(() => {
    dir = mkdtempSync("/tmp/heimdall-docker-stop-");
    writeFileSync(join(dir, "Dockerfile"), "FROM node:22.22.0-bookworm\nCOPY fixture.sh /opt/heimdall/scripts/runtime/ctf-agent.sh\n");
    writeFileSync(join(dir, "fixture.sh"), "#!/bin/bash\ntrap 'exit 0' TERM INT\nwhile true; do sleep 0.1; done\n");
    execFileSync("docker", ["build", "--network=none", "-t", tag, dir], { stdio: "pipe", timeout: 60000 });
  }, 65000);
  afterAll(() => {
    for (const name of containers) { try { execFileSync("docker", ["rm", "-f", name], { stdio: "pipe" }); } catch { /* already removed */ } }
    try { execFileSync("docker", ["image", "rm", tag], { stdio: "pipe" }); } catch { /* build may have failed */ }
    rmSync(dir, { recursive: true, force: true });
  });
  it("stops a tracked Docker runtime using only its job ID", async () => {
    const path = join(dir, "fixture.yaml");
    writeFileSync(path, JSON.stringify({ paths: { data_dir: dir, tools_env: join(dir, "absent") } }));
    const cfg = loadConfig(path, process.cwd());
    Object.assign(cfg, { vpn_enabled: false, observe_enabled: false, docker_runtime_mounts: "image", token: "", base_url: "" });
    const jobId = `fixture-${process.pid}`, code = "url-local-fixture", workspace = join(dir, "workspace");
    mkdirSync(workspace); containers.push(dockerJobName(code, jobId));
    let resolveStarted!: (cid: string) => void;
    const started = new Promise<string>(resolve => resolveStarted = resolve);
    const pending = runDocker(cfg, { jobId, uniqueCode: code, attemptN: 1, image: tag, workspace,
      jobDir: join(dir, "job"), containerAddr: [], challengeType: "web", timeoutSec: 20, onStarted: resolveStarted });
    const cid = await started;
    expect(inspectExit(cid).running).toBe(true);
    expect(stopRunningJob({ jobId })).toBe(1);
    expect(stopRunningJob({ jobId })).toBe(0); // Deduplicate repeated stop commands.
    await pending;
    expect(inspectExit(cid).running).toBe(false);
  }, 30000);
  it("stops a persisted runtime after restart and forces a TERM-resistant container to exit", async () => {
    const name = `heimdall-stop-resistant-${process.pid}`; containers.push(name);
    const cid = execFileSync("docker", ["run", "-d", "--network=none", "--name", name, "alpine:3.20", "sh", "-c", "trap '' TERM; while true; do sleep 1; done"], { encoding: "utf8" }).trim();
    expect(stopRunningJob({ jobId: `not-in-memory-${process.pid}`, containerId: cid })).toBe(1);
    const deadline = Date.now() + 16000;
    while (Date.now() < deadline && inspectExit(cid).running !== false) await new Promise(resolve => setTimeout(resolve, 200));
    expect(inspectExit(cid).running).toBe(false);
  }, 20000);
});
