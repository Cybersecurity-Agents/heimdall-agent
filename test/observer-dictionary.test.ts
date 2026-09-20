import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ObservationSubmit } from "../src/observer/contract.js";
import { seedJobSteer } from "../src/observer/job-steer.js";
import { loadObserverSystem } from "../src/observer/system-prompt.js";
import { ObservationTurn } from "../src/observer/tools.js";
import { validateGeneratedBrief } from "../src/agent/brief-summarizer.js";
import { loadGeneratedBody, saveGeneratedBrief } from "../src/agent/observe.js";
import { composeInjectBlob } from "../src/shared/inject.js";
import { publicationDir } from "../src/shared/observation-publication.js";
import { injectTxt, sprayCredsTxt, trafficDir } from "../src/shared/paths.js";
import { loadPrompt } from "../src/shared/resources.js";

const dirs: string[] = [];
beforeEach(() => {
  vi.stubEnv("HEIMDALL_REPO_ROOT", process.cwd());
  vi.stubEnv("HEIMDALL_WORDLISTS", join(process.cwd(), "resources/wordlists"));
});
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function workspace(task: Record<string, unknown>): string {
  const ws = mkdtempSync(join(tmpdir(), "heimdall-dictionary-")); dirs.push(ws);
  mkdirSync(trafficDir(ws), { recursive: true });
  writeFileSync(join(ws, "input.json"), JSON.stringify({ job_id: "dictionary-job", unique_code: "fixture", ...task }));
  writeFileSync(join(trafficDir(ws), "turns.jsonl"), JSON.stringify({ n: 1, jobId: "dictionary-job",
    detail: "Observed fixture credentials: operator:FixtureLogin!42, admin:FixtureAdmin!84", sources: [] }) + "\n");
  return ws;
}

const read = (ws: string, name: string): string => readFileSync(join(publicationDir(ws), name), "utf8");
const submission = (turn: ObservationTurn, credential = "operator:FixtureLogin!42"): ObservationSubmit => ({
  baseRevision: turn.base.revision, upserts: [], retireIds: [],
  loot: [{ bucket: "creds", value: credential, evidenceRefs: ["turn:1"] }],
});

describe("credential dictionary activation", () => {
  it.each([
    { challenge_type: "intranet", flag_count: 1 },
    { challenge_type: "intranet" },
    { challenge_type: "intranet", flag_count: 2 },
    { challenge_type: "pentest", flag_count: 0 },
    { challenge_type: " InTrAnEt ", flag_count: 1 },
    { challenge_type: "web", flag_count: 2 },
    { flag_count: "2" },
  ])("injects the module and publishes loot and dictionaries for %j", task => {
    const ws = workspace(task), module = loadPrompt("observer-spray").trim();
    expect(loadObserverSystem(ws).split(module)).toHaveLength(2);
    const turn = new ObservationTurn(ws);
    expect(turn.context().loot).toEqual([]);
    expect(turn.submit(submission(turn))).toMatchObject({ ok: true });
    expect(JSON.parse(read(ws, "loot.json")).creds).toContain("operator:FixtureLogin!42");
    expect(readFileSync(sprayCredsTxt(ws), "utf8").split("\n")).toContain("operator:FixtureLogin!42");
    expect(read(ws, "spray_users.txt").split("\n")).toContain("operator");
    expect(read(ws, "spray_passwords.txt").split("\n")).toContain("FixtureLogin!42");
    expect(JSON.parse(read(ws, "spray_meta.json"))).toMatchObject({ rev: 1, status: "ready" });
    expect(JSON.parse(read(ws, "graph.json")).view.nodes.some((node: { id: string }) => node.id === "spray-dict")).toBe(true);
    expect(read(ws, "CONFIRMED.md")).toContain("DICT rev=1");
    expect(composeInjectBlob(ws)).toContain("DICT rev=1");
  });

  it.each([
    { challenge_type: "web", flag_count: 1 },
    { challenge_type: "web" },
    { challenge_type: "all", flag_count: 1 },
    { challenge_type: "all" },
    { challenge_type: "unknown", flag_count: 1 },
    { flag_count: 1 },
    {},
  ])("omits the module and rejects loot without creating dictionaries for %j", task => {
    const ws = workspace(task);
    // Another job's environment or an old seed marker cannot override this task.
    vi.stubEnv("HEIMDALL_CHALLENGE_TYPE", "intranet");
    writeFileSync(join(ws, ".heimdall/challenge_type"), "intranet\n");
    expect(loadObserverSystem(ws)).not.toContain(loadPrompt("observer-spray").trim());
    const turn = new ObservationTurn(ws);
    expect(turn.context()).not.toHaveProperty("loot");
    expect(turn.submit(submission(turn))).toMatchObject({ ok: false, errors: [{ path: "/loot", code: "disabled" }] });
    expect(turn.submit({ ...submission(turn), loot: [] })).toMatchObject({ ok: true });
    expect(existsSync(sprayCredsTxt(ws))).toBe(false);
    expect(read(ws, "CONFIRMED.md")).not.toContain("DICT rev=");
  });

  it.each([null, "{ malformed", "[]", "null"])("loads the baseline when task input is missing or invalid: %j", input => {
    const ws = workspace({ challenge_type: "intranet" });
    if (input === null) rmSync(join(ws, "input.json"));
    else writeFileSync(join(ws, "input.json"), input);
    const system = loadObserverSystem(ws);
    expect(system).toContain(loadPrompt("observer").trim());
    expect(system).not.toContain(loadPrompt("observer-spray").trim());
  });
});

