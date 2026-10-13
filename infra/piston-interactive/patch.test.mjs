import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { test } from 'node:test';
import { patchJob, replaceExactly, upstreamHashes } from './patch.mjs';

const archive = new URL('../piston/.downloads/sources/piston.tar.gz', import.meta.url);
const source = execFileSync('tar', ['-xOf', fileURLToPath(archive),
  'piston-de2b365ac759670a3a0d13ea208a0869a92c7e64/api/src/job.js'], { encoding: 'utf8' });
assert.equal(createHash('sha256').update(source).digest('hex'), upstreamHashes['job.js']);

function fixture() {
  const pendingCleanup = [];
  const initializedIds = [];
  const cp = {
    exec: (command, callback) => {
      if (command.includes('--init')) {
        initializedIds.push(Number(/-b(\d+)/.exec(command)[1]));
        queueMicrotask(() => callback(null, '/box', ''));
      }
      else pendingCleanup.push(callback);
    },
  };
  const fs = { mkdir: async () => {}, write_file: async () => {}, rm: async () => {} };
  const sandboxModule = { exports: {} };
  const dependencies = {
    logplease: { create: () => ({ debug() {}, info() {} }) },
    uuid: { v4: () => 'job' }, child_process: cp,
    path: path.posix,
    './config': { max_concurrent_jobs: 2 }, 'fs/promises': fs, './globals': {},
  };
  new Script(patchJob(source)).runInNewContext({ require: name => dependencies[name], module: sandboxModule, Buffer });
  const create = () => new sandboxModule.exports.Job({ runtime: { language: 'python' },
    files: [{ name: 'main.py', content: '1' }], args: [], stdin: '', timeouts: {}, cpu_times: {}, memory_limits: {} });
  return { create, pendingCleanup, initializedIds };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('patch refuses ambiguous contexts and produces valid pinned JavaScript', () => {
  assert.throws(() => replaceExactly('a a', 'a', 'b'), /drifted/);
  assert.throws(() => replaceExactly('a', 'absent', 'b'), /drifted/);
  new Script(patchJob(source));
});

test('cancelled queued jobs do not consume or manufacture slots; release waits for cleanup', async () => {
  const f = fixture();
  const [one, two, queued, next] = Array.from({ length: 4 }, f.create);
  await Promise.all([one.prime(), two.prime()]);
  const waiting = queued.prime();
  const rejection = assert.rejects(waiting, /cancelled/);
  queued.cancel();
  await rejection;
  await queued.cleanup();
  let nextStarted = false;
  const nextPrime = next.prime().then(() => { nextStarted = true; });
  await turn();
  assert.equal(nextStarted, false, 'cancelled waiter must not release someone else\'s slot');
  const cleanup = one.cleanup();
  await turn();
  assert.equal(nextStarted, false, 'slot remains occupied until isolate cleanup confirms completion');
  f.pendingCleanup.shift()(null);
  await cleanup;
  await nextPrime;
  assert.equal(nextStarted, true);
  await Promise.all([one.cleanup(), one.cleanup()]);
  assert.equal(f.pendingCleanup.length, 0, 'repeated cleanup must not tear down or release twice');
  for (const job of [two, next]) {
    const release = job.cleanup();
    await turn();
    f.pendingCleanup.shift()(null);
    await release;
  }
});

test('cancellation signals isolate supervisor with SIGTERM, not the learner process', () => {
  const job = fixture().create();
  const signals = [];
  job.live_process = { kill: signal => signals.push(signal) };
  job.cancel();
  assert.equal(job.cancelled, true);
  assert.deepEqual(signals, ['SIGTERM']);
});

test('failed cleanup does not release capacity to another job', async () => {
  const f = fixture();
  const [one, two, queued] = Array.from({ length: 3 }, f.create);
  await Promise.all([one.prime(), two.prime()]);
  let started = false;
  const prime = queued.prime().then(() => { started = true; });
  const release = one.cleanup();
  const rejection = assert.rejects(release, /cleanup failed/);
  await turn();
  f.pendingCleanup.shift()(new Error('cleanup failed'));
  await rejection;
  await turn();
  assert.equal(started, false);
  queued.cancel();
  await assert.rejects(prime, /cancelled/);
  const releaseTwo = two.cleanup();
  await turn();
  f.pendingCleanup.shift()(null);
  await releaseTwo;
});

test('box IDs cannot wrap onto a long-lived active terminal', async () => {
  const f = fixture();
  const terminal = f.create();
  await terminal.prime();
  const reserved = f.initializedIds[0];
  for (let index = 0; index < 1100; index++) {
    const quick = f.create();
    await quick.prime();
    assert.notEqual(f.initializedIds.at(-1), reserved, 'a live sandbox ID must never be reused');
    const release = quick.cleanup();
    await turn();
    f.pendingCleanup.shift()(null);
    await release;
  }
  const release = terminal.cleanup();
  await turn();
  f.pendingCleanup.shift()(null);
  await release;
});
