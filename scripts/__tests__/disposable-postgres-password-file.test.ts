/* eslint-disable @next/next/no-assign-module-variable */

import path from "node:path";
import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

const TEMPORARY_ROOT = path.resolve("task-temp");

type PasswordFileOperations = Readonly<{
  makeTemporaryDirectory: (prefix: string) => string;
  writeExclusiveFile: (
    filePath: string,
    content: string,
    mode: number,
  ) => void;
  setFileMode: (filePath: string, mode: number) => void;
  readFileMode: (filePath: string) => number;
  isFile: (filePath: string) => boolean;
  pathExists: (filePath: string) => boolean;
  removeFile: (filePath: string) => void;
  removeDirectory: (directoryPath: string) => void;
  secureWindowsPath: (
    targetPath: string,
    kind: "directory" | "file",
  ) => void;
}>;

type PasswordFileHandle = Readonly<{
  hostPath: string;
  containerPath: string;
  cleanup: () => void;
}>;

type PasswordFileModule = Readonly<{
  createDisposablePostgresPasswordFile?: (input: Readonly<{
    password: string;
    temporaryRoot: string;
    platform: NodeJS.Platform;
    operations: PasswordFileOperations;
  }>) => PasswordFileHandle;
}>;

async function loadPasswordFileModule(): Promise<PasswordFileModule | null> {
  const modulePath = "../lib/disposable-postgres-password-file";
  try {
    return await import(/* @vite-ignore */ modulePath) as PasswordFileModule;
  } catch {
    return null;
  }
}

function createFakeFileSystem(input: Readonly<{
  reportedFileMode?: number;
  retainFileOnRemove?: boolean;
}> = {}) {
  const directory = path.join(
    TEMPORARY_ROOT,
    "codestead-postgres-it-run123",
  );
  const existing = new Set<string>();
  const files = new Set<string>();
  const writes: Array<Readonly<{
    path: string;
    content: string;
    mode: number;
  }>> = [];
  const modes: Array<Readonly<{ path: string; mode: number }>> = [];
  const secured: Array<Readonly<{
    path: string;
    kind: "directory" | "file";
  }>> = [];
  const removals: string[] = [];

  const operations: PasswordFileOperations = {
    makeTemporaryDirectory: () => {
      existing.add(directory);
      return directory;
    },
    writeExclusiveFile: (filePath, content, mode) => {
      if (existing.has(filePath)) throw new Error("exclusive create failed");
      existing.add(filePath);
      files.add(filePath);
      writes.push({ path: filePath, content, mode });
    },
    setFileMode: (filePath, mode) => {
      modes.push({ path: filePath, mode });
    },
    readFileMode: () => input.reportedFileMode ?? 0o600,
    isFile: (filePath) => files.has(filePath),
    pathExists: (filePath) => existing.has(filePath),
    removeFile: (filePath) => {
      removals.push(filePath);
      if (!input.retainFileOnRemove) {
        existing.delete(filePath);
        files.delete(filePath);
      }
    },
    removeDirectory: (directoryPath) => {
      removals.push(directoryPath);
      if (
        ![...existing].some((entry) =>
          entry !== directoryPath && path.dirname(entry) === directoryPath
        )
      ) {
        existing.delete(directoryPath);
      }
    },
    secureWindowsPath: (targetPath, kind) => {
      secured.push({ path: targetPath, kind });
    },
  };

  return {
    directory,
    existing,
    modes,
    operations,
    removals,
    secured,
    writes,
  };
}

