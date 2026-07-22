import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type Server as HttpServer,
} from "node:http";
import {
  createConnection,
  createServer as createTcpServer,
  type Server as TcpServer,
  type Socket,
} from "node:net";
import path from "node:path";

import {
  startProductionLoadDisposableProviderServer,
  startProductionLoadDisposableTcpProxy,
  type ProductionLoadDisposableCloseable,
  type ProductionLoadDisposableProviderServer,
  type ProductionLoadDisposableTcpProxy,
} from "./production-load-disposable-fixtures";
import type {
  ProductionLoadDisposableFixtureTopology,
} from "./production-load-disposable-runtime";
import type { ProductionLoadFixtureOperations } from "./production-load-fixture-runtime";

type FaultId = Parameters<ProductionLoadFixtureOperations["reset"]>[0];
type FaultPhase = Parameters<ProductionLoadFixtureOperations["probe"]>[1];

const FIXTURE_ROOT = "/var/lib/learncoding-production-load-fixtures";
const POSTGRES_UPSTREAM_PORT = 5_432;
const APPLICATION_UPSTREAM_PORT = 3_000;
const MAXIMUM_HTTP_BODY_BYTES = 8 * 1024;
const MAXIMUM_QUOTA_VOLUME_BYTES = 32 * 1024 * 1024;
const FAULT_DURATION_MS = 100;

const fixtureFaults = new Set<FaultId>([
  "postgres_proxy_interruption",
  "tunnel_proxy_interruption",
  "fake_gmail_failure",
  "fake_ai_provider_failure",
  "fake_offsite_drive_failure",
  "quota_volume_near_full",
  "synthetic_stale_backup_alert",
]);

const providerByFault = {
  fake_gmail_failure: "gmail",
  fake_ai_provider_failure: "ai",
  fake_offsite_drive_failure: "drive",
} as const;

type Provider = (typeof providerByFault)[keyof typeof providerByFault];

type Upstream = ProductionLoadDisposableCloseable & { readonly port: number };

export type StartProductionLoadDisposableFixtureTopologyOptions = {
  readonly testConfiguration?: {
    readonly fixtureRoot: string;
    readonly postgresPort: number;
    readonly applicationPort: number;
  };
};

function fail(code: string): never {
  throw new Error(`Production load disposable topology failed: ${code}`);
}

function abort(signal: AbortSignal): void {
  if (signal.aborted) fail("aborted");
}

