import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createDisposablePostgresPasswordFile } from
  "../lib/disposable-postgres-password-file";

describe("disposable PostgreSQL password-file Windows ACL canary", () => {
  it.runIf(process.platform === "win32")(
    "uses the real token ACL for read, write, delete, and exact cleanup",
    () => {
      let handle: ReturnType<
        typeof createDisposablePostgresPasswordFile
      > | undefined;
      let directoryPath: string | undefined;
      const initialCanary = "local-password-canary";
      const updatedCanary = "rotated-password-canary";
      try {
        handle = createDisposablePostgresPasswordFile({
          password: initialCanary,
        });
        directoryPath = path.dirname(handle.hostPath);
        expect(readFileSync(handle.hostPath, "utf8")).toBe(initialCanary);
        writeFileSync(handle.hostPath, updatedCanary, {
          encoding: "utf8",
        });
        expect(readFileSync(handle.hostPath, "utf8")).toBe(updatedCanary);
      } finally {
        handle?.cleanup();
      }
      expect(handle).toBeDefined();
      if (handle !== undefined) {
        expect(existsSync(handle.hostPath)).toBe(false);
      }
      expect(directoryPath).toBeDefined();
      if (directoryPath !== undefined) {
        expect(existsSync(directoryPath)).toBe(false);
      }
    },
  );
});
