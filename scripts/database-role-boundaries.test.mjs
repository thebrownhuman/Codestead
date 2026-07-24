import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import {
  MAIL_WORKER_OUTBOX_INSERT_COLUMNS,
  MAIL_WORKER_OUTBOX_UPDATE_COLUMNS,
  mailWorkerOutboxPrivilegesSql,
  reviewedApplicationFunctionPrivilegesSql,
} from "./bootstrap-database-roles.mjs";
import {
  DatabaseRoleBoundaryError,
  verifyDatabaseRoleBoundaries,
  validateDatabaseRoleBoundaryUrls,
} from "./verify-database-role-boundaries.mjs";

const password = (character) => character.repeat(48);
const validInput = () => ({
  postgresDatabase: "learncoding",
  databaseAppUrl: `postgresql://learncoding_app:${password("a")}@postgres:5432/learncoding`,
  databaseMigratorUrl: `postgresql://learncoding_migrator:${password("m")}@postgres:5432/learncoding`,
  databaseWorkerUrl: `postgresql://learncoding_worker:${password("w")}@postgres:5432/learncoding`,
  databaseOpsUrl: `postgresql://learncoding_ops:${password("o")}@postgres:5432/learncoding`,
});

const PLATFORM_ENVIRONMENT_KEYS = Object.freeze([
  "CI",
  "LANG",
  "LC_ALL",
  "TZ",
  "NO_COLOR",
  "FORCE_COLOR",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
]);

function minimalPlatformEnvironment(environment) {
  const result = {};
  for (const canonicalName of PLATFORM_ENVIRONMENT_KEYS) {
    const matchedName = Object.keys(environment).find(
      (name) => name.toUpperCase() === canonicalName,
    );
    if (matchedName !== undefined && environment[matchedName] !== undefined) {
      result[canonicalName] = environment[matchedName];
    }
  }
  return result;
}

test("composes the mail worker outbox role without payload mutation authority", () => {
  assert.deepEqual(MAIL_WORKER_OUTBOX_INSERT_COLUMNS, [
    "operation_id",
    "user_id",
    "delivery_scope_key",
    "to_email",
    "template",
    "template_version",
    "variables",
    "idempotency_key",
    "status",
    "next_attempt_at",
  ]);
  assert.deepEqual(MAIL_WORKER_OUTBOX_UPDATE_COLUMNS, [
    "status",
    "attempt_count",
    "claim_token",
    "claim_owner",
    "claim_version",
    "lease_expires_at",
    "provider_call_started",
    "adapter",
    "provider_message_id",
    "next_attempt_at",
    "sent_at",
    "quarantined_at",
    "last_error_code",
    "updated_at",
  ]);

  const payloadColumns = new Set([
    "id",
    "operation_id",
    "user_id",
    "delivery_scope_key",
    "to_email",
    "template",
    "template_version",
    "variables",
    "idempotency_key",
    "created_at",
  ]);
  assert.deepEqual(
    MAIL_WORKER_OUTBOX_UPDATE_COLUMNS.filter((column) => payloadColumns.has(column)),
    [],
  );

  const sql = mailWorkerOutboxPrivilegesSql();
  assert.match(sql, /revoke all on table public\.email_outbox from learncoding_worker/iu);
  assert.match(sql, /revoke all \([^)]+\) on table public\.email_outbox from learncoding_worker/iu);
  assert.match(sql, /grant select on table public\.email_outbox to learncoding_worker/iu);
  assert.match(sql, /grant insert \([^)]+\) on table public\.email_outbox to learncoding_worker/iu);
  assert.match(sql, /grant update \([^)]+\) on table public\.email_outbox to learncoding_worker/iu);
  assert.doesNotMatch(sql, /grant delete|grant truncate/iu);
});