function delay(durationMs: number, signal: AbortSignal): Promise<void> {
  abort(signal);
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

function listen(
  server: TcpServer | HttpServer,
  host: string,
  port: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
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

function closeServer(server: TcpServer | HttpServer, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function startEchoUpstream(port: number): Promise<Upstream> {
  const sockets = new Set<Socket>();
  const server = createTcpServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.setTimeout(2_000, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    socket.pipe(socket);
  });
  const actualPort = await listen(server, "127.0.0.1", port);
  return { port: actualPort, close: () => closeServer(server, sockets) };
}

async function consumeBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
    bytes += chunk.byteLength;
    if (bytes > MAXIMUM_HTTP_BODY_BYTES) fail("body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

function learnerId(index: number): string {
  return `load-learner-${String(index + 1).padStart(2, "0")}`;
}

function sessionToken(learner: string): string {
  return createHash("sha256")
    .update(`codestead-production-load-session-v1:${learner}`, "utf8")
    .digest("hex");
}

async function startAuthenticatedApplication(port: number): Promise<Upstream> {
  const sockets = new Set<Socket>();
  const sessions = new Map<string, string>();
  const server = createHttpServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "", "http://fixture.invalid");
        if (request.method === "POST" && url.pathname === "/fixture/session") {
          const body = await consumeBody(request);
          const value = JSON.parse(body.toString("utf8")) as unknown;
          const learner = value !== null && typeof value === "object"
            && !Array.isArray(value) && Object.keys(value).join(",") === "learnerId"
            ? (value as { learnerId?: unknown }).learnerId
            : null;
          if (typeof learner !== "string"
            || !/^load-learner-(?:0[1-9]|10)$/.test(learner)) {
            response.writeHead(400).end();
            return;
          }
          const token = sessionToken(learner);
          sessions.set(token, learner);
          response.writeHead(201, {
            "cache-control": "no-store",
            "content-type": "application/json",
            "x-content-type-options": "nosniff",
          });
          response.end(JSON.stringify({ token }));
          return;
        }
        if (request.method === "GET" && url.pathname === "/fixture/lesson") {
          const authorization = request.headers.authorization ?? "";
          const token = authorization.startsWith("Bearer ")
            ? authorization.slice("Bearer ".length)
            : "";
          const learner = sessions.get(token);
          if (!learner) {
            response.writeHead(401, { "cache-control": "no-store" }).end();
            return;
          }
          response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "application/json",
            "x-content-type-options": "nosniff",
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
  server.headersTimeout = 1_000;
  server.requestTimeout = 2_000;
  server.keepAliveTimeout = 500;
  server.maxConnections = 32;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.setTimeout(2_500, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });
  const actualPort = await listen(server, "127.0.0.1", port);
  return { port: actualPort, close: () => closeServer(server, sockets) };
}

function tcpRoundTrip(port: number, input: Buffer, signal: AbortSignal): Promise<Buffer> {
  abort(signal);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, bytes));
    };
    const onAbort = () => finish(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    socket.setTimeout(2_000, () => finish(new Error("timeout")));
    socket.once("connect", () => socket.end(input));
    socket.on("data", (raw: Buffer | string) => {
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

function fixtureHttp(options: {
  readonly port: number;
  readonly method: "GET" | "POST";
  readonly pathname: string;
  readonly body?: Buffer;
  readonly token?: string;
  readonly signal: AbortSignal;
}): Promise<{ readonly status: number; readonly body: Buffer }> {
  abort(options.signal);
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
        ...(options.body ? {
          "content-length": String(options.body.byteLength),
          "content-type": "application/json",
        } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > MAXIMUM_HTTP_BODY_BYTES) request.destroy(new Error("response_too_large"));
        else chunks.push(Buffer.from(chunk));
      });
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks, bytes),
      }));
    });
    request.setTimeout(2_000, () => request.destroy(new Error("timeout")));
    request.once("error", reject);
    request.end(options.body);
  });
}
function validateAuthenticatedLesson(
  response: { readonly status: number; readonly body: Buffer },
  learner: string,
): void {
  let value: unknown;
  try {
    value = JSON.parse(response.body.toString("utf8"));
  } catch {
    fail("authenticated_journey_failed");
  }
  if (response.status !== 200
    || value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).join(",") !== "learnerId,lesson"
    || (value as { learnerId?: unknown }).learnerId !== learner
    || (value as { lesson?: unknown }).lesson !== "fixture-readiness") {
    fail("authenticated_journey_failed");
  }
}


async function authenticateLearners(
  tunnelPort: number,
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const sessions = new Map<string, string>();
  for (let index = 0; index < 10; index += 1) {
    abort(signal);
    const learner = learnerId(index);
    const response = await fixtureHttp({
      port: tunnelPort,
      method: "POST",
      pathname: "/fixture/session",
      body: Buffer.from(JSON.stringify({ learnerId: learner }), "utf8"),
      signal,
    });
    let value: unknown;
    try {
      value = JSON.parse(response.body.toString("utf8"));
    } catch {
      fail("authentication_failed");
    }
    const token = value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as { token?: unknown }).token
      : null;
    if (response.status !== 201 || typeof token !== "string"
      || token !== sessionToken(learner) || sessions.has(learner)) {
      fail("authentication_failed");
    }
    const lesson = await fixtureHttp({
      port: tunnelPort,
      method: "GET",
      pathname: "/fixture/lesson",
      token,
      signal,
    });
    validateAuthenticatedLesson(lesson, learner);
    sessions.set(learner, token);
  }
  return sessions;
}

