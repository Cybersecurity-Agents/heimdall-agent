import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function linkCompat(from, to, installRoot = root) {
  const path = join(installRoot, from);
  const target = join(installRoot, to);
  if (!existsSync(target)) throw new Error(`Missing compatibility target: ${to}`);
  mkdirSync(dirname(path), { recursive: true });
  const rel = relative(dirname(path), target);
  if (existsSync(path) || (() => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } })()) {
    if (!lstatSync(path).isSymbolicLink()) throw new Error(`Refusing to overwrite local file: ${path}`);
    if (readlinkSync(path) === rel) return;
    unlinkSync(path);
  }
  symlinkSync(rel, path);
}
export function validateResources(installRoot = root) {
  const mapping = JSON.parse(readFileSync(join(installRoot, 'resources/skills/mapping.json'), 'utf8'));
  const wordlistLimits = { 'paths.txt': 300, 'usernames.txt': 50, 'passwords.txt': 300, 'lfi.txt': 300, 'sqli.txt': 300 };
  const layout = JSON.parse(readFileSync(join(installRoot, 'resources/runtime-layout.json'), 'utf8'));
  const names = Object.keys(wordlistLimits).sort();
  const wordlists = join(installRoot, 'resources/wordlists');
  if (JSON.stringify([...layout.defaultWordlists].sort()) !== JSON.stringify(names)
      || JSON.stringify(readdirSync(wordlists).filter(name => name.endsWith('.txt')).sort()) !== JSON.stringify(names)) {
    throw new Error('Runtime must distribute exactly paths, usernames, passwords, lfi and sqli dictionaries');
  }
  for (const [name, limit] of Object.entries(wordlistLimits)) {
    const lines = readFileSync(join(wordlists, name), 'utf8').split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    if (!lines.length || lines.length > limit || lines.some(line => !line.trim() || line.startsWith('#'))
        || new Set(lines).size !== lines.length) {
      throw new Error(`Invalid dictionary ${name}: require 1..${limit} unique, nonblank entries without comments`);
    }
  }
  const required = [
    ...names.map(name => `resources/wordlists/${name}`),
    'resources/workspaces/base/findings.json', 'resources/workspaces/templates/map-template.html',
    'resources/cve/INDEX.md', 'resources/cve/README.md', 'resources/cve/SOURCE.txt',
  ];
  for (const [role, files] of Object.entries({solver: ['protocol.md', 'user.md', 'loop_followup.md'], observer: ['observer_system.md', 'observer_spray.md', 'observer_recap.md'], summarizer: ['brief-summarizer-system.md']})) {
    for (const lang of ['zh', 'en']) for (const file of files) required.push(`resources/prompts/${role}/${lang}/${file}`);
  }
  for (const type of ['all','web','cve','pwn','intranet','evasion']) {
    if (!Array.isArray(mapping.types[type])) throw new Error(`Missing skill mapping: ${type}`);
    required.push(`resources/workspaces/types/${type}/CLAUDE.md`, `resources/workspaces/types/${type}/_en/CLAUDE.md`);
    const names = [...mapping.common, ...mapping.types[type]];
    if (new Set(names).size !== names.length) throw new Error(`Duplicate skills for ${type}`);
    for (const name of names) {
      if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Invalid skill name: ${name}`);
      required.push(`resources/skills/catalog/${name}/SKILL.md`);
      const text = readFileSync(join(installRoot, `resources/skills/catalog/${name}/SKILL.md`), 'utf8');
      if (!text.startsWith('---\n') || !text.includes(`name: ${name}`)) throw new Error(`Invalid skill: ${name}`);
    }
  }
  for (const path of new Set(required)) if (!readFileSync(join(installRoot, path), 'utf8').trim()) throw new Error(`Empty resource: ${path}`);
}
export function installCompatibility(installRoot = root) {
  const layout = JSON.parse(readFileSync(join(installRoot, 'resources/runtime-layout.json'), 'utf8'));
  for (const [from, to] of Object.entries(layout.compatibility)) linkCompat(from, to, installRoot);

}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateResources();
  installCompatibility();
  console.log('Runtime resources validated; compatibility paths ready.');
}
