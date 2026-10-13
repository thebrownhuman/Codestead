import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interactiveBuildArgs, requireLocalDriver } from './build.mjs';

test('interactive parent resolves through the daemon-local image without network or pulls', () => {
  const reference = `codestead-piston@sha256:${'a'.repeat(64)}`;
  const options = { reference, base: 'codestead-piston:ci', builder: 'default',
    epoch: 1790812800, tag: 'codestead-piston-interactive:ci', archive: '/tmp/image.tar',
    metadataFile: '/tmp/metadata.json', context: '/interactive' };
  for (const noCache of [false, true]) {
    const args = interactiveBuildArgs({ ...options, noCache });
    const value = flag => args[args.indexOf(flag) + 1];
    assert.equal(value('--builder'), 'default');
    assert.equal(value('--build-context'), `${reference}=docker-image://codestead-piston:ci`);
    assert.ok(args.includes(`PISTON_BASE_IMAGE=${reference}`));
    assert.ok(args.includes('--network=none'));
    assert.ok(args.includes('--pull=false'));
    assert.ok(args.includes('--provenance=false'));
    assert.ok(value('--output').includes('rewrite-timestamp=true'));
    assert.equal(args.includes('--no-cache'), noCache);
    assert.equal(args.at(-1), options.context);
  }
});

test('separate or remote builders cannot bypass the shared local image store', () => {
  requireLocalDriver('Name: default\nDriver: docker\n');
  for (const driver of ['docker-container', 'remote', 'kubernetes']) {
    assert.throws(() => requireLocalDriver(`Name: default\nDriver: ${driver}\n`),
      /local Docker driver/);
  }
});