test("guards reviewed application grants on both role and object existence", () => {
  const workerSql = mailWorkerOutboxPrivilegesSql();
  assert.match(
    workerSql,
    /pg_catalog\.to_regrole\('learncoding_worker'\)\s+is\s+not\s+null/iu,
  );
  assert.match(
    workerSql,
    /pg_catalog\.to_regclass\('public\.email_outbox'\)\s+is\s+not\s+null/iu,
  );

  const routineSql = reviewedApplicationFunctionPrivilegesSql();
  assert.match(
    routineSql,
    /pg_catalog\.to_regrole\('learncoding_ops'\)\s+is\s+not\s+null/iu,
  );
  assert.match(
    routineSql,
    /pg_catalog\.to_regprocedure\('public\.redact_unresolved_email_outbox_authority\(timestamp with time zone,integer\)'\)\s+is\s+not\s+null/iu,
  );
});

test("replays post-migration privilege reconciliation idempotently", async () => {
  const databaseRoleBootstrap = await import("./bootstrap-database-roles.mjs");
  assert.equal(
    typeof databaseRoleBootstrap.reconcileDatabaseRolePrivileges,
    "function",
  );

  const passes = [];
  let currentPass = [];
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/gu, " ").trim().toLowerCase();
      currentPass.push(normalized);
      if (
        normalized.includes(
          "select to_regclass('public.email_outbox') is not null present",
        )
      ) {
        return { rows: [{ present: true }] };
      }
      if (normalized.includes("from pg_namespace")) {
        return { rows: [{ present: false }] };
      }
      return { rows: [] };
    },
  };

  for (let pass = 0; pass < 2; pass += 1) {
    await databaseRoleBootstrap.reconcileDatabaseRolePrivileges(client);
    passes.push(currentPass);
    currentPass = [];
  }

  assert.deepEqual(passes[1], passes[0]);
  assert.equal(
    passes[0].some((sql) => sql.includes("do $codestead_mail_worker_outbox$")),
    true,
  );
});

test("accepts only the exact four distinct restricted-role URLs", () => {
  const parsed = validateDatabaseRoleBoundaryUrls(validInput());
  assert.deepEqual(Object.keys(parsed), ["app", "migrator", "worker", "ops"]);
  assert.equal(parsed.app.username, "learncoding_app");

  for (const mutate of [
    (input) => { input.databaseAppUrl = input.databaseAppUrl.replace("@postgres", "@elsewhere"); },
    (input) => { input.databaseAppUrl = input.databaseAppUrl.replace("learncoding_app", "learncoding_ops"); },
    (input) => { input.databaseAppUrl += "?sslmode=disable"; },
    (input) => { input.databaseAppUrl = input.databaseAppUrl.replace(password("a"), "short"); },
    (input) => { input.databaseOpsUrl = input.databaseWorkerUrl.replace("learncoding_worker", "learncoding_ops"); },
  ]) {
    const candidate = validInput();
    mutate(candidate);
    assert.throws(() => validateDatabaseRoleBoundaryUrls(candidate), DatabaseRoleBoundaryError);
  }
});

