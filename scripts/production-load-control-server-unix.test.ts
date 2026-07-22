import { chmod, mkdtemp } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startProductionLoadControlServer,
  type ProductionLoadControlHost,
} from "./production-load-control-server";

function host(): ProductionLoadControlHost {
  return { handle: vi.fn(async () => ({ ok: true })) };
}

function closeNet(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function listenNet(server: ReturnType<typeof createServer>, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

function post(socketPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = '{"schemaVersion":1,"operation":"baseline","payload":{}}';
    const outgoing = request({
      socketPath, path: "/v1/load-control", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

describe.skipIf(process.platform === "win32")("production load Unix peer and crash recovery", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

  it("does not unlink or displace an active owned control socket", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codestead-control-active-"));
    const socketPath = path.join(root, "control.sock");
    const first = await startProductionLoadControlServer({
      socketPath,
      host: host(),
      recoverBeforeListen: async () => undefined,
    });
    closers.push(first.close);

    await expect(startProductionLoadControlServer({
      socketPath,
      host: host(),
      recoverBeforeListen: async () => undefined,
    })).rejects.toThrow(
      /socket_in_use/,
    );
    await expect(post(socketPath)).resolves.toMatchObject({ status: 200 });
  });

  it("recovers only a private, owned stale socket left by a crash", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codestead-control-stale-"));
    const socketPath = path.join(root, "control.sock");
    const stale = createServer();
    await listenNet(stale, socketPath);
    await chmod(socketPath, 0o660);
    await closeNet(stale);

    const recovered = await startProductionLoadControlServer({
      socketPath,
      host: host(),
      recoverBeforeListen: async () => undefined,
    });
    closers.push(recovered.close);
    await expect(post(socketPath)).resolves.toMatchObject({ status: 200 });
  });

  it("rejects a peer when the operating-system authorization hook denies it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codestead-control-peer-"));
    const socketPath = path.join(root, "control.sock");
    const adapter = host();
    const server = await startProductionLoadControlServer({
      socketPath, host: adapter, authorizePeer: () => false,
      recoverBeforeListen: async () => undefined,
    });
    closers.push(server.close);

    const response = await post(socketPath);
    expect(response.status).toBe(403);
    expect(response.body).toBe('{"schemaVersion":1,"ok":false,"error":{"code":"peer_not_authorized"}}');
    expect(adapter.handle).not.toHaveBeenCalled();
  });
});
