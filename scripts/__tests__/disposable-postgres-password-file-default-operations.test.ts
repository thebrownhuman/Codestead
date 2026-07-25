import {
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createDisposablePostgresPasswordFile } from
  "../lib/disposable-postgres-password-file";

describe("disposable PostgreSQL password file default operations", () => {
  it("removes the exact empty password directory after removing its file", () => {
    const temporaryRoot = mkdtempSync(path.join(
      tmpdir(),
      "codestead-password-file-default-test-",
    ));
    try {
      const handle = createDisposablePostgresPasswordFile({
        password: "non-secret-cleanup-canary",
        temporaryRoot,
      });
      const passwordDirectory = path.dirname(handle.hostPath);

      handle.cleanup();

      expect(existsSync(handle.hostPath)).toBe(false);
      expect(existsSync(passwordDirectory)).toBe(false);
    } finally {
      rmSync(temporaryRoot, {
        force: true,
        recursive: true,
        maxRetries: 0,
      });
    }
  });
});
