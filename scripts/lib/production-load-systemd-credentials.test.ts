import { describe, expect, it, vi } from "vitest";

import {
  readProductionLoadSystemdCredential,
  resolveProductionLoadCredentialPath,
  type ProductionLoadCredentialFileIdentity,
} from "./production-load-systemd-credentials";

const DIRECTORY = "/run/credentials/learncoding-production-load-control.service";

function file(override: Partial<ProductionLoadCredentialFileIdentity> = {}): ProductionLoadCredentialFileIdentity {
  return {
    kind: "file", uid: 0, gid: 0, mode: 0o400, linkCount: 1,
    size: 48, device: 10, inode: 20, modifiedAtMs: 30, changedAtMs: 40,
    ...override,
  };
}

describe("production load systemd credentials", () => {
  it.each([
    [undefined],
    ["relative/path"],
    ["/tmp/credentials/service"],
    ["/run/credentials"],
    ["/run/credentials/../escape"],
    ["/run/credentials/service\nnext"],
  ])("rejects an unsafe CREDENTIALS_DIRECTORY %s", (value) => {
    expect(() => resolveProductionLoadCredentialPath(
      { NODE_ENV: "test", CREDENTIALS_DIRECTORY: value },
      "database_url",
    )).toThrow(/^Production load systemd credential failed: invalid_credentials_directory$/);
  });

  it("reads only the exact named credential using a no-follow, identity-stable file operation", async () => {
    const bytes = Buffer.from("postgresql://app:password@postgres:5432/learncoding");
    const stable = file({ size: bytes.byteLength });
    const inspect = vi.fn(async () => stable);
    const read = vi.fn(async () => ({
      bytes,
      before: stable, after: stable,
    }));
    await expect(readProductionLoadSystemdCredential({
      environment: { NODE_ENV: "test", CREDENTIALS_DIRECTORY: DIRECTORY },
      name: "database_url",
      inspect,
      read,
    })).resolves.toBe("postgresql://app:password@postgres:5432/learncoding");
    expect(inspect).toHaveBeenCalledWith(`${DIRECTORY}/database_url`);
    expect(read).toHaveBeenCalledWith(`${DIRECTORY}/database_url`, 16 * 1024);
  });

  it.each([
    ["symlink", { kind: "symbolic-link" }],
    ["owner", { uid: 1000 }],
    ["group", { gid: 1000 }],
    ["mode", { mode: 0o440 }],
    ["links", { linkCount: 2 }],
    ["size", { size: 16 * 1024 + 1 }],
  ])("rejects an unsafe credential %s", async (_label, override) => {
    await expect(readProductionLoadSystemdCredential({
      environment: { NODE_ENV: "test", CREDENTIALS_DIRECTORY: DIRECTORY },
      name: "better_auth_secret",
      inspect: async () => file(override as Partial<ProductionLoadCredentialFileIdentity>),
      read: async () => ({ bytes: Buffer.from("x".repeat(48)), before: file(), after: file() }),
    })).rejects.toThrow(/^Production load systemd credential failed: unsafe_credential_file$/);
  });

  it("rejects a replacement race and control characters without exposing secret bytes", async () => {
    const bytes = Buffer.from("secret-that-must-not-appear\n");
    const stable = file({ size: bytes.byteLength });
    await expect(readProductionLoadSystemdCredential({
      environment: { NODE_ENV: "test", CREDENTIALS_DIRECTORY: DIRECTORY },
      name: "better_auth_secret",
      inspect: async () => stable,
      read: async () => ({
        bytes,
        before: stable, after: { ...stable, inode: 21 },
      }),
    })).rejects.toThrow(/^Production load systemd credential failed: credential_changed$/);
    await expect(readProductionLoadSystemdCredential({
      environment: { NODE_ENV: "test", CREDENTIALS_DIRECTORY: DIRECTORY },
      name: "better_auth_secret",
      inspect: async () => stable,
      read: async () => ({ bytes, before: stable, after: stable }),
    })).rejects.toThrow(/^Production load systemd credential failed: invalid_credential_bytes$/);
  });
});
