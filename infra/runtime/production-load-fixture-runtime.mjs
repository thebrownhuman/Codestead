// scripts/start-production-load-fixture-runtime.ts
import { fileURLToPath } from "node:url";
import path4 from "node:path";

// scripts/lib/production-load-disposable-runtime.ts
import { createHash } from "node:crypto";
var learnerPattern = /^load-learner-(?:0[1-9]|10)$/;
function fail(code) {
  throw new Error(`Production load disposable runtime failed: ${code}`);
}
function abort(signal) {
  if (signal.aborted) fail("aborted");
}
function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function bindingDigest(binding) {
  return createHash("sha256").update(Buffer.from(`${JSON.stringify(binding)}
`, "utf8")).digest("hex");
}
function validateReadiness(evidence) {
  const learners = evidence.authenticatedLearnerIds;
  if (evidence.postgresRoundTrip !== true || evidence.providerStatuses.gmail !== 204 || evidence.providerStatuses.ai !== 204 || evidence.providerStatuses.drive !== 204 || !Array.isArray(learners) || learners.length !== 10 || new Set(learners).size !== 10 || learners.some((learner) => !learnerPattern.test(learner)) || evidence.runnerMaxConcurrentJobs !== 2 || !Number.isSafeInteger(evidence.runnerQueuedJobsObserved) || evidence.runnerQueuedJobsObserved < 1) {
    fail("fixture_not_ready");
  }
}
function validateProbe(value) {
  if (typeof value.componentHealthy !== "boolean" || typeof value.alertOrDeadLetterVisible !== "boolean") {
    fail("invalid_probe_evidence");
  }
}
function validateInvariants(value) {
  if (!safeInteger(value.acknowledgedMutationFailures) || value.runnerMaxConcurrentJobs !== 2 || !safeInteger(value.secretLeakFindings)) {
    fail("invalid_invariant_evidence");
  }
}
function createProductionLoadDisposableFixtureOperations(options) {
  const now = options.now ?? (() => /* @__PURE__ */ new Date());
  let boundDigest = null;
  let ready = false;
  let closed = false;
  let closePromise = null;
  const assertAvailable = (signal) => {
    abort(signal);
    if (closed) fail("closed");
  };
  const assertReady = (signal) => {
    assertAvailable(signal);
    if (!ready || boundDigest === null) fail("fixture_not_ready");
  };
  return {
    async assertReady(binding, signal) {
      assertAvailable(signal);
      const digest = bindingDigest(binding);
      if (boundDigest !== null && boundDigest !== digest) fail("binding_rejected");
      let evidence;
      try {
        evidence = await options.topology.readinessEvidence(signal);
      } catch {
        abort(signal);
        fail("fixture_not_ready");
      }
      abort(signal);
      validateReadiness(evidence);
      boundDigest = digest;
      ready = true;
    },
    async isolationStatus(signal) {
      assertReady(signal);
      return { maintenanceWindowApproved: true, freshRecoveryPoint: true };
    },
    async hostTelemetry(signal) {
      assertReady(signal);
      fail("external_host_telemetry_required");
    },
    async runnerVmTelemetry(_runnerVmId, _runnerVmMac, signal) {
      assertReady(signal);
      fail("external_runner_telemetry_required");
    },
    async reset(faultId, signal) {
      assertReady(signal);
      await options.topology.reset(faultId, signal);
      abort(signal);
    },
    async injectAndRelease(faultId, signal) {
      assertReady(signal);
      await options.topology.injectAndRelease(faultId, signal);
      abort(signal);
    },
    async probe(faultId, phase, signal) {
      assertReady(signal);
      const value = await options.topology.probe(faultId, phase, signal);
      abort(signal);
      validateProbe(value);
      return value;
    },
    async browserJourney(faultId, stage, signal) {
      assertReady(signal);
      await options.topology.browserJourney(faultId, stage, signal);
      abort(signal);
    },
    async invariantEvidence(faultId, signal) {
      assertReady(signal);
      const value = await options.topology.invariantEvidence(faultId, signal);
      abort(signal);
      validateInvariants(value);
      const observedAt = now();
      if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
        fail("invalid_clock");
      }
      return { observedAt: observedAt.toISOString(), ...value };
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        ready = false;
        await options.topology.close();
      })();
      return closePromise;
    }
  };
}

// scripts/lib/production-load-disposable-topology.ts
import { createHash as createHash2 } from "node:crypto";
import {
  mkdir,
  open,
  statfs,
  unlink,
  writeFile
} from "node:fs/promises";
import {
  createServer as createHttpServer2,
  request as httpRequest
} from "node:http";
import {
  createConnection as createConnection2,
  createServer as createTcpServer2
} from "node:net";
import path2 from "node:path";

// scripts/lib/production-load-disposable-fixtures.ts
import { createServer as createHttpServer } from "node:http";
import {
  createConnection,
  createServer as createTcpServer
} from "node:net";

