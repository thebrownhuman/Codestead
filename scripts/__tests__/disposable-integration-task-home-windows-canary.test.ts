import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createDisposableIntegrationTaskHome } from
  "../lib/disposable-integration-task-home";

describe("disposable integration task-home Windows ACL canary", () => {
  it.runIf(process.platform === "win32")(
    "uses the real token ACL for write access and exact cleanup",
    () => {
      let home: ReturnType<
        typeof createDisposableIntegrationTaskHome
      > | undefined;
      let homePath: string | undefined;
      try {
        home = createDisposableIntegrationTaskHome();
        homePath = home.path;
        const canaryPath = path.join(
          home.path,
          "tmp",
          "write-canary.txt",
        );
        writeFileSync(canaryPath, "canary", {
          encoding: "utf8",
          flag: "wx",
        });
        expect(existsSync(canaryPath)).toBe(true);
      } finally {
        home?.cleanup();
      }
      expect(homePath).toBeDefined();
      if (homePath !== undefined) {
        expect(existsSync(homePath)).toBe(false);
      }
    },
  );
});
