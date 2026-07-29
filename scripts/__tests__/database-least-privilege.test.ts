import { describe, expect, it, vi } from "vitest";

type DatabaseRoleModule = {
  DATABASE_ADMIN_LOCK_NAME: string;
  DATABASE_CLUSTER_ROLE_ADMIN_LOCK_NAME: string;
  DATABASE_BOOTSTRAP_POOL_POLICY: Readonly<{
    connectionTimeoutMillis: number;
    idleTimeoutMillis: number;
    query_timeout: number;
    statement_timeout: number;
    lock_timeout: number;
    idle_in_transaction_session_timeout: number;
  }>;
  databaseAdministrationConnectionString: (
    connectionString: string,
  ) => string;
  createDatabaseAdministrationLockDeadline: (
    timeoutMs: number | undefined,
    now?: () => number,
  ) => number;
  acquireDatabaseAdministrationLock: (
    client: {
      query: (
        sql: string,
        parameters?: unknown[],
      ) => Promise<{ rows: Array<Record<string, unknown>> }>;
    },
    lockName: string,
    deadline: number,
    dependencies?: {
      now?: () => number;
      sleep?: (milliseconds: number) => Promise<void>;
    },
  ) => Promise<void>;
  parseDatabaseRoleBootstrapBooleanSetting: (
    value: string | undefined,
    label: string,
  ) => boolean;
  REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES: ReadonlyArray<{
    readonly index: number;
  }>;
  REVIEWED_APPLICATION_FUNCTIONS: ReadonlyArray<{
    signature: string;
    owner: string;
    securityDefiner: boolean;
    configuration: readonly string[] | null;
    allowedRoles: readonly string[];
    bodySha256: string;
    language: string;
    kind: string;
    volatility: string;
    strict: boolean;
    parallel: string;
    leakproof: boolean;
    argumentNames: readonly string[];
    argumentModes: readonly string[];
    argumentTypes: readonly string[];
    inputArgumentCount: number;
    argumentDefaultCount: number;
    returnType: string;
    returnsSet: boolean;
    variadic: boolean;
  }>;
  reviewedApplicationFunctionPrivilegesSql: (phase: unknown) => string;
  globalDefaultAclScrubSql: () => string;
  validateDatabaseRoleUrls: (input: {
    postgresUser: string;
    postgresDatabase: string;
    databaseBootstrapUrl: string;
    databaseAppUrl: string;
    databaseMigratorUrl: string;
    databaseWorkerUrl: string;
    databaseOpsUrl: string;
    databaseBackupReporterUrl: string;
  }) => Record<
    string,
    { username: string; hostname: string; database: string }
  >;
  validateOwnershipInventory: (input: {
    postgresUser: string;
    postgresDatabase: string;
    databases: Array<{ name: string; owner: string }>;
    tablespaces: Array<{ name: string; owner: string }>;
    schemas: Array<{ name: string; owner: string }>;
    objects: Array<{
      schema: string;
      name: string;
      kind: string;
      owner: string;
    }>;
    defaultAcls?: Array<{
      schema: string;
      owner: string;
      grantee: string | null;
      grantee_oid?: number | null;
      is_public?: boolean | null;
      kind: string;
      privilege_type?: string | null;
      is_grantable?: boolean | null;
    }>;
    unexpectedOwnerDependencies?: Array<{ catalog: string; objectId: string }>;
    directAcls?: Array<{
      scope: string;
      grantee: string;
      privilege: string;
      isGrantable?: boolean;
    }>;
  }) => void;
  verifyDatabaseDefaultAclState: (input: {
    postgresUser: string;
    drizzleExists: boolean;
    entries: Array<{
      schema: string;
      owner: string;
      grantor: string | null;
      grantee: string | null;
      kind: string;
      grantee_oid: number | null;
      is_public: boolean | null;
      privilege_type: string | null;
      is_grantable: boolean | null;
    }>;
  }) => void;
  cleanupDatabaseBootstrapResources: (input: {
    client: {
      query: (
        sql: string,
        parameters?: unknown[],
      ) => Promise<{ rows: Array<{ released?: boolean }> }>;
      release: (destroy?: boolean) => void;
    };
    pool: { end: () => Promise<void> };
    transactionOpen: boolean;
    lockAcquired: boolean;
    destroyClient?: boolean;
    timeoutMs?: number;
  }) => Promise<void>;
  cleanupRestoredNoAclMaintenanceResources: (input: {
    client?: {
      query: (
        sql: string,
        parameters?: unknown[],
      ) => Promise<{ rows: Array<{ released?: boolean }> }>;
      release: (destroy?: boolean) => void;
    };
    pool: { end: () => Promise<void> };
    databaseReenabled: boolean;
    operationFailed: boolean;
    timeoutMs?: number;
  }) => Promise<unknown[]>;
  validateRestoredNoAclMaintenanceIdentity: (
    target: Record<string, unknown>,
    maintenance: Record<string, unknown>,
    expectedUser: string,
  ) => void;
  proveRestoredNoAclMaintenanceSameInstance: (
    targetClient: {
      query: (
        sql: string,
        parameters?: unknown[],
      ) => Promise<{ rows: Array<Record<string, unknown>> }>;
    },
    maintenanceClient: {
      query: (
        sql: string,
        parameters?: unknown[],
      ) => Promise<{ rows: Array<Record<string, unknown>> }>;
    },
    nonce?: string,
  ) => Promise<void>;
  reenableRestoredNoAclDatabase: (
    maintenancePool: {
      query: (
        sql: string,
        parameters?: unknown[],
      ) => Promise<{ rows: Array<Record<string, unknown>> }>;
    },
    postgresDatabase: string,
    targetBackendPid: number,
  ) => Promise<void>;

  terminateAndDrainManagedLoginRoleSessions: (
    client: {
      query: (
        sql: string,
        parameters?: unknown[],
      ) => Promise<{ rows: Array<Record<string, unknown>> }>;
    },
    options?: {
      timeoutMs?: number;
      queryTimeoutMs?: number;
      now?: () => number;
    },
  ) => Promise<boolean>;
  readDatabaseAuthenticationFenceSettings: (client: {
    query: (
      sql: string,
      parameters?: unknown[],
    ) => Promise<{ rows: Array<Record<string, unknown>> }>;
  }) => Promise<{
    authenticationTimeoutMs: number;
    preAuthDelayMs: number;
    postAuthDelayMs: number;
    serverVersionNum: number;
  }>;
  verifyNoExternalManagedRoleSetPaths: (client: {
    query: (
      sql: string,
      parameters?: unknown[],
    ) => Promise<{ rows: Array<Record<string, unknown>> }>;
  }) => Promise<boolean>;
  commitDatabaseBootstrapTransaction: (
    client: {
      query: (
        sql: string,
        parameters?: unknown[],
      ) => Promise<{ rows: Array<Record<string, unknown>> }>;
    },
    phase: "authentication-gate" | "activation",
    options?: { timeoutMs?: number },
  ) => Promise<void>;
  beginDatabaseBootstrapTransaction: (
    client: {
      query: (
        sql: string,
        parameters?: unknown[],
      ) => Promise<{
        rows: Array<Record<string, unknown>>;
        command?: string;
      }>;
    },
    phase: "authentication-gate" | "activation",
    options?: { timeoutMs?: number },
  ) => Promise<void>;
  checkoutDatabaseBootstrapClient: (
    pool: {
      connect: () => Promise<{
        release: (destroy?: boolean) => void;
      }>;
    },
    phase: "target" | "cluster-administration",
    options?: { timeoutMs?: number },
  ) => Promise<{
    release: (destroy?: boolean) => void;
  }>;
  commitManagedRoleAuthenticationGate: (
    client: {
      query: (
        sql: string,
        parameters?: unknown[],
      ) => Promise<{ rows: Array<Record<string, unknown>> }>;
    },
    options?: { rollbackTimeoutMs?: number },
  ) => Promise<boolean>;
  installManagedLoginRolePasswordsAndEnable: (
    client: {
      query: (
        sql: string,
        parameters?: unknown[],
      ) => Promise<{ rows: Array<Record<string, unknown>> }>;
    },
    rolePasswords: Record<string, { password: string }>,
  ) => Promise<void>;
  exhaustManagedRoleAuthenticationFence: (
    client: {
      query: (
        sql: string,
        parameters?: unknown[],
      ) => Promise<{ rows: Array<Record<string, unknown>> }>;
    },
    settings: {
      authenticationTimeoutMs: number;
      serverVersionNum: number;
    },
    dependencies?: {
      now?: () => number;
      sleep?: (milliseconds: number) => Promise<void>;
      pollMs?: number;
      safetyMarginMs?: number;
      finalDrainMs?: number;
      queryTimeoutMs?: number;
    },
  ) => Promise<boolean>;

  runDatabaseRoleBootstrap: (input: {
    postgresUser: string;
    postgresDatabase: string;
    databaseBootstrapUrl: string;
    databaseAppUrl: string;
    databaseMigratorUrl: string;
    databaseWorkerUrl: string;
    databaseOpsUrl: string;
    databaseBackupReporterUrl: string;
    cleanupTimeoutMs?: number;
    requireCompleteMigrationLedger?: boolean;
    bootstrapMode?: "strict" | "restored-no-acl";
    verifyAppliedMigrationLedger?: () => Promise<void>;
    beforeCommit?: () => Promise<void>;
    restoreMaintenancePool?: {
      connect: () => Promise<{
        query: (
          sql: string,
          parameters?: unknown[],
        ) => Promise<{ rows: Array<Record<string, unknown>> }>;
        release: (destroy?: boolean) => void;
      }>;
      end: () => Promise<void>;
    };
    clusterAdministrationPool?: {
      connect: () => Promise<{
        query: (
          sql: string,
          parameters?: unknown[],
        ) => Promise<{ rows: Array<Record<string, unknown>> }>;
        release: (destroy?: boolean) => void;
      }>;
      end: () => Promise<void>;
    };
    pool: { connect: () => Promise<never>; end: () => Promise<void> };
  }) => Promise<unknown>;
};

async function loadDatabaseRoleModule(): Promise<DatabaseRoleModule | null> {
  const modulePath = "../bootstrap-database-roles.mjs";
  try {
    return (await import(/* @vite-ignore */ modulePath)) as DatabaseRoleModule;
  } catch {
    return null;
  }
}

const urls = {
  postgresUser: "legacy_bootstrap",
  postgresDatabase: "learncoding",
  databaseBootstrapUrl:
    "postgresql://legacy_bootstrap:bootstrap-Fake-A-0000000000000000@postgres:5432/learncoding",
  databaseAppUrl:
    "postgresql://learncoding_app:app-Fake-B-000000000000000000000@postgres:5432/learncoding",
  databaseMigratorUrl:
    "postgresql://learncoding_migrator:migrator-Fake-C-00000000000000000@postgres:5432/learncoding",
  databaseWorkerUrl:
    "postgresql://learncoding_worker:worker-Fake-D-0000000000000000000@postgres:5432/learncoding",
  databaseOpsUrl:
    "postgresql://learncoding_ops:ops-Fake-E-000000000000000000000@postgres:5432/learncoding",
  databaseBackupReporterUrl:
    "postgresql://learncoding_backup_reporter:backup-reporter-Fake-F-000000000000@postgres:5432/learncoding",
};

async function captureRejection(operation: () => Promise<unknown>) {
  try {
    await operation();
    return { rejected: false as const, reason: undefined };
  } catch (reason) {
    return { rejected: true as const, reason };
  }
}

const NO_TEST_FAILURE = Symbol("no-test-failure");

async function runBootstrapCheckoutFailure(
  databaseRoleBootstrap: DatabaseRoleModule,
  primaryFailure: unknown,
  cleanupFailure: unknown = NO_TEST_FAILURE,
) {
  const pool = {
    connect: vi.fn(async (): Promise<never> => {
      throw primaryFailure;
    }),
    end: vi.fn(async () => {
      if (cleanupFailure !== NO_TEST_FAILURE) throw cleanupFailure;
    }),
  };
  const clusterAdministrationPool = {
    connect: vi.fn(async (): Promise<never> => {
      throw new Error("cluster administration checkout must not run");
    }),
    end: vi.fn(async () => undefined),
  };
  const outcome = await captureRejection(() =>
    databaseRoleBootstrap.runDatabaseRoleBootstrap({
      ...urls,
      cleanupTimeoutMs: 50,
      pool,
      clusterAdministrationPool,
    }),
  );
  return { outcome, pool, clusterAdministrationPool };
}

