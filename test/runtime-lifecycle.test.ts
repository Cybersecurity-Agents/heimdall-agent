import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import * as childProcess from "node:child_process";
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>() }));
import { once } from "node:events";
import { processIdentity, recordLocalProcess, inspectLocalProcess } from "../src/control/local-process.js";
import { harvestJob } from "../src/control/console/progress.js";
import { runLocal } from "../src/control/runner.js";
import { loadConfig } from "../src/shared/config.js";
import { EventSink } from "../src/shared/events.js";
import * as capabilities from "../src/shared/runtime-capabilities.js";
import type { Database } from "../src/shared/db.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, {recursive:true,force:true}); });
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),"heimdall-lifecycle-")); dirs.push(dir);
  const job={id:"fixture",container_id:"local-fixture",status:"running",started_at:Date.now()/1000-120,workspace_path:dir,job_dir:dir};
  const updateJob=vi.fn();const db={updateJob,getGoal:vi.fn(()=>null)} as unknown as Database;
  return {dir,job,db,updateJob};
}
describe("workspace lifecycle", () => {
  it("keeps a live workspace running past 20 seconds, ignoring previous completion events", () => {
    const {dir,job,db,updateJob}=fixture();
    mkdirSync(join(dir,".heimdall"));
    writeFileSync(join(dir,".heimdall/events.jsonl"),JSON.stringify({ts:job.started_at-1,kind:"agent_done",payload:{exit_code:0}})+'\n');
    recordLocalProcess(dir,{jobId:job.id,identity:processIdentity(process.pid),state:"running",exit:null,error:null,timedOut:false});
    expect(harvestJob(db,job).status).toBe("running");expect(updateJob).not.toHaveBeenCalled();
  });
  it("does not invent failure for legacy records without process evidence", () => {
    const {job,db,updateJob}=fixture();
    expect(harvestJob(db,job).status).toBe("running");expect(updateJob).not.toHaveBeenCalled();
  });
  it("recognizes real process exit and does not confuse reused PIDs", async () => {
    const {dir,job,db}=fixture();
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);
    const identity=processIdentity(child.pid!)!;
    try {
      recordLocalProcess(dir,{jobId:job.id,identity,state:"running",exit:null,error:null,timedOut:false});
      expect(inspectLocalProcess(job.id,dir).status).toBe("running");
      recordLocalProcess(dir,{jobId:job.id,identity:{...identity,start:'different'},state:"running",exit:null,error:null,timedOut:false});
      expect(inspectLocalProcess(job.id,dir).status).toBe("missing");
      recordLocalProcess(dir,{jobId:job.id,identity,state:"running",exit:null,error:null,timedOut:false});
    } finally { const closed=once(child,'close'); child.kill(); await closed; }
    expect(harvestJob(db,job)).toMatchObject({status:"failed",terminal_reason:"process_lost"});
  });
  it("recovers explicit timeout and exit results without treating null as success", () => {
    const {dir,job,db}=fixture();
    for(const [exit,timedOut,status] of [[0,false,'failed'],[null,false,'failed'],[null,true,'timeout']] as const){
      recordLocalProcess(dir,{jobId:job.id,identity:null,state:"exited",exit,error:null,timedOut});
      expect(harvestJob(db,job).status).toBe(status);
    }
  });
  it("does not turn an unavailable Docker daemon into a failed task", () => {
    const {job,db,updateJob}=fixture();job.container_id='docker-fixture';
    vi.spyOn(childProcess,'execFileSync').mockImplementation(()=>{throw new Error('Cannot connect to the Docker daemon');});
    expect(harvestJob(db,job)).toMatchObject({status:'running',error:expect.stringContaining("capacity remains reserved")});
  });
  it("requires acceptance to belong to the recovered attempt", () => {
    const {dir,job,db}=fixture();
    recordLocalProcess(dir,{jobId:job.id,identity:null,state:"exited",exit:0,error:null,timedOut:false});
    const accepted = {jobId:"newer-attempt",state:"succeeded",verdict:{state:"satisfied"}};
    vi.mocked(db.getGoal).mockReturnValue(accepted as ReturnType<Database["getGoal"]>);
    expect(harvestJob(db,job).status).toBe("failed");
    accepted.jobId=job.id;
    expect(harvestJob(db,job).status).toBe("succeeded");
  });
  it("cleans orphaned owned processes when recovering an exited attempt", async () => {
    const {dir,job,db}=fixture();
    const owner=`recovery-${dir}`;
    const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{
      detached:true, env:{...process.env,HEIMDALL_PROCESS_OWNER:owner},stdio:"ignore",
    });
    const closed=once(child,"close");
    try {
      await once(child,"spawn");
      recordLocalProcess(dir,{jobId:job.id,identity:null,state:"exited",exit:0,error:null,timedOut:false,owner});
      expect(harvestJob(db,job).status).toBe("failed");
      await vi.waitFor(()=>expect(processIdentity(child.pid!)).toBeNull());
    } finally { child.kill("SIGKILL"); await closed; }
  });
  it("ignores a previous attempt's completion when recovering an exited Docker task", () => {
    const {dir,job,db}=fixture();job.container_id='docker-fixture';
    mkdirSync(join(dir,'.heimdall'));
    writeFileSync(join(dir,'.heimdall/events.jsonl'),JSON.stringify({ts:job.started_at-1,kind:'agent_done',payload:{exit_code:0,ok:true}})+'\n');
    vi.spyOn(childProcess,'execFileSync').mockReturnValue('exited 1');
    expect(harvestJob(db,job)).toMatchObject({status:'failed',exit_code:1});
  });
  it("captures SDK text exactly once in the complete job log and drains the last chunk", async () => {
    const {dir}=fixture();
    const cfg=loadConfig(join(dir,"config.yaml"),dir); cfg.vpn_enabled=false;cfg.observe_enabled=false;
    vi.spyOn(capabilities,"workspaceCapability").mockReturnValue({available:true,reason:"fixture"});
    mkdirSync(join(dir,"scripts/runtime"),{recursive:true});
    writeFileSync(join(dir,"scripts/runtime/ctf-agent.sh"),`#!/bin/bash\necho startup\nif [ "$HEIMDALL_CAPTURE_LOG" != 1 ]; then exit 2; fi\n"${process.execPath}" -e 'process.stdout.write("sdk-tool\\n" + "x".repeat(200000) + "\\nlast-chunk\\n")'\n`);
    const result=await runLocal(cfg,{jobId:"fixture",uniqueCode:"fixture",attemptN:1,workspace:dir,jobDir:join(dir,"job"),containerAddr:[],challengeType:"web",timeoutSec:5});
    expect(result.exitCode).toBe(0);
    const log=readFileSync(result.logPath,"utf8");
    expect(log).toContain('sdk-tool\n');expect(log.endsWith('last-chunk\n')).toBe(true);
    expect(log).toBe(readFileSync(join(dir,".heimdall/agent.log"),"utf8").replace(/^/, '=== workspace fixture job=fixture ===\n'));
    expect(inspectLocalProcess('fixture',join(dir,'job'))).toMatchObject({status:'exited',exit:0});
  });
  it("does not hang or report timeout when a background child inherits stdout", async () => {
    const {dir}=fixture();const cfg=loadConfig(join(dir,'config.yaml'),dir);
    cfg.vpn_enabled=false;cfg.observe_enabled=false;cfg.kill_timeout_sec=1;
    vi.spyOn(capabilities,'workspaceCapability').mockReturnValue({available:true,reason:'fixture'});
    mkdirSync(join(dir,'scripts/runtime'),{recursive:true});
    writeFileSync(join(dir,'scripts/runtime/ctf-agent.sh'),'#!/bin/bash\nsleep 30 &\necho complete\nexit 0\n');
    const pending=runLocal(cfg,{jobId:'background',uniqueCode:'background',attemptN:1,workspace:dir,jobDir:join(dir,'job'),containerAddr:[],challengeType:'web',timeoutSec:3});
    await new Promise(resolve=>setTimeout(resolve,150));
    expect(inspectLocalProcess('background',join(dir,'job')).status).toBe('running');
    const result=await pending;
    expect(result).toMatchObject({exitCode:0,timedOut:false});
    expect(readFileSync(result.logPath,'utf8')).toContain('complete');
  });
  it("routes managed agent text to stdout without a second file writer", () => {
    const {dir}=fixture();const log=join(dir,'agent.log');const stdout=vi.spyOn(process.stdout,'write').mockReturnValue(true);
    const sink=new EventSink(join(dir,'events.jsonl'),log,{stdout:true,jobId:'fixture'});
    sink.writeText('tool finished');sink.emit('agent_done',{exit_code:0});
    expect(stdout).toHaveBeenCalledWith('tool finished\n');
    expect(()=>readFileSync(log)).toThrow();
    expect(JSON.parse(readFileSync(join(dir,'events.jsonl'),'utf8')).job_id).toBe('fixture');
  });
});

