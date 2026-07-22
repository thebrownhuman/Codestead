import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createProductionLoadSocketTransport,
  productionLoadSocketRequester,
  type ProductionLoadSocketRequester,
} from "./production-load-socket";

describe("production load Unix-socket transport", () => {
  it("sends a versioned bounded request to the dedicated socket and returns only result", async () => {
    const requester = vi.fn<ProductionLoadSocketRequester>(async () => ({
      statusCode: 200,
      contentType: "application/json",
      body: { schemaVersion: 1, ok: true, result: { ok: true } },
    }));
    const socketPath = path.resolve("test-results", "load-control.sock");
    const transport = createProductionLoadSocketTransport({
      socketPath,
      requester,
      verifySocket: vi.fn(async () => undefined),
    });

    await expect(transport.request("fault_reset", {
      faultId: "runner_service_restart",
    })).resolves.toEqual({ ok: true });

    expect(requester).toHaveBeenCalledWith(expect.objectContaining({
      socketPath,
      requestPath: "/v1/load-control",
      timeoutMs: 30_000,
      maxResponseBytes: 1_048_576,
      body: JSON.stringify({
        schemaVersion: 1,
        operation: "fault_reset",
        payload: { faultId: "runner_service_restart" },
      }),
    }));
  });

  it("uses bounded operation-specific timeouts", async () => {
    const requester = vi.fn<ProductionLoadSocketRequester>(async () => ({
      statusCode: 200,
      contentType: "application/json; charset=utf-8",
      body: { schemaVersion: 1, ok: true, result: { ok: true } },
    }));
    const transport = createProductionLoadSocketTransport({
      socketPath: path.resolve("test-results", "load-control.sock"),
      requester,
      verifySocket: vi.fn(async () => undefined),
    });

    await transport.request("sample", {});
    await transport.request("runner_observation", {
      requestId: "3a58772a-5e5e-4aca-a62e-13fe0c5baff3",
    });
    await transport.request("seed", {});
    await transport.request("fault_inject_release", {});
    await transport.request("browser_journey", {});

    expect(requester.mock.calls.map(([input]) => input.timeoutMs)).toEqual([
      4_000,
      4_000,
      120_000,
      70_000,
      120_000,
    ]);
  });

  it.each([
    {
      statusCode: 500,
      contentType: "application/json",
      body: { schemaVersion: 1, ok: false, error: "Bearer do-not-echo" },
    },
    {
      statusCode: 200,
      contentType: "text/plain",
      body: { schemaVersion: 1, ok: true, result: {} },
    },
    {
      statusCode: 200,
      contentType: "application/json",
      body: { schemaVersion: 2, ok: true, result: {} },
    },
    {
      statusCode: 200,
      contentType: "application/json",
      body: { schemaVersion: 1, ok: true, result: {}, extra: true },
    },
  ])("fails closed without echoing malformed control response %#", async (response) => {
    const requester: ProductionLoadSocketRequester = vi.fn(async () => response);
    const transport = createProductionLoadSocketTransport({
      socketPath: path.resolve("test-results", "load-control.sock"),
      requester,
      verifySocket: vi.fn(async () => undefined),
    });

    let message = "";
    try {
      await transport.request("sample", {});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Production load socket failed: invalid_response");
    expect(message).not.toContain("Bearer do-not-echo");
  });

  it("rejects relative, newline-bearing, or unverified socket paths before any request", async () => {
    const requester = vi.fn<ProductionLoadSocketRequester>();
    expect(() => createProductionLoadSocketTransport({
      socketPath: "relative.sock",
      requester,
      verifySocket: vi.fn(async () => undefined),
    })).toThrow("Production load socket failed: invalid_socket_path");

    expect(() => createProductionLoadSocketTransport({
      socketPath: path.resolve("test-results", "bad\nload.sock"),
      requester,
      verifySocket: vi.fn(async () => undefined),
    })).toThrow("Production load socket failed: invalid_socket_path");

    const transport = createProductionLoadSocketTransport({
      socketPath: path.resolve("test-results", "load-control.sock"),
      requester,
      verifySocket: vi.fn(async () => {
        throw new Error("unsafe");
      }),
    });
    await expect(transport.request("sample", {})).rejects.toThrow(
      "Production load socket failed: unsafe_socket",
    );
    expect(requester).not.toHaveBeenCalled();
  });

  it("removes the shared abort listener after every settled socket request", async () => {
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\codestead-load-${randomUUID()}`
      : path.join(os.tmpdir(), `codestead-load-${randomUUID()}.sock`);
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schemaVersion: 1,
        ok: true,
        result: { ok: true },
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    const signal = new AbortController().signal;
    const add = vi.spyOn(signal, "addEventListener");
    const remove = vi.spyOn(signal, "removeEventListener");

    try {
      for (let index = 0; index < 25; index += 1) {
        await productionLoadSocketRequester({
          socketPath,
          requestPath: "/v1/load-control",
          body: JSON.stringify({ schemaVersion: 1, operation: "sample", payload: {} }),
          timeoutMs: 1_000,
          maxResponseBytes: 1_048_576,
          signal,
        });
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") await rm(socketPath, { force: true });
    }

    expect(add).toHaveBeenCalledTimes(25);
    expect(remove).toHaveBeenCalledTimes(25);
  });
});
