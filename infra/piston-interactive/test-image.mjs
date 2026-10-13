import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, inputPaths } from './build.mjs';
import { liveTests } from './live-tests.mjs';

const image = process.argv[2];
if (!image || process.argv.length !== 3) throw new Error('Usage: test-image.mjs <interactive-image>');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = JSON.parse(await readFile(path.join(root, 'build-metadata.json')));
const manifest = metadata['containerimage.digest'];
const config = metadata['containerimage.config.digest'];
const inspected = JSON.parse(docker('image', 'inspect', image))[0];
assert.ok([manifest, config].includes(inspected.Id));
assert.equal(inspected.Os, 'linux');
assert.equal(inspected.Architecture, 'amd64');
const expectedInputs = (await readFile(path.join(root, 'build-inputs.sha256'), 'utf8')).trim();
assert.equal(docker('run', '--rm', '--network', 'none', '--entrypoint', '/bin/cat', image,
  '/usr/local/share/codestead-piston-interactive/build-inputs.sha256'), expectedInputs);
const name = `codestead-piston-interactive-test-${process.pid}`;
let started = false;
try {
  // Only a disposable Docker Desktop/CI VM. Production stays in Kata, never privileged.
  docker('run', '-d', '--name', name, '--privileged', '--cgroupns=private', '--read-only',
    '-p', '127.0.0.1::2000', '--tmpfs', '/piston/jobs', '--tmpfs', '/tmp:exec',
    '--tmpfs', '/var/local/lib/isolate:exec', '--tmpfs', '/run/isolate:rw,noexec,nosuid,nodev,size=8m',
    '--memory', '2g', '--cpus', '2', '--pids-limit', '128',
    ...Object.entries({ PISTON_DISABLE_NETWORKING: 'true', PISTON_RUN_TIMEOUT: '300000',
      PISTON_RUN_CPU_TIME: '3000', PISTON_COMPILE_TIMEOUT: '10000', PISTON_COMPILE_CPU_TIME: '10000',
      PISTON_RUN_MEMORY_LIMIT: '268435456', PISTON_COMPILE_MEMORY_LIMIT: '536870912',
      PISTON_MAX_CONCURRENT_JOBS: '2', PISTON_OUTPUT_MAX_SIZE: '65536', PISTON_MAX_PROCESS_COUNT: '32',
      PISTON_LOG_LEVEL: 'ERROR' }).flatMap(([key, value]) => ['-e', `${key}=${value}`]), image);
  started = true;
  const port = JSON.parse(docker('inspect', name))[0].NetworkSettings.Ports['2000/tcp'][0].HostPort;
  const url = `http://127.0.0.1:${port}`;
  let inventory;
  for (let retry = 0; retry < 60; retry++) {
    try {
      const controller = new AbortController();
      // A referenced deadline keeps the startup probe alive even if the HTTP
      // client's pending sockets are unreferenced during a cold container start.
      const timeout = setTimeout(() => controller.abort(), 2000);
      let response;
      try { response = await fetch(url + '/api/v2/runtimes', { signal: controller.signal }); }
      finally { clearTimeout(timeout); }
      if (response.ok) { inventory = await response.json(); break; }
    } catch { /* bounded startup */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(inventory, 'interactive image must become ready');
  const countProcesses = marker => Number(docker('exec', name, 'node', '-e',
    'const fs=require("fs");let n=0;for(const p of fs.readdirSync("/proc")){if(!/^\\d+$/.test(p)||Number(p)===process.pid)continue;try{if(fs.readFileSync("/proc/"+p+"/cmdline").includes(process.argv[1]))n++;}catch{}}process.stdout.write(String(n));', marker));
  const tests = await liveTests(url, countProcesses);
  const inputs = {};
  for (const file of inputPaths) inputs[file] = hash(await readFile(path.join(root, file)));
  const testInputs = {};
  for (const file of ['build.mjs', 'build.test.mjs', 'test-image.mjs', 'live-tests.mjs', 'connection.test.mjs', 'patch.test.mjs', 'compose.test.mjs', 'verify-handoff.mjs']) {
    testInputs[file] = hash(await readFile(path.join(root, file)));
  }
  const lock = JSON.parse(await readFile(path.join(root, '../piston/image-inputs.lock.json')));
  const keys = records => records.map(({ language, version }) => `${language}@${version}`).sort();
  assert.deepEqual(keys(inventory), keys(Object.values(lock.runtimes)));
  const report = {
    schemaVersion: 1, imageReference: `${image.split('@')[0]}@${manifest}`, imageConfigDigest: config,
    baseImage: JSON.parse(await readFile(path.join(root, 'base-image.json'))),
    observedInventory: inventory, buildInputSha256: inputs, testInputSha256: testInputs,
    validation: { passed: true, liveTests: tests, skipped: 0,
      isolation: 'isolate in disposable Docker Desktop/CI VM; production Kata requires owner deployment',
      resourceLimits: { memoryBytes: 2147483648, cpus: 2, pids: 128, slots: 2, readOnly: true } },
  };
  await writeFile(path.join(root, 'image-result.json'), JSON.stringify(report, null, 2) + '\n');
} catch (error) {
  if (started) process.stderr.write(docker('logs', '--tail', '60', name));
  throw error;
} finally {
  if (started) docker('rm', '-f', name);
}
