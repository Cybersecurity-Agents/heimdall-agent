// Export an already verified image and a self-contained offline installer.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { root } from './resources.mjs';

const image = process.argv[2];
const output = process.argv[3] && resolve(process.argv[3]);
if (!image || image.startsWith('-') || !output || !output.endsWith('.tar')) {
  throw new Error('Usage: npm run package:docker -- IMAGE OUTPUT.tar (contains a gzip-compressed Docker image)');
}
const inspect = JSON.parse(execFileSync('docker', ['image', 'inspect', image], { encoding: 'utf8' }))[0];
if (inspect.Os !== 'linux' || inspect.Architecture !== 'amd64') throw new Error('Expected a linux/amd64 deployment image');
await mkdir(dirname(output), { recursive: true });
const temporary = await mkdtemp(join(dirname(output), '.heimdall-bundle-'));
const bundle = join(temporary, 'heimdall-agent');
await mkdir(bundle);
const digest = async path => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
try {
  for (const [from, to] of [['compose.yaml', 'compose.yaml'], ['.env.example', '.env.example'],
    ['deploy/offline/install.sh', 'install.sh'], ['deploy/offline/README.md', 'README.md']]) {
    await copyFile(join(root, from), join(bundle, to));
  }
  await chmod(join(bundle, 'install.sh'), 0o755);
  await writeFile(join(bundle, 'image.txt'), image + '\n');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim();
  const imageRevision = inspect.Config.Labels?.['org.opencontainers.image.revision'];
  if (imageRevision && imageRevision !== 'unknown' && imageRevision !== revision) {
    throw new Error('Image revision differs from HEAD; rebuild the image before packaging');
  }
  await writeFile(join(bundle, 'release.json'), JSON.stringify({ image, imageId: inspect.Id,
    platform: 'linux/amd64', revision, imageRevision, dirty: Boolean(status), created: new Date().toISOString(),
    lockfileSha256: await digest(join(root, 'package-lock.json')) }, null, 2) + '\n');
  console.log(`Exporting ${image} (${inspect.Id})…`);
  const child = spawn('docker', ['image', 'save', image], { stdio: ['ignore', 'pipe', 'inherit'] });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`docker save exited ${code}`)));
  });
  try {
    await Promise.all([done, pipeline(child.stdout, createGzip({ level: 1 }), createWriteStream(join(bundle, 'heimdall-image.tar.gz'), { flags: 'wx' }))]);
  } catch (error) { child.kill(); throw error; }
  const files = ['heimdall-image.tar.gz', 'compose.yaml', '.env.example', 'install.sh', 'README.md', 'image.txt', 'release.json'];
  await writeFile(join(bundle, 'SHA256SUMS'), (await Promise.all(files.map(async name => `${await digest(join(bundle, name))}  ${name}`))).join('\n') + '\n');
  // The image is already compressed; an uncompressed outer tar avoids recompression.
  const archive = join(temporary, 'bundle.tar');
  const out = createWriteStream(archive, { flags: 'wx' });
  const tar = spawn('python3', ['-c',
    'import sys,tarfile; t=tarfile.open(fileobj=sys.stdout.buffer,mode="w|"); t.add(sys.argv[1],arcname="heimdall-agent"); t.close()',
    bundle], { stdio: ['ignore', 'pipe', 'inherit'] });
  const tarDone = new Promise((resolve, reject) => {
    tar.once('error', reject);
    tar.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`Archive writer exited ${code ?? signal}`)));
  });
  try { await Promise.all([tarDone, pipeline(tar.stdout, out)]); }
  catch (error) { tar.kill(); throw error; }
  await link(archive, output); // Atomic publish; refuse to replace an existing release.
  await writeFile(output + '.sha256', `${await digest(output)}  ${output.split('/').at(-1)}\n`, { flag: 'wx' });
  console.log(`Offline bundle: ${output}`);
} finally { await rm(temporary, { recursive: true, force: true }); }
