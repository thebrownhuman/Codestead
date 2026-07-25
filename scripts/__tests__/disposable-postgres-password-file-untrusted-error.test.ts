import path from "node:path";
import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { createDisposablePostgresPasswordFile } from
  "../lib/disposable-postgres-password-file";
import type { DisposablePasswordFileOperations } from
  "../lib/disposable-postgres-password-file";

describe("disposable PostgreSQL password file error boundary", () => {
  it("maps an untrusted secret-bearing operation code to a fixed safe code", () => {
    const temporaryRoot = path.resolve("task-temp");
    const directory = path.join(
      temporaryRoot, "codestead-postgres-it-run123",
    );
    const rawCode = "raw-secret-code C:\\credential\\path-canary";
    const existing = new Set([directory]);
    const operations: DisposablePasswordFileOperations = {
      makeTemporaryDirectory: () => directory,
      writeExclusiveFile: () => {
        const untrustedError = new Error("raw-password-file-operation-canary");
        Object.assign(untrustedError, { code: rawCode });
        throw untrustedError;
      },
      setFileMode: () => undefined,
      readFileMode: () => 0o600,
      isFile: () => false,
      pathExists: (targetPath) => existing.has(targetPath),
      removeFile: (targetPath) => {
        existing.delete(targetPath);
      },
      removeDirectory: (targetPath) => {
        existing.delete(targetPath);
      },
      secureWindowsPath: () => undefined,
    };

    let failure: unknown;
    try {
      createDisposablePostgresPasswordFile({
        password: "raw-operation-password-canary",
        temporaryRoot,
        platform: "linux",
        operations,
      });
    } catch (error) {
      failure = error;
    }

    const rendered = [
      String(failure),
      inspect(failure),
      JSON.stringify(failure),
      JSON.stringify(Object.entries(failure as object)),
    ].join("\n");
    expect(rendered).toContain("password_file_create_failed");
    expect(rendered).not.toContain(rawCode);
    expect(rendered).not.toContain("raw-password-file-operation-canary");
    expect(rendered).not.toContain("raw-operation-password-canary");
    expect(failure).not.toHaveProperty("cause");
    expect(failure).not.toHaveProperty("errors");
  });
});
