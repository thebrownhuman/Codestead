import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  processProductionLoadControlRequest,
  startProductionLoadControlServer,
  type ProductionLoadControlHost,
} from "./production-load-control-server";

function host(): ProductionLoadControlHost {
  return { handle: vi.fn(async (_operation, payload) => ({ echoed: payload })), close: vi.fn(async () => undefined) };
}

describe("production load control request boundary", () => {
  it("accepts only the exact versioned JSON protocol and returns the exact success envelope", async () => {
    const adapter = host();
    const response = await processProductionLoadControlRequest(adapter, {
      method: "POST", url: "/v1/load-control", contentType: "application/json",
      body: Buffer.from(JSON.stringify({ schemaVersion: 1, operation: "baseline", payload: {} })),
    });
    expect(response).toEqual({ statusCode: 200, body: { schemaVersion: 1, ok: true, result: { echoed: {} } } });
    expect(adapter.handle).toHaveBeenCalledWith("baseline", {});
  });

  it.each([
    [{ method: "GET", url: "/v1/load-control", contentType: "application/json" }, 405, "method_not_allowed"],
    [{ method: "POST", url: "/v1/load-control?x=1", contentType: "application/json" }, 404, "route_not_found"],
    [{ method: "POST", url: "/v1/load-control", contentType: "text/plain" }, 415, "unsupported_media_type"],
  ])("fails closed for a malformed request boundary", async (partial, statusCode, code) => {
    const adapter = host();
    const response = await processProductionLoadControlRequest(adapter, { ...partial, body: Buffer.from("{}") });
    expect(response).toEqual({ statusCode, body: { schemaVersion: 1, ok: false, error: { code } } });
    expect(adapter.handle).not.toHaveBeenCalled();
  });

  it.each([
    ["not-json", "invalid_json"],
    [JSON.stringify({ schemaVersion: 1, operation: "baseline" }), "invalid_envelope"],
    [JSON.stringify({ schemaVersion: 1, operation: "baseline", payload: {}, extra: true }), "invalid_envelope"],
    [JSON.stringify({ schemaVersion: 2, operation: "baseline", payload: {} }), "invalid_envelope"],
    [JSON.stringify({ schemaVersion: 1, operation: "shell", payload: {} }), "invalid_operation"],
  ])("rejects invalid input %s", async (body, code) => {
    const adapter = host();
    const response = await processProductionLoadControlRequest(adapter, { method: "POST", url: "/v1/load-control", contentType: "application/json; charset=utf-8", body: Buffer.from(body) });
    expect(response.body).toEqual({ schemaVersion: 1, ok: false, error: { code } });
    expect(adapter.handle).not.toHaveBeenCalled();
  });

  it("bounds requests before parsing or dispatch", async () => {
    const adapter = host();
    const response = await processProductionLoadControlRequest(adapter, { method: "POST", url: "/v1/load-control", contentType: "application/json", body: Buffer.alloc(1_048_577, 0x20) });
    expect(response.statusCode).toBe(413);
    expect(response.body).toEqual({ schemaVersion: 1, ok: false, error: { code: "request_too_large" } });
    expect(adapter.handle).not.toHaveBeenCalled();
  });

  it("projects all host failures to stable secret-free errors", async () => {
    const adapter: ProductionLoadControlHost = { handle: vi.fn(async () => { throw new Error("postgres://admin:password@db/session_token=secret"); }) };
    const response = await processProductionLoadControlRequest(adapter, { method: "POST", url: "/v1/load-control", contentType: "application/json", body: Buffer.from(JSON.stringify({ schemaVersion: 1, operation: "sample", payload: {} })) });
    expect(response.statusCode).toBe(503);
    expect(JSON.stringify(response.body)).toBe('{"schemaVersion":1,"ok":false,"error":{"code":"operation_failed"}}');
  });

  it("requires startup fault recovery before preparing or exposing the control socket", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codestead-load-recovery-"));
    const socketPath = path.join(root, "missing-parent", "control.sock");
    const adapter = host();

    await expect(startProductionLoadControlServer({
      socketPath,
      host: adapter,
    } as Parameters<typeof startProductionLoadControlServer>[0])).rejects.toThrow(/startup_recovery_required/);

    expect(adapter.close).toHaveBeenCalledOnce();
    await expect(readFile(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed without leaking recovery errors or touching the socket path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codestead-load-recovery-"));
    const socketPath = path.join(root, "missing-parent", "control.sock");
    const adapter = host();
    const recoverBeforeListen = vi.fn(async () => {
      throw new Error("reset credential=must-not-leak");
    });

    await expect(startProductionLoadControlServer({
      socketPath,
      host: adapter,
      recoverBeforeListen,
    } as Parameters<typeof startProductionLoadControlServer>[0])).rejects.toThrow(
      /^Production load control server failed: startup_recovery_failed$/,
    );

    expect(recoverBeforeListen).toHaveBeenCalledOnce();
    expect(adapter.close).toHaveBeenCalledOnce();
    expect(adapter.handle).not.toHaveBeenCalled();
    await expect(readFile(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe.skipIf(process.platform === "win32")("production load Unix socket lifecycle", () => {
  const servers: Array<Awaited<ReturnType<typeof startProductionLoadControlServer>>> = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

  it("creates a private socket and removes only its own socket on clean shutdown", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codestead-load-control-"));
    const socketPath = path.join(root, "control.sock");
    const server = await startProductionLoadControlServer({
      socketPath,
      host: host(),
      recoverBeforeListen: async () => undefined,
      socketMode: 0o660,
      maximumConcurrentRequests: 2,
    });
    servers.push(server);
    const before = await stat(socketPath);
    expect(before.isSocket()).toBe(true);
    expect(before.mode & 0o777).toBe(0o660);
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    await expect(readFile(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a pre-existing regular file instead of unlinking it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codestead-load-control-"));
    const socketPath = path.join(root, "control.sock");
    await writeFile(socketPath, "sentinel");
    await expect(startProductionLoadControlServer({
      socketPath,
      host: host(),
      recoverBeforeListen: async () => undefined,
    })).rejects.toThrow(/unsafe_existing_socket/);
    await expect(readFile(socketPath, "utf8")).resolves.toBe("sentinel");
  });
});
