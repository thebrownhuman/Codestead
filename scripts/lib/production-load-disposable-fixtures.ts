import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import {
  createConnection,
  createServer as createTcpServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";

import {
  assertProductionLoadDisposableNetworkSandbox,
  type ProductionLoadDisposableNetworkSandbox,
} from "./production-load-disposable-sandbox";

const MAXIMUM_PROVIDER_BODY_BYTES = 64 * 1024;
const PROVIDER_HEADERS_TIMEOUT_MS = 1_000;
const PROVIDER_REQUEST_TIMEOUT_MS = 2_000;
const PROVIDER_KEEP_ALIVE_TIMEOUT_MS = 500;
const PROVIDER_SOCKET_TIMEOUT_MS = 2_500;

export type ProductionLoadDisposableCloseable = {
  close(): Promise<void>;
};

export type ProductionLoadDisposableTcpProxy = ProductionLoadDisposableCloseable & {
  readonly port: number;
  interruptAndRelease(durationMs: number, signal: AbortSignal): Promise<void>;
  reset(): void;
  status(): { readonly interrupted: boolean; readonly activeConnections: number };
};

export type ProductionLoadDisposableProviderServer = ProductionLoadDisposableCloseable & {
  readonly port: number;
  interruptAndRelease(
    provider: "gmail" | "ai" | "drive",
    durationMs: number,
    signal: AbortSignal,
  ): Promise<void>;
  reset(provider?: "gmail" | "ai" | "drive"): void;
  status(): { readonly gmail: boolean; readonly ai: boolean; readonly drive: boolean };
};

type FaultHandle = {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
};

type SocketPair = {
  readonly client: Socket;
  readonly upstream: Socket;
  clientClosed: boolean;
  upstreamClosed: boolean;
  readonly closed: Promise<void>;
  readonly resolveClosed: () => void;
};

function fail(code: string): never {
  throw new Error(`Production load disposable fixture failed: ${code}`);
}

function validateDuration(durationMs: number): void {
  if (!Number.isSafeInteger(durationMs) || durationMs < 100 || durationMs > 5_000) {
    fail("invalid_duration");
  }
}

function delay(durationMs: number, signal: AbortSignal): Promise<void> {
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

function createFault(
  durationMs: number,
  callerSignal: AbortSignal,
  release: () => void,
): FaultHandle {
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

function closeServer(server: Server | ReturnType<typeof createHttpServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function listen(
  server: Server | ReturnType<typeof createHttpServer>,
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
      resolve((address as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function proxyConfiguration(
  sandbox: ProductionLoadDisposableNetworkSandbox,
  kind: "postgres" | "tunnel",
) {
  return sandbox[kind];
}

export async function startProductionLoadDisposableTcpProxy(options: {
  readonly kind: "postgres" | "tunnel";
}): Promise<ProductionLoadDisposableTcpProxy> {
  const sandbox = await assertProductionLoadDisposableNetworkSandbox();
  const configuration = proxyConfiguration(sandbox, options.kind);
  let interrupted = false;
  let closing = false;
  let activeFault: FaultHandle | null = null;
  const pairs = new Set<SocketPair>();
  const destroyPair = (pair: SocketPair) => {
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
      allowHalfOpen: true,
    });
    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const pair: SocketPair = {
      client,
      upstream,
      clientClosed: false,
      upstreamClosed: false,
      closed,
      resolveClosed,
    };
    pairs.add(pair);
    const closeHalf = (half: "client" | "upstream") => {
      if (half === "client") pair.clientClosed = true;
      else pair.upstreamClosed = true;
      destroyPair(pair);
      if (pair.clientClosed && pair.upstreamClosed && pairs.delete(pair)) pair.resolveClosed();
    };
    const failPair = () => destroyPair(pair);
    client.setTimeout(30_000, failPair);
    upstream.setTimeout(30_000, failPair);
    client.once("error", failPair);
    upstream.once("error", failPair);
    client.once("close", () => closeHalf("client"));
    upstream.once("close", () => closeHalf("upstream"));
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.maxConnections = configuration.maximumConnections;
  const port = await listen(server, configuration.listenHost, configuration.listenPort).catch(() => {
    fail("listen_failed");
  });

  let closePromise: Promise<void> | null = null;
  return {
    port,
    interruptAndRelease(durationMs, signal) {
      validateDuration(durationMs);
      if (closing) return Promise.reject(new Error("closed"));
      if (activeFault) return activeFault.promise;
      interrupted = true;
      for (const pair of pairs) destroyPair(pair);
      const fault = createFault(durationMs, signal, () => {
        interrupted = false;
        if (activeFault === fault) activeFault = null;
      });
      activeFault = fault;
      return fault.promise;
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
        await activeFault?.promise.catch(() => undefined);
        await Promise.all(closingPairs.map((pair) => pair.closed));
        await closeServer(server);
      })();
      return closePromise;
    },
  };
}

const providerPaths = new Map([
  ["/gmail", "gmail"],
  ["/ai", "ai"],
  ["/drive", "drive"],
] as const);

function canonicalContentLength(request: IncomingMessage): number | null {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "content-length") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  if (values.length === 0) return null;
  if (values.length !== 1 || !/^(?:0|[1-9][0-9]*)$/.test(values[0] ?? "")) {
    fail("invalid_body_length");
  }
  const value = Number(values[0]);
  if (!Number.isSafeInteger(value)) fail("invalid_body_length");
  return value;
}

async function consumeBoundedBody(request: IncomingMessage): Promise<void> {
  const contentLength = canonicalContentLength(request);
  if (contentLength !== null && contentLength > MAXIMUM_PROVIDER_BODY_BYTES) {
    request.socket.destroy();
    fail("body_too_large");
  }
  let bytes = 0;
  for await (const raw of request) {
    bytes += Buffer.isBuffer(raw) ? raw.byteLength : Buffer.byteLength(raw as string);
    if (bytes > MAXIMUM_PROVIDER_BODY_BYTES) {
      request.socket.destroy();
      fail("body_too_large");
    }
  }
}

export async function startProductionLoadDisposableProviderServer(): Promise<
  ProductionLoadDisposableProviderServer
> {
  const sandbox = await assertProductionLoadDisposableNetworkSandbox();
  const configuration = sandbox.provider;
  const state = { gmail: false, ai: false, drive: false };
  const active = new Map<keyof typeof state, FaultHandle>();
  const sockets = new Set<Socket>();
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
        const provider = providerPaths.get(pathName as "/gmail" | "/ai" | "/drive");
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
    fail("listen_failed");
  });
  let closePromise: Promise<void> | null = null;

  return {
    port,
    interruptAndRelease(provider, durationMs, signal) {
      validateDuration(durationMs);
      if (closing) return Promise.reject(new Error("closed"));
      const current = active.get(provider);
      if (current) return current.promise;
      state[provider] = true;
      const fault = createFault(durationMs, signal, () => {
        state[provider] = false;
        if (active.get(provider) === fault) active.delete(provider);
      });
      active.set(provider, fault);
      return fault.promise;
    },
    reset(provider) {
      if (provider) {
        active.get(provider)?.controller.abort();
        state[provider] = false;
      } else {
        for (const fault of active.values()) fault.controller.abort();
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
        for (const fault of active.values()) fault.controller.abort();
        for (const socket of sockets) socket.destroy();
        await Promise.allSettled([...active.values()].map((fault) => fault.promise));
        await closeServer(server);
      })();
      return closePromise;
    },
  };
}
