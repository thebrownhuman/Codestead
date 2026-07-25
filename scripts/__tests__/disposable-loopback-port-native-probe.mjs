import assert from "node:assert/strict";

const allocatorModuleUrl = new URL(
  "../lib/disposable-loopback-port.mjs",
  import.meta.url,
);
const allocatorModule = await import(allocatorModuleUrl.href);

assert.equal(typeof allocatorModule.allocateDisposableLoopbackPort, "function");

const assignedPorts = [5432, 54_321];
const events = [];
const deterministicPort = await allocatorModule.allocateDisposableLoopbackPort({
  openListener: async (input) => {
    const assignedPort = assignedPorts.shift();
    assert.notEqual(assignedPort, undefined);
    events.push(`open:${input.host}:${input.port}:${assignedPort}`);
    return {
      port: assignedPort,
      close: async () => {
        events.push(`close:${assignedPort}`);
      },
    };
  },
});

assert.equal(deterministicPort, 54_321);
assert.deepEqual(events, [
  "open:127.0.0.1:0:5432",
  "close:5432",
  "open:127.0.0.1:0:54321",
  "close:54321",
]);

const kernelAssignedPort =
  await allocatorModule.allocateDisposableLoopbackPort();
assert.equal(Number.isSafeInteger(kernelAssignedPort), true);
assert.equal(kernelAssignedPort > 0, true);
assert.equal(kernelAssignedPort <= 65_535, true);
assert.notEqual(kernelAssignedPort, 5432);

process.stdout.write(
  `${JSON.stringify({
    deterministicPort,
    events,
    kernelAssignedPort,
    modulePath: allocatorModuleUrl.pathname,
  })}\n`,
);
