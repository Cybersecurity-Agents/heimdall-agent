import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './resources.mjs';
const { volumeArgs } = await import(pathToFileURL(join(root, 'dist/control/docker-runner.js')));
const { seedWorkspace } = await import(pathToFileURL(join(root, 'dist/control/seed.js')));
const { snapshotConsolePrompts } = await import(pathToFileURL(join(root, 'dist/control/prompt-snapshot.js')));
const image = process.argv[2];
if (!image) throw new Error('Usage: node scripts/build/smoke-docker.mjs IMAGE');
const temporary = mkdtempSync(join(tmpdir(), 'heimdall-container-'));
try {
  const cfg = { repo_root: root, data_dir: temporary, docker_runtime_mounts: "image" };
  mkdirSync(join(temporary, 'console')); writeFileSync(join(temporary, 'console/system_prompt.md'), 'Fixture desk solver protocol.\n');
  for (const type of ['web', 'all']) {
    const workspace = join(temporary, type); const jobDir = join(temporary, `${type}-job`);
    mkdirSync(jobDir); seedWorkspace(workspace, root, { challengeType: type }); snapshotConsolePrompts(cfg, workspace);
    writeFileSync(join(workspace, 'input.json'), JSON.stringify({ unique_code: 'fixture', challenge_type: type, flag_count: 1 }));
    const mounts = volumeArgs(cfg, { workspace, jobDir });
    mkdirSync(join(temporary, 'empty-src'), { recursive: true });
    mounts.push('-v', `${join(temporary, 'empty-src')}:/opt/heimdall/src:ro`, '-v', `${join(root, 'test/fixtures')}:/fixtures:ro`);
    const env = {
      HEIMDALL_REPO_ROOT: '/opt/heimdall', HEIMDALL_WORKSPACE: '/workspace', HEIMDALL_AGENT_BACKEND: 'pi', HEIMDALL_PI_TRANSPORT: 'rpc',
      HEIMDALL_PI_CLI: '/fixtures/fake_pi_rpc.py', HEIMDALL_LOOP_TIMEOUT_SEC: '4', HEIMDALL_MAX_TURNS: '2', HEIMDALL_CHALLENGE_TYPE: type,
      HEIMDALL_COACH: '0', HEIMDALL_BRIEF_SUMMARIZER: '0', HEIMDALL_DISABLE_HTTP_TAP: '1', HEIMDALL_DISABLE_LLM_TAP: '1',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/anthropic', ANTHROPIC_API_KEY: 'offline-fixture', HEIMDALL_LLM_API: 'anthropic',
      UNIQUE_CODE: 'fixture', FAKE_PI_FLAG_AFTER: '1', FAKE_PI_FLAG_PATH: '/workspace/flags.json', FAKE_PI_SESSION_FILE: '/workspace/fixture-session.jsonl',
    };
    const args = ['run', '--rm', '--network', 'none', ...mounts, ...Object.entries(env).flatMap(([k,v]) => ['-e', `${k}=${v}`]), '--entrypoint', '/bin/bash', image];
    const checks = 'set -e; test -s /opt/heimdall/tools/wordlists/passwords.txt; test -x /opt/heimdall/tools/heimdall; command -v chisel; command -v certipy; command -v secretsdump.py; exec /bin/bash /opt/heimdall/scripts/runtime/ctf-agent.sh';
    execFileSync('docker', [...args, '-c', checks], { timeout: 30_000, stdio: 'pipe' });
    assert(JSON.parse(readFileSync(join(workspace, 'flags.json'), 'utf8')).some(x => x.correct));
    const prompt = readFileSync(join(workspace, '.heimdall/agent_prompt.md'), 'utf8');
    assert(prompt.includes('Fixture desk solver protocol.'));
    assert(prompt.includes('# Workspace playbook (CLAUDE.md)'));
    console.log(`Docker ${type}: real runtime mounts, hooks, desk overlay, fake RPC task completion, AD and chisel passed.`);
  }
} finally {
  // Container entrypoints run as root and create job-owned files on this test mount.
  execFileSync('docker', ['run', '--rm', '--network', 'none', '-v', `${temporary}:/cleanup`, '--entrypoint', '/bin/chown', image, '-R', `${process.getuid()}:${process.getgid()}`, '/cleanup']);
  rmSync(temporary, { recursive: true, force: true });
}
