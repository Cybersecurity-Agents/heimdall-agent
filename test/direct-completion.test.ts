import { taskKey } from "../src/shared/task-ref.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/shared/config.js";
import { Database } from "../src/shared/db.js";
import { Desk } from "../src/control/console/desk.js";
import { Daemon } from "../src/control/daemon.js";
import * as runner from "../src/control/runner.js";
import { main } from "../src/tools/tsec-cli.js";
import { hasCorrectSubmit, isChallengeComplete, recordLocalFlag } from "../src/shared/completion.js";

vi.mock("node:sqlite", async () => {
  const { createRequire } = await import("node:module");
  return createRequire(import.meta.url)("node:sqlite");
});

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync('/tmp/heimdall-direct-'); dirs.push(dir);
  writeFileSync(join(dir,'config.yaml'), JSON.stringify({ paths: { data_dir: dir, tools_env: join(dir,'tools.yaml') } }));
  writeFileSync(join(dir,'tools.yaml'), '{}');
  const cfg = loadConfig(join(dir,'config.yaml'), process.cwd());
  cfg.agent_runtime = 'local'; cfg.base_url = ''; cfg.token = ''; cfg.observe_enabled = false; cfg.vpn_enabled = false;
  cfg.loop_enabled = true; cfg.loop_direct_types = ['intranet'];
  return { dir, cfg, db: new Database(join(dir,'db.sqlite')) };
}

describe('direct task completion', () => {
  it('records a candidate through the real submit CLI without platform credentials or scored correctness', async () => {
    const {dir} = fixture();
    vi.stubEnv('HEIMDALL_WORKSPACE',dir); vi.stubEnv('UNIQUE_CODE','url-fixture');
    vi.stubEnv('BENCHMARK_BASE_URL',''); vi.stubEnv('BENCHMARK_TOKEN','');
    const network = vi.spyOn(globalThis,'fetch');
    writeFileSync(join(dir,'input.json'),JSON.stringify({unique_code:'url-fixture',flag_count:0,target_mode:'direct'}));
    writeFileSync(join(dir,'flags.json'),JSON.stringify([{flag:'flag{local_fixture}'}]));
    expect(isChallengeComplete(dir)).toBe(false);
    expect(await main(['submit'])).toBe(0);
    expect(isChallengeComplete(dir)).toBe(true);
    expect(hasCorrectSubmit(dir)).toBe(false);
    expect(JSON.parse(readFileSync(join(dir,'flags.json'),'utf8'))).toEqual([
      {flag:'flag{local_fixture}',source:'direct',via:'heimdall-submit',recorded:true,correct:null},
    ]);
    expect(await main(['challenge'])).toBe(0);
    expect(await main(['hint'])).toBe(0);
    expect(network).not.toHaveBeenCalled();
    writeFileSync(join(dir,'input.json'),JSON.stringify({unique_code:'task-1',target_mode:'platform',flag_count:1}));
    expect(isChallengeComplete(dir)).toBe(false);
  });

  it.each([true, false])('starts a direct intranet job with loop_enabled=%s', async (enabled) => {
    const {cfg,db} = fixture(); cfg.loop_enabled = enabled;
    const run = vi.spyOn(Daemon.prototype,'runJob').mockResolvedValue({completed:true,status:'succeeded'});
    const desk = new Desk(cfg,db);
    const accepted = desk.start({url:'http://127.0.0.1:9/fixture',workspace:'intranet'});
    expect(accepted.accepted).toBe(true);
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith(accepted.code,enabled ? 'loop' : 'regular',expect.objectContaining({targetUrl:'http://127.0.0.1:9/fixture'})));
  });

  it('finishes a local finding without escalating and keeps the database flag unverified', async () => {
    const {cfg,db} = fixture();
    vi.spyOn(runner,'runLocal').mockImplementation(async (_cfg,spec) => {
      recordLocalFlag(spec.workspace,'flag{local_fixture}');
      return {containerId:'local-fixture',exitCode:0,timedOut:false,logPath:'',error:null};
    });
    const desk = new Desk(cfg,db);
    const rec = desk.start({url:'http://127.0.0.1:9/fixture',workspace:'web'});
    await vi.waitFor(() => expect(desk.runs.get(taskKey(String(rec.code)))?.status).toBe('done'));
    expect(desk.runs.get(taskKey(String(rec.code)))?.result).toMatchObject({completed:true,status:'succeeded'});
    expect(db.listFlags(String(rec.code))[0]).toMatchObject({source:'direct',submit_correct:null});
    expect(db.getLoopEntry(String(rec.code))).toBeFalsy();
  });

  it('does not escalate a permanent backend configuration failure', async () => {
    const {cfg,db} = fixture();
    vi.spyOn(runner,'runLocal').mockResolvedValue({containerId:'local-fixture',exitCode:2,timedOut:false,logPath:'',error:'401 fixture'});
    const desk = new Desk(cfg,db);
    const rec = desk.start({url:'http://127.0.0.1:9/invalid-key',workspace:'web'});
    await vi.waitFor(() => expect(desk.runs.get(taskKey(String(rec.code)))?.status).toBe('done'));
    expect(db.listJobsForCode(String(rec.code))).toHaveLength(1);
    expect(db.getLoopEntry(String(rec.code))).toBeFalsy();
  });

});
