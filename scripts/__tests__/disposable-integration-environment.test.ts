import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  acquireValidatedDisposableRoleClient,
  DISPOSABLE_INTEGRATION_POOL_BOUNDS,
  endDisposableIntegrationPoolWithinDeadline,
  minimalNodeTestEnvironment,
  runWithBoundedDisposableIntegrationPool,
  runWithValidatedRetentionOpsEnvironment,
  validatedDisposableApplicationDatabaseUrl,
  validatedDisposableBackupReporterEnvironment,
} from "../lib/disposable-integration-environment";

const WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const validEnvironment = () => ({
  INTEGRATION_TEST: "1",
  DATABASE_URL:
    "postgresql://learncoding_app:app-password@127.0.0.1:49152/learncoding_integration",
  DATABASE_APP_URL:
    "postgresql://learncoding_app:app-password@127.0.0.1:49152/learncoding_integration",
  DATABASE_OWNER_URL:
    "postgresql://learncoding_migrator:owner-password@127.0.0.1:49152/learncoding_integration?options=-c+role%3Dlearncoding_owner",
  DATABASE_WORKER_URL:
    "postgresql://learncoding_worker:worker-password@127.0.0.1:49152/learncoding_integration",
  DATABASE_OPS_URL:
    "postgresql://learncoding_ops:ops-password@127.0.0.1:49152/learncoding_integration",
  DATABASE_BACKUP_REPORTER_URL:
    "postgresql://learncoding_backup_reporter:reporter-password@127.0.0.1:49152/learncoding_integration",
});

