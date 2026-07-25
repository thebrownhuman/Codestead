import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import {
  MAIL_WORKER_OUTBOX_INSERT_COLUMNS,
  MAIL_WORKER_OUTBOX_UPDATE_COLUMNS,
  REVIEWED_APPLICATION_CONSTRAINTS,
  REVIEWED_APPLICATION_FUNCTIONS,
  REVIEWED_APPLICATION_TRIGGERS,
  REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES,
  mailWorkerOutboxPrivilegesSql,
  reconcileDatabaseRolePrivileges,
  reviewedApplicationFunctionPrivilegesSql,
  verifyPostMigrationReviewedContractsBeforeReconciliation,
} from "./bootstrap-database-roles.mjs";
import {
  DatabaseRoleBoundaryError,
  verifyDatabaseRoleBoundaries,
  verifyMailWorkerOutboxContract,
  verifyReviewedMailAuthorityCatalogContracts,
  verifyReviewedApplicationRoutines,
  verifyReviewedApplicationTriggers,
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
    "dispatch_binding_version",
    "dispatch_binding_sha256",
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
    MAIL_WORKER_OUTBOX_UPDATE_COLUMNS.filter((column) =>
      payloadColumns.has(column),
    ),
    [],
  );

  const sql = mailWorkerOutboxPrivilegesSql();
  assert.match(
    sql,
    /revoke all on table public\.email_outbox from learncoding_worker/iu,
  );
  assert.match(
    sql,
    /revoke all \([^)]+\) on table public\.email_outbox from learncoding_worker/iu,
  );
  assert.match(
    sql,
    /grant select on table public\.email_outbox to learncoding_worker/iu,
  );
  assert.match(
    sql,
    /grant insert \([^)]+\) on table public\.email_outbox to learncoding_worker/iu,
  );
  assert.match(
    sql,
    /grant update \([^)]+\) on table public\.email_outbox to learncoding_worker/iu,
  );
  assert.doesNotMatch(sql, /grant delete|grant truncate/iu);
  assert.match(sql, /pg_catalog\.pg_attribute/iu);
  assert.match(sql, /dispatch_binding_version/iu);
  assert.match(sql, /dispatch_binding_sha256/iu);
  assert.match(sql, /binding_column_count/iu);
  assert.match(sql, /binding_column_exact_count/iu);
  assert.match(sql, /raise exception/iu);
  assert.doesNotMatch(sql, /grant insert \([^)]*dispatch_binding_/iu);
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
      if (normalized.includes("reviewed_migration_journal_present")) {
        return {
          rows: [
            {
              reviewed_migration_journal_present: false,
            },
          ],
        };
      }
      if (normalized.includes("post_migration_binding_column_count")) {
        return {
          rows: [
            {
              post_migration_binding_column_count: 0,
              post_migration_binding_column_exact_count: 0,
            },
          ],
        };
      }
      if (normalized.includes("reviewed_routine_presence_exact")) {
        return {
          rows: [
            {
              reviewed_routine_presence_exact: true,
              reviewed_trigger_presence_exact: true,
              reviewed_constraint_presence_exact: true,
            },
          ],
        };
      }
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
    (input) => {
      input.databaseAppUrl = input.databaseAppUrl.replace(
        "@postgres",
        "@elsewhere",
      );
    },
    (input) => {
      input.databaseAppUrl = input.databaseAppUrl.replace(
        "learncoding_app",
        "learncoding_ops",
      );
    },
    (input) => {
      input.databaseAppUrl += "?sslmode=disable";
    },
    (input) => {
      input.databaseAppUrl = input.databaseAppUrl.replace(
        password("a"),
        "short",
      );
    },
    (input) => {
      input.databaseOpsUrl = input.databaseWorkerUrl.replace(
        "learncoding_worker",
        "learncoding_ops",
      );
    },
  ]) {
    const candidate = validInput();
    mutate(candidate);
    assert.throws(
      () => validateDatabaseRoleBoundaryUrls(candidate),
      DatabaseRoleBoundaryError,
    );
  }
});

