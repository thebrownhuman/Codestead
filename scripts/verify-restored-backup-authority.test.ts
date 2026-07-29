import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  installRestoreLedgerAuthority,
  removeRestoreLedgerAuthorityBeforeBootstrap,
  resolveRestoreLedgerAuthorityEnvironment,
  resolveRestoreLedgerAuthorityIdentityEnvironment,
  resolveRestoreSmokeEnvironment,
  RESTORE_LEDGER_AUTHORITY_BODY,
  restoreDatabaseClientConfig,
  RESTORE_DATABASE_CLIENT_TIMEOUTS,
  runRestoreDatabaseClientOperation,
  verifyRestoreLedgerRuntimeAuthority,
} from "./verify-restored-backup";

type ReviewedLedger = Readonly<{
  REVIEWED_MIGRATION_LEDGER: readonly Readonly<{
    idx: number;
    when: number;
    sqlSha256: string;
  }>[];
  REVIEWED_MIGRATION_LEDGER_SHA256: string;
}>;

async function reviewedLedger() {
  return await import("./lib/reviewed-migration-ledger.mjs") as
    ReviewedLedger;
}

async function exactAppliedLedgerRows() {
  const { REVIEWED_MIGRATION_LEDGER } = await reviewedLedger();
  return REVIEWED_MIGRATION_LEDGER.map((entry, index) => ({
    id: String(index + 1),
    hash: entry.sqlSha256,
    created_at: String(entry.when),
  }));
}

const runtimeIdentity = {
  current_user: "learncoding_ops",
  session_user: "learncoding_ops",
  superuser: false,
  owner_membership: false,
  drizzle_schema_usage: false,
  ledger_select: false,
  ledger_column_privilege: false,
};

const authorityCatalog = {
  owner_name: "learncoding_restore_ledger_reader",
  definer_role_exact: true,
  definer_membership_exact: true,
  definer_role_setting_exact: true,
  definer_default_acl_exact: true,
  definer_dependency_set_exact: true,
  definer_application_privileges_exact: true,
  definer_drizzle_acl_exact: true,
  ledger_relation_exact: true,
  ledger_columns_exact: true,
  audit_schema_exact: true,
  audit_schema_acl_exact: true,
  audit_object_set_exact: true,
  audit_namespace_dependency_set_exact: true,
  authority_extension_dependency_exact: true,
  overload_set_exact: true,
  security_definer: true,
  stable: true,
  parallel_unsafe: true,
  leakproof: false,
  strict: false,
  language_name: "plpgsql",
  support_exact: true,
  binary_exact: true,
  cost_exact: true,
  rows_exact: true,
  search_path_exact: true,
  signature_exact: true,
  body_exact: true,
  acl_exact: true,
};

