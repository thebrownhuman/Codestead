import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import {
  MAIL_WORKER_OUTBOX_INSERT_COLUMNS,
  MAIL_WORKER_OUTBOX_UPDATE_COLUMNS,
  mailWorkerOutboxPrivilegesSql,
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
      if (normalized.includes("from pg_class c") && normalized.includes("c.relkind = 'r'")) {
        return { rows: [{ schema_name: "public", object_name: "sample", column_name: "id" }] };
      }
      if (normalized.includes("from pg_class c") && normalized.includes("c.relkind = 's'")) {
        return { rows: [{ schema_name: "public", object_name: "sample_id_seq" }] };
      }
      if (normalized.includes("from pg_type t")) {
        return { rows: [{ schema_name: "public", object_name: "sample_status" }] };
      }
      const forbidden =
        normalized.startsWith("create role ") ||
        normalized.startsWith("create table ") ||
        normalized.startsWith("grant learncoding_owner ") ||
        normalized.startsWith("alter table ") ||
        normalized.startsWith("grant select on table ") ||
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

test("CLI failure output never includes credential material", () => {
  const script = path.join(import.meta.dirname, "verify-database-role-boundaries.mjs");
  const canary = "BOUNDARY_SECRET_CANARY_123456789012345678901234567890";
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
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