function makeClient(role, database, options) {
  const queries = [];
  let delegated = false;
  let grantCatalogVersion = 0;
  return {
    queries,
    release() {},
    async query(sql) {
      const normalized = String(sql).replace(/\s+/gu, " ").trim().toLowerCase();
      queries.push(normalized);
      if (normalized.startsWith("select pg_try_advisory_lock")) {
        return { rows: [{ acquired: options.lockAvailable !== false }] };
      }
      if (normalized.startsWith("select pg_advisory_unlock")) return { rows: [{ released: true }] };
      if (normalized === "select current_user, session_user, current_database()") {
        return { rows: [{ current_user: role, session_user: role, current_database: database }] };
      }
      if (normalized === "select current_user, session_user" && role === "learncoding_migrator") {
        return { rows: [{ current_user: "learncoding_owner", session_user: role }] };
      }
      if (normalized.includes("from pg_roles") && normalized.includes("rolname = current_user")) {
        return { rows: [{
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolcanlogin: true,
          rolreplication: false,
          rolbypassrls: false,
        }] };
      }
      if (normalized.startsWith("select has_database_privilege")) {
        return { rows: [{
          connect_allowed: true,
          temp_allowed: false,
          create_allowed: false,
          schema_usage: role !== "learncoding_migrator",
          schema_create: false,
        }] };
      }
      if (
        normalized.includes("pg_catalog.aclexplode") &&
        normalized.includes("current_role_direct_grantable")
      ) {
        return { rows: [{
          delegated,
          current_role_effective_grantable:
            options.currentRoleEffectiveGrantable === true,
          current_role_direct_grantable:
            options.currentRoleDirectGrantable === true,
          table_acl: `catalog-version-${grantCatalogVersion}`,
        }] };
      }
      if (normalized.startsWith("select has_table_privilege")) {
        if (
          role === "learncoding_migrator" &&
          options.migratorCannotResolveRelationName === true &&
          !normalized.includes("$2::oid")
        ) throw Object.assign(new Error("redacted relation lookup rejection"), { code: "42501" });
        return { rows: [{ delegated }] };
      }
      if (normalized.includes("from pg_class c") && normalized.includes("c.relkind = 'r'")) {
        return { rows: [{
          schema_name: "public",
          object_name: "sample",
          object_oid: 16_384,
          column_name: "id",
        }] };
      }
      if (normalized.includes("from pg_class c") && normalized.includes("c.relkind = 's'")) {
        return { rows: [{ schema_name: "public", object_name: "sample_id_seq" }] };
      }
      if (normalized.includes("from pg_type t")) {
        return { rows: [{ schema_name: "public", object_name: "sample_status" }] };
      }
      if (
        normalized.startsWith("grant select on table ") &&
        options.grantProbeErrorCode
      ) {
        throw Object.assign(new Error("redacted grant probe failure"), {
          code: options.grantProbeErrorCode,
        });
      }
      if (normalized.startsWith("grant select on table ")) {
        if (options.grantActuallyDelegates === true) {
          delegated = true;
          grantCatalogVersion += 1;
        }
        if (options.grantChangesCatalogWithoutDelegating === true) {
          grantCatalogVersion += 1;
        }
        return { rows: [] };
      }
      const forbidden =
        normalized.startsWith("create role ") ||
        normalized.startsWith("create table ") ||
        normalized.startsWith("grant learncoding_owner ") ||
        normalized.startsWith("alter table ") ||
        (normalized === "set role learncoding_owner" && role !== "learncoding_migrator");
      if (forbidden && options.allowForbidden !== true) {
        const error = new Error("redacted database rejection");
        error.code = "42501";
        throw error;
      }
      return { rows: [] };
    },
  };
}

function makePoolHarness(options = {}) {
  const clients = new Map();
  const pools = [];
  return {
    clients,
    pools,
    factory({ role, database }) {
      const client = makeClient(role, database, options);
      clients.set(role, client);
      const pool = {
        ended: false,
        async connect() {
          if (options.connectFailureRole === role) throw new Error("redacted connection failure");
          return client;
        },
        async end() { this.ended = true; },
      };
      pools.push(pool);
      return pool;
    },
  };
}

test("authenticates every restricted role under the shared administration lock", async () => {
  const harness = makePoolHarness();
  const result = await verifyDatabaseRoleBoundaries({
    ...validInput(),
    poolFactory: harness.factory,
    lockTimeoutMs: 50,
  });

  assert.deepEqual(result, {
    rolesAuthenticated: 4,
    positiveChecks: 13,
    negativeChecks: 15,
  });
  assert.equal(harness.pools.every((pool) => pool.ended), true);
  assert.equal(
    harness.clients.get("learncoding_migrator").queries.includes("set local role learncoding_owner"),
    true,
  );
  for (const role of ["learncoding_app", "learncoding_worker", "learncoding_ops"]) {
    assert.equal(harness.clients.get(role).queries.includes("set role learncoding_owner"), true);
  }
});

test("proves application-object access without mutating application rows", async () => {
  const harness = makePoolHarness();
  const result = await verifyDatabaseRoleBoundaries({
    ...validInput(),
    poolFactory: harness.factory,
    lockTimeoutMs: 50,
    requireApplicationObjects: true,
  });

  assert.deepEqual(result, {
    rolesAuthenticated: 4,
    positiveChecks: 31,
    negativeChecks: 23,
  });
  for (const role of ["learncoding_app", "learncoding_worker", "learncoding_ops"]) {
    const queries = harness.clients.get(role).queries;
    assert.equal(queries.some((sql) => sql.startsWith("explain (format json) insert")), true);
    assert.equal(queries.some((sql) => sql.startsWith("explain (format json) update")), true);
    assert.equal(queries.some((sql) => sql.startsWith("explain (format json) delete")), true);
  }
});

