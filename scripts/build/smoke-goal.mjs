// Host controller <-> network-isolated executor. No model/platform credentials.
// Run after build: node scripts/build/smoke-goal.mjs heimdall:executor-candidate
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../../dist/shared/db.js';
import { GoalController } from '../../dist/control/goal-controller.js';
import { parseGoalConfig, pendingVerdict } from '../../dist/shared/goal.js';
import { emptySubmit } from '../../dist/platforms/types.js';

const image = process.argv[2];
if (!image) throw new Error('Usage: node scripts/build/smoke-goal.mjs IMAGE');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dir = mkdtempSync('/tmp/heimdall-goal-smoke-');
const db = new Database(join(dir, 'control.sqlite'));
const workspace = join(dir, 'workspace');
const { mkdirSync } = await import('node:fs'); mkdirSync(workspace);
let submissions = 0, stops = 0;
const client = {
  async listChallenges() { return [{ unique_code: 'fixture', flag_count: 2, correct_flag_count: submissions, is_completed: submissions >= 2, container_addr: [], container_status: 'available', level: 1, description: null, difficulty: null, total_score: 100 }]; },
  async submit() { submissions++; return emptySubmit({ correct: true, correct_flag_count: submissions, total_flag_count: 2 }); },
};
const spec = { taskId: 'fixture-task', revision: 1, instanceEpoch: 'fixture-instance', code: 'fixture', objective: 'Collect both accepted flags',
  acceptance: { kind: 'platform_flags' }, persistence: 'until_satisfied', createdAt: Date.now(), deadlineAt: null };
const record = { spec, state: 'running', verdict: pendingVerdict(spec), workspace, jobId: 'fixture-job', runOptions: { flagCount: 2 }, nextRunAt: 0, reason: '' };
writeFileSync(join(workspace, 'input.json'), JSON.stringify({ unique_code: 'fixture', job_id: 'fixture-job', goal_managed: true }));
const controller = new GoalController(db, client, parseGoalConfig({}), record, () => { stops++; });
assert(controller.start());
const containerName = `heimdall-goal-smoke-${process.pid}`;
async function run(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['run', '--rm', '--name', containerName, '--network', 'none', '--init',
      '--mount', `type=bind,src=${workspace},dst=/workspace`, '--mount', `type=bind,src=${root},dst=/opt/heimdall,readonly`,
      '-e', 'HEIMDALL_WORKSPACE=/workspace', '-e', 'UNIQUE_CODE=fixture', '--entrypoint', `/opt/heimdall/bin/${command}`, image, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; proc.stdout.on('data', b => { output += b; }); proc.stderr.on('data', b => { output += b; });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`Container request timed out: ${output}`)); }, 60000);
    proc.once('error', e => { clearTimeout(timer); reject(e); });
    proc.once('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}
try {
  let result = await run('heimdall-submit', ['flag{first_fixture}']); assert.equal(result.code, 0, result.output);
  assert.equal(record.verdict.state, 'unsatisfied'); assert.equal(stops, 0);
  result = await run('heimdall-submit', ['flag{first_fixture}']); assert.equal(result.code, 0, result.output);
  assert.equal(submissions, 1);
  result = await run('heimdall-goal', ['check', '--json']); assert.equal(result.code, 1, result.output);
  assert.match(result.output, /unsatisfied/);
  result = await run('heimdall-submit', ['flag{second_fixture}']); assert.equal(result.code, 0, result.output);
  result = await run('heimdall-goal', ['check', '--json']); assert.equal(result.code, 0, result.output);
  assert.match(result.output, /satisfied/);
  assert.equal(db.getGoal(workspace).state, 'succeeded'); assert.equal(submissions, 2); assert.equal(stops, 1);
  console.log('Goal Docker smoke passed: isolated container, serialized submissions, duplicate suppression, partial flags stay open, verified completion.');
} finally {
  await controller.close();
  await new Promise(r => { const p = spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore' }); p.once('error', r); p.once('close', r); });
  rmSync(dir, { recursive: true, force: true });
}
