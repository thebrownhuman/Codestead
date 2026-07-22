import { describe, expect, it } from "vitest";

import {
  createProductionLoadRequestDispatcher,
  validateProductionLoadSocketDirectory,
  validateProductionLoadStaleSocket,
  type ProductionLoadControlHost,
} from "./production-load-control-server";

const secureDirectory = {
  isDirectory: () => true,
  isSymbolicLink: () => false,
  isSocket: () => false,
  uid: 1000,
  gid: 1001,
  mode: 0o40750,
  nlink: 2,
};

const secureSocket = {
  isDirectory: () => false,
  isSymbolicLink: () => false,
  isSocket: () => true,
  uid: 1000,
  gid: 1001,
  mode: 0o140660,
  nlink: 1,
};

describe("production load control filesystem authorization", () => {
  it("accepts only a private, owned, non-symlink parent directory", () => {
    expect(() => validateProductionLoadSocketDirectory(
      secureDirectory, 1000, 1001,
    )).not.toThrow();
    for (const unsafe of [
      { ...secureDirectory, isDirectory: () => false },
      { ...secureDirectory, isSymbolicLink: () => true },
      { ...secureDirectory, uid: 2000 },
      { ...secureDirectory, gid: 2001 },
      { ...secureDirectory, mode: 0o40770 },
      { ...secureDirectory, nlink: 1 },
    ]) {
      expect(() => validateProductionLoadSocketDirectory(
        unsafe, 1000, 1001,
      )).toThrow(/unsafe_socket_parent/);
    }
  });

  it("removes only an owned single-link private stale socket", () => {
    expect(() => validateProductionLoadStaleSocket(
      secureSocket, 1000, 1001, 0o660,
    )).not.toThrow();
    for (const unsafe of [
      { ...secureSocket, isSocket: () => false },
      { ...secureSocket, isSymbolicLink: () => true },
      { ...secureSocket, uid: 2000 },
      { ...secureSocket, gid: 2001 },
      { ...secureSocket, mode: 0o140666 },
      { ...secureSocket, nlink: 2 },
    ]) {
      expect(() => validateProductionLoadStaleSocket(
        unsafe, 1000, 1001, 0o660,
      )).toThrow(/unsafe_existing_socket/);
    }
  });
});

describe("production load control bounded dispatcher", () => {
  it("returns deterministic backpressure without dispatching above the approved concurrency", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const host: ProductionLoadControlHost = {
      async handle() {
        await blocked;
        return { ok: true };
      },
    };
    const dispatch = createProductionLoadRequestDispatcher(host, 1);
    const request = {
      method: "POST", url: "/v1/load-control", contentType: "application/json",
      body: Buffer.from('{"schemaVersion":1,"operation":"baseline","payload":{}}'),
    };

    const first = dispatch(request);
    await Promise.resolve();
    await expect(dispatch(request)).resolves.toEqual({
      statusCode: 503,
      body: { schemaVersion: 1, ok: false, error: { code: "server_busy" } },
    });
    release();
    await expect(first).resolves.toMatchObject({ statusCode: 200 });
  });
});
