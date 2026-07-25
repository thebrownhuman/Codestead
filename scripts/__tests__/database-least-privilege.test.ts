import { describe, expect, it, vi } from "vitest";

type DatabaseRoleModule = {
  DATABASE_ADMIN_LOCK_NAME: string;
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

type DatabasePrivilegeManifestModule = {
  DATABASE_PRIVILEGE_MANIFEST: {
    version: string;
    tables: Record<string, Partial<Record<"learncoding_app" | "learncoding_worker" | "learncoding_ops", readonly string[]>>>;
    routines: Record<string, Partial<Record<"learncoding_app" | "learncoding_worker" | "learncoding_ops", readonly string[]>>>;
    defaultPrivileges: Record<string, readonly string[]>;
    services: Record<string, { role: string; secret: string }>;
  };
  validateDatabasePrivilegeManifest: (input: { tableNames: readonly string[] }) => void;
};

async function loadDatabaseRoleModule(): Promise<DatabaseRoleModule | null> {
  const modulePath = "../bootstrap-database-roles.mjs";
  try {
    return (await import(/* @vite-ignore */ modulePath)) as DatabaseRoleModule;
  } catch {
    return null;
  }
}

async function loadDatabasePrivilegeManifest(): Promise<DatabasePrivilegeManifestModule | null> {
  const modulePath = "../database-privilege-manifest.mjs";
  try {
    return (await import(/* @vite-ignore */ modulePath)) as DatabasePrivilegeManifestModule;
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

describe("database least-privilege bootstrap", () => {
  it("publishes one versioned manifest covering every current public table", async () => {
    const manifestModule = await loadDatabasePrivilegeManifest();
    expect(manifestModule).not.toBeNull();

    const [{ readFile }, { join }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    const snapshot = JSON.parse(
      await readFile(join(process.cwd(), "drizzle", "meta", "0056_snapshot.json"), "utf8"),
    ) as { tables: Record<string, unknown> };
    const tableNames = Object.keys(snapshot.tables)
      .filter((name) => name.startsWith("public."))
      .map((name) => name.slice("public.".length))
      .sort();

    expect(manifestModule!.DATABASE_PRIVILEGE_MANIFEST.version).toBe("2026-07-22.v1");
    expect(() => manifestModule!.validateDatabasePrivilegeManifest({ tableNames })).not.toThrow();
    expect(Object.keys(manifestModule!.DATABASE_PRIVILEGE_MANIFEST.tables).sort()).toEqual(tableNames);
  });

  it("contains the reviewed worker/ops denial and routine boundaries", async () => {
    const manifestModule = await loadDatabasePrivilegeManifest();
    expect(manifestModule).not.toBeNull();
    const manifest = manifestModule!.DATABASE_PRIVILEGE_MANIFEST;

    for (const sensitive of ["account", "session", "auth_session_history", "provider_credential"]) {
      expect(manifest.tables[sensitive]?.learncoding_worker ?? []).toEqual([]);
    }
    for (const grading of ["attempt", "response", "assessment_attempt_effective_result"]) {
      expect(manifest.tables[grading]?.learncoding_ops ?? []).not.toContain("INSERT");
      expect(manifest.tables[grading]?.learncoding_ops ?? []).not.toContain("UPDATE");
      expect(manifest.tables[grading]?.learncoding_ops ?? []).not.toContain("DELETE");
    }
    expect(
      Object.entries(manifest.routines)
        .filter(([, grants]) => grants.learncoding_worker?.includes("EXECUTE"))
        .map(([signature]) => signature)
        .sort(),
    ).toEqual([
      "public.enqueue_reward_jobs_for_attempt_v1(uuid,text,timestamp with time zone)",
      "public.enqueue_reward_jobs_for_mastery_scope_v1(uuid,text,timestamp with time zone)",
    ]);
    expect(manifest.defaultPrivileges).toEqual({
      tables: [],
      sequences: [],
      types: [],
      routines: [],
    });
  });

  it("assigns every long-lived worker and operation a distinct login credential", async () => {
    const manifestModule = await loadDatabasePrivilegeManifest();
    expect(manifestModule).not.toBeNull();
    const services = manifestModule!.DATABASE_PRIVILEGE_MANIFEST.services;
    expect(Object.keys(services).sort()).toEqual([
      "admin-bootstrap",
      "app",
      "exam-finalization-worker",
      "file-erasure-worker",
      "lifecycle",
      "mail-worker",
      "platform-seed",
      "practice-runner-recovery-worker",
      "project-review-correction-worker",
      "regrade-worker",
      "reward-worker",
      "scan-worker",
    ]);
    const roles = Object.values(services).map((service) => service.role);
    const secrets = Object.values(services).map((service) => service.secret);
    expect(new Set(roles).size).toBe(roles.length);
    expect(new Set(secrets).size).toBe(secrets.length);
    expect(roles).not.toContain("learncoding_worker");
    expect(roles).not.toContain("learncoding_ops");
  });

  it("removes direct destructive app access from append-only history and projections", async () => {
    const manifestModule = await loadDatabasePrivilegeManifest();
    expect(manifestModule).not.toBeNull();
    const tables = manifestModule!.DATABASE_PRIVILEGE_MANIFEST.tables;

    for (const table of [
      "audit_event",
      "auth_session_history",
      "project_review",
      "project_review_correction_event",
      "reward_ledger",
    ]) {
      expect(tables[table]?.learncoding_app ?? []).not.toContain("DELETE");
    }
    expect(tables.project_review_effective?.learncoding_app ?? []).toEqual(["SELECT"]);
  });

  it("uses one shared database-administration advisory lock", async () => {
    const databaseRoleBootstrap = await loadDatabaseRoleModule();

    expect(databaseRoleBootstrap).not.toBeNull();
    expect(databaseRoleBootstrap?.DATABASE_ADMIN_LOCK_NAME).toBe(
      "codestead:database-administration:v1",
    );
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
