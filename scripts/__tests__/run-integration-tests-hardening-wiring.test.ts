import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    expect(source).toContain("withDisposableIntegrationReset");
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
    expect(source).toContain('failureReporter.enter("reset-capability-install")');
    expect(source).toContain('failureReporter.enter("application-tests")');
    expect(source).toContain('failureReporter.enter("reset-capability-teardown")');
    expect(source).toContain("(primaryState) => {");
    expect(source).toContain('if (primaryState.status === "fulfilled")');
    expect(source).not.toContain("primaryFailure === undefined");
    expect(source).not.toContain(
      '() => failureReporter.enter("reset-capability-teardown")',
    );
    expect(source).toContain('failureReporter.enter("harness-cleanup")');

    const releaseCyclesIndex = source.indexOf(
      "await runDisposableIntegrationReleaseCycles",
    );
    const resetLifecycleIndex = source.indexOf(
      "await withDisposableIntegrationReset",
    );
    const resetInstallPhaseIndex = source.indexOf(
      'failureReporter.enter("reset-capability-install")',
    );
    const applicationTestsIndex = source.indexOf(
      'failureReporter.enter("application-tests")',
    );
    const resetTeardownIndex = source.indexOf(
      'failureReporter.enter("reset-capability-teardown")',
    );
    expect(resetInstallPhaseIndex).toBeGreaterThan(releaseCyclesIndex);
    expect(resetLifecycleIndex).toBeGreaterThan(resetInstallPhaseIndex);
    expect(applicationTestsIndex).toBeGreaterThan(resetLifecycleIndex);
    expect(resetTeardownIndex).toBeGreaterThan(applicationTestsIndex);
    expect(source).toContain(`
    const resetInstallerPool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 5_000,
      max: 1,
      query_timeout: 30_000,
      statement_timeout: 30_000,
      lock_timeout: 5_000,
      idle_in_transaction_session_timeout: 30_000,
      allowExitOnIdle: true,
    });`);
    const resetPoolIndex = source.indexOf("const resetInstallerPool");
    expect(resetLifecycleIndex).toBeGreaterThan(resetPoolIndex);
    const resetLifecycleSource = await readFile(
      path.resolve(
        process.cwd(),
        "scripts/lib/disposable-integration-reset.ts",
      ),
      "utf8",
    );
    expect(resetLifecycleSource).toContain(
      "uninstallDisposableIntegrationReset,",
    );
    expect(resetLifecycleSource).toContain("client.release(true)");
    expect(resetLifecycleSource).not.toContain("Promise.race");
    expect(resetLifecycleSource).not.toContain("void closeOperation");
    expect(resetLifecycleSource).toContain("await pool.end()");
    expect(resetLifecycleSource).toContain(
      "DROP SCHEMA codestead_disposable_test RESTRICT",
    );
    expect(resetLifecycleSource).toContain("AS contract_absent");

    const resetIntegrationSource = await readFile(
      path.resolve(
        process.cwd(),
        "integration/disposable-integration-reset.integration.test.ts",
      ),
      "utf8",
    );
    expect(resetIntegrationSource).not.toContain("DATABASE_OWNER_URL");
    expect(resetIntegrationSource).not.toContain(
      "FROM drizzle.__drizzle_migrations",
    );
    expect(resetIntegrationSource).toContain(
      "readValidatedIntegrationMigrationJournal",
    );
    expect(resetIntegrationSource).toContain("fileURLToPath(import.meta.url)");
    expect(resetIntegrationSource).not.toContain("process.cwd()");
    expect(resetIntegrationSource).toContain("closePool(pool)");
    expect(resetIntegrationSource).toContain("pg_catalog.pg_stat_activity");
    expect(resetIntegrationSource).not.toMatch(/setTimeout\(resolve, 100\)/u);
    expect(resetIntegrationSource).toContain(
      "blocker.release(destroyBlocker)",
    );
    expect(resetIntegrationSource).toContain(
      '"reset concurrency proof and cleanup failed"',
    );

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

  it("keeps the reset journal proof anchored when cwd is unrelated", async () => {
    const originalCwd = process.cwd();
    const workspaceRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    try {
      process.chdir(path.parse(originalCwd).root);
      const source = await readFile(
        path.resolve(
          workspaceRoot,
          "integration/disposable-integration-reset.integration.test.ts",
        ),
        "utf8",
      );
      expect(source).toContain("fileURLToPath(import.meta.url)");
      expect(source).toContain("WORKSPACE_MIGRATIONS_FOLDER");
      expect(source).toContain("readValidatedIntegrationMigrationJournal");
      expect(source).not.toContain("process.cwd()");
    } finally {
      process.chdir(originalCwd);
    }
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
