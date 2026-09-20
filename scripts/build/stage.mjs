import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { root, validateResources, installCompatibility } from './resources.mjs';

const output = process.argv[2] && resolve(process.argv[2]);
if (!output || output === root || (existsSync(output) && readdirSync(output).length)) {
  throw new Error('Usage: node scripts/build/stage.mjs EMPTY_DIRECTORY [--console]');
}
validateResources();
mkdirSync(output, { recursive: true });
const layout = JSON.parse(readFileSync(join(root, 'resources/runtime-layout.json'), 'utf8'));
for (const path of [...layout.directories, 'dist', 'package.json', 'package-lock.json']) {
  cpSync(join(root, path), join(output, path), { recursive: true });
}
if (process.argv.includes('--console')) cpSync(join(root, 'console/spa'), join(output, 'console/spa'), { recursive: true });
// Old builds can leave module-adjacent prompts behind; the release has a single source.
for (const path of ['agent/protocol.md', 'agent/prompt-templates', 'agent/brief-summarizer-system.md', 'observer/observer_system.md', 'observer/map-template.html']) {
  const { rmSync } = await import('node:fs');
  rmSync(join(output, 'dist', path), { recursive: true, force: true });
}
validateResources(output);
const files = {};
function inventory(dir, rel = '') {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(rel, entry.name);
    if (entry.isDirectory()) inventory(join(dir, entry.name), path);
    else if (entry.isFile()) files[path] = createHash('sha256').update(readFileSync(join(dir, entry.name))).digest('hex');
  }
}
inventory(output);
writeFileSync(join(output, 'release-manifest.json'), JSON.stringify({ version: 1, files }, null, 2) + '\n');
installCompatibility(output);
console.log(`Release staged at ${output}; install dependencies with npm ci --omit=dev.`);
