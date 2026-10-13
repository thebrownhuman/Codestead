import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const batchCompose = readFileSync(path.join(root, 'compose.yaml'), 'utf8');
const image = `codestead-piston-interactive:contract@sha256:${'a'.repeat(64)}`;
const appImages = Object.fromEntries([...batchCompose.matchAll(/\$\{(APP_[A-Z_]*IMAGE):/g)].map(([, name]) =>
  [name, `ghcr.io/thebrownhuman/compose-contract@sha256:${'b'.repeat(64)}`]));
function render(addon, profiles) {
  const result = spawnSync('docker', ['compose', '--env-file', 'infra/env/compose.env.example',
    '-f', 'compose.yaml', ...(addon ? ['-f', 'compose.piston-interactive.yaml'] : []),
    ...profiles.flatMap(profile => ['--profile', profile]), 'config', '--format', 'json'], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...appImages, APP_NAME: 'Interactive Compose contract',
      APP_URL: 'https://compose-contract.example', BOOTSTRAP_ADMIN_EMAIL: 'admin@compose-contract.example',
      COMPOSE_PROFILES: '', PISTON_IMAGE: `codestead-piston:contract@sha256:${'c'.repeat(64)}`,
      PISTON_INTERACTIVE_IMAGE: image, SENTRY_RELEASE: 'd'.repeat(40), GITHUB_TOKEN: '' },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('interactive addon leaves every existing service byte-equivalent in Compose and is profile-off by default', () => {
  const baseline = render(false, ['piston']);
  const inactive = render(true, ['piston']);
  assert.deepEqual(inactive.services, baseline.services);
  const active = render(true, ['piston', 'piston-interactive']);
  for (const [name, service] of Object.entries(baseline.services)) {
    assert.deepEqual(active.services[name], service, `existing service changed: ${name}`);
  }
  assert.deepEqual(Object.keys(active.services).filter(name => !Object.hasOwn(baseline.services, name)), ['piston-interactive']);
  for (const [name, network] of Object.entries(baseline.networks)) {
    assert.deepEqual(active.networks[name], network, `existing network changed: ${name}`);
  }
  const service = active.services['piston-interactive'];
  assert.equal(service.image, image);
  assert.equal(service.runtime, 'io.containerd.kata.v2');
  assert.equal(service.pull_policy, 'never');
  assert.equal(service.read_only, true);
  assert.equal(Number(service.mem_limit), 2147483648);
  assert.equal(Number(service.cpus), 2);
  assert.equal(service.pids_limit, 128);
  assert.deepEqual(service.cap_drop, ['ALL']);
  assert.deepEqual([...service.cap_add].sort(), ['SYS_ADMIN', 'NET_ADMIN', 'SETUID', 'SETGID', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SYS_CHROOT', 'KILL'].sort());
  assert.deepEqual(service.security_opt, ['no-new-privileges:true', 'systempaths=unconfined']);
  for (const field of ['ports', 'volumes', 'secrets', 'devices']) assert.equal((service[field] ?? []).length, 0, field);
  assert.deepEqual(Object.keys(service.networks), ['piston-interactive']);
  assert.equal(active.networks['piston-interactive'].internal, true);
  assert.deepEqual(service.environment, {
    PISTON_LOG_LEVEL: 'ERROR', PISTON_DISABLE_NETWORKING: 'true', PISTON_RUN_TIMEOUT: '300000',
    PISTON_RUN_CPU_TIME: '3000', PISTON_COMPILE_TIMEOUT: '10000', PISTON_COMPILE_CPU_TIME: '10000',
    PISTON_RUN_MEMORY_LIMIT: '268435456', PISTON_COMPILE_MEMORY_LIMIT: '536870912',
    PISTON_MAX_CONCURRENT_JOBS: '2', PISTON_OUTPUT_MAX_SIZE: '65536', PISTON_MAX_PROCESS_COUNT: '32',
    PISTON_MAX_OPEN_FILES: '64', PISTON_MAX_FILE_SIZE: '16777216',
  });
});
