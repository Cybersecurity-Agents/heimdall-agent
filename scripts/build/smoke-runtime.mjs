// Exercise the actual workspace runner, SDK log sink and task status in the image.
import { execFileSync } from 'node:child_process';
const image=process.argv[2];
if(!image) throw new Error('Usage: node scripts/build/smoke-runtime.mjs IMAGE');
const script = String.raw`
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {loadConfig} from '/opt/heimdall/dist/shared/config.js';
import {runLocal,stopRunningJob} from '/opt/heimdall/dist/control/runner.js';
import {harvestJob} from '/opt/heimdall/dist/control/console/progress.js';
const root=mkdtempSync('/tmp/heimdall-runtime-smoke-');
mkdirSync(join(root,'scripts/runtime'),{recursive:true});
const agent = "import {EventSink} from '/opt/heimdall/dist/shared/events.js'; const sink=new EventSink(process.env.HEIMDALL_WORKSPACE+'/.heimdall/events.jsonl',null,{stdout:process.env.HEIMDALL_CAPTURE_LOG==='1',jobId:process.env.HEIMDALL_JOB_ID}); sink.writeText('sdk-action'); await new Promise(r=>setTimeout(r,500)); sink.emit('agent_done',{exit_code:0}); sink.writeText('final-action');";
writeFileSync(join(root,'agent.mjs'),agent);
writeFileSync(join(root,'scripts/runtime/ctf-agent.sh'),'#!/bin/bash\necho bootstrap\nnode '+join(root,'agent.mjs')+'\n');
const cfg=loadConfig(join(root,'config.yaml'),root);cfg.vpn_enabled=false;cfg.observe_enabled=false;
const job={id:'smoke',container_id:'local-smoke',status:'running',started_at:Date.now()/1000-120,workspace_path:root,job_dir:join(root,'job')};
let updates=0;
let goal=null;
const db={updateJob(){updates++;},getGoal(){return goal;}};
const result=await runLocal(cfg,{jobId:'smoke',uniqueCode:'smoke',workspace:root,jobDir:job.job_dir,attemptN:1,containerAddr:[],challengeType:'web',timeoutSec:5,onStarted(){assert.equal(harvestJob(db,job).status,'running');}});
assert.equal(updates,0);assert.equal(result.exitCode,0);
const log=readFileSync(result.logPath,'utf8');
for(const line of ['bootstrap','sdk-action','final-action']) assert.equal(log.split(line).length-1,1);
assert.equal(harvestJob(db,job).status,'failed');
goal={jobId:job.id,state:'succeeded',verdict:{state:'satisfied'}};
assert.equal(harvestJob(db,job).status,'succeeded');
// Redirected and detached tool children must be gone when a workspace finishes.
for (const mode of ['exit','stop','timeout','detached']) {
  const workspace=join(root,mode);mkdirSync(join(workspace,'scripts/runtime'),{recursive:true});
  writeFileSync(join(workspace,'child.cjs'), "process.on('SIGTERM',()=>{});require('fs').writeFileSync('child.pid',String(process.pid));setInterval(()=>{},1000);");
  const childScript='#!/bin/bash\n'+(mode==='detached'?'setsid ':'')+process.execPath+' child.cjs </dev/null >/dev/null 2>&1 &\nwhile [ ! -f child.pid ]; do sleep 0.01; done\n'+(['exit','detached'].includes(mode)?'exit 0':'sleep 30')+'\n';
  writeFileSync(join(workspace,'scripts/runtime/ctf-agent.sh'),childScript);
  const localCfg={...cfg,repo_root:workspace,kill_timeout_sec:1};
  const pending=runLocal(localCfg,{jobId:mode,uniqueCode:mode,workspace,jobDir:join(workspace,'job'),attemptN:1,containerAddr:[],challengeType:'web',timeoutSec:mode==='timeout'?1:10});
  let pid;
  for(let i=0;i<100;i++){try{pid=Number(readFileSync(join(workspace,'child.pid'),'utf8'));break;}catch{}await new Promise(r=>setTimeout(r,20));}
  assert(pid,'child did not start');
  if(mode==='stop')stopRunningJob({jobId:mode});
  const result=await pending;assert.equal(result.timedOut,mode==='timeout');
  const {processIdentity}=await import('/opt/heimdall/dist/control/local-process.js');
  for(let i=0;i<100&&processIdentity(pid);i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(processIdentity(pid),null,mode+' left a child running');
}
console.log('Runtime smoke passed: workspace status, complete SDK logs, terminal recovery and child cleanup on exit/stop/timeout/detach.');
`;
const output=execFileSync('docker',['run','--rm','--init','--network','none','--entrypoint','node',image,'--input-type=module','-e',script],{encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']});
console.log(output.trim());