describe("disposable PostgreSQL password file", () => {
  it("creates an exclusive 0600 file and verifies exact cleanup", async () => {
    const module = await loadPasswordFileModule();
    expect(module).not.toBeNull();
    if (!module) return;
    expect(typeof module.createDisposablePostgresPasswordFile).toBe("function");
    if (!module.createDisposablePostgresPasswordFile) return;

    const password = "password-file-content-canary";
    const fake = createFakeFileSystem();
    const handle = module.createDisposablePostgresPasswordFile({
      password,
      temporaryRoot: TEMPORARY_ROOT,
      platform: "linux",
      operations: fake.operations,
    });
    const expectedFile = path.join(fake.directory, "postgres-password");

    expect(handle).toEqual({
      hostPath: expectedFile,
      containerPath: "/run/secrets/postgres-password",
      cleanup: expect.any(Function),
    });
    expect(fake.writes).toEqual([{
      path: expectedFile,
      content: password,
      mode: 0o600,
    }]);
    expect(fake.modes).toEqual([{ path: expectedFile, mode: 0o600 }]);
    expect(fake.secured).toEqual([]);

    handle.cleanup();

    expect(fake.removals).toEqual([expectedFile, fake.directory]);
    expect(fake.existing.size).toBe(0);
  });

  it("uses a private Windows ACL when POSIX mode bits are not representable", async () => {
    const module = await loadPasswordFileModule();
    expect(module).not.toBeNull();
    if (!module) return;
    expect(typeof module.createDisposablePostgresPasswordFile).toBe("function");
    if (!module.createDisposablePostgresPasswordFile) return;

    const fake = createFakeFileSystem({ reportedFileMode: 0o666 });
    const handle = module.createDisposablePostgresPasswordFile({
      password: "windows-password-file-canary",
      temporaryRoot: TEMPORARY_ROOT,
      platform: "win32",
      operations: fake.operations,
    });
    const expectedFile = path.join(fake.directory, "postgres-password");

    expect(fake.secured).toEqual([
      { path: fake.directory, kind: "directory" },
      { path: expectedFile, kind: "file" },
    ]);
    handle.cleanup();
  });

  it("fails closed and removes partial state when POSIX mode is not exactly 0600", async () => {
    const module = await loadPasswordFileModule();
    expect(module).not.toBeNull();
    if (!module) return;
    expect(typeof module.createDisposablePostgresPasswordFile).toBe("function");
    if (!module.createDisposablePostgresPasswordFile) return;

    const password = "mode-failure-password-canary";
    const fake = createFakeFileSystem({ reportedFileMode: 0o640 });
    let failure: unknown;
    try {
      module.createDisposablePostgresPasswordFile({
        password,
        temporaryRoot: TEMPORARY_ROOT,
        platform: "linux",
        operations: fake.operations,
      });
    } catch (error) {
      failure = error;
    }

    const rendered = [
      String(failure),
      inspect(failure),
      JSON.stringify(failure),
    ].join("\n");
    expect(rendered).toContain("password_file_mode_invalid");
    expect(rendered).not.toContain(password);
    expect(fake.existing.size).toBe(0);
  });

  it("fails when exact file deletion cannot be verified without exposing path or content", async () => {
    const module = await loadPasswordFileModule();
    expect(module).not.toBeNull();
    if (!module) return;
    expect(typeof module.createDisposablePostgresPasswordFile).toBe("function");
    if (!module.createDisposablePostgresPasswordFile) return;

    const password = "cleanup-password-content-canary";
    const fake = createFakeFileSystem({ retainFileOnRemove: true });
    const handle = module.createDisposablePostgresPasswordFile({
      password,
      temporaryRoot: TEMPORARY_ROOT,
      platform: "linux",
      operations: fake.operations,
    });

    let failure: unknown;
    try {
      handle.cleanup();
    } catch (error) {
      failure = error;
    }

    const rendered = [
      String(failure),
      inspect(failure),
      JSON.stringify(failure),
      JSON.stringify(Object.entries(failure as object)),
    ].join("\n");
    expect(rendered).toContain("password_file_still_present");
    expect(rendered).not.toContain(password);
    expect(rendered).not.toContain(handle.hostPath);
    expect(failure).not.toHaveProperty("cause");
    expect(failure).not.toHaveProperty("errors");
  });
});
