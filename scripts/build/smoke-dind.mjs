// Requires local all-in-one and executor images; creates only an isolated test project.
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
const image = process.argv[2], executor = process.argv[3];
if (!image || !executor) throw new Error('Usage: node scripts/build/smoke-dind.mjs ALL_IN_ONE EXECUTOR');
const project = `heimdall-dind-smoke-${process.pid}`;
const env = { ...process.env, HEIMDALL_IMAGE: image, HEIMDALL_EXECUTOR_IMAGE: executor, HEIMDALL_PORT: '0' };
const args = ['compose', '--env-file', '.env.example', '-p', project, '-f', 'compose.yaml', '-f', 'deploy/compose.dind.yaml'];
const run = (...rest) => execFileSync('docker', [...args, ...rest], { env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout: 240_000 });
const tmp = mkdtempSync(join(tmpdir(), 'heimdall-dind-smoke-'));
try {
  run('up', '-d', '--wait');
  // Save+load streaming without storing a large intermediate tarball.
  // Unpacking the full toolkit into a fresh nested engine can take several
  // minutes on hosted disks. This budget covers image transfer, not solver work.
  const transfer = spawnSync('bash', ['-o', 'pipefail', '-c', 'docker save "$1" | docker compose --env-file .env.example -p "$2" -f compose.yaml -f deploy/compose.dind.yaml exec -T heimdall docker load', 'bash', executor, project],
    { env, encoding: 'utf8', timeout: 900_000 });
  if (transfer.status !== 0) throw new Error(`Inner image load failed: ${transfer.error?.message || `exit=${transfer.status} signal=${transfer.signal}`}\n${transfer.stderr || ''}`);
  run('cp', resolve('test/fixtures/fake_pi_rpc.py'), 'heimdall:/opt/heimdall/data/fake_pi_rpc.py');
  const script = `
import assert from 'node:assert/strict';
import { mkdirSync, copyFileSync, chmodSync, writeFileSync, readFileSync } from 'node:fs';
import { loadConfig } from '/opt/heimdall/dist/shared/config.js';
import { seedWorkspace } from '/opt/heimdall/dist/control/seed.js';
import { runDocker } from '/opt/heimdall/dist/control/docker-runner.js';
const cfg = loadConfig('/opt/heimdall/data/config/config.yaml', '/opt/heimdall');
cfg.vpn_enabled = false;
const workspace = '/opt/heimdall/data/workspaces/dind-fixture';
const jobDir = '/opt/heimdall/data/jobs/dind-fixture';
mkdirSync(jobDir, { recursive:true });
seedWorkspace(workspace, cfg.repo_root, { challengeType:'all' });
copyFileSync('/opt/heimdall/data/fake_pi_rpc.py', workspace + '/fake_pi_rpc.py');
chmodSync(workspace + '/fake_pi_rpc.py', 0o755);
writeFileSync(workspace + '/input.json', JSON.stringify({unique_code:'fixture', challenge_type:'all', flag_count:1}));
const result = await runDocker(cfg, { uniqueCode:'fixture', jobId:'dind-fixture', attemptN:1, workspace, jobDir, containerAddr:[], challengeType:'all', timeoutSec:30, image:process.env.HEIMDALL_EXECUTOR_IMAGE, extraEnv:{
HEIMDALL_PI_TRANSPORT:'rpc', HEIMDALL_PI_CLI:'/workspace/fake_pi_rpc.py', HEIMDALL_COACH:'0', HEIMDALL_BRIEF_SUMMARIZER:'0', HEIMDALL_DISABLE_HTTP_TAP:'1', HEIMDALL_DISABLE_LLM_TAP:'1', HEIMDALL_MAX_TURNS:'2', ANTHROPIC_BASE_URL:'http://127.0.0.1:9/anthropic', ANTHROPIC_API_KEY:'offline-fixture', HEIMDALL_LLM_API:'anthropic', FAKE_PI_FLAG_AFTER:'1', FAKE_PI_FLAG_PATH:'/workspace/flags.json', FAKE_PI_SESSION_FILE:'/workspace/session.jsonl'
}});
assert.equal(result.exitCode, 0, result.error + '\\n' + readFileSync(result.logPath, 'utf8'));
assert(JSON.parse(readFileSync(workspace + '/flags.json', 'utf8')).some(x=>x.correct));
console.log('DinD passed: real runDocker, shared-volume bind resolution, baked executor and fake-RPC completion.');
`;
  writeFileSync(join(tmp, 'check.mjs'), script);
  run('cp', join(tmp, 'check.mjs'), 'heimdall:/opt/heimdall/data/check.mjs');
  console.log(run('exec', '-T', 'heimdall', 'node', '/opt/heimdall/data/check.mjs'));
} catch (error) {
  try { console.error(run('logs', '--tail', '50')); } catch {}
  throw error;
} finally {
  try { run('down', '-v', '--remove-orphans'); } finally { rmSync(tmp, { recursive: true, force: true }); }
}