// scripts/lib/production-load-disposable-sandbox.ts
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
var PRODUCTION_LOAD_DISPOSABLE_ATTESTATION_PATH = "/run/secrets/production_load_network_attestation";
var EXPECTED_ATTESTATION = [
  "schema=1",
  "profile=codestead-production-load-disposable-network-v1",
  "egress=default-deny",
  ""
].join("\n");
var FIXED_SANDBOX = Object.freeze({
  postgres: Object.freeze({
    listenHost: "0.0.0.0",
    listenPort: 15432,
    upstreamHost: "production-load-postgres",
    upstreamPort: 5432,
    maximumConnections: 16
  }),
  tunnel: Object.freeze({
    listenHost: "0.0.0.0",
    listenPort: 13e3,
    upstreamHost: "production-load-app",
    upstreamPort: 3e3,
    maximumConnections: 16
  }),
  provider: Object.freeze({
    listenHost: "0.0.0.0",
    listenPort: 18080
  })
});
function fail2() {
  throw new Error("Production load disposable sandbox failed: unattested_sandbox");
}
function validateProductionLoadDisposableSandboxEvidence(evidence) {
  if (evidence.platform !== "linux" || evidence.uid !== 65532 || evidence.gid !== 65532 || evidence.attestation !== EXPECTED_ATTESTATION || !evidence.attestationSafe || !evidence.dockerEnvironmentSafe || evidence.hasDefaultRoute || evidence.dangerousHostPathsPresent) {
    fail2();
  }
  return FIXED_SANDBOX;
}
async function safeRootOwnedFile(target, expectedMode) {
  try {
    const expectedParent = path.dirname(target);
    const parent = await realpath(expectedParent);
    if (parent !== expectedParent) return false;
    const metadata = await lstat(target);
    const mode = metadata.mode & 511;
    return metadata.isFile() && !metadata.isSymbolicLink() && metadata.uid === 0 && metadata.gid === 0 && metadata.nlink === 1 && (expectedMode === null ? (mode & 18) === 0 : mode === expectedMode);
  } catch {
    return false;
  }
}
async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}
function ipv4RouteTableHasDefaultRoute(routeTable) {
  const lines = routeTable.split("\n").slice(1);
  return lines.some((line) => {
    const fields = line.trim().split(/\s+/);
    return fields.length >= 4 && fields[1] === "00000000" && (Number.parseInt(fields[3] ?? "0", 16) & 1) === 1;
  });
}
function ipv6RouteTableHasDefaultRoute(routeTable) {
  return routeTable.split("\n").some((line) => {
    const fields = line.trim().split(/\s+/);
    return fields.length >= 10 && fields[0] === "0".repeat(32) && fields[1] === "00" && (Number.parseInt(fields[8] ?? "0", 16) & 1) === 1;
  });
}
async function assertProductionLoadDisposableNetworkSandbox() {
  let attestation = "";
  let ipv4RouteTable = "";
  let ipv6RouteTable = "";
  try {
    [attestation, ipv4RouteTable, ipv6RouteTable] = await Promise.all([
      readFile(PRODUCTION_LOAD_DISPOSABLE_ATTESTATION_PATH, "utf8"),
      readFile("/proc/net/route", "utf8"),
      readFile("/proc/net/ipv6_route", "utf8")
    ]);
  } catch {
    fail2();
  }
  const [attestationSafe, dockerEnvironmentSafe, ...dangerousPaths] = await Promise.all([
    safeRootOwnedFile(PRODUCTION_LOAD_DISPOSABLE_ATTESTATION_PATH, 292),
    safeRootOwnedFile("/.dockerenv", null),
    pathExists("/run/docker.sock"),
    pathExists("/run/libvirt"),
    pathExists("/dev/kvm")
  ]);
  return validateProductionLoadDisposableSandboxEvidence({
    platform: process.platform,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    attestation,
    attestationSafe,
    dockerEnvironmentSafe,
    hasDefaultRoute: ipv4RouteTableHasDefaultRoute(ipv4RouteTable) || ipv6RouteTableHasDefaultRoute(ipv6RouteTable),
    dangerousHostPathsPresent: dangerousPaths.some(Boolean)
  });
}

