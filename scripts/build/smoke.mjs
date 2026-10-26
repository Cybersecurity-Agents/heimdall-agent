import { createServer } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from './resources.mjs';
const temporary = mkdtempSync(join(tmpdir(), 'heimdall release '));
const release = join(temporary, 'installation with spaces');
try {
  execFileSync(process.execPath, [join(root, 'scripts/build/stage.mjs'), release, '--console']);
  symlinkSync(join(root, 'node_modules'), join(release, 'node_modules'), 'dir');
  if (existsSync(join(release, 'src'))) throw new Error('Release unexpectedly includes src');
  const isolatedHome = join(temporary, 'home'); mkdirSync(isolatedHome);
  const env = { PATH: process.env.PATH, HOME: isolatedHome, HEIMDALL_NODE: process.execPath, HEIMDALL_REPO_ROOT: release, PI_OFFLINE: '1' };
  const script = `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { loadPrompt } from './installation with spaces/dist/shared/resources.js';
    import { seedWorkspace } from './installation with spaces/dist/control/seed.js';
    import { loadPiResources } from './installation with spaces/dist/agent/backends/pi.js';
    import { seedPiWorkspace } from './installation with spaces/dist/shared/pi-workspace.js';
    const root = process.env.HEIMDALL_REPO_ROOT;
    for (const id of ['solver-protocol','solver-user','solver-loop','observer','summarizer']) assert(loadPrompt(id).length > 20);
    const ws = root + '/fixture-workspace';
    seedWorkspace(ws, root, { challengeType: 'all' });
    const dir = seedPiWorkspace(ws, { systemPrompt: loadPrompt('solver-protocol') });
    const { resourceLoader } = await loadPiResources(ws, dir, loadPrompt('solver-protocol'), true);
    assert.deepEqual(resourceLoader.getSkills().skills.map(s => s.name), ['waf-bypass']);
    assert.equal(resourceLoader.getSkills().diagnostics.length, 0);
    for (const skill of resourceLoader.getSkills().skills) assert(readFileSync(skill.filePath, 'utf8').length > 20);
    assert(readFileSync(root + '/tools/wordlists/passwords.txt', 'utf8').length > 0);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: temporary, env, stdio: 'pipe' });
  execFileSync(join(release, 'bin/heimdall'), ['--help'], { cwd: temporary, env, stdio: 'pipe' });
  execFileSync(join(release, 'tools/heimdall'), ['--help'], { cwd: temporary, env, stdio: 'pipe' });
  const hooks = join(temporary, 'hooks'); mkdirSync(hooks);
  symlinkSync(join(release, 'scripts/runtime/heimdall_hook_bash'), join(hooks, 'bash'));
  execFileSync(join(release, 'bin/heimdall'), ['--help'], { cwd: temporary, env: { ...env, PATH: hooks + ':' + env.PATH, HEIMDALL_WORKSPACE: join(release, 'fixture-workspace') }, timeout: 10_000, stdio: 'pipe' });
  execFileSync(join(release, 'bin/heimdall-cve'), ['--help'], { cwd: temporary, env, stdio: 'pipe' });
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const config = join(release, 'fixture.yaml');
  writeFileSync(config, 'docker:\n  runtime: local\npaths:\n  data_dir: data\n');
  const desk = spawn(join(release, 'bin/heimdall'), ['--config', config, 'console', '--listen', `127.0.0.1:${port}`], { cwd: temporary, env, stdio: ['ignore','pipe','pipe'] });
  let output = ''; desk.stdout.on('data', x => { output += x; }); desk.stderr.on('data', x => { output += x; });
  const closed = new Promise(resolve => desk.once('close', resolve));
  try {
    let response;
    for (let i = 0; i < 50; i++) {
      if (desk.exitCode !== null) throw new Error(`Desk exited during startup: ${output}`);
      try { response = await fetch(`http://127.0.0.1:${port}/`); if (response.ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!response?.ok) throw new Error(`Desk did not start: ${output}`);
    const html = await response.text();
    const paths = ['/projects', ...[...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(m => m[1])];
    if (paths.length < 3) throw new Error('Missing compiled JS/CSS references');
    for (const path of paths) {
      const result = await fetch(`http://127.0.0.1:${port}${path}`);
      if (!result.ok) throw new Error(`Desk resource failed: ${path} ${result.status}`);
      await result.arrayBuffer();
    }
  } finally { desk.kill('SIGTERM'); await closed; }
  console.log('Release smoke passed: no src, external cwd, spaces, prompts, the real Pi waf-bypass skill, canonical and legacy CLI, hooks, CVE, console routing and JS/CSS.');
} finally { rmSync(temporary, { recursive: true, force: true }); }