function makeClient(role, database, options) {
  const queries = [];
  const queryParameters = [];
  let delegated = false;
  let grantCatalogVersion = 0;
  return {
    queries,
    queryParameters,
    release() {},
    async query(sql, parameters) {
      const normalized = String(sql).replace(/\s+/gu, " ").trim().toLowerCase();
      queries.push(normalized);
      queryParameters.push(parameters);
      if (normalized.startsWith("select pg_try_advisory_lock")) {
        return { rows: [{ acquired: options.lockAvailable !== false }] };
      }
      if (normalized.startsWith("select pg_advisory_unlock"))
        return { rows: [{ released: true }] };
      if (
        normalized === "select current_user, session_user, current_database()"
      ) {
        return {
          rows: [
            {
              current_user: role,
              session_user: role,
              current_database: database,
            },
          ],
        };
      }
      if (
        normalized === "select current_user, session_user" &&
        role === "learncoding_migrator"
      ) {
        return {
          rows: [{ current_user: "learncoding_owner", session_user: role }],
        };
      }
      if (
        normalized.includes("from pg_roles") &&
        normalized.includes("rolname = current_user")
      ) {
        return {
          rows: [
            {
              rolsuper: false,
              rolcreatedb: false,
              rolcreaterole: false,
              rolcanlogin: true,
              rolreplication: false,
              rolbypassrls: false,
            },
          ],
        };
      }
      if (normalized.startsWith("select has_database_privilege")) {
        return {
          rows: [
            {
              connect_allowed: true,
              temp_allowed: false,
              create_allowed: false,
              schema_usage: role !== "learncoding_migrator",
              schema_create: false,
            },
          ],
        };
      }
      if (normalized.includes("reviewed_migration_journal_present")) {
        return {
          rows: [
            {
              reviewed_migration_journal_present:
                options.journalPresent !== false,
            },
          ],
        };
      }
      if (
        normalized.includes("reviewed(migration_index, created_at)") &&
        normalized.includes("applied_hashes")
      ) {
        const latestApplied =
          options.appliedMigrationIndex === undefined
            ? 64
            : options.appliedMigrationIndex;
        return {
          rows: REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.map((phase) => {
            const applied =
              latestApplied !== null &&
              phase.index <= latestApplied &&
              phase.index !== options.missingMigrationIndex;
            const hash =
              phase.index === options.journalHashTamper
                ? "0".repeat(64)
                : phase.migrationSha256;
            return {
              migration_index: phase.index,
              created_at: phase.createdAt,
              applied_count: applied ? 1 : 0,
              applied_hashes: applied ? [hash] : [],
            };
          }),
        };
      }
      if (normalized.includes("post_migration_binding_column_count")) {
        return {
          rows: [
            {
              post_migration_binding_column_count:
                options.bindingColumnCount ?? 2,
              post_migration_binding_column_exact_count:
                options.bindingColumnExactCount ?? 2,
            },
          ],
        };
      }
      if (normalized.includes("reviewed_routine_presence_exact")) {
        const tamper = options.footprintContractTamper;
        return {
          rows: [
            {
              reviewed_routine_presence_exact: tamper !== "routine",
              reviewed_trigger_presence_exact: tamper !== "trigger",
              reviewed_constraint_presence_exact: tamper !== "constraint",
            },
          ],
        };
      }
      if (normalized.includes("routine_direct_acl_exact")) {
        if (options.requiredRoutineMissing === true) return { rows: [] };
        const tamper = options.routineContractTamper;
        return {
          rows: [
            {
              body_sha256_exact: tamper !== "body",
              owner_exact: tamper !== "owner",
              security_definer_exact: tamper !== "security-definer",
              configuration_exact: tamper !== "configuration",
              language_exact: tamper !== "language",
              kind_exact: tamper !== "kind",
              volatility_exact: tamper !== "volatility",
              strict_exact: tamper !== "strict",
              parallel_exact: tamper !== "parallel",
              leakproof_exact: tamper !== "leakproof",
              argument_names_exact: tamper !== "argument-names",
              argument_modes_exact: tamper !== "argument-modes",
              argument_types_exact: tamper !== "argument-types",
              input_argument_count_exact: tamper !== "input-argument-count",
              argument_defaults_exact: tamper !== "argument-defaults",
              return_type_exact: tamper !== "return-type",
              returns_set_exact: tamper !== "returns-set",
              variadic_exact: tamper !== "variadic",
              cost_exact: tamper !== "cost",
              rows_exact: tamper !== "rows",
              support_exact: tamper !== "support",
              transform_types_exact: tamper !== "transform-types",
              binary_exact: tamper !== "binary",
              sql_body_exact: tamper !== "sql-body",
              definition_sha256_exact: tamper !== "definition",
              owner_execute_exact: tamper !== "owner-execute",
              effective_execute_exact: tamper !== "effective-acl",
              routine_direct_acl_exact: ![
                "direct-acl",
                "missing-acl",
                "extra-acl",
                "grantable-acl",
              ].includes(tamper),
            },
          ],
        };
      }
      if (normalized.includes("reviewed_trigger_catalog_exact")) {
        if (options.requiredTriggerMissing === true) return { rows: [] };
        const tamper = options.triggerContractTamper;
        return {
          rows: [
            {
              relation_exact: tamper !== "relation",
              function_exact: tamper !== "function",
              enabled_exact: tamper !== "enabled",
              type_exact: tamper !== "type",
              predicate_exact: tamper !== "predicate",
              arguments_exact: tamper !== "arguments",
              watched_columns_exact: tamper !== "watched-columns",
              reviewed_trigger_catalog_exact: tamper !== "catalog",
            },
          ],
        };
      }
      if (normalized.includes("worker_column_direct_acl_exact")) {
        const tamper = options.workerContractTamper;
        return {
          rows: [
            {
              outbox_present_exact: tamper !== "table",
              outbox_owner_exact: tamper !== "owner",
              binding_columns_exact: tamper !== "binding-columns",
              dispatch_constraint_exact: ![
                "constraint",
                "constraint-always-true",
                "constraint-state-arm-removed",
                "constraint-unknown-version",
              ].includes(tamper),
              worker_table_direct_acl_exact: tamper !== "table-acl",
              worker_column_direct_acl_exact: ![
                "column-acl",
                "one-column-grant",
              ].includes(tamper),
              worker_effective_privileges_exact: tamper !== "effective-acl",
            },
          ],
        };
      }
      if (
        normalized.includes("pg_catalog.aclexplode") &&
        normalized.includes("current_role_direct_grantable")
      ) {
        return {
          rows: [
            {
              delegated,
              current_role_effective_grantable:
                options.currentRoleEffectiveGrantable === true,
              current_role_direct_grantable:
                options.currentRoleDirectGrantable === true,
              table_acl: `catalog-version-${grantCatalogVersion}`,
            },
          ],
        };
      }
      if (normalized.startsWith("select has_table_privilege")) {
        if (
          role === "learncoding_migrator" &&
          options.migratorCannotResolveRelationName === true &&
          !normalized.includes("$2::oid")
        )
          throw Object.assign(new Error("redacted relation lookup rejection"), {
            code: "42501",
          });
        return { rows: [{ delegated }] };
      }
      if (
        normalized.includes("from pg_class c") &&
        normalized.includes("c.relkind = 'r'")
      ) {
        return {
          rows: [
            {
              schema_name: "public",
              object_name: "sample",
              object_oid: 16_384,
              column_name: "id",
            },
          ],
        };
      }
      if (
        normalized.includes("from pg_class c") &&
        normalized.includes("c.relkind = 's'")
      ) {
        return {
          rows: [{ schema_name: "public", object_name: "sample_id_seq" }],
        };
      }
      if (normalized.includes("from pg_type t")) {
        return {
          rows: [{ schema_name: "public", object_name: "sample_status" }],
        };
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
        (normalized === "set role learncoding_owner" &&
          role !== "learncoding_migrator");
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
          if (options.connectFailureRole === role)
            throw new Error("redacted connection failure");
          return client;
        },
        async end() {
          this.ended = true;
        },
      };
      pools.push(pool);
      return pool;
    },
  };
}