// scripts/lib/production-load-disposable-fixtures.ts
var MAXIMUM_PROVIDER_BODY_BYTES = 64 * 1024;
var PROVIDER_HEADERS_TIMEOUT_MS = 1e3;
var PROVIDER_REQUEST_TIMEOUT_MS = 2e3;
var PROVIDER_KEEP_ALIVE_TIMEOUT_MS = 500;
var PROVIDER_SOCKET_TIMEOUT_MS = 2500;
function fail3(code) {
  throw new Error(`Production load disposable fixture failed: ${code}`);
}
function validateDuration(durationMs) {
  if (!Number.isSafeInteger(durationMs) || durationMs < 100 || durationMs > 5e3) {
    fail3("invalid_duration");
  }
}
function delay(durationMs, signal) {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
function createFault(durationMs, callerSignal, release) {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  if (callerSignal.aborted) controller.abort();
  const promise = delay(durationMs, controller.signal).finally(() => {
    callerSignal.removeEventListener("abort", onCallerAbort);
    release();
  });
  return { controller, promise };
}
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("invalid_listener"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}
function proxyConfiguration(sandbox, kind) {
  return sandbox[kind];
}
async function startProductionLoadDisposableTcpProxy(options) {
  const sandbox = await assertProductionLoadDisposableNetworkSandbox();
  const configuration = proxyConfiguration(sandbox, options.kind);
  let interrupted = false;
  let closing = false;
  let activeFault = null;
  const pairs = /* @__PURE__ */ new Set();
  const destroyPair = (pair) => {
    pair.client.destroy();
    pair.upstream.destroy();
  };
  const server = createTcpServer({ allowHalfOpen: true }, (client) => {
    if (closing || interrupted || pairs.size >= configuration.maximumConnections) {
      client.destroy();
      return;
    }
    const upstream = createConnection({
      host: configuration.upstreamHost,
      port: configuration.upstreamPort,
      allowHalfOpen: true
    });
    let resolveClosed = () => void 0;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    const pair = {
      client,
      upstream,
      clientClosed: false,
      upstreamClosed: false,
      closed,
      resolveClosed
    };
    pairs.add(pair);
    const closeHalf = (half) => {
      if (half === "client") pair.clientClosed = true;
      else pair.upstreamClosed = true;
      destroyPair(pair);
      if (pair.clientClosed && pair.upstreamClosed && pairs.delete(pair)) pair.resolveClosed();
    };
    const failPair = () => destroyPair(pair);
    client.setTimeout(3e4, failPair);
    upstream.setTimeout(3e4, failPair);
    client.once("error", failPair);
    upstream.once("error", failPair);
    client.once("close", () => closeHalf("client"));
    upstream.once("close", () => closeHalf("upstream"));
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.maxConnections = configuration.maximumConnections;
  const port = await listen(server, configuration.listenHost, configuration.listenPort).catch(() => {
    fail3("listen_failed");
  });
  let closePromise = null;
  return {
    port,
    interruptAndRelease(durationMs, signal) {
      validateDuration(durationMs);
      if (closing) return Promise.reject(new Error("closed"));
      if (activeFault) return activeFault.promise;
      interrupted = true;
      for (const pair of pairs) destroyPair(pair);
      const fault2 = createFault(durationMs, signal, () => {
        interrupted = false;
        if (activeFault === fault2) activeFault = null;
      });
      activeFault = fault2;
      return fault2.promise;
    },
    reset() {
      activeFault?.controller.abort();
      interrupted = false;
      for (const pair of pairs) destroyPair(pair);
    },
    status: () => ({ interrupted, activeConnections: pairs.size }),
    close() {
      closePromise ??= (async () => {
        closing = true;
        interrupted = false;
        activeFault?.controller.abort();
        const closingPairs = [...pairs];
        for (const pair of closingPairs) destroyPair(pair);
        await activeFault?.promise.catch(() => void 0);
        await Promise.all(closingPairs.map((pair) => pair.closed));
        await closeServer(server);
      })();
      return closePromise;
    }
  };
}
var providerPaths = /* @__PURE__ */ new Map([
  ["/gmail", "gmail"],
  ["/ai", "ai"],
  ["/drive", "drive"]
]);
function canonicalContentLength(request) {
  const values = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "content-length") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  if (values.length === 0) return null;
  if (values.length !== 1 || !/^(?:0|[1-9][0-9]*)$/.test(values[0] ?? "")) {
    fail3("invalid_body_length");
  }
  const value = Number(values[0]);
  if (!Number.isSafeInteger(value)) fail3("invalid_body_length");
  return value;
}
async function consumeBoundedBody(request) {
  const contentLength = canonicalContentLength(request);
  if (contentLength !== null && contentLength > MAXIMUM_PROVIDER_BODY_BYTES) {
    request.socket.destroy();
    fail3("body_too_large");
  }
  let bytes = 0;
  for await (const raw of request) {
    bytes += Buffer.isBuffer(raw) ? raw.byteLength : Buffer.byteLength(raw);
    if (bytes > MAXIMUM_PROVIDER_BODY_BYTES) {
      request.socket.destroy();
      fail3("body_too_large");
    }
  }
}
async function startProductionLoadDisposableProviderServer() {
  const sandbox = await assertProductionLoadDisposableNetworkSandbox();
  const configuration = sandbox.provider;
  const state = { gmail: false, ai: false, drive: false };
  const active = /* @__PURE__ */ new Map();
  const sockets = /* @__PURE__ */ new Set();
  let closing = false;
  const server = createHttpServer((request, response) => {
    const requestSocket = request.socket;
    void (async () => {
      try {
        await consumeBoundedBody(request);
        if (closing || response.destroyed) return;
        response.setHeader("cache-control", "no-store");
        response.setHeader("x-content-type-options", "nosniff");
        const method = request.method ?? "";
        if (method !== "GET" && method !== "POST") {
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
          return;
        }
        let pathName = "";
        try {
          pathName = new URL(request.url ?? "", "http://fixture.invalid").pathname;
        } catch {
          response.writeHead(400);
          response.end();
          return;
        }
        const provider = providerPaths.get(pathName);
        if (!provider) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(state[provider] ? 503 : 204);
        response.end();
      } catch {
        requestSocket.destroy();
      }
    })();
  });
  server.headersTimeout = PROVIDER_HEADERS_TIMEOUT_MS;
  server.requestTimeout = PROVIDER_REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = PROVIDER_KEEP_ALIVE_TIMEOUT_MS;
  server.maxRequestsPerSocket = 10;
  server.maxConnections = 32;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.setTimeout(PROVIDER_SOCKET_TIMEOUT_MS, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });
  const port = await listen(server, configuration.listenHost, configuration.listenPort).catch(() => {
    fail3("listen_failed");
  });
  let closePromise = null;
  return {
    port,
    interruptAndRelease(provider, durationMs, signal) {
      validateDuration(durationMs);
      if (closing) return Promise.reject(new Error("closed"));
      const current = active.get(provider);
      if (current) return current.promise;
      state[provider] = true;
      const fault2 = createFault(durationMs, signal, () => {
        state[provider] = false;
        if (active.get(provider) === fault2) active.delete(provider);
      });
      active.set(provider, fault2);
      return fault2.promise;
    },
    reset(provider) {
      if (provider) {
        active.get(provider)?.controller.abort();
        state[provider] = false;
      } else {
        for (const fault2 of active.values()) fault2.controller.abort();
        state.gmail = false;
        state.ai = false;
        state.drive = false;
      }
    },
    status: () => ({ ...state }),
    close() {
      closePromise ??= (async () => {
        closing = true;
        state.gmail = false;
        state.ai = false;
        state.drive = false;
        for (const fault2 of active.values()) fault2.controller.abort();
        for (const socket of sockets) socket.destroy();
        await Promise.allSettled([...active.values()].map((fault2) => fault2.promise));
        await closeServer(server);
      })();
      return closePromise;
    }
  };
}

// scripts/lib/production-load-disposable-topology.ts
var FIXTURE_ROOT = "/var/lib/learncoding-production-load-fixtures";
var POSTGRES_UPSTREAM_PORT = 5432;
var APPLICATION_UPSTREAM_PORT = 3e3;
var MAXIMUM_HTTP_BODY_BYTES = 8 * 1024;
var MAXIMUM_QUOTA_VOLUME_BYTES = 32 * 1024 * 1024;
var FAULT_DURATION_MS = 100;
var fixtureFaults = /* @__PURE__ */ new Set([
  "postgres_proxy_interruption",
  "tunnel_proxy_interruption",
  "fake_gmail_failure",
  "fake_ai_provider_failure",
  "fake_offsite_drive_failure",
  "quota_volume_near_full",
  "synthetic_stale_backup_alert"
]);
var providerByFault = {
  fake_gmail_failure: "gmail",
  fake_ai_provider_failure: "ai",
  fake_offsite_drive_failure: "drive"
};
function fail4(code) {
  throw new Error(`Production load disposable topology failed: ${code}`);
}
function abort2(signal) {
  if (signal.aborted) fail4("aborted");
}
function delay2(durationMs, signal) {
  abort2(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
function listen2(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("invalid_listener"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}
function closeServer2(server, sockets) {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
async function startEchoUpstream(port) {
  const sockets = /* @__PURE__ */ new Set();
  const server = createTcpServer2({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.setTimeout(2e3, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    socket.pipe(socket);
  });
  const actualPort = await listen2(server, "127.0.0.1", port);
  return { port: actualPort, close: () => closeServer2(server, sockets) };
}
async function consumeBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > MAXIMUM_HTTP_BODY_BYTES) fail4("body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}
function learnerId(index) {
  return `load-learner-${String(index + 1).padStart(2, "0")}`;
}
function sessionToken(learner) {
  return createHash2("sha256").update(`codestead-production-load-session-v1:${learner}`, "utf8").digest("hex");
}
async function startAuthenticatedApplication(port) {
  const sockets = /* @__PURE__ */ new Set();
  const sessions = /* @__PURE__ */ new Map();
  const server = createHttpServer2((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "", "http://fixture.invalid");
        if (request.method === "POST" && url.pathname === "/fixture/session") {
          const body = await consumeBody(request);
          const value = JSON.parse(body.toString("utf8"));
          const learner = value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).join(",") === "learnerId" ? value.learnerId : null;
          if (typeof learner !== "string" || !/^load-learner-(?:0[1-9]|10)$/.test(learner)) {
            response.writeHead(400).end();
            return;
          }
          const token = sessionToken(learner);
          sessions.set(token, learner);
          response.writeHead(201, {
            "cache-control": "no-store",
            "content-type": "application/json",
            "x-content-type-options": "nosniff"
          });
          response.end(JSON.stringify({ token }));
          return;
        }
        if (request.method === "GET" && url.pathname === "/fixture/lesson") {
          const authorization = request.headers.authorization ?? "";
          const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
          const learner = sessions.get(token);
          if (!learner) {
            response.writeHead(401, { "cache-control": "no-store" }).end();
            return;
          }
          response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "application/json",
            "x-content-type-options": "nosniff"
          });
          response.end(JSON.stringify({ learnerId: learner, lesson: "fixture-readiness" }));
          return;
        }
        response.writeHead(404, { "cache-control": "no-store" }).end();
      } catch {
        request.socket.destroy();
      }
    })();
  });
  server.headersTimeout = 1e3;
  server.requestTimeout = 2e3;
  server.keepAliveTimeout = 500;
  server.maxConnections = 32;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.setTimeout(2500, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });
  const actualPort = await listen2(server, "127.0.0.1", port);
  return { port: actualPort, close: () => closeServer2(server, sockets) };
}
function tcpRoundTrip(port, input, signal) {
  abort2(signal);
  return new Promise((resolve, reject) => {
    const socket = createConnection2({ host: "127.0.0.1", port });
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, bytes));
    };
    const onAbort = () => finish(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    socket.setTimeout(2e3, () => finish(new Error("timeout")));
    socket.once("connect", () => socket.end(input));
    socket.on("data", (raw) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      bytes += chunk.byteLength;
      if (bytes > MAXIMUM_HTTP_BODY_BYTES) finish(new Error("response_too_large"));
      else chunks.push(chunk);
    });
    socket.once("end", () => finish());
    socket.once("error", (error) => finish(error));
    if (signal.aborted) onAbort();
  });
}
function fixtureHttp(options) {
  abort2(options.signal);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: options.port,
      method: options.method,
      path: options.pathname,
      signal: options.signal,
      headers: {
        host: "production-load-app",
        connection: "close",
        ...options.body ? {
          "content-length": String(options.body.byteLength),
          "content-type": "application/json"
        } : {},
        ...options.token ? { authorization: `Bearer ${options.token}` } : {}
      }
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.byteLength;
        if (bytes > MAXIMUM_HTTP_BODY_BYTES) request.destroy(new Error("response_too_large"));
        else chunks.push(Buffer.from(chunk));
      });
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks, bytes)
      }));
    });
    request.setTimeout(2e3, () => request.destroy(new Error("timeout")));
    request.once("error", reject);
    request.end(options.body);
  });
}
function validateAuthenticatedLesson(response, learner) {
  let value;
  try {
    value = JSON.parse(response.body.toString("utf8"));
  } catch {
    fail4("authenticated_journey_failed");
  }
  if (response.status !== 200 || value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join(",") !== "learnerId,lesson" || value.learnerId !== learner || value.lesson !== "fixture-readiness") {
    fail4("authenticated_journey_failed");
  }
}
async function authenticateLearners(tunnelPort, signal) {
  const sessions = /* @__PURE__ */ new Map();
  for (let index = 0; index < 10; index += 1) {
    abort2(signal);
    const learner = learnerId(index);
    const response = await fixtureHttp({
      port: tunnelPort,
      method: "POST",
      pathname: "/fixture/session",
      body: Buffer.from(JSON.stringify({ learnerId: learner }), "utf8"),
      signal
    });
    let value;
    try {
      value = JSON.parse(response.body.toString("utf8"));
    } catch {
      fail4("authentication_failed");
    }
    const token = value !== null && typeof value === "object" && !Array.isArray(value) ? value.token : null;
    if (response.status !== 201 || typeof token !== "string" || token !== sessionToken(learner) || sessions.has(learner)) {
      fail4("authentication_failed");
    }
    const lesson = await fixtureHttp({
      port: tunnelPort,
      method: "GET",
      pathname: "/fixture/lesson",
      token,
      signal
    });
    validateAuthenticatedLesson(lesson, learner);
    sessions.set(learner, token);
  }
  return sessions;
}
async function runnerBackpressureProof(signal) {
  let running = 0;
  let maximum = 0;
  let maximumQueued = 0;
  const queue = [];
  const pump = () => {
    while (running < 2 && queue.length > 0) {
      const start = queue.shift();
      running += 1;
      maximum = Math.max(maximum, running);
      start?.();
    }
  };
  const submit = () => new Promise((resolve, reject) => {
    queue.push(() => {
      void delay2(10, signal).then(resolve, reject).finally(() => {
        running -= 1;
        pump();
      });
    });
    maximumQueued = Math.max(maximumQueued, Math.max(0, queue.length - (2 - running)));
    pump();
  });
  await Promise.all([submit(), submit(), submit(), submit()]);
  return { maximum, queued: maximumQueued };
}
function providerStatus(server, provider, signal) {
  return fetch(`http://127.0.0.1:${server.port}/${provider}`, {
    redirect: "manual",
    signal
  }).then((response) => response.status);
}
async function exists(target) {
  try {
    const handle = await open(target, "r");
    await handle.close();
    return true;
  } catch {
    return false;
  }
}
async function fillQuotaVolume(root, signal) {
  abort2(signal);
  const before = await statfs(root);
  const capacity = before.blocks * before.bsize;
  const free = before.bavail * before.bsize;
  if (!Number.isSafeInteger(capacity) || capacity < 4 * 1024 * 1024 || capacity > MAXIMUM_QUOTA_VOLUME_BYTES || !Number.isSafeInteger(free)) {
    fail4("unbounded_quota_volume");
  }
  const target = path2.join(root, "quota-near-full.bin");
  const bytes = Math.max(1, Math.floor(free - capacity * 0.08));
  const handle = await open(target, "wx", 384);
  const chunk = Buffer.alloc(Math.min(1024 * 1024, bytes), 81);
  try {
    let written = 0;
    while (written < bytes) {
      abort2(signal);
      const size = Math.min(chunk.byteLength, bytes - written);
      await handle.write(chunk, 0, size);
      written += size;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  const after = await statfs(root);
  if (after.bavail / after.blocks > 0.1) fail4("quota_fault_not_reached");
}
function providerForFault(faultId) {
  return Object.prototype.hasOwnProperty.call(providerByFault, faultId) ? providerByFault[faultId] : null;
}
async function startProductionLoadDisposableFixtureTopology(options = {}) {
  const test = options.testConfiguration;
  if (test && process.env.NODE_ENV !== "test") fail4("test_configuration_forbidden");
  const fixtureRoot = test?.fixtureRoot ?? FIXTURE_ROOT;
  const postgresPort = test?.postgresPort ?? POSTGRES_UPSTREAM_PORT;
  const applicationPort = test?.applicationPort ?? APPLICATION_UPSTREAM_PORT;
  if (!path2.isAbsolute(fixtureRoot) || !Number.isSafeInteger(postgresPort) || postgresPort < 1 || postgresPort > 65535 || !Number.isSafeInteger(applicationPort) || applicationPort < 1 || applicationPort > 65535 || applicationPort === postgresPort) {
    fail4("invalid_configuration");
  }
  await mkdir(fixtureRoot, { recursive: true, mode: 448 });
  const closeables = [];
  let postgres;
  let application;
  let postgresProxy;
  let tunnelProxy;
  let provider;
  try {
    postgres = await startEchoUpstream(postgresPort);
    closeables.push(postgres);
    application = await startAuthenticatedApplication(applicationPort);
    closeables.push(application);
    postgresProxy = await startProductionLoadDisposableTcpProxy({ kind: "postgres" });
    closeables.push(postgresProxy);
    tunnelProxy = await startProductionLoadDisposableTcpProxy({ kind: "tunnel" });
    closeables.push(tunnelProxy);
    provider = await startProductionLoadDisposableProviderServer();
    closeables.push(provider);
  } catch (error) {
    await Promise.allSettled(closeables.reverse().map((item) => item.close()));
    throw error;
  }
  const quotaPath = path2.join(fixtureRoot, "quota-near-full.bin");
  const stalePath = path2.join(fixtureRoot, "synthetic-stale-backup.json");
  const alertedFaults = /* @__PURE__ */ new Set();
  let sessions = /* @__PURE__ */ new Map();
  let runnerMaximum = 0;
  let runnerQueued = 0;
  let closed = false;
  let closePromise = null;
  const ensureFixtureFault = (faultId) => {
    if (!fixtureFaults.has(faultId)) fail4("external_fault_required");
  };
  const postgresHealthy = async (signal) => {
    const marker = Buffer.from("codestead-postgres-fixture-v1\n", "ascii");
    const output = await tcpRoundTrip(postgresProxy.port, marker, signal);
    return output.equals(marker);
  };
  const journey = async (signal) => {
    if (sessions.size !== 10) fail4("authenticated_journey_failed");
    for (const [learner, token] of sessions) {
      abort2(signal);
      const response = await fixtureHttp({
        port: tunnelProxy.port,
        method: "GET",
        pathname: "/fixture/lesson",
        token,
        signal
      });
      validateAuthenticatedLesson(response, learner);
    }
  };
  const resetFixture = async (faultId) => {
    if (faultId === "postgres_proxy_interruption") postgresProxy.reset();
    else if (faultId === "tunnel_proxy_interruption") tunnelProxy.reset();
    else {
      const mapped = providerForFault(faultId);
      if (mapped) provider.reset(mapped);
      else if (faultId === "quota_volume_near_full") {
        await unlink(quotaPath).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      } else if (faultId === "synthetic_stale_backup_alert") {
        await unlink(stalePath).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    }
  };
  return {
    async readinessEvidence(signal) {
      abort2(signal);
      if (closed) fail4("closed");
      await resetFixture("postgres_proxy_interruption");
      await resetFixture("tunnel_proxy_interruption");
      provider.reset();
      const postgresRoundTrip = await postgresHealthy(signal);
      const providerStatuses = {
        gmail: await providerStatus(provider, "gmail", signal),
        ai: await providerStatus(provider, "ai", signal),
        drive: await providerStatus(provider, "drive", signal)
      };
      sessions = await authenticateLearners(tunnelProxy.port, signal);
      const runner = await runnerBackpressureProof(signal);
      runnerMaximum = Math.max(runnerMaximum, runner.maximum);
      runnerQueued = Math.max(runnerQueued, runner.queued);
      return {
        postgresRoundTrip,
        providerStatuses,
        authenticatedLearnerIds: [...sessions.keys()],
        runnerMaxConcurrentJobs: runner.maximum,
        runnerQueuedJobsObserved: runner.queued
      };
    },
    async reset(faultId, signal) {
      abort2(signal);
      ensureFixtureFault(faultId);
      await resetFixture(faultId);
      alertedFaults.delete(faultId);
      abort2(signal);
    },
    async injectAndRelease(faultId, signal) {
      abort2(signal);
      ensureFixtureFault(faultId);
      if (faultId === "postgres_proxy_interruption") {
        await postgresProxy.interruptAndRelease(FAULT_DURATION_MS, signal);
      } else if (faultId === "tunnel_proxy_interruption") {
        await tunnelProxy.interruptAndRelease(FAULT_DURATION_MS, signal);
      } else {
        const mapped = providerForFault(faultId);
        if (mapped) {
          await provider.interruptAndRelease(mapped, FAULT_DURATION_MS, signal);
        } else if (faultId === "quota_volume_near_full") {
          try {
            await fillQuotaVolume(fixtureRoot, signal);
            await delay2(FAULT_DURATION_MS, signal);
          } finally {
            await resetFixture(faultId);
          }
        } else {
          try {
            await writeFile(stalePath, '{"schemaVersion":1,"stale":true}\n', {
              encoding: "utf8",
              flag: "wx",
              mode: 384
            });
            await delay2(FAULT_DURATION_MS, signal);
          } finally {
            await resetFixture(faultId);
          }
        }
      }
      alertedFaults.add(faultId);
      abort2(signal);
    },
    async probe(faultId, phase, signal) {
      abort2(signal);
      ensureFixtureFault(faultId);
      let componentHealthy = false;
      if (faultId === "postgres_proxy_interruption") {
        componentHealthy = await postgresHealthy(signal);
      } else if (faultId === "tunnel_proxy_interruption") {
        try {
          await journey(signal);
          componentHealthy = true;
        } catch {
          componentHealthy = false;
        }
      } else {
        const mapped = providerForFault(faultId);
        if (mapped) componentHealthy = await providerStatus(provider, mapped, signal) === 204;
        else if (faultId === "quota_volume_near_full") componentHealthy = !await exists(quotaPath);
        else componentHealthy = !await exists(stalePath);
      }
      return {
        componentHealthy,
        alertOrDeadLetterVisible: phase === "recovery" && alertedFaults.has(faultId)
      };
    },
    async browserJourney(faultId, _stage, signal) {
      abort2(signal);
      if (!fixtureFaults.has(faultId)) fail4("external_fault_required");
      await journey(signal);
      abort2(signal);
    },
    async invariantEvidence(faultId, signal) {
      abort2(signal);
      ensureFixtureFault(faultId);
      if (runnerMaximum !== 2 || runnerQueued < 1) fail4("runner_proof_unavailable");
      return {
        acknowledgedMutationFailures: 0,
        runnerMaxConcurrentJobs: runnerMaximum,
        secretLeakFindings: 0
      };
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        await Promise.allSettled([
          resetFixture("quota_volume_near_full"),
          resetFixture("synthetic_stale_backup_alert")
        ]);
        const results = await Promise.allSettled(
          closeables.reverse().map((item) => item.close())
        );
        if (results.some((result) => result.status === "rejected")) fail4("close_failed");
      })();
      return closePromise;
    }
  };
}

// scripts/lib/production-load-fixture-server.ts
import { createHash as createHash3 } from "node:crypto";
import { chmod, lstat as lstat2, unlink as unlink2 } from "node:fs/promises";
import { createConnection as createConnection3, createServer } from "node:net";
import path3 from "node:path";
var MAXIMUM_MESSAGE_BYTES = 64 * 1024;
var hashPattern = /^[0-9a-f]{64}$/;
var vmIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var vmMacPattern = /^52:54:00:20:00:12$/;
var timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
var faultIds = /* @__PURE__ */ new Set([
  "runner_service_restart",
  "app_container_restart",
  "email_worker_restart",
  "assessment_regrade_worker_restart",
  "project_review_correction_worker_restart",
  "exam_finalization_worker_restart",
  "practice_recovery_worker_restart",
  "rewards_worker_restart",
  "postgres_proxy_interruption",
  "tunnel_proxy_interruption",
  "fake_gmail_failure",
  "fake_ai_provider_failure",
  "fake_offsite_drive_failure",
  "quota_volume_near_full",
  "synthetic_stale_backup_alert"
]);
function fail5() {
  throw new Error("fixture_request_failed");
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function exactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}
function canonical(value) {
  const output = Buffer.from(`${JSON.stringify(value)}
`, "utf8");
  if (output.byteLength < 1 || output.byteLength > MAXIMUM_MESSAGE_BYTES) fail5();
  return output;
}
function stableFailure() {
  return canonical({ ok: false, result: null });
}
function parseCanonical(body) {
  if (!Buffer.isBuffer(body) || body.byteLength < 2 || body.byteLength > MAXIMUM_MESSAGE_BYTES) fail5();
  let value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    if (text.includes("\0") || text.includes("\r") || !text.endsWith("\n")) fail5();
    value = JSON.parse(text);
  } catch {
    fail5();
  }
  const item = record(value);
  if (!item || !body.equals(canonical(item))) fail5();
  return item;
}
function fault(value) {
  if (typeof value !== "string" || !faultIds.has(value)) fail5();
  return value;
}
function finite(value, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) fail5();
  return value;
}
function integer(value) {
  const parsed = finite(value, 0, Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(parsed)) fail5();
  return parsed;
}
function validateResult(action, raw) {
  const item = record(raw);
  if (action === "runtime-health") {
    if (!item || !exactKeys(item, ["ready"]) || item.ready !== true) fail5();
    return { ready: true };
  }
  if (action === "assert-ready") {
    if (!item || !exactKeys(item, ["bindingSha256", "ready"]) || typeof item.bindingSha256 !== "string" || !hashPattern.test(item.bindingSha256) || item.ready !== true) fail5();
    return { bindingSha256: item.bindingSha256, ready: true };
  }
  if (action === "reset" || action === "inject-and-release" || action === "browser-journey") {
    if (raw !== null) fail5();
    return null;
  }
  if (action === "isolation-status") {
    if (!item || !exactKeys(item, ["maintenanceWindowApproved", "freshRecoveryPoint"]) || typeof item.maintenanceWindowApproved !== "boolean" || typeof item.freshRecoveryPoint !== "boolean") fail5();
    return {
      maintenanceWindowApproved: item.maintenanceWindowApproved,
      freshRecoveryPoint: item.freshRecoveryPoint
    };
  }
  if (action === "host-telemetry") {
    const keys = [
      "hostCpuPercent",
      "availableMemoryBytes",
      "rootFreeFraction",
      "rootFreeBytes",
      "diskReadBytes",
      "diskWriteBytes",
      "temperatureCelsius",
      "oomKills",
      "thermalThrottleIncrements"
    ];
    if (!item || !exactKeys(item, keys)) fail5();
    return {
      hostCpuPercent: finite(item.hostCpuPercent, 0, 100),
      availableMemoryBytes: integer(item.availableMemoryBytes),
      rootFreeFraction: finite(item.rootFreeFraction, 0, 1),
      rootFreeBytes: integer(item.rootFreeBytes),
      diskReadBytes: integer(item.diskReadBytes),
      diskWriteBytes: integer(item.diskWriteBytes),
      temperatureCelsius: finite(item.temperatureCelsius, -100, 250),
      oomKills: integer(item.oomKills),
      thermalThrottleIncrements: integer(item.thermalThrottleIncrements)
    };
  }
  if (action === "runner-vm-telemetry") {
    if (!item || !exactKeys(item, ["runnerVmCpuPercent", "runnerVmAvailableMemoryBytes"])) {
      fail5();
    }
    return {
      runnerVmCpuPercent: finite(item.runnerVmCpuPercent, 0, 100),
      runnerVmAvailableMemoryBytes: integer(item.runnerVmAvailableMemoryBytes)
    };
  }
  if (action === "probe") {
    if (!item || !exactKeys(item, ["componentHealthy", "alertOrDeadLetterVisible"]) || typeof item.componentHealthy !== "boolean" || typeof item.alertOrDeadLetterVisible !== "boolean") fail5();
    return {
      componentHealthy: item.componentHealthy,
      alertOrDeadLetterVisible: item.alertOrDeadLetterVisible
    };
  }
  if (action === "invariant-evidence") {
    if (!item || !exactKeys(item, [
      "observedAt",
      "acknowledgedMutationFailures",
      "runnerMaxConcurrentJobs",
      "secretLeakFindings"
    ]) || typeof item.observedAt !== "string" || !timestampPattern.test(item.observedAt) || new Date(item.observedAt).toISOString() !== item.observedAt) fail5();
    return {
      observedAt: item.observedAt,
      acknowledgedMutationFailures: integer(item.acknowledgedMutationFailures),
      runnerMaxConcurrentJobs: integer(item.runnerMaxConcurrentJobs),
      secretLeakFindings: integer(item.secretLeakFindings)
    };
  }
  fail5();
}
function bindingDigest2(value) {
  const item = record(value);
  if (!item || !exactKeys(item, [
    "profile",
    "project",
    "fixtureRoot",
    "runtimeSocket",
    "candidate",
    "candidateRunIdentitySha256",
    "decisionSha256",
    "expectedUnrelatedInventorySha256"
  ])) fail5();
  const bytes = canonical(item);
  return {
    binding: item,
    digest: createHash3("sha256").update(bytes).digest("hex")
  };
}
function createProductionLoadFixtureRuntimeDispatcher(options) {
  if (options.maximumConcurrentRequests !== 2 || !Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1 || options.requestTimeoutMs > 125e3) fail5();
  let active = 0;
  let closed = false;
  let bindingSha256 = null;
  let bindingInFlight = false;
  const controllers = /* @__PURE__ */ new Set();
  const invoke = async (request, signal) => {
    if (request.version !== 1 || typeof request.action !== "string") fail5();
    const action = request.action;
    if (action === "runtime-health") {
      if (!exactKeys(request, ["version", "action"])) fail5();
      return { ready: true };
    }
    if (action === "assert-ready") {
      if (!exactKeys(request, ["version", "action", "binding"]) || bindingInFlight) fail5();
      const resolved = bindingDigest2(request.binding);
      if (bindingSha256 !== null && bindingSha256 !== resolved.digest) fail5();
      bindingInFlight = true;
      try {
        await options.operations.assertReady(resolved.binding, signal);
        bindingSha256 = resolved.digest;
        return { bindingSha256: resolved.digest, ready: true };
      } finally {
        bindingInFlight = false;
      }
    }
    if (bindingSha256 === null || typeof request.bindingSha256 !== "string" || request.bindingSha256 !== bindingSha256) fail5();
    if (action === "isolation-status") {
      if (!exactKeys(request, ["version", "action", "bindingSha256"])) fail5();
      return options.operations.isolationStatus(signal);
    }
    if (action === "host-telemetry") {
      if (!exactKeys(request, ["version", "action", "bindingSha256"])) fail5();
      return options.operations.hostTelemetry(signal);
    }
    if (action === "runner-vm-telemetry") {
      if (!exactKeys(request, [
        "version",
        "action",
        "bindingSha256",
        "runnerVmId",
        "runnerVmMac"
      ]) || typeof request.runnerVmId !== "string" || !vmIdPattern.test(request.runnerVmId) || typeof request.runnerVmMac !== "string" || !vmMacPattern.test(request.runnerVmMac)) {
        fail5();
      }
      return options.operations.runnerVmTelemetry(
        request.runnerVmId,
        request.runnerVmMac,
        signal
      );
    }
    if (action === "reset" || action === "inject-and-release") {
      if (!exactKeys(request, [
        "version",
        "action",
        "bindingSha256",
        "faultId"
      ])) fail5();
      const faultId = fault(request.faultId);
      if (action === "reset") {
        await options.operations.reset(faultId, signal);
      } else {
        await options.operations.injectAndRelease(faultId, signal);
      }
      return null;
    }
    if (action === "probe") {
      if (!exactKeys(request, [
        "version",
        "action",
        "bindingSha256",
        "faultId",
        "phase"
      ]) || request.phase !== "baseline" && request.phase !== "recovery") fail5();
      return options.operations.probe(fault(request.faultId), request.phase, signal);
    }
    if (action === "browser-journey") {
      if (!exactKeys(request, [
        "version",
        "action",
        "bindingSha256",
        "faultId",
        "stage"
      ]) || request.stage !== "steady" && request.stage !== "recovered") fail5();
      await options.operations.browserJourney(fault(request.faultId), request.stage, signal);
      return null;
    }
    if (action === "invariant-evidence") {
      if (!exactKeys(request, [
        "version",
        "action",
        "bindingSha256",
        "faultId"
      ])) fail5();
      return options.operations.invariantEvidence(fault(request.faultId), signal);
    }
    fail5();
  };
  return {
    async dispatch(body, callerSignal) {
      if (closed || active >= options.maximumConcurrentRequests) return stableFailure();
      active += 1;
      const controller = new AbortController();
      controllers.add(controller);
      const relay = () => controller.abort();
      callerSignal?.addEventListener("abort", relay, { once: true });
      if (callerSignal?.aborted) relay();
      const timer = setTimeout(relay, options.requestTimeoutMs);
      timer.unref();
      let operationSettled = false;
      const releaseSlot = () => {
        if (operationSettled) return;
        operationSettled = true;
        controllers.delete(controller);
        active -= 1;
      };
      const operation = (async () => {
        try {
          if (controller.signal.aborted) fail5();
          const request = parseCanonical(body);
          const result = await invoke(request, controller.signal);
          if (controller.signal.aborted) fail5();
          return canonical({ ok: true, result: validateResult(request.action, result) });
        } catch {
          return stableFailure();
        }
      })().finally(releaseSlot);
      let removeAbortListener = () => void 0;
      const aborted = new Promise((resolve) => {
        const onAbort = () => resolve(stableFailure());
        removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([operation, aborted]);
      } finally {
        clearTimeout(timer);
        removeAbortListener();
        callerSignal?.removeEventListener("abort", relay);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const controller of controllers) controller.abort();
      await options.operations.close();
    }
  };
}
var PRODUCTION_LOAD_FIXTURE_RUNTIME_INTERNAL_SOCKET = "/run/learncoding-production-load-fixtures/runtime.sock";
var FIXTURE_RUNTIME_UID = 65532;
var FIXTURE_RUNTIME_GID = 65532;
function unixFail(code) {
  throw new Error(`Production load fixture Unix server failed: ${code}`);
}
function validateProductionLoadFixtureRuntimeSocketParent(value) {
  if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== FIXTURE_RUNTIME_UID || value.gid !== FIXTURE_RUNTIME_GID || value.nlink < 1 || (value.mode & 511) !== 448) {
    unixFail("unsafe_runtime_socket_parent");
  }
}
function validateProductionLoadFixtureRuntimeSocket(value) {
  if (!value.isSocket() || value.isSymbolicLink() || value.uid !== FIXTURE_RUNTIME_UID || value.gid !== FIXTURE_RUNTIME_GID || value.nlink !== 1 || (value.mode & 511) !== 384 || !Number.isSafeInteger(value.dev) || value.dev < 0 || !Number.isSafeInteger(value.ino) || value.ino <= 0) {
    unixFail("unsafe_runtime_socket");
  }
}
function listen3(server, socketPath) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}
function closeServer3(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
function socketIsActive(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = createConnection3(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
}
async function prepareFixtureRuntimeSocket(socketPath, inspect) {
  if (socketPath !== PRODUCTION_LOAD_FIXTURE_RUNTIME_INTERNAL_SOCKET || path3.posix.normalize(socketPath) !== socketPath) {
    unixFail("invalid_runtime_socket_path");
  }
  let parent;
  try {
    parent = await inspect(path3.posix.dirname(socketPath));
  } catch {
    unixFail("unsafe_runtime_socket_parent");
  }
  validateProductionLoadFixtureRuntimeSocketParent(parent);
  let existing;
  try {
    existing = await inspect(socketPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    unixFail("unsafe_runtime_socket");
  }
  validateProductionLoadFixtureRuntimeSocket(existing);
  if (await socketIsActive(socketPath).catch(() => unixFail("unsafe_runtime_socket"))) {
    unixFail("runtime_socket_in_use");
  }
  await unlink2(socketPath).catch(() => unixFail("unsafe_runtime_socket"));
}
async function startProductionLoadFixtureRuntimeUnixServer(options) {
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? process.getuid?.() ?? -1;
  const gid = options.gid ?? process.getgid?.() ?? -1;
  const socketPath = options.socketPath ?? PRODUCTION_LOAD_FIXTURE_RUNTIME_INTERNAL_SOCKET;
  const requestTimeoutMs = options.requestTimeoutMs ?? 125e3;
  const inspect = options.inspect ?? lstat2;
  if (platform !== "linux" || uid !== FIXTURE_RUNTIME_UID || gid !== FIXTURE_RUNTIME_GID) {
    unixFail("dedicated_identity_required");
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 125e3) unixFail("invalid_timeout");
  await prepareFixtureRuntimeSocket(socketPath, inspect);
  let closing = false;
  const sockets = /* @__PURE__ */ new Set();
  const controllers = /* @__PURE__ */ new Set();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const controller = new AbortController();
    controllers.add(controller);
    const chunks = [];
    let bytes = 0;
    let requestEnded = false;
    const abort3 = () => controller.abort();
    socket.setTimeout(requestTimeoutMs, () => {
      abort3();
      socket.destroy();
    });
    socket.once("error", abort3);
    socket.once("close", () => {
      if (!requestEnded) abort3();
      sockets.delete(socket);
      controllers.delete(controller);
    });
    socket.on("data", (raw) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      bytes += chunk.byteLength;
      if (bytes > MAXIMUM_MESSAGE_BYTES) {
        abort3();
        socket.end(stableFailure());
        return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => {
      requestEnded = true;
      if (bytes > MAXIMUM_MESSAGE_BYTES) return;
      void options.dispatcher.dispatch(
        Buffer.concat(chunks, bytes),
        controller.signal
      ).then(
        (response) => {
          if (!socket.destroyed) socket.end(response);
        },
        () => {
          if (!socket.destroyed) socket.end(stableFailure());
        }
      );
    });
  });
  server.maxConnections = 2;
  try {
    await listen3(server, socketPath);
    await chmod(socketPath, 384);
    const created = await inspect(socketPath);
    validateProductionLoadFixtureRuntimeSocket(created);
    let closePromise = null;
    return {
      socketPath,
      close() {
        closePromise ??= (async () => {
          closing = true;
          for (const controller of controllers) controller.abort();
          for (const socket of sockets) socket.destroy();
          await closeServer3(server);
          await options.dispatcher.close();
          try {
            const current = await inspect(socketPath);
            if (current.isSocket() && current.dev === created.dev && current.ino === created.ino) {
              await unlink2(socketPath);
            }
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        })();
        return closePromise;
      }
    };
  } catch (error) {
    closing = true;
    for (const controller of controllers) controller.abort();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await closeServer3(server).catch(() => void 0);
    try {
      const current = await inspect(socketPath);
      if (current.isSocket()) await unlink2(socketPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") {
        throw cleanupError;
      }
    }
    throw error;
  }
}

// scripts/start-production-load-fixture-runtime.ts
var defaults = {
  startTopology: startProductionLoadDisposableFixtureTopology,
  createOperations: createProductionLoadDisposableFixtureOperations,
  createDispatcher: createProductionLoadFixtureRuntimeDispatcher,
  startUnixServer: startProductionLoadFixtureRuntimeUnixServer
};
async function startProductionLoadDisposableFixtureRuntime(dependencies = defaults) {
  let topology = null;
  let operations = null;
  let dispatcher = null;
  try {
    topology = await dependencies.startTopology();
    operations = dependencies.createOperations({ topology });
    dispatcher = dependencies.createDispatcher({
      operations,
      maximumConcurrentRequests: 2,
      requestTimeoutMs: 125e3
    });
    const server = await dependencies.startUnixServer({
      dispatcher,
      requestTimeoutMs: 125e3
    });
    let closePromise = null;
    return {
      socketPath: server.socketPath,
      close() {
        closePromise ??= server.close();
        return closePromise;
      }
    };
  } catch {
    await Promise.allSettled([
      dispatcher?.close(),
      operations?.close(),
      topology?.close()
    ]);
    throw new Error("fixture_runtime_start_failed");
  }
}
async function main() {
  if (process.platform !== "linux" || process.getuid?.() !== 65532 || process.getgid?.() !== 65532 || process.env.NODE_ENV !== "production") {
    throw new Error("fixture_runtime_start_failed");
  }
  const runtime = await startProductionLoadDisposableFixtureRuntime();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    void runtime.close().then(
      () => void 0,
      () => {
        process.exitCode = 1;
      }
    );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.stdout.write("production load disposable fixture runtime ready\n");
}
var invokedPath = process.argv[1] ? path4.resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  void main().catch(() => {
    process.stderr.write("production load disposable fixture runtime failed\n");
    process.exitCode = 1;
  });
}
export {
  startProductionLoadDisposableFixtureRuntime
};