describe("restore-only migration-ledger authority", () => {
  it("requires an explicit complete-ledger assertion before installer startup", () => {
    const base = {
      DATABASE_BOOTSTRAP_URL:
        "postgresql://codestead_restore:secret@postgres:5432/learncoding_restore",
      POSTGRES_DB: "learncoding_restore",
      POSTGRES_USER: "codestead_restore",
    };
    for (const value of [undefined, "", "false", "TRUE", "1", "yes"]) {
      expect(() =>
        resolveRestoreLedgerAuthorityEnvironment({
          ...base,
          ...(value === undefined
            ? {}
            : { REQUIRE_COMPLETE_MIGRATION_LEDGER: value }),
        }),
      ).toThrow("complete migration ledger");
    }
    expect(
      resolveRestoreLedgerAuthorityEnvironment({
        ...base,
        REQUIRE_COMPLETE_MIGRATION_LEDGER: "true",
      }),
    ).toEqual({
      databaseUrl: base.DATABASE_BOOTSTRAP_URL,
      identity: {
        expectedBootstrapUser: base.POSTGRES_USER,
        expectedDatabase: base.POSTGRES_DB,
      },
      requireLedger: true,
    });
  });

  it("resolves pre-bootstrap removal identity without requiring a complete ledger", () => {
    const base = {
      DATABASE_BOOTSTRAP_URL:
        "postgresql://codestead_restore:secret@postgres:5432/learncoding_restore",
      POSTGRES_DB: "learncoding_restore",
      POSTGRES_USER: "codestead_restore",
    };
    for (const value of [undefined, "false"]) {
      expect(
        resolveRestoreLedgerAuthorityIdentityEnvironment({
          ...base,
          ...(value === undefined
            ? {}
            : { REQUIRE_COMPLETE_MIGRATION_LEDGER: value }),
        }),
      ).toEqual({
        databaseUrl: base.DATABASE_BOOTSTRAP_URL,
        identity: {
          expectedBootstrapUser: base.POSTGRES_USER,
          expectedDatabase: base.POSTGRES_DB,
        },
      });
    }
    for (const missing of [
      "DATABASE_BOOTSTRAP_URL",
      "POSTGRES_DB",
      "POSTGRES_USER",
    ]) {
      const environment = { ...base };
      delete environment[missing as keyof typeof environment];
      expect(() =>
        resolveRestoreLedgerAuthorityIdentityEnvironment(environment)
      ).toThrow("environment is incomplete");
    }
  });

  it("proves the ops runtime has no direct drizzle access before accepting exact authority rows", async () => {
    const queries: string[] = [];
    const ledgerRows = await exactAppliedLedgerRows();
    const { REVIEWED_MIGRATION_LEDGER_SHA256 } = await reviewedLedger();
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("restore_ledger_runtime_identity")) {
          return { rows: [runtimeIdentity] };
        }
        if (sql.includes("restore_ledger_direct_select_denied")) {
          throw Object.assign(new Error("permission denied"), { code: "42501" });
        }
        if (sql.includes("restore_ledger_authority_catalog")) {
          return { rows: [authorityCatalog] };
        }
        if (sql.includes("restore_reviewed_ledger_authority_rows")) {
          return { rows: ledgerRows };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    };

    await expect(verifyRestoreLedgerRuntimeAuthority(client)).resolves.toEqual({
      appliedCount: 70,
      complete: true,
      ledgerSha256: REVIEWED_MIGRATION_LEDGER_SHA256,
    });
    expect(queries).toHaveLength(4);
    expect(queries[0]).toContain("has_schema_privilege");
    expect(queries[0]).toContain("has_table_privilege");
    expect(queries[0]).toContain("COALESCE(");
    expect(queries[0]).not.toContain("pg_catalog.coalesce(");
    expect(queries[1]).toContain("FROM drizzle.__drizzle_migrations");
    expect(queries[2]).not.toContain("pg_catalog.coalesce(");
    expect(queries[3]).toContain(
      "codestead_restore_audit.reviewed_migration_ledger()",
    );
    expect(queries[3]).toContain(
      "ORDER BY authority.id::pg_catalog.int8",
    );
    expect(queries[3]).not.toContain("FROM drizzle.__drizzle_migrations");
    expect(queries[2]).toContain("pg_catalog.pg_shdepend");
    expect(queries[2]).toContain("pg_catalog.pg_depend");
    expect(queries[2]).toContain("pg_catalog.pg_db_role_setting");
    expect(queries[2]).toContain("pg_catalog.pg_default_acl");
    expect(queries[2]).toContain("pg_catalog.pg_ts_parser");
    expect(queries[2]).toContain("pg_catalog.pg_ts_template");
    expect(queries[2]).toContain("pg_catalog.pg_statistic_ext");
    expect(queries[2]).toContain("has_database_privilege");
    expect(queries[2]).toContain("has_sequence_privilege");
    expect(queries[2]).toContain("has_any_column_privilege");
    expect(queries[2]).toContain("has_function_privilege");
    expect(queries[2]).toContain("has_type_privilege");
    expect(queries[2]).toContain("type_object.typtype IN ('b', 'c', 'd', 'e', 'r', 'm')");
    expect(queries[2]).toContain("attribute.attacl IS NULL");
    expect(queries[2]).toContain("AS collation_object");
    expect(queries[2]).not.toMatch(/\bAS\s+collation\b/u);
  });

  it.each([
    [{ ...runtimeIdentity, current_user: "learncoding_owner" }, "identity"],
    [{ ...runtimeIdentity, superuser: true }, "identity"],
    [{ ...runtimeIdentity, owner_membership: true }, "identity"],
    [{ ...runtimeIdentity, drizzle_schema_usage: true }, "direct ledger access"],
    [{ ...runtimeIdentity, ledger_select: true }, "direct ledger access"],
    [{ ...runtimeIdentity, ledger_column_privilege: true }, "direct ledger access"],
  ])("rejects an unsafe ops runtime boundary: %s", async (identity, message) => {
    const client = {
      async query(sql: string) {
        if (sql.includes("restore_ledger_runtime_identity")) {
          return { rows: [identity] };
        }
        throw new Error("authority must not run after an unsafe identity");
      },
    };

    await expect(verifyRestoreLedgerRuntimeAuthority(client)).rejects.toThrow(
      message,
    );
  });

  it("rejects an ops role whose direct ledger SELECT unexpectedly succeeds", async () => {
    const client = {
      async query(sql: string) {
        if (sql.includes("restore_ledger_runtime_identity")) {
          return { rows: [runtimeIdentity] };
        }
        if (sql.includes("restore_ledger_direct_select_denied")) {
          return { rows: [] };
        }
        throw new Error("authority must not run after a successful direct SELECT");
      },
    };

    await expect(verifyRestoreLedgerRuntimeAuthority(client)).rejects.toThrow(
      "direct ledger SELECT was not denied",
    );
  });

  it("rejects a drifted authority catalog before reading any ledger rows", async () => {
    const client = {
      async query(sql: string) {
        if (sql.includes("restore_ledger_runtime_identity")) {
          return { rows: [runtimeIdentity] };
        }
        if (sql.includes("restore_ledger_direct_select_denied")) {
          throw Object.assign(new Error("permission denied"), { code: "42501" });
        }
        if (sql.includes("restore_ledger_authority_catalog")) {
          return { rows: [{ ...authorityCatalog, acl_exact: false }] };
        }
        throw new Error("authority rows must not be read after catalog drift");
      },
    };

    await expect(verifyRestoreLedgerRuntimeAuthority(client)).rejects.toThrow(
      "catalog",
    );
  });

  it.each([
    "definer_role_setting_exact",
    "definer_default_acl_exact",
    "definer_dependency_set_exact",
    "definer_application_privileges_exact",
    "audit_object_set_exact",
    "ledger_columns_exact",
    "audit_namespace_dependency_set_exact",
    "authority_extension_dependency_exact",
  ] as const)(
    "rejects hostile %s catalog state before reading any ledger rows",
    async (unsafeField) => {
      const client = {
        async query(sql: string) {
          if (sql.includes("restore_ledger_runtime_identity")) {
            return { rows: [runtimeIdentity] };
          }
          if (sql.includes("restore_ledger_direct_select_denied")) {
            throw Object.assign(
              new Error("permission denied"),
              { code: "42501" },
            );
          }
          if (sql.includes("restore_ledger_authority_catalog")) {
            return {
              rows: [{ ...authorityCatalog, [unsafeField]: false }],
            };
          }
          throw new Error("authority rows must not be read after catalog drift");
        },
      };

      await expect(
        verifyRestoreLedgerRuntimeAuthority(client),
      ).rejects.toThrow("catalog");
    },
  );

  it("installs the authority only from the isolated restore bootstrap identity", async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("restore_ledger_installer_identity")) {
          return {
            rows: [{
              current_user: "codestead_restore",
              session_user: "codestead_restore",
              database_name: "learncoding_restore",
              superuser: true,
            }],
          };
        }
        if (sql.includes("restore_ledger_install_prerequisites")) {
          return {
            rows: [{
              ledger_present: true,
              owner_present: true,
              ops_present: true,
            }],
          };
        }
        if (sql.includes("restore_ledger_existing_authority")) {
          return { rows: [] };
        }
        if (sql.includes("restore_ledger_installer_secret")) {
          return {
            rows: [{ role_present: true, password_absent: true }],
          };
        }
        if (sql.includes("restore_ledger_direct_select_denied")) {
          throw Object.assign(new Error("permission denied"), { code: "42501" });
        }
        if (sql.includes("restore_ledger_authority_catalog")) {
          return { rows: [authorityCatalog] };
        }
        return { rows: [] };
      },
    };

    await expect(installRestoreLedgerAuthority(client, {
      requireLedger: true,
    })).resolves.toEqual({ installed: true });
    expect(queries).toEqual(expect.arrayContaining([
      expect.stringMatching(/^BEGIN$/iu),
      expect.stringContaining(
        "CREATE ROLE learncoding_restore_ledger_reader",
      ),
      expect.stringContaining(
        "CREATE SCHEMA codestead_restore_audit",
      ),
      expect.stringContaining(
        "GRANT USAGE ON SCHEMA drizzle",
      ),
      expect.stringContaining(
        "GRANT SELECT ON TABLE drizzle.__drizzle_migrations",
      ),
      expect.stringContaining(
        "SET LOCAL ROLE learncoding_restore_ledger_reader",
      ),
      expect.stringContaining(
        "CREATE FUNCTION codestead_restore_audit.reviewed_migration_ledger()",
      ),
      expect.stringContaining("SECURITY DEFINER"),
      expect.stringContaining("REVOKE ALL ON FUNCTION"),
      expect.stringContaining("GRANT EXECUTE ON FUNCTION"),
      expect.stringMatching(/^COMMIT$/iu),
    ]));
    expect(RESTORE_LEDGER_AUTHORITY_BODY).toContain(
      "session_user IS DISTINCT FROM 'learncoding_ops'",
    );
    expect(RESTORE_LEDGER_AUTHORITY_BODY).toContain(
      "current_user IS DISTINCT FROM 'learncoding_restore_ledger_reader'",
    );
    expect(RESTORE_LEDGER_AUTHORITY_BODY).toContain(
      "FROM drizzle.__drizzle_migrations",
    );
    expect(RESTORE_LEDGER_AUTHORITY_BODY).toMatch(/END;\n$/u);
  });

  it("resolves only the dedicated post-entrypoint restore key path", () => {
    const environment = {
      DATABASE_URL: "postgresql://learncoding_ops:redacted@postgres/learncoding_restore",
      RESTORE_APP_DATA_ROOT: "/restore-app-data",
      RESTORE_APP_DATA_MANIFEST: "/restore/app-data-objects.sha256",
      RESTORE_CREDENTIAL_PROBE: "/restore/credential-probe.json",
      RESTORE_CREDENTIAL_MASTER_KEY_PATH: "/run/secrets/credential_master_key",
    };

    expect(resolveRestoreSmokeEnvironment(environment)).toEqual(environment);
    expect(() => resolveRestoreSmokeEnvironment({
      ...environment,
      CREDENTIAL_MASTER_KEY: "plaintext-must-not-be-consumed",
    })).toThrow("generic credential key");
    expect(() => resolveRestoreSmokeEnvironment({
      ...environment,
      CREDENTIAL_MASTER_KEY_FILE: "/run/secrets/credential_master_key",
    })).toThrow("generic credential key");
    expect(() => resolveRestoreSmokeEnvironment({
      ...environment,
      RESTORE_CREDENTIAL_MASTER_KEY_PATH: "/restore/credential_master_key",
    })).toThrow("restore credential key path");
  });

  it("does not mutate a pre-restore database whose ledger is not present", async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("restore_ledger_installer_identity")) {
          return {
            rows: [{
              current_user: "codestead_restore",
              session_user: "codestead_restore",
              database_name: "learncoding_restore",
              superuser: true,
            }],
          };
        }
        return {
          rows: [{
            ledger_present: false,
            owner_present: true,
            ops_present: true,
          }],
        };
      },
    };

    await expect(installRestoreLedgerAuthority(client, {
      requireLedger: false,
    })).resolves.toEqual({ installed: false });
    expect(queries).toHaveLength(2);
    expect(queries).not.toContain("BEGIN");
  });

  it("anchors the reviewed ledger module to the verifier instead of a caller-controlled cwd", async () => {
    const originalCwd = process.cwd();
    const decoyRoot = await mkdtemp(path.join(tmpdir(), "restore-ledger-decoy-"));
    const decoyModuleRoot = path.join(decoyRoot, "scripts", "lib");
    const fakeDigest = "a".repeat(64);
    await mkdir(decoyModuleRoot, { recursive: true });
    await writeFile(
      path.join(decoyModuleRoot, "reviewed-migration-ledger.mjs"),
      [
        "export const REVIEWED_MIGRATION_LEDGER = Array.from({ length: 70 }, (_, idx) => ({",
        "  idx,",
        "  when: idx + 1,",
        "  tag: idx === 69 ? '0069_mail_outbox_guarded_delivery_authority' : `${String(idx).padStart(4, '0')}_decoy`,",
        "  sqlSha256: 'a'.repeat(64),",
        "}));",
        `export const REVIEWED_MIGRATION_LEDGER_SHA256 = "${fakeDigest}";`,
        "export async function verifyAppliedMigrationLedger() {",
        `  return { appliedCount: 70, complete: true, ledgerSha256: "${fakeDigest}" };`,
        "}",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
    const ledgerRows = await exactAppliedLedgerRows();
    const { REVIEWED_MIGRATION_LEDGER_SHA256 } = await reviewedLedger();
    const client = {
      async query(sql: string) {
        if (sql.includes("restore_ledger_runtime_identity")) {
          return { rows: [runtimeIdentity] };
        }
        if (sql.includes("restore_ledger_direct_select_denied")) {
          throw Object.assign(new Error("permission denied"), { code: "42501" });
        }
        if (sql.includes("restore_ledger_authority_catalog")) {
          return { rows: [authorityCatalog] };
        }
        if (sql.includes("restore_reviewed_ledger_authority_rows")) {
          return { rows: ledgerRows };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    };

    process.chdir(decoyRoot);
    try {
      await expect(verifyRestoreLedgerRuntimeAuthority(client)).resolves.toEqual({
        appliedCount: 70,
        complete: true,
        ledgerSha256: REVIEWED_MIGRATION_LEDGER_SHA256,
      });
    } finally {
      process.chdir(originalCwd);
      await rm(decoyRoot, { recursive: true, force: true });
    }
  });

  it("accepts an exact pre-existing authority as commit-ack convergence", async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("restore_ledger_installer_identity")) {
          return {
            rows: [{
              current_user: "codestead_restore",
              session_user: "codestead_restore",
              database_name: "learncoding_restore",
              superuser: true,
            }],
          };
        }
        if (sql.includes("restore_ledger_install_prerequisites")) {
          return {
            rows: [{
              ledger_present: true,
              owner_present: true,
              ops_present: true,
            }],
          };
        }
        if (sql.includes("restore_ledger_existing_authority")) {
          return {
            rows: [
              { object_kind: "role" },
              { object_kind: "schema" },
              { object_kind: "routine" },
            ],
          };
        }
        if (sql.includes("restore_ledger_installer_secret")) {
          return {
            rows: [{ role_present: true, password_absent: true }],
          };
        }
        if (sql.includes("restore_ledger_authority_catalog")) {
          return { rows: [authorityCatalog] };
        }
        return { rows: [] };
      },
    };

    await expect(installRestoreLedgerAuthority(client, {
      requireLedger: true,
    })).resolves.toEqual({ installed: false, converged: true });
    expect(queries).toContain("COMMIT");
    expect(queries).not.toContain("ROLLBACK");
    expect(queries.join("\n")).not.toContain(
      "CREATE ROLE learncoding_restore_ledger_reader",
    );
  });

  it("rejects and rolls back a partial pre-existing authority", async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("restore_ledger_installer_identity")) {
          return {
            rows: [{
              current_user: "codestead_restore",
              session_user: "codestead_restore",
              database_name: "learncoding_restore",
              superuser: true,
            }],
          };
        }
        if (sql.includes("restore_ledger_install_prerequisites")) {
          return {
            rows: [{
              ledger_present: true,
              owner_present: true,
              ops_present: true,
            }],
          };
        }
        if (sql.includes("restore_ledger_existing_authority")) {
          return { rows: [{ object_kind: "role" }] };
        }
        return { rows: [] };
      },
    };

    await expect(installRestoreLedgerAuthority(client, {
      requireLedger: true,
    })).rejects.toThrow("already exists");
    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
  });

  it("preserves installer failure and rollback failure together", async () => {
    const primary = new Error("create role failed");
    const rollback = new Error("rollback failed");
    const client = {
      async query(sql: string) {
        if (sql.includes("restore_ledger_installer_identity")) {
          return {
            rows: [{
              current_user: "codestead_restore",
              session_user: "codestead_restore",
              database_name: "learncoding_restore",
              superuser: true,
            }],
          };
        }
        if (sql.includes("restore_ledger_install_prerequisites")) {
          return {
            rows: [{
              ledger_present: true,
              owner_present: true,
              ops_present: true,
            }],
          };
        }
        if (sql.includes("restore_ledger_existing_authority")) {
          return { rows: [] };
        }
        if (sql.includes("restore_ledger_installer_secret")) {
          return {
            rows: [{ role_present: true, password_absent: true }],
          };
        }
        if (sql.includes("CREATE ROLE")) throw primary;
        if (sql === "ROLLBACK") throw rollback;
        return { rows: [] };
      },
    };

    const error = await installRestoreLedgerAuthority(client, {
      requireLedger: true,
    }).catch((caught: unknown) => caught);
    expect(error).toBe(primary);
    expect(primary.cause).toBeInstanceOf(AggregateError);
    expect((primary.cause as AggregateError).errors).toEqual([
      rollback,
    ]);
  });

  it("configures finite PostgreSQL connect, query, statement, transaction-idle, and close bounds", () => {
    const config = restoreDatabaseClientConfig(
      "postgresql://learncoding_ops:redacted@postgres/learncoding_restore",
    );
    expect(config).toMatchObject({
      connectionTimeoutMillis: RESTORE_DATABASE_CLIENT_TIMEOUTS.connectMs,
      query_timeout: RESTORE_DATABASE_CLIENT_TIMEOUTS.queryMs,
      statement_timeout: RESTORE_DATABASE_CLIENT_TIMEOUTS.statementMs,
      idle_in_transaction_session_timeout:
        RESTORE_DATABASE_CLIENT_TIMEOUTS.idleInTransactionMs,
    });
    expect(Object.values(RESTORE_DATABASE_CLIENT_TIMEOUTS)).toSatisfy(
      (values: number[]) =>
        values.every((value) => Number.isFinite(value) && value > 0),
    );
  });

  it("preserves a primary verifier failure together with bounded client cleanup failure", async () => {
    const primary = new Error("verification failed");
    const cleanup = new Error("client close failed");
    const client = {
      async connect() {},
      async query() {
        return { rows: [] };
      },
      async end() {
        throw cleanup;
      },
    };

    const error = await runRestoreDatabaseClientOperation(
      client,
      async () => {
        throw primary;
      },
      { connectMs: 50, closeMs: 50 },
    ).catch((caught: unknown) => caught);
    expect(error).toBe(primary);
    expect(primary.cause).toBeInstanceOf(AggregateError);
    expect((primary.cause as AggregateError).errors).toEqual([
      cleanup,
    ]);
  });

  it("preserves frozen primary and cleanup failures without mutating either", async () => {
    const primary = Object.freeze(new Error("frozen verification failure"));
    const cleanup = new Error("client close failed");
    const client = {
      async connect() {},
      async query() {
        return { rows: [] };
      },
      async end() {
        throw cleanup;
      },
    };

    const error = await runRestoreDatabaseClientOperation(
      client,
      async () => {
        throw primary;
      },
      { connectMs: 50, closeMs: 50 },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      primary,
      cleanup,
    ]);
    expect((error as AggregateError).cause).toBe(primary);
  });

  it("preserves an arbitrary thrown primary value together with cleanup failure", async () => {
    const primary = "non-error verification failure";
    const cleanup = new Error("client close failed");
    const client = {
      async connect() {},
      async query() {
        return { rows: [] };
      },
      async end() {
        throw cleanup;
      },
    };

    const error = await runRestoreDatabaseClientOperation(
      client,
      async () => {
        throw primary;
      },
      { connectMs: 50, closeMs: 50 },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      primary,
      cleanup,
    ]);
    expect((error as AggregateError).cause).toBe(primary);
  });

  it("bounds a stalled client close", async () => {
    const client = {
      async connect() {},
      async query() {
        return { rows: [] };
      },
      async end() {
        await new Promise(() => undefined);
      },
    };

    await expect(runRestoreDatabaseClientOperation(
      client,
      async () => "verified",
      { connectMs: 50, closeMs: 5 },
    )).rejects.toThrow("close timeout");
  });

  it("makes pre-bootstrap convergence a transactionally proven no-op at exact absence", async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("restore_ledger_installer_identity")) {
          return {
            rows: [{
              current_user: "codestead_restore",
              session_user: "codestead_restore",
              database_name: "learncoding_restore",
              superuser: true,
            }],
          };
        }
        if (sql.includes("restore_ledger_existing_authority")) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    };

    await expect(removeRestoreLedgerAuthorityBeforeBootstrap(client, {
      expectedBootstrapUser: "codestead_restore",
      expectedDatabase: "learncoding_restore",
    })).resolves.toEqual({ removed: false });
    expect(queries).toContain("BEGIN");
    expect(queries).toContain("COMMIT");
    expect(queries).not.toContain("ROLLBACK");
    expect(queries.join("\n")).not.toContain("DROP ROLE");
  });

  it("removes only an exact authority and proves exact absence before commit", async () => {
    const queries: string[] = [];
    let inventoryCalls = 0;
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("restore_ledger_installer_identity")) {
          return {
            rows: [{
              current_user: "codestead_restore",
              session_user: "codestead_restore",
              database_name: "learncoding_restore",
              superuser: true,
            }],
          };
        }
        if (sql.includes("restore_ledger_existing_authority")) {
          inventoryCalls += 1;
          return inventoryCalls === 1
            ? {
                rows: [
                  { object_kind: "role" },
                  { object_kind: "schema" },
                  { object_kind: "routine" },
                ],
              }
            : { rows: [] };
        }
        if (sql.includes("restore_ledger_installer_secret")) {
          return {
            rows: [{ role_present: true, password_absent: true }],
          };
        }
        if (sql.includes("restore_ledger_authority_catalog")) {
          return { rows: [authorityCatalog] };
        }
        return { rows: [] };
      },
    };

    await expect(removeRestoreLedgerAuthorityBeforeBootstrap(client, {
      expectedBootstrapUser: "codestead_restore",
      expectedDatabase: "learncoding_restore",
    })).resolves.toEqual({ removed: true });
    expect(inventoryCalls).toBe(2);
    expect(queries.join("\n")).toContain(
      "DROP FUNCTION codestead_restore_audit.reviewed_migration_ledger()",
    );
    expect(queries.join("\n")).toContain(
      "DROP SCHEMA codestead_restore_audit RESTRICT",
    );
    expect(queries.join("\n")).toContain(
      "DROP ROLE learncoding_restore_ledger_reader",
    );
    expect(queries.at(-1)).toBe("COMMIT");
  });

  it("rejects partial or malformed pre-bootstrap authority state without mutation", async () => {
    for (const scenario of ["partial", "malformed"] as const) {
      const queries: string[] = [];
      const client = {
        async query(sql: string) {
          queries.push(sql);
          if (sql.includes("restore_ledger_installer_identity")) {
            return {
              rows: [{
                current_user: "codestead_restore",
                session_user: "codestead_restore",
                database_name: "learncoding_restore",
                superuser: true,
              }],
            };
          }
          if (sql.includes("restore_ledger_existing_authority")) {
            return scenario === "partial"
              ? { rows: [{ object_kind: "role" }] }
              : {
                  rows: [
                    { object_kind: "role" },
                    { object_kind: "schema" },
                    { object_kind: "routine" },
                  ],
                };
          }
          if (sql.includes("restore_ledger_installer_secret")) {
            return {
              rows: [{ role_present: true, password_absent: true }],
            };
          }
          if (sql.includes("restore_ledger_authority_catalog")) {
            return {
              rows: [{
                ...authorityCatalog,
                definer_default_acl_exact: false,
              }],
            };
          }
          return { rows: [] };
        },
      };

      await expect(removeRestoreLedgerAuthorityBeforeBootstrap(client, {
        expectedBootstrapUser: "codestead_restore",
        expectedDatabase: "learncoding_restore",
      })).rejects.toThrow("authority");
      expect(queries.at(-1)).toBe("ROLLBACK");
      expect(queries.join("\n")).not.toContain("DROP FUNCTION");
      expect(queries.join("\n")).not.toContain("DROP SCHEMA");
      expect(queries.join("\n")).not.toContain("DROP ROLE");
    }
  });

  it("fails closed on an unreviewed role dependency and rolls every removal back", async () => {
    const dependencyFailure = new Error("role cannot be dropped because objects depend on it");
    const queries: string[] = [];
    let inventoryCalls = 0;
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("restore_ledger_installer_identity")) {
          return {
            rows: [{
              current_user: "codestead_restore",
              session_user: "codestead_restore",
              database_name: "learncoding_restore",
              superuser: true,
            }],
          };
        }
        if (sql.includes("restore_ledger_existing_authority")) {
          inventoryCalls += 1;
          return {
            rows: [
              { object_kind: "role" },
              { object_kind: "schema" },
              { object_kind: "routine" },
            ],
          };
        }
        if (sql.includes("restore_ledger_installer_secret")) {
          return {
            rows: [{ role_present: true, password_absent: true }],
          };
        }
        if (sql.includes("restore_ledger_authority_catalog")) {
          return { rows: [authorityCatalog] };
        }
        if (sql.includes("DROP ROLE")) throw dependencyFailure;
        return { rows: [] };
      },
    };

    await expect(removeRestoreLedgerAuthorityBeforeBootstrap(client, {
      expectedBootstrapUser: "codestead_restore",
      expectedDatabase: "learncoding_restore",
    })).rejects.toBe(dependencyFailure);
    expect(inventoryCalls).toBe(1);
    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
  });

  it("converges after a removal COMMIT acknowledgement is lost", async () => {
    let authorityPresent = true;
    let loseFirstCommitAck = true;
    const client = {
      async query(sql: string) {
        if (sql.includes("restore_ledger_installer_identity")) {
          return {
            rows: [{
              current_user: "codestead_restore",
              session_user: "codestead_restore",
              database_name: "learncoding_restore",
              superuser: true,
            }],
          };
        }
        if (sql.includes("restore_ledger_existing_authority")) {
          return authorityPresent
            ? {
                rows: [
                  { object_kind: "role" },
                  { object_kind: "schema" },
                  { object_kind: "routine" },
                ],
              }
            : { rows: [] };
        }
        if (sql.includes("restore_ledger_installer_secret")) {
          return {
            rows: [{ role_present: true, password_absent: true }],
          };
        }
        if (sql.includes("restore_ledger_authority_catalog")) {
          return { rows: [authorityCatalog] };
        }
        if (sql.includes("DROP ROLE")) {
          authorityPresent = false;
          return { rows: [] };
        }
        if (sql === "COMMIT" && loseFirstCommitAck) {
          loseFirstCommitAck = false;
          throw new Error("commit acknowledgement lost");
        }
        return { rows: [] };
      },
    };

    await expect(removeRestoreLedgerAuthorityBeforeBootstrap(client, {
      expectedBootstrapUser: "codestead_restore",
      expectedDatabase: "learncoding_restore",
    })).rejects.toThrow("commit acknowledgement lost");
    await expect(removeRestoreLedgerAuthorityBeforeBootstrap(client, {
      expectedBootstrapUser: "codestead_restore",
      expectedDatabase: "learncoding_restore",
    })).resolves.toEqual({ removed: false });
  });
});
