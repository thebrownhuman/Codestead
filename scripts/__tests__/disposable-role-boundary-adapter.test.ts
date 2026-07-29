import { describe, expect, it, vi } from "vitest";

import { verifyDisposableIntegrationRoleBoundaries } from
  "../lib/disposable-role-boundary-adapter";

const roleUrls = {
  bootstrap:
    "postgresql://codestead_it:bootstrap-password-0000@127.0.0.1:49152/learncoding_integration",
  app: "postgresql://learncoding_app:app-password-0001@127.0.0.1:49152/learncoding_integration",
  migrator:
    "postgresql://learncoding_migrator:migrator-password-0002@127.0.0.1:49152/learncoding_integration",
  worker:
    "postgresql://learncoding_worker:worker-password-0003@127.0.0.1:49152/learncoding_integration",
  ops: "postgresql://learncoding_ops:ops-password-0004@127.0.0.1:49152/learncoding_integration",
  backupReporter:
    "postgresql://learncoding_backup_reporter:backup-password-0005@127.0.0.1:49152/learncoding_integration",
} as const;

const roleProperties = [
  ["codestead_it", "databaseBootstrapUrl", "bootstrap"],
  ["learncoding_app", "databaseAppUrl", "app"],
  ["learncoding_migrator", "databaseMigratorUrl", "migrator"],
  ["learncoding_worker", "databaseWorkerUrl", "worker"],
  ["learncoding_ops", "databaseOpsUrl", "ops"],
  [
    "learncoding_backup_reporter",
    "databaseBackupReporterUrl",
    "backupReporter",
  ],
] as const;

describe("disposable role-boundary adapter", () => {
  it("uses exact canonical verifier URLs and rewrites only pool host and port", async () => {
    const createdPools: Array<Record<string, unknown>> = [];
    let capturedVerifierInput: Record<string, unknown> | undefined;
    const verifyDatabaseRoleBoundaries = vi.fn(async (input: Record<string, unknown>) => {
      capturedVerifierInput = input;
      const poolFactory = input.poolFactory as (probe: Readonly<{
        connectionString: string;
        database: string;
        role: string;
      }>) => unknown;
      for (const [role, property] of roleProperties) {
        const probeUrl = new URL(input[property] as string);
        probeUrl.searchParams.set("options", "-c statement_timeout=4321");
        poolFactory({
          connectionString: probeUrl.href,
          database: "learncoding_integration",
          role,
        });
      }
    });
    const createPool = vi.fn((options: Record<string, unknown>) => {
      createdPools.push(options);
      return { options };
    });

    await verifyDisposableIntegrationRoleBoundaries({
      postgresUser: "codestead_it",
      database: "learncoding_integration",
      roleUrls,
      requireApplicationObjects: true,
      verifyDatabaseRoleBoundaries,
      createPool,
    });

    expect(verifyDatabaseRoleBoundaries).toHaveBeenCalledOnce();
    expect(Object.keys(capturedVerifierInput ?? {}).sort()).toEqual([
      "databaseAppUrl",
      "databaseBackupReporterUrl",
      "databaseBootstrapUrl",
      "databaseMigratorUrl",
      "databaseOpsUrl",
      "databaseWorkerUrl",
      "lockTimeoutMs",
      "poolFactory",
      "postgresDatabase",
      "postgresUser",
      "requireApplicationObjects",
    ]);
    expect(capturedVerifierInput).toMatchObject({
      postgresUser: "codestead_it",
      postgresDatabase: "learncoding_integration",
      requireApplicationObjects: true,
      lockTimeoutMs: 10_000,
      databaseBootstrapUrl:
        "postgresql://codestead_it:bootstrap-password-0000@postgres:5432/learncoding_integration",
      databaseAppUrl:
        "postgresql://learncoding_app:app-password-0001@postgres:5432/learncoding_integration",
      databaseMigratorUrl:
        "postgresql://learncoding_migrator:migrator-password-0002@postgres:5432/learncoding_integration",
      databaseWorkerUrl:
        "postgresql://learncoding_worker:worker-password-0003@postgres:5432/learncoding_integration",
      databaseOpsUrl:
        "postgresql://learncoding_ops:ops-password-0004@postgres:5432/learncoding_integration",
      databaseBackupReporterUrl:
        "postgresql://learncoding_backup_reporter:backup-password-0005@postgres:5432/learncoding_integration",
    });
    const canonicalPasswords = roleProperties.map(([, property]) =>
      new URL(capturedVerifierInput![property] as string).password);
    expect(new Set(canonicalPasswords).size).toBe(6);

    expect(createdPools).toHaveLength(6);
    for (const [index, [role, , roleName]] of roleProperties.entries()) {
      const options = createdPools[index]!;
      const connectionUrl = new URL(options.connectionString as string);
      const scopedUrl = new URL(roleUrls[roleName]);
      expect(connectionUrl).toMatchObject({
        protocol: scopedUrl.protocol,
        username: scopedUrl.username,
        password: scopedUrl.password,
        hostname: scopedUrl.hostname,
        port: scopedUrl.port,
        pathname: scopedUrl.pathname,
        hash: scopedUrl.hash,
      });
      expect(connectionUrl.searchParams.get("options")).toBe(
        "-c statement_timeout=4321",
      );
      expect(options).toMatchObject({
        application_name: `codestead_integration_boundary_${roleName}`,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 1_000,
        max: 1,
        statement_timeout: 5_000,
      });
      expect(role).toBe(connectionUrl.username);
    }
  });
});