test("rejects reviewed post-migration tamper before privilege repair", async () => {
  const preMigration = makeClient("learncoding_ops", "learncoding", {
    journalPresent: false,
    bindingColumnCount: 0,
    bindingColumnExactCount: 0,
  });
  assert.equal(
    await verifyPostMigrationReviewedContractsBeforeReconciliation(
      preMigration,
    ),
    0,
  );

  const exact = makeClient("learncoding_ops", "learncoding", {});
  assert.equal(
    await verifyPostMigrationReviewedContractsBeforeReconciliation(exact),
    1,
  );

  for (const appliedMigrationIndex of [62, 63]) {
    const priorPhase = makeClient("learncoding_ops", "learncoding", {
      appliedMigrationIndex,
      bindingColumnCount: 0,
      bindingColumnExactCount: 0,
    });
    assert.equal(
      await verifyPostMigrationReviewedContractsBeforeReconciliation(
        priorPhase,
      ),
      1,
    );
    assert.equal(
      priorPhase.queries.some((query) =>
        query.includes("routine_direct_acl_exact"),
      ),
      true,
    );
    const workerQueryIndex = priorPhase.queries.findIndex((query) =>
      query.includes("worker_column_direct_acl_exact"),
    );
    assert.equal(workerQueryIndex >= 0, true);
    assert.equal(
      priorPhase.queryParameters[workerQueryIndex]?.[1].includes(
        "dispatch_binding_version",
      ),
      false,
    );
    assert.deepEqual(priorPhase.queryParameters[workerQueryIndex]?.slice(10), [
      0,
      false,
    ]);
  }

  for (const options of [
    { journalHashTamper: 62 },
    { missingMigrationIndex: 62 },
    { missingMigrationIndex: 63 },
    { appliedMigrationIndex: 63, bindingColumnCount: 2 },
    { appliedMigrationIndex: 64, bindingColumnCount: 0 },
    { journalPresent: false, bindingColumnCount: 2 },
    {
      journalPresent: false,
      bindingColumnCount: 0,
      bindingColumnExactCount: 0,
      footprintContractTamper: "routine",
    },
    {
      journalPresent: false,
      bindingColumnCount: 0,
      bindingColumnExactCount: 0,
      footprintContractTamper: "trigger",
    },
    {
      journalPresent: false,
      bindingColumnCount: 0,
      bindingColumnExactCount: 0,
      footprintContractTamper: "constraint",
    },
  ]) {
    await assert.rejects(
      verifyPostMigrationReviewedContractsBeforeReconciliation(
        makeClient("learncoding_ops", "learncoding", options),
      ),
    );
  }

  for (const options of [
    { bindingColumnCount: 1, bindingColumnExactCount: 1 },
    { bindingColumnCount: 2, bindingColumnExactCount: 1 },
    { footprintContractTamper: "routine" },
    { footprintContractTamper: "trigger" },
    { footprintContractTamper: "constraint" },
    { routineContractTamper: "owner" },
    { routineContractTamper: "missing-acl" },
    { routineContractTamper: "extra-acl" },
    { routineContractTamper: "grantable-acl" },
    { routineContractTamper: "argument-names" },
    { routineContractTamper: "return-type" },
    { triggerContractTamper: "enabled" },
    { triggerContractTamper: "function" },
    { workerContractTamper: "owner" },
    { workerContractTamper: "one-column-grant" },
  ]) {
    const tampered = makeClient("learncoding_ops", "learncoding", options);
    await assert.rejects(reconcileDatabaseRolePrivileges(tampered));
    assert.equal(
      tampered.queries[0]?.includes("reviewed_migration_journal_present"),
      true,
    );
    assert.equal(
      tampered.queries.some(
        (query) =>
          query.includes("revoke all on database") ||
          query.includes("revoke all on schema public"),
      ),
      false,
    );
  }
});

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
  assert.equal(
    harness.pools.every((pool) => pool.ended),
    true,
  );
  assert.equal(
    harness.clients
      .get("learncoding_migrator")
      .queries.includes("set local role learncoding_owner"),
    true,
  );
  for (const role of [
    "learncoding_app",
    "learncoding_worker",
    "learncoding_ops",
  ]) {
    assert.equal(
      harness.clients.get(role).queries.includes("set role learncoding_owner"),
      true,
    );
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
    positiveChecks: 38,
    negativeChecks: 23,
  });
  for (const role of [
    "learncoding_app",
    "learncoding_worker",
    "learncoding_ops",
  ]) {
    const queries = harness.clients.get(role).queries;
    assert.equal(
      queries.some((sql) => sql.startsWith("explain (format json) insert")),
      true,
    );
    assert.equal(
      queries.some((sql) => sql.startsWith("explain (format json) update")),
      true,
    );
    assert.equal(
      queries.some((sql) => sql.startsWith("explain (format json) delete")),
      true,
    );
  }
});

