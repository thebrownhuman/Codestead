import {
  createConnection,
  createServer as createTcpServer,
  type AddressInfo,
  type Socket,
} from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

const sandbox = vi.hoisted(() => ({
  configuration: {
    postgres: {
      listenHost: "127.0.0.1",
      listenPort: 0,
      upstreamHost: "127.0.0.1",
      upstreamPort: 1,
      maximumConnections: 4,
    },
    tunnel: {
      listenHost: "127.0.0.1",
      listenPort: 0,
      upstreamHost: "127.0.0.1",
      upstreamPort: 1,
      maximumConnections: 4,
    },
    provider: { listenHost: "127.0.0.1", listenPort: 0 },
  },
}));

vi.mock("./production-load-disposable-sandbox", () => ({
  assertProductionLoadDisposableNetworkSandbox: vi.fn(async () => sandbox.configuration),
}));

import {
  startProductionLoadDisposableProviderServer,
  startProductionLoadDisposableTcpProxy,
  type ProductionLoadDisposableCloseable,
} from "./production-load-disposable-fixtures";

const closeables: ProductionLoadDisposableCloseable[] = [];

afterEach(async () => {
  await Promise.allSettled(closeables.splice(0).reverse().map((item) => item.close()));
});

function tcpServer(handler: (socket: Socket) => void) {
  const sockets = new Set<Socket>();
  const server = createTcpServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handler(socket);
  });
  return new Promise<{ port: number; close(): Promise<void> }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        close: () => new Promise<void>((done, fail) => {
          for (const socket of sockets) socket.destroy();
          server.close((error) => error ? fail(error) : done());
        }),
      });
    });
  });
}

function echoServer() {
  return tcpServer((socket) => socket.pipe(socket));
}

function configureProxy(kind: "postgres" | "tunnel", upstreamPort: number): void {
  sandbox.configuration[kind].upstreamPort = upstreamPort;
}

async function roundTrip(port: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.setTimeout(1_000, () => socket.destroy(new Error("timeout")));
    socket.once("connect", () => socket.end(message));
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("error", reject);
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition_timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function rawConnection(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(5_000, () => socket.destroy(new Error("client_timeout")));
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForClose(socket: Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("close", () => resolve());
    socket.once("error", (error) => {
      if (socket.destroyed) resolve();
      else reject(error);
    });
  });
}

