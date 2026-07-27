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
    expect(source).toContain("allocateDisposableLoopbackPort");
    expect(source).toContain(
      '"./lib/disposable-loopback-port.mjs"',
    );
    expect(source).toContain("buildDisposableIntegrationRuntimeEnvironment");
    expect(source).toContain("buildDisposableIntegrationChildLaunch");
    expect(source).toContain("createIntegrationOutputSanitizer");
    expect(source).toContain("createIntegrationFailureReporter");
    expect(source).toContain("taskHomeDirectory");
    expect(source).toContain("postgresMajor");
    expect(source).not.toContain("sanitizedIntegrationEnvironment");
    expect(source).not.toContain("server.listen(0");
    expect(source).not.toContain("options.env ?? process.env");
    expect(source).toContain(
      "detached: launch.detached",
    );
    expect(source).not.toContain("detached: true");
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
    expect(source).toContain('failureReporter.enter("migration-journal")');
    expect(source).toContain('failureReporter.enter("loopback-port")');
    expect(source).toContain(
      'failureReporter.enter("role-boundary-self-test")',
    );
    expect(source).toContain('failureReporter.enter("postgres-readiness")');
    expect(source).toContain("failureReporter.enter(phase)");
    expect(source).toContain('failureReporter.enter("application-tests")');
    expect(source).toContain('failureReporter.enter("harness-cleanup")');

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
    expect(source).toMatch(
      /main\(\)\.catch\(\(\) => \{\s*failureReporter\.report\(\);/u,
    );
    expect(source).not.toContain(
      'console.error("Disposable integration failed.");',
    );
    const terminal = source.slice(source.lastIndexOf("main().catch"));
    expect(terminal).not.toMatch(
      /error\.(?:message|stack|cause|code)|String\(error\)|JSON\.stringify\(error\)/u,
    );
    const secretInventory = source.slice(
      source.indexOf("const secrets = ["),
      source.indexOf("];", source.indexOf("const secrets = [")) + 2,
    );
    expect(secretInventory).toContain("roleCredentials.backupReporter");
    expect(secretInventory).toContain("roleUrls.backupReporter");
    expect(source).toMatch(
      /backupReporter:\s*loopback\(\s*"learncoding_backup_reporter",\s*credentials\.backupReporter,\s*\)/u,
    );
  });
});