test("requires the exact reviewed 0062 through 0064 routine contracts in application-object mode", async () => {
  const verified = makePoolHarness();
  const result = await verifyDatabaseRoleBoundaries({
    ...validInput(),
    poolFactory: verified.factory,
    lockTimeoutMs: 50,
    requireApplicationObjects: true,
  });

  assert.deepEqual(result, {
    rolesAuthenticated: 4,
    positiveChecks: 38,
    negativeChecks: 23,
  });
  const routineQueries = verified.clients
    .get("learncoding_ops")
    .queries.filter((sql) => sql.includes("routine_direct_acl_exact"));
  assert.equal(routineQueries.length, REVIEWED_APPLICATION_FUNCTIONS.length);
  assert.match(routineQueries[0], /pg_catalog\.to_regprocedure/iu);
  assert.match(routineQueries[0], /p\.prosecdef/iu);
  assert.match(routineQueries[0], /p\.proconfig/iu);
  assert.match(routineQueries[0], /pg_catalog\.aclexplode/iu);
  assert.match(routineQueries[0], /has_function_privilege/iu);
  assert.match(routineQueries[0], /p\.proargnames/iu);
  assert.match(routineQueries[0], /p\.proargmodes/iu);
  assert.match(routineQueries[0], /p\.proallargtypes/iu);
  assert.match(routineQueries[0], /p\.pronargdefaults/iu);
  assert.match(routineQueries[0], /pg_catalog\.sha256/iu);
  assert.match(routineQueries[0], /pg_catalog\.pg_get_functiondef/iu);
  assert.match(routineQueries[0], /p\.procost/iu);
  assert.match(routineQueries[0], /p\.prorows/iu);
  assert.match(routineQueries[0], /p\.prosupport/iu);
  assert.match(routineQueries[0], /p\.protrftypes/iu);
  assert.match(routineQueries[0], /p\.prosqlbody/iu);
  assert.match(routineQueries[0], /p\.prorettype/iu);
  assert.doesNotMatch(routineQueries[0], /pg_catalog\.md5/iu);
  const routineQueryIndex = verified.clients
    .get("learncoding_ops")
    .queries.indexOf(routineQueries[0]);
  const restrictedRoles = [
    "learncoding_app",
    "learncoding_migrator",
    "learncoding_worker",
    "learncoding_ops",
  ];
  assert.deepEqual(
    verified.clients
      .get("learncoding_ops")
      .queries.map((query, index) => ({ index, query }))
      .filter(({ query }) => query.includes("routine_direct_acl_exact"))
      .map(
        ({ index }) =>
          verified.clients.get("learncoding_ops").queryParameters[index],
      ),
    REVIEWED_APPLICATION_FUNCTIONS.map((routine) => [
      routine.signature,
      routine.owner,
      routine.securityDefiner,
      routine.configuration,
      restrictedRoles,
      routine.allowedRoles,
      routine.bodySha256,
      routine.language,
      routine.kind,
      routine.volatility,
      routine.strict,
      routine.parallel,
      routine.leakproof,
      routine.argumentNames,
      routine.argumentModes,
      routine.argumentTypes,
      routine.inputArgumentCount,
      routine.argumentDefaultCount,
      routine.returnType,
      routine.returnsSet,
      routine.variadic,
      routine.cost,
      routine.rows,
      routine.supportFunction,
      routine.transformTypes,
      routine.binary,
      routine.sqlBody,
      routine.definitionSha256,
    ]),
  );
  assert.equal(routineQueryIndex >= 0, true);

  for (const options of [
    { requiredRoutineMissing: true },
    { routineContractTamper: "owner" },
    { routineContractTamper: "security-definer" },
    { routineContractTamper: "configuration" },
    { routineContractTamper: "body" },
    { routineContractTamper: "language" },
    { routineContractTamper: "kind" },
    { routineContractTamper: "volatility" },
    { routineContractTamper: "strict" },
    { routineContractTamper: "parallel" },
    { routineContractTamper: "leakproof" },
    { routineContractTamper: "argument-names" },
    { routineContractTamper: "argument-modes" },
    { routineContractTamper: "argument-types" },
    { routineContractTamper: "input-argument-count" },
    { routineContractTamper: "argument-defaults" },
    { routineContractTamper: "return-type" },
    { routineContractTamper: "returns-set" },
    { routineContractTamper: "variadic" },
    { routineContractTamper: "cost" },
    { routineContractTamper: "rows" },
    { routineContractTamper: "support" },
    { routineContractTamper: "transform-types" },
    { routineContractTamper: "binary" },
    { routineContractTamper: "sql-body" },
    { routineContractTamper: "definition" },
    { routineContractTamper: "owner-execute" },
    { routineContractTamper: "effective-acl" },
    { routineContractTamper: "direct-acl" },
  ]) {
    const tampered = makePoolHarness(options);
    await assert.rejects(
      verifyDatabaseRoleBoundaries({
        ...validInput(),
        poolFactory: tampered.factory,
        lockTimeoutMs: 50,
        requireApplicationObjects: true,
      }),
      DatabaseRoleBoundaryError,
    );
    assert.equal(
      tampered.pools.every((pool) => pool.ended),
      true,
    );
  }
});