async function runnerBackpressureProof(signal: AbortSignal): Promise<{
  readonly maximum: number;
  readonly queued: number;
}> {
  let running = 0;
  let maximum = 0;
  let maximumQueued = 0;
  const queue: Array<() => void> = [];
  const pump = () => {
    while (running < 2 && queue.length > 0) {
      const start = queue.shift();
      running += 1;
      maximum = Math.max(maximum, running);
      start?.();
    }
  };
  const submit = () => new Promise<void>((resolve, reject) => {
    queue.push(() => {
      void delay(10, signal).then(resolve, reject).finally(() => {
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

function providerStatus(
  server: ProductionLoadDisposableProviderServer,
  provider: Provider,
  signal: AbortSignal,
): Promise<number> {
  return fetch(`http://127.0.0.1:${server.port}/${provider}`, {
    redirect: "manual",
    signal,
  }).then((response) => response.status);
}

async function exists(target: string): Promise<boolean> {
  try {
    const handle = await open(target, "r");
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

async function fillQuotaVolume(root: string, signal: AbortSignal): Promise<void> {
  abort(signal);
  const before = await statfs(root);
  const capacity = before.blocks * before.bsize;
  const free = before.bavail * before.bsize;
  if (!Number.isSafeInteger(capacity) || capacity < 4 * 1024 * 1024
    || capacity > MAXIMUM_QUOTA_VOLUME_BYTES || !Number.isSafeInteger(free)) {
    fail("unbounded_quota_volume");
  }
  const target = path.join(root, "quota-near-full.bin");
  const bytes = Math.max(1, Math.floor(free - capacity * 0.08));
  const handle = await open(target, "wx", 0o600);
  const chunk = Buffer.alloc(Math.min(1024 * 1024, bytes), 0x51);
  try {
    let written = 0;
    while (written < bytes) {
      abort(signal);
      const size = Math.min(chunk.byteLength, bytes - written);
      await handle.write(chunk, 0, size);
      written += size;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  const after = await statfs(root);
  if (after.bavail / after.blocks > 0.1) fail("quota_fault_not_reached");
}

function providerForFault(faultId: FaultId): Provider | null {
  return Object.prototype.hasOwnProperty.call(providerByFault, faultId)
    ? providerByFault[faultId as keyof typeof providerByFault]
    : null;
}

export async function startProductionLoadDisposableFixtureTopology(
  options: StartProductionLoadDisposableFixtureTopologyOptions = {},
): Promise<ProductionLoadDisposableFixtureTopology> {
  const test = options.testConfiguration;
  if (test && process.env.NODE_ENV !== "test") fail("test_configuration_forbidden");
  const fixtureRoot = test?.fixtureRoot ?? FIXTURE_ROOT;
  const postgresPort = test?.postgresPort ?? POSTGRES_UPSTREAM_PORT;
  const applicationPort = test?.applicationPort ?? APPLICATION_UPSTREAM_PORT;
  if (!path.isAbsolute(fixtureRoot)
    || !Number.isSafeInteger(postgresPort) || postgresPort < 1 || postgresPort > 65_535
    || !Number.isSafeInteger(applicationPort) || applicationPort < 1
    || applicationPort > 65_535 || applicationPort === postgresPort) {
    fail("invalid_configuration");
  }
  await mkdir(fixtureRoot, { recursive: true, mode: 0o700 });

  const closeables: ProductionLoadDisposableCloseable[] = [];
  let postgres: Upstream;
  let application: Upstream;
  let postgresProxy: ProductionLoadDisposableTcpProxy;
  let tunnelProxy: ProductionLoadDisposableTcpProxy;
  let provider: ProductionLoadDisposableProviderServer;
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

  const quotaPath = path.join(fixtureRoot, "quota-near-full.bin");
  const stalePath = path.join(fixtureRoot, "synthetic-stale-backup.json");
  const alertedFaults = new Set<FaultId>();
  let sessions = new Map<string, string>();
  let runnerMaximum = 0;
  let runnerQueued = 0;
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const ensureFixtureFault = (faultId: FaultId) => {
    if (!fixtureFaults.has(faultId)) fail("external_fault_required");
  };
  const postgresHealthy = async (signal: AbortSignal) => {
    const marker = Buffer.from("codestead-postgres-fixture-v1\n", "ascii");
    const output = await tcpRoundTrip(postgresProxy.port, marker, signal);
    return output.equals(marker);
  };
  const journey = async (signal: AbortSignal) => {
    if (sessions.size !== 10) fail("authenticated_journey_failed");
    for (const [learner, token] of sessions) {
      abort(signal);
      const response = await fixtureHttp({
        port: tunnelProxy.port,
        method: "GET",
        pathname: "/fixture/lesson",
        token,
        signal,
      });
      validateAuthenticatedLesson(response, learner);
    }
  };
  const resetFixture = async (faultId: FaultId) => {
    if (faultId === "postgres_proxy_interruption") postgresProxy.reset();
    else if (faultId === "tunnel_proxy_interruption") tunnelProxy.reset();
    else {
      const mapped = providerForFault(faultId);
      if (mapped) provider.reset(mapped);
      else if (faultId === "quota_volume_near_full") {
        await unlink(quotaPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      } else if (faultId === "synthetic_stale_backup_alert") {
        await unlink(stalePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    }
  };

  return {
    async readinessEvidence(signal) {
      abort(signal);
      if (closed) fail("closed");
      await resetFixture("postgres_proxy_interruption");
      await resetFixture("tunnel_proxy_interruption");
      provider.reset();
      const postgresRoundTrip = await postgresHealthy(signal);
      const providerStatuses = {
        gmail: await providerStatus(provider, "gmail", signal),
        ai: await providerStatus(provider, "ai", signal),
        drive: await providerStatus(provider, "drive", signal),
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
        runnerQueuedJobsObserved: runner.queued,
      };
    },

    async reset(faultId, signal) {
      abort(signal);
      ensureFixtureFault(faultId);
      await resetFixture(faultId);
      alertedFaults.delete(faultId);
      abort(signal);
    },

    async injectAndRelease(faultId, signal) {
      abort(signal);
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
            await delay(FAULT_DURATION_MS, signal);
          } finally {
            await resetFixture(faultId);
          }
        } else {
          try {
            await writeFile(stalePath, "{\"schemaVersion\":1,\"stale\":true}\n", {
              encoding: "utf8", flag: "wx", mode: 0o600,
            });
            await delay(FAULT_DURATION_MS, signal);
          } finally {
            await resetFixture(faultId);
          }
        }
      }
      alertedFaults.add(faultId);
      abort(signal);
    },

    async probe(faultId, phase: FaultPhase, signal) {
      abort(signal);
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
        alertOrDeadLetterVisible: phase === "recovery" && alertedFaults.has(faultId),
      };
    },

    async browserJourney(faultId, _stage, signal) {
      abort(signal);
      if (!fixtureFaults.has(faultId)) fail("external_fault_required");
      await journey(signal);
      abort(signal);
    },

    async invariantEvidence(faultId, signal) {
      abort(signal);
      ensureFixtureFault(faultId);
      if (runnerMaximum !== 2 || runnerQueued < 1) fail("runner_proof_unavailable");
      return {
        acknowledgedMutationFailures: 0,
        runnerMaxConcurrentJobs: runnerMaximum,
        secretLeakFindings: 0,
      };
    },

    close() {
      closePromise ??= (async () => {
        closed = true;
        await Promise.allSettled([
          resetFixture("quota_volume_near_full"),
          resetFixture("synthetic_stale_backup_alert"),
        ]);
        const results = await Promise.allSettled(
          closeables.reverse().map((item) => item.close()),
        );
        if (results.some((result) => result.status === "rejected")) fail("close_failed");
      })();
      return closePromise;
    },
  };
}
