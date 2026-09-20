import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PiBackend } from '../src/agent/backends/pi.js';
import { EventSink } from '../src/shared/events.js';
import { runAgent } from '../src/agent/runner.js';
import { loadSettings } from '../src/agent/config.js';

const dirs:string[]=[];
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function fixture(){const dir=mkdtempSync('/tmp/heimdall-pi-error-');dirs.push(dir);return dir;}

describe('Pi error propagation',()=>{
  it('reports real SDK authentication failures as non-retryable', {timeout:20000}, async()=>{
    const dir=fixture();let requests=0;
    const server=createServer((req,res)=>{req.resume();req.on('end',()=>{requests++;res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({type:'error',error:{type:'authentication_error',message:'fixture invalid API key'}}));});});
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
    const port=(server.address() as {port:number}).port;
    for(const [key,value] of Object.entries({PI_OFFLINE:'1',HEIMDALL_LLM_API:'anthropic',HEIMDALL_LLM_PROVIDER:'anthropic',HEIMDALL_LLM_BASE_URL:`http://127.0.0.1:${port}`,HEIMDALL_AGENT_MODEL:'fixture-model',PI_CODING_AGENT_DIR:join(dir,'agent'),HEIMDALL_LLM_API_KEY:'fixture'}))vi.stubEnv(key,value);
    const backend=new PiBackend({noSkills:true,noContextFiles:true});
    const events=new EventSink(join(dir,'events.jsonl'),null);
    try{
      const result=await backend.run({workspace:dir,systemPrompt:'Fixture',userPrompt:'Hello',model:'fixture-model',maxTurns:0,permissionMode:'bypassPermissions',events,signal:AbortSignal.timeout(15000)});
      expect(result).toMatchObject({ok:false,exitCode:2,retryable:false,extra:{stop_reason:'error'}});
      expect(result.error).toContain('fixture invalid API key');expect(requests).toBe(1);
    }finally{await backend.close();events.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  });

  it('does not retry a permanent backend failure in the until-flag harness',async()=>{
    const dir=fixture();
    writeFileSync(join(dir,'input.json'),JSON.stringify({unique_code:'task-1',flag_count:1}));
    const run=vi.spyOn(PiBackend.prototype,'run').mockResolvedValue({backend:'pi',ok:false,exitCode:2,retryable:false,error:'401 invalid API key'});
    vi.stubEnv('HEIMDALL_WORKSPACE',dir);vi.stubEnv('HEIMDALL_AGENT_BACKEND','pi');vi.stubEnv('HEIMDALL_SUBMIT_BIN','/bin/true');vi.stubEnv('HEIMDALL_LOOP_TIMEOUT_SEC','1');
    expect(await runAgent({...loadSettings(),piTransport:'sdk'})).toBe(2);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