test("requires exact reviewed trigger and worker outbox catalog contracts", async () => {
  const verified = makePoolHarness();
  const result = await verifyDatabaseRoleBoundaries({
    ...validInput(),
    poolFactory: verified.factory,
    lockTimeoutMs: 50,
    requireApplicationObjects: true,
  });
  assert.deepEqual(result, {
    rolesAuthenticated: 4,
    positiveChecks: 38,
    negativeChecks: 23,
  });

  const opsClient = verified.clients.get("learncoding_ops");
  const triggerQueries = opsClient.queries.filter((sql) =>
    sql.includes("reviewed_trigger_catalog_exact"),
  );
  assert.equal(triggerQueries.length, REVIEWED_APPLICATION_TRIGGERS.length);
  assert.match(triggerQueries[0], /pg_catalog\.pg_trigger/iu);
  assert.match(triggerQueries[0], /tgqual/iu);
  assert.match(triggerQueries[0], /tgnargs/iu);
  assert.match(triggerQueries[0], /tgattr/iu);
  assert.match(triggerQueries[0], /octet_length/iu);
  const workerQuery = opsClient.queries.find((sql) =>
    sql.includes("worker_column_direct_acl_exact"),
  );
  const workerQueryIndex = opsClient.queries.indexOf(workerQuery);
  assert.equal(
    opsClient.queryParameters[workerQueryIndex]?.[4],
    "email_outbox_dispatch_binding_valid",
  );
  assert.equal(
    opsClient.queryParameters[workerQueryIndex]?.[7],
    REVIEWED_APPLICATION_CONSTRAINTS[0].normalizedExpression,
  );
  assert.doesNotMatch(workerQuery, /\slike\s/iu);
  assert.match(workerQuery, /pg_catalog\.aclexplode/iu);
  assert.deepEqual(opsClient.queryParameters[workerQueryIndex]?.[2], [
    "dispatch_binding_version",
    "dispatch_binding_sha256",
  ]);

  for (const triggerContractTamper of [
    "relation",
    "function",
    "enabled",
    "type",
    "predicate",
    "arguments",
    "watched-columns",
    "catalog",
  ]) {
    const tampered = makeClient("learncoding_ops", "learncoding", {
      triggerContractTamper,
    });
    await assert.rejects(
      verifyReviewedApplicationTriggers(tampered),
      DatabaseRoleBoundaryError,
    );
  }

  for (const workerContractTamper of [
    "table",
    "owner",
    "binding-columns",
    "constraint-always-true",
    "constraint-state-arm-removed",
    "constraint-unknown-version",
    "constraint",
    "table-acl",
    "column-acl",
    "effective-acl",
  ]) {
    const tampered = makeClient("learncoding_ops", "learncoding", {
      workerContractTamper,
    });
    await assert.rejects(
      verifyMailWorkerOutboxContract(tampered),
      DatabaseRoleBoundaryError,
    );
  }

  assert.deepEqual(
    await verifyReviewedMailAuthorityCatalogContracts(
      makeClient("learncoding_ops", "learncoding", {}),
    ),
    {
      routinesVerified: REVIEWED_APPLICATION_FUNCTIONS.length,
      triggersVerified: REVIEWED_APPLICATION_TRIGGERS.length,
      workerContractsVerified: 1,
      totalVerified:
        REVIEWED_APPLICATION_FUNCTIONS.length +
        REVIEWED_APPLICATION_TRIGGERS.length +
        1,
    },
  );
});

