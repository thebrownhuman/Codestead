import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inputPaths, root } from './build.mjs';
import { buildInputPaths as batchInputs } from '../piston/prepare.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function verifyHandoff() {
  const bytes = await readFile(path.join(root, 'runtime-handoff.json'));
  const expectedDigest = (await readFile(path.join(root, 'runtime-handoff.sha256'), 'utf8')).trim();
  assert.equal(digest(bytes), expectedDigest, 'Interactive handoff digest changed');
  const record = JSON.parse(bytes);
  assert.match(record.imageReference, /^codestead-piston-interactive:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$/);
  assert.match(record.imageConfigDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(record.baseImage.imageReference, /^codestead-piston@sha256:[a-f0-9]{64}$/);
  assert.notEqual(record.imageReference.split('@')[1], record.imageConfigDigest);
  assert.equal(record.validation.passed, true);
  assert.equal(record.validation.skipped, 0);
  assert.equal(record.validation.liveTests.length, 15);
  assert.ok(record.validation.liveTests.every(test => test.passed === true));
  assert.deepEqual(record.validation.resourceLimits, { memoryBytes: 2147483648, cpus: 2, pids: 128, slots: 2, readOnly: true });
  const lock = JSON.parse(await readFile(path.join(root, '../piston/image-inputs.lock.json')));
  assert.equal(record.baseImage.pistonCommit, lock.pistonCommit);
  assert.equal(record.baseImage.sourceDateEpoch, lock.sourceDateEpoch);
  const runtimeKeys = runtimes => runtimes.map(({ language, version }) => `${language}@${version}`).sort();
  assert.deepEqual(runtimeKeys(record.observedInventory), runtimeKeys(Object.values(lock.runtimes)));
  assert.deepEqual(Object.keys(record.buildInputSha256), inputPaths);
  for (const file of inputPaths.filter(file => !['base-image.json', 'base-inputs.sha256'].includes(file))) {
    assert.equal(digest(await readFile(path.join(root, file))), record.buildInputSha256[file], `Stale interactive image input: ${file}`);
  }
  assert.equal(digest(JSON.stringify(record.baseImage, null, 2) + '\n'), record.buildInputSha256['base-image.json']);
  const parentManifest = (await Promise.all(batchInputs.map(async file =>
    `${digest(await readFile(path.join(root, '../piston', file)))}  ${file}\n`))).join('');
  assert.equal(digest(parentManifest), record.buildInputSha256['base-inputs.sha256'], 'Batch parent source changed');
  for (const [file, expected] of Object.entries(record.testInputSha256)) {
    assert.equal(digest(await readFile(path.join(root, file))), expected, `Stale image verification source: ${file}`);
  }
  return expectedDigest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyHandoff();
}