describe("database least-privilege bootstrap", () => {
  it("uses distinct fixed cluster-role and target-database advisory locks", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();

    expect(databaseRoleBootstrap).not.toBeNull();
    expect(databaseRoleBootstrap?.DATABASE_ADMIN_LOCK_NAME).toBe(
      "codestead:database-administration:v1",
    );
    expect(databaseRoleBootstrap?.DATABASE_CLUSTER_ROLE_ADMIN_LOCK_NAME).toBe(
      "codestead:cluster-role-administration:v1",
    );
    expect(databaseRoleBootstrap?.DATABASE_CLUSTER_ROLE_ADMIN_LOCK_NAME).not.toBe(
      databaseRoleBootstrap?.DATABASE_ADMIN_LOCK_NAME,
    );
  });

  it("pins cluster-role administration to postgres and shares one lock deadline", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const administrationUrl = new URL(
      databaseRoleBootstrap!.databaseAdministrationConnectionString(
        urls.databaseBootstrapUrl,
      ),
    );
    const targetUrl = new URL(urls.databaseBootstrapUrl);
    expect(administrationUrl.pathname).toBe("/postgres");
    expect(administrationUrl.protocol).toBe(targetUrl.protocol);
    expect(administrationUrl.username).toBe(targetUrl.username);
    expect(administrationUrl.password).toBe(targetUrl.password);
    expect(administrationUrl.host).toBe(targetUrl.host);
    expect(administrationUrl.search).toBe(targetUrl.search);
    expect(administrationUrl.hash).toBe(targetUrl.hash);

    const deadline =
      databaseRoleBootstrap!.createDatabaseAdministrationLockDeadline(
        1_000,
        () => 25,
      );
    expect(deadline).toBe(1_025);
    const calls: Array<{ lock: unknown; sql: string }> = [];
    const makeClient = () => ({
      query: vi.fn(async (sql: string, parameters?: unknown[]) => {
        calls.push({ lock: parameters?.[0], sql });
        return { rows: [{ acquired: true }] };
      }),
    });
    await databaseRoleBootstrap!.acquireDatabaseAdministrationLock(
      makeClient(),
      databaseRoleBootstrap!.DATABASE_CLUSTER_ROLE_ADMIN_LOCK_NAME,
      deadline,
      { now: () => 25, sleep: async () => undefined },
    );
    await databaseRoleBootstrap!.acquireDatabaseAdministrationLock(
      makeClient(),
      databaseRoleBootstrap!.DATABASE_ADMIN_LOCK_NAME,
      deadline,
      { now: () => 25, sleep: async () => undefined },
    );
    expect(calls.map(({ lock }) => lock)).toEqual([
      "codestead:cluster-role-administration:v1",
      "codestead:database-administration:v1",
    ]);
    expect(calls.every(({ sql }) => sql.includes("pg_try_advisory_lock"))).toBe(
      true,
    );
    const policy = databaseRoleBootstrap!.DATABASE_BOOTSTRAP_POOL_POLICY;
    expect(policy.lock_timeout).toBeLessThan(policy.statement_timeout);
    expect(policy.statement_timeout).toBeLessThan(policy.query_timeout);
    expect(policy.idle_in_transaction_session_timeout).toBeGreaterThanOrEqual(
      policy.statement_timeout,
    );
    expect(policy.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(policy.idleTimeoutMillis).toBeGreaterThan(0);
  });

  it("acquires cluster then target and cleans target before cluster", async () => {
    const [{ readFile }, { join }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    const source = await readFile(
      join(process.cwd(), "scripts", "bootstrap-database-roles.mjs"),
      "utf8",
    );
    const start = source.indexOf(
      "export async function runDatabaseRoleBootstrap(options) {",
    );
    const end = source.indexOf("\nasync function main()", start);
    const run = source.slice(start, end);
    const clusterConnect = run.indexOf(
      "clusterAdministrationClient = await checkoutDatabaseBootstrapClient(",
    );
    const clusterAcquire = run.indexOf(
      "DATABASE_CLUSTER_ROLE_ADMIN_LOCK_NAME",
      clusterConnect,
    );
    const targetAcquire = run.indexOf(
      "DATABASE_ADMIN_LOCK_NAME",
      clusterAcquire + 1,
    );
    const targetCleanup = run.indexOf(
      "const cleanupFailures = await collectDatabaseBootstrapCleanupFailures",
      targetAcquire,
    );
    const clusterCleanup = run.indexOf(
      "const clusterCleanupFailures =",
      targetCleanup,
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(clusterConnect).toBeGreaterThanOrEqual(0);
    expect(clusterAcquire).toBeGreaterThan(clusterConnect);
    expect(targetAcquire).toBeGreaterThan(clusterAcquire);
    expect(targetCleanup).toBeGreaterThan(targetAcquire);
    expect(clusterCleanup).toBeGreaterThan(targetCleanup);
  });

  it("accepts only exact boolean CLI settings for restore authority", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const parse =
      databaseRoleBootstrap!.parseDatabaseRoleBootstrapBooleanSetting;
    expect(parse(undefined, "RESTORE_NO_ACL_RECONCILIATION")).toBe(false);
    expect(parse("true", "RESTORE_NO_ACL_RECONCILIATION")).toBe(true);
    expect(parse("false", "RESTORE_NO_ACL_RECONCILIATION")).toBe(false);
    for (const invalid of ["TRUE", "False", " true", "1", ""]) {
      expect(() =>
        parse(invalid, "RESTORE_NO_ACL_RECONCILIATION"),
      ).toThrowError("RESTORE_NO_ACL_RECONCILIATION must be true or false");
    }
  });

  it("rejects no-ACL restore reconciliation without a complete ledger before checkout", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const pool = {
      connect: vi.fn(async (): Promise<never> => {
        throw new Error("restore-mode validation must precede checkout");
      }),
      end: vi.fn(async () => undefined),
    };

    const outcome = await captureRejection(() =>
      databaseRoleBootstrap!.runDatabaseRoleBootstrap({
        ...urls,
        pool,
        requireCompleteMigrationLedger: false,
        bootstrapMode: "restored-no-acl",
      }),
    );

    expect(outcome.rejected).toBe(true);
    expect(outcome.reason).toBeInstanceOf(Error);
    expect((outcome.reason as Error).message).toBe(
      "restored-no-acl bootstrap requires a complete migration ledger",
    );
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.end).not.toHaveBeenCalled();
  });

  it("rejects unsafe restored-no-ACL capabilities before URL parsing or checkout", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const scenarios = [
      {
        input: {
          verifyAppliedMigrationLedger: async () => undefined,
        },
        message:
          "restored-no-acl bootstrap does not allow a custom migration ledger verifier",
      },
      {
        input: {
          beforeCommit: async () => undefined,
        },
        message: "restored-no-acl bootstrap does not allow beforeCommit",
      },
      {
        input: {
          postgresDatabase: "learncoding",
        },
        message: "restored-no-acl bootstrap database name is invalid",
      },
    ];

    for (const scenario of scenarios) {
      const pool = {
        connect: vi.fn(async (): Promise<never> => {
          throw new Error("restore-mode validation must precede checkout");
        }),
        end: vi.fn(async () => undefined),
      };
      const outcome = await captureRejection(() =>
        databaseRoleBootstrap!.runDatabaseRoleBootstrap({
          ...urls,
          ...scenario.input,
          postgresDatabase:
            scenario.input.postgresDatabase ?? "learncoding_restore_target",
          pool,
          requireCompleteMigrationLedger: true,
          bootstrapMode: "restored-no-acl",
        }),
      );
      expect(outcome.rejected).toBe(true);
      expect((outcome.reason as Error).message).toBe(scenario.message);
      expect(pool.connect).not.toHaveBeenCalled();
      expect(pool.end).not.toHaveBeenCalled();
    }
  });

  it("requires custom restored target and maintenance pools as a pair", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const pool = {
      query: vi.fn(async (): Promise<never> => {
        throw new Error("paired-pool validation must precede query");
      }),
      connect: vi.fn(async (): Promise<never> => {
        throw new Error("paired-pool validation must precede checkout");
      }),
      end: vi.fn(async () => undefined),
    };
    const outcome = await captureRejection(() =>
      databaseRoleBootstrap!.runDatabaseRoleBootstrap({
        ...urls,
        bootstrapMode: "restored-no-acl",
        pool,
        postgresDatabase: "learncoding_restore_target",
        requireCompleteMigrationLedger: true,
      }),
    );
    expect((outcome.reason as Error).message).toBe(
      "restored-no-acl bootstrap requires paired target and maintenance pools",
    );
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.end).not.toHaveBeenCalled();

    const samePoolOutcome = await captureRejection(() =>
      databaseRoleBootstrap!.runDatabaseRoleBootstrap({
        ...urls,
        bootstrapMode: "restored-no-acl",
        pool,
        postgresDatabase: "learncoding_restore_target",
        requireCompleteMigrationLedger: true,
        restoreMaintenancePool: pool,
      }),
    );
    expect((samePoolOutcome.reason as Error).message).toBe(
      "restored-no-acl target and maintenance pools must be distinct",
    );
    expect(pool.connect).not.toHaveBeenCalled();
  });
  it("accepts only a distinct same-cluster postgres maintenance authority", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const target = {
      backend_pid: 101,
      cluster_system_identifier: "72623859790382856",
      current_database: "learncoding_restore_target",
      current_user: "codestead_restore",
      rolsuper: true,
      server_address: "127.0.0.1",
      server_port: 55432,
    };
    const maintenance = {
      ...target,
      backend_pid: 202,
      current_database: "postgres",
    };

    expect(() =>
      databaseRoleBootstrap!.validateRestoredNoAclMaintenanceIdentity(
        target,
        maintenance,
        "codestead_restore",
      ),
    ).not.toThrow();

    for (const invalidMaintenance of [
      { ...maintenance, backend_pid: target.backend_pid },
      { ...maintenance, cluster_system_identifier: "other-cluster" },
      { ...maintenance, current_database: "learncoding_restore_target" },
      { ...maintenance, current_user: "postgres" },
      { ...maintenance, rolsuper: false },
      { ...maintenance, server_address: "127.0.0.2" },
      { ...maintenance, server_port: 55433 },
    ]) {
      expect(() =>
        databaseRoleBootstrap!.validateRestoredNoAclMaintenanceIdentity(
          target,
          invalidMaintenance,
          "codestead_restore",
        ),
      ).toThrowError(
        "restored-no-acl maintenance authority verification failed",
      );
    }
  });

  it("proves the pinned maintenance session belongs to the target instance", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const nonce = "a".repeat(64);
    const marker = `codestead-restore-v1:${nonce.slice(0, 40)}`;
    const targetClient = {
      query: vi.fn(async (_sql: string, _parameters?: unknown[]) => {
        void _sql;
        void _parameters;
        if (targetClient.query.mock.calls.length === 1) {
          return {
            rows: [
              {
                application_name: marker,
                backend_pid: 101,
                database_name: "learncoding_restore_target",
                previous_application_name: "restore-before-proof",
                user_name: "codestead_restore",
              },
            ],
          };
        }
        return { rows: [{ application_name: "restore-before-proof" }] };
      }),
    };
    const maintenanceClient = {
      query: vi.fn(async (_sql: string, _parameters?: unknown[]) => {
        void _sql;
        void _parameters;
        return {
          rows: [
            {
              application_name: marker,
              database_name: "learncoding_restore_target",
              user_name: "codestead_restore",
            },
          ],
        };
      }),
    };

    await expect(
      databaseRoleBootstrap!.proveRestoredNoAclMaintenanceSameInstance(
        targetClient,
        maintenanceClient,
        nonce,
      ),
    ).resolves.toBeUndefined();
    expect(targetClient.query).toHaveBeenCalledTimes(2);
    expect(targetClient.query.mock.calls[0]?.[0]).toContain(
      "set_config('application_name'",
    );
    expect(targetClient.query.mock.calls[0]?.[1]).toEqual([marker]);
    expect(targetClient.query.mock.calls[1]?.[1]).toEqual([
      "restore-before-proof",
    ]);
    expect(maintenanceClient.query).toHaveBeenCalledOnce();
    expect(maintenanceClient.query.mock.calls[0]?.[0]).toContain(
      "pg_stat_activity",
    );
    expect(maintenanceClient.query.mock.calls[0]?.[1]?.[0]).toBe(101);
  });

  it("rejects a cloned foreign instance and restores the target marker", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const nonce = "b".repeat(64);
    const marker = `codestead-restore-v1:${nonce.slice(0, 40)}`;
    const targetClient = {
      query: vi.fn(async (_sql: string, _parameters?: unknown[]) => {
        void _sql;
        void _parameters;
        if (targetClient.query.mock.calls.length === 1) {
          return {
            rows: [
              {
                application_name: marker,
                backend_pid: 202,
                database_name: "learncoding_restore_target",
                previous_application_name: "restore-before-proof",
                user_name: "codestead_restore",
              },
            ],
          };
        }
        return { rows: [{ application_name: "restore-before-proof" }] };
      }),
    };
    const maintenanceClient = {
      query: vi.fn(async () => ({
        rows: [
          {
            application_name: "codestead-restore-v1:foreign",
            database_name: "learncoding_restore_target",
            user_name: "codestead_restore",
          },
        ],
      })),
    };

    await expect(
      databaseRoleBootstrap!.proveRestoredNoAclMaintenanceSameInstance(
        targetClient,
        maintenanceClient,
        nonce,
      ),
    ).rejects.toThrowError(
      "restored-no-acl maintenance instance verification failed",
    );
    expect(targetClient.query).toHaveBeenCalledTimes(2);
    expect(maintenanceClient.query).toHaveBeenCalledOnce();
    expect(targetClient.query.mock.calls.at(-1)?.[0]).toContain(
      "set_config('application_name'",
    );
    expect(targetClient.query.mock.calls.at(-1)?.[1]).toEqual([
      "restore-before-proof",
    ]);
  });

  it("makes acknowledged database re-enable the final fallible database action", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const queries: string[] = [];
    const maintenancePool = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("select database.datallowconn")) {
          return {
            rows: [{ allow_connections: false, other_sessions: 0 }],
          };
        }
        if (sql.includes("with allow_connections true")) {
          return { rows: [] };
        }
        throw new Error("unexpected maintenance query after re-enable");
      }),
    };

    await expect(
      databaseRoleBootstrap!.reenableRestoredNoAclDatabase(
        maintenancePool,
        "learncoding_restore_target",
        101,
      ),
    ).resolves.toBeUndefined();
    expect(queries).toHaveLength(2);
    expect(queries.at(-1)).toContain("with allow_connections true");
  });

  it("re-quarantines an uncertain database re-enable before rejecting", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const primary = new Error("simulated re-enable acknowledgement loss");
    const queries: string[] = [];
    let stateReads = 0;
    const maintenancePool = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("select database.datallowconn")) {
          stateReads += 1;
          return {
            rows: [{ allow_connections: false, other_sessions: 0 }],
          };
        }
        if (sql.includes("with allow_connections true")) {
          throw primary;
        }
        if (
          sql.includes("with allow_connections false") ||
          sql.includes("pg_terminate_backend") ||
          sql.includes("pg_stat_clear_snapshot")
        ) {
          return { rows: [] };
        }
        throw new Error("unexpected re-quarantine query");
      }),
    };

    await expect(
      databaseRoleBootstrap!.reenableRestoredNoAclDatabase(
        maintenancePool,
        "learncoding_restore_target",
        101,
      ),
    ).rejects.toBe(primary);
    expect(stateReads).toBe(2);
    const reenable = queries.findIndex((query) =>
      query.includes("with allow_connections true"),
    );
    const requarantine = queries.findIndex((query) =>
      query.includes("with allow_connections false"),
    );
    expect(reenable).toBeGreaterThanOrEqual(0);
    expect(requarantine).toBeGreaterThan(reenable);
  });

  it("keeps restored no-ACL bootstrap on the shared exact manifest path", async () => {
    const [{ readFile }, { join }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    const source = await readFile(
      join(process.cwd(), "scripts", "bootstrap-database-roles.mjs"),
      "utf8",
    );
    expect(source).not.toMatch(
      /applyDatabaseRolePrivilegeReconciliation|reconcileRestoredNoAclDatabaseRolePrivileges/u,
    );
    expect(source).not.toMatch(/\bon\s+all\s+(tables|sequences|routines)\b/iu);

    const bootstrapStart = source.indexOf(
      "export async function runDatabaseRoleBootstrap(options) {",
    );
    const bootstrapEnd = source.indexOf(
      "\nasync function main()",
      bootstrapStart,
    );
    const bootstrap = source.slice(bootstrapStart, bootstrapEnd);
    const structure = bootstrap.indexOf(
      "await verifyRestoredNoAclStructureBeforeReconciliation(",
    );
    const strictRoutineGate = bootstrap.indexOf(
      "await verifyAndRepairReviewedPhaseRoutinePrivileges(",
    );
    const roleReset = bootstrap.indexOf("await createAndResetRoles(client)");
    const transfer = bootstrap.indexOf(
      "await transferBootstrapDatabaseRuntimeCapabilityOwnership(",
      roleReset,
    );
    const reconcile = bootstrap.indexOf(
      "await reconcileBootstrapDatabaseRuntimeCapabilities(",
      transfer,
    );
    const foundation = bootstrap.indexOf(
      "await establishBootstrapDatabaseRuntimeCapabilityFoundation(",
      reconcile,
    );
    const postRepairReviewed = bootstrap.indexOf(
      "await verifyPostMigrationReviewedContractsBeforeReconciliation(",
      foundation,
    );
    const exactVerify = bootstrap.indexOf(
      "await verifyBootstrapDatabaseRuntimeCapabilities(",
      postRepairReviewed,
    );
    const strictState = bootstrap.indexOf(
      "await verifyDatabaseRoleBootstrapState(",
      exactVerify,
    );
    expect(bootstrapStart).toBeGreaterThanOrEqual(0);
    expect(structure).toBeGreaterThanOrEqual(0);
    expect(strictRoutineGate).toBeGreaterThan(structure);
    expect(roleReset).toBeGreaterThan(strictRoutineGate);
    expect(transfer).toBeGreaterThan(roleReset);
    expect(reconcile).toBeGreaterThan(transfer);
    expect(foundation).toBeGreaterThan(reconcile);
    expect(postRepairReviewed).toBeGreaterThan(foundation);
    expect(exactVerify).toBeGreaterThan(postRepairReviewed);
    expect(strictState).toBeGreaterThan(exactVerify);
    expect(bootstrap).toContain("restored-capability-foundation");
  });

  it("quarantines a restored database through structural and strict reconciliation", async () => {
    const [{ readFile }, { join }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    const source = await readFile(
      join(process.cwd(), "scripts", "bootstrap-database-roles.mjs"),
      "utf8",
    );
    const start = source.indexOf(
      "export async function runDatabaseRoleBootstrap",
    );
    const end = source.indexOf("\nasync function main()", start);
    const bootstrap = source.slice(start, end);
    const quarantineStart = source.indexOf(
      "async function restoredNoAclDatabaseConnectionState(",
    );
    const quarantineEnd = source.indexOf(
      "\nasync function verifyRestoredNoAclStructureBeforeReconciliation(",
      quarantineStart,
    );
    const quarantine = source.slice(quarantineStart, quarantineEnd);
    const positions = {
      lock: bootstrap.indexOf("await acquireDatabaseAdministrationLock("),
      quarantine: bootstrap.indexOf("await quarantineRestoredNoAclDatabase("),
      cleanup: bootstrap.indexOf(
        "const cleanupFailures = await collectDatabaseBootstrapCleanupFailures(",
      ),
      begin: bootstrap.indexOf(
        'await beginDatabaseBootstrapTransaction(client, "activation")',
      ),
      structure: bootstrap.indexOf(
        "await verifyRestoredNoAclStructureBeforeReconciliation(",
      ),
      reconcile: bootstrap.indexOf(
        "await reconcileBootstrapDatabaseRuntimeCapabilities(",
      ),
      commit: bootstrap.indexOf(
        'await commitDatabaseBootstrapTransaction(client, "activation")',
      ),
      committedLedger: bootstrap.lastIndexOf(
        "await verifyAppliedMigrationLedger(",
      ),
      reenable: bootstrap.indexOf("await reenableRestoredNoAclDatabase("),
    };
    expect(Object.values(positions).every((position) => position >= 0)).toBe(
      true,
    );
    expect(positions.lock).toBeLessThan(positions.quarantine);
    expect(positions.quarantine).toBeLessThan(positions.begin);
    expect(positions.begin).toBeLessThan(positions.structure);
    expect(positions.structure).toBeLessThan(positions.reconcile);
    expect(positions.reconcile).toBeLessThan(positions.commit);
    expect(positions.commit).toBeLessThan(positions.committedLedger);
    expect(positions.committedLedger).toBeLessThan(positions.cleanup);
    expect(positions.cleanup).toBeLessThan(positions.reenable);
    expect(bootstrap).toContain("clusterAdministrationPool");
    expect(bootstrap).toContain(
      "clusterAdministrationClient = await checkoutDatabaseBootstrapClient(",
    );
    expect(bootstrap).toContain(
      "const maintenanceIdentity = await clusterAdministrationClient.query(",
    );
    expect(bootstrap).toContain(
      "await proveRestoredNoAclMaintenanceSameInstance(",
    );
    expect(bootstrap).toMatch(
      /await quarantineRestoredNoAclDatabase\(\s*clusterAdministrationClient,/u,
    );
    expect(bootstrap).toMatch(
      /await reenableRestoredNoAclDatabase\(\s*clusterAdministrationClient,/u,
    );
    expect(bootstrap).not.toContain("clusterAdministrationPool.query(");
    expect(bootstrap).toMatch(
      /client:\s*clusterAdministrationClient,\s*pool:\s*clusterAdministrationPool,/u,
    );
    expect(bootstrap).toContain(
      "cleanupFailures.push(...clusterCleanupFailures)",
    );
    expect(bootstrap).toContain("identityRow.backend_pid");
    expect(quarantine).toContain("activity.pid <> $2");
    expect(quarantine).not.toContain(
      "database.datname = pg_catalog.current_database()",
    );
    expect(
      bootstrap.match(/await reenableRestoredNoAclDatabase\(/gu),
    ).toHaveLength(1);
  });

  it("closes a restored database before boundedly draining every other backend", async () => {
    const [{ readFile }, { join }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    const source = await readFile(
      join(process.cwd(), "scripts", "bootstrap-database-roles.mjs"),
      "utf8",
    );
    const start = source.indexOf(
      "async function quarantineRestoredNoAclDatabase(",
    );
    const end = source.indexOf(
      "\nasync function forceRestoredNoAclDatabaseQuarantine(",
      start,
    );
    const quarantine = source.slice(start, end);
    const disable = quarantine.indexOf("with allow_connections false");
    const terminate = quarantine.indexOf("pg_terminate_backend(");
    const poll = quarantine.indexOf(
      "restoredNoAclDatabaseConnectionState(",
      terminate,
    );

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(disable).toBeGreaterThanOrEqual(0);
    expect(terminate).toBeGreaterThan(disable);
    expect(poll).toBeGreaterThan(terminate);
    expect(quarantine).toContain("MAX_SESSION_DRAIN_MS");
    expect(quarantine).toContain("SESSION_DRAIN_POLL_MS");
    expect(quarantine).toContain("pg_stat_clear_snapshot()");
    expect(quarantine).toMatch(
      /activity\.datid\s*=\s*\(\s*select database\.oid[\s\S]*database\.datname\s*=\s*\$1[\s\S]*activity\.pid\s*<>\s*\$2/u,
    );
    expect(quarantine).toContain("maintenancePool.query(");
    expect(quarantine).not.toContain("before.other_sessions !== 0");
  });

  it("reconciles the exact reviewed mail-authority routines without blanket authority", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();

    expect(databaseRoleBootstrap).not.toBeNull();
    const routines = databaseRoleBootstrap!.REVIEWED_APPLICATION_FUNCTIONS;
    expect(
      routines.map(
        ({
          signature,
          owner,
          securityDefiner,
          configuration,
          allowedRoles,
        }) => ({
          signature,
          owner,
          securityDefiner,
          configuration,
          allowedRoles,
        }),
      ),
    ).toEqual([
      {
        signature:
          "public.enqueue_reward_jobs_for_attempt_v1(uuid,text,timestamp with time zone)",
        owner: "learncoding_owner",
        securityDefiner: false,
        configuration: null,
        allowedRoles: ["learncoding_app", "learncoding_worker"],
      },
      {
        signature:
          "public.enqueue_reward_jobs_for_mastery_scope_v1(uuid,text,timestamp with time zone)",
        owner: "learncoding_owner",
        securityDefiner: false,
        configuration: null,
        allowedRoles: ["learncoding_app", "learncoding_worker"],
      },
      {
        signature:
          "public.redact_unresolved_email_outbox_authority(timestamp with time zone,integer)",
        owner: "learncoding_owner",
        securityDefiner: true,
        configuration: ["search_path=pg_catalog"],
        allowedRoles: ["learncoding_ops"],
      },
      {
        signature:
          "public.classify_email_outbox_retention_redaction(public.email_outbox,timestamp with time zone)",
        owner: "learncoding_owner",
        securityDefiner: true,
        configuration: ["search_path=pg_catalog"],
        allowedRoles: [],
      },
      {
        signature: "public.enforce_email_outbox_payload_immutable()",
        owner: "learncoding_owner",
        securityDefiner: false,
        configuration: ["search_path=pg_catalog"],
        allowedRoles: [],
      },
      {
        signature: "public.enforce_email_outbox_dispatch_binding()",
        owner: "learncoding_owner",
        securityDefiner: false,
        configuration: ["search_path=pg_catalog"],
        allowedRoles: [],
      },
      {
        signature: "public.reject_backup_status_mail_authority_mutation()",
        owner: "learncoding_owner",
        securityDefiner: false,
        configuration: ["search_path=pg_catalog"],
        allowedRoles: [],
      },
      {
        signature: "public.lock_backup_status_mail_admin_authority()",
        owner: "learncoding_owner",
        securityDefiner: true,
        configuration: ["search_path=pg_catalog"],
        allowedRoles: [],
      },
      {
        signature: "public.enqueue_backup_status_mail_authority(text,text)",
        owner: "learncoding_owner",
        securityDefiner: true,
        configuration: ["search_path=pg_catalog, pg_temp"],
        allowedRoles: ["learncoding_backup_reporter"],
      },
      {
        signature: "public.backup_status_mail_authorized(uuid)",
        owner: "learncoding_owner",
        securityDefiner: true,
        configuration: ["search_path=pg_catalog"],
        allowedRoles: ["learncoding_worker"],
      },
      {
        signature:
          "public.enforce_email_outbox_provider_correlation_evidence()",
        owner: "learncoding_owner",
        securityDefiner: false,
        configuration: ["search_path=pg_catalog"],
        allowedRoles: [],
      },
      {
        signature:
          "public.email_outbox_original_payload_sha256(text,text,text,text,jsonb)",
        owner: "learncoding_owner",
        securityDefiner: true,
        configuration: ["search_path=pg_catalog, pg_temp"],
        allowedRoles: [],
      },
      {
        signature: "public.email_outbox_event_sha256(text,text,text)",
        owner: "learncoding_owner",
        securityDefiner: true,
        configuration: ["search_path=pg_catalog, pg_temp"],
        allowedRoles: [],
      },
      {
        signature: "public.claim_email_outbox_idempotency_authority()",
        owner: "learncoding_owner",
        securityDefiner: true,
        configuration: ["search_path=pg_catalog, pg_temp"],
        allowedRoles: [],
      },
      {
        signature: "public.persist_email_outbox_idempotency_authority()",
        owner: "learncoding_owner",
        securityDefiner: true,
        configuration: ["search_path=pg_catalog, pg_temp"],
        allowedRoles: [],
      },
      {
        signature:
          "public.enforce_email_outbox_idempotency_metadata_immutable()",
        owner: "learncoding_owner",
        securityDefiner: true,
        configuration: ["search_path=pg_catalog, pg_temp"],
        allowedRoles: [],
      },
      {
        signature: "public.enforce_email_outbox_idempotency_append_only()",
        owner: "learncoding_owner",
        securityDefiner: true,
        configuration: ["search_path=pg_catalog, pg_temp"],
        allowedRoles: [],
      },
      {
        signature: "public.email_outbox_idempotency_coverage_authority(uuid[])",
        owner: "learncoding_owner",
        securityDefiner: true,
        configuration: ["search_path=pg_catalog, pg_temp"],
        allowedRoles: ["learncoding_ops"],
      },
      {
        signature: "public.enforce_email_outbox_delivery_hold()",
        owner: "learncoding_owner",
        securityDefiner: true,
        configuration: ["search_path=pg_catalog, pg_temp"],
        allowedRoles: [],
      },
    ]);
    for (const routine of routines) {
      expect(routine.bodySha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(routine.language).toMatch(/^(?:plpgsql|sql)$/u);
      expect(routine.kind).toBe("f");
      expect(routine.argumentDefaultCount).toBe(0);
      expect(routine.variadic).toBe(false);
    }
    expect(
      routines
        .filter(({ language }) => language === "sql")
        .map(({ signature }) => signature),
    ).toEqual([
      "public.email_outbox_original_payload_sha256(text,text,text,text,jsonb)",
      "public.email_outbox_event_sha256(text,text,text)",
    ]);
    expect(
      routines.find(
        ({ signature }) =>
          signature ===
          "public.redact_unresolved_email_outbox_authority(timestamp with time zone,integer)",
      ),
    ).toMatchObject({
      argumentNames: [
        "cutoff_at",
        "batch_limit",
        "disposition",
        "eligible",
        "transitioned",
      ],
      argumentModes: ["i", "i", "t", "t", "t"],
      argumentTypes: [
        "timestamp with time zone",
        "integer",
        "text",
        "bigint",
        "bigint",
      ],
      inputArgumentCount: 2,
      returnType: "record",
      returnsSet: true,
    });
    const reviewedPhase0067 =
      databaseRoleBootstrap!.REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.find(
        ({ index }) => index === 67,
      );
    expect(reviewedPhase0067?.index).toBe(67);
    const reviewedGrant = databaseRoleBootstrap!
      .reviewedApplicationFunctionPrivilegesSql(reviewedPhase0067)
      .toLowerCase();
    expect(reviewedGrant).toContain(
      "grant execute on function public.redact_unresolved_email_outbox_authority(timestamp with time zone,integer) to learncoding_ops",
    );
    expect(reviewedGrant).toContain(
      "grant execute on function public.enqueue_backup_status_mail_authority(text,text) to learncoding_backup_reporter",
    );
    expect(reviewedGrant).toContain(
      "grant execute on function public.backup_status_mail_authorized(uuid) to learncoding_worker",
    );
    expect(reviewedGrant).toContain(
      "grant execute on function public.email_outbox_idempotency_coverage_authority(uuid[]) to learncoding_ops",
    );
    for (const signature of [
      "public.enqueue_reward_jobs_for_attempt_v1(uuid,text,timestamp with time zone)",
      "public.enqueue_reward_jobs_for_mastery_scope_v1(uuid,text,timestamp with time zone)",
    ]) {
      expect(reviewedGrant).toContain(
        `grant execute on function ${signature} to learncoding_app`,
      );
      expect(reviewedGrant).toContain(
        `grant execute on function ${signature} to learncoding_worker`,
      );
    }
    expect(reviewedGrant).not.toMatch(/to\s+(public|learncoding_migrator)\b/iu);

    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile("scripts/bootstrap-database-roles.mjs", "utf8"),
    );
    expect(source).not.toMatch(/\bon\s+all\s+(tables|sequences|routines)\b/iu);
    const reconcile = source.indexOf(
      "await reconcileBootstrapDatabaseRuntimeCapabilities(",
    );
    const exactVerify = source.indexOf(
      "await verifyBootstrapDatabaseRuntimeCapabilities(",
      reconcile,
    );
    expect(reconcile).toBeGreaterThanOrEqual(0);
    expect(exactVerify).toBeGreaterThan(reconcile);
    expect(source).toMatch(/is distinct from exists/iu);
    expect(source).toMatch(/has_function_privilege\(0, p\.oid, 'EXECUTE'\)/u);
    expect(source).toMatch(
      /aclexplode\(\s*coalesce\(p\.proacl,\s*acldefault\('f',\s*p\.proowner\)\)\s*\)/u,
    );
    expect(source).toMatch(
      /aclexplode\(\s*coalesce\(t\.typacl,\s*acldefault\('T',\s*t\.typowner\)\)\s*\)/u,
    );
    expect(source).toContain("routine_direct_acl_exact");
    expect(source).toContain("type_direct_acl_exact");
    expect(source).toMatch(/except[\s\S]+except/iu);
    expect(source).toContain("'MEMBER'");
    expect(source).toContain("'USAGE'");
    expect(source).toContain("'SET'");
  });

  it("wires the real role boundaries into the behavior-tested release cycles", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile("scripts/run-integration-tests.ts", "utf8"),
    );
    const bootstrapSource = await import("node:fs/promises").then(
      ({ readFile }) =>
        readFile("scripts/bootstrap-database-roles.mjs", "utf8"),
    );
    const packageJson = await import("node:fs/promises").then(
      async ({ readFile }) =>
        JSON.parse(await readFile("package.json", "utf8")) as {
          scripts: Record<string, string>;
        },
    );
    const orchestratorIndex = source.indexOf(
      "await runDisposableIntegrationReleaseCycles({",
    );
    const applicationTestMatch =
      /await runNpm\(\[\s*"run",\s*"test:integration:vitest"/u.exec(source);
    const testIndex = applicationTestMatch?.index ?? -1;

    expect(source).toContain("runDatabaseRoleBootstrap");
    expect(source).toContain("verifyDatabaseRoleBoundaries");
    expect(source).toContain("runProductionMigration");
    expect(source).toContain(
      'migrationsFolder: path.resolve(process.cwd(), "drizzle")',
    );
    expect(source).toContain(
      "new Pool({ connectionString: input.databaseUrl, max: 1 })",
    );
    expect(source).toContain("verifyDisposableRoleBoundaryAdapter({");
    expect(source).toContain(
      "const toolEnvironment = buildDisposableToolEnvironment(",
    );
    expect(source).toContain("expectedJournalCount");
    expect(source).toContain("postgresUser: input.integrationUser");
    expect(source).toContain("verifyDatabaseRoleBootstrapState");
    expect(source).toContain(
      "reconcileRoles: () => reconcileDisposableIntegrationRoles(topology)",
    );
    expect(source).toContain("verifyDisposableIntegrationRoleBoundaries({");
    expect(source).toContain(
      "migrate: () => runDisposableIntegrationMigration(roleUrls.migrator)",
    );
    expect(source).toContain(
      "verifyTopology: () => verifyDisposableIntegrationTopology(topology)",
    );
    expect(source).toContain(
      "buildDisposableIntegrationRuntimeEnvironment(process.env, {",
    );
    expect(source).not.toContain("env: process.env");
    expect(source).toContain("ownerAssumingDatabaseUrl(roleUrls.migrator)");
    expect(source).toContain("databaseOwnerUrl: ownerDatabaseUrl");
    expect(source).toContain("databaseAppUrl: roleUrls.app");
    expect(source).toContain("client.release();\n    await pool.end();");
    expect(source).not.toContain("journal_count !== 63");
    expect(source).not.toContain("`POSTGRES_PASSWORD=${password}`");
    expect(source).not.toContain("DATABASE_URL: databaseUrl");
    for (const role of [
      "learncoding_owner",
      "learncoding_migrator",
      "learncoding_app",
      "learncoding_backup_reporter",
      "learncoding_worker",
      "learncoding_ops",
    ]) {
      expect(`${source}\n${bootstrapSource}`).toContain(role);
    }
    expect(orchestratorIndex).toBeGreaterThanOrEqual(0);
    expect(orchestratorIndex).toBeLessThan(testIndex);
    expect(packageJson.scripts["test:integration"]).toBe(
      "tsx scripts/run-integration-tests.ts",
    );
    expect(source).not.toMatch(
      /create role learncoding_(?:owner|migrator|app|worker|ops)/iu,
    );
  });

  it("uses the disposable ops session for ordinary integration retention", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile("integration/postgres.integration.test.ts", "utf8"),
    );
    const opsProofSource = await import("node:fs/promises").then(
      ({ readFile }) =>
        readFile(
          "integration/retention-ops-session.integration.test.ts",
          "utf8",
        ),
    );
    const ownerHelperSource = await import("node:fs/promises").then(
      ({ readFile }) =>
        readFile(
          "integration/support/with-validated-owner-fault-injection.ts",
          "utf8",
        ),
    );
    const dependencyStart = source.indexOf(
      "const integrationRetentionDependencies = {",
    );
    const dependencyEnd = source.indexOf("} as const;", dependencyStart);
    const retentionCalls = [...source.matchAll(/\brunRetention\(/gu)];
    const validatedRetentionCalls = [
      ...source.matchAll(/\brunValidatedIntegrationRetention\(/gu),
    ];

    expect(source).toContain("const integrationRetentionPool = new PgPool({");
    expect(source).toContain(
      "const integrationRetentionFileErasureDependencies = {",
    );
    expect(source).toContain(
      "connectionString: validatedIntegrationEnvironment.databaseOpsUrl",
    );
    expect(source).toContain(
      "endDisposableIntegrationPoolWithinDeadline(integrationRetentionPool)",
    );
    expect(dependencyStart).toBeGreaterThanOrEqual(0);
    expect(dependencyEnd).toBeGreaterThan(dependencyStart);
    expect(source.slice(dependencyStart, dependencyEnd)).toContain(
      "acquireValidatedDisposableRoleClient<PoolClient>(",
    );
    expect(source.slice(dependencyStart, dependencyEnd)).toContain(
      '"learncoding_ops"',
    );
    expect(retentionCalls).toHaveLength(1);
    expect(validatedRetentionCalls).toHaveLength(6);
    const opsProofCalls = [
      ...opsProofSource.matchAll(/(?:\bretention[.])?runRetention\(/gu),
    ];
    expect(opsProofCalls).toHaveLength(2);
    expect(opsProofSource).toMatch(
      /const integrationRetentionDependencies = \{[\s\S]*?acquireClient: \(\) => integrationRetentionPool[.]connect\(\),[\s\S]*?\} as const;/u,
    );
    expect(opsProofSource).toMatch(
      /const report = await runRetention\(\{[\s\S]*?\}, integrationRetentionDependencies\);/u,
    );
    const ownerWrapperStart = opsProofSource.indexOf(
      "const report = await withValidatedOwnerFaultInjection({",
    );
    const ownerWrapperEnd = opsProofSource.indexOf(
      "\n\n          expect(checkpointObserved).toBe(true);",
      ownerWrapperStart,
    );
    expect(ownerWrapperStart).toBeGreaterThanOrEqual(0);
    expect(ownerWrapperEnd).toBeGreaterThan(ownerWrapperStart);
    const ownerWrapper = opsProofSource.slice(
      ownerWrapperStart,
      ownerWrapperEnd,
    );
    expect(ownerWrapper).toContain('context: "Retention-redaction"');
    expect(ownerWrapper).toMatch(
      /installSql: \[[\s\S]*?cleanupSql: \[[\s\S]*?run: \(\) => retention[.]runRetention\(\{/u,
    );
    expect(ownerWrapper).toContain("databaseTarget: databaseOwnerTarget");
    expect(ownerWrapper).toContain("acquireClient: () => opsPool.connect()");
    expect(ownerWrapper).toContain("processFileErasures: async (");
    expect([
      ...opsProofSource.matchAll(/withValidatedOwnerFaultInjection\(/gu),
    ]).toHaveLength(1);
    expect(opsProofSource).not.toContain("DATABASE_OWNER_URL");
    expect(opsProofSource).not.toContain("learncoding_owner");
    expect(opsProofSource).not.toContain("learncoding_migrator");
    expect(ownerHelperSource).toContain(
      'identity.rows[0]?.session_user !== "learncoding_migrator"',
    );
    expect(ownerHelperSource).toContain(
      'identity.rows[0]?.current_user !== "learncoding_owner"',
    );
    expect(opsProofSource).toMatch(
      /const opsPool = new PgPool\(\{[\s\S]*?connectionString: databaseOpsUrl,[\s\S]*?\}\);/u,
    );
    const firstCall = opsProofCalls[0]?.index;
    const secondCall = opsProofCalls[1]?.index;
    expect(firstCall).toBeTypeOf("number");
    expect(secondCall).toBeTypeOf("number");
    expect(firstCall!).toBeLessThan(secondCall!);
    expect(opsProofSource).toContain("select current_user, session_user");
    expect(opsProofSource).toContain("runWithValidatedRetentionOpsEnvironment");
    expect(opsProofSource).toContain("current_database()");

    expect(opsProofSource).toContain('current_user: "learncoding_ops"');
    expect(opsProofSource).toContain('session_user: "learncoding_ops"');
  });

  it("accepts only the fixed role, postgres host, and configured database matrix", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();

    expect(databaseRoleBootstrap).not.toBeNull();
    const parsed = databaseRoleBootstrap!.validateDatabaseRoleUrls(urls);
    expect(
      Object.fromEntries(
        Object.entries(parsed).map(([name, value]) => [
          name,
          [value.username, value.hostname, value.database],
        ]),
      ),
    ).toEqual({
      bootstrap: ["legacy_bootstrap", "postgres", "learncoding"],
      app: ["learncoding_app", "postgres", "learncoding"],
      migrator: ["learncoding_migrator", "postgres", "learncoding"],
      worker: ["learncoding_worker", "postgres", "learncoding"],
      ops: ["learncoding_ops", "postgres", "learncoding"],
      backupReporter: [
        "learncoding_backup_reporter",
        "postgres",
        "learncoding",
      ],
    });
  });

  it.each([
    [
      "bootstrap identity reused as the non-login owner",
      {
        postgresUser: "learncoding_owner",
        databaseBootstrapUrl: urls.databaseBootstrapUrl.replace(
          "legacy_bootstrap",
          "learncoding_owner",
        ),
      },
    ],
    [
      "bootstrap user reused by app",
      { databaseAppUrl: urls.databaseBootstrapUrl },
    ],
    [
      "session-changing query option",
      {
        databaseAppUrl: `${urls.databaseAppUrl}?options=-csearch_path%3Dpublic`,
      },
    ],
    [
      "wrong database host",
      {
        databaseWorkerUrl: urls.databaseWorkerUrl.replace(
          "@postgres:",
          "@localhost:",
        ),
      },
    ],
    [
      "duplicate password",
      {
        databaseOpsUrl: urls.databaseAppUrl.replace(
          "learncoding_app",
          "learncoding_ops",
        ),
      },
    ],
    [
      "short password",
      {
        databaseOpsUrl:
          "postgresql://learncoding_ops:too-short@postgres:5432/learncoding",
      },
    ],
  ])("rejects %s without exposing credentials", async (_name, override) => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();

    expect(databaseRoleBootstrap).not.toBeNull();
    expect(() =>
      databaseRoleBootstrap!.validateDatabaseRoleUrls({ ...urls, ...override }),
    ).toThrow(/database credential configuration is invalid/u);
  });

  it("accepts the fresh pg_database_owner public schema invariant", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();

    expect(databaseRoleBootstrap).not.toBeNull();
    expect(() =>
      databaseRoleBootstrap!.validateOwnershipInventory({
        postgresUser: "legacy_bootstrap",
        postgresDatabase: "learncoding",
        databases: [
          { name: "learncoding", owner: "legacy_bootstrap" },
          { name: "postgres", owner: "legacy_bootstrap" },
          { name: "template0", owner: "legacy_bootstrap" },
          { name: "template1", owner: "legacy_bootstrap" },
        ],
        tablespaces: [
          { name: "pg_default", owner: "legacy_bootstrap" },
          { name: "pg_global", owner: "legacy_bootstrap" },
        ],
        schemas: [{ name: "public", owner: "pg_database_owner" }],
        objects: [],
      }),
    ).not.toThrow();
  });

  it("accepts the reconciled migrator CONNECT ACL on an idempotent rerun", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();

    expect(databaseRoleBootstrap).not.toBeNull();
    expect(() =>
      databaseRoleBootstrap!.validateOwnershipInventory({
        postgresUser: "legacy_bootstrap",
        postgresDatabase: "learncoding",
        databases: [{ name: "learncoding", owner: "learncoding_owner" }],
        tablespaces: [],
        schemas: [{ name: "public", owner: "learncoding_owner" }],
        objects: [],
        directAcls: [
          {
            scope: "schema public",
            grantee: "PUBLIC",
            privilege: "USAGE",
            isGrantable: false,
          },
          {
            scope: "database learncoding",
            grantee: "learncoding_migrator",
            privilege: "CONNECT",
            isGrantable: false,
          },
        ],
      }),
    ).not.toThrow();
  });

  it("admits only globally repairable routine/type ACL drift before scrub", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const base = {
      postgresUser: "legacy_bootstrap",
      postgresDatabase: "learncoding",
      databases: [{ name: "learncoding", owner: "legacy_bootstrap" }],
      tablespaces: [],
      schemas: [{ name: "public", owner: "pg_database_owner" }],
      objects: [],
    };
    expect(() =>
      databaseRoleBootstrap!.validateOwnershipInventory({
        ...base,
        defaultAcls: [
          {
            schema: "<global>",
            owner: "learncoding_owner",
            grantee: "delegated_leaf",
            grantee_oid: 16_384,
            is_public: false,
            kind: "f",
            privilege_type: "EXECUTE",
            is_grantable: false,
          },
          {
            schema: "<global>",
            owner: "legacy_bootstrap",
            grantee: "PUBLIC",
            grantee_oid: 0,
            is_public: true,
            kind: "T",
            privilege_type: "USAGE",
            is_grantable: true,
          },
        ],
      }),
    ).not.toThrow();
    for (const defaultAcls of [
      [
        {
          schema: "<global>",
          owner: "learncoding_owner",
          grantee: "PUBLIC",
          grantee_oid: 16_385,
          is_public: false,
          kind: "f",
          privilege_type: "EXECUTE",
          is_grantable: false,
        },
      ],
      [
        {
          schema: "<global>",
          owner: "learncoding_owner",
          grantee: "delegated_leaf",
          grantee_oid: 16_384,
          is_public: false,
          kind: "r",
          privilege_type: "SELECT",
          is_grantable: false,
        },
      ],
      [
        {
          schema: "<global>",
          owner: "learncoding_owner",
          grantee: "delegated_leaf",
          grantee_oid: 16_384,
          is_public: false,
          kind: "S",
          privilege_type: "USAGE",
          is_grantable: false,
        },
      ],
      [
        {
          schema: "public",
          owner: "learncoding_owner",
          grantee: "delegated_leaf",
          grantee_oid: 16_384,
          is_public: false,
          kind: "f",
          privilege_type: "EXECUTE",
          is_grantable: false,
        },
      ],
      [
        {
          schema: "<global>",
          owner: "unreviewed_creator",
          grantee: "PUBLIC",
          grantee_oid: 0,
          is_public: true,
          kind: "f",
          privilege_type: "EXECUTE",
          is_grantable: false,
        },
      ],
    ]) {
      expect(() =>
        databaseRoleBootstrap!.validateOwnershipInventory({
          ...base,
          defaultAcls,
        }),
      ).toThrow(/unsafe legacy ownership inventory/u);
    }
  });

  it.each([
    [
      "decoy database",
      { databases: [{ name: "decoy", owner: "legacy_bootstrap" }] },
    ],
    [
      "decoy tablespace",
      { tablespaces: [{ name: "decoy_space", owner: "legacy_bootstrap" }] },
    ],
    [
      "out-of-scope schema",
      { schemas: [{ name: "decoy", owner: "legacy_bootstrap" }] },
    ],
    [
      "externally owned out-of-scope schema",
      {
        schemas: [
          { name: "public", owner: "pg_database_owner" },
          { name: "decoy", owner: "external_owner" },
        ],
      },
    ],
    [
      "externally owned public schema",
      { schemas: [{ name: "public", owner: "external_owner" }] },
    ],
    [
      "invalidly owned drizzle schema",
      {
        schemas: [
          { name: "public", owner: "pg_database_owner" },
          { name: "drizzle", owner: "pg_database_owner" },
        ],
      },
    ],
    [
      "unsupported owner-bearing catalog object",
      {
        unexpectedOwnerDependencies: [
          { catalog: "pg_collation", objectId: "decoy_oid" },
        ],
      },
    ],
    [
      "external direct ACL grantee",
      {
        directAcls: [
          {
            scope: "table public.lesson",
            grantee: "legacy_reader",
            privilege: "SELECT",
          },
        ],
      },
    ],
    [
      "grantable direct ACL",
      {
        directAcls: [
          {
            scope: "table public.lesson",
            grantee: "learncoding_app",
            privilege: "SELECT",
            isGrantable: true,
          },
        ],
      },
    ],
  ])("fails before mutation for a %s", async (_name, override) => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();

    expect(databaseRoleBootstrap).not.toBeNull();
    expect(() =>
      databaseRoleBootstrap!.validateOwnershipInventory({
        postgresUser: "legacy_bootstrap",
        postgresDatabase: "learncoding",
        databases: [{ name: "learncoding", owner: "legacy_bootstrap" }],
        tablespaces: [],
        schemas: [{ name: "public", owner: "pg_database_owner" }],
        objects: [],
        ...override,
      }),
    ).toThrow(/unsafe legacy ownership inventory/u);
  });

  it("repeatedly terminates and drains managed login sessions to an exact zero", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const remaining = [2, 1, 0];
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, parameters?: unknown[]) => {
        queries.push(sql);
        if (sql.includes("pg_terminate_backend")) {
          expect(parameters).toEqual([
            [
              "learncoding_migrator",
              "learncoding_app",
              "learncoding_worker",
              "learncoding_ops",
              "learncoding_backup_reporter",
            ],
          ]);
          return { rows: [] };
        }
        if (sql === "select pg_catalog.pg_stat_clear_snapshot()") {
          return { rows: [{ pg_stat_clear_snapshot: null }] };
        }
        if (sql.includes("count(*)::integer remaining")) {
          return { rows: [{ remaining: remaining.shift() }] };
        }
        throw new Error(`unexpected session drain query: ${sql}`);
      }),
    };

    await expect(
      databaseRoleBootstrap!.terminateAndDrainManagedLoginRoleSessions(client, {
        timeoutMs: 1_000,
      }),
    ).resolves.toBe(true);
    expect(remaining).toEqual([]);
    expect(
      queries.filter((query) => query.includes("pg_terminate_backend")),
    ).toHaveLength(3);
    expect(queries).toEqual([
      expect.stringContaining("pg_terminate_backend"),
      "select pg_catalog.pg_stat_clear_snapshot()",
      expect.stringContaining("count(*)::integer remaining"),
      expect.stringContaining("pg_terminate_backend"),
      "select pg_catalog.pg_stat_clear_snapshot()",
      expect.stringContaining("count(*)::integer remaining"),
      expect.stringContaining("pg_terminate_backend"),
      "select pg_catalog.pg_stat_clear_snapshot()",
      expect.stringContaining("count(*)::integer remaining"),
    ]);
  });

  it("rejects malformed or non-draining managed-session evidence", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();

    for (const rows of [
      [],
      [{ remaining: -1 }],
      [{ remaining: "0" }],
      [{ remaining: 0 }, { remaining: 0 }],
    ]) {
      const client = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("pg_terminate_backend")) return { rows: [] };
          if (sql === "select pg_catalog.pg_stat_clear_snapshot()") {
            return { rows: [] };
          }
          return { rows };
        }),
      };
      await expect(
        databaseRoleBootstrap!.terminateAndDrainManagedLoginRoleSessions(
          client,
          { timeoutMs: 50 },
        ),
      ).rejects.toThrow(/database role session evidence is invalid/u);
    }

    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_terminate_backend")) return { rows: [] };
        if (sql === "select pg_catalog.pg_stat_clear_snapshot()") {
          return { rows: [] };
        }
        return { rows: [{ remaining: 1 }] };
      }),
    };
    await expect(
      databaseRoleBootstrap!.terminateAndDrainManagedLoginRoleSessions(client, {
        timeoutMs: 1,
      }),
    ).rejects.toThrow(/database role sessions remain active/u);
  });

  it("reads one bounded PostgreSQL 17 or 18 authentication fence setting with zero auth delays", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const query = vi.fn(async (_sql: string) => {
      void _sql;
      return {
        rows: [
          {
          authentication_timeout_ms: 60_000,
          pre_auth_delay_ms: 0,
          post_auth_delay_ms: 0,
          server_version_num: 170_006,
          },
        ],
      };
    });

    await expect(
      databaseRoleBootstrap!.readDatabaseAuthenticationFenceSettings({ query }),
    ).resolves.toEqual({
      authenticationTimeoutMs: 60_000,
      preAuthDelayMs: 0,
      postAuthDelayMs: 0,
      serverVersionNum: 170_006,
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain(
      "current_setting('authentication_timeout')",
    );
    expect(query.mock.calls[0]?.[0]).toContain(
      "current_setting('pre_auth_delay')",
    );
    expect(query.mock.calls[0]?.[0]).toContain(
      "current_setting('post_auth_delay')",
    );
    expect(query.mock.calls[0]?.[0]).toContain(
      "current_setting('server_version_num')",
    );

    for (const rows of [
      [],
      [
        {
          authentication_timeout_ms: 0,
          pre_auth_delay_ms: 0,
          post_auth_delay_ms: 0,
          server_version_num: 170_006,
        },
      ],
      [
        {
          authentication_timeout_ms: 600_001,
          pre_auth_delay_ms: 0,
          post_auth_delay_ms: 0,
          server_version_num: 170_006,
        },
      ],
      [
        {
          authentication_timeout_ms: 60_000,
          pre_auth_delay_ms: 1,
          post_auth_delay_ms: 0,
          server_version_num: 170_006,
        },
      ],
      [
        {
          authentication_timeout_ms: 60_000,
          pre_auth_delay_ms: 0,
          post_auth_delay_ms: 1,
          server_version_num: 170_006,
        },
      ],
      [
        {
          authentication_timeout_ms: 60_000,
          pre_auth_delay_ms: 0,
          post_auth_delay_ms: 0,
          server_version_num: 160_010,
        },
      ],
      [
        {
          authentication_timeout_ms: 60_000,
          pre_auth_delay_ms: 0,
          post_auth_delay_ms: 0,
          server_version_num: 190_000,
        },
      ],
      [
        {
          authentication_timeout_ms: 60_000,
          pre_auth_delay_ms: 0,
          post_auth_delay_ms: 0,
          server_version_num: 180_001,
        },
        {
          authentication_timeout_ms: 60_000,
          pre_auth_delay_ms: 0,
          post_auth_delay_ms: 0,
          server_version_num: 180_001,
        },
      ],
    ]) {
      await expect(
        databaseRoleBootstrap!.readDatabaseAuthenticationFenceSettings({
          query: vi.fn(async () => ({ rows })),
        }),
      ).rejects.toThrow(/database authentication fence evidence is invalid/u);
    }
  });

  it("rejects external login principals with effective SET paths into managed roles", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const safeQuery = vi.fn(async (_sql: string) => {
      void _sql;
      return { rows: [] };
    });
    await expect(
      databaseRoleBootstrap!.verifyNoExternalManagedRoleSetPaths({
        query: safeQuery,
      }),
    ).resolves.toBe(true);
    expect(safeQuery).toHaveBeenCalledOnce();
    expect(safeQuery.mock.calls[0]?.[0]).toContain("pg_has_role");
    expect(safeQuery.mock.calls[0]?.[0]).toContain("principal.rolcanlogin");
    expect(safeQuery.mock.calls[0]?.[0]).toContain("not principal.rolsuper");

    await expect(
      databaseRoleBootstrap!.verifyNoExternalManagedRoleSetPaths({
        query: vi.fn(async () => ({
          rows: [
            {
              principal_role: "external_login",
              managed_role: "learncoding_owner",
            },
          ],
        })),
      }),
    ).rejects.toThrow(
      "unexpected external SET ROLE authority reaches a managed role",
    );
  });

  it("revalidates fence settings and the committed quarantine after the horizon", async () => {
    const [{ readFile }, { join }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    const source = await readFile(
      join(process.cwd(), "scripts", "bootstrap-database-roles.mjs"),
      "utf8",
    );
    const start = source.indexOf(
      "export async function runDatabaseRoleBootstrap(options) {",
    );
    const end = source.indexOf("\nasync function main()", start);
    const run = source.slice(start, end);
    const externalSetPathGate = run.indexOf(
      "await verifyNoExternalManagedRoleSetPaths(client)",
    );
    const gate = run.indexOf(
      "await commitManagedRoleAuthenticationGate(client)",
      externalSetPathGate,
    );
    const horizon = run.indexOf(
      "await exhaustManagedRoleAuthenticationFence(",
      gate,
    );
    const postHorizonSettings = run.indexOf(
      "const postHorizonAuthenticationFenceSettings =",
      horizon,
    );
    const postHorizonGate = run.indexOf(
      "await verifyManagedRoleAuthenticationGate(client)",
      postHorizonSettings,
    );
    const activationBegin = run.indexOf(
      'await beginDatabaseBootstrapTransaction(client, "activation")',
      postHorizonGate,
    );
    expect(externalSetPathGate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(externalSetPathGate);
    expect(horizon).toBeGreaterThan(gate);
    expect(postHorizonSettings).toBeGreaterThan(horizon);
    expect(postHorizonGate).toBeGreaterThan(postHorizonSettings);
    expect(activationBegin).toBeGreaterThan(postHorizonGate);
  });

  it("commits a stripped NOLOGIN and PASSWORD NULL quarantine before exposing any LOGIN", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const queries: Array<{ sql: string; parameters?: unknown[] }> = [];
    const expectedRoleRows = [
      {
        rolname: "learncoding_app",
        rolcanlogin: false,
        password_is_null: true,
        password_is_scram: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
        rolconnlimit: -1,
      },
      {
        rolname: "learncoding_backup_reporter",
        rolcanlogin: false,
        password_is_null: true,
        password_is_scram: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
        rolconnlimit: -1,
      },
      {
        rolname: "learncoding_migrator",
        rolcanlogin: false,
        password_is_null: true,
        password_is_scram: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
        rolconnlimit: -1,
      },
      {
        rolname: "learncoding_ops",
        rolcanlogin: false,
        password_is_null: true,
        password_is_scram: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
        rolconnlimit: -1,
      },
      {
        rolname: "learncoding_owner",
        rolcanlogin: false,
        password_is_null: true,
        password_is_scram: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
        rolconnlimit: -1,
      },
      {
        rolname: "learncoding_worker",
        rolcanlogin: false,
        password_is_null: true,
        password_is_scram: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
        rolconnlimit: -1,
      },
    ];
    const client = {
      query: vi.fn(async (sql: string, parameters?: unknown[]) => {
        queries.push({ sql, parameters });
        if (sql === "begin") return { rows: [], command: "BEGIN" };
        if (sql === "commit") return { rows: [], command: "COMMIT" };
        if (sql.includes("from pg_catalog.pg_authid")) {
          return { rows: expectedRoleRows };
        }
        return { rows: [] };
      }),
    };
    await expect(
      databaseRoleBootstrap!.commitManagedRoleAuthenticationGate(client),
    ).resolves.toBe(true);

    const normalized = queries.map(({ sql }) =>
      sql.replace(/\s+/gu, " ").trim().toLowerCase(),
    );
    expect(normalized[0]).toBe("begin");
    const gateCommit = normalized.indexOf("commit");
    expect(gateCommit).toBeGreaterThan(0);
    expect(normalized.at(-1)).toContain("from pg_catalog.pg_authid");
    expect(
      normalized
        .slice(0, gateCommit)
        .some((sql) => /\balter role\b[\s\S]*\bnologin\b/u.test(sql)),
    ).toBe(true);
    expect(
      normalized
        .slice(0, gateCommit)
        .some((sql) => /\balter role\b[\s\S]*\blogin\b/u.test(sql)),
    ).toBe(false);
    expect(normalized.slice(0, gateCommit).join("\n")).not.toContain(
      "codestead.role_password",
    );
    expect(normalized.slice(0, gateCommit).join("\n")).not.toContain(
      "password_encryption",
    );
    expect(normalized.slice(0, gateCommit).join("\n")).not.toContain(
      "pg_auth_members",
    );
    expect(normalized.slice(0, gateCommit).join("\n")).not.toContain(
      "grant learncoding_owner to learncoding_migrator",
    );
    expect(normalized.slice(0, gateCommit).join("\n")).not.toContain(
      "reset all",
    );
    for (const role of [
      "learncoding_owner",
      "learncoding_migrator",
      "learncoding_app",
      "learncoding_worker",
      "learncoding_ops",
      "learncoding_backup_reporter",
    ]) {
      expect(
        normalized
          .slice(0, gateCommit)
          .some(
            (sql) =>
              sql.includes(`alter role ${role}`) &&
              sql.includes("nologin") &&
              sql.includes("password null"),
          ),
      ).toBe(true);
    }
    expect(
      normalized
        .slice(0, gateCommit)
        .filter((sql) => sql.includes("from pg_catalog.pg_authid")),
    ).toHaveLength(1);
  });

  it("rolls back a quarantined authentication gate whose exact role reread drifts", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();
        queries.push(normalized);
        if (normalized === "begin") return { rows: [], command: "BEGIN" };
        if (normalized === "rollback") return { rows: [], command: "ROLLBACK" };
        return { rows: [] };
      }),
    };

    await expect(
      databaseRoleBootstrap!.commitManagedRoleAuthenticationGate(client),
    ).rejects.toThrow("database managed-role authentication gate is invalid");
    expect(queries.at(-1)).toBe("rollback");
    expect(queries).not.toContain("commit");
    expect(queries.join("\n")).not.toContain("pg_auth_members");
    expect(queries.join("\n")).not.toContain(
      "grant learncoding_owner to learncoding_migrator",
    );
    expect(queries.join("\n")).not.toContain("reset all");
  });

  it("never restores LOGIN when the authentication-gate commit is uncertain", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const queries: string[] = [];
    const commitFailure = new Error(
      "simulated lost gate commit acknowledgement",
    );
    const client = {
      query: vi.fn(async (sql: string) => {
        const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();
        queries.push(normalized);
        if (normalized.includes("from pg_catalog.pg_authid")) {
          return {
            rows: [
              "learncoding_app",
              "learncoding_backup_reporter",
              "learncoding_migrator",
              "learncoding_ops",
              "learncoding_owner",
              "learncoding_worker",
            ].map((rolname) => ({
              rolname,
              rolcanlogin: false,
              password_is_null: true,
              password_is_scram: false,
              rolsuper: false,
              rolcreatedb: false,
              rolcreaterole: false,
              rolinherit: false,
              rolreplication: false,
              rolbypassrls: false,
              rolconnlimit: -1,
            })),
          };
        }
        if (normalized === "begin") return { rows: [], command: "BEGIN" };
        if (normalized === "commit") throw commitFailure;
        return { rows: [] };
      }),
    };

    const outcome = await captureRejection(() =>
      databaseRoleBootstrap!.commitManagedRoleAuthenticationGate(client),
    );
    expect(outcome.rejected).toBe(true);
    expect(outcome.reason).toMatchObject({
      name: "DatabaseBootstrapCommitOutcomeUncertainError",
      cause: commitFailure,
      commitOutcomeUncertain: true,
      commitPhase: "authentication-gate",
    });
    expect(queries.at(-1)).toBe("commit");
    expect(queries).not.toContain("rollback");
    expect(
      queries.some((sql) => /\balter role\b[\s\S]*\blogin\b/u.test(sql)),
    ).toBe(false);
  });

  it("rolls back the authentication gate for activation uncertainty raised before its own commit", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const activationCommitFailure = new Error(
      "simulated lost activation commit acknowledgement",
    );
    const activationOutcome = await captureRejection(() =>
      databaseRoleBootstrap!.commitDatabaseBootstrapTransaction(
        {
          query: vi.fn(async () => {
            throw activationCommitFailure;
          }),
        },
        "activation",
      ),
    );
    expect(activationOutcome.rejected).toBe(true);
    expect(activationOutcome.reason).toMatchObject({
      name: "DatabaseBootstrapCommitOutcomeUncertainError",
      cause: activationCommitFailure,
      commitOutcomeUncertain: true,
      commitPhase: "activation",
    });

    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();
        queries.push(normalized);
        if (normalized === "begin") {
          return { rows: [], command: "BEGIN" };
        }
        if (normalized === "rollback") {
          return { rows: [] };
        }
        throw activationOutcome.reason;
      }),
    };

    const gateOutcome = await captureRejection(() =>
      databaseRoleBootstrap!.commitManagedRoleAuthenticationGate(client),
    );
    expect(gateOutcome.rejected).toBe(true);
    expect(gateOutcome.reason).toBe(activationOutcome.reason);
    expect(queries).toEqual(["begin", queries[1], "rollback"]);
    expect(queries[1]).toContain("do $codestead$");
    expect(queries).not.toContain("commit");
  });

  it("rolls back same-phase and duck-typed uncertainty raised before the gate commit site", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const samePhaseOutcome = await captureRejection(() =>
      databaseRoleBootstrap!.commitDatabaseBootstrapTransaction(
        {
          query: vi.fn(async () => {
            throw new Error("simulated gate commit acknowledgement loss");
          }),
        },
        "authentication-gate",
      ),
    );
    expect(samePhaseOutcome.rejected).toBe(true);
    const duckTypedUncertainty = Object.assign(
      new Error("untrusted uncertainty marker"),
      {
        commitOutcomeUncertain: true,
        commitPhase: "authentication-gate",
      },
    );

    for (const failure of [
      samePhaseOutcome.reason,
      duckTypedUncertainty,
    ]) {
      const queries: string[] = [];
      const client = {
        query: vi.fn(async (sql: string) => {
          const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();
          queries.push(normalized);
          if (normalized === "begin") {
            return { rows: [], command: "BEGIN" };
          }
          if (normalized === "rollback") {
            return { rows: [] };
          }
          throw failure;
        }),
      };

      const gateOutcome = await captureRejection(() =>
        databaseRoleBootstrap!.commitManagedRoleAuthenticationGate(client),
      );
      expect(gateOutcome.rejected).toBe(true);
      expect(gateOutcome.reason).toBe(failure);
      expect(queries).toEqual(["begin", queries[1], "rollback"]);
      expect(queries[1]).toContain("do $codestead$");
      expect(queries).not.toContain("commit");
    }
  });

  it("rejects an unknown commit phase before issuing COMMIT", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const query = vi.fn(async () => ({ rows: [] }));
    const outcome = await captureRejection(() =>
      databaseRoleBootstrap!.commitDatabaseBootstrapTransaction(
        { query },
        "final" as never,
      ),
    );
    expect(outcome.rejected).toBe(true);
    expect(outcome.reason).toBeInstanceOf(TypeError);
    expect((outcome.reason as Error).message).toBe(
      "database bootstrap commit phase is invalid",
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("requires exact BEGIN and COMMIT command evidence and bounds both controls", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();

    await expect(
      databaseRoleBootstrap!.beginDatabaseBootstrapTransaction(
        {
          query: vi.fn(async () => ({ command: "BEGIN", rows: [] })),
        },
        "activation",
      ),
    ).resolves.toBeUndefined();
    await expect(
      databaseRoleBootstrap!.commitDatabaseBootstrapTransaction(
        {
          query: vi.fn(async () => ({ command: "COMMIT", rows: [] })),
        },
        "activation",
      ),
    ).resolves.toBeUndefined();

    const rolledBack = await captureRejection(() =>
      databaseRoleBootstrap!.commitDatabaseBootstrapTransaction(
        {
          query: vi.fn(async () => ({ command: "ROLLBACK", rows: [] })),
        },
        "activation",
      ),
    );
    expect(rolledBack.rejected).toBe(true);
    expect(rolledBack.reason).toMatchObject({
      name: "DatabaseBootstrapCommitRejectedError",
      commitPhase: "activation",
    });
    expect(rolledBack.reason).not.toMatchObject({
      commitOutcomeUncertain: true,
    });

    for (const command of [undefined, "BEGIN"]) {
      const malformed = await captureRejection(() =>
        databaseRoleBootstrap!.commitDatabaseBootstrapTransaction(
          {
            query: vi.fn(async () => ({ command, rows: [] })),
          },
          "activation",
        ),
      );
      expect(malformed.rejected).toBe(true);
      expect(malformed.reason).toMatchObject({
        name: "DatabaseBootstrapCommitOutcomeUncertainError",
        commitOutcomeUncertain: true,
        commitPhase: "activation",
      });
    }

    await expect(
      databaseRoleBootstrap!.beginDatabaseBootstrapTransaction(
        {
          query: vi.fn(async () => ({ command: "COMMIT", rows: [] })),
        },
        "activation",
      ),
    ).rejects.toMatchObject({
      name: "DatabaseBootstrapTransactionStartOutcomeUncertainError",
      transactionPhase: "activation",
    });

    await expect(
      databaseRoleBootstrap!.beginDatabaseBootstrapTransaction(
        {
          query: vi.fn(() => new Promise<never>(() => undefined)),
        },
        "authentication-gate",
        { timeoutMs: 5 },
      ),
    ).rejects.toMatchObject({
      name: "DatabaseBootstrapTransactionStartOutcomeUncertainError",
      transactionPhase: "authentication-gate",
    });
    await expect(
      databaseRoleBootstrap!.commitDatabaseBootstrapTransaction(
        {
          query: vi.fn(() => new Promise<never>(() => undefined)),
        },
        "activation",
        { timeoutMs: 5 },
      ),
    ).rejects.toMatchObject({
      name: "DatabaseBootstrapCommitOutcomeUncertainError",
      commitOutcomeUncertain: true,
      commitPhase: "activation",
    });
  });

  it("rejects late zero-session evidence and a never-settling drain query", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    let clock = 0;
    const lateZeroClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_terminate_backend")) return { rows: [] };
        if (sql === "select pg_catalog.pg_stat_clear_snapshot()") {
          return { rows: [] };
        }
        clock = 2;
        return { rows: [{ remaining: 0 }] };
      }),
    };
    await expect(
      databaseRoleBootstrap!.terminateAndDrainManagedLoginRoleSessions(
        lateZeroClient,
        { timeoutMs: 1, queryTimeoutMs: 10, now: () => clock },
      ),
    ).rejects.toThrow("database role sessions remain active");

    await expect(
      databaseRoleBootstrap!.terminateAndDrainManagedLoginRoleSessions(
        {
          query: vi.fn(() => new Promise<never>(() => undefined)),
        },
        { timeoutMs: 50, queryTimeoutMs: 5 },
      ),
    ).rejects.toMatchObject({
      name: "DatabaseBootstrapControlTimeoutError",
    });

    let sharedDrainClock = 0;
    const sharedDrainQuery = vi.fn(async (sql: string) => {
      sharedDrainClock += 10;
      if (sql.includes("pg_terminate_backend")) return { rows: [] };
      if (sql === "select pg_catalog.pg_stat_clear_snapshot()") {
        return { rows: [] };
      }
      return { rows: [{ remaining: 0 }] };
    });
    await expect(
      databaseRoleBootstrap!.terminateAndDrainManagedLoginRoleSessions(
        { query: sharedDrainQuery },
        {
          timeoutMs: 15,
          queryTimeoutMs: 50,
          now: () => sharedDrainClock,
        },
      ),
    ).rejects.toThrow("database role sessions remain active");
    expect(sharedDrainQuery).toHaveBeenCalledTimes(2);
  });

  it("bounds client checkout and destroys a client that arrives after timeout", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    let resolveCheckout:
      | ((client: { release: (destroy?: boolean) => void }) => void)
      | undefined;
    const lateClient = { release: vi.fn() };
    const pool = {
      connect: vi.fn(
        () =>
          new Promise<{ release: (destroy?: boolean) => void }>((resolve) => {
            resolveCheckout = resolve;
          }),
      ),
    };

    await expect(
      databaseRoleBootstrap!.checkoutDatabaseBootstrapClient(pool, "target", {
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({
      name: "DatabaseBootstrapControlTimeoutError",
      controlPhase: "target-client-checkout",
    });
    expect(lateClient.release).not.toHaveBeenCalled();
    resolveCheckout?.(lateClient);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lateClient.release).toHaveBeenCalledWith(true);
  });

  it("bounds authentication-fence queries and rejects zero evidence at the hard deadline", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    let clock = 0;
    const exactDeadlineClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_terminate_backend")) return { rows: [] };
        if (sql === "select pg_catalog.pg_stat_clear_snapshot()") {
          return { rows: [] };
        }
        clock = 200;
        return { rows: [{ remaining: 0 }] };
      }),
    };
    await expect(
      databaseRoleBootstrap!.exhaustManagedRoleAuthenticationFence(
        exactDeadlineClient,
        {
          authenticationTimeoutMs: 100,
          serverVersionNum: 180_001,
        },
        {
          now: () => clock,
          sleep: async () => undefined,
          pollMs: 10,
          safetyMarginMs: 0,
          finalDrainMs: 100,
          queryTimeoutMs: 10,
        },
      ),
    ).rejects.toThrow("database authentication fence did not drain");

    const internalOutcome =
      databaseRoleBootstrap!.exhaustManagedRoleAuthenticationFence(
        {
          query: vi.fn(() => new Promise<never>(() => undefined)),
        },
        {
          authenticationTimeoutMs: 100,
          serverVersionNum: 170_006,
        },
        {
          now: () => 0,
          sleep: async () => undefined,
          pollMs: 10,
          safetyMarginMs: 0,
          finalDrainMs: 100,
          queryTimeoutMs: 5,
        },
      );
    const observed = await Promise.race([
      internalOutcome.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ kind: "outer-timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "outer-timeout" }), 25),
      ),
    ]);
    expect(observed).toMatchObject({
      kind: "rejected",
      error: {
        name: "DatabaseBootstrapControlTimeoutError",
        controlPhase: "authentication-fence-session-termination",
      },
    });

    let sharedFenceClock = 0;
    const sharedFenceQuery = vi.fn(async (sql: string) => {
      sharedFenceClock += 110;
      if (sql.includes("pg_terminate_backend")) return { rows: [] };
      if (sql === "select pg_catalog.pg_stat_clear_snapshot()") {
        return { rows: [] };
      }
      return { rows: [{ remaining: 0 }] };
    });
    await expect(
      databaseRoleBootstrap!.exhaustManagedRoleAuthenticationFence(
        { query: sharedFenceQuery },
        {
          authenticationTimeoutMs: 100,
          serverVersionNum: 180_001,
        },
        {
          now: () => sharedFenceClock,
          sleep: async () => undefined,
          pollMs: 10,
          safetyMarginMs: 0,
          finalDrainMs: 100,
          queryTimeoutMs: 500,
        },
      ),
    ).rejects.toThrow("database authentication fence did not drain");
    expect(sharedFenceQuery).toHaveBeenCalledTimes(2);
  });

  it("holds the visible-session horizon through a late session and never kills unrelated starters", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    let clock = 0;
    const remaining = [0, 0, 1, 0];
    const queryParameters: unknown[][] = [];
    const client = {
      query: vi.fn(async (sql: string, parameters?: unknown[]) => {
        if (parameters !== undefined) queryParameters.push(parameters);
        if (sql.includes("pg_terminate_backend")) return { rows: [] };
        if (sql === "select pg_catalog.pg_stat_clear_snapshot()") {
          return { rows: [{ pg_stat_clear_snapshot: null }] };
        }
        if (sql.includes("count(*)::integer remaining")) {
          return { rows: [{ remaining: remaining.shift() }] };
        }
        throw new Error(`unexpected authentication fence query: ${sql}`);
      }),
    };

    await expect(
      databaseRoleBootstrap!.exhaustManagedRoleAuthenticationFence(
        client,
        {
          authenticationTimeoutMs: 100,
          serverVersionNum: 180_001,
        },
        {
          now: () => clock,
          sleep: async (milliseconds) => {
            clock += milliseconds;
          },
          pollMs: 50,
          safetyMarginMs: 0,
          finalDrainMs: 100,
        },
      ),
    ).resolves.toBe(true);

    expect(clock).toBe(150);
    expect(remaining).toEqual([]);
    expect(
      client.query.mock.calls.filter(([sql]) =>
        String(sql).includes("pg_terminate_backend"),
      ),
    ).toHaveLength(4);
    expect(queryParameters).toEqual(
      Array.from({ length: 8 }, () => [
        "learncoding_owner",
        "learncoding_migrator",
        "learncoding_app",
        "learncoding_worker",
        "learncoding_ops",
        "learncoding_backup_reporter",
      ]).map((roles) => [roles]),
    );
    for (const [sql] of client.query.mock.calls) {
      expect(String(sql)).not.toContain("state = 'starting'");
    }
  });

  it("rejects when a visible managed-role session survives the hard deadline", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    let clock = 0;
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_terminate_backend")) return { rows: [] };
        if (sql === "select pg_catalog.pg_stat_clear_snapshot()") {
          return { rows: [{ pg_stat_clear_snapshot: null }] };
        }
        if (sql.includes("count(*)::integer remaining")) {
          return { rows: [{ remaining: 1 }] };
        }
        throw new Error(`unexpected authentication horizon query: ${sql}`);
      }),
    };

    await expect(
      databaseRoleBootstrap!.exhaustManagedRoleAuthenticationFence(
        client,
        {
          authenticationTimeoutMs: 100,
          serverVersionNum: 170_006,
        },
        {
          now: () => clock,
          sleep: async (milliseconds) => {
            clock += milliseconds;
          },
          pollMs: 50,
          safetyMarginMs: 0,
          finalDrainMs: 100,
        },
      ),
    ).rejects.toThrow(/database authentication fence did not drain/u);
    expect(clock).toBe(200);
  });

  it("installs every exact desired password only in Phase B and binds it to one role", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const rolePasswords = {
      learncoding_migrator: { password: "m".repeat(32) },
      learncoding_app: { password: "a".repeat(32) },
      learncoding_worker: { password: "w".repeat(32) },
      learncoding_ops: { password: "o".repeat(32) },
      learncoding_backup_reporter: { password: "b".repeat(32) },
    };
    const queries: Array<{ sql: string; parameters?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, parameters?: unknown[]) => {
        queries.push({ sql, parameters });
        return { rows: [] };
      }),
    };

    await databaseRoleBootstrap!.installManagedLoginRolePasswordsAndEnable(
      client,
      rolePasswords,
    );

    expect(queries[0]?.sql).toContain("set local log_parameter_max_length = 0");
    expect(queries[1]?.sql).toContain(
      "set local log_parameter_max_length_on_error = 0",
    );
    expect(queries[2]?.sql).toContain(
      "set local password_encryption = 'scram-sha-256'",
    );
    const passwordSets = queries.filter(({ sql }) =>
      sql.includes("set_config('codestead.role_password'"),
    );
    expect(passwordSets.map(({ parameters }) => parameters?.[0])).toEqual([
      rolePasswords.learncoding_migrator.password,
      rolePasswords.learncoding_app.password,
      rolePasswords.learncoding_worker.password,
      rolePasswords.learncoding_ops.password,
      rolePasswords.learncoding_backup_reporter.password,
    ]);
    for (const [index, role] of (
      [
        "learncoding_migrator",
        "learncoding_app",
        "learncoding_worker",
        "learncoding_ops",
        "learncoding_backup_reporter",
      ] as const
    ).entries()) {
      const mutation = queries[2 * index + 4]?.sql ?? "";
      expect(mutation).toContain(`alter role ${role} login password %L`);
      expect(mutation).not.toContain(rolePasswords[role].password);
    }
  });

  it("keeps the committed quarantine before Phase B password installation and the single final commit", async () => {
    const [{ readFile }, { join }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    const source = await readFile(
      join(process.cwd(), "scripts", "bootstrap-database-roles.mjs"),
      "utf8",
    );
    const start = source.indexOf(
      "export async function runDatabaseRoleBootstrap(options) {",
    );
    const end = source.indexOf("\nasync function main()", start);
    const run = source.slice(start, end);
    const gate = run.indexOf(
      "await commitManagedRoleAuthenticationGate(client)",
    );
    const horizon = run.indexOf(
      "await exhaustManagedRoleAuthenticationFence(",
      gate,
    );
    const finalBegin = run.indexOf(
      'await beginDatabaseBootstrapTransaction(client, "activation")',
      horizon,
    );
    const resetRoles = run.indexOf(
      "await createAndResetRoles(client)",
      finalBegin,
    );
    const enableRoles = run.indexOf(
      "await installManagedLoginRolePasswordsAndEnable(client, rolePasswords)",
      resetRoles,
    );
    const finalCommit = run.indexOf(
      'await commitDatabaseBootstrapTransaction(client, "activation")',
      enableRoles,
    );

    expect(start).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(horizon).toBeGreaterThan(gate);
    expect(finalBegin).toBeGreaterThan(horizon);
    expect(resetRoles).toBeGreaterThan(finalBegin);
    expect(enableRoles).toBeGreaterThan(resetRoles);
    expect(finalCommit).toBeGreaterThan(enableRoles);
    expect(run.slice(gate, finalBegin)).not.toContain(
      "codestead.role_password",
    );
    expect(run.slice(finalBegin, finalCommit)).toContain(
      "installManagedLoginRolePasswordsAndEnable(client, rolePasswords)",
    );
    expect(run.slice(finalBegin, enableRoles)).not.toMatch(
      /\balter role\b[\s\S]*\blogin\b/u,
    );
    expect(
      run.match(/commitDatabaseBootstrapTransaction\(client, "activation"\)/gu),
    ).toHaveLength(1);
  });

  it("enables managed login roles before either manifest role observation path", async () => {
    const [{ readFile }, { join }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    const source = await readFile(
      join(process.cwd(), "scripts", "bootstrap-database-roles.mjs"),
      "utf8",
    );
    const start = source.indexOf(
      "export async function runDatabaseRoleBootstrap(options) {",
    );
    const end = source.indexOf("\nasync function main()", start);
    const run = source.slice(start, end);
    const finalBegin = run.indexOf(
      'await beginDatabaseBootstrapTransaction(client, "activation")',
    );
    const resetRoles = run.indexOf(
      "await createAndResetRoles(client)",
      finalBegin,
    );
    const enableRoles = run.indexOf(
      "await installManagedLoginRolePasswordsAndEnable(client, rolePasswords)",
      resetRoles,
    );
    const reconcile = run.indexOf(
      "await reconcileBootstrapDatabaseRuntimeCapabilities(",
      resetRoles,
    );
    const foundation = run.indexOf(
      "await establishBootstrapDatabaseRuntimeCapabilityFoundation(",
      resetRoles,
    );
    const finalCommit = run.indexOf(
      'await commitDatabaseBootstrapTransaction(client, "activation")',
      resetRoles,
    );

    expect(finalBegin).toBeGreaterThanOrEqual(0);
    expect(resetRoles).toBeGreaterThan(finalBegin);
    expect(enableRoles).toBeGreaterThan(resetRoles);
    expect(reconcile).toBeGreaterThan(enableRoles);
    expect(foundation).toBeGreaterThan(enableRoles);
    expect(finalCommit).toBeGreaterThan(foundation);
  });

  it("bounds rollback cleanup and destroys the still-locked session", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const primary = new Error("simulated gate mutation failure");
    const client = {
      query: vi.fn((sql: string) => {
        if (sql === "begin") {
          return Promise.resolve({ rows: [], command: "BEGIN" });
        }
        if (sql === "rollback") return new Promise<never>(() => undefined);
        return Promise.reject(primary);
      }),
    };

    await expect(
      databaseRoleBootstrap!.commitManagedRoleAuthenticationGate(client, {
        rollbackTimeoutMs: 10,
      }),
    ).rejects.toMatchObject({
      name: "AggregateError",
      cause: primary,
      errors: [
        primary,
        expect.objectContaining({
          name: "DatabaseBootstrapCleanupTimeoutError",
        }),
      ],
    });
  });

  it("bounds outer rollback cleanup and destroys the still-locked session", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const client = {
      query: vi.fn((sql: string) =>
        sql === "rollback"
          ? new Promise<never>(() => undefined)
          : Promise.resolve({ rows: [{ released: true }] }),
      ),
      release: vi.fn(),
    };
    const pool = { end: vi.fn(async () => undefined) };

    await expect(
      databaseRoleBootstrap!.cleanupDatabaseBootstrapResources({
        client,
        pool,
        transactionOpen: true,
        lockAcquired: true,
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({ name: "DatabaseBootstrapCleanupTimeoutError" });

    expect(client.release).toHaveBeenCalledWith(true);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("fails closed when PostgreSQL reports the shared lock was not released", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const client = {
      query: vi.fn(async () => ({ rows: [{ released: false }] })),
      release: vi.fn(),
    };
    const pool = { end: vi.fn(async () => undefined) };

    await expect(
      databaseRoleBootstrap!.cleanupDatabaseBootstrapResources({
        client,
        pool,
        transactionOpen: false,
        lockAcquired: true,
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({ name: "DatabaseBootstrapUnlockError" });

    expect(client.release).toHaveBeenCalledWith(true);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("bounds pool shutdown after releasing the client", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const client = {
      query: vi.fn(async () => ({ rows: [{ released: true }] })),
      release: vi.fn(),
    };
    const pool = { end: vi.fn(() => new Promise<never>(() => undefined)) };

    await expect(
      databaseRoleBootstrap!.cleanupDatabaseBootstrapResources({
        client,
        pool,
        transactionOpen: false,
        lockAcquired: true,
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({ name: "DatabaseBootstrapCleanupTimeoutError" });

    expect(client.release).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("surfaces every maintenance cleanup failure after acknowledged re-enable", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const releaseFailure = new Error("maintenance client release failed");
    const poolFailure = new Error("maintenance pool shutdown failed");
    const client = {
      query: vi.fn(async (): Promise<never> => {
        throw new Error("no database query is allowed after re-enable");
      }),
      release: vi.fn(() => {
        throw releaseFailure;
      }),
    };
    const pool = {
      end: vi.fn(async () => {
        throw poolFailure;
      }),
    };

    const outcome = await captureRejection(() =>
      databaseRoleBootstrap!.cleanupRestoredNoAclMaintenanceResources({
        client,
        pool,
        databaseReenabled: true,
        operationFailed: false,
        timeoutMs: 50,
      }),
    );

    expect(outcome.rejected).toBe(true);
    expect(outcome.reason).toBeInstanceOf(AggregateError);
    expect((outcome.reason as AggregateError).errors).toEqual([
      releaseFailure,
      poolFailure,
    ]);
    expect(outcome.reason).toMatchObject({
      cleanupIncomplete: true,
      databaseEnabled: true,
    });
    expect(client.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledWith(undefined);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("preserves the exact bootstrap rejection when cleanup succeeds", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();

    for (const primaryFailure of [
      new Error("bootstrap primary Error"),
      "bootstrap-primary-primitive",
      undefined,
    ]) {
      const { outcome, pool } = await runBootstrapCheckoutFailure(
        databaseRoleBootstrap!,
        primaryFailure,
      );
      expect(outcome.rejected).toBe(true);
      expect(outcome.reason).toBe(primaryFailure);
      expect(pool.end).toHaveBeenCalledOnce();
    }
  });

  it("keeps a mutable primary Error outward and attaches its cleanup failures", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const originalCause = new Error("original bootstrap cause");
    const primaryFailure = new Error("bootstrap primary");
    Object.defineProperty(primaryFailure, "cause", {
      value: originalCause,
      configurable: true,
      writable: true,
    });
    const cleanupFailure = new Error("bootstrap pool cleanup");

    const { outcome } = await runBootstrapCheckoutFailure(
      databaseRoleBootstrap!,
      primaryFailure,
      cleanupFailure,
    );

    expect(outcome.rejected).toBe(true);
    expect(outcome.reason).toBe(primaryFailure);
    const cleanupCause = (primaryFailure as Error & { cause?: unknown }).cause;
    expect(cleanupCause).toBeInstanceOf(AggregateError);
    expect((cleanupCause as AggregateError).errors).toEqual([cleanupFailure]);
    expect((cleanupCause as AggregateError & { cause?: unknown }).cause).toBe(
      originalCause,
    );
  });

  it("aggregates falsey and non-Error primaries with cleanup failures", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();

    for (const primaryFailure of [
      false,
      "bootstrap-primary-primitive",
      undefined,
    ]) {
      const cleanupFailure = new Error("bootstrap pool cleanup");
      const { outcome } = await runBootstrapCheckoutFailure(
        databaseRoleBootstrap!,
        primaryFailure,
        cleanupFailure,
      );
      expect(outcome.rejected).toBe(true);
      expect(outcome.reason).toBeInstanceOf(AggregateError);
      expect((outcome.reason as AggregateError).errors).toEqual([
        primaryFailure,
        cleanupFailure,
      ]);
      expect(
        (outcome.reason as AggregateError & { cause?: unknown }).cause,
      ).toBe(primaryFailure);
    }
  });

  it("does not mutate a frozen primary Error or its existing cause", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const originalCause = Object.freeze(new Error("frozen original cause"));
    const primaryFailure = Object.freeze(
      new Error("frozen bootstrap primary", { cause: originalCause }),
    );
    const cleanupFailure = new Error("bootstrap pool cleanup");

    const { outcome } = await runBootstrapCheckoutFailure(
      databaseRoleBootstrap!,
      primaryFailure,
      cleanupFailure,
    );

    expect(outcome.rejected).toBe(true);
    expect(outcome.reason).toBeInstanceOf(AggregateError);
    expect((outcome.reason as AggregateError).errors).toEqual([
      primaryFailure,
      cleanupFailure,
    ]);
    expect((outcome.reason as AggregateError & { cause?: unknown }).cause).toBe(
      primaryFailure,
    );
    expect(primaryFailure.cause).toBe(originalCause);
  });

  it("rejects with an exact sole falsey or primitive cleanup failure", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();

    for (const cleanupFailure of [undefined, false, "cleanup-primitive"]) {
      const client = {
        query: vi.fn(async () => ({ rows: [{ released: true }] })),
        release: vi.fn(() => {
          throw cleanupFailure;
        }),
      };
      const pool = { end: vi.fn(async () => undefined) };
      const outcome = await captureRejection(() =>
        databaseRoleBootstrap!.cleanupDatabaseBootstrapResources({
          client,
          pool,
          transactionOpen: false,
          lockAcquired: false,
          timeoutMs: 50,
        }),
      );

      expect(outcome.rejected).toBe(true);
      expect(outcome.reason).toBe(cleanupFailure);
      expect(pool.end).toHaveBeenCalledOnce();
    }
  });

  it("retains every bootstrap cleanup failure in execution order", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    const rollbackFailure = undefined;
    const releaseFailure = "release-cleanup-primitive";
    const poolFailure = new Error("pool cleanup failure");
    const client = {
      query: vi.fn(async () => {
        throw rollbackFailure;
      }),
      release: vi.fn(() => {
        throw releaseFailure;
      }),
    };
    const pool = {
      end: vi.fn(async () => {
        throw poolFailure;
      }),
    };

    const outcome = await captureRejection(() =>
      databaseRoleBootstrap!.cleanupDatabaseBootstrapResources({
        client,
        pool,
        transactionOpen: true,
        lockAcquired: true,
        timeoutMs: 50,
      }),
    );

    expect(outcome.rejected).toBe(true);
    expect(outcome.reason).toBeInstanceOf(AggregateError);
    expect((outcome.reason as AggregateError).errors).toEqual([
      rollbackFailure,
      releaseFailure,
      poolFailure,
    ]);
    expect((outcome.reason as AggregateError & { cause?: unknown }).cause).toBe(
      rollbackFailure,
    );
    expect(client.release).toHaveBeenCalledWith(true);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("verifies the exact physical and exploded default-ACL state", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();
    expect(databaseRoleBootstrap).not.toBeNull();
    expect(databaseRoleBootstrap?.verifyDatabaseDefaultAclState).toBeTypeOf(
      "function",
    );

    const entry = (
      owner: string,
      schema: string,
      kind: string,
      grantee: string | null,
      privilegeType: string | null,
      isGrantable: boolean | null = false,
      grantor: string | null = owner,
    ) => ({
      schema,
      owner,
      grantor,
      grantee,
      kind,
      grantee_oid: grantee === null ? null : grantee === "PUBLIC" ? 0 : 16_384,
      is_public: grantee === null ? null : grantee === "PUBLIC",
      privilege_type: privilegeType,
      is_grantable: isGrantable,
    });
    const runtimeRoles = [
      "learncoding_app",
      "learncoding_worker",
      "learncoding_ops",
    ];
    const managedPrivileges = {
      r: ["DELETE", "INSERT", "SELECT", "UPDATE"],
      S: ["SELECT", "UPDATE", "USAGE"],
      T: ["USAGE"],
    };
    const validEntries = [
      ...["learncoding_owner", "legacy_bootstrap"].flatMap((owner) => [
        entry(owner, "<global>", "f", owner, "EXECUTE"),
        entry(owner, "<global>", "T", owner, "USAGE"),
      ]),
      ...runtimeRoles.flatMap((grantee) =>
        Object.entries(managedPrivileges).flatMap(([kind, privileges]) =>
          privileges.map((privilege) =>
            entry("learncoding_owner", "public", kind, grantee, privilege),
          ),
        ),
      ),
    ];
    const sameCreatorEntries = validEntries.filter(
      ({ owner }) => owner !== "legacy_bootstrap",
    );
    expect(validEntries).toHaveLength(28);
    expect(
      new Set(
        validEntries.map(
          ({ owner, schema, kind }) => `${owner}|${schema}|${kind}`,
        ),
      ).size,
    ).toBe(7);
    expect(sameCreatorEntries).toHaveLength(26);
    expect(
      new Set(
        sameCreatorEntries.map(
          ({ owner, schema, kind }) => `${owner}|${schema}|${kind}`,
        ),
      ).size,
    ).toBe(5);

    expect(() =>
      databaseRoleBootstrap!.verifyDatabaseDefaultAclState({
        postgresUser: "legacy_bootstrap",
        drizzleExists: true,
        entries: validEntries,
      }),
    ).not.toThrow();
    expect(() =>
      databaseRoleBootstrap!.verifyDatabaseDefaultAclState({
        postgresUser: "learncoding_owner",
        drizzleExists: true,
        entries: sameCreatorEntries,
      }),
    ).not.toThrow();
    expect(() =>
      databaseRoleBootstrap!.verifyDatabaseDefaultAclState({
        postgresUser: "legacy_bootstrap",
        drizzleExists: false,
        entries: validEntries,
      }),
    ).not.toThrow();

    const invalidEntries = [
      [
        ...validEntries,
        entry("second_creator", "<global>", "f", "second_creator", "EXECUTE"),
      ],
      [
        ...validEntries,
        entry("legacy_bootstrap", "public", "r", "legacy_bootstrap", "SELECT"),
      ],
      validEntries.map((candidate) =>
        candidate.owner === "learncoding_owner" &&
        candidate.schema === "<global>" &&
        candidate.kind === "f"
          ? entry("learncoding_owner", "<global>", "f", null, null, null, null)
          : candidate,
      ),
      [
        ...validEntries,
        entry(
          "learncoding_owner",
          "<global>",
          "f",
          "learncoding_owner",
          "EXECUTE",
        ),
      ],
      validEntries.map((candidate) =>
        candidate.owner === "learncoding_owner" &&
        candidate.schema === "<global>" &&
        candidate.kind === "f"
          ? { ...candidate, privilege_type: "USAGE" }
          : candidate,
      ),
      validEntries.map((candidate) =>
        candidate.owner === "learncoding_owner" &&
        candidate.schema === "<global>" &&
        candidate.kind === "T"
          ? { ...candidate, grantor: "second_creator" }
          : candidate,
      ),
      [
        ...validEntries,
        entry(
          "learncoding_owner",
          "public",
          "f",
          "learncoding_owner",
          "EXECUTE",
        ),
      ],
      [
        ...validEntries,
        entry(
          "learncoding_owner",
          "drizzle",
          "T",
          "learncoding_owner",
          "USAGE",
        ),
      ],
      [
        ...validEntries,
        entry(
          "learncoding_owner",
          "public",
          "r",
          "learncoding_owner",
          "SELECT",
        ),
      ],
      validEntries.map((candidate) =>
        candidate.owner === "learncoding_owner" &&
        candidate.schema === "<global>" &&
        candidate.kind === "f"
          ? { ...candidate, grantee: "PUBLIC" }
          : candidate,
      ),
      validEntries.map((candidate) =>
        candidate.owner === "learncoding_owner" &&
        candidate.schema === "<global>" &&
        candidate.kind === "f"
          ? { ...candidate, is_grantable: true }
          : candidate,
      ),
      validEntries.map((candidate) =>
        candidate.owner === "learncoding_owner" &&
        candidate.schema === "public" &&
        candidate.kind === "r" &&
        candidate.grantee === "learncoding_app" &&
        candidate.privilege_type === "SELECT"
          ? { ...candidate, is_grantable: true }
          : candidate,
      ),
      [
        ...validEntries,
        entry(
          "learncoding_owner",
          "<global>",
          "S",
          "learncoding_owner",
          "USAGE",
        ),
      ],
      validEntries.map((candidate) =>
        candidate.owner === "learncoding_owner" &&
        candidate.schema === "public" &&
        candidate.kind === "r" &&
        candidate.grantee === "learncoding_app" &&
        candidate.privilege_type === "SELECT"
          ? {
              ...candidate,
              grantee_oid: 0,
              is_public: true,
            }
          : candidate,
      ),
      validEntries.filter(
        (candidate) =>
          !(
            candidate.owner === "legacy_bootstrap" &&
            candidate.schema === "<global>" &&
            candidate.kind === "T"
          ),
      ),
      validEntries.filter(
        (candidate) =>
          !(
            candidate.owner === "learncoding_owner" &&
            candidate.schema === "public" &&
            candidate.grantee === "learncoding_app" &&
            candidate.kind === "r" &&
            candidate.privilege_type === "SELECT"
          ),
      ),
    ];
    const expectDefaultAclFailure = (
      postgresUser: string,
      entries: typeof validEntries,
    ) => {
      expect(() =>
        databaseRoleBootstrap!.verifyDatabaseDefaultAclState({
          postgresUser,
          drizzleExists: true,
          entries,
        }),
      ).toThrow(/default-acl/u);
    };
    for (const entries of invalidEntries) {
      expectDefaultAclFailure("legacy_bootstrap", entries);
    }

    const sameCreatorInvalidEntries = [
      sameCreatorEntries.filter(
        (candidate) =>
          !(
            candidate.owner === "learncoding_owner" &&
            candidate.schema === "<global>" &&
            candidate.kind === "T"
          ),
      ),
      [...sameCreatorEntries, { ...sameCreatorEntries[0] }],
      [
        ...sameCreatorEntries,
        entry("second_creator", "<global>", "f", "second_creator", "EXECUTE"),
      ],
      [
        ...sameCreatorEntries,
        entry(
          "learncoding_owner",
          "public",
          "f",
          "learncoding_owner",
          "EXECUTE",
        ),
      ],
      [
        ...sameCreatorEntries,
        entry(
          "learncoding_owner",
          "public",
          "r",
          "learncoding_owner",
          "SELECT",
        ),
      ],
      [
        ...sameCreatorEntries,
        entry(
          "learncoding_owner",
          "drizzle",
          "T",
          "learncoding_owner",
          "USAGE",
        ),
      ],
    ];
    for (const entries of sameCreatorInvalidEntries) {
      expectDefaultAclFailure("learncoding_owner", entries);
    }

    for (const [index] of validEntries.entries()) {
      expectDefaultAclFailure(
        "legacy_bootstrap",
        validEntries.map((candidate, candidateIndex) =>
          candidateIndex === index
            ? { ...candidate, is_grantable: true }
            : candidate,
        ),
      );
    }
    for (const [index] of sameCreatorEntries.entries()) {
      expectDefaultAclFailure(
        "learncoding_owner",
        sameCreatorEntries.map((candidate, candidateIndex) =>
          candidateIndex === index
            ? { ...candidate, is_grantable: true }
            : candidate,
        ),
      );
    }

    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile("scripts/bootstrap-database-roles.mjs", "utf8"),
    );
    const ownershipInventoryStart = source.indexOf(
      "async function loadOwnershipInventory",
    );
    const inventoryDefaultAclStart = source.indexOf(
      "`select case when a.defaclnamespace = 0 then '<global>'",
      ownershipInventoryStart,
    );
    const inventoryDefaultAclEnd = source.indexOf(
      "order by 1, 2, 3, 4, 5, 6`",
      inventoryDefaultAclStart,
    );
    const finalDefaultAclStart = source.indexOf(
      "const defaultAcls = await client.query(",
    );
    const finalDefaultAclEnd = source.indexOf(
      "verifyDatabaseDefaultAclState({",
      finalDefaultAclStart,
    );
    expect(ownershipInventoryStart).toBeGreaterThanOrEqual(0);
    expect(inventoryDefaultAclStart).toBeGreaterThan(ownershipInventoryStart);
    expect(inventoryDefaultAclEnd).toBeGreaterThan(inventoryDefaultAclStart);
    expect(finalDefaultAclStart).toBeGreaterThanOrEqual(0);
    expect(finalDefaultAclEnd).toBeGreaterThan(finalDefaultAclStart);
    for (const query of [
      source.slice(inventoryDefaultAclStart, inventoryDefaultAclEnd),
      source.slice(finalDefaultAclStart, finalDefaultAclEnd),
    ]) {
      expect(query).toMatch(
        /case when a[.]defaclnamespace = 0 then '<global>'[\s\S]*?else n[.]nspname end schema/iu,
      );
      expect(query).toMatch(
        /left join lateral aclexplode\(a[.]defaclacl\) privilege on true/iu,
      );
      expect(query).toMatch(
        /left join pg_namespace n on n[.]oid = a[.]defaclnamespace/iu,
      );
      expect(query).not.toMatch(/\b(?:where|having|limit|offset)\b/iu);
      expect(query).not.toMatch(/\$\d+/u);
      expect(query).not.toMatch(/pg_get_userbyid[(]a[.]defaclrole[)]\s+in\b/iu);
      expect(query).toMatch(/privilege[.]grantee\s+grantee_oid/iu);
      expect(query).toMatch(/else privilege[.]grantee\s*=\s*0 end is_public/iu);
    }
    expect(source).toMatch(
      /verifyDatabaseDefaultAclState\(\{\s*postgresUser,[\s\S]*?entries:\s*defaultAcls\.rows/u,
    );
    expect(source).toMatch(
      /left join lateral aclexplode\(a\.defaclacl\) privilege on true/u,
    );
    expect(source).toMatch(
      /case when a[.]defaclnamespace = 0 then '<global>'[\s\S]*?else n[.]nspname end schema/iu,
    );
    expect(source).toMatch(
      /left join pg_namespace n on n[.]oid = a[.]defaclnamespace/iu,
    );
    expect(databaseRoleBootstrap?.globalDefaultAclScrubSql).toBeTypeOf(
      "function",
    );
    const scrubSql = databaseRoleBootstrap!.globalDefaultAclScrubSql();
    expect(scrubSql).toMatch(
      /creator[.]rolname in [(]'learncoding_owner', current_user[)]/iu,
    );
    expect(scrubSql).toMatch(
      /from pg_catalog[.]pg_default_acl[\s\S]*?cross join lateral pg_catalog[.]aclexplode/iu,
    );
    expect(scrubSql).toMatch(/default_acl[.]defaclnamespace = 0/iu);
    expect(scrubSql).toMatch(/pg_catalog[.]array_agg/iu);
    expect(scrubSql).toMatch(/access[.]grantee\s+grantee_oid/iu);
    expect(scrubSql).toMatch(/access[.]grantee\s*=\s*0\s+is_public/iu);
    expect(scrubSql).toMatch(
      /union\s+select 0::pg_catalog[.]oid,\s*true,\s*'PUBLIC'/iu,
    );
    expect(scrubSql).toMatch(
      /union\s+select target[.]creator_oid,\s*false,\s*target[.]creator_name/iu,
    );
    expect(scrubSql).toMatch(
      /when grantee_is_public\[grantee_index\] then 'PUBLIC'/iu,
    );
    expect(scrubSql).toMatch(
      /pg_catalog[.]format[(]'%I', grantee_names\[grantee_index\][)]/iu,
    );
    expect(scrubSql).not.toMatch(/grantee_name\s*=\s*'PUBLIC'/iu);
    expect(scrubSql).toMatch(/revoke all on %s from %s cascade/iu);
    expect(scrubSql).toMatch(/grant %s on %s to %I/iu);
    expect(source).not.toContain(
      "await client.query(globalDefaultAclScrubSql())",
    );
    expect(source).toContain(
      "await reconcileBootstrapDatabaseRuntimeCapabilities(",
    );
    expect(source).not.toMatch(
      /applyDatabaseRolePrivilegeReconciliation|reconcileRestoredNoAclDatabaseRolePrivileges/u,
    );
  });

  it("delegates exact ownership and declares non-grantable ACL invariants", async () => {
    const [{ readFile }, { join }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    const source = await readFile(
      join(process.cwd(), "scripts", "bootstrap-database-roles.mjs"),
      "utf8",
    );
    const bootstrapStart = source.indexOf(
      "export async function runDatabaseRoleBootstrap(options) {",
    );
    const connectIndex = source.indexOf(
      'client = await checkoutDatabaseBootstrapClient(pool, "target", {',
      bootstrapStart,
    );
    const trustedSearchPathIndex = source.indexOf(
      "pg_catalog.set_config('search_path', 'pg_catalog,pg_temp', false)",
      connectIndex,
    );
    const identityIndex = source.indexOf(
      "const identity = await client.query(",
      connectIndex,
    );
    expect(bootstrapStart).toBeGreaterThanOrEqual(0);
    expect(connectIndex).toBeGreaterThan(bootstrapStart);
    expect(trustedSearchPathIndex).toBeGreaterThan(connectIndex);
    expect(trustedSearchPathIndex).toBeLessThan(identityIndex);

    expect(source).toContain(
      "await transferBootstrapDatabaseRuntimeCapabilityOwnership(",
    );
    expect(source).toMatch(/acl\.is_grantable/u);
    expect(source).toMatch(/is_grantable\s*=\s*false/iu);
    expect(source).not.toContain(
      "aclexplode(coalesce(d.datacl, '{}'::aclitem[]))",
    );
    expect(source).not.toContain("await Promise.all([\n    client.query(");
    expect(source).toMatch(/or\s+not grant_not_delegable/iu);
    expect(source).not.toMatch(
      /coalesce\(pg_get_userbyid\((?:acl|privilege)\.grantee\), 'PUBLIC'\)/u,
    );
    expect(source).toMatch(/when acl\.grantee = 0 then 'PUBLIC'/u);
    expect(source).not.toMatch(/on all types in schema/iu);
    expect(source).toContain(
      "await reconcileBootstrapDatabaseRuntimeCapabilities(",
    );
    expect(source).not.toMatch(/\bon\s+all\s+(tables|sequences|routines)\b/iu);
    expect(source).not.toMatch(/rolconfig is null/u);
    expect(source).toMatch(
      /not exists \(\s*select 1 from pg_db_role_setting/iu,
    );
    expect(source).not.toMatch(/has_[a-z_]+_privilege\('PUBLIC'/u);
    expect(source).toMatch(
      /pg_catalog\.pg_terminate_backend\(activity\.pid\)/u,
    );
    expect(source).not.toMatch(
      /pg_catalog\.pg_terminate_backend\(activity\.pid,\s*5000\)/u,
    );
    expect(source).toMatch(/MAX_SESSION_DRAIN_MS/u);
    expect(source).toMatch(/pg_stat_clear_snapshot\(\)/u);
    expect(source).toMatch(/privilege\.is_grantable/u);
    expect(source).toMatch(/has_function_privilege\(0, p\.oid, 'EXECUTE'\)/u);
  });

  it("re-verifies every boundary after beforeCommit and before COMMIT", async () => {
    const [{ readFile }, { join }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    const source = await readFile(
      join(process.cwd(), "scripts", "bootstrap-database-roles.mjs"),
      "utf8",
    );
    const bootstrapStart = source.indexOf(
      "export async function runDatabaseRoleBootstrap(options) {",
    );
    const beforeCommit = source.indexOf(
      "if (options.beforeCommit)",
      bootstrapStart,
    );
    const commit = source.indexOf(
      'await commitDatabaseBootstrapTransaction(client, "activation")',
      beforeCommit,
    );
    expect(bootstrapStart).toBeGreaterThanOrEqual(0);
    expect(beforeCommit).toBeGreaterThan(bootstrapStart);
    expect(commit).toBeGreaterThan(beforeCommit);
    const finalTransactionalVerification = source.slice(beforeCommit, commit);
    const guardInstallation = source.indexOf(
      "await installDatabaseBootstrapTransactionGuard(client)",
      bootstrapStart,
    );
    const guardVerification = source.indexOf(
      "await verifyDatabaseBootstrapTransactionGuard(",
      beforeCommit,
    );
    expect(guardInstallation).toBeGreaterThan(bootstrapStart);
    expect(guardInstallation).toBeLessThan(beforeCommit);
    expect(guardVerification).toBeGreaterThan(beforeCommit);
    expect(guardVerification).toBeLessThan(commit);

    const reviewedCatalog = finalTransactionalVerification.indexOf(
      "verifyPostMigrationReviewedContractsBeforeReconciliation(",
    );
    const completeRoleState = finalTransactionalVerification.indexOf(
      "verifyDatabaseRoleBootstrapState(",
    );
    const backupAuthority = finalTransactionalVerification.indexOf(
      "verifyBackupStatusAuthorityAfterRepair(",
    );
    expect(reviewedCatalog).toBeGreaterThanOrEqual(0);
    expect(backupAuthority).toBeGreaterThan(reviewedCatalog);
    expect(completeRoleState).toBeGreaterThan(backupAuthority);
    expect(finalTransactionalVerification).not.toContain(
      'verifyBackupStatusAuthorityAfterRepair(client);\n    await commitDatabaseBootstrapTransaction(client, "activation")',
    );
  });

  it("drains post-commit sessions before every committed verifier and never synthesizes success", async () => {
    const [{ readFile }, { join }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    const source = await readFile(
      join(process.cwd(), "scripts", "bootstrap-database-roles.mjs"),
      "utf8",
    );
    const bootstrapStart = source.indexOf(
      "export async function runDatabaseRoleBootstrap(options) {",
    );
    const bootstrapEnd = source.indexOf(
      "\nasync function main()",
      bootstrapStart,
    );
    const bootstrap = source.slice(bootstrapStart, bootstrapEnd);
    const commit = bootstrap.indexOf(
      'await commitDatabaseBootstrapTransaction(client, "activation")',
    );
    const transactionClosed = bootstrap.indexOf(
      "transactionOpen = false",
      commit,
    );
    const postCommitDrain = bootstrap.indexOf(
      "await terminateAndDrainManagedLoginRoleSessions(client)",
      transactionClosed,
    );
    const committedPhase = bootstrap.indexOf(
      "const committedPhase",
      postCommitDrain,
    );

    expect(commit).toBeGreaterThanOrEqual(0);
    expect(transactionClosed).toBeGreaterThan(commit);
    expect(postCommitDrain).toBeGreaterThan(transactionClosed);
    expect(committedPhase).toBeGreaterThan(postCommitDrain);
    expect(bootstrap.slice(transactionClosed, postCommitDrain)).not.toMatch(
      /await client[.]query/u,
    );
    expect(bootstrap).not.toContain("sessionsTerminated: true");
    expect(bootstrap).toContain("sessionsTerminated,");
  });
});