test("supports reviewed routines with no restricted-role execute allowance", async () => {
  const contract = Object.freeze({
    signature: "public.no_runtime_execute_contract()",
    owner: "learncoding_owner",
    securityDefiner: false,
    configuration: Object.freeze(["search_path=pg_catalog"]),
    allowedRoles: Object.freeze([]),
    bodySha256:
      "319499a64f640749559a76870ade387c00888ec2089a7f1cea1a08f629d32447",
    definitionSha256: null,
    cost: 100,
    rows: 0,
    supportFunction: null,
    transformTypes: Object.freeze([]),
    binary: null,
    sqlBody: null,
    language: "plpgsql",
    kind: "f",
    volatility: "v",
    strict: false,
    parallel: "u",
    leakproof: false,
    argumentNames: Object.freeze([]),
    argumentModes: Object.freeze([]),
    argumentTypes: Object.freeze([]),
    inputArgumentCount: 0,
    argumentDefaultCount: 0,
    returnType: "trigger",
    returnsSet: false,
    variadic: false,
  });
  const verified = makeClient("learncoding_ops", "learncoding", {});

  assert.equal(
    await verifyReviewedApplicationRoutines(verified, [contract]),
    1,
  );
  const queryIndex = verified.queries.findIndex((sql) =>
    sql.includes("routine_direct_acl_exact"),
  );
  assert.deepEqual(verified.queryParameters[queryIndex]?.[5], []);

  for (const routineContractTamper of ["effective-acl", "direct-acl"]) {
    const tampered = makeClient("learncoding_ops", "learncoding", {
      routineContractTamper,
    });
    await assert.rejects(
      verifyReviewedApplicationRoutines(tampered, [contract]),
      DatabaseRoleBoundaryError,
    );
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
    positiveChecks: 38,
    negativeChecks: 23,
  });
  for (const role of [
    "learncoding_app",
    "learncoding_migrator",
    "learncoding_worker",
    "learncoding_ops",
  ]) {
    const queries = harness.clients.get(role).queries;
    const probesWithGrant = role !== "learncoding_migrator";
    assert.equal(
      queries.filter(
        (sql) =>
          sql.includes("aclexplode") &&
          sql.includes("current_role_direct_grantable"),
      ).length,
      probesWithGrant ? 2 : 1,
    );
    assert.equal(
      queries.filter((sql) => sql.startsWith("grant select on table ")).length,
      probesWithGrant ? 1 : 0,
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
  assert.equal(
    delegated.pools.every((pool) => pool.ended),
    true,
  );

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
  assert.equal(
    catalogChanged.pools.every((pool) => pool.ended),
    true,
  );
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
    assert.equal(
      harness.pools.every((pool) => pool.ended),
      true,
    );
  }
});