describe('background process cleanup', () => {
  for (const mode of ['exit', 'stop', 'timeout', 'detached'] as const) {
    it(`removes redirected children after ${mode}`, { timeout: 8000 }, async () => {
      const {dir} = fixture();
      const cfg = loadConfig(join(dir,'config.yaml'),dir);
      cfg.vpn_enabled=false; cfg.observe_enabled=false; cfg.kill_timeout_sec=1;
      vi.spyOn(capabilities,'workspaceCapability').mockReturnValue({available:true,reason:'fixture'});
      mkdirSync(join(dir,'scripts/runtime'),{recursive:true});
      writeFileSync(join(dir,'child.cjs'), `process.on('SIGTERM',()=>{}); require('fs').writeFileSync('child.pid',String(process.pid)); setInterval(()=>{},1000);`);
      writeFileSync(join(dir,'scripts/runtime/ctf-agent.sh'), `#!/bin/bash\n${mode === 'detached' ? 'setsid ' : ''}"${process.execPath}" child.cjs </dev/null >/dev/null 2>&1 &\nwhile [ ! -f child.pid ]; do sleep 0.01; done\n${['exit','detached'].includes(mode) ? 'exit 0' : 'sleep 30'}\n`);
      let pid: number | undefined;
      const pending = runLocal(cfg,{jobId:`cleanup-${mode}`,uniqueCode:'fixture',attemptN:1,workspace:dir,jobDir:join(dir,'job'),containerAddr:[],challengeType:'web',timeoutSec:mode === 'timeout' ? 1 : 6});
      try {
        await vi.waitFor(() => { pid=Number(readFileSync(join(dir,'child.pid'),'utf8')); });
        if (mode === 'stop') {
          const {stopRunningJob} = await import('../src/control/runner.js');
          expect(stopRunningJob({jobId:`cleanup-${mode}`})).toBe(1);
        }
        const result = await pending;
        expect(result.timedOut).toBe(mode === 'timeout');
        if (['exit','detached'].includes(mode)) expect(result.exitCode).toBe(0);
        await vi.waitFor(() => expect(processIdentity(pid!)).toBeNull());
      } finally {
        if (pid && processIdentity(pid)) process.kill(pid,'SIGKILL');
        const {stopRunningJob} = await import('../src/control/runner.js');
        stopRunningJob({jobId:`cleanup-${mode}`});
        await pending;
      }
    });
  }
});