describe("production load disposable TCP proxy", () => {
  it("forwards real bytes, interrupts active traffic, then recovers", async () => {
    const upstream = await echoServer();
    closeables.push(upstream);
    configureProxy("postgres", upstream.port);
    const proxy = await startProductionLoadDisposableTcpProxy({ kind: "postgres" });
    closeables.push(proxy);

    await expect(roundTrip(proxy.port, "before")).resolves.toBe("before");
    const interruption = proxy.interruptAndRelease(100, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(roundTrip(proxy.port, "during")).rejects.toThrow();
    await interruption;
    await expect(roundTrip(proxy.port, "after")).resolves.toBe("after");
    expect(proxy.status()).toEqual({ interrupted: false, activeConnections: 0 });
  });

  it("always releases the fault when cancellation fires", async () => {
    const upstream = await echoServer();
    closeables.push(upstream);
    configureProxy("tunnel", upstream.port);
    const proxy = await startProductionLoadDisposableTcpProxy({ kind: "tunnel" });
    closeables.push(proxy);
    const controller = new AbortController();
    const interrupted = proxy.interruptAndRelease(5_000, controller.signal);
    controller.abort();
    await expect(interrupted).rejects.toThrow("aborted");
    expect(proxy.status().interrupted).toBe(false);
    await expect(roundTrip(proxy.port, "recovered")).resolves.toBe("recovered");
  });

  it("destroys both halves and drops tracking when an upstream closes first", async () => {
    const upstream = await tcpServer((socket) => socket.destroy());
    closeables.push(upstream);
    configureProxy("postgres", upstream.port);
    const proxy = await startProductionLoadDisposableTcpProxy({ kind: "postgres" });
    closeables.push(proxy);
    const client = await rawConnection(proxy.port);
    await waitForClose(client);
    await waitUntil(() => proxy.status().activeConnections === 0);
    expect(proxy.status()).toEqual({ interrupted: false, activeConnections: 0 });
  });

  it("cancels active fault timers and hostile half-open sockets during bounded close", async () => {
    const upstream = await tcpServer(() => undefined);
    closeables.push(upstream);
    configureProxy("tunnel", upstream.port);
    const proxy = await startProductionLoadDisposableTcpProxy({ kind: "tunnel" });
    closeables.push(proxy);
    const client = await rawConnection(proxy.port);
    await waitUntil(() => proxy.status().activeConnections === 1);
    const activeFault = proxy.interruptAndRelease(5_000, new AbortController().signal);
    const started = Date.now();
    await proxy.close();
    expect(Date.now() - started).toBeLessThan(750);
    await expect(activeFault).rejects.toThrow("aborted");
    await waitForClose(client);
    expect(proxy.status().activeConnections).toBe(0);
  });
});

describe("production load fake provider endpoint", () => {
  it("produces real provider failures without contacting any external endpoint", async () => {
    const server = await startProductionLoadDisposableProviderServer();
    closeables.push(server);

    for (const provider of ["gmail", "ai", "drive"] as const) {
      const url = `http://127.0.0.1:${server.port}/${provider}`;
      await expect(fetch(url, { redirect: "manual" }).then((value) => value.status)).resolves.toBe(204);
      const interruption = server.interruptAndRelease(
        provider, 100, new AbortController().signal,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expect(fetch(url, { redirect: "manual" }).then((value) => value.status)).resolves.toBe(503);
      await interruption;
      await expect(fetch(url, { redirect: "manual" }).then((value) => value.status)).resolves.toBe(204);
    }
    expect(server.status()).toEqual({ gmail: false, ai: false, drive: false });
  });

  it("rejects unallowlisted methods and paths without reflecting input", async () => {
    const server = await startProductionLoadDisposableProviderServer();
    closeables.push(server);
    const origin = `http://127.0.0.1:${server.port}`;
    await expect(fetch(`${origin}/unknown?token=secret`).then((value) => value.status)).resolves.toBe(404);
    await expect(fetch(`${origin}/ai`, { method: "PUT", body: "secret" })
      .then((value) => value.status)).resolves.toBe(405);
  });

  it("destroys declared and streamed oversized bodies before any provider response", async () => {
    const server = await startProductionLoadDisposableProviderServer();
    closeables.push(server);

    const declared = await rawConnection(server.port);
    const declaredOutput: Buffer[] = [];
    declared.on("data", (chunk) => declaredOutput.push(Buffer.from(chunk)));
    declared.write([
      "POST /ai HTTP/1.1",
      "Host: fixture.invalid",
      "Content-Length: 65537",
      "Connection: keep-alive",
      "",
      "",
    ].join("\r\n"));
    await waitForClose(declared);
    expect(Buffer.concat(declaredOutput).toString("utf8")).not.toContain(" 204 ");

    const streamed = await rawConnection(server.port);
    const streamedOutput: Buffer[] = [];
    streamed.on("data", (chunk) => streamedOutput.push(Buffer.from(chunk)));
    streamed.write([
      "POST /ai HTTP/1.1",
      "Host: fixture.invalid",
      "Transfer-Encoding: chunked",
      "Connection: keep-alive",
      "",
      "",
    ].join("\r\n"));
    const chunk = "x".repeat(40_000);
    streamed.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
    streamed.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
    await waitForClose(streamed);
    expect(Buffer.concat(streamedOutput).toString("utf8")).not.toContain(" 204 ");
  });

  it("closes slow headers and destroys keep-alive sockets during bounded shutdown", async () => {
    const server = await startProductionLoadDisposableProviderServer();
    closeables.push(server);
    const slow = await rawConnection(server.port);
    slow.write("POST /ai HTTP/1.1\r\nHost:");
    const slowStarted = Date.now();
    await waitForClose(slow);
    expect(Date.now() - slowStarted).toBeLessThan(3_500);

    const keepAlive = await rawConnection(server.port);
    keepAlive.write([
      "GET /gmail HTTP/1.1",
      "Host: fixture.invalid",
      "Connection: keep-alive",
      "",
      "",
    ].join("\r\n"));
    await new Promise<void>((resolve, reject) => {
      keepAlive.once("data", () => resolve());
      keepAlive.once("error", reject);
    });
    const activeFault = server.interruptAndRelease("ai", 5_000, new AbortController().signal);
    const closeStarted = Date.now();
    await server.close();
    expect(Date.now() - closeStarted).toBeLessThan(750);
    await expect(activeFault).rejects.toThrow("aborted");
    await waitForClose(keepAlive);
  });
});
