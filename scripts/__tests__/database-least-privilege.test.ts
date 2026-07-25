import { describe, expect, it, vi } from "vitest";

type DatabaseRoleModule = {
  DATABASE_ADMIN_LOCK_NAME: string;
  REVIEWED_APPLICATION_FUNCTIONS: ReadonlyArray<{
    signature: string;
    owner: string;
    securityDefiner: boolean;
    configuration: readonly string[];
    allowedRoles: readonly string[];
  }>;
  REVIEWED_APPLICATION_TRIGGERS: ReadonlyArray<{
    relation: string;
    name: string;
    functionSignature: string;
    enabled: string;
    type: number;
    qualifier: string | null;
    arguments: number;
    columns: readonly string[];
  }>;
  reviewedApplicationFunctionPrivilegesSql: () => string;
  runDatabaseRoleBootstrap: (input: {
    postgresUser: string;
    postgresDatabase: string;
    databaseBootstrapUrl: string;
    databaseAppUrl: string;
    databaseMigratorUrl: string;
    databaseWorkerUrl: string;
    databaseOpsUrl: string;
    lockTimeoutMs?: number;
    cleanupTimeoutMs?: number;
    pool: {
      connect: () => Promise<{
        query: (sql: string, parameters?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
        release: (destroy?: boolean) => void;
      }>;
      end: () => Promise<void>;
    };
  }) => Promise<unknown>;
  verifyDatabaseRoleBootstrapState: (
    client: {
      query: (sql: string, parameters?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
    },
    postgresDatabase: string,
    postgresUser: string,
  ) => Promise<unknown>;
  validateDatabaseRoleUrls: (input: {
    postgresUser: string;
    postgresDatabase: string;
    databaseBootstrapUrl: string;
    databaseAppUrl: string;
    databaseMigratorUrl: string;
    databaseWorkerUrl: string;
    databaseOpsUrl: string;
  }) => Record<string, { username: string; hostname: string; database: string }>;
  validateOwnershipInventory: (input: {
    postgresUser: string;
    postgresDatabase: string;
    databases: Array<{ name: string; owner: string }>;
    tablespaces: Array<{ name: string; owner: string }>;
    schemas: Array<{ name: string; owner: string }>;
    objects: Array<{ schema: string; name: string; kind: string; owner: string }>;
    unexpectedOwnerDependencies?: Array<{ catalog: string; objectId: string }>;
    directAcls?: Array<{ scope: string; grantee: string; privilege: string; isGrantable?: boolean }>;
  }) => void;
  cleanupDatabaseBootstrapResources: (input: {
    client: {
      query: (sql: string, parameters?: unknown[]) => Promise<{ rows: Array<{ released?: boolean }> }>;
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
  databaseAppUrl: "postgresql://learncoding_app:app-Fake-B-000000000000000000000@postgres:5432/learncoding",
  databaseMigratorUrl:
    "postgresql://learncoding_migrator:migrator-Fake-C-00000000000000000@postgres:5432/learncoding",
  databaseWorkerUrl:
    "postgresql://learncoding_worker:worker-Fake-D-0000000000000000000@postgres:5432/learncoding",
  databaseOpsUrl: "postgresql://learncoding_ops:ops-Fake-E-000000000000000000000@postgres:5432/learncoding",
};

const bootstrapRoleRows = [
  {
    rolname: "learncoding_app",
    rolcanlogin: true,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolinherit: false,
    rolreplication: false,
    rolbypassrls: false,
    rolconnlimit: -1,
    valid_until_infinity: true,
    password_is_null: false,
    password_is_scram: true,
    role_settings_empty: true,
  },
  {
    rolname: "learncoding_migrator",
    rolcanlogin: true,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolinherit: false,
    rolreplication: false,
    rolbypassrls: false,
    rolconnlimit: -1,
    valid_until_infinity: true,
    password_is_null: false,
    password_is_scram: true,
    role_settings_empty: true,
  },
  {
    rolname: "learncoding_ops",
    rolcanlogin: true,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolinherit: false,
    rolreplication: false,
    rolbypassrls: false,
    rolconnlimit: -1,
    valid_until_infinity: true,
    password_is_null: false,
    password_is_scram: true,
    role_settings_empty: true,
  },
  {
    rolname: "learncoding_owner",
    rolcanlogin: false,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolinherit: false,
    rolreplication: false,
    rolbypassrls: false,
    rolconnlimit: -1,
    valid_until_infinity: true,
    password_is_null: true,
    password_is_scram: false,
    role_settings_empty: true,
  },
  {
    rolname: "learncoding_worker",
    rolcanlogin: true,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolinherit: false,
    rolreplication: false,
    rolbypassrls: false,
    rolconnlimit: -1,
    valid_until_infinity: true,
    password_is_null: false,
    password_is_scram: true,
    role_settings_empty: true,
  },
] as const;

const bootstrapMembershipRows = [{
  granted_role: "learncoding_owner",
  member_role: "learncoding_migrator",
  admin_option: false,
  inherit_option: false,
  set_option: true,
  member_option: true,
  usage_option: false,
  role_set_option: true,
}] as const;

const bootstrapOwnershipExact = {
  database_owned: true,
  canonical_databases_unchanged: true,
  no_unexpected_owned_database: true,
  canonical_tablespaces_unchanged: true,
  no_unexpected_owned_tablespace: true,
  public_schema_owned: true,
  drizzle_schema_owned: true,
  relations_owned: true,
  routines_owned: true,
  types_owned: true,
} as const;

const bootstrapPrivilegesExact = {
  public_connect_revoked: true,
  public_temp_revoked: true,
  public_create_revoked: true,
  migrator_connect: true,
  migrator_no_temp: true,
  migrator_no_create: true,
  migrator_no_schema_usage: true,
  migrator_no_schema_create: true,
  public_schema_usage_revoked: true,
  public_schema_create_revoked: true,
  runtime_database_schema_exact: true,
  drizzle_restricted: true,
  table_privileges_exact: true,
  worker_other_table_privileges_exact: true,
  worker_outbox_privileges_exact: true,
  sequence_privileges_exact: true,
  migrator_table_restricted: true,
  migrator_sequence_restricted: true,
  runtime_type_usage: true,
  migrator_type_restricted: true,
  routine_execute_exact: true,
  routine_direct_acl_exact: true,
  type_direct_acl_exact: true,
} as const;

function bootstrapDefaultAclRows() {
  const privilegesByKind = {
    r: ["DELETE", "INSERT", "SELECT", "UPDATE"],
    S: ["SELECT", "UPDATE", "USAGE"],
    T: ["USAGE"],
  } as const;
  return ["learncoding_app", "learncoding_worker", "learncoding_ops"].flatMap(
    (grantee) => Object.entries(privilegesByKind).flatMap(
      ([kind, privileges]) => privileges.map((privilege_type) => ({
        schema: "public",
        owner: "learncoding_owner",
        grantee,
        kind,
        privilege_type,
        is_grantable: false,
      })),
    ),
  );
}

describe("database least-privilege bootstrap", () => {
  it("uses one shared database-administration advisory lock", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();

    expect(databaseRoleBootstrap).not.toBeNull();
    expect(databaseRoleBootstrap?.DATABASE_ADMIN_LOCK_NAME).toBe(
      "codestead:database-administration:v1",
    );
  });

  it("registers the exact reviewed 0063 routine and trigger contracts", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();

    expect(databaseRoleBootstrap).not.toBeNull();
    expect(databaseRoleBootstrap!.REVIEWED_APPLICATION_FUNCTIONS).toEqual([
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
        signature:
          "public.redact_unresolved_email_outbox_authority(timestamp with time zone,integer)",
        owner: "learncoding_owner",
        securityDefiner: true,
        configuration: ["search_path=pg_catalog"],
        allowedRoles: ["learncoding_ops"],
      },
    ]);
    expect(databaseRoleBootstrap!.REVIEWED_APPLICATION_TRIGGERS).toEqual([
      {
        relation: "public.email_outbox",
        name: "email_outbox_payload_immutable",
        functionSignature: "public.enforce_email_outbox_payload_immutable()",
        enabled: "O",
        type: 19,
        qualifier: null,
        arguments: 0,
        columns: [
          "delivery_scope_key",
          "idempotency_key",
          "operation_id",
          "template",
          "template_version",
          "to_email",
          "user_id",
          "variables",
        ],
      },
    ]);
    const reviewedGrant = databaseRoleBootstrap!
      .reviewedApplicationFunctionPrivilegesSql()
      .toLowerCase();
    expect(reviewedGrant).toContain(
      "grant execute on function public.redact_unresolved_email_outbox_authority(timestamp with time zone,integer) to learncoding_ops",
    );
    expect(reviewedGrant).not.toMatch(/to\s+(public|learncoding_app|learncoding_worker|learncoding_migrator)\b/iu);
    expect(reviewedGrant).not.toMatch(/alter\s+function/iu);

    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile("scripts/bootstrap-database-roles.mjs", "utf8"));
    expect(source.indexOf("revoke execute on all routines in schema public"))
      .toBeLessThan(
        source.indexOf("await client.query(reviewedApplicationFunctionPrivilegesSql())"),
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

  it("does not repair a wrong reviewed routine owner before bootstrap verification", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();

    expect(databaseRoleBootstrap).not.toBeNull();
    const queryLog: Array<{ sql: string; parameters?: unknown[] }> = [];
    let reviewedRoutineOwner = urls.postgresUser;
    let transferSql = "";
    const client = {
      query: vi.fn(async (sql: string, parameters?: unknown[]) => {
        queryLog.push({ sql, parameters });
        const normalized = sql.replaceAll(/\s+/gu, " ").trim().toLowerCase();
        if (normalized.includes("select current_user, current_database(), rolsuper")) {
          return { rows: [{
            current_user: urls.postgresUser,
            current_database: urls.postgresDatabase,
            rolsuper: true,
          }] };
        }
        if (normalized.includes("pg_try_advisory_lock")) {
          return { rows: [{ acquired: true }] };
        }
        if (normalized === "begin" || normalized === "rollback") {
          return { rows: [] };
        }
        if (normalized.includes("pg_advisory_unlock")) {
          return { rows: [{ released: true }] };
        }
        if (normalized.startsWith("select d.datname name")) {
          return { rows: [{ name: urls.postgresDatabase, owner: urls.postgresUser }] };
        }
        if (normalized.startsWith("select t.spcname name")) return { rows: [] };
        if (normalized.startsWith("select n.nspname name")) {
          return { rows: [{ name: "public", owner: "pg_database_owner" }] };
        }
        if (normalized.startsWith("select n.nspname schema, c.relname name")) {
          return { rows: [] };
        }
        if (normalized.startsWith("select n.nspname schema, p.proname name")) {
          return { rows: [{
            schema: "public",
            name: "classify_email_outbox_retention_redaction",
            kind: "f",
            owner: reviewedRoutineOwner,
          }] };
        }
        if (normalized.startsWith("select n.nspname schema, t.typname name")) {
          return { rows: [] };
        }
        if (normalized.startsWith("select coalesce(n.nspname, '*') schema")) {
          return { rows: [] };
        }
        if (normalized.startsWith("select catalog, object_id")) return { rows: [] };
        if (normalized.startsWith("select scope, grantee, privilege")) return { rows: [] };
        if (normalized.includes("select count(*)::integer remaining")) {
          return { rows: [{ remaining: 0 }] };
        }
        if (
          normalized.includes("alter database %i owner to learncoding_owner") &&
          normalized.includes("from pg_proc p")
        ) {
          transferSql = sql;
          const resolvesEveryReviewedOid = databaseRoleBootstrap!
            .REVIEWED_APPLICATION_FUNCTIONS.every(({ signature }) =>
              sql.includes(`pg_catalog.to_regprocedure('${signature}')`));
          const excludesResolvedOids = /and\s+not\s+exists\s*\(\s*select\s+1\s+from\s+pg_catalog\.unnest\([\s\S]+?\)\s+reviewed_routine\(routine_oid\)\s+where\s+reviewed_routine\.routine_oid\s*=\s*p\.oid\s*\)/iu.test(sql);
          if (!resolvesEveryReviewedOid || !excludesResolvedOids) {
            reviewedRoutineOwner = "learncoding_owner";
          }
          return { rows: [] };
        }
        if (normalized === "select to_regclass('public.email_outbox') is not null present") {
          return { rows: [{ present: true }] };
        }
        if (normalized.startsWith("select exists(select 1 from pg_namespace")) {
          return { rows: [{ present: false }] };
        }
        if (normalized.startsWith("select rolname, rolcanlogin")) {
          return { rows: [...bootstrapRoleRows] };
        }
        if (normalized.startsWith("select granted.rolname granted_role")) {
          return { rows: [...bootstrapMembershipRows] };
        }
        if (normalized.startsWith("select count(*)::integer count from pg_db_role_setting")) {
          return { rows: [{ count: 0 }] };
        }
        if (normalized.startsWith("select (select pg_get_userbyid(datdba)")) {
          return { rows: [{
            ...bootstrapOwnershipExact,
            routines_owned: reviewedRoutineOwner === "learncoding_owner",
          }] };
        }
        if (normalized.includes("routine_direct_acl_exact")) {
          throw new Error("reviewed routine owner was silently repaired");
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };

    await expect(databaseRoleBootstrap!.runDatabaseRoleBootstrap({
      ...urls,
      pool,
      lockTimeoutMs: 100,
      cleanupTimeoutMs: 100,
    })).rejects.toThrow(
      "database role bootstrap invariant verification failed [ownership: routines_owned]",
    );

    expect(reviewedRoutineOwner).toBe(urls.postgresUser);
    expect(transferSql).not.toBe("");
    const transferIndex = queryLog.findIndex(({ sql }) => sql === transferSql);
    const reconcileIndex = queryLog.findIndex(({ sql }) =>
      sql.includes("revoke all on database %I from public"));
    const verificationIndex = queryLog.findIndex(({ sql }) =>
      sql.includes("routines_owned"));
    expect(transferIndex).toBeGreaterThanOrEqual(0);
    expect(reconcileIndex).toBeGreaterThan(transferIndex);
    expect(verificationIndex).toBeGreaterThan(reconcileIndex);
    expect(queryLog.some(({ sql }) => sql.trim().toLowerCase() === "commit")).toBe(false);
    expect(queryLog.some(({ sql }) => sql.trim().toLowerCase() === "rollback")).toBe(true);
    expect(client.release).toHaveBeenCalledWith(true);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it.each([
    "missing owner EXECUTE ACL",
    "owner EXECUTE grant option",
    "extra routine ACL",
  ])("fails bootstrap state for %s", async (tamper) => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();

    expect(databaseRoleBootstrap).not.toBeNull();
    let routineAclSql = "";
    const client = {
      query: vi.fn(async (sql: string) => {
        const normalized = sql.replaceAll(/\s+/gu, " ").trim().toLowerCase();
        if (normalized.startsWith("select rolname, rolcanlogin")) {
          return { rows: [...bootstrapRoleRows] };
        }
        if (normalized.startsWith("select granted.rolname granted_role")) {
          return { rows: [...bootstrapMembershipRows] };
        }
        if (normalized.startsWith("select count(*)::integer count from pg_db_role_setting")) {
          return { rows: [{ count: 0 }] };
        }
        if (normalized.startsWith("select (select pg_get_userbyid(datdba)")) {
          return { rows: [{ ...bootstrapOwnershipExact }] };
        }
        if (normalized.includes("routine_direct_acl_exact")) {
          routineAclSql = sql;
          const marker = sql.indexOf(") routine_direct_acl_exact");
          const routineAclStart = sql.lastIndexOf("with observed(", marker);
          const routineAclContract = sql.slice(routineAclStart, marker);
          const observesOwnerAcl = !/acl\.grantee\s*<>\s*p\.proowner/iu.test(
            routineAclContract,
          );
          const expectsOwnerAcl = /select\s+p\.oid,\s*p\.proowner,\s*p\.proowner,\s*'EXECUTE'::text,\s*false\s+from\s+pg_catalog\.pg_proc\s+p\s+join\s+pg_catalog\.pg_namespace/iu.test(
            routineAclContract,
          );
          const simulatedAclIsExact = !(observesOwnerAcl && expectsOwnerAcl && tamper);
          return { rows: [{
            ...bootstrapPrivilegesExact,
            routine_direct_acl_exact: simulatedAclIsExact,
          }] };
        }
        if (normalized.includes("where grantee not in")) {
          return { rows: [{ count: 0 }] };
        }
        if (normalized.includes("from pg_default_acl a")) {
          return { rows: bootstrapDefaultAclRows() };
        }
        if (normalized.startsWith("select count(*)::integer count from pg_stat_activity")) {
          return { rows: [{ count: 0 }] };
        }
        throw new Error(`unexpected bootstrap-state query: ${normalized.slice(0, 80)}`);
      }),
    };

    await expect(
      databaseRoleBootstrap!.verifyDatabaseRoleBootstrapState(
        client,
        urls.postgresDatabase,
        urls.postgresUser,
      ),
    ).rejects.toThrow(
      "database role bootstrap invariant verification failed [privileges: routine_direct_acl_exact]",
    );

    const marker = routineAclSql.indexOf(") routine_direct_acl_exact");
    const routineAclStart = routineAclSql.lastIndexOf("with observed(", marker);
    const routineAclContract = routineAclSql.slice(routineAclStart, marker);
    expect(routineAclContract).not.toMatch(/acl\.grantee\s*<>\s*p\.proowner/iu);
    expect(routineAclContract).toMatch(
      /select\s+p\.oid,\s*p\.proowner,\s*p\.proowner,\s*'EXECUTE'::text,\s*false\s+from\s+pg_catalog\.pg_proc\s+p\s+join\s+pg_catalog\.pg_namespace/iu,
    );
  });

  it("wires the real role boundaries into the behavior-tested release cycles", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile("scripts/run-integration-tests.ts", "utf8"));
    const bootstrapSource = await import("node:fs/promises").then(({ readFile }) =>
      readFile("scripts/bootstrap-database-roles.mjs", "utf8"));
    const packageJson = await import("node:fs/promises").then(async ({ readFile }) =>
      JSON.parse(await readFile("package.json", "utf8")) as {
        scripts: Record<string, string>;
      });
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
    expect(source).toContain("new Pool({ connectionString: input.databaseUrl, max: 1 })");
    expect(source).toContain("verifyDisposableRoleBoundaryAdapter({");
    expect(source).toContain("buildDisposableToolEnvironment(");
    expect(source).toContain("env: toolEnvironment");
    expect(source).not.toContain("options.env ?? process.env");
    expect(source).toContain("expectedJournalCount");
    expect(source).toContain("postgresUser: input.integrationUser");
    expect(source).toContain("verifyDatabaseRoleBootstrapState");
    expect(source).toContain("reconcileRoles: () => reconcileDisposableIntegrationRoles(topology)");
    expect(source).toContain("verifyDisposableIntegrationRoleBoundaries({");
    expect(source).toContain("migrate: () => runDisposableIntegrationMigration(roleUrls.migrator)");
    expect(source).toContain("verifyTopology: () => verifyDisposableIntegrationTopology(topology)");
    expect(source).toContain(
      "buildDisposableIntegrationRuntimeEnvironment(process.env",
    );
    expect(source).not.toContain("sanitizedIntegrationEnvironment");
    expect(source).toContain("ownerAssumingDatabaseUrl(roleUrls.migrator)");
    expect(source).toContain('client.release();\n    await pool.end();');
    expect(source).not.toContain("journal_count !== 63");
    expect(source).not.toContain("`POSTGRES_PASSWORD=${password}`");
    expect(source).not.toContain("DATABASE_URL: databaseUrl");
    for (const role of [
      "learncoding_owner",
      "learncoding_migrator",
      "learncoding_app",
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
      readFile("integration/postgres.integration.test.ts", "utf8"));
    const opsProofSource = await import("node:fs/promises").then(({ readFile }) =>
      readFile("integration/retention-ops-session.integration.test.ts", "utf8"));
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
    expect(source).toContain("const integrationRetentionFileErasureDependencies = {");
    expect(source).toContain(
      "connectionString: process.env.DATABASE_OPS_URL",
    );
    expect(source).toContain("integrationRetentionPool.end()");
    expect(dependencyStart).toBeGreaterThanOrEqual(0);
    expect(dependencyEnd).toBeGreaterThan(dependencyStart);
    expect(source.slice(dependencyStart, dependencyEnd)).toContain(
      "acquireClient: () => integrationRetentionPool.connect()",
    );
    expect(retentionCalls.length).toBeGreaterThan(0);
    expect(scopedRetentionCalls).toHaveLength(retentionCalls.length);
    expect(opsProofSource.match(/runRetention\(/gu)).toHaveLength(1);
    expect(opsProofSource).toContain("}, integrationRetentionDependencies);");
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
    });
  });

  it.each([
    ["bootstrap user reused by app", { databaseAppUrl: urls.databaseBootstrapUrl }],
    [
      "session-changing query option",
      { databaseAppUrl: `${urls.databaseAppUrl}?options=-csearch_path%3Dpublic` },
    ],
    [
      "wrong database host",
      { databaseWorkerUrl: urls.databaseWorkerUrl.replace("@postgres:", "@localhost:") },
    ],
    [
      "duplicate password",
      { databaseOpsUrl: urls.databaseAppUrl.replace("learncoding_app", "learncoding_ops") },
    ],
    [
      "short password",
      { databaseOpsUrl: "postgresql://learncoding_ops:too-short@postgres:5432/learncoding" },
    ],
  ])("rejects %s without exposing credentials", async (_name, override) => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();

    expect(databaseRoleBootstrap).not.toBeNull();
    expect(() => databaseRoleBootstrap!.validateDatabaseRoleUrls({ ...urls, ...override })).toThrow(
      /database credential configuration is invalid/u,
    );
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
            scope: "database learncoding",
            grantee: "learncoding_migrator",
            privilege: "CONNECT",
            isGrantable: false,
          },
        ],
      }),
    ).not.toThrow();
  });

  it.each([
    ["decoy database", { databases: [{ name: "decoy", owner: "legacy_bootstrap" }] }],
    ["decoy tablespace", { tablespaces: [{ name: "decoy_space", owner: "legacy_bootstrap" }] }],
    ["out-of-scope schema", { schemas: [{ name: "decoy", owner: "legacy_bootstrap" }] }],
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
          { scope: "table public.lesson", grantee: "legacy_reader", privilege: "SELECT" },
        ],
      },
    ],
    [
      "grantable direct ACL",
      {
        directAcls: [
          { scope: "table public.lesson", grantee: "learncoding_app", privilege: "SELECT", isGrantable: true },
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

  it("declares aggregate ownership and non-grantable ACL invariants", async () => {
    const [{ readFile }, { join }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    const source = await readFile(join(process.cwd(), "scripts", "bootstrap-database-roles.mjs"), "utf8");

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
    expect(source).toContain("alter default privileges for role learncoding_owner in schema public");
    expect(source).not.toMatch(/rolconfig is null/u);
    expect(source).toMatch(/not exists \(\s*select 1 from pg_db_role_setting/iu);
    expect(source).not.toMatch(/has_[a-z_]+_privilege\('PUBLIC'/u);
    expect(source).toMatch(/pg_terminate_backend\(pid\)/u);
    expect(source).not.toMatch(/pg_terminate_backend\(pid,\s*5000\)/u);
    expect(source).toMatch(/MAX_SESSION_DRAIN_MS/u);
    expect(source).toMatch(/pg_stat_clear_snapshot\(\)/u);
    expect(source).toMatch(/privilege\.is_grantable/u);
    expect(source).toMatch(/has_function_privilege\(0, p\.oid, 'EXECUTE'\)/u);
  });
});