describe("disposable integration environment", () => {
  it("admits exact lower roles and returns one frozen owner/app target", async () => {
    const environment = validEnvironment();
    const operation = vi.fn(async (urls: Readonly<{
      databaseAppUrl: string;
      databaseOwnerTarget: Readonly<{
        databaseApplicationUrl: string;
        databaseOwnerUrl: string;
      }>;
      databaseWorkerUrl: string;
      databaseOpsUrl: string;
    }>) => urls);

    await expect(runWithValidatedRetentionOpsEnvironment(
      environment,
      operation,
    )).resolves.toEqual({
      databaseAppUrl: environment.DATABASE_APP_URL,
      databaseOwnerTarget: {
        databaseApplicationUrl: environment.DATABASE_APP_URL,
        databaseOwnerUrl: environment.DATABASE_OWNER_URL,
      },
      databaseWorkerUrl: environment.DATABASE_WORKER_URL,
      databaseOpsUrl: environment.DATABASE_OPS_URL,
    });
    expect(operation).toHaveBeenCalledOnce();
    const validated = operation.mock.calls[0]?.[0];
    expect(Object.isFrozen(validated?.databaseOwnerTarget)).toBe(true);
  });

  it.each([
    ["missing integration marker", (env: Record<string, string | undefined>) => {
      delete env.INTEGRATION_TEST;
    }],
    ["wrong integration marker", (env: Record<string, string | undefined>) => {
      env.INTEGRATION_TEST = "true";
    }],
    ["missing canonical app URL", (env: Record<string, string | undefined>) => {
      delete env.DATABASE_URL;
    }],
    ["missing explicit app URL", (env: Record<string, string | undefined>) => {
      delete env.DATABASE_APP_URL;
    }],
    ["canonical app mismatch", (env: Record<string, string | undefined>) => {
      env.DATABASE_URL = env.DATABASE_URL!.replace("app-password", "other-password");
    }],
    ["wrong app role", (env: Record<string, string | undefined>) => {
      env.DATABASE_APP_URL = env.DATABASE_APP_URL!.replace("learncoding_app", "learncoding_worker");
    }],
    ["missing owner URL", (env: Record<string, string | undefined>) => {
      delete env.DATABASE_OWNER_URL;
    }],
    ["wrong owner login role", (env: Record<string, string | undefined>) => {
      env.DATABASE_OWNER_URL = env.DATABASE_OWNER_URL!.replace(
        "learncoding_migrator",
        "learncoding_app",
      );
    }],
    ["missing owner role option", (env: Record<string, string | undefined>) => {
      env.DATABASE_OWNER_URL = env.DATABASE_OWNER_URL!.split("?")[0];
    }],
    ["owner topology mismatch", (env: Record<string, string | undefined>) => {
      env.DATABASE_OWNER_URL = env.DATABASE_OWNER_URL!.replace(":49152", ":49153");
    }],
    ["owner protected port", (env: Record<string, string | undefined>) => {
      env.DATABASE_OWNER_URL = env.DATABASE_OWNER_URL!.replace(":49152", ":5432");
    }],
    ["missing worker URL", (env: Record<string, string | undefined>) => {
      delete env.DATABASE_WORKER_URL;
    }],
    ["wrong worker role", (env: Record<string, string | undefined>) => {
      env.DATABASE_WORKER_URL = env.DATABASE_WORKER_URL!.replace("learncoding_worker", "learncoding_app");
    }],
    ["missing ops URL", (env: Record<string, string | undefined>) => {
      delete env.DATABASE_OPS_URL;
    }],
    ["wrong ops role", (env: Record<string, string | undefined>) => {
      env.DATABASE_OPS_URL = env.DATABASE_OPS_URL!.replace("learncoding_ops", "learncoding_app");
    }],
    ["remote host", (env: Record<string, string | undefined>) => {
      env.DATABASE_WORKER_URL = env.DATABASE_WORKER_URL!.replace("127.0.0.1", "postgres");
    }],
    ["protected port", (env: Record<string, string | undefined>) => {
      env.DATABASE_OPS_URL = env.DATABASE_OPS_URL!.replace(":49152", ":5432");
    }],
    ["different topology", (env: Record<string, string | undefined>) => {
      env.DATABASE_WORKER_URL = env.DATABASE_WORKER_URL!.replace(":49152", ":49153");
    }],
    ["wrong database", (env: Record<string, string | undefined>) => {
      env.DATABASE_APP_URL = env.DATABASE_APP_URL!.replace("learncoding_integration", "postgres");
    }],
    ["unsafe query option", (env: Record<string, string | undefined>) => {
      env.DATABASE_OPS_URL += "?sslmode=disable";
    }],
    ["unsafe fragment", (env: Record<string, string | undefined>) => {
      env.DATABASE_WORKER_URL += "#unsafe";
    }],
    ["alternate protocol", (env: Record<string, string | undefined>) => {
      env.DATABASE_APP_URL = env.DATABASE_APP_URL!.replace("postgresql:", "postgres:");
    }],
  ])("rejects %s before the callback can construct a pool", async (_name, mutate) => {
    const environment: Record<string, string | undefined> = validEnvironment();
    mutate(environment);
    const operation = vi.fn();

    await expect(runWithValidatedRetentionOpsEnvironment(
      environment,
      operation,
    )).rejects.toThrow("disposable integration environment validation failed");
    expect(operation).not.toHaveBeenCalled();
  });

  it("keeps the validated owner target stable when ambient input mutates", async () => {
    const environment: Record<string, string | undefined> = validEnvironment();
    const originalOwnerUrl = environment.DATABASE_OWNER_URL;

    await runWithValidatedRetentionOpsEnvironment(environment, (validated) => {
      environment.DATABASE_OWNER_URL =
        "postgresql://learncoding_migrator:decoy@127.0.0.1:59999/learncoding_integration?options=-c+role%3Dlearncoding_owner";
      expect(validated.databaseOwnerTarget).toEqual({
        databaseApplicationUrl: environment.DATABASE_APP_URL,
        databaseOwnerUrl: originalOwnerUrl,
      });
      expect(Object.isFrozen(validated.databaseOwnerTarget)).toBe(true);
    });

    const source = await readFile(
      path.resolve(WORKSPACE_ROOT, "scripts/lib/disposable-integration-environment.ts"),
      "utf8",
    );
    expect(source).toContain("validatedDisposableOwnerDatabaseTarget");
    expect(source).not.toMatch(/\bdatabaseUrl\b/);
  });

  it("validates exact app and backup-reporter topology without ambient fallback", () => {
    const environment = validEnvironment();
    expect(validatedDisposableApplicationDatabaseUrl(environment)).toBe(
      environment.DATABASE_APP_URL,
    );
    expect(validatedDisposableBackupReporterEnvironment(environment)).toEqual({
      databaseAppUrl: environment.DATABASE_APP_URL,
      databaseBackupReporterUrl: environment.DATABASE_BACKUP_REPORTER_URL,
    });
    for (const mutate of [
      (env: Record<string, string | undefined>) => {
        delete env.DATABASE_BACKUP_REPORTER_URL;
      },
      (env: Record<string, string | undefined>) => {
        env.DATABASE_BACKUP_REPORTER_URL = env.DATABASE_BACKUP_REPORTER_URL!
          .replace("learncoding_backup_reporter", "learncoding_ops");
      },
      (env: Record<string, string | undefined>) => {
        env.DATABASE_BACKUP_REPORTER_URL = env.DATABASE_BACKUP_REPORTER_URL!
          .replace(":49152", ":5432");
      },
      (env: Record<string, string | undefined>) => {
        env.DATABASE_BACKUP_REPORTER_URL = env.DATABASE_BACKUP_REPORTER_URL!
          .replace("127.0.0.1", "localhost");
      },
    ]) {
      const invalid: Record<string, string | undefined> = validEnvironment();
      mutate(invalid);
      expect(() => validatedDisposableBackupReporterEnvironment(invalid))
        .toThrow("disposable integration environment validation failed");
    }
  });

  it("probes the exact connected role identity and destroys a mismatch", async () => {
    const exact = {
      query: vi.fn(async (statement: string) => {
        expect(statement).toContain("current_database()");
        return { rows: [{
          current_database: "learncoding_integration",
          current_user: "learncoding_ops",
          session_user: "learncoding_ops",
        }] };
      }),
      release: vi.fn(),
    };
    await expect(acquireValidatedDisposableRoleClient(
      { connect: vi.fn(async () => exact) },
      "learncoding_ops",
    )).resolves.toBe(exact);
    expect(exact.release).not.toHaveBeenCalled();

    const mismatch = {
      query: vi.fn(async (statement: string) => {
        expect(statement).toContain("current_database()");
        return { rows: [{
          current_database: "learncoding_integration",
          current_user: "learncoding_owner",
          session_user: "learncoding_ops",
        }] };
      }),
      release: vi.fn(),
    };
    await expect(acquireValidatedDisposableRoleClient(
      { connect: vi.fn(async () => mismatch) },
      "learncoding_ops",
    )).rejects.toThrow("disposable integration role identity mismatch");
    expect(mismatch.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("bounds every pool phase and preserves fixture plus shutdown failures", async () => {
    expect(DISPOSABLE_INTEGRATION_POOL_BOUNDS).toEqual({
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 5_000,
      query_timeout: 30_000,
      statement_timeout: 30_000,
      lock_timeout: 5_000,
      idle_in_transaction_session_timeout: 30_000,
    });
    const fixtureFailure = new Error("fixture failed");
    const shutdownFailure = new Error("shutdown failed");
    let failure: unknown;
    try {
      await runWithBoundedDisposableIntegrationPool(
        { end: vi.fn(async () => { throw shutdownFailure; }) },
        async () => { throw fixtureFailure; },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      fixtureFailure,
      shutdownFailure,
    ]);
    expect((failure as Error & { cause?: unknown }).cause).toBe(fixtureFailure);

    vi.useFakeTimers();
    try {
      const pending = endDisposableIntegrationPoolWithinDeadline({
        end: () => new Promise<void>(() => {}),
      });
      const assertion = expect(pending).rejects.toThrow(
        "disposable integration pool shutdown timed out",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("wires reporter and retention integration operations through validated sessions", async () => {
    const [reporterSource, postgresSource] = await Promise.all([
      readFile(
        path.resolve(
          WORKSPACE_ROOT,
          "integration/backup-status-outbox.integration.test.ts",
        ),
        "utf8",
      ),
      readFile(
        path.resolve(WORKSPACE_ROOT, "integration/postgres.integration.test.ts"),
        "utf8",
      ),
    ]);

    expect(reporterSource).toContain(
      "validatedDisposableBackupReporterEnvironment(process.env)",
    );
    expect(reporterSource).toContain("acquireValidatedDisposableRoleClient(");
    expect(reporterSource).toContain("DISPOSABLE_INTEGRATION_POOL_BOUNDS");
    expect(reporterSource).not.toContain(
      'process.env.DATABASE_BACKUP_REPORTER_URL ?? ""',
    );
    expect(postgresSource).toContain(
      "validatedDisposableRetentionOpsEnvironment(process.env)",
    );
    expect(postgresSource).toContain("runValidatedIntegrationRetention(");
    expect(postgresSource).toMatch(
      /acquireValidatedDisposableRoleClient<PoolClient>\(\s*integrationRetentionPool,\s*"learncoding_ops",/u,
    );
    expect(postgresSource).not.toContain(
      "connectionString: process.env.DATABASE_OPS_URL",
    );
    expect([...postgresSource.matchAll(/\brunRetention\(/gu)]).toHaveLength(1);
    expect([
      ...postgresSource.matchAll(/\brunValidatedIntegrationRetention\(/gu),
    ]).toHaveLength(6);
  });

  it("passes only an explicit minimal platform environment to child tests", () => {
    const child = minimalNodeTestEnvironment({
      CI: "true",
      LANG: "C.UTF-8",
      SYSTEMROOT: "C:\\Windows",
      TEMP: "C:\\Temp",
      ARBITRARY_TOKEN: "token-canary",
      APP_SECRET: "secret-canary",
      SIGNING_KEY: "key-canary",
      SERVICE_CREDENTIAL: "credential-canary",
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "cloud-canary",
      HTTPS_PROXY: "proxy-canary",
      DATABASE_READONLY_URL: "database-canary",
      PGHOST: "postgres-canary",
      DELETION_TOMBSTONE_KEY: "deletion-tombstone-secret-canary",
      DELETION_TOMBSTONE_KEY_FILE: "deletion-tombstone-file-canary",
    });

    expect(child).toEqual({
      CI: "true",
      LANG: "C.UTF-8",
      SYSTEMROOT: "C:\\Windows",
      TEMP: "C:\\Temp",
    });
    expect(JSON.stringify(child)).not.toMatch(
      /token-canary|secret-canary|key-canary|credential-canary|cloud-canary|proxy-canary|database-canary|postgres-canary|deletion-tombstone-secret-canary|deletion-tombstone-file-canary/u,
    );
  });

  it("keeps the deletion tombstone capability out of migration and the general runner", async () => {
    const [migrationRunner, integrationRunner] = await Promise.all([
      readFile(
        path.resolve(process.cwd(), "scripts/migrate-production.mjs"),
        "utf8",
      ),
      readFile(
        path.resolve(process.cwd(), "scripts/run-integration-tests.ts"),
        "utf8",
      ),
    ]);
    const deletionCapability =
      /DELETION_TOMBSTONE_KEY(?:_FILE)?|deletion_tombstone_key/u;

    expect(migrationRunner).not.toMatch(deletionCapability);
    expect(integrationRunner).not.toMatch(deletionCapability);
  });
});
