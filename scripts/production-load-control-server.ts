import { chmod, chown, lstat, unlink } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createConnection, type Socket } from "node:net";
import path from "node:path";

import type {
  ProductionLoadControlOperation,
} from "./lib/production-load-control";

const MAXIMUM_REQUEST_BYTES = 1_048_576;
const operations = new Set<ProductionLoadControlOperation>([
  "seed",
  "baseline",
  "sample",
  "runner_observation",
  "fault_reset",
  "fault_probe",
  "browser_journey",
  "fault_inject_release",
  "fault_invariants",
]);

export type ProductionLoadControlHost = {
  handle(
    operation: ProductionLoadControlOperation,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
  close?(): Promise<void>;
};

export type ProductionLoadControlRequest = {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly contentType: string | undefined;
  readonly body: Buffer;
  readonly signal?: AbortSignal;
};

export type ProductionLoadControlResponse = {
  readonly statusCode: number;
  readonly body: unknown;
};

export type StartProductionLoadControlServerOptions = {
  readonly socketPath: string;
  readonly host: ProductionLoadControlHost;
  readonly recoverBeforeListen: () => Promise<void>;
  readonly socketMode?: number;
  readonly maximumConcurrentRequests?: number;
  readonly requestTimeoutMs?: number;
  readonly socketUid?: number;
  readonly socketGid?: number;
  readonly authorizePeer?: (socket: Socket) => boolean | Promise<boolean>;
};

function stableError(statusCode: number, code: string): ProductionLoadControlResponse {
  return {
    statusCode,
    body: { schemaVersion: 1, ok: false, error: { code } },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

export type ProductionLoadSocketStat = {
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly nlink: number;
  isDirectory(): boolean;
  isSocket(): boolean;
  isSymbolicLink(): boolean;
};

export function validateProductionLoadSocketDirectory(
  value: ProductionLoadSocketStat,
  expectedUid: number,
  expectedGid: number,
): void {
  if (!value.isDirectory()
    || value.isSymbolicLink()
    || value.uid !== expectedUid
    || value.gid !== expectedGid
    || value.nlink < 2
    || (value.mode & 0o027) !== 0) {
    throw new Error("Production load control server failed: unsafe_socket_parent");
  }
}

export function validateProductionLoadStaleSocket(
  value: ProductionLoadSocketStat,
  expectedUid: number,
  expectedGid: number,
  expectedMode: number,
): void {
  if (!value.isSocket()
    || value.isSymbolicLink()
    || value.uid !== expectedUid
    || value.gid !== expectedGid
    || value.nlink !== 1
    || (value.mode & 0o777) !== expectedMode) {
    throw new Error("Production load control server failed: unsafe_existing_socket");
  }
}

export function createProductionLoadRequestDispatcher(
  host: ProductionLoadControlHost,
  maximumConcurrentRequests: number,
) {
  if (!Number.isSafeInteger(maximumConcurrentRequests)
    || maximumConcurrentRequests < 1
    || maximumConcurrentRequests > 4) {
    throw new Error("Production load control server failed: invalid_concurrency");
  }
  let active = 0;
  return async (request: ProductionLoadControlRequest): Promise<ProductionLoadControlResponse> => {
    if (request.signal?.aborted) return stableError(503, "operation_failed");
    if (active >= maximumConcurrentRequests) return stableError(503, "server_busy");
    active += 1;
    const pending = processProductionLoadControlRequest(host, request);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
    };
    void pending.then(release, release);
    if (!request.signal) return pending;
    const signal = request.signal;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: ProductionLoadControlResponse) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => finish(stableError(503, "operation_failed"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      void pending.then(finish, () => finish(stableError(503, "operation_failed")));
    });
  };
}

function hostHandle(
  host: ProductionLoadControlHost,
  operation: ProductionLoadControlOperation,
  payload: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  return signal ? host.handle(operation, payload, signal) : host.handle(operation, payload);
}

function cancelled(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}
export async function processProductionLoadControlRequest(
  host: ProductionLoadControlHost,
  request: ProductionLoadControlRequest,
): Promise<ProductionLoadControlResponse> {
  if (request.method !== "POST") return stableError(405, "method_not_allowed");
  if (request.url !== "/v1/load-control") return stableError(404, "route_not_found");
  if (!/^application\/json(?:\s*;|$)/i.test(request.contentType ?? "")) {
    return stableError(415, "unsupported_media_type");
  }
  if (request.body.length > MAXIMUM_REQUEST_BYTES) {
    return stableError(413, "request_too_large");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body)) as unknown;
  } catch {
    return stableError(400, "invalid_json");
  }
  const envelope = record(decoded);
  if (!envelope
    || !exactKeys(envelope, ["schemaVersion", "operation", "payload"])
    || envelope.schemaVersion !== 1
    || typeof envelope.operation !== "string") {
    return stableError(400, "invalid_envelope");
  }
  if (!operations.has(envelope.operation as ProductionLoadControlOperation)) {
    return stableError(400, "invalid_operation");
  }
  if (cancelled(request.signal)) return stableError(503, "operation_failed");
  try {
    const result = await hostHandle(
      host,
      envelope.operation as ProductionLoadControlOperation,
      envelope.payload,
      request.signal,
    );
    if (cancelled(request.signal)) return stableError(503, "operation_failed");
    return { statusCode: 200, body: { schemaVersion: 1, ok: true, result } };
  } catch {
    return stableError(503, "operation_failed");
  }
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const declared = request.headers["content-length"];
  if (typeof declared === "string") {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAXIMUM_REQUEST_BYTES) {
      throw new Error("request_too_large");
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.length;
    if (total > MAXIMUM_REQUEST_BYTES) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function send(response: ServerResponse, result: ProductionLoadControlResponse): void {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(result.body);
  response.statusCode = result.statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(body);
}

function safeSocketPath(socketPath: string): string {
  if (!path.isAbsolute(socketPath)
    || socketPath === path.parse(socketPath).root
    || socketPath.length > 240
    || /[\0\r\n]/.test(socketPath)) {
    throw new Error("Production load control server failed: invalid_socket_path");
  }
  return path.resolve(socketPath);
}

function socketIsActive(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
      else reject(error);
    });
  });
}

