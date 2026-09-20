// Exercise an unmodified release image: no source/dist/node_modules overlays.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const image = process.argv[2];
if (!image) throw new Error('Usage: node scripts/build/smoke-container.mjs IMAGE');
const prefix = `heimdall-smoke-${process.pid}-${Date.now()}`;
const volume = `${prefix}-data`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const fixtures = resolve('test/fixtures');
try {
  docker('volume', 'create', volume);
  const start = () => docker('run', '-d', '--name', prefix, '--network', 'none', '--init',
    '--mount', `type=volume,src=${volume},dst=/opt/heimdall/data`, image);
  const healthy = async () => {
    for (let n = 0; n < 60; n++) {
      try {
        const health = JSON.parse(docker('exec', prefix, 'node', '-e', "fetch('http://127.0.0.1:8700/health').then(r=>r.text()).then(console.log)"));
        if (health.ok) {
          assert.equal(health.settings.runtime_capabilities.local.available, true);
          const vpn = JSON.parse(docker('exec', prefix, 'node', '-e', "fetch('http://127.0.0.1:8700/api/vpn').then(r=>r.text()).then(console.log)"));
          assert.equal(vpn.mode, 'embedded');
          assert.equal(vpn.running, false);
          assert.equal(vpn.ready, false);
          return;
        }
      } catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`Desk startup failed: ${docker('logs', prefix)}`);
  };
  start(); await healthy();
  docker('exec', prefix, 'node', '-e', "require('fs').writeFileSync('/opt/heimdall/data/recreate-check','retained')");
  docker('rm', '-f', prefix);
  start(); await healthy();
  assert.equal(docker('exec', prefix, 'cat', '/opt/heimdall/data/recreate-check'), 'retained');
  const env = {
    HEIMDALL_WORKSPACE: '/workspace', HEIMDALL_REPO_ROOT: '/opt/heimdall', HEIMDALL_AGENT_BACKEND: 'pi',
    HEIMDALL_PI_TRANSPORT: 'rpc', HEIMDALL_PI_CLI: '/fixtures/fake_pi_rpc.py',
    HEIMDALL_COACH: '0', HEIMDALL_BRIEF_SUMMARIZER: '0', HEIMDALL_DISABLE_HTTP_TAP: '1', HEIMDALL_DISABLE_LLM_TAP: '1',
    HEIMDALL_LOOP_TIMEOUT_SEC: '8', HEIMDALL_MAX_TURNS: '2', HEIMDALL_CHALLENGE_TYPE: 'all',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/anthropic', ANTHROPIC_API_KEY: 'offline-fixture', HEIMDALL_LLM_API: 'anthropic',
    UNIQUE_CODE: 'fixture', FAKE_PI_FLAG_AFTER: '1', FAKE_PI_FLAG_PATH: '/workspace/flags.json',
    FAKE_PI_SESSION_FILE: '/workspace/session.jsonl',
  };
  const script = `set -e
mkdir -p /workspace
node --input-type=module -e 'import {seedWorkspace} from "/opt/heimdall/dist/control/seed.js"; seedWorkspace("/workspace", "/opt/heimdall", {challengeType:"all"})'
printf '%s' '{"unique_code":"fixture","challenge_type":"all","flag_count":1}' > /workspace/input.json
bash /opt/heimdall/scripts/runtime/ctf-agent.sh
node -e 'if(!require("/workspace/flags.json").some(x=>x.correct)) process.exit(1)'
`;
  docker('run', '--rm', '--network', 'none', '--init', '--mount', `type=bind,src=${fixtures},dst=/fixtures,readonly`,
    ...Object.entries(env).flatMap(([k,v]) => ['-e', `${k}=${v}`]), '--entrypoint', 'bash', image, '-c', script);
  console.log('Image smoke passed: desk health, full tools capability, recreation persistence, baked runtime and offline fake-RPC completion.');
} finally {
  try { docker('rm', '-f', prefix); } catch {}
  try { docker('volume', 'rm', volume); } catch {}
}
