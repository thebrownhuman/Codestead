import { describe, expect, it, vi } from "vitest";

import {
  assertProductionLoadPostgresSocketIdentity,
  assertProductionLoadPostgresSocketUnchanged,
  PRODUCTION_LOAD_POSTGRES_SOCKET_PATH,
  type ProductionLoadPostgresPathIdentity,
} from "./production-load-postgres-socket";

const identity = (
  kind: ProductionLoadPostgresPathIdentity["kind"],
  uid: number,
  gid: number,
  mode: number,
  linkCount: number,
  device = 1,
  inode = 2,
): ProductionLoadPostgresPathIdentity => ({
  kind,
  uid,
  gid,
  mode,
  linkCount,
  device,
  inode,
});

const valid = new Map<string, ProductionLoadPostgresPathIdentity>([
  ["/run", identity("directory", 0, 0, 0o755, 20)],
  ["/run/learncoding-postgres", identity("directory", 999, 999, 0o700, 2)],
  [PRODUCTION_LOAD_POSTGRES_SOCKET_PATH, identity("socket", 999, 999, 0o700, 1, 7, 11)],
]);

describe("production load PostgreSQL socket identity", () => {
  it("accepts only the fixed root/PostgreSQL-owned path and returns its stable identity", async () => {
    const inspect = vi.fn(async (target: string) => valid.get(target)!);
    await expect(assertProductionLoadPostgresSocketIdentity({
      platform: "linux",
      inspect,
    })).resolves.toEqual({ device: 7, inode: 11 });
    expect(inspect.mock.calls.map(([target]) => target)).toEqual([
      "/run",
      "/run/learncoding-postgres",
      PRODUCTION_LOAD_POSTGRES_SOCKET_PATH,
    ]);
  });

  it("accepts the same validated socket identity after database use", () => {
    expect(() => assertProductionLoadPostgresSocketUnchanged(
      { device: 7, inode: 11 },
      { device: 7, inode: 11 },
    )).not.toThrow();
  });

  it.each([
    ["device changed", { device: 8, inode: 11 }],
    ["inode changed", { device: 7, inode: 12 }],
    ["invalid identity", { device: 0, inode: 0 }],
  ])("rejects a socket whose %s", (_label, after) => {
    expect(() => assertProductionLoadPostgresSocketUnchanged(
      { device: 7, inode: 11 },
      after,
    )).toThrow("Production load PostgreSQL socket failed: socket_identity_changed");
  });

  it.each([
    ["run symlink", "/run", identity("symbolic-link", 0, 0, 0o777, 1)],
    ["run writable", "/run", identity("directory", 0, 0, 0o777, 20)],
    ["directory wrong owner", "/run/learncoding-postgres", identity("directory", 0, 0, 0o700, 2)],
    ["directory group-readable", "/run/learncoding-postgres", identity("directory", 999, 999, 0o750, 2)],
    ["socket symlink", PRODUCTION_LOAD_POSTGRES_SOCKET_PATH, identity("symbolic-link", 999, 999, 0o700, 1)],
    ["socket wrong owner", PRODUCTION_LOAD_POSTGRES_SOCKET_PATH, identity("socket", 0, 0, 0o700, 1)],
    ["socket permissive", PRODUCTION_LOAD_POSTGRES_SOCKET_PATH, identity("socket", 999, 999, 0o770, 1)],
    ["socket hard-linked", PRODUCTION_LOAD_POSTGRES_SOCKET_PATH, identity("socket", 999, 999, 0o700, 2)],
    ["socket invalid inode", PRODUCTION_LOAD_POSTGRES_SOCKET_PATH, identity("socket", 999, 999, 0o700, 1, 0, 0)],
  ])("fails closed for %s", async (_label, target, replacement) => {
    await expect(assertProductionLoadPostgresSocketIdentity({
      platform: "linux",
      inspect: async (candidate) => candidate === target ? replacement : valid.get(candidate)!,
    })).rejects.toThrow("Production load PostgreSQL socket failed: unsafe_socket_identity");
  });

  it("fails closed off Linux and projects inspection errors", async () => {
    await expect(assertProductionLoadPostgresSocketIdentity({
      platform: "win32",
      inspect: async () => valid.get("/run")!,
    })).rejects.toThrow(/linux_only/);
    await expect(assertProductionLoadPostgresSocketIdentity({
      platform: "linux",
      inspect: async () => { throw new Error("secret path"); },
    })).rejects.toThrow(/unsafe_socket_identity/);
  });
});
