import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { validateResources } from './resources.mjs';

const root = process.env.HEIMDALL_REPO_ROOT || '/opt/heimdall';
validateResources(root);
assert(!existsSync('/usr/share/sqlmap/data/txt/wordlist.tx_'), 'SQLMap bundled large dictionary must be removed');
const contract = JSON.parse(readFileSync(join(root, 'resources/toolkits/runtime-contract.json'), 'utf8'));
const missing = contract.commands.filter(name => !(process.env.PATH || '').split(delimiter).some(dir => {
  try { accessSync(join(dir, name), constants.X_OK); return true; } catch { return false; }
}));
assert.equal(missing.length, 0, `Missing required tools: ${missing.join(', ')}`);
const retired = ['J35', 'j35', 'zdrive', 'xdrive', 'zdrive-selfhost', 'ztime', 'ztimes', 'ztimec'];
for (const name of retired) {
  const found = (process.env.PATH || '').split(delimiter).some(dir => {
    try { accessSync(join(dir, name), constants.X_OK); return true; } catch { return false; }
  });
  assert.equal(found, false, `retired toolkit still on PATH: ${name}`);
}
for (const path of ['c2', 'tools/c2']) {
  assert(!existsSync(join(root, path)), `retired C2 tree must not ship: ${path}`);
}
const run = (cmd, args) => execFileSync(cmd, args, { timeout: 120_000, stdio: 'pipe' });
assert(Number(process.versions.node.split('.')[0]) >= 22, 'Node >=22 required');
run(join(root, 'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'), ['--version']);
run('python3', ['-c', 'import pwn, angr, unicorn, capstone, keystone, elftools, z3, Crypto, cryptography, bs4, lxml, requests, IPython']);
for (const [cmd, args] of [
  ['pi', ['--version']], ['httpx', ['-version']], ['nuclei', ['-version']], ['r2', ['-v']], ['pwninit', ['--version']],
  ['java', ['-version']], ['java8', ['-version']], ['java11', ['-version']],
  ['gdb', ['--batch', '-ex', 'file /bin/true', '-ex', 'info files']],
  ['pwndbg', ['--batch', '-ex', 'file /bin/true', '-ex', 'info files']],
  ['pyghidra-mcp', ['--help']], ['androguard', ['--help']], ['nxc', ['--help']],
]) run(cmd, args);
assert(!readFileSync(run('which', ['httpx']).toString().trim()).subarray(0, 80).toString().includes('python'), 'PD httpx was shadowed');
for (const path of ['ghidra/support/analyzeHeadless', 'nuclei-templates/http/cves', 'cve-poc/README.md',
  'tools/wordlists/paths.txt', 'tools/wordlists/passwords.txt', 'proxy/chisel-drop/chisel_linux_amd64']) {
  assert(existsSync(join(root, path)), `Missing tool resource: ${path}`);
}
const languages = run('tesseract', ['--list-langs']).toString();
assert(languages.includes('eng') && languages.includes('chi_sim'), 'Missing OCR languages');
const work = mkdtempSync(join(tmpdir(), 'heimdall-tools-'));
try {
  writeFileSync(join(work, 'check.c'), 'int main(void) { return 0; }\n');
  for (const arch of ['-m64', '-m32']) {
    run('gcc', [arch, join(work, 'check.c'), '-o', join(work, 'check')]);
    run(join(work, 'check'), []);
  }
  // A real browser launch catches missing libraries and wrong download paths.
  const opts = { cwd: work, timeout: 120_000, stdio: 'pipe' };
  try {
    execFileSync('playwright-cli', ['open', 'about:blank'], opts);
    execFileSync('playwright-cli', ['eval', 'document.readyState'], opts);
  } finally { execFileSync('playwright-cli', ['close'], opts); }
} finally { rmSync(work, { recursive: true, force: true }); }
if (process.argv.includes('--write-marker')) {
  writeFileSync('/etc/heimdall-runtime.json', JSON.stringify({ ...contract, verified_at: new Date().toISOString() }, null, 2));
}
console.log(`Full environment verified: ${contract.commands.length} commands, Python imports, 32/64-bit compilation, browser, OCR and resource paths.`);
