import path from "node:path";
import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { DisposableIntegrationLifecycleError } from
  "../lib/disposable-integration-error";
import {
  createDisposablePostgresPasswordFile,
  type DisposablePasswordFileOperations,
} from "../lib/disposable-postgres-password-file";

describe("password-file lifecycle-shaped error boundary", () => {
  it("does not trust an exported lifecycle error carrying a malicious code", () => {
    const root = path.resolve("task-temp");
    const directory = path.join(root, "codestead-postgres-it-unit123");
    const rawCode = "raw-lifecycle-code C:\\credential\\path-canary";
    const existing = new Set([directory]);
    const operations: DisposablePasswordFileOperations = {
      makeTemporaryDirectory: () => directory,
      writeExclusiveFile: () => {
        throw new DisposableIntegrationLifecycleError(rawCode);
      },
      setFileMode: () => undefined,
      readFileMode: () => 0o600,
      isFile: () => false,
      pathExists: (candidate) => existing.has(candidate),
      removeFile: (candidate) => existing.delete(candidate),
      removeDirectory: (candidate) => existing.delete(candidate),
      secureWindowsPath: () => undefined,
    };

    let failure: unknown;
    try {
      createDisposablePostgresPasswordFile({
        password: "password-content-canary",
        temporaryRoot: root,
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
    expect(rendered).not.toContain("password-content-canary");
    expect(failure).not.toHaveProperty("cause");
    expect(failure).not.toHaveProperty("errors");
  });
});
