import { chmod, mkdtemp } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createProductionLoadRequestDispatcher,
  startProductionLoadControlServer,
  type ProductionLoadControlHost,
  type ProductionLoadControlRequest,
} from "./production-load-control-server";

const REQUEST: ProductionLoadControlRequest = {
  method: "POST",
  url: "/v1/load-control",
  contentType: "application/json",
  body: Buffer.from('{"schemaVersion":1,"operation":"baseline","payload":{}}'),
};

const FAILED_OPERATION = {
  statusCode: 503,
  body: { schemaVersion: 1, ok: false, error: { code: "operation_failed" } },
};

describe("production load control cancellation", () => {
  it("forwards cancellation to the host and keeps the concurrency slot until the host settles", async () => {
    let release!: () => void;
    let observedSignal: AbortSignal | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const host: ProductionLoadControlHost = {
      async handle(_operation, _payload, signal) {
        observedSignal = signal;
        await blocked;
        return { ok: true };
      },
    };
    const dispatch = createProductionLoadRequestDispatcher(host, 1);
    const controller = new AbortController();

    const first = dispatch({ ...REQUEST, signal: controller.signal });
    await vi.waitFor(() => expect(observedSignal).toBe(controller.signal));
    controller.abort(new Error("postgresql://user:secret@db/private"));

    await expect(first).resolves.toEqual(FAILED_OPERATION);
    expect(observedSignal?.aborted).toBe(true);
    await expect(dispatch(REQUEST)).resolves.toEqual({
      statusCode: 503,
      body: { schemaVersion: 1, ok: false, error: { code: "server_busy" } },
    });

    release();
    await vi.waitFor(async () => {
      await expect(dispatch(REQUEST)).resolves.toMatchObject({ statusCode: 200 });
    });
  });

  it("does not dispatch a pre-cancelled request and redacts its abort reason", async () => {
    const host: ProductionLoadControlHost = {
      handle: vi.fn(async () => ({ ok: true })),
    };
    const dispatch = createProductionLoadRequestDispatcher(host, 1);
    const controller = new AbortController();
    controller.abort(new Error("credential=must-not-leak"));

    await expect(dispatch({ ...REQUEST, signal: controller.signal })).resolves.toEqual(
      FAILED_OPERATION,
    );
    expect(host.handle).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === "win32")("production load HTTP lifecycle cancellation", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  it("aborts an in-flight operation at the reviewed request deadline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codestead-control-timeout-"));
    await chmod(root, 0o700);
    const socketPath = path.join(root, "control.sock");
    let observedSignal: AbortSignal | undefined;
    const host: ProductionLoadControlHost = {
      handle: vi.fn(async (_operation, _payload, signal) => {
        observedSignal = signal;
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), {
          once: true,
        }));
        return { ok: true };
      }),
    };
    const server = await startProductionLoadControlServer({
      socketPath,
      host,
      recoverBeforeListen: async () => undefined,
      requestTimeoutMs: 1_000,
    });
    closers.push(server.close);

    const result = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const outgoing = request({
        socketPath,
        path: "/v1/load-control",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": REQUEST.body.length,
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({
          statusCode: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      outgoing.once("error", reject);
      outgoing.end(REQUEST.body);
    });

    expect(result).toEqual({ statusCode: 503, body: JSON.stringify(FAILED_OPERATION.body) });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("aborts host work when the client disconnects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codestead-control-disconnect-"));
    await chmod(root, 0o700);
    const socketPath = path.join(root, "control.sock");
    let observedSignal: AbortSignal | undefined;
    let started!: () => void;
    const hostStarted = new Promise<void>((resolve) => { started = resolve; });
    const host: ProductionLoadControlHost = {
      handle: vi.fn(async (_operation, _payload, signal) => {
        observedSignal = signal;
        started();
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), {
          once: true,
        }));
        return { ok: true };
      }),
    };
    const server = await startProductionLoadControlServer({
      socketPath,
      host,
      recoverBeforeListen: async () => undefined,
      requestTimeoutMs: 5_000,
    });
    closers.push(server.close);

    const outgoing = request({
      socketPath,
      path: "/v1/load-control",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": REQUEST.body.length,
      },
    });
    outgoing.on("error", () => undefined);
    outgoing.end(REQUEST.body);
    await hostStarted;
    outgoing.destroy();

    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
  });
});
