import { describe, expect, it, vi } from "vitest";

type DatabaseRoleModule = {
  DATABASE_ADMIN_LOCK_NAME: string;
  REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES: ReadonlyArray<{
    readonly index: number;
  }>;
  REVIEWED_APPLICATION_FUNCTIONS: ReadonlyArray<{
    signature: string;
    owner: string;
    securityDefiner: boolean;
    configuration: readonly string[];
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

describe("database least-privilege bootstrap", () => {
  it("uses one shared database-administration advisory lock", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();

    expect(databaseRoleBootstrap).not.toBeNull();
    expect(databaseRoleBootstrap?.DATABASE_ADMIN_LOCK_NAME).toBe(
      "codestead:database-administration:v1",
    );
  });

  it("reconciles the exact reviewed mail-authority routines after the blanket revoke", async () => {
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
    expect(routines[0]).toMatchObject({
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
    expect(reviewedGrant).not.toMatch(
      /to\s+(public|learncoding_app|learncoding_migrator)\b/iu,
    );

    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile("scripts/bootstrap-database-roles.mjs", "utf8"),
    );
    expect(
      source.indexOf("revoke execute on all routines in schema public"),
    ).toBeLessThan(
      source.indexOf(
        "await client.query(reviewedApplicationFunctionPrivilegesSql(canonicalPhase))",
      ),
    );
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
    const testIndex = source.indexOf(
      'await runNpm([\n      "run",\n      "test:integration:vitest"',
    );

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
    const dependencyStart = source.indexOf(
      "const integrationRetentionDependencies = {",
    );
    const dependencyEnd = source.indexOf("} as const;", dependencyStart);
    const retentionCalls = [...source.matchAll(/runRetention\(/gu)];
    const scopedRetentionCalls = [
      ...source.matchAll(
        /\}, integrationRetention(?:FileErasure)?Dependencies\)(?:;|\))/gu,
      ),
    ];

    expect(source).toContain("const integrationRetentionPool = new PgPool({");
    expect(source).toContain(
      "const integrationRetentionFileErasureDependencies = {",
    );
    expect(source).toContain("connectionString: process.env.DATABASE_OPS_URL");
    expect(source).toContain("integrationRetentionPool.end()");
    expect(dependencyStart).toBeGreaterThanOrEqual(0);
    expect(dependencyEnd).toBeGreaterThan(dependencyStart);
    expect(source.slice(dependencyStart, dependencyEnd)).toContain(
      "acquireClient: () => integrationRetentionPool.connect()",
    );
    expect(retentionCalls.length).toBeGreaterThan(0);
    expect(scopedRetentionCalls).toHaveLength(retentionCalls.length);
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
    expect(opsProofSource).toMatch(
      /const report = await retention[.]runRetention\(\{[\s\S]*?\}, \{[\s\S]*?acquireClient: \(\) => opsPool[.]connect\(\),[\s\S]*?processFileErasures:/u,
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
    expect(opsProofSource).toContain('current_user: "learncoding_owner"');
    expect(opsProofSource).toContain('session_user: "learncoding_migrator"');
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

  it("bounds rollback cleanup and destroys the still-locked session", async () => {
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
    const observedSchemaRevokeTargets = [
      ...source.matchAll(
        /alter default privileges for role (learncoding_owner|current_user) in schema (public|drizzle)\s+revoke (?:all|execute|usage) on (tables|sequences|routines|types)/giu,
      ),
    ].map(([, owner, schema, kind]) => `${owner}|${schema}|${kind}`);
    const expectedSchemaRevokeTargets = [
      "learncoding_owner",
      "current_user",
    ].flatMap((owner) =>
      ["public", "drizzle"].flatMap((schema) =>
        ["tables", "sequences", "routines", "types"].map(
          (kind) => `${owner}|${schema}|${kind}`,
        ),
      ),
    );
    expect(observedSchemaRevokeTargets).toHaveLength(16);
    expect(new Set(observedSchemaRevokeTargets)).toEqual(
      new Set(expectedSchemaRevokeTargets),
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
    const scrubCall = source.indexOf(
      "await client.query(globalDefaultAclScrubSql())",
    );
    const firstSchemaDefaultRevoke = source.indexOf(
      "alter default privileges for role learncoding_owner in schema public",
    );
    expect(scrubCall).toBeGreaterThanOrEqual(0);
    expect(firstSchemaDefaultRevoke).toBeGreaterThan(scrubCall);
  });

  it("declares aggregate ownership and non-grantable ACL invariants", async () => {
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
      "client = await pool.connect();",
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
      "when 'a' then 'alter aggregate %I.%I(%s) owner to learncoding_owner'",
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
      "alter default privileges for role learncoding_owner in schema public",
    );
    expect(source).not.toMatch(/rolconfig is null/u);
    expect(source).toMatch(
      /not exists \(\s*select 1 from pg_db_role_setting/iu,
    );
    expect(source).not.toMatch(/has_[a-z_]+_privilege\('PUBLIC'/u);
    expect(source).toMatch(/pg_terminate_backend\(pid\)/u);
    expect(source).not.toMatch(/pg_terminate_backend\(pid,\s*5000\)/u);
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
    const commit = source.indexOf('await client.query("commit")', beforeCommit);
    expect(bootstrapStart).toBeGreaterThanOrEqual(0);
    expect(beforeCommit).toBeGreaterThan(bootstrapStart);
    expect(commit).toBeGreaterThan(beforeCommit);
    const finalTransactionalVerification = source.slice(beforeCommit, commit);

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
      'verifyBackupStatusAuthorityAfterRepair(client);\n    await client.query("commit")',
    );
  });
});
