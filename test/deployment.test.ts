import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { loadConfig } from "../src/shared/config.js";
import { applyPayload } from "../src/control/console/llm-io.js";
import { firstLlmKey } from "../src/shared/pi-workspace.js";
import { volumeArgs } from "../src/control/docker-runner.js";
import type { Config } from "../src/shared/config.js";
import type { RunSpec } from "../src/control/runner.js";

const temporary: string[] = [];
afterEach(() => { for (const p of temporary.splice(0)) rmSync(p, { recursive: true, force: true }); });

describe("public container deployment", () => {
  it("uses baked executor resources without reading a host source tree", () => {
    const args = volumeArgs({ repo_root: "/does-not-exist", docker_runtime_mounts: "image" } as Config,
      { workspace: "/opt/heimdall/data/a workspace", jobDir: "/does-not-exist" } as RunSpec);
    expect(args).toEqual(["--mount", "type=bind,src=/opt/heimdall/data/a workspace,dst=/workspace"]);
    expect(args.join(" ")).not.toContain("node_modules");
  });

  it("persists credentials and config across recreation, preserving YAML special characters", () => {
    const data = mkdtempSync(join(tmpdir(), "heimdall-deploy-")); temporary.push(data);
    const secret = 'fixture-only: "quoted"\nline\\two';
    const env = { ...process.env, HEIMDALL_REPO_ROOT: resolve("."), HEIMDALL_DATA_DIR: data, ANTHROPIC_API_KEY: secret };
    execFileSync(process.execPath, ["deploy/unified/init.mjs"], { env });
    const toolsPath = join(data, "config/tools.env.yaml");
    expect(parse(readFileSync(toolsPath, "utf8")).claude.ANTHROPIC_API_KEY).toBe(secret);
    const cfg = parse(readFileSync(join(data, "config/config.yaml"), "utf8"));
    expect(cfg.paths.data_dir).toBe(data);
    expect(cfg.paths.tools_env).toBe(toolsPath);
    expect(cfg.docker.vpn.enabled).toBe(true);
    expect(cfg.docker.vpn.mode).toBe("auto");
    expect(cfg.docker.runtime).toBe("local");
    expect(cfg.docker.vpn.config).toBe(join(data, "vpn/client.ovpn"));
    writeFileSync(join(data, "config/config.yaml"), "docker:\n  vpn:\n    enabled: false\n");
    writeFileSync(toolsPath, 'claude:\n  ANTHROPIC_API_KEY: edited-in-console\n');
    execFileSync(process.execPath, ["deploy/unified/init.mjs"], { env: { ...env, ANTHROPIC_API_KEY: "replacement" } });
    expect(parse(readFileSync(toolsPath, "utf8")).claude.ANTHROPIC_API_KEY).toBe("edited-in-console");
    expect(parse(readFileSync(join(data, "config/config.yaml"), "utf8")).docker.vpn.enabled).toBe(false);
  });
});


describe("model environment initialization", () => {
  for (const prefix of ["HEIMDALL", "OPENAI", "ANTHROPIC"]) {
    it(`persists ${prefix} aliases for both local and Docker jobs`, () => {
      const data = mkdtempSync(join(tmpdir(), "heimdall-model-env-")); temporary.push(data);
      const names = prefix === "HEIMDALL"
        ? ["HEIMDALL_LLM_API_KEY", "HEIMDALL_LLM_BASE_URL", "HEIMDALL_AGENT_MODEL"]
        : [`${prefix}_API_KEY`, `${prefix}_BASE_URL`, `${prefix}_MODEL`];
      const supplied = Object.fromEntries(names.map((key,i) => [key,["fixture-key","http://fixture.invalid/anthropic","fixture-model"][i]!]));
      const compose = parse(readFileSync("compose.yaml", "utf8"));
      for (const key of names) expect(compose.services.heimdall.environment[key]).toBe("${" + key + ":-}");
      execFileSync(process.execPath,["deploy/unified/init.mjs"],{env:{PATH:process.env.PATH,HEIMDALL_REPO_ROOT:resolve("."),HEIMDALL_DATA_DIR:data,...supplied}});
      const cfg=loadConfig(join(data,"config/config.yaml"), data);
      expect(cfg.tools_env.values).toMatchObject({HEIMDALL_LLM_API_KEY:"fixture-key",ANTHROPIC_API_KEY:"fixture-key",OPENAI_API_KEY:"fixture-key",HEIMDALL_AGENT_MODEL:"fixture-model",HEIMDALL_LLM_BASE_URL:"http://fixture.invalid/anthropic"});
      // A console edit must supersede every initialized alias, including the highest-priority key.
      applyPayload(cfg,{ANTHROPIC_API_KEY:"edited-key"});
      expect(firstLlmKey(cfg.tools_env.values)).toBe("edited-key");
    });
  }
});