describe("intranet dictionary updates and solver guidance", () => {
  it("preserves earlier credentials and publishes a new dictionary revision for a single-flag intranet job", () => {
    const ws = workspace({ challenge_type: "intranet", flag_count: 1 }), first = new ObservationTurn(ws);
    const initial = submission(first);
    expect(first.submit(initial)).toMatchObject({ ok: true });
    const second = new ObservationTurn(ws);
    expect(second.context().loot).toEqual(initial.loot);
    expect(second.submit(submission(second, "admin:FixtureAdmin!84"))).toMatchObject({ ok: true });
    expect(readFileSync(sprayCredsTxt(ws), "utf8").split("\n")).toEqual(expect.arrayContaining([
      "operator:FixtureLogin!42", "admin:FixtureAdmin!84",
    ]));
    expect(JSON.parse(read(ws, "spray_meta.json"))).toMatchObject({ rev: 2, status: "updated" });
    expect(composeInjectBlob(ws)).toContain("DICT rev=2");
  });

  it.each(["intranet", "web"])("keeps dictionary guidance only when enabled for the %s playbook", challenge_type => {
    const ws = workspace({ challenge_type, flag_count: 1 });
    const brief = "LOCK: Check the observed login boundary\nCONFIRMED:\n- Observed credentials are available\nANGLES:\n- Use spray_creds.txt on the next observed login surface\n";
    writeFileSync(injectTxt(ws), `<heimdall-map>\n${brief}</heimdall-map>\n`);
    expect(seedJobSteer(ws)).toBe(true);
    expect(saveGeneratedBrief(ws, brief)).not.toBeNull();
    if (challenge_type === "intranet") {
      expect(readFileSync(injectTxt(ws), "utf8")).toContain("spray_creds.txt");
      expect(loadGeneratedBody(ws)).toContain("spray_creds.txt");
      expect(validateGeneratedBrief(brief, { workspace: ws })).toBe("");
    } else {
      expect(readFileSync(injectTxt(ws), "utf8")).not.toContain("spray_creds.txt");
      expect(loadGeneratedBody(ws)).not.toContain("spray_creds.txt");
      expect(loadGeneratedBody(ws)).not.toContain("登录注入");
      expect(readFileSync(injectTxt(ws), "utf8")).not.toContain("登录注入");
      expect(validateGeneratedBrief(brief, { workspace: ws })).not.toBe("");
    }
  });
});
