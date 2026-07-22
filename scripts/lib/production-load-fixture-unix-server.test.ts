import { describe, expect, it } from "vitest";

import {
  validateProductionLoadFixtureRuntimeSocket,
  validateProductionLoadFixtureRuntimeSocketParent,
  type ProductionLoadFixtureRuntimeSocketStat,
} from "./production-load-fixture-server";

function stat(options: {
  uid?: number;
  gid?: number;
  mode?: number;
  nlink?: number;
  directory?: boolean;
  socket?: boolean;
  symlink?: boolean;
} = {}): ProductionLoadFixtureRuntimeSocketStat {
  return {
    uid: options.uid ?? 65_532,
    gid: options.gid ?? 65_532,
    mode: options.mode ?? 0o140600,
    nlink: options.nlink ?? 1,
    dev: 7,
    ino: 11,
    isDirectory: () => options.directory ?? false,
    isSocket: () => options.socket ?? true,
    isSymbolicLink: () => options.symlink ?? false,
  };
}

describe("production load fixture runtime Unix boundary", () => {
  it("accepts only the dedicated non-root private parent and socket identities", () => {
    expect(() => validateProductionLoadFixtureRuntimeSocketParent(stat({
      directory: true, socket: false, mode: 0o40700, nlink: 2,
    }))).not.toThrow();
    expect(() => validateProductionLoadFixtureRuntimeSocket(stat())).not.toThrow();
  });

  it.each([
    ["root owner", stat({ uid: 0, gid: 0 })],
    ["other owner", stat({ uid: 1_000, gid: 1_000 })],
    ["group access", stat({ mode: 0o140660 })],
    ["hard link", stat({ nlink: 2 })],
    ["symlink", stat({ symlink: true })],
    ["regular file", stat({ socket: false })],
  ])("rejects unsafe runtime socket: %s", (_label, value) => {
    expect(() => validateProductionLoadFixtureRuntimeSocket(value)).toThrow(
      "unsafe_runtime_socket",
    );
  });

  it.each([
    ["root owner", stat({ directory: true, socket: false, uid: 0, gid: 0, mode: 0o40700 })],
    ["group access", stat({ directory: true, socket: false, mode: 0o40750 })],
    ["symlink", stat({ directory: true, socket: false, mode: 0o40700, symlink: true })],
    ["not directory", stat({ directory: false, socket: true, mode: 0o140600 })],
  ])("rejects unsafe runtime parent: %s", (_label, value) => {
    expect(() => validateProductionLoadFixtureRuntimeSocketParent(value)).toThrow(
      "unsafe_runtime_socket_parent",
    );
  });
});
