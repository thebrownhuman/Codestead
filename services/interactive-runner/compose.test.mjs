import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync('compose.yaml', 'utf8');
const appImages = Object.fromEntries([...source.matchAll(/\$\{(APP_[A-Z_]*IMAGE):/g)]
  .map(([, name]) => [name, `ghcr.io/thebrownhuman/contract@sha256:${'a'.repeat(64)}`]));
function render(broker) {
  const result = spawnSync('docker', ['compose', '--env-file', 'infra/env/compose.env.example',
    '-f', 'compose.yaml', '-f', 'compose.piston-interactive.yaml',
    ...(broker ? ['-f', 'compose.interactive-runner.yaml'] : []),
    '--profile', 'piston', '--profile', 'piston-interactive', 'config', '--format', 'json'], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...appImages, COMPOSE_PROFILES: '', GITHUB_TOKEN: '',
      APP_NAME: 'Broker contract', APP_URL: 'https://contract.example', BOOTSTRAP_ADMIN_EMAIL: 'admin@contract.example',
      SENTRY_RELEASE: 'a'.repeat(40), PISTON_IMAGE: `codestead-piston@sha256:${'b'.repeat(64)}`,
      PISTON_INTERACTIVE_IMAGE: `codestead-piston-interactive@sha256:${'c'.repeat(64)}`,
      INTERACTIVE_RUNNER_IMAGE: `codestead-interactive-broker@sha256:${'d'.repeat(64)}`,
      INTERACTIVE_BROKER_SECRET_PATH: '/contract-only/not-a-real-secret', INTERACTIVE_RUNNER_ENABLED: 'false' },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
test('broker addon preserves every batch/homelab service and network, adding only app config and broker', () => {
  const old = render(false), next = render(true);
  for (const [name, service] of Object.entries(old.services)) {
    if (name !== 'app') assert.deepEqual(next.services[name], service, name);
  }
  for (const [name, network] of Object.entries(old.networks)) assert.deepEqual(next.networks[name], network, name);
  const app = structuredClone(next.services.app);
  for (const name of ['INTERACTIVE_RUNNER_ENABLED', 'INTERACTIVE_BROKER_URL', 'INTERACTIVE_BROKER_SECRET_FILE']) delete app.environment[name];
  app.secrets = app.secrets.filter(secret => secret.source !== 'interactive_broker_secret');
  assert.deepEqual(app, old.services.app);
  const broker = next.services['interactive-runner'];
  assert.deepEqual(Object.keys(broker.networks).sort(), ['frontend', 'piston-interactive']);
  assert.equal(broker.environment.INTERACTIVE_RUNNER_ENABLED, 'false');
  assert.equal(next.services.app.environment.INTERACTIVE_RUNNER_ENABLED, 'false');
  assert.equal(Number(broker.mem_limit), 268435456); assert.equal(Number(broker.cpus), 0.5); assert.equal(broker.pids_limit, 64);
  assert.equal(broker.read_only, true); assert.deepEqual(broker.cap_drop, ['ALL']);
  assert.deepEqual(broker.security_opt, ['no-new-privileges:true']);
  assert.equal(broker.pull_policy, 'never');
  assert.equal(broker.ports, undefined); assert.equal(broker.volumes, undefined);
  assert.equal(next.services.piston.environment.PISTON_MAX_CONCURRENT_JOBS, '2');
  assert.equal(next.services['piston-interactive'].environment.PISTON_MAX_CONCURRENT_JOBS, '2');
});