async function prepareSocketPath(
  socketPath: string,
  expectedUid: number,
  expectedGid: number,
  socketMode: number,
): Promise<void> {
  const parent = await lstat(path.dirname(socketPath)).catch(() => {
    throw new Error("Production load control server failed: unsafe_socket_parent");
  });
  validateProductionLoadSocketDirectory(parent, expectedUid, expectedGid);
  let current;
  try {
    current = await lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  validateProductionLoadStaleSocket(current, expectedUid, expectedGid, socketMode);
  if (await socketIsActive(socketPath)) {
    throw new Error("Production load control server failed: socket_in_use");
  }
  await unlink(socketPath);
}
function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
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

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
}

export function resolveProductionLoadControlSocket(
  environment: NodeJS.ProcessEnv,
): string {
  const raw = environment.LOAD_CONTROL_SOCKET?.trim() ?? "";
  if (environment.LOAD_MODE !== "production"
    || environment.LOAD_SCOPE !== "codestead-project-only"
    || environment.LOAD_PROJECT !== "learncoding"
    || !raw
    || !path.isAbsolute(raw)) {
    throw new Error("Production load control server failed: invalid_environment");
  }
  return safeSocketPath(raw);
}
export async function startProductionLoadControlServer(
  options: StartProductionLoadControlServerOptions,
) {
  const socketPath = safeSocketPath(options.socketPath);
  const socketMode = options.socketMode ?? 0o660;
  if (!Number.isSafeInteger(socketMode) || socketMode < 0o600 || socketMode > 0o660) {
    throw new Error("Production load control server failed: invalid_socket_mode");
  }
  const maximumConcurrentRequests = options.maximumConcurrentRequests ?? 2;
  if (!Number.isSafeInteger(maximumConcurrentRequests)
    || maximumConcurrentRequests < 1
    || maximumConcurrentRequests > 4) {
    throw new Error("Production load control server failed: invalid_concurrency");
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? 125_000;
  if (!Number.isSafeInteger(requestTimeoutMs)
    || requestTimeoutMs < 1_000
    || requestTimeoutMs > 130_000) {
    throw new Error("Production load control server failed: invalid_timeout");
  }

  const socketUid = options.socketUid ?? process.getuid?.() ?? 0;
  const socketGid = options.socketGid ?? process.getgid?.() ?? 0;
  if (!Number.isSafeInteger(socketUid) || socketUid < 0
    || !Number.isSafeInteger(socketGid) || socketGid < 0) {
    throw new Error("Production load control server failed: invalid_socket_owner");
  }
  const closeHost = async () => {
    try {
      await options.host.close?.();
    } catch {
      // Startup recovery failures must remain stable and secret-free.
    }
  };
  if (typeof options.recoverBeforeListen !== "function") {
    await closeHost();
    throw new Error(
      "Production load control server failed: startup_recovery_required",
    );
  }
  try {
    await options.recoverBeforeListen();
  } catch {
    await closeHost();
    throw new Error(
      "Production load control server failed: startup_recovery_failed",
    );
  }
  await prepareSocketPath(socketPath, socketUid, socketGid, socketMode);
  let closing = false;
  const dispatch = createProductionLoadRequestDispatcher(options.host, maximumConcurrentRequests);
  const authorizePeer = options.authorizePeer ?? ((socket: Socket) => socket.remoteAddress === undefined);
  const activeControllers = new Set<AbortController>();
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    activeControllers.add(controller);
    const abort = () => controller.abort();
    const onResponseClose = () => {
      if (!response.writableFinished) abort();
    };
    request.once("aborted", abort);
    response.once("close", onResponseClose);
    const deadline = setTimeout(abort, requestTimeoutMs);
    deadline.unref();
    try {
      if (closing) {
        request.resume();
        send(response, stableError(503, "server_busy"));
        return;
      }
      let authorized = false;
      try {
        authorized = await authorizePeer(request.socket);
      } catch {
        authorized = false;
      }
      if (!authorized) {
        request.resume();
        send(response, stableError(403, "peer_not_authorized"));
        return;
      }
      let body: Buffer;
      try {
        body = await readRequestBody(request);
      } catch {
        send(response, stableError(413, "request_too_large"));
        return;
      }
      send(response, await dispatch({
        method: request.method,
        url: request.url,
        contentType: typeof request.headers["content-type"] === "string"
          ? request.headers["content-type"]
          : undefined,
        body,
        signal: controller.signal,
      }));
    } catch {
      send(response, stableError(503, "operation_failed"));
    } finally {
      clearTimeout(deadline);
      request.off("aborted", abort);
      response.off("close", onResponseClose);
      activeControllers.delete(controller);
    }
  });
  server.maxConnections = maximumConcurrentRequests;
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = Math.min(requestTimeoutMs, 10_000);
  server.keepAliveTimeout = 1_000;

  try {
    await listen(server, socketPath);
    await chown(socketPath, socketUid, socketGid);
    await chmod(socketPath, socketMode);
  } catch {
    await closeServer(server).catch(() => undefined);
    throw new Error("Production load control server failed: listen_failed");
  }
  const identity = await lstat(socketPath);
  if (!identity.isSocket() || identity.isSymbolicLink()) {
    await closeServer(server).catch(() => undefined);
    throw new Error("Production load control server failed: unsafe_created_socket");
  }
  let closed = false;
  return {
    socketPath,
    async close() {
      if (closed) return;
      closed = true;
      closing = true;
      for (const controller of activeControllers) controller.abort();
      await closeServer(server);
      await options.host.close?.();
      try {
        const current = await lstat(socketPath);
        if (current.isSocket()
          && !current.isSymbolicLink()
          && current.dev === identity.dev
          && current.ino === identity.ino) {
          await unlink(socketPath);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}
