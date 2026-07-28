import { readFile } from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

describe("authenticated learn runtime database wiring", () => {
  let source = "";

  beforeAll(async () => {
    source = await readFile(
      path.resolve(
        process.cwd(),
        "scripts/verify-authenticated-learn-runtime.ts",
      ),
      "utf8",
    );
  });

  it("orders reviewed bootstrap, owner-assuming migration, reconciliation, and boundary verification", () => {
    expect(source).toContain("runDatabaseRoleBootstrap");
    expect(source).toContain("runProductionMigration");
    expect(source).toContain("verifyDisposableRoleBoundaryAdapter");
    expect(source).toContain("verifyDatabaseRoleBoundaries");
    expect(source).not.toContain('"db:migrate"');

    const orchestration = source.slice(
      source.indexOf("containerStarted = true;"),
      source.indexOf("Object.assign(process.env,"),
    );
    expect(
      orchestration.match(
        /await reconcileAuthenticatedLearnDatabaseRoles\(/gu,
      ) ?? [],
    ).toHaveLength(2);
    expect(
      orchestration.match(
        /await runAuthenticatedLearnProductionMigration\(/gu,
      ) ?? [],
    ).toHaveLength(1);
    expect(
      orchestration.match(
        /await verifyAuthenticatedLearnDatabaseRoleBoundaries\(/gu,
      ) ?? [],
    ).toHaveLength(1);
    expect(orchestration).toMatch(
      /await waitForPostgres\(roleUrls\.bootstrap\);[\s\S]*?await reconcileAuthenticatedLearnDatabaseRoles\(\{\s*roleUrls,\s*requireCompleteMigrationLedger:\s*false,\s*\}\);[\s\S]*?await runAuthenticatedLearnProductionMigration\(roleUrls\);[\s\S]*?await reconcileAuthenticatedLearnDatabaseRoles\(\{\s*roleUrls,\s*requireCompleteMigrationLedger:\s*true,\s*\}\);[\s\S]*?await verifyAuthenticatedLearnDatabaseRoleBoundaries\(roleUrls\);/u,
    );

    const firstBootstrap = source.indexOf(
      "await reconcileAuthenticatedLearnDatabaseRoles(",
    );
    const migration = source.indexOf(
      "await runAuthenticatedLearnProductionMigration(",
      firstBootstrap + 1,
    );
    const secondBootstrap = source.indexOf(
      "await reconcileAuthenticatedLearnDatabaseRoles(",
      migration + 1,
    );
    const boundary = source.indexOf(
      "await verifyAuthenticatedLearnDatabaseRoleBoundaries(",
      secondBootstrap + 1,
    );

    expect(firstBootstrap).toBeGreaterThanOrEqual(0);
    expect(migration).toBeGreaterThan(firstBootstrap);
    expect(secondBootstrap).toBeGreaterThan(migration);
    expect(boundary).toBeGreaterThan(secondBootstrap);
    expect(source).toMatch(
      /runProductionMigration\(\{\s*connectionString:\s*roleUrls\.migrator,[\s\S]*?requiredPostgresMajor:\s*17,/u,
    );
    expect(source).toMatch(
      /verifyDisposableRoleBoundaryAdapter\(\{[\s\S]*?requireApplicationObjects:\s*true,/u,
    );
  });

  it("uses six distinct secrets, all five restricted URLs, and only the app URL at runtime", () => {
    for (const credential of [
      "bootstrap",
      "app",
      "migrator",
      "worker",
      "ops",
      "backupReporter",
    ]) {
      expect(source).toMatch(
        new RegExp(
          `${credential}:\\s*generatedDatabasePassword\\(\\)`,
          "u",
        ),
      );
    }
    expect(
      source.match(/:\s*generatedDatabasePassword\(\),/gu) ?? [],
    ).toHaveLength(6);
    for (const [credential, role] of Object.entries({
      bootstrap: "learncoding_ui",
      app: "learncoding_app",
      migrator: "learncoding_migrator",
      worker: "learncoding_worker",
      ops: "learncoding_ops",
      backupReporter: "learncoding_backup_reporter",
    })) {
      expect(source).toMatch(
        new RegExp(
          `${credential}:\\s*loopback\\(\\s*"${role}",\\s*credentials\\.${credential},?\\s*\\)`,
          "u",
        ),
      );
    }
    for (const role of [
      "learncoding_app",
      "learncoding_migrator",
      "learncoding_worker",
      "learncoding_ops",
      "learncoding_backup_reporter",
    ]) {
      expect(source).toContain(role);
    }
    expect(source).toContain("assertDistinctDatabaseCredentials");
    const databaseUrlSinks = [...source.matchAll(
      /DATABASE_URL:\s*([^,\r\n]+),/gu,
    )].map((match) => match[1]?.trim());
    expect(databaseUrlSinks).toEqual(["roleUrls.app", "roleUrls.app"]);
    expect(source).toContain("runtimeSensitiveValues = sensitiveValues");
    expect(source).toMatch(
      /const unsafeMessage = error instanceof Error[\s\S]*?const message = redactSensitiveText\(\s*unsafeMessage,\s*runtimeSensitiveValues,\s*\);/u,
    );
  });

  it("isolates ambient secrets and cleans every spawned child", () => {
    expect(source).toContain("minimalNodeTestEnvironment");
    const commandEnvironmentSource = source.slice(
      source.indexOf("function commandEnvironment("),
      source.indexOf("function generatedDatabasePassword("),
    );
    expect(commandEnvironmentSource).toContain(
      "minimalNodeTestEnvironment(process.env)",
    );
    expect(commandEnvironmentSource).not.toMatch(
      /HOME|USERPROFILE|LOCALAPPDATA|APPDATA/u,
    );
    expect(source).toMatch(
      /launchPersistentServer\.call\([\s\S]*?env:\s*commandEnvironment\(\),/u,
    );
    expect(source).toContain(
      "const commandChildren = new Set<ChildProcess>();",
    );
    expect(source).toContain("commandChildren.add(child);");
    expect(source).toContain("commandChildren.delete(child);");
    expect(source).toMatch(
      /for \(const child of \[\.\.\.commandChildren\]\) \{[\s\S]*?await stopProcessTree\(child\);/u,
    );
    expect(source).toMatch(
      /let registered = false;[\s\S]*?finally \{\s*if \(!registered\) \{[\s\S]*?await browser\?\.close\(\)[\s\S]*?await server\.kill\(\)/u,
    );
  });

  it("preserves the owned PG17 container and failure cleanup boundaries", () => {
    expect(source).toContain(
      "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193",
    );
    expect(source).toMatch(/requiredPostgresMajor:\s*17,/u);
    expect(source).toContain("`127.0.0.1:${databasePort}:5432`");
    expect(source).toContain('"POSTGRES_PASSWORD"');
    expect(source).not.toMatch(/POSTGRES_PASSWORD=\$\{/u);
    expect(source).toContain("containerStarted = true");
    expect(source).toContain('spawnSync(docker, ["rm", "--force", containerName]');
    expect(source).toMatch(
      /main\(\)\s*\.catch\([\s\S]*?const cleanupResults = await cleanup\(\);/u,
    );
    expect(source).toContain(".finally(cleanup)");
  });
});