test("grounds PostgreSQL's successful no-op GRANT in unchanged effective and catalog state", async () => {
  const harness = makePoolHarness({
    migratorCannotResolveRelationName: true,
  });

  const result = await verifyDatabaseRoleBoundaries({
    ...validInput(),
    poolFactory: harness.factory,
    lockTimeoutMs: 50,
    requireApplicationObjects: true,
  });

  assert.deepEqual(result, {
    rolesAuthenticated: 4,
    positiveChecks: 31,
    negativeChecks: 23,
  });
  for (const role of [
    "learncoding_app",
    "learncoding_migrator",
    "learncoding_worker",
    "learncoding_ops",
  ]) {
    const queries = harness.clients.get(role).queries;
    assert.equal(
      queries.filter((sql) =>
        sql.includes("aclexplode") &&
        sql.includes("current_role_direct_grantable")
      ).length,
      2,
    );
    assert.equal(
      queries.filter((sql) => sql.startsWith("grant select on table ")).length,
      1,
    );
  }

  const delegated = makePoolHarness({
    grantActuallyDelegates: true,
  });
  await assert.rejects(
    verifyDatabaseRoleBoundaries({
      ...validInput(),
      poolFactory: delegated.factory,
      lockTimeoutMs: 50,
      requireApplicationObjects: true,
    }),
    DatabaseRoleBoundaryError,
  );
  assert.equal(delegated.pools.every((pool) => pool.ended), true);

  const catalogChanged = makePoolHarness({
    grantChangesCatalogWithoutDelegating: true,
  });
  await assert.rejects(
    verifyDatabaseRoleBoundaries({
      ...validInput(),
      poolFactory: catalogChanged.factory,
      lockTimeoutMs: 50,
      requireApplicationObjects: true,
    }),
    DatabaseRoleBoundaryError,
  );
  assert.equal(catalogChanged.pools.every((pool) => pool.ended), true);
});

test("rejects current-role grantability even when the target stays undelegated", async () => {
  for (const grantability of [
    { currentRoleDirectGrantable: true },
    { currentRoleEffectiveGrantable: true },
  ]) {
    const harness = makePoolHarness({
      ...grantability,
    });
    await assert.rejects(
      verifyDatabaseRoleBoundaries({
        ...validInput(),
        poolFactory: harness.factory,
        lockTimeoutMs: 50,
        requireApplicationObjects: true,
      }),
      DatabaseRoleBoundaryError,
    );
    assert.equal(harness.pools.every((pool) => pool.ended), true);
  }
});

test("rechecks catalog state after a savepointed GRANT error without trusting its code", async () => {
  for (const grantProbeErrorCode of ["42501", "XX000"]) {
    const harness = makePoolHarness({ grantProbeErrorCode });
    const result = await verifyDatabaseRoleBoundaries({
      ...validInput(),
      poolFactory: harness.factory,
      lockTimeoutMs: 50,
      requireApplicationObjects: true,
    });

    assert.deepEqual(result, {
      rolesAuthenticated: 4,
      positiveChecks: 31,
      negativeChecks: 23,
    });
    for (const role of [
      "learncoding_app",
      "learncoding_migrator",
      "learncoding_worker",
      "learncoding_ops",
    ]) {
      const queries = harness.clients.get(role).queries;
      const grantIndex = queries.findIndex((sql) =>
        sql.startsWith("grant select on table ")
      );
      const rollbackIndex = queries.indexOf(
        "rollback to savepoint codestead_table_grant_probe",
      );
      const catalogIndexes = queries.flatMap((sql, index) =>
        sql.includes("current_role_direct_grantable") ? [index] : []
      );
      assert.equal(catalogIndexes.length, 2);
      assert.equal(grantIndex < rollbackIndex, true);
      assert.equal(rollbackIndex < catalogIndexes[1], true);
    }
  }
});

