import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("integration runner hardening wiring", () => {
  it("uses the owned harness, fresh runtime environment, and chunk sanitizer", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "scripts/run-integration-tests.ts"),
      "utf8",
    );

    expect(source).toContain("runWithDisposableIntegrationHarness");
    expect(source).toContain("buildDisposableIntegrationRuntimeEnvironment");
    expect(source).toContain("buildDisposableIntegrationChildLaunch");
    expect(source).toContain("createIntegrationOutputSanitizer");
    expect(source).toContain("taskHomeDirectory");
    expect(source).toContain("postgresMajor");
    expect(source).not.toContain("sanitizedIntegrationEnvironment");
    expect(source).not.toContain("options.env ?? process.env");
    expect(source).toContain(
      "detached: true",
    );
    expect(source).toContain("windowsHide: true");
    expect(source).toContain(
      "options.childController.spawnAndTrack(() => spawn",
    );
    expect(source).toContain(
      'child.once("close", (code, signal) =>',
    );
    expect(source).toContain(
      "await completeAndWait(childSignal)",
    );
    expect(source).not.toContain("Signal cleanup reports");

    const harnessIndex = source.indexOf(
      "await runWithDisposableIntegrationHarness",
    );
    const harnessCallbackIndex = source.indexOf(
      "async ({ taskHomeDirectory, postgresMajor })",
      harnessIndex,
    );
    const roleBoundaryIndex = source.indexOf(
      "scripts/database-role-boundaries.test.mjs",
    );
    expect(roleBoundaryIndex).toBeGreaterThan(harnessCallbackIndex);
  });

  it("has no direct password environment or name-targeted Docker cleanup path", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "scripts/run-integration-tests.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/POSTGRES_PASSWORD["'`)]/u);
    expect(source).not.toMatch(/spawnSync\(docker/u);
    expect(source).not.toMatch(/docker,\s*\[\s*"rm"/u);
    expect(source).not.toContain("dockerCheck.stderr");
    expect(source).toContain(
      'console.error("Disposable integration failed.");',
    );
  });
});