test("fails closed when the fixed GRANT probe errors for any SQLSTATE", async () => {
  for (const grantProbeErrorCode of ["42501", "XX000"]) {
    const harness = makePoolHarness({ grantProbeErrorCode });
    await assert.rejects(
      verifyDatabaseRoleBoundaries({
        ...validInput(),
        poolFactory: harness.factory,
        lockTimeoutMs: 50,
        requireApplicationObjects: true,
      }),
      DatabaseRoleBoundaryError,
    );
    assert.equal(
      harness.pools.every((pool) => pool.ended),
      true,
    );
    const queries = harness.clients.get("learncoding_app").queries;
    assert.equal(
      queries.filter((sql) => sql.includes("current_role_direct_grantable"))
        .length,
      1,
    );
    assert.equal(
      queries.includes("rollback to savepoint codestead_table_grant_probe"),
      false,
    );
    assert.equal(queries.includes("rollback"), true);
  }
});

test("fails closed when a forbidden statement succeeds or the lock remains held", async () => {
  const permissive = makePoolHarness({ allowForbidden: true });
  await assert.rejects(
    verifyDatabaseRoleBoundaries({
      ...validInput(),
      poolFactory: permissive.factory,
    }),
    DatabaseRoleBoundaryError,
  );
  assert.equal(
    permissive.pools.every((pool) => pool.ended),
    true,
  );

  const locked = makePoolHarness({ lockAvailable: false });
  await assert.rejects(
    verifyDatabaseRoleBoundaries({
      ...validInput(),
      poolFactory: locked.factory,
      lockTimeoutMs: 1,
    }),
    DatabaseRoleBoundaryError,
  );
  assert.equal(
    locked.pools.every((pool) => pool.ended),
    true,
  );
  const connectionFailure = makePoolHarness({
    connectFailureRole: "learncoding_worker",
  });
  await assert.rejects(
    verifyDatabaseRoleBoundaries({
      ...validInput(),
      poolFactory: connectionFailure.factory,
    }),
    DatabaseRoleBoundaryError,
  );
  assert.equal(
    connectionFailure.pools.every((pool) => pool.ended),
    true,
  );
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
  const result = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify(process.env))"],
    {
      encoding: "utf8",
      env: minimalPlatformEnvironment(Object.assign({}, process.env, canaries)),
    },
  );

  assert.equal(result.status, 0);
  const childEnvironment = JSON.parse(result.stdout);
  for (const [name, value] of Object.entries(canaries)) {
    assert.equal(childEnvironment[name], undefined);
    assert.doesNotMatch(
      result.stdout,
      new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
  }
});

test("CLI failure output never includes credential material", () => {
  const script = path.join(
    import.meta.dirname,
    "verify-database-role-boundaries.mjs",
  );
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
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    new RegExp(canary, "u"),
  );
  assert.match(
    result.stderr,
    /"event":"database\.role_boundary_verification_failed"/u,
  );
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
  assert.deepEqual(JSON.parse(result.stderr.trim()), {
    event: "database.role_bootstrap_failed",
    code: "DATABASE_ROLE_BOOTSTRAP_FAILED",
  });
});
