import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { createConnection } from "node:net";

import {
  startProductionLoadTestControlUnixServer,
  type ProductionLoadTestControlAdapter,
} from "../../../scripts/lib/production-load-test-control-server";

const socketPath = "/run/learncoding/codestead-production-load-test-control.sock";
const request = Buffer.from(
  JSON.stringify({ version: 1, action: "host-telemetry", project: "learncoding" }) + "\n",
  "utf8",
);
const failure = JSON.stringify({ ok: false, result: null }) + "\n";
let adapterCalls = 0;
const adapter: ProductionLoadTestControlAdapter = {
  async handle() {
    adapterCalls += 1;
    return {
      hostCpuPercent: 1,
      availableMemoryBytes: 2,
      rootFreeFraction: 0.5,
      rootFreeBytes: 3,
      diskReadBytes: 4,
      diskWriteBytes: 5,
      temperatureCelsius: 40,
      oomKills: 0,
      thermalThrottleIncrements: 0,
    };
  },
};

// The proof container mounts a fresh root-owned /run tmpfs. Recreate the same
// systemd RuntimeDirectory contract used by the production unit before binding.
await mkdir("/run/learncoding", { mode: 0o750 });

function sendAsRoot(): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    socket.once("connect", () => socket.end(request));
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("error", reject);
  });
}

function sendAsNonRoot(): Promise<string> {
  const script = [
    'const { createConnection } = require("node:net");',
    `const socket = createConnection(${JSON.stringify(socketPath)});`,
    'const chunks = [];',
    'socket.once("connect", () => socket.end(' + JSON.stringify(request.toString("utf8")) + '));',
    'socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));',
    'socket.once("end", () => process.stdout.write(Buffer.concat(chunks)));',
    'socket.once("error", () => process.exit(71));',
  ].join("");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], {
      uid: 65_532,
      gid: 65_532,
      env: {
        LANG: "C",
        LC_ALL: "C",
        NODE_ENV: "test",
        PATH: "/usr/bin:/bin",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null) {
        reject(new Error("non_root_client_failed"));
        return;
      }
      resolve(Buffer.concat(output).toString("utf8"));
    });
  });
}

const server = await startProductionLoadTestControlUnixServer({
  socketPath,
  socketParentGid: 0,
  adapter,
  authority: {
    candidateRunIdentitySha256: "sha256:" + "a".repeat(64),
    project: "learncoding",
    runnerVmId: "57b9ab11-f3a4-4ea8-a58e-e73d951f9d11",
    runnerVmMac: "52:54:00:20:00:12",
  },
  maximumConcurrentRequests: 2,
  requestTimeoutMs: 2_000,
});

try {
  const rootResponse = JSON.parse((await sendAsRoot()).trim()) as { ok?: unknown };
  assert.equal(rootResponse.ok, true);
  assert.equal(adapterCalls, 1);

  // The production socket remains 0600. This proof temporarily opens only the
  // disposable container's runtime directory and socket so a real non-root
  // connect reaches SO_PEERCRED instead of being stopped by filesystem DAC.
  await chmod("/run/learncoding", 0o755);
  await chmod(socketPath, 0o666);
  assert.equal(await sendAsNonRoot(), failure);
  assert.equal(adapterCalls, 1);
  process.stdout.write(
    "linux SO_PEERCRED proof passed: root peer=accepted non-root peer=denied adapter_calls=1\n",
  );
} finally {
  await server.close();
}
