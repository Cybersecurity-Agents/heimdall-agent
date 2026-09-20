// Real console -> scheduler -> Pi SDK -> bash -> heimdall-submit, with a local model fixture.
import { execFileSync } from 'node:child_process';
const image = process.argv[2];
if (!image) throw new Error('Usage: node scripts/build/smoke-direct.mjs IMAGE');
const script = String.raw`
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
const dir=mkdtempSync('/tmp/heimdall-direct-smoke-');
let calls=0;
const model=createServer((req,res)=>{
 let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{
  const body=JSON.parse(raw);calls++;
  const done=body.messages?.some(m=>Array.isArray(m.content)&&m.content.some(c=>c.type==='tool_result'));
  res.writeHead(200,{'content-type':'text/event-stream'});
  const event=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n');
  event('message_start',{message:{id:'fixture-'+calls,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}});
  if(done){
   event('content_block_start',{index:0,content_block:{type:'text',text:''}});
   event('content_block_delta',{index:0,delta:{type:'text_delta',text:'Local finding recorded.'}});
  }else{
   event('content_block_start',{index:0,content_block:{type:'tool_use',id:'submit-'+calls,name:'bash',input:{}}});
   event('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({command:"heimdall-submit 'flag{offline_direct_fixture}'"})}});
  }
  event('content_block_stop',{index:0});
  event('message_delta',{delta:{stop_reason:done?'end_turn':'tool_use',stop_sequence:null},usage:{output_tokens:20}});
  event('message_stop',{});res.end();
 });
});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
// Reserve an ephemeral console port; fail explicitly if another process takes it.
const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));
const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const config=join(dir,'config.yaml'),tools=join(dir,'tools.yaml');
writeFileSync(tools,JSON.stringify({claude:{ANTHROPIC_API_KEY:'fixture',ANTHROPIC_BASE_URL:'http://127.0.0.1:'+model.address().port,ANTHROPIC_MODEL:'fixture-model',HEIMDALL_LLM_API:'anthropic'},coach:{HEIMDALL_COACH:'0'}}));
writeFileSync(config,JSON.stringify({paths:{data_dir:join(dir,'data'),tools_env:tools},docker:{runtime:'local',vpn:{enabled:false}},observe:{enabled:false},scheduler:{loop:{enabled:true,backend:'pi',direct_types:['intranet']}}}));
const desk=spawn('/opt/heimdall/bin/heimdall',['--config',config,'console','--listen','127.0.0.1:'+port],{env:{...process.env,BENCHMARK_BASE_URL:'',BENCHMARK_TOKEN:''},stdio:['ignore','pipe','pipe']});
let output='';desk.stdout.on('data',b=>output+=b);desk.stderr.on('data',b=>output+=b);
const closed=new Promise(r=>desk.once('close',r));
const api=async(path,body)=>{
 const response=await fetch('http://127.0.0.1:'+port+path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
 assert(response.ok);return response.json();
};
try{
 let ready=false;
 for(let i=0;i<100;i++){if(desk.exitCode!==null)throw Error(output);try{await api('/health');ready=true;break;}catch{}await new Promise(r=>setTimeout(r,100));}
 assert(ready,output);
 for(const type of ['web','intranet']){
  const accepted=await api('/api/run',{url:'http://127.0.0.1:9/'+type,workspace:type,timeout_sec:60});
  assert.equal(accepted.accepted,true);
  let progress;
  for(let i=0;i<120;i++){
   progress=await api('/api/progress/'+accepted.code);
   if(['succeeded','failed','timeout','cancelled'].includes(progress.status))break;
   await new Promise(r=>setTimeout(r,250));
  }
  assert.equal(progress?.status,'succeeded',JSON.stringify(progress)+'\n'+output);
  const flags=await api('/api/flags?code='+accepted.code);
  assert.equal(flags.items.length,1);assert.equal(flags.items[0].source,'direct');assert.equal(flags.items[0].submit_correct,null);
  assert.equal(progress.job.job_kind,type==='intranet'?'loop':'regular');
  const rows=JSON.parse(readFileSync(join(progress.job.workspace_path,'flags.json'),'utf8'));
  assert.equal(rows[0].recorded,true);assert.equal(rows[0].correct,null);
 }
 assert(calls>=2);
 console.log('Direct image smoke passed: real Pi tool calls, local submission, web + intranet scheduling, unverified flag display, no platform credentials.');
}finally{desk.kill('SIGTERM');await closed;model.closeAllConnections();await new Promise(r=>model.close(r));}
`;
console.log(execFileSync('docker',['run','--rm','--init','--network','none','--entrypoint','node',image,'--input-type=module','-e',script],{encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']}).trim());