test("fails closed when a forbidden statement succeeds or the lock remains held", async () => {
  const permissive = makePoolHarness({ allowForbidden: true });
  await assert.rejects(
    verifyDatabaseRoleBoundaries({ ...validInput(), poolFactory: permissive.factory }),
    DatabaseRoleBoundaryError,
  );
  assert.equal(permissive.pools.every((pool) => pool.ended), true);

  const locked = makePoolHarness({ lockAvailable: false });
  await assert.rejects(
    verifyDatabaseRoleBoundaries({
      ...validInput(),
      poolFactory: locked.factory,
      lockTimeoutMs: 1,
    }),
    DatabaseRoleBoundaryError,
  );
  assert.equal(locked.pools.every((pool) => pool.ended), true);
  const connectionFailure = makePoolHarness({ connectFailureRole: "learncoding_worker" });
  await assert.rejects(
    verifyDatabaseRoleBoundaries({ ...validInput(), poolFactory: connectionFailure.factory }),
    DatabaseRoleBoundaryError,
  );
  assert.equal(connectionFailure.pools.every((pool) => pool.ended), true);

});

test("the verifier child receives no ambient credentials or alternate database settings", () => {
  const canaries = {
    ARBITRARY_TOKEN: "ambient-token-canary",
    APPLICATION_SECRET: "ambient-secret-canary",
    SIGNING_KEY: "ambient-key-canary",
    SERVICE_CREDENTIAL: "ambient-credential-canary",
    AWS_SECRET_ACCESS_KEY: "ambient-cloud-canary",
    HTTPS_PROXY: "https://ambient-proxy.invalid",
    DATABASE_ANALYTICS_URL: "postgresql://alternate-database.invalid/analytics",
    DATABASE_URL_FILE: "C:\\ambient\\alternate-database-url",
    PGHOST: "ambient-postgres-host.invalid",
  };
  const result = spawnSync(process.execPath, [
    "-e",
    "process.stdout.write(JSON.stringify(process.env))",
  ], {
    encoding: "utf8",
    env: minimalPlatformEnvironment(Object.assign({}, process.env, canaries)),
  });

  assert.equal(result.status, 0);
  const childEnvironment = JSON.parse(result.stdout);
  for (const [name, value] of Object.entries(canaries)) {
    assert.equal(childEnvironment[name], undefined);
    assert.doesNotMatch(result.stdout, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
});

test("CLI failure output never includes credential material", () => {
  const script = path.join(import.meta.dirname, "verify-database-role-boundaries.mjs");
  const canary = "BOUNDARY_SECRET_CANARY_123456789012345678901234567890";
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...minimalPlatformEnvironment(process.env),
      POSTGRES_DB: "learncoding",
      DATABASE_URL: `postgresql://learncoding_app:${canary}@wrong-host:5432/learncoding`,
      DATABASE_MIGRATOR_URL: validInput().databaseMigratorUrl,
      DATABASE_WORKER_URL: validInput().databaseWorkerUrl,
      DATABASE_OPS_URL: validInput().databaseOpsUrl,
    },
  });
  assert.equal(result.status, 1);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(canary, "u"));
  assert.match(result.stderr, /"event":"database\.role_boundary_verification_failed"/u);
});

test("bootstrap CLI failure output uses a fixed code without credential material", () => {
  const script = path.join(import.meta.dirname, "bootstrap-database-roles.mjs");
  const canary = "BOOTSTRAP_SECRET_CANARY_123456789012345678901234567890";
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...minimalPlatformEnvironment(process.env),
      POSTGRES_USER: "legacy_bootstrap",
      POSTGRES_DB: "learncoding",
      DATABASE_BOOTSTRAP_URL: `postgresql://legacy_bootstrap:${canary}@wrong-host:5432/learncoding`,
      DATABASE_APP_URL: validInput().databaseAppUrl,
      DATABASE_MIGRATOR_URL: validInput().databaseMigratorUrl,
      DATABASE_WORKER_URL: validInput().databaseWorkerUrl,
      DATABASE_OPS_URL: validInput().databaseOpsUrl,
    },
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.doesNotMatch(output, new RegExp(canary, "u"));
  assert.deepEqual(
    JSON.parse(result.stderr.trim()),
    {
      event: "database.role_bootstrap_failed",
      code: "DATABASE_ROLE_BOOTSTRAP_FAILED",
    },
  );
});
