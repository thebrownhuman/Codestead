import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArgs, sourceDateEpoch } from '../piston/build.mjs';
import { buildInputPaths as batchInputs } from '../piston/prepare.mjs';

export const root = path.dirname(fileURLToPath(import.meta.url));
export const inputPaths = ['Dockerfile', '.dockerignore', 'patch.mjs', 'connection.mjs', 'base-image.json', 'base-inputs.sha256'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
export function requireLocalDriver(description) {
  assert.match(description, /^Driver:\s+docker\s*$/m, 'Interactive builds require the local Docker driver');
}

export function interactiveBuildArgs({ reference, base, builder, ...options }) {
  const args = buildArgs(options);
  // Resolve the immutable FROM through the verified local tag, not a registry.
  // The Docker driver shares the daemon image store used by bindBase/load.
  args.splice(-1, 0, '--builder', builder, '--pull=false',
    '--build-context', `${reference}=docker-image://${base}`,
    '--build-arg', `PISTON_BASE_IMAGE=${reference}`);
  return args;
}

export async function bindBase(image) {
  const lock = JSON.parse(await readFile(path.join(root, '../piston/image-inputs.lock.json')));
  const metadata = JSON.parse(await readFile(path.join(root, '../piston/build-metadata.json')));
  const manifest = metadata['containerimage.digest'];
  const config = metadata['containerimage.config.digest'];
  for (const value of [manifest, config]) assert.match(value, /^sha256:[a-f0-9]{64}$/);
  const inspected = JSON.parse(docker('image', 'inspect', image))[0];
  assert.ok([manifest, config].includes(inspected.Id), 'Base image does not match its build metadata');
  const expected = (await readFile(path.join(root, '../piston/build-inputs.sha256'), 'utf8')).trim();
  const embedded = docker('run', '--rm', '--network', 'none', '--entrypoint', '/bin/cat', image,
    '/usr/local/share/codestead-piston/build-inputs.sha256');
  assert.equal(embedded, expected, 'Base image input manifest changed');
  for (const file of batchInputs) {
    assert.ok(expected.split('\n').includes(`${digest(await readFile(path.join(root, '../piston', file)))}  ${file}`),
      `Base source changed: ${file}`);
  }
  const reference = `codestead-piston@${manifest}`;
  assert.ok(inspected.RepoDigests?.includes(reference), 'Parent digest must exist in the local image store');
  await writeFile(path.join(root, 'base-image.json'), JSON.stringify({
    imageReference: reference, imageConfigDigest: config, pistonCommit: lock.pistonCommit,
    sourceDateEpoch: sourceDateEpoch(lock),
  }, null, 2) + '\n');
  await writeFile(path.join(root, 'base-inputs.sha256'), expected + '\n');
  const lines = await Promise.all(inputPaths.map(async file => `${digest(await readFile(path.join(root, file)))}  ${file}\n`));
  await writeFile(path.join(root, 'build-inputs.sha256'), lines.join(''));
  return { reference, epoch: sourceDateEpoch(lock) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const noCache = args[0] === '--no-cache';
  const [image, base] = args.slice(noCache ? 1 : 0);
  if (!image || !base || args.length !== (noCache ? 3 : 2)) throw new Error('Usage: build.mjs [--no-cache] <interactive-tag> <built-batch-image>');
  if (!docker('info', '--format', '{{json .DriverStatus}}').includes('io.containerd.snapshotter.v1')) {
    throw new Error('The containerd image store is required');
  }
  const builder = docker('context', 'show');
  requireLocalDriver(docker('buildx', 'inspect', builder));
  const bound = await bindBase(base);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codestead-piston-interactive-'));
  try {
    const archive = path.join(directory, 'image.tar');
    const argumentsForBuild = interactiveBuildArgs({ reference: bound.reference, base, builder,
      epoch: bound.epoch, tag: image, archive,
      metadataFile: path.join(root, 'build-metadata.json'), context: root, noCache });
    execFileSync('docker', argumentsForBuild, { stdio: 'inherit' });
    execFileSync('docker', ['load', '--input', archive], { stdio: ['ignore', 'ignore', 'inherit'] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
