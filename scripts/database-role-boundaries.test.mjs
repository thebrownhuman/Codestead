import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  MAIL_APP_OUTBOX_INSERT_COLUMNS,
  MAIL_WORKER_OUTBOX_INSERT_COLUMNS,
  MAIL_WORKER_OUTBOX_PRE_REQUEST_UPDATE_COLUMNS,
  MAIL_WORKER_OUTBOX_UPDATE_COLUMNS,
  REVIEWED_APPLICATION_CONSTRAINTS,
  REVIEWED_APPLICATION_FUNCTIONS,
  REVIEWED_APPLICATION_TRIGGERS,
  REVIEWED_0065_BACKUP_STATUS_AUTHORITY,
  REVIEWED_0067_BACKUP_STATUS_AUTHORITY,
  REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES,
  REVIEWED_REPLAY_AUTHORITY_RELATIONAL_CONTRACT,
  backupStatusAuthorityPrivilegesSql,
  canonicalReviewedMailAuthorityCatalogPhase,
  mailWorkerOutboxPrivilegesSql,
  reviewedApplicationFunctionPrivilegesSql,
  reviewedExactAclRelationNames,
  verifyBackupStatusAuthorityAfterRepair,
  verifyBackupStatusAuthorityBeforeRepair,
  verifyPostMigrationReviewedContractsBeforeReconciliation,
} from "./bootstrap-database-roles.mjs";
import {
  DatabaseRoleBoundaryError,
  verifyDatabaseRoleBoundaries,
  verifyMailWorkerOutboxContract,
  verifyRestoredNoAclMailAuthorityStructure,
  verifyReviewedMailAuthorityCatalogContracts,
  verifyReviewedApplicationRoutines,
  verifyReviewedApplicationTriggers,
  validateDatabaseRoleBoundaryUrls,
} from "./verify-database-role-boundaries.mjs";
import { REVIEWED_MIGRATION_LEDGER } from "./lib/reviewed-migration-ledger.mjs";
import {
  databaseRuntimeCapabilityCatalogQueryResult,
  makeDatabaseRuntimeCapabilityCatalogFixture,
} from "./lib/database-runtime-capability-test-fixture.mjs";

function reviewedPhase(index) {
  const phase = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.find(
    (candidate) => candidate.index === index,
  );
  assert.ok(phase, `reviewed phase ${index} must be registered`);
  return phase;
}

const REVIEWED_PHASE_0062 = reviewedPhase(62);
const REVIEWED_PHASE_0063 = reviewedPhase(63);
const REVIEWED_PHASE_0064 = reviewedPhase(64);
const REVIEWED_PHASE_0065 = reviewedPhase(65);
const REVIEWED_PHASE_0066 = reviewedPhase(66);
const REVIEWED_PHASE_0067 = reviewedPhase(67);
const REVIEWED_PHASE_0068 = reviewedPhase(68);
const REVIEWED_PHASE_0069 = reviewedPhase(69);
const REVIEWED_REWARD_ROUTINES = Object.freeze([
  Object.freeze({
    signature:
      "public.enqueue_reward_jobs_for_attempt_v1(uuid,text,timestamp with time zone)",
    owner: "learncoding_owner",
    securityDefiner: false,
    configuration: null,
    allowedRoles: Object.freeze(["learncoding_app", "learncoding_worker"]),
    bodySha256:
      "facb629452f45715f4b9dfe577b29f05bee32a0ca44b26f27f80bbaa533b508f",
    definitionSha256:
      "05f3a04b1bdc75bece262f2692532d8ecfd2a6f3b46d2bf87c1f7a5aa3812983",
    argumentNames: Object.freeze(["p_attempt_id", "p_user_id", "p_now"]),
  }),
  Object.freeze({
    signature:
      "public.enqueue_reward_jobs_for_mastery_scope_v1(uuid,text,timestamp with time zone)",
    owner: "learncoding_owner",
    securityDefiner: false,
    configuration: null,
    allowedRoles: Object.freeze(["learncoding_app", "learncoding_worker"]),
    bodySha256:
      "a94d35a4bb7e85acc21599c875aec04b2922523bc0da857f184dffa3312c8c82",
    definitionSha256:
      "871d44498def9aee424a4474a317135e26fa1bc1271d5a4188f80dc04ac59819",
    argumentNames: Object.freeze([
      "p_mastery_evidence_id",
      "p_user_id",
      "p_now",
    ]),
  }),
]);
const REPLAY_AUTHORITY_CONSTRAINT_HASHES_BY_POSTGRES_MAJOR = Object.freeze({
  17: "2cc426fbe12df9a29707bbad22a3addf50fa483f0ad8f4c76c778ad25bf6748e",
  18: "2cc426fbe12df9a29707bbad22a3addf50fa483f0ad8f4c76c778ad25bf6748e",
});
const GUARDED_REPLAY_TRIGGER_ADDITIONS = Object.freeze([
  "email_outbox_delivery_hold_final",
  "email_outbox_delivery_release_commit_exact",
  "email_outbox_delivery_release_delete_exact",
  "email_outbox_delivery_release_insert_xid",
  "email_outbox_delivery_release_insert_xid_immutable",
  "email_outbox_provider_request_body_immutable",
  "zz_email_outbox_delivery_release_identity",
  "zz_email_outbox_delivery_release_insert_final",
]);
const GUARDED_RECEIPT_TRIGGER_NAMES = Object.freeze([
  "mail_delivery_release_receipt_insert_authority",
  "mail_delivery_release_receipt_append_only",
  "mail_delivery_release_receipt_no_truncate",
  "mail_delivery_release_receipt_delete_exact",
]);

function reviewedPhaseForOptions(options) {
  if (
    options.journalPresent === false ||
    options.appliedMigrationIndex === null
  ) {
    return null;
  }
  return reviewedPhase(options.appliedMigrationIndex ?? 67);
}

const password = (character) => character.repeat(48);
const MAIL_DELIVERY_RELEASE_RECEIPT_WORKER_SELECT_COLUMNS = Object.freeze([
  "outbox_id",
  "operation_id",
  "idempotency_authority_version",
  "idempotency_authority_sha256",
  "idempotency_original_payload_sha256",
  "release_version",
  "release_receipt_sha256",
]);
const validInput = () => ({
  postgresUser: "legacy_bootstrap",
  postgresDatabase: "learncoding",
  databaseBootstrapUrl: `postgresql://legacy_bootstrap:${password("b")}@postgres:5432/learncoding`,
  databaseAppUrl: `postgresql://learncoding_app:${password("a")}@postgres:5432/learncoding`,
  databaseMigratorUrl: `postgresql://learncoding_migrator:${password("m")}@postgres:5432/learncoding`,
  databaseWorkerUrl: `postgresql://learncoding_worker:${password("w")}@postgres:5432/learncoding`,
  databaseOpsUrl: `postgresql://learncoding_ops:${password("o")}@postgres:5432/learncoding`,
  databaseBackupReporterUrl: `postgresql://learncoding_backup_reporter:${password("r")}@postgres:5432/learncoding`,
});

const NO_TEST_FAILURE = Symbol("no-test-failure");

async function captureRejection(operation) {
  try {
    await operation();
    return { rejected: false, reason: NO_TEST_FAILURE };
  } catch (reason) {
    return { rejected: true, reason };
  }
}

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

function normalizedReviewedCheck(expression) {
  return expression
    .replace(/"?(email_outbox|email_outbox_idempotency_authority)"?[.]/gu, "")
    .replace(/[\s"]/gu, "");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function reviewedApplicationConstraint(name) {
  const constraint = REVIEWED_APPLICATION_CONSTRAINTS.find(
    (candidate) => candidate.name === name,
  );
  assert.ok(constraint, `missing reviewed application constraint ${name}`);
  return constraint;
}

test("pins reviewed-SQL and live-catalog Group 4 CHECK hashes separately", () => {
  const snapshot = JSON.parse(
    readFileSync(
      new URL("../drizzle/meta/0067_snapshot.json", import.meta.url),
      "utf8",
    ),
  );
  const authorityChecks =
    snapshot.tables["public.email_outbox_idempotency_authority"]
      .checkConstraints;
  const outboxChecks = snapshot.tables["public.email_outbox"].checkConstraints;
  const contract = REVIEWED_REPLAY_AUTHORITY_RELATIONAL_CONTRACT;

  for (const expected of contract.authority.checks) {
    const expression = authorityChecks[expected.name]?.value;
    assert.equal(typeof expression, "string");
    assert.equal(
      sha256(normalizedReviewedCheck(expression)),
      expected.reviewedSqlExpressionSha256,
    );
  }
  assert.equal(
    sha256(
      normalizedReviewedCheck(outboxChecks[contract.deliveryScope.name].value),
    ),
    contract.deliveryScope.reviewedSqlExpressionSha256,
  );
  assert.equal(contract.triggers.length, 9);
  assert.equal(contract.routines.length, 8);
});
test("reviews the two reward enqueue routines in every post-0061 catalog phase", () => {
  for (const phase of REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES) {
    const rewardRoutines = phase.routines.filter(({ signature }) =>
      REVIEWED_REWARD_ROUTINES.some(
        (expected) => expected.signature === signature,
      ),
    );
    assert.deepEqual(
      rewardRoutines.map(
        ({
          signature,
          owner,
          securityDefiner,
          configuration,
          allowedRoles,
          bodySha256,
          definitionSha256,
          language,
          kind,
          volatility,
          strict,
          parallel,
          leakproof,
          argumentNames,
          argumentModes,
          argumentTypes,
          inputArgumentCount,
          argumentDefaultCount,
          returnType,
          returnsSet,
          variadic,
        }) => ({
          signature,
          owner,
          securityDefiner,
          configuration,
          allowedRoles,
          bodySha256,
          definitionSha256,
          language,
          kind,
          volatility,
          strict,
          parallel,
          leakproof,
          argumentNames,
          argumentModes,
          argumentTypes,
          inputArgumentCount,
          argumentDefaultCount,
          returnType,
          returnsSet,
          variadic,
        }),
      ),
      REVIEWED_REWARD_ROUTINES.map((routine) => ({
        ...routine,
        language: "plpgsql",
        kind: "f",
        volatility: "v",
        strict: false,
        parallel: "u",
        leakproof: false,
        argumentModes: [],
        argumentTypes: ["uuid", "text", "timestamp with time zone"],
        inputArgumentCount: 3,
        argumentDefaultCount: 0,
        returnType: "void",
        returnsSet: false,
        variadic: false,
      })),
      `phase ${phase.index}`,
    );

    const privilegeSql =
      reviewedApplicationFunctionPrivilegesSql(phase).toLowerCase();
    for (const { signature } of REVIEWED_REWARD_ROUTINES) {
      for (const role of ["learncoding_app", "learncoding_worker"]) {
        assert.ok(
          privilegeSql.includes(
            `grant execute on function ${signature} to ${role}`,
          ),
          `phase ${phase.index} ${signature} ${role}`,
        );
      }
      for (const role of [
        "learncoding_ops",
        "learncoding_backup_reporter",
        "learncoding_migrator",
      ]) {
        assert.equal(
          privilegeSql.includes(
            `grant execute on function ${signature} to ${role}`,
          ),
          false,
          `phase ${phase.index} ${signature} ${role}`,
        );
      }
    }
  }
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
    "idempotency_authority_version",
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
    "provider_request_body_sha256",
    "provider_request_body_length",
    "adapter",
    "provider_message_id",
    "next_attempt_at",
    "sent_at",
    "quarantined_at",
    "last_error_code",
    "updated_at",
    "dispatch_binding_version",
    "dispatch_binding_sha256",
    "provider_correlation_version",
    "provider_evidence_version",
    "provider_evidence_sha256",
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
    /revoke all on table public\.email_outbox from learncoding_app, learncoding_worker, learncoding_ops/iu,
  );
  assert.match(
    sql,
    /revoke all \([^)]+\) on table public\.email_outbox from learncoding_app, learncoding_worker, learncoding_ops/iu,
  );
  assert.match(
    sql,
    /grant select on table public\.email_outbox to learncoding_app, learncoding_worker, learncoding_ops/iu,
  );
  assert.match(
    sql,
    /grant insert \([^)]+\) on table public\.email_outbox to learncoding_worker/iu,
  );
  assert.match(
    sql,
    /grant update \([^)]+\) on table public\.email_outbox to learncoding_worker/iu,
  );
  assert.doesNotMatch(
    sql,
    /grant (?:delete|truncate) on table public\.email_outbox to learncoding_worker/iu,
  );
  assert.match(sql, /pg_catalog\.pg_attribute/iu);
  assert.match(sql, /dispatch_binding_version/iu);
  assert.match(sql, /dispatch_binding_sha256/iu);
  assert.match(sql, /binding_column_count/iu);
  assert.match(sql, /binding_column_exact_count/iu);
  assert.match(sql, /raise exception/iu);
  assert.doesNotMatch(sql, /grant insert \([^)]*dispatch_binding_/iu);
});

test("keeps guarded-delivery release markers outside runtime write allowlists", () => {
  const releaseMarkers = [
    "delivery_release_insert_xid",
    "delivery_release_insert_system_identifier",
  ];
  for (const marker of releaseMarkers) {
    assert.equal(MAIL_WORKER_OUTBOX_INSERT_COLUMNS.includes(marker), false);
    assert.equal(MAIL_WORKER_OUTBOX_UPDATE_COLUMNS.includes(marker), false);
    assert.match(
      mailWorkerOutboxPrivilegesSql(),
      new RegExp(`\\b${marker}\\b`, "u"),
    );
  }
});

test("reconciles the delivery-release receipt to a seven-column worker read surface", async () => {
  const databaseRoleBootstrap = await import("./bootstrap-database-roles.mjs");
  assert.equal(
    typeof databaseRoleBootstrap.mailDeliveryReleasePrivilegesSql,
    "function",
  );

  const sql = databaseRoleBootstrap.mailDeliveryReleasePrivilegesSql();
  assert.match(
    sql,
    /relation_oid\s*:=\s*pg_catalog\.to_regclass\(\s*'public\.mail_delivery_release_receipt'\s*\);/iu,
  );
  const relationGuardIndex = sql.search(/if relation_oid is not null/iu);
  const firstAclIndex = sql.search(
    /revoke all on table public\.mail_delivery_release_receipt/iu,
  );
  assert.equal(relationGuardIndex >= 0, true);
  assert.equal(firstAclIndex >= 0, true);
  assert.equal(relationGuardIndex < firstAclIndex, true);
  assert.match(
    sql,
    /revoke all on table public\.mail_delivery_release_receipt from [^;]*public[^;]*learncoding_app[^;]*learncoding_worker[^;]*learncoding_ops/iu,
  );
  assert.match(
    sql,
    /grant select \([^)]+\) on table public\.mail_delivery_release_receipt to learncoding_worker/iu,
  );
  for (const column of MAIL_DELIVERY_RELEASE_RECEIPT_WORKER_SELECT_COLUMNS) {
    assert.match(sql, new RegExp(`\\b${column}\\b`, "u"));
  }
  assert.doesNotMatch(
    sql,
    /grant (?:select|insert|update|delete|truncate|references|trigger|maintain) on table public\.mail_delivery_release_receipt/iu,
  );
  assert.doesNotMatch(
    sql,
    /grant (?:insert|update|references) \([^)]+\) on table public\.mail_delivery_release_receipt/iu,
  );
});

test("narrows guarded-delivery outbox writes while retaining residual lifecycle deletes", async () => {
  const databaseRoleBootstrap = await import("./bootstrap-database-roles.mjs");
  const expectedWorkerInsertColumns = [
    "operation_id",
    "user_id",
    "delivery_scope_key",
    "to_email",
    "template",
    "template_version",
    "variables",
    "idempotency_key",
    "idempotency_authority_version",
    "status",
    "next_attempt_at",
  ];
  assert.deepEqual(databaseRoleBootstrap.MAIL_APP_OUTBOX_INSERT_COLUMNS, [
    "id",
    ...expectedWorkerInsertColumns,
  ]);
  assert.deepEqual(
    MAIL_WORKER_OUTBOX_INSERT_COLUMNS,
    expectedWorkerInsertColumns,
  );

  const sql = mailWorkerOutboxPrivilegesSql();
  assert.match(
    sql,
    /revoke all on table public\.email_outbox from learncoding_app, learncoding_worker, learncoding_ops/iu,
  );
  assert.match(
    sql,
    /grant select on table public\.email_outbox to learncoding_app, learncoding_worker, learncoding_ops/iu,
  );
  assert.match(
    sql,
    /grant delete on table public\.email_outbox to learncoding_app, learncoding_ops/iu,
  );
  assert.doesNotMatch(
    sql,
    /grant (?:insert|update) on table public\.email_outbox/iu,
  );
  assert.match(
    sql,
    /grant insert \(id, [^)]+\) on table public\.email_outbox to learncoding_app/iu,
  );
  assert.doesNotMatch(
    sql,
    /grant update \([^)]+\) on table public\.email_outbox to learncoding_app/iu,
  );
});

test("rejects direct, effective, marker, receipt, and membership ACL reopenings", async () => {
  const verified = makeClient("learncoding_ops", "learncoding", {});
  await verifyMailWorkerOutboxContract(verified, {
    requiresDispatchBinding: true,
    requiresProviderEvidence: true,
    requiresReplayAuthority: true,
    requiresProviderRequest: true,
    requiresGuardedDelivery: true,
  });
  const guardedQuery = verified.queries.find((sql) =>
    sql.includes("guarded_delivery_presence_exact"),
  );
  assert.equal(typeof guardedQuery, "string");
  assert.match(guardedQuery, /pg_catalog\.aclexplode/iu);
  assert.match(guardedQuery, /pg_catalog\.has_table_privilege/iu);
  assert.match(guardedQuery, /pg_catalog\.has_column_privilege/iu);
  assert.match(guardedQuery, /with recursive/iu);
  assert.match(guardedQuery, /pg_catalog\.pg_auth_members/iu);

  for (const guardedDeliveryAclTamper of [
    "guarded_delivery_presence_exact",
    "outbox_runtime_table_direct_acl_exact",
    "outbox_runtime_column_direct_acl_exact",
    "outbox_runtime_effective_acl_exact",
    "outbox_release_marker_writes_owner_only_exact",
    "receipt_table_direct_acl_exact",
    "receipt_column_direct_acl_exact",
    "receipt_effective_acl_exact",
    "runtime_membership_closure_exact",
  ]) {
    await assert.rejects(
      verifyMailWorkerOutboxContract(
        makeClient("learncoding_ops", "learncoding", {
          guardedDeliveryAclTamper,
        }),
        {
          requiresDispatchBinding: true,
          requiresProviderEvidence: true,
          requiresReplayAuthority: true,
          requiresProviderRequest: true,
          requiresGuardedDelivery: true,
        },
      ),
      (error) =>
        error instanceof DatabaseRoleBoundaryError &&
        error.message.includes(guardedDeliveryAclTamper),
    );
  }
});
test("runs exact outbox ACL verification for every reviewed phase", async () => {
  for (const [phase, expected] of [
    [REVIEWED_PHASE_0062, false],
    [REVIEWED_PHASE_0063, false],
    [REVIEWED_PHASE_0064, false],
    [REVIEWED_PHASE_0065, false],
    [REVIEWED_PHASE_0066, false],
    [REVIEWED_PHASE_0067, false],
    [REVIEWED_PHASE_0068, false],
    [REVIEWED_PHASE_0069, true],
  ]) {
    const client = makeClient("learncoding_ops", "learncoding", {
      appliedMigrationIndex: phase.index,
    });
    await verifyReviewedMailAuthorityCatalogContracts(client, phase);
    const index = client.queries.findIndex((sql) =>
      sql.includes("guarded_delivery_presence_exact"),
    );
    assert.notEqual(index, -1);
    assert.equal(client.queryParameters[index].at(-1), expected);
  }
});
test("rejects historical app and ops outbox ACL drift", async () => {
  for (const phase of [
    REVIEWED_PHASE_0062,
    REVIEWED_PHASE_0063,
    REVIEWED_PHASE_0064,
    REVIEWED_PHASE_0065,
    REVIEWED_PHASE_0066,
  ]) {
    for (const guardedDeliveryAclTamper of [
      "outbox_runtime_table_direct_acl_exact",
      "outbox_runtime_effective_acl_exact",
    ]) {
      await assert.rejects(
        verifyReviewedMailAuthorityCatalogContracts(
          makeClient("learncoding_ops", "learncoding", {
            appliedMigrationIndex: phase.index,
            guardedDeliveryAclTamper,
          }),
          phase,
        ),
        (error) =>
          error instanceof DatabaseRoleBoundaryError &&
          error.message.includes(guardedDeliveryAclTamper),
      );
    }
  }
});
test("binds phase 0069 to full worker ACLs and a fail-closed PG-major digest", async () => {
  const client = makeClient("learncoding_ops", "learncoding", {
    appliedMigrationIndex: 69,
  });
  await verifyPostMigrationReviewedContractsBeforeReconciliation(
    client,
    REVIEWED_PHASE_0069,
  );
  const workerQueryIndex = client.queries.findIndex((sql) =>
    sql.includes("worker_column_direct_acl_exact"),
  );
  assert.notEqual(workerQueryIndex, -1);
  assert.deepEqual(
    client.queryParameters[workerQueryIndex]?.[0],
    MAIL_WORKER_OUTBOX_INSERT_COLUMNS,
  );
  assert.deepEqual(
    client.queryParameters[workerQueryIndex]?.[1],
    MAIL_WORKER_OUTBOX_UPDATE_COLUMNS,
  );
  assert.equal(
    client.queryParameters[workerQueryIndex]?.[27],
    JSON.stringify(REPLAY_AUTHORITY_CONSTRAINT_HASHES_BY_POSTGRES_MAJOR),
  );
  const workerQuery = client.queries[workerQueryIndex];
  assert.match(
    workerQuery,
    /case\s+pg_catalog\.current_setting\(\s*'server_version_num'\s*\)::integer\s*\/\s*10000\s+when 17 then \$28::jsonb ->> '17'\s+when 18 then \$28::jsonb ->> '18'\s+else null\s+end/iu,
  );
  assert.doesNotMatch(workerQuery, /=\s*any\s*\(\s*\$28::text\[\]\s*\)/iu);
  const replayQueryIndex = client.queries.findIndex((sql) =>
    sql.includes("authority_constraint_set_exact"),
  );
  assert.notEqual(replayQueryIndex, -1);
  assert.equal(client.queryParameters[replayQueryIndex]?.[72], 2);
  assert.deepEqual(
    client.queryParameters[replayQueryIndex]?.[73],
    MAIL_APP_OUTBOX_INSERT_COLUMNS,
  );
  assert.deepEqual(
    client.queryParameters[replayQueryIndex]?.[74],
    MAIL_DELIVERY_RELEASE_RECEIPT_WORKER_SELECT_COLUMNS,
  );
  assert.deepEqual(client.queryParameters[replayQueryIndex]?.[65], [
    ...REVIEWED_REPLAY_AUTHORITY_RELATIONAL_CONTRACT.triggerRelations,
    "public.mail_delivery_release_receipt",
  ]);
  assert.deepEqual(
    JSON.parse(client.queryParameters[replayQueryIndex]?.[66])
      .map(({ name }) => name)
      .sort(),
    [
      ...REVIEWED_REPLAY_AUTHORITY_RELATIONAL_CONTRACT.triggers.map(
        ({ name }) => name,
      ),
      ...GUARDED_REPLAY_TRIGGER_ADDITIONS,
      ...GUARDED_RECEIPT_TRIGGER_NAMES,
    ].sort(),
  );
});
test("rejects exact guarded-delivery relation catalog drift", async () => {
  const verified = makeClient("learncoding_ops", "learncoding", {
    appliedMigrationIndex: 69,
  });
  await verifyReviewedMailAuthorityCatalogContracts(
    verified,
    REVIEWED_PHASE_0069,
  );
  const catalogQuery = verified.queries.find((sql) =>
    sql.includes("guarded_delivery_catalog_phase_exact"),
  );
  assert.equal(typeof catalogQuery, "string");
  assert.match(catalogQuery, /pg_catalog\.pg_constraint/iu);
  assert.match(catalogQuery, /pg_catalog\.pg_index/iu);
  assert.match(catalogQuery, /pg_catalog\.pg_rewrite/iu);
  assert.match(catalogQuery, /pg_catalog\.pg_inherits/iu);
  assert.match(catalogQuery, /pg_catalog\.pg_policy/iu);
  assert.match(
    catalogQuery,
    /index_row\.indkey::pg_catalog\.text\s*=\s*'1 15'::pg_catalog\.text/iu,
  );
  assert.doesNotMatch(
    catalogQuery,
    /index_row\.indkey::int2\[\]\s*=\s*array\[1,\s*15\]::int2\[\]/iu,
  );

  for (const guardedDeliveryCatalogTamper of [
    "guarded_delivery_catalog_phase_exact",
    "guarded_outbox_columns_exact",
    "guarded_outbox_constraints_exact",
    "receipt_relation_exact",
    "receipt_columns_exact",
    "receipt_constraints_exact",
    "receipt_indexes_exact",
    "receipt_foreign_keys_exact",
    "receipt_relation_safety_exact",
  ]) {
    await assert.rejects(
      verifyReviewedMailAuthorityCatalogContracts(
        makeClient("learncoding_ops", "learncoding", {
          appliedMigrationIndex: 69,
          guardedDeliveryCatalogTamper,
        }),
        REVIEWED_PHASE_0069,
      ),
      (error) =>
        error instanceof DatabaseRoleBoundaryError &&
        error.message.includes(guardedDeliveryCatalogTamper),
    );
  }
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

  const routineSql =
    reviewedApplicationFunctionPrivilegesSql(REVIEWED_PHASE_0067);
  assert.match(
    routineSql,
    /pg_catalog\.to_regrole\('learncoding_ops'\)\s+is\s+not\s+null/iu,
  );
  assert.match(
    routineSql,
    /routine_oid\s+pg_catalog\.oid\s*:=\s*pg_catalog\.to_regprocedure\(\s*'public\.redact_unresolved_email_outbox_authority\(timestamp with time zone,integer\)'\s*\)/iu,
  );
});

test("gates exact reward ACL states before manifest reconciliation", async () => {
  const databaseRoleBootstrap = await import("./bootstrap-database-roles.mjs");
  assert.equal(
    typeof databaseRoleBootstrap.verifyAndRepairReviewedBaselineRewardRoutinePrivileges,
    "function",
  );
  const sql = databaseRoleBootstrap
    .reviewedBaselineRewardFunctionPrivilegesSql(REVIEWED_PHASE_0069)
    .toLowerCase();
  for (const { signature } of REVIEWED_REWARD_ROUTINES) {
    assert.ok(sql.includes(signature));
  }
  assert.doesNotMatch(sql, /email_outbox|backup_status/iu);

  const source = readFileSync(
    new URL("./bootstrap-database-roles.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /applyDatabaseRolePrivilegeReconciliation|reconcileRestoredNoAclDatabaseRolePrivileges/gu,
  );
  assert.doesNotMatch(source, /\bon\s+all\s+(tables|sequences|routines)\b/giu);
  const compatibilityStart = source.indexOf(
    "export async function reconcileDatabaseRolePrivileges(",
  );
  const compatibilityEnd = source.indexOf(
    "\nfunction databaseRoleBootstrapInvariantError(",
    compatibilityStart,
  );
  const compatibility = source.slice(compatibilityStart, compatibilityEnd);
  assert.ok(compatibilityStart >= 0 && compatibilityEnd > compatibilityStart);
  assert.match(compatibility, /legacy-reconciliation-disabled/u);

  const bootstrapStart = source.indexOf(
    "export async function runDatabaseRoleBootstrap",
  );
  const begin = source.indexOf(
    'await beginDatabaseBootstrapTransaction(client, "activation")',
    bootstrapStart,
  );
  const phaseResolution = source.indexOf(
    "let reviewedPhase = await resolveReviewedMailAuthorityCatalogPhase(client)",
    bootstrapStart,
  );
  const routineGate = source.indexOf(
    "await verifyAndRepairReviewedPhaseRoutinePrivileges(",
    phaseResolution,
  );
  const rewardGate = source.indexOf(
    "await verifyAndRepairReviewedBaselineRewardRoutinePrivileges(",
    routineGate,
  );
  const precheck = source.indexOf(
    "await verifyPostMigrationReviewedContractsBeforeReconciliation(",
    rewardGate,
  );
  const roleReset = source.indexOf(
    "await createAndResetRoles(client)",
    precheck,
  );
  const ownership = source.indexOf(
    "await transferBootstrapDatabaseRuntimeCapabilityOwnership(",
    roleReset,
  );
  const reconcile = source.indexOf(
    "await reconcileBootstrapDatabaseRuntimeCapabilities(",
    ownership,
  );
  const exactVerify = source.indexOf(
    "await verifyBootstrapDatabaseRuntimeCapabilities(",
    reconcile,
  );
  assert.ok(bootstrapStart >= 0);
  assert.ok(begin > bootstrapStart && begin < phaseResolution);
  assert.ok(routineGate > phaseResolution);
  assert.ok(rewardGate > routineGate);
  assert.ok(precheck > rewardGate);
  assert.ok(roleReset > precheck);
  assert.ok(ownership > roleReset);
  assert.ok(reconcile > ownership);
  assert.ok(exactVerify > reconcile);
});

test("leaves a canonical reward ACL unchanged", async () => {
  const databaseRoleBootstrap = await import("./bootstrap-database-roles.mjs");
  const client = makeClient("learncoding_ops", "learncoding", {
    appliedMigrationIndex: 69,
    rewardRoutineAclState: "canonical",
  });

  assert.equal(
    await databaseRoleBootstrap.verifyAndRepairReviewedBaselineRewardRoutinePrivileges(
      client,
      REVIEWED_PHASE_0069,
    ),
    "canonical",
  );
  assert.equal(
    client.queries.filter((query) =>
      query.includes("do $codestead_reviewed_function_0$"),
    ).length,
    0,
  );
  assert.deepEqual(
    client.queryParameters
      .filter((parameters) =>
        REVIEWED_REWARD_ROUTINES.some(
          ({ signature }) => signature === parameters?.[0],
        ),
      )
      .map((parameters) => [parameters[0], parameters[5]]),
    REVIEWED_REWARD_ROUTINES.map(({ signature }) => [
      signature,
      ["learncoding_app", "learncoding_worker"],
    ]),
  );
});

test("repairs only the exact owner-only legacy reward ACL", async () => {
  const databaseRoleBootstrap = await import("./bootstrap-database-roles.mjs");
  const client = makeClient("learncoding_ops", "learncoding", {
    appliedMigrationIndex: 69,
    rewardRoutineAclState: "owner-only",
  });

  assert.equal(
    await databaseRoleBootstrap.verifyAndRepairReviewedBaselineRewardRoutinePrivileges(
      client,
      REVIEWED_PHASE_0069,
    ),
    "repaired",
  );
  const repairs = client.queries.filter((query) =>
    query.includes("do $codestead_reviewed_function_0$"),
  );
  assert.equal(repairs.length, 1);
  for (const { signature } of REVIEWED_REWARD_ROUTINES) {
    assert.ok(repairs[0].includes(signature));
    for (const role of ["learncoding_app", "learncoding_worker"]) {
      assert.ok(
        repairs[0].includes(
          `grant execute on function ${signature} to ${role}`,
        ),
      );
    }
  }
  assert.doesNotMatch(
    repairs[0],
    /email_outbox|backup_status|revoke all on (?:database|schema|all tables|all sequences|all routines)/iu,
  );
  assert.deepEqual(
    client.queryParameters
      .filter((parameters) =>
        REVIEWED_REWARD_ROUTINES.some(
          ({ signature }) => signature === parameters?.[0],
        ),
      )
      .map((parameters) => [parameters[0], parameters[5]]),
    [
      [
        REVIEWED_REWARD_ROUTINES[0].signature,
        ["learncoding_app", "learncoding_worker"],
      ],
      [REVIEWED_REWARD_ROUTINES[0].signature, []],
      [REVIEWED_REWARD_ROUTINES[1].signature, []],
      [
        REVIEWED_REWARD_ROUTINES[0].signature,
        ["learncoding_app", "learncoding_worker"],
      ],
      [
        REVIEWED_REWARD_ROUTINES[1].signature,
        ["learncoding_app", "learncoding_worker"],
      ],
    ],
  );
});

test("rejects every hostile reward ACL or structural state before mutation", async () => {
  const databaseRoleBootstrap = await import("./bootstrap-database-roles.mjs");
  for (const rewardRoutineAclState of [
    "partial-app",
    "partial-worker",
    "public",
    "ops",
    "migrator",
    "backup",
    "delegated",
    "grantable",
    "mixed",
    "owner-mismatch",
    "body-drift",
    "definition-drift",
    "config-drift",
  ]) {
    const client = makeClient("learncoding_ops", "learncoding", {
      appliedMigrationIndex: 69,
      rewardRoutineAclState,
    });
    await assert.rejects(
      databaseRoleBootstrap.verifyAndRepairReviewedBaselineRewardRoutinePrivileges(
        client,
        REVIEWED_PHASE_0069,
      ),
      /reviewed-baseline-reward-routine-pre-repair/u,
      rewardRoutineAclState,
    );
    assert.equal(
      client.queries.some(
        (query) =>
          query.includes("do $codestead_reviewed_function_0$") ||
          query.includes("revoke all on database") ||
          query.includes("revoke all on schema public") ||
          query.includes("revoke execute on all routines"),
      ),
      false,
      rewardRoutineAclState,
    );
  }
});
test("does not retry operational reward ACL verification failures", async () => {
  const databaseRoleBootstrap = await import("./bootstrap-database-roles.mjs");
  const operationalFailure = new Error("simulated catalog connection loss");
  const client = makeClient("learncoding_ops", "learncoding", {
    appliedMigrationIndex: 69,
    rewardRoutineOperationalFailure: operationalFailure,
  });
  await assert.rejects(
    databaseRoleBootstrap.verifyAndRepairReviewedBaselineRewardRoutinePrivileges(
      client,
      REVIEWED_PHASE_0069,
    ),
    (error) => error === operationalFailure,
  );
  assert.equal(
    client.queries.some((query) =>
      query.includes("do $codestead_reviewed_function_0$"),
    ),
    false,
  );
});
test("does not mask operational owner-only reward ACL verification failures", async () => {
  const databaseRoleBootstrap = await import("./bootstrap-database-roles.mjs");
  const operationalFailure = new Error(
    "simulated legacy catalog connection loss",
  );
  const client = makeClient("learncoding_ops", "learncoding", {
    appliedMigrationIndex: 69,
    rewardRoutineAclState: "owner-only",
    rewardRoutineOwnerOnlyOperationalFailure: operationalFailure,
  });
  await assert.rejects(
    databaseRoleBootstrap.verifyAndRepairReviewedBaselineRewardRoutinePrivileges(
      client,
      REVIEWED_PHASE_0069,
    ),
    (error) => error === operationalFailure,
  );
  assert.equal(
    client.queries.some((query) =>
      query.includes("do $codestead_reviewed_function_0$"),
    ),
    false,
  );
});
test("gates every reviewed routine before exact manifest reconciliation", async () => {
  const databaseRoleBootstrap = await import("./bootstrap-database-roles.mjs");
  assert.equal(
    typeof databaseRoleBootstrap.verifyAndRepairReviewedPhaseRoutinePrivileges,
    "function",
  );

  const source = readFileSync(
    new URL("./bootstrap-database-roles.mjs", import.meta.url),
    "utf8",
  );
  const bootstrapStart = source.indexOf(
    "export async function runDatabaseRoleBootstrap",
  );
  const begin = source.indexOf(
    'await beginDatabaseBootstrapTransaction(client, "activation")',
    bootstrapStart,
  );
  const phaseResolution = source.indexOf(
    "let reviewedPhase = await resolveReviewedMailAuthorityCatalogPhase(client)",
    bootstrapStart,
  );
  const allRoutineGate = source.indexOf(
    "await verifyAndRepairReviewedPhaseRoutinePrivileges(",
    phaseResolution,
  );
  const rewardGate = source.indexOf(
    "await verifyAndRepairReviewedBaselineRewardRoutinePrivileges(",
    allRoutineGate,
  );
  const precheck = source.indexOf(
    "await verifyPostMigrationReviewedContractsBeforeReconciliation(",
    rewardGate,
  );
  const roleReset = source.indexOf(
    "await createAndResetRoles(client)",
    precheck,
  );
  const reconcile = source.indexOf(
    "await reconcileBootstrapDatabaseRuntimeCapabilities(",
    roleReset,
  );
  const exactVerify = source.indexOf(
    "await verifyBootstrapDatabaseRuntimeCapabilities(",
    reconcile,
  );
  assert.ok(begin > bootstrapStart && begin < phaseResolution);
  assert.ok(allRoutineGate > phaseResolution);
  assert.ok(rewardGate > allRoutineGate);
  assert.ok(precheck > rewardGate);
  assert.ok(roleReset > precheck);
  assert.ok(reconcile > roleReset);
  assert.ok(exactVerify > reconcile);
  assert.doesNotMatch(source, /\bon\s+all\s+(tables|sequences|routines)\b/giu);
});

test("leaves every canonical reviewed routine ACL unchanged", async () => {
  const databaseRoleBootstrap = await import("./bootstrap-database-roles.mjs");
  for (const phase of REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES) {
    const client = makeClient("learncoding_ops", "learncoding", {
      appliedMigrationIndex: phase.index,
      reviewedRoutineAclState: "canonical",
    });
    assert.equal(
      await databaseRoleBootstrap.verifyAndRepairReviewedPhaseRoutinePrivileges(
        client,
        phase,
      ),
      "canonical",
      `phase ${phase.index}`,
    );
    assert.equal(
      client.queries.some((query) =>
        query.includes("do $codestead_reviewed_function_0$"),
      ),
      false,
      `phase ${phase.index}`,
    );
    assert.deepEqual(
      client.queryParameters
        .filter((parameters) =>
          phase.routines.some(({ signature }) => signature === parameters?.[0]),
        )
        .map((parameters) => [parameters[0], parameters[5]]),
      phase.routines.map(({ signature, allowedRoles }) => [
        signature,
        allowedRoles,
      ]),
      `phase ${phase.index}`,
    );
  }
});

test("repairs only exact all-owner-only reviewed routine ACL states", async () => {
  const databaseRoleBootstrap = await import("./bootstrap-database-roles.mjs");
  const allKnownSignatures = [
    ...new Set(
      REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.flatMap(({ routines }) =>
        routines.map(({ signature }) => signature),
      ),
    ),
  ];
  for (const phase of REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES) {
    const client = makeClient("learncoding_ops", "learncoding", {
      appliedMigrationIndex: phase.index,
      reviewedRoutineAclState: "owner-only",
    });
    assert.equal(
      await databaseRoleBootstrap.verifyAndRepairReviewedPhaseRoutinePrivileges(
        client,
        phase,
      ),
      "repaired",
      `phase ${phase.index}`,
    );
    const repairs = client.queries.filter(
      (query) =>
        query.includes("do $codestead_reviewed_function_0$") &&
        phase.routines.every(({ signature }) => query.includes(signature)),
    );
    assert.equal(repairs.length, 1, `phase ${phase.index}`);
    assert.equal(
      repairs[0].match(/do \$codestead_reviewed_function_\d+\$/gu)?.length,
      phase.routines.length,
      `phase ${phase.index}`,
    );
    assert.deepEqual(
      allKnownSignatures
        .filter((signature) => repairs[0].includes(signature))
        .sort(),
      phase.routines.map(({ signature }) => signature).sort(),
      `phase ${phase.index}`,
    );
    assert.doesNotMatch(
      repairs[0],
      /revoke all on (?:database|schema|all tables|all sequences|all routines)/iu,
    );
    for (const { signature, allowedRoles } of phase.routines) {
      assert.ok(repairs[0].includes(signature), `phase ${phase.index}`);
      for (const role of allowedRoles) {
        assert.ok(
          repairs[0].includes(
            `grant execute on function ${signature} to ${role}`,
          ),
          `phase ${phase.index} ${signature} ${role}`,
        );
      }
    }

    const verificationParameters = client.queryParameters.filter((parameters) =>
      phase.routines.some(({ signature }) => signature === parameters?.[0]),
    );
    const verificationSequence = verificationParameters.map((parameters) => [
      parameters[0],
      parameters[5],
    ]);
    assert.deepEqual(
      verificationSequence,
      [
        [phase.routines[0].signature, phase.routines[0].allowedRoles],
        ...phase.routines.map(({ signature }) => [signature, []]),
        ...phase.routines.map(({ signature, allowedRoles }) => [
          signature,
          allowedRoles,
        ]),
      ],
      `phase ${phase.index}`,
    );

    const ownerOnlyParameters = verificationParameters.slice(
      1,
      1 + phase.routines.length,
    );
    const postRepairParameters = verificationParameters.slice(
      1 + phase.routines.length,
    );
    for (
      let routineIndex = 0;
      routineIndex < phase.routines.length;
      routineIndex += 1
    ) {
      for (
        let parameterIndex = 0;
        parameterIndex < ownerOnlyParameters[routineIndex].length;
        parameterIndex += 1
      ) {
        assert.deepEqual(
          ownerOnlyParameters[routineIndex][parameterIndex],
          parameterIndex === 5
            ? []
            : postRepairParameters[routineIndex][parameterIndex],
          `phase ${phase.index} routine ${routineIndex} parameter ${parameterIndex}`,
        );
      }
    }
  }
});

test("repairs only the exact heterogeneous raw migration routine ACL manifest", async () => {
  const databaseRoleBootstrap = await import("./bootstrap-database-roles.mjs");
  const rewardSignatures = new Set(
    REVIEWED_REWARD_ROUTINES.map(({ signature }) => signature),
  );

  for (const phase of REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES) {
    const client = makeClient("learncoding_ops", "learncoding", {
      appliedMigrationIndex: phase.index,
      reviewedRoutineAclState: "raw-migration",
    });
    const rawMigrationManifest = phase.routines.map(
      ({ signature, allowedRoles }) => [
        signature,
        rewardSignatures.has(signature) ? [] : allowedRoles,
      ],
    );

    assert.equal(
      await databaseRoleBootstrap.verifyAndRepairReviewedPhaseRoutinePrivileges(
        client,
        phase,
      ),
      "repaired",
      `phase ${phase.index}`,
    );
    const repairs = client.queries.filter(
      (query) =>
        query.includes("do $codestead_reviewed_function_0$") &&
        phase.routines.every(({ signature }) => query.includes(signature)),
    );
    assert.equal(repairs.length, 1, `phase ${phase.index}`);
    for (const { signature, allowedRoles } of phase.routines) {
      assert.ok(repairs[0].includes(signature), `phase ${phase.index}`);
      for (const role of allowedRoles) {
        assert.ok(
          repairs[0].includes(
            `grant execute on function ${signature} to ${role}`,
          ),
          `phase ${phase.index} ${signature} ${role}`,
        );
      }
    }

    const verificationSequence = client.queryParameters
      .filter((parameters) =>
        phase.routines.some(({ signature }) => signature === parameters?.[0]),
      )
      .map((parameters) => [parameters[0], parameters[5]]);
    const containsRawManifest = verificationSequence.some(
      (_entry, startIndex) =>
        JSON.stringify(
          verificationSequence.slice(
            startIndex,
            startIndex + rawMigrationManifest.length,
          ),
        ) === JSON.stringify(rawMigrationManifest),
    );
    assert.equal(containsRawManifest, true, `phase ${phase.index}`);

    assert.equal(
      await databaseRoleBootstrap.verifyAndRepairReviewedPhaseRoutinePrivileges(
        client,
        phase,
      ),
      "canonical",
      `phase ${phase.index} idempotent replay`,
    );
    assert.equal(
      client.queries.filter(
        (query) =>
          query.includes("do $codestead_reviewed_function_0$") &&
          phase.routines.every(({ signature }) => query.includes(signature)),
      ).length,
      1,
      `phase ${phase.index} idempotent repair count`,
    );
  }
});

test("rejects structural drift in the raw migration routine manifest before mutation", async () => {
  const databaseRoleBootstrap = await import("./bootstrap-database-roles.mjs");
  for (const routineContractTamper of [
    "owner",
    "body",
    "definition",
    "configuration",
    "security-definer",
    "language",
    "kind",
    "volatility",
    "strict",
    "parallel",
    "argument-names",
    "argument-modes",
    "argument-types",
    "input-argument-count",
    "argument-defaults",
    "return-type",
    "returns-set",
    "variadic",
    "owner-execute",
  ]) {
    const client = makeClient("learncoding_ops", "learncoding", {
      appliedMigrationIndex: 69,
      reviewedRoutineAclState: "raw-migration",
      routineContractTamper,
    });
    await assert.rejects(
      databaseRoleBootstrap.verifyAndRepairReviewedPhaseRoutinePrivileges(
        client,
        REVIEWED_PHASE_0069,
      ),
      /reviewed-phase-routine-pre-repair/u,
      routineContractTamper,
    );
    assert.equal(
      client.queries.some((query) =>
        query.includes("do $codestead_reviewed_function_0$"),
      ),
      false,
      routineContractTamper,
    );
  }
});

test("rejects mixed and hostile reviewed routine ACL states before mutation", async () => {
  const databaseRoleBootstrap = await import("./bootstrap-database-roles.mjs");
  for (const reviewedRoutineAclState of [
    "mixed",
    "attempt-only-owner-only",
    "mastery-only-owner-only",
    "partial-app",
    "partial-worker",
    "public",
    "ops",
    "migrator",
    "backup",
    "delegated",
    "grantable",
  ]) {
    const client = makeClient("learncoding_ops", "learncoding", {
      appliedMigrationIndex: 69,
      reviewedRoutineAclState,
    });
    await assert.rejects(
      databaseRoleBootstrap.verifyAndRepairReviewedPhaseRoutinePrivileges(
        client,
        REVIEWED_PHASE_0069,
      ),
      /reviewed-phase-routine-pre-repair/u,
      reviewedRoutineAclState,
    );
    assert.equal(
      client.queries.some((query) =>
        query.includes("do $codestead_reviewed_function_0$"),
      ),
      false,
      reviewedRoutineAclState,
    );
  }
});

test("rejects reviewed routine structural drift before mutation", async () => {
  const databaseRoleBootstrap = await import("./bootstrap-database-roles.mjs");
  for (const routineContractTamper of [
    "owner",
    "body",
    "definition",
    "configuration",
    "security-definer",
    "language",
    "kind",
    "volatility",
    "strict",
    "parallel",
    "argument-names",
    "argument-modes",
    "argument-types",
    "input-argument-count",
    "argument-defaults",
    "return-type",
    "returns-set",
    "variadic",
    "owner-execute",
  ]) {
    const client = makeClient("learncoding_ops", "learncoding", {
      appliedMigrationIndex: 69,
      reviewedRoutineAclState: "owner-only",
      routineContractTamper,
    });
    await assert.rejects(
      databaseRoleBootstrap.verifyAndRepairReviewedPhaseRoutinePrivileges(
        client,
        REVIEWED_PHASE_0069,
      ),
      /reviewed-phase-routine-pre-repair/u,
      routineContractTamper,
    );
    assert.equal(
      client.queries.some((query) =>
        query.includes("do $codestead_reviewed_function_0$"),
      ),
      false,
      routineContractTamper,
    );
  }
});

test("rejects a missing reviewed routine before mutation", async () => {
  const databaseRoleBootstrap = await import("./bootstrap-database-roles.mjs");
  const client = makeClient("learncoding_ops", "learncoding", {
    appliedMigrationIndex: 69,
    reviewedRoutineAclState: "owner-only",
    requiredRoutineMissing: true,
  });
  await assert.rejects(
    databaseRoleBootstrap.verifyAndRepairReviewedPhaseRoutinePrivileges(
      client,
      REVIEWED_PHASE_0069,
    ),
    /reviewed-phase-routine-pre-repair/u,
  );
  assert.equal(
    client.queries.some((query) =>
      query.includes("do $codestead_reviewed_function_0$"),
    ),
    false,
  );
});

test("fails closed when all-routine ACL post-verification is not canonical", async () => {
  const databaseRoleBootstrap = await import("./bootstrap-database-roles.mjs");
  const client = makeClient("learncoding_ops", "learncoding", {
    appliedMigrationIndex: 69,
    reviewedRoutineAclState: "owner-only",
    reviewedRoutinePostRepairAclState: "grantable",
  });
  await assert.rejects(
    databaseRoleBootstrap.verifyAndRepairReviewedPhaseRoutinePrivileges(
      client,
      REVIEWED_PHASE_0069,
    ),
    DatabaseRoleBoundaryError,
  );
  assert.equal(
    client.queries.filter((query) =>
      query.includes("do $codestead_reviewed_function_0$"),
    ).length,
    1,
  );
});
test("propagates operational failures from both all-routine ACL states", async () => {
  const databaseRoleBootstrap = await import("./bootstrap-database-roles.mjs");
  for (const ownerOnly of [false, true]) {
    const operationalFailure = new Error(
      ownerOnly
        ? "simulated all-owner-only catalog loss"
        : "simulated canonical catalog loss",
    );
    const client = makeClient("learncoding_ops", "learncoding", {
      appliedMigrationIndex: 69,
      reviewedRoutineAclState: ownerOnly ? "owner-only" : "canonical",
      ...(ownerOnly
        ? { reviewedRoutineOwnerOnlyOperationalFailure: operationalFailure }
        : { reviewedRoutineOperationalFailure: operationalFailure }),
    });
    await assert.rejects(
      databaseRoleBootstrap.verifyAndRepairReviewedPhaseRoutinePrivileges(
        client,
        REVIEWED_PHASE_0069,
      ),
      (error) => error === operationalFailure,
    );
    assert.equal(
      client.queries.some((query) =>
        query.includes("do $codestead_reviewed_function_0$"),
      ),
      false,
    );
  }
});
test("keeps the legacy blanket reconciliation export fail-closed without database access", async () => {
  const databaseRoleBootstrap = await import("./bootstrap-database-roles.mjs");
  assert.equal(
    typeof databaseRoleBootstrap.reconcileDatabaseRolePrivileges,
    "function",
  );
  assert.equal(databaseRoleBootstrap.reconcileDatabaseRolePrivileges.length, 2);
  let queries = 0;
  await assert.rejects(
    databaseRoleBootstrap.reconcileDatabaseRolePrivileges(
      {
        async query() {
          queries += 1;
          throw new Error("database access is forbidden");
        },
      },
      REVIEWED_PHASE_0069,
    ),
    /legacy-reconciliation-disabled/u,
  );
  assert.equal(queries, 0);
});

test("reconciles both authority relations to an exact zero-DML surface", () => {
  const sql = backupStatusAuthorityPrivilegesSql();
  assert.match(
    sql,
    /revoke all on table\s+public\.backup_status_mail_authority,\s+public\.backup_status_mail_admin_guard/iu,
  );
  assert.match(
    sql,
    /revoke all \(\s+id, run_key, outcome, outbox_id, operation_id, authority_epoch,\s+created_at\s+\) on table public\.backup_status_mail_authority/iu,
  );
  assert.match(
    sql,
    /revoke all \(\s+singleton, authority_epoch\s+\) on table public\.backup_status_mail_admin_guard/iu,
  );
  assert.doesNotMatch(sql, /\bgrant\b/iu);

  const bootstrapSource = readFileSync(
    new URL("./bootstrap-database-roles.mjs", import.meta.url),
    "utf8",
  );
  const precheck = bootstrapSource.indexOf(
    "await verifyBackupStatusAuthorityBeforeRepair(",
  );
  const repair = bootstrapSource.indexOf(
    "await createAndResetRoles(client)",
    precheck,
  );
  const postcheck = bootstrapSource.indexOf(
    "await verifyBackupStatusAuthorityAfterRepair(",
  );
  assert.ok(precheck >= 0 && precheck < repair);
  assert.ok(postcheck > repair);
});

test("freezes 0065/0066 backup authority and selects 0067 at every verifier", async () => {
  const phase0065 = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.find(
    ({ index }) => index === 65,
  );
  const phase0066 = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.find(
    ({ index }) => index === 66,
  );
  const phase0067 = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.find(
    ({ index }) => index === 67,
  );
  assert.equal(
    phase0065?.backupStatusAuthority,
    REVIEWED_0065_BACKUP_STATUS_AUTHORITY,
  );
  assert.equal(
    phase0066?.backupStatusAuthority,
    REVIEWED_0065_BACKUP_STATUS_AUTHORITY,
  );
  assert.equal(
    phase0067?.backupStatusAuthority,
    REVIEWED_0067_BACKUP_STATUS_AUTHORITY,
  );
  assert.notEqual(
    phase0067?.backupStatusAuthority,
    phase0066?.backupStatusAuthority,
  );

  const expectedConfigurations = new Map([
    [65, ["search_path=pg_catalog"]],
    [66, ["search_path=pg_catalog"]],
    [67, ["search_path=pg_catalog, pg_temp"]],
  ]);
  for (const [
    appliedMigrationIndex,
    expectedConfiguration,
  ] of expectedConfigurations) {
    const client = makeClient("learncoding_ops", "learncoding", {
      appliedMigrationIndex,
      bindingColumnCount: 2,
      bindingColumnExactCount: 2,
    });
    assert.equal(
      await verifyPostMigrationReviewedContractsBeforeReconciliation(
        client,
        reviewedPhase(appliedMigrationIndex),
      ),
      1,
    );
    const enqueueCalls = client.queryParameters.filter(
      (parameters) =>
        parameters?.[0] ===
        "public.enqueue_backup_status_mail_authority(text,text)",
    );
    assert.ok(enqueueCalls.length >= 1);
    for (const parameters of enqueueCalls) {
      assert.deepEqual(parameters[3], expectedConfiguration);
    }
  }

  const finalEnqueueContracts = REVIEWED_APPLICATION_FUNCTIONS.filter(
    ({ signature }) =>
      signature === "public.enqueue_backup_status_mail_authority(text,text)",
  );
  assert.equal(finalEnqueueContracts.length, 1);
  assert.deepEqual(finalEnqueueContracts[0].configuration, [
    "search_path=pg_catalog, pg_temp",
  ]);
});

test("rejects missing, partial, and cloned catalog phases before work", async () => {
  const invalidPhases = [
    undefined,
    Object.freeze({ index: 66 }),
    Object.freeze({ ...REVIEWED_PHASE_0066 }),
  ];
  for (const phase of invalidPhases) {
    assert.throws(
      () => canonicalReviewedMailAuthorityCatalogPhase(phase),
      /reviewed-mail-authority-catalog-phase-contract/u,
    );
    assert.throws(
      () => reviewedApplicationFunctionPrivilegesSql(phase),
      /reviewed-mail-authority-catalog-phase-contract/u,
    );
    const client = {
      calls: 0,
      async query() {
        this.calls += 1;
        throw new Error("canonical rejection must happen before query");
      },
    };
    await assert.rejects(
      verifyReviewedMailAuthorityCatalogContracts(client, phase),
      /reviewed-mail-authority-catalog-phase-contract/u,
    );
    assert.equal(client.calls, 0);
  }
  assert.equal(canonicalReviewedMailAuthorityCatalogPhase(null), null);
});

test("generates routine ACL repair from only the selected catalog phase", () => {
  const sql0065 = reviewedApplicationFunctionPrivilegesSql(REVIEWED_PHASE_0065);
  const sql0066 = reviewedApplicationFunctionPrivilegesSql(REVIEWED_PHASE_0066);
  const sql0067 = reviewedApplicationFunctionPrivilegesSql(REVIEWED_PHASE_0067);
  assert.doesNotMatch(
    sql0065,
    /enforce_email_outbox_provider_correlation_evidence/u,
  );
  assert.match(sql0066, /enforce_email_outbox_provider_correlation_evidence/u);
  for (const preReplaySql of [sql0065, sql0066]) {
    assert.doesNotMatch(preReplaySql, /email_outbox_original_payload_sha256/u);
  }
  assert.match(sql0067, /email_outbox_original_payload_sha256/u);
});
test("re-resolves the full journal-selected catalog phase after beforeCommit", () => {
  const source = readFileSync(
    new URL("./bootstrap-database-roles.mjs", import.meta.url),
    "utf8",
  );
  const callback = source.indexOf("await options.beforeCommit(client)");
  const postCallbackResolution = source.indexOf(
    "await resolveReviewedMailAuthorityCatalogPhase(client)",
    callback,
  );
  const postCallbackBoundary = source.indexOf(
    "await verifyBackupStatusAuthorityAfterRepair(",
    postCallbackResolution,
  );
  const commit = source.indexOf(
    'await commitDatabaseBootstrapTransaction(client, "activation")',
    callback,
  );
  assert.ok(callback >= 0);
  assert.ok(postCallbackResolution > callback);
  assert.ok(postCallbackBoundary > postCallbackResolution);
  assert.ok(commit > postCallbackBoundary);
});

test("re-verifies the reviewed ACL catalog after privilege reconciliation", () => {
  const source = readFileSync(
    new URL("./bootstrap-database-roles.mjs", import.meta.url),
    "utf8",
  );
  const runStart = source.indexOf(
    "export async function runDatabaseRoleBootstrap(options)",
  );
  const reconcile = source.indexOf(
    "await reconcileBootstrapDatabaseRuntimeCapabilities(",
    runStart,
  );
  const postReconciliationVerify = source.indexOf(
    "await verifyPostMigrationReviewedContractsBeforeReconciliation(",
    reconcile + 1,
  );
  const capabilityVerify = source.indexOf(
    "await verifyBootstrapDatabaseRuntimeCapabilities(",
    postReconciliationVerify,
  );
  const stateVerify = source.indexOf(
    "await verifyDatabaseRoleBootstrapState(",
    reconcile + 1,
  );
  assert.ok(runStart >= 0 && reconcile > runStart);
  assert.ok(postReconciliationVerify > reconcile);
  assert.ok(capabilityVerify > postReconciliationVerify);
  assert.ok(stateVerify > capabilityVerify);
});
test("keeps every phase-specific exact-ACL relation out of coarse full-CRUD scans", () => {
  assert.deepEqual(reviewedExactAclRelationNames(null), ["email_outbox"]);
  assert.deepEqual(reviewedExactAclRelationNames(REVIEWED_PHASE_0062), [
    "email_outbox",
  ]);
  assert.deepEqual(reviewedExactAclRelationNames(REVIEWED_PHASE_0063), [
    "email_outbox",
  ]);
  assert.deepEqual(reviewedExactAclRelationNames(REVIEWED_PHASE_0064), [
    "email_outbox",
  ]);
  assert.deepEqual(reviewedExactAclRelationNames(REVIEWED_PHASE_0067), [
    "email_outbox",
  ]);
  assert.deepEqual(reviewedExactAclRelationNames(REVIEWED_PHASE_0068), [
    "email_outbox",
  ]);
  assert.deepEqual(reviewedExactAclRelationNames(REVIEWED_PHASE_0069), [
    "email_outbox",
    "mail_delivery_release_receipt",
  ]);

  const source = readFileSync(
    new URL("./bootstrap-database-roles.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
    "export async function verifyDatabaseRoleBootstrapState(",
  );
  const end = source.indexOf(
    "export async function runDatabaseRoleBootstrap(",
    start,
  );
  const verifier = source.slice(start, end);
  assert.match(verifier, /reviewedExactAclRelationNames\(canonicalPhase\)/u);
  assert.match(
    verifier,
    /to_regclass\('public\.email_outbox'\)[\s\S]*canonicalPhase !== null[\s\S]*outboxPresenceRow\.outbox_present !== true[\s\S]*await import\("\.\/verify-database-role-boundaries\.mjs"\)[\s\S]*verifyMailWorkerOutboxContract\(client, \{[\s\S]*requiresDispatchBinding:\s*canonicalPhase\?\.requiresWorkerContract \?\? false,[\s\S]*requiresProviderEvidence:\s*canonicalPhase\?\.requiresProviderEvidence \?\? false,[\s\S]*requiresReplayAuthority:\s*canonicalPhase\?\.requiresReplayAuthority \?\? false,[\s\S]*requiresProviderRequest:\s*canonicalPhase\?\.requiresGuardedDelivery \?\? false,[\s\S]*requiresGuardedDelivery:\s*canonicalPhase\?\.requiresGuardedDelivery \?\? false,/u,
  );
  assert.equal(
    verifier.match(/c\.relname <> all\(\$4::text\[\]\)/gu)?.length,
    2,
  );
  assert.match(
    verifier,
    /\[\s*postgresDatabase,[\s\S]*exactAclRelationNames,\s*\]/u,
  );
});

test("accepts only the bootstrap and exact five distinct restricted-role URLs", () => {
  const parsed = validateDatabaseRoleBoundaryUrls(validInput());
  assert.deepEqual(Object.keys(parsed), [
    "bootstrap",
    "app",
    "migrator",
    "worker",
    "ops",
    "backupReporter",
  ]);
  assert.equal(parsed.bootstrap.username, "legacy_bootstrap");
  assert.equal(parsed.app.username, "learncoding_app");
  assert.equal(parsed.backupReporter.username, "learncoding_backup_reporter");

  for (const mutate of [
    (input) => {
      input.databaseBootstrapUrl = input.databaseBootstrapUrl.replace(
        "legacy_bootstrap",
        "learncoding_owner",
      );
    },
    (input) => {
      input.databaseBootstrapUrl = input.databaseBootstrapUrl.replace(
        password("b"),
        password("a"),
      );
    },
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
    (input) => {
      input.databaseBackupReporterUrl = input.databaseOpsUrl.replace(
        "learncoding_ops",
        "learncoding_backup_reporter",
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

function makeClient(role, database, options, generation = 1) {
  const queries = [];
  const queryParameters = [];
  let delegated = false;
  let grantCatalogVersion = 0;
  let rewardRoutineAclState = options.rewardRoutineAclState ?? "canonical";
  let reviewedRoutineAclState = options.reviewedRoutineAclState ?? "canonical";
  let reviewedRoutineAclStateApplies =
    options.reviewedRoutineAclState !== undefined;
  const latestApplied =
    options.appliedMigrationIndex === undefined
      ? 67
      : options.appliedMigrationIndex;
  const activeReviewedPhase = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.find(
    ({ index }) => index === latestApplied,
  );
  const backupAuthorityPresent =
    options.backupAuthorityPresent ??
    (options.journalPresent !== false &&
      latestApplied !== null &&
      latestApplied >= 65 &&
      options.missingMigrationIndex !== 65);
  const runtimeCapabilityAppliedCount =
    options.runtimeCapabilityAppliedCount ??
    (options.journalPresent === false || latestApplied === null
      ? 0
      : Math.min(latestApplied + 1, REVIEWED_MIGRATION_LEDGER.length));
  const runtimeCapabilityAppliedCounts =
    options.runtimeCapabilityAppliedCounts ?? [runtimeCapabilityAppliedCount];
  const runtimeCapabilityReads = options.runtimeCapabilityReads ?? {
    credential: 0,
    ledger: 0,
  };
  let runtimeCapabilityFixture;
  const getRuntimeCapabilityFixture = () => {
    if (runtimeCapabilityFixture === undefined) {
      runtimeCapabilityFixture = makeDatabaseRuntimeCapabilityCatalogFixture();
      runtimeCapabilityFixture.foundationMode =
        runtimeCapabilityAppliedCount < REVIEWED_MIGRATION_LEDGER.length;
      options.runtimeCapabilityFixtureMutator?.(runtimeCapabilityFixture);
    }
    return runtimeCapabilityFixture;
  };
  const releaseArguments = [];
  return {
    queries,
    queryParameters,
    releaseArguments,
    release(destroy) {
      releaseArguments.push(destroy);
      options.eventLog?.push(
        `release:${role}:${generation}:${destroy === true ? "destroy" : "reuse"}`,
      );
      if (options.releaseFailureByRole?.has(role)) {
        throw options.releaseFailureByRole.get(role);
      }
    },
    async query(sql, parameters) {
      const normalized = String(sql).replace(/\s+/gu, " ").trim().toLowerCase();
      queries.push(normalized);
      queryParameters.push(parameters);
      if (normalized.includes("trusted_search_path")) {
        options.eventLog?.push(`search-path:${role}:${generation}`);
      } else if (normalized.startsWith("select pg_try_advisory_lock")) {
        options.eventLog?.push(`lock:${role}:${generation}`);
      } else if (normalized.startsWith("select pg_advisory_unlock")) {
        options.eventLog?.push(`unlock:${role}:${generation}`);
      } else if (
        normalized.includes(
          "verifier_database_runtime_credential_evidence_roles",
        )
      ) {
        options.eventLog?.push(`credential:${role}:${generation}`);
      } else if (
        normalized === "select current_user, session_user, current_database()"
      ) {
        options.eventLog?.push(`role-probe:${role}:${generation}`);
      }
      if (
        normalized.includes("do $codestead_reviewed_function_0$") &&
        activeReviewedPhase?.routines.every(({ signature }) =>
          normalized.includes(signature),
        )
      ) {
        reviewedRoutineAclState =
          options.reviewedRoutinePostRepairAclState ?? "canonical";
        reviewedRoutineAclStateApplies = true;
        rewardRoutineAclState = reviewedRoutineAclState;
        return { rows: [] };
      }
      if (
        normalized.includes("do $codestead_reviewed_function_0$") &&
        REVIEWED_REWARD_ROUTINES.every(({ signature }) =>
          normalized.includes(signature),
        )
      ) {
        rewardRoutineAclState = "canonical";
        return { rows: [] };
      }
      if (normalized.includes("trusted_search_path")) {
        return {
          rows: [
            {
              trusted_search_path:
                options.trustedSearchPath ?? "pg_catalog,pg_temp",
            },
          ],
        };
      }
      if (normalized.startsWith("select pg_try_advisory_lock")) {
        return { rows: [{ acquired: options.lockAvailable !== false }] };
      }
      if (normalized.startsWith("select pg_advisory_unlock")) {
        if (Object.hasOwn(options, "unlockFailure")) {
          throw options.unlockFailure;
        }
        return { rows: [{ released: true }] };
      }
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
      if (
        normalized.includes("authenticated_guarded_delivery_privileges_exact")
      ) {
        if (
          options.guardedSchemaResolutionDenied === true &&
          role === "learncoding_migrator"
        ) {
          throw Object.assign(new Error("redacted schema lookup rejection"), {
            code: "42501",
          });
        }
        return {
          rows: [
            {
              authenticated_guarded_delivery_privileges_exact:
                options.authenticatedGuardedDeliveryTamper !== true,
            },
          ],
        };
      }
      if (
        normalized.includes("verifier_capability_migration_journal_present")
      ) {
        return {
          rows: [
            {
              verifier_capability_migration_journal_present:
                options.journalPresent !== false,
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
      if (normalized.includes("reviewed_full_migration_journal_rows")) {
        const appliedCount =
          runtimeCapabilityAppliedCounts[
            Math.min(
              runtimeCapabilityReads.ledger,
              runtimeCapabilityAppliedCounts.length - 1,
            )
          ];
        runtimeCapabilityReads.ledger += 1;
        return {
          rows: REVIEWED_MIGRATION_LEDGER.slice(0, appliedCount).map(
            (entry, index) => ({
              id: String(index + 1),
              hash: entry.sqlSha256,
              created_at: String(entry.when),
            }),
          ),
        };
      }
      if (normalized.includes("verifier_database_runtime_")) {
        const result = databaseRuntimeCapabilityCatalogQueryResult(
          normalized,
          getRuntimeCapabilityFixture(),
        );
        if (result !== undefined) {
          if (
            normalized.includes(
              "verifier_database_runtime_credential_evidence_roles",
            )
          ) {
            runtimeCapabilityReads.credential += 1;
            const rows = structuredClone(result.rows);
            options.runtimeCapabilityCredentialRowsMutator?.({
              read: runtimeCapabilityReads.credential,
              rows,
            });
            return { rows };
          }
          return result;
        }
      }
      if (normalized.includes("backup_status_authority_present")) {
        return {
          rows: [
            {
              backup_status_authority_present: backupAuthorityPresent,
            },
          ],
        };
      }
      if (
        normalized.includes("'public.backup_status_mail_authorized(uuid)'") &&
        normalized.endsWith(") present")
      ) {
        return {
          rows: [{ present: backupAuthorityPresent }],
        };
      }
      if (
        normalized.includes("reviewed(migration_index, created_at)") &&
        normalized.includes("applied_hashes")
      ) {
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
              post_migration_provider_column_count:
                options.providerColumnCount ??
                (options.journalPresent === false ||
                latestApplied === null ||
                latestApplied < 66
                  ? 0
                  : 3),
              post_migration_provider_column_exact_count:
                options.providerColumnExactCount ??
                options.providerColumnCount ??
                (latestApplied !== null && latestApplied >= 66 ? 3 : 0),
              post_migration_replay_column_count:
                options.replayColumnCount ??
                (options.journalPresent === false ||
                latestApplied === null ||
                latestApplied < 67
                  ? 0
                  : 3),
              post_migration_replay_column_exact_count:
                options.replayColumnExactCount ??
                options.replayColumnCount ??
                (options.journalPresent === false ||
                latestApplied === null ||
                latestApplied < 67
                  ? 0
                  : 3),
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
              reviewed_provider_evidence_constraint_presence_exact:
                tamper !== "provider-constraint",
              reviewed_replay_authority_constraint_presence_exact:
                tamper !== "replay-constraint",
              reviewed_replay_authority_relation_presence_exact:
                tamper !== "replay-relation",
            },
          ],
        };
      }
      if (normalized.includes("effective_table_acl_exact")) {
        const targetRelation = parameters?.[0];
        const targeted =
          options.backupContractTamperRelation === undefined ||
          options.backupContractTamperRelation === targetRelation;
        const tamper = targeted ? options.backupContractTamper : undefined;
        if (tamper === "relation-missing") return { rows: [] };
        return {
          rows: [
            {
              owner_exact: tamper !== "table-owner",
              relation_kind_exact: true,
              persistence_exact: true,
              access_method_exact: true,
              replica_identity_exact: true,
              reloptions_exact: true,
              tablespace_exact: true,
              row_security_exact: true,
              forced_row_security_exact: true,
              columns_exact: tamper !== "table-columns",
              column_definitions_exact: tamper !== "table-definitions",
              constraints_exact: tamper !== "table-constraints",
              indexes_exact: tamper !== "table-indexes",
              effective_table_acl_exact: tamper !== "table-effective-acl",
              effective_column_acl_exact: tamper !== "column-effective-acl",
              direct_acl_exact: tamper !== "table-direct-acl",
            },
          ],
        };
      }
      if (normalized.includes("routine_kind_exact")) {
        const targetRoutine = parameters?.[0];
        const targeted =
          options.backupContractTamperSignature === undefined ||
          options.backupContractTamperSignature === targetRoutine;
        const tamper = targeted ? options.backupContractTamper : undefined;
        if (tamper === "routine-missing") return { rows: [] };
        return {
          rows: [
            {
              body_sha256_exact: tamper !== "routine-body",
              definition_sha256_exact: tamper !== "routine-definition",
              owner_exact: tamper !== "routine-owner",
              language_exact: true,
              routine_kind_exact: true,
              security_definer_exact: tamper !== "routine-security",
              configuration_exact: tamper !== "routine-config",
              volatility_exact: true,
              strict_exact: true,
              parallel_exact: true,
              leakproof_exact: true,
              argument_names_exact: true,
              argument_modes_exact: true,
              argument_types_exact: tamper !== "routine-arguments",
              input_argument_count_exact: true,
              argument_defaults_exact: true,
              return_type_exact: true,
              returns_set_exact: true,
              variadic_exact: true,
              cost_exact: tamper !== "routine-cost",
              rows_exact: true,
              support_exact: true,
              transform_types_exact: true,
              binary_exact: true,
              sql_body_exact: true,
              effective_execute_exact: tamper !== "routine-effective-acl",
              direct_acl_exact: tamper !== "routine-direct-acl",
            },
          ],
        };
      }
      if (normalized.includes("triggers_exact")) {
        if (
          options.restrictedGuardReadDenied === true &&
          role === "learncoding_ops" &&
          normalized.includes("backup_status_mail_admin_guard")
        ) {
          throw Object.assign(new Error("redacted protected guard rejection"), {
            code: "42501",
          });
        }
        return {
          rows: [
            {
              relations_present:
                options.backupContractTamper !== "trigger-relation",
              guard_state_exact: options.backupContractTamper !== "guard-state",
              triggers_exact: options.backupContractTamper !== "triggers",
            },
          ],
        };
      }
      if (normalized.includes("routine_direct_acl_exact")) {
        if (options.requiredRoutineMissing === true) return { rows: [] };
        const tamper = options.routineContractTamper;
        const targetRoutine = parameters?.[0];
        const rewardRoutine = REVIEWED_REWARD_ROUTINES.some(
          ({ signature }) => signature === targetRoutine,
        );
        const reviewedRoutine = activeReviewedPhase?.routines.find(
          ({ signature }) => signature === targetRoutine,
        );
        const expectedAllowedRoles = parameters?.[5] ?? [];
        const expectsCanonicalReviewedAcl =
          reviewedRoutine !== undefined &&
          expectedAllowedRoles.length === reviewedRoutine.allowedRoles.length &&
          expectedAllowedRoles.every(
            (roleName, index) =>
              roleName === reviewedRoutine.allowedRoles[index],
          );
        const expectsOwnerOnlyReviewedAcl =
          reviewedRoutine !== undefined && expectedAllowedRoles.length === 0;
        if (
          reviewedRoutine &&
          expectsCanonicalReviewedAcl &&
          options.reviewedRoutineOperationalFailure
        ) {
          throw options.reviewedRoutineOperationalFailure;
        }
        if (
          reviewedRoutine &&
          expectsOwnerOnlyReviewedAcl &&
          options.reviewedRoutineOwnerOnlyOperationalFailure
        ) {
          throw options.reviewedRoutineOwnerOnlyOperationalFailure;
        }
        if (rewardRoutine && options.rewardRoutineOperationalFailure) {
          throw options.rewardRoutineOperationalFailure;
        }

        const expectsOwnerOnlyRewardAcl = expectedAllowedRoles.length === 0;
        if (
          rewardRoutine &&
          expectsOwnerOnlyRewardAcl &&
          options.rewardRoutineOwnerOnlyOperationalFailure
        ) {
          throw options.rewardRoutineOwnerOnlyOperationalFailure;
        }
        const actualRewardAclState =
          rewardRoutineAclState === "mixed"
            ? targetRoutine === REVIEWED_REWARD_ROUTINES[0].signature
              ? "canonical"
              : "owner-only"
            : rewardRoutineAclState;
        const actualReviewedAclState = reviewedRoutineAclStateApplies
          ? reviewedRoutineAclState === "mixed"
            ? targetRoutine === activeReviewedPhase?.routines[0].signature
              ? "canonical"
              : "owner-only"
            : reviewedRoutineAclState === "raw-migration"
              ? rewardRoutine
                ? "owner-only"
                : "canonical"
              : reviewedRoutineAclState === "attempt-only-owner-only"
                ? targetRoutine === REVIEWED_REWARD_ROUTINES[0].signature
                  ? "owner-only"
                  : "canonical"
                : reviewedRoutineAclState === "mastery-only-owner-only"
                  ? targetRoutine === REVIEWED_REWARD_ROUTINES[1].signature
                    ? "owner-only"
                    : "canonical"
                  : reviewedRoutineAclState
          : rewardRoutine
            ? actualRewardAclState
            : "canonical";
        const rewardAclExact =
          !reviewedRoutine ||
          (actualReviewedAclState === "canonical" &&
            expectsCanonicalReviewedAcl) ||
          (actualReviewedAclState === "owner-only" &&
            expectsOwnerOnlyReviewedAcl);
        return {
          rows: [
            {
              body_sha256_exact:
                tamper !== "body" &&
                (!rewardRoutine || rewardRoutineAclState !== "body-drift"),
              owner_exact:
                tamper !== "owner" &&
                (!rewardRoutine || rewardRoutineAclState !== "owner-mismatch"),
              security_definer_exact: tamper !== "security-definer",
              configuration_exact:
                tamper !== "configuration" &&
                (!rewardRoutine || rewardRoutineAclState !== "config-drift"),
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
              definition_sha256_exact:
                tamper !== "definition" &&
                (!rewardRoutine ||
                  rewardRoutineAclState !== "definition-drift"),
              owner_execute_exact: tamper !== "owner-execute",
              effective_execute_exact:
                options.restoredNoAclState !== true &&
                tamper !== "effective-acl" &&
                rewardAclExact,
              routine_direct_acl_exact:
                options.restoredNoAclState !== true &&
                ![
                  "direct-acl",
                  "missing-acl",
                  "extra-acl",
                  "grantable-acl",
                ].includes(tamper) &&
                rewardAclExact,
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
              constraint_exact: tamper !== "constraint",
              deferrable_exact: tamper !== "deferrable",
              initially_deferred_exact: tamper !== "initially-deferred",
              constraint_catalog_exact: tamper !== "constraint-catalog",
              transition_tables_exact: tamper !== "transition-tables",
              reviewed_trigger_catalog_exact: tamper !== "catalog",
            },
          ],
        };
      }
      if (normalized.includes("guarded_delivery_catalog_phase_exact")) {
        const tamper = options.guardedDeliveryCatalogTamper;
        const row = {
          guarded_delivery_catalog_phase_exact: true,
          guarded_outbox_columns_exact: true,
          guarded_outbox_constraints_exact: true,
          receipt_relation_exact: true,
          receipt_columns_exact: true,
          receipt_constraints_exact: true,
          receipt_indexes_exact: true,
          receipt_foreign_keys_exact: true,
          receipt_relation_safety_exact: true,
        };
        if (typeof tamper === "string" && Object.hasOwn(row, tamper)) {
          row[tamper] = false;
        }
        return { rows: [row] };
      }
      if (normalized.includes("guarded_delivery_presence_exact")) {
        const tamper = options.guardedDeliveryAclTamper;
        const row = {
          guarded_delivery_presence_exact: true,
          outbox_runtime_table_direct_acl_exact: true,
          outbox_runtime_column_direct_acl_exact: true,
          outbox_runtime_effective_acl_exact: true,
          outbox_release_marker_writes_owner_only_exact: true,
          receipt_table_direct_acl_exact: true,
          receipt_column_direct_acl_exact: true,
          receipt_effective_acl_exact: true,
          runtime_membership_closure_exact: true,
        };
        if (options.restoredNoAclState === true) {
          for (const key of Object.keys(row)) row[key] = false;
        }
        if (typeof tamper === "string" && Object.hasOwn(row, tamper)) {
          row[tamper] = false;
        }
        return { rows: [row] };
      }
      if (normalized.includes("worker_column_direct_acl_exact")) {
        const tamper = options.workerContractTamper;
        const premature0067CheckObserved = (
          options.premature0067CheckConstraints ?? []
        ).some((constraintName) => normalized.includes(`'${constraintName}'`));
        return {
          rows: [
            {
              outbox_present_exact: tamper !== "table",
              outbox_owner_exact: tamper !== "owner",
              binding_columns_exact: tamper !== "binding-columns",
              provider_evidence_columns_exact:
                tamper !== "provider-evidence-columns",
              idempotency_authority_columns_exact: tamper !== "replay-columns",
              reviewed_0067_check_constraints_exact:
                !tamper?.startsWith("variables-constraint-") &&
                !tamper?.startsWith("recipient-constraint-") &&
                !premature0067CheckObserved,
              variables_object_constraint_exact: ![
                "variables-constraint-missing",
                "variables-constraint-expression",
                "variables-constraint-columns",
                "variables-constraint-type",
                "variables-constraint-validation",
                "variables-constraint-noinherit",
              ].includes(tamper),
              recipient_canonical_constraint_exact: ![
                "recipient-constraint-missing",
                "recipient-constraint-expression",
                "recipient-constraint-columns",
                "recipient-constraint-type",
                "recipient-constraint-validation",
                "recipient-constraint-noinherit",
              ].includes(tamper),
              dispatch_constraint_exact: ![
                "constraint",
                "constraint-always-true",
                "constraint-state-arm-removed",
                "constraint-unknown-version",
              ].includes(tamper),
              provider_evidence_constraint_exact: ![
                "provider-constraint",
                "provider-constraint-type",
                "provider-constraint-validation",
                "provider-constraint-hash",
                "provider-constraint-columns",
              ].includes(tamper),
              replay_authority_constraint_exact: ![
                "replay-constraint",
                "replay-constraint-type",
                "replay-constraint-validation",
                "replay-constraint-hash",
                "replay-constraint-columns",
              ].includes(tamper),
              worker_table_direct_acl_exact:
                options.restoredNoAclState !== true && tamper !== "table-acl",
              worker_column_direct_acl_exact:
                options.restoredNoAclState !== true &&
                !["column-acl", "one-column-grant"].includes(tamper),
              worker_effective_privileges_exact:
                options.restoredNoAclState !== true &&
                tamper !== "effective-acl",
            },
          ],
        };
      }
      if (normalized.includes("authority_column_acl_exact")) {
        const tamper = options.replayAuthorityTableTamper;
        return {
          rows: [
            {
              authority_relation_exact: tamper !== "relation",
              authority_relation_storage_exact:
                tamper !== "relation-persistence",
              authority_relation_rls_exact: ![
                "relation-rls",
                "relation-force-rls",
              ].includes(tamper),
              authority_constraint_set_exact: tamper !== "extra-constraint",
              authority_index_set_exact: tamper !== "extra-index",
              authority_primary_index_catalog_exact:
                !tamper?.startsWith("primary-index-"),
              authority_composite_index_catalog_exact:
                !tamper?.startsWith("composite-index-"),
              outbox_replay_lookup_index_catalog_exact:
                !tamper?.startsWith("lookup-index-"),
              persistent_default_acl_exact:
                options.restoredNoAclState !== true &&
                (tamper === "default-acl-additional-creator-complete-pair"
                  ? normalized.includes(
                      "additional_creator_default_acl_exact",
                    ) &&
                    normalized.includes(
                      "additional_creator_default_acl_rows",
                    ) &&
                    normalized.includes("default_acl_catalog_prerequisites")
                  : ![
                      "default-acl-additional-creator-drizzle-row",
                      "default-acl-additional-creator-function-only",
                      "default-acl-additional-creator-unrelated-schema-row",
                      "default-acl-additional-creator-public-row",
                      "default-acl-additional-creator-split-pair",
                      "default-acl-additional-creator-type-only",
                      "default-acl-missing-managed-grantee",
                      "default-acl-missing-owner-role",
                      "default-acl-missing-public-schema",
                      "default-acl-orphan-owner",
                      "default-acl-arbitrary-owner",
                      "default-acl",
                      "default-acl-arbitrary-grantee",
                      "default-acl-duplicate-entry",
                      "default-acl-duplicate-row",
                      "default-acl-empty-extra",
                      "default-acl-extra-owner-privilege",
                      "default-acl-global-sequence",
                      "default-acl-global-table",
                      "default-acl-grant-option",
                      "default-acl-pseudo-public-entry",
                      "default-acl-real-public-role",
                      "default-acl-harmless-global-function-owner",
                      "default-acl-harmless-global-type-owner",
                      "default-acl-missing-owner-global-function",
                      "default-acl-missing-owner-global-type",
                      "default-acl-missing-owner-public-sequence",
                      "default-acl-missing-owner-public-table",
                      "default-acl-missing-owner-public-type",
                      "default-acl-multiple-owner-tuples",
                      "default-acl-object-kind",
                      "default-acl-extra-row",
                      "default-acl-unexpected-owner-public-function",
                      "default-acl-unexpected-owner-drizzle-type",
                      "default-acl-unknown-schema-owner",
                      "default-acl-unknown-sequence-owner",
                      "default-acl-unknown-table-owner",
                      "default-acl-wrong-grantor",
                      "default-acl-wrong-privilege",
                    ].includes(tamper)),
              persistent_relation_grant_options_exact:
                tamper !== "relation-grant-option",
              persistent_column_acl_exact:
                options.restoredNoAclState !== true &&
                ![
                  "column-acl-unexpected",
                  "column-acl-missing",
                  "column-acl-wrong-grantor",
                  "column-acl-wrong-grantee",
                  "column-acl-grantable",
                ].includes(tamper),
              authority_owner_exact: tamper !== "owner",
              authority_columns_exact: !["columns", "extra-column"].includes(
                tamper,
              ),
              authority_primary_key_exact: tamper !== "primary-key",
              authority_checks_exact: ![
                "digest-check",
                "payload-check",
              ].includes(tamper),
              outbox_delivery_scope_exact: tamper !== "delivery-scope",
              reviewed_trigger_set_exact: tamper !== "extra-trigger",
              reviewed_routine_overloads_exact: tamper !== "routine-overload",
              authority_direct_acl_exact:
                options.restoredNoAclState !== true && tamper !== "direct-acl",
              authority_effective_acl_exact:
                options.restoredNoAclState !== true &&
                tamper !== "effective-acl",
              authority_column_acl_exact:
                options.restoredNoAclState !== true &&
                !["column-acl", "authority-column-acl"].includes(tamper),
              outbox_replay_lookup_index_exact: tamper !== "lookup-index",
              authority_composite_unique_exact: ![
                "unique-type",
                "unique-validation",
                "unique-deferrable",
                "unique-initially-deferred",
                "unique-noinherit",
                "unique-columns",
                "unique-index-nonunique",
                "unique-index-invalid",
                "unique-index-not-ready",
                "unique-index-partial",
                "unique-index-expression",
              ].includes(tamper),
              outbox_authority_foreign_key_exact: ![
                "foreign-key-type",
                "foreign-key-validation",
                "foreign-key-noinherit",
                "foreign-key-columns",
                "foreign-key-reference",
                "foreign-key-deferrable",
                "foreign-key-initially-deferred",
                "foreign-key-match",
                "foreign-key-update",
                "foreign-key-delete",
              ].includes(tamper),
              outbox_authority_trigger_order_exact:
                tamper !== "foreign-key-trigger-order",
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
      if (normalized.includes("effective_table_acl_exact")) {
        const tamper = options.backupContractTamper;
        return {
          rows: [
            {
              owner_exact: tamper !== "table-owner",
              relation_kind_exact: true,
              persistence_exact: true,
              access_method_exact: true,
              replica_identity_exact: true,
              reloptions_exact: true,
              tablespace_exact: true,
              row_security_exact: true,
              forced_row_security_exact: true,
              columns_exact: tamper !== "table-columns",
              column_definitions_exact: tamper !== "table-definitions",
              constraints_exact: tamper !== "table-constraints",
              indexes_exact: tamper !== "table-indexes",
              effective_table_acl_exact: tamper !== "table-effective-acl",
              effective_column_acl_exact: tamper !== "column-effective-acl",
              direct_acl_exact: tamper !== "table-direct-acl",
            },
          ],
        };
      }
      if (normalized.includes("routine_kind_exact")) {
        const tamper = options.backupContractTamper;
        return {
          rows: [
            {
              body_sha256_exact: tamper !== "routine-body",
              definition_sha256_exact: tamper !== "routine-definition",
              owner_exact: tamper !== "routine-owner",
              language_exact: true,
              routine_kind_exact: true,
              security_definer_exact: tamper !== "routine-security",
              configuration_exact: tamper !== "routine-config",
              volatility_exact: true,
              strict_exact: true,
              parallel_exact: true,
              leakproof_exact: true,
              argument_names_exact: true,
              argument_modes_exact: true,
              argument_types_exact: tamper !== "routine-arguments",
              input_argument_count_exact: true,
              argument_defaults_exact: true,
              return_type_exact: true,
              returns_set_exact: true,
              variadic_exact: true,
              cost_exact: tamper !== "routine-cost",
              rows_exact: true,
              support_exact: true,
              transform_types_exact: true,
              binary_exact: true,
              sql_body_exact: true,
              effective_execute_exact: tamper !== "routine-effective-acl",
              direct_acl_exact: tamper !== "routine-direct-acl",
            },
          ],
        };
      }
      if (normalized.includes("triggers_exact")) {
        return {
          rows: [
            {
              relations_present: true,
              guard_state_exact: options.backupContractTamper !== "guard-state",
              triggers_exact: options.backupContractTamper !== "triggers",
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
        const selectsSharedCrudTable = [
          "select",
          "insert",
          "update",
          "delete",
        ].every((privilege) =>
          normalized.includes(
            `has_table_privilege( role_name, c.oid, '${privilege}' )`,
          ),
        );
        return {
          rows: [
            {
              schema_name: "public",
              object_name:
                options.protectedTableSortsFirst === true &&
                !selectsSharedCrudTable
                  ? "backup_status_mail_admin_guard"
                  : "sample",
              object_oid: 16_384,
              column_name: "id",
            },
          ],
        };
      }
      if (
        normalized.startsWith("explain (format json)") &&
        normalized.includes('"backup_status_mail_admin_guard"')
      ) {
        throw Object.assign(new Error("redacted protected table rejection"), {
          code: "42501",
        });
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
        if (Object.hasOwn(options, "grantProbeFailure")) {
          throw options.grantProbeFailure;
        }
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
  const clientGenerations = new Map();
  const events = [];
  const pools = [];
  const runtimeCapabilityReads = { credential: 0, ledger: 0 };
  const clientOptions = {
    ...options,
    appliedMigrationIndex: options.appliedMigrationIndex ?? 69,
    eventLog: events,
    runtimeCapabilityReads,
    runtimeCapabilityAppliedCount: options.runtimeCapabilityAppliedCount ?? 68,
  };
  return {
    clientGenerations,
    clients,
    events,
    pools,
    factory({ role, database }) {
      let generation = 0;
      const pool = {
        ended: false,
        async connect() {
          generation += 1;
          events.push(`connect:${role}:${generation}`);
          if (
            options.connectFailureRole === role
            && (
              options.connectFailureGeneration === undefined
              || options.connectFailureGeneration === generation
            )
          ) {
            if (Object.hasOwn(options, "connectFailure")) {
              throw options.connectFailure;
            }
            throw new Error("redacted connection failure");
          }
          const deferredConnection =
            options.connectDeferredByRoleGeneration?.get(
              `${role}:${generation}`,
            );
          if (deferredConnection !== undefined) {
            await deferredConnection;
          }
          const client = makeClient(
            role,
            database,
            clientOptions,
            generation,
          );
          clients.set(role, client);
          const generations = clientGenerations.get(role) ?? [];
          generations.push(client);
          clientGenerations.set(role, generations);
          return client;
        },
        async end() {
          this.ended = true;
          if (options.poolEndFailureByRole?.has(role)) {
            throw options.poolEndFailureByRole.get(role);
          }
        },
      };
      pools.push(pool);
      return pool;
    },
  };
}

const backupStatusAuthorityTamperCases = Object.freeze([
  Object.freeze({
    backupContractTamper: "table-owner",
    backupContractTamperRelation: "public.backup_status_mail_authority",
  }),
  Object.freeze({
    backupContractTamper: "table-constraints",
    backupContractTamperRelation: "public.backup_status_mail_admin_guard",
  }),
  Object.freeze({
    backupContractTamper: "table-direct-acl",
    backupContractTamperRelation: "public.backup_status_mail_authority",
  }),
  Object.freeze({
    backupContractTamper: "column-effective-acl",
    backupContractTamperRelation: "public.backup_status_mail_admin_guard",
  }),
  Object.freeze({
    backupContractTamper: "routine-owner",
    backupContractTamperSignature:
      "public.enqueue_backup_status_mail_authority(text,text)",
  }),
  Object.freeze({
    backupContractTamper: "routine-security",
    backupContractTamperSignature: "public.backup_status_mail_authorized(uuid)",
  }),
  Object.freeze({
    backupContractTamper: "routine-config",
    backupContractTamperSignature:
      "public.lock_backup_status_mail_admin_authority()",
  }),
  Object.freeze({
    backupContractTamper: "routine-body",
    backupContractTamperSignature:
      "public.reject_backup_status_mail_authority_mutation()",
  }),
  Object.freeze({
    backupContractTamper: "routine-definition",
    backupContractTamperSignature:
      "public.enqueue_backup_status_mail_authority(text,text)",
  }),
  Object.freeze({
    backupContractTamper: "routine-effective-acl",
    backupContractTamperSignature: "public.backup_status_mail_authorized(uuid)",
  }),
  Object.freeze({
    backupContractTamper: "routine-direct-acl",
    backupContractTamperSignature:
      "public.enqueue_backup_status_mail_authority(text,text)",
  }),
  Object.freeze({ backupContractTamper: "guard-state" }),
  Object.freeze({ backupContractTamper: "triggers" }),
]);

test("fails closed on phase-65 authority tamper before and after repair", async () => {
  const exact = makeClient("learncoding_ops", "learncoding", {});
  assert.equal(
    await verifyBackupStatusAuthorityBeforeRepair(exact, REVIEWED_PHASE_0065),
    true,
  );
  assert.equal(
    await verifyBackupStatusAuthorityAfterRepair(exact, REVIEWED_PHASE_0065),
    true,
  );

  for (const options of backupStatusAuthorityTamperCases) {
    await assert.rejects(
      verifyBackupStatusAuthorityBeforeRepair(
        makeClient("learncoding_ops", "learncoding", options),
        REVIEWED_PHASE_0065,
      ),
      /backup-status-authority-pre-repair/u,
    );
    await assert.rejects(
      verifyBackupStatusAuthorityAfterRepair(
        makeClient("learncoding_ops", "learncoding", options),
        REVIEWED_PHASE_0065,
      ),
      /backup-status-authority-post-repair/u,
    );
  }
});

test("rejects reviewed post-migration tamper before privilege repair", async () => {
  const preMigration = makeClient("learncoding_ops", "learncoding", {
    journalPresent: false,
    bindingColumnCount: 0,
    bindingColumnExactCount: 0,
    providerColumnCount: 0,
    providerColumnExactCount: 0,
  });
  assert.equal(
    await verifyPostMigrationReviewedContractsBeforeReconciliation(
      preMigration,
      null,
    ),
    0,
  );

  const exact = makeClient("learncoding_ops", "learncoding", {});
  assert.equal(
    await verifyPostMigrationReviewedContractsBeforeReconciliation(
      exact,
      REVIEWED_PHASE_0067,
    ),
    1,
  );
  assert.equal(
    exact.queries.filter((query) => query.includes("effective_table_acl_exact"))
      .length,
    2,
  );
  assert.equal(
    exact.queries.filter((query) => query.includes("routine_kind_exact"))
      .length,
    4,
  );
  assert.equal(
    exact.queries.filter((query) => query.includes("triggers_exact")).length,
    1,
  );
  const exactReplayQueryIndex = exact.queries.findIndex((query) =>
    query.includes("authority_constraint_set_exact"),
  );
  assert.notEqual(exactReplayQueryIndex, -1);
  assert.deepEqual(
    exact.queryParameters[exactReplayQueryIndex]?.[65],
    REVIEWED_REPLAY_AUTHORITY_RELATIONAL_CONTRACT.triggerRelations,
  );
  assert.deepEqual(
    exact.queryParameters[exactReplayQueryIndex]?.[71],
    MAIL_WORKER_OUTBOX_PRE_REQUEST_UPDATE_COLUMNS,
  );
  assert.equal(exact.queryParameters[exactReplayQueryIndex]?.[72], 1);
  assert.deepEqual(
    exact.queryParameters[exactReplayQueryIndex]?.[73],
    MAIL_APP_OUTBOX_INSERT_COLUMNS,
  );
  assert.deepEqual(exact.queryParameters[exactReplayQueryIndex]?.[74], []);
  assert.deepEqual(
    JSON.parse(exact.queryParameters[exactReplayQueryIndex]?.[66]),
    REVIEWED_REPLAY_AUTHORITY_RELATIONAL_CONTRACT.triggers.map(
      ({ relation, name }) => ({
        relation,
        name,
      }),
    ),
  );

  for (const appliedMigrationIndex of [62, 63]) {
    const priorPhase = makeClient("learncoding_ops", "learncoding", {
      appliedMigrationIndex,
      bindingColumnCount: 0,
      bindingColumnExactCount: 0,
      providerColumnCount: 0,
      providerColumnExactCount: 0,
    });
    assert.equal(
      await verifyPostMigrationReviewedContractsBeforeReconciliation(
        priorPhase,
        reviewedPhase(appliedMigrationIndex),
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
      [
        "provider_correlation_version",
        "provider_evidence_version",
        "provider_evidence_sha256",
      ],
      0,
      "public.email_outbox",
      "email_outbox_provider_correlation_evidence_valid",
      "c",
      true,
      "2594dd57e4115fe9296d03888d8d1771b98e90725bce7e0d66c753eb1f0dba82",
      reviewedApplicationConstraint(
        "email_outbox_provider_correlation_evidence_valid",
      ).columns,
      false,
      [
        "idempotency_authority_version",
        "idempotency_authority_sha256",
        "idempotency_original_payload_sha256",
      ],
      0,
      "public.email_outbox",
      "email_outbox_idempotency_authority_valid",
      "c",
      true,
      JSON.stringify(REPLAY_AUTHORITY_CONSTRAINT_HASHES_BY_POSTGRES_MAJOR),
      reviewedApplicationConstraint("email_outbox_idempotency_authority_valid")
        .columns,
      false,
      "[]",
    ]);
  }

  const phase0064 = makeClient("learncoding_ops", "learncoding", {
    appliedMigrationIndex: 64,
    bindingColumnCount: 2,
    bindingColumnExactCount: 2,
  });
  assert.equal(
    await verifyPostMigrationReviewedContractsBeforeReconciliation(
      phase0064,
      REVIEWED_PHASE_0064,
    ),
    1,
  );
  assert.equal(
    phase0064.queries.some((query) =>
      query.includes("effective_table_acl_exact"),
    ),
    false,
  );
  assert.equal(
    phase0064.queries.some((query) => query.includes("routine_kind_exact")),
    false,
  );

  for (const options of [
    { journalHashTamper: 62 },
    { journalHashTamper: 65 },
    { missingMigrationIndex: 62 },
    { missingMigrationIndex: 63 },
    { appliedMigrationIndex: 63, bindingColumnCount: 2 },
    { appliedMigrationIndex: 65, bindingColumnCount: 0 },
    {
      appliedMigrationIndex: 64,
      backupAuthorityPresent: true,
    },
    { backupAuthorityPresent: false },
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
    {
      journalPresent: false,
      bindingColumnCount: 0,
      bindingColumnExactCount: 0,
      providerColumnCount: 0,
      providerColumnExactCount: 0,
      footprintContractTamper: "provider-constraint",
    },
  ]) {
    await assert.rejects(
      verifyPostMigrationReviewedContractsBeforeReconciliation(
        makeClient("learncoding_ops", "learncoding", options),
        reviewedPhaseForOptions(options),
      ),
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
    rolesAuthenticated: 5,
    positiveChecks: 16,
    negativeChecks: 19,
  });
  assert.equal(
    harness.pools.every((pool) => pool.ended),
    true,
  );
  assert.deepEqual(
    Object.fromEntries(
      [...harness.clientGenerations].map(([role, clients]) => [
        role,
        clients.length,
      ]),
    ),
    {
      legacy_bootstrap: 1,
      learncoding_app: 1,
      learncoding_backup_reporter: 1,
      learncoding_migrator: 2,
      learncoding_ops: 1,
      learncoding_worker: 1,
    },
  );
  const lockIndex = harness.events.indexOf("lock:legacy_bootstrap:1");
  const migratorReleaseIndex = harness.events.indexOf(
    "release:learncoding_migrator:1:destroy",
  );
  const postLockAuthentication = [
    "connect:learncoding_migrator:2",
    "connect:learncoding_app:1",
    "connect:learncoding_worker:1",
    "connect:learncoding_ops:1",
    "connect:learncoding_backup_reporter:1",
  ].map((event) => harness.events.indexOf(event));
  const postLockSearchPaths = [
    "search-path:learncoding_migrator:2",
    "search-path:learncoding_app:1",
    "search-path:learncoding_worker:1",
    "search-path:learncoding_ops:1",
    "search-path:learncoding_backup_reporter:1",
  ].map((event) => harness.events.indexOf(event));
  assert.ok(lockIndex >= 0);
  assert.ok(migratorReleaseIndex > lockIndex);
  assert.ok(postLockAuthentication.every((index) => index > migratorReleaseIndex));
  assert.ok(postLockSearchPaths.every((index) => index > migratorReleaseIndex));
  const firstCredentialEvidence = harness.events.indexOf(
    "credential:legacy_bootstrap:1",
  );
  assert.ok(firstCredentialEvidence > Math.max(...postLockSearchPaths));
  assert.equal(
    harness.events.some((event) => event === "lock:learncoding_ops:1"),
    false,
  );
  assert.deepEqual(
    harness.clientGenerations.get("learncoding_migrator")[0].releaseArguments,
    [true],
  );
  assert.equal(harness.clients.has("legacy_bootstrap"), true);
  assert.equal(
    harness.clients
      .get("legacy_bootstrap")
      .queries.filter((query) =>
        query.includes("verifier_database_runtime_credential_evidence_roles"),
      ).length,
    2,
  );
  assert.equal(
    harness.clients
      .get("learncoding_migrator")
      .queries.filter((query) =>
        query.includes(
          "verifier_database_runtime_capability_foundation_authority",
        ),
      ).length,
    2,
  );
  const foundationQueries = harness.clients.get("learncoding_migrator").queries;
  assert.equal(
    foundationQueries.some((query) =>
      query.includes("verifier_database_runtime_capability_objects"),
    ),
    false,
  );
  assert.equal(
    foundationQueries.some((query) =>
      query.includes("verifier_database_runtime_capability_columns"),
    ),
    false,
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
  assert.equal(
    harness.clients
      .get("learncoding_backup_reporter")
      .queries.includes("set role learncoding_owner"),
    true,
  );
});

test("rejects credentials that fail only during post-lock authentication", async () => {
  const harness = makePoolHarness({
    connectFailureRole: "learncoding_migrator",
    connectFailureGeneration: 2,
  });
  await assert.rejects(
    verifyDatabaseRoleBoundaries({
      ...validInput(),
      poolFactory: harness.factory,
      lockTimeoutMs: 50,
    }),
    /redacted connection failure/u,
  );
  assert.equal(
    harness.events.includes("release:learncoding_migrator:1:destroy"),
    true,
  );
  assert.equal(
    harness.events.some((event) => event.startsWith("role-probe:")),
    false,
  );
  const failedAuthentication = harness.events.indexOf(
    "connect:learncoding_migrator:2",
  );
  const unlock = harness.events.indexOf("unlock:legacy_bootstrap:1");
  const bootstrapRelease = harness.events.indexOf(
    "release:legacy_bootstrap:1:reuse",
  );
  assert.ok(unlock > failedAuthentication);
  assert.ok(bootstrapRelease > unlock);
  assert.equal(harness.pools.every((pool) => pool.ended), true);
});

test("bounds post-lock authentication and destroys a checkout that resolves late", async () => {
  let releaseConnection = () => undefined;
  const delayedConnection = new Promise((resolve) => {
    releaseConnection = resolve;
  });
  const harness = makePoolHarness({
    connectDeferredByRoleGeneration: new Map([
      ["learncoding_worker:1", delayedConnection],
    ]),
  });
  setTimeout(releaseConnection, 20);
  await assert.rejects(
    verifyDatabaseRoleBoundaries({
      ...validInput(),
      authenticationTimeoutMs: 10,
      poolFactory: harness.factory,
      lockTimeoutMs: 50,
    }),
    {
      name: "DatabaseRoleBoundaryError",
      message: /post-lock-authentication-timeout/u,
    },
  );
  assert.equal(
    harness.events.some((event) => event.startsWith("role-probe:")),
    false,
  );
  assert.equal(harness.events.includes("unlock:legacy_bootstrap:1"), true);
  assert.deepEqual(
    harness.clientGenerations.get("learncoding_worker")[0].releaseArguments,
    [true],
  );
  assert.equal(harness.pools.every((pool) => pool.ended), true);
});

test("preserves the authentication timeout and reports late checkout cleanup failure", async () => {
  let releaseConnection = () => undefined;
  const delayedConnection = new Promise((resolve) => {
    releaseConnection = resolve;
  });
  const lateReleaseFailure = new Error("late checkout release failure");
  const harness = makePoolHarness({
    connectDeferredByRoleGeneration: new Map([
      ["learncoding_worker:1", delayedConnection],
    ]),
    releaseFailureByRole: new Map([
      ["learncoding_worker", lateReleaseFailure],
    ]),
  });
  setTimeout(releaseConnection, 20);
  const outcome = await captureRejection(() =>
    verifyDatabaseRoleBoundaries({
      ...validInput(),
      authenticationTimeoutMs: 10,
      poolFactory: harness.factory,
      lockTimeoutMs: 50,
    })
  );
  assert.equal(outcome.rejected, true);
  assert.ok(outcome.reason instanceof DatabaseRoleBoundaryError);
  assert.match(outcome.reason.message, /post-lock-authentication-timeout/u);
  assert.ok(outcome.reason.cause instanceof AggregateError);
  assert.deepEqual(outcome.reason.cause.errors, [lateReleaseFailure]);
  assert.equal(
    harness.events.some((event) => event.startsWith("role-probe:")),
    false,
  );
  assert.equal(harness.pools.every((pool) => pool.ended), true);
});

test("executes the exact current capability catalog twice under a sealed lock", async () => {
  const harness = makePoolHarness({
    runtimeCapabilityAppliedCount: REVIEWED_MIGRATION_LEDGER.length,
  });
  const result = await verifyDatabaseRoleBoundaries({
    ...validInput(),
    poolFactory: harness.factory,
    lockTimeoutMs: 50,
  });
  assert.deepEqual(result, {
    rolesAuthenticated: 5,
    positiveChecks: 16,
    negativeChecks: 19,
  });
  const allMigratorQueries = harness.clientGenerations
    .get("learncoding_migrator")
    .flatMap((client) => client.queries);
  assert.equal(
    allMigratorQueries.filter((sql) =>
      sql.includes("verifier_database_runtime_capability_context"),
    ).length,
    2,
  );
  assert.equal(
    allMigratorQueries.filter((sql) =>
      sql.includes("verifier_database_runtime_capability_default_acls"),
    ).length,
    2,
  );
  assert.equal(
    harness.clients
      .get("legacy_bootstrap")
      .queries.filter((sql) =>
        sql.includes("verifier_database_runtime_credential_evidence_roles"),
      ).length,
    2,
  );
  assert.equal(
    allMigratorQueries.filter(
      (sql) =>
        sql === "begin transaction isolation level repeatable read read only",
    ).length,
    3,
  );
  assert.equal(
    allMigratorQueries.filter((sql) =>
      sql.includes("verifier_capability_migration_journal_present"),
    ).length,
    3,
  );
});

test("rejects a bootstrap identity inside the managed role namespace before pool checkout", async () => {
  for (const postgresUser of [
    "learncoding_it",
    "learncoding_ui",
    "learncoding_restore",
    "learncoding_unreviewed",
  ]) {
    let poolCalls = 0;
    await assert.rejects(
      verifyDatabaseRoleBoundaries({
        ...validInput(),
        postgresUser,
        poolFactory() {
          poolCalls += 1;
          throw new Error("pool must not be created");
        },
      }),
    );
    assert.equal(poolCalls, 0);
  }
});

test("rejects future capability requests before pool checkout", async () => {
  for (const databaseRuntimeCapabilityPhase of [
    "0070-expand-prepare",
    "0071-contracted",
    "unknown",
  ]) {
    let poolCalls = 0;
    await assert.rejects(
      verifyDatabaseRoleBoundaries({
        ...validInput(),
        databaseRuntimeCapabilityPhase,
        poolFactory() {
          poolCalls += 1;
          throw new Error("pool must not be created");
        },
      }),
      { name: "DatabaseRuntimeCapabilityPhaseError" },
    );
    assert.equal(poolCalls, 0);
  }
});

test("rejects capability phase drift and current catalog drift before role probes", async () => {
  for (const runtimeCapabilityAppliedCounts of [
    [68, 69],
    [68, 68, 69],
  ]) {
    const samePhaseDrift = makePoolHarness({
      runtimeCapabilityAppliedCounts,
    });

    await assert.rejects(
      verifyDatabaseRoleBoundaries({
        ...validInput(),
        poolFactory: samePhaseDrift.factory,
        lockTimeoutMs: 50,
      }),
      {
        name: "VerifierDatabaseRuntimeCapabilityError",
        message: /capability-phase/u,
      },
    );
    assert.equal(
      samePhaseDrift.clients
        .get("learncoding_ops")
        .queries.some((sql) => sql.includes("from pg_class c")),
      false,
    );
  }

  const phaseDrift = makePoolHarness({
    runtimeCapabilityAppliedCounts: [
      REVIEWED_MIGRATION_LEDGER.length,
      REVIEWED_MIGRATION_LEDGER.length - 1,
    ],
  });
  await assert.rejects(
    verifyDatabaseRoleBoundaries({
      ...validInput(),
      poolFactory: phaseDrift.factory,
      lockTimeoutMs: 50,
    }),
    { name: "VerifierDatabaseRuntimeCapabilityError" },
  );

  const catalogDrift = makePoolHarness({
    runtimeCapabilityAppliedCount: REVIEWED_MIGRATION_LEDGER.length,
    runtimeCapabilityFixtureMutator(fixture) {
      fixture.roleRows.push({
        ...fixture.roleRows.at(-1),
        role_oid: "99991",
        role_name: "learncoding_unreviewed",
      });
    },
  });
  await assert.rejects(
    verifyDatabaseRoleBoundaries({
      ...validInput(),
      poolFactory: catalogDrift.factory,
      lockTimeoutMs: 50,
    }),
    { name: "VerifierDatabaseRuntimeCapabilityError" },
  );
  assert.equal(
    catalogDrift.clients
      .get("learncoding_ops")
      .queries.some((sql) => sql.includes("from pg_class c")),
    false,
  );
});

test("rejects valid locked-to-final credential drift before a second catalog scan", async () => {
  const harness = makePoolHarness({
    runtimeCapabilityCredentialRowsMutator({ read, rows }) {
      if (read !== 2) return;
      const app = rows.find((row) => row.role_name === "learncoding_app");
      assert.ok(app);
      app.role_oid = "99991";
    },
  });
  await assert.rejects(
    verifyDatabaseRoleBoundaries({
      ...validInput(),
      poolFactory: harness.factory,
      lockTimeoutMs: 50,
    }),
    {
      name: "DatabaseRoleBoundaryError",
      message: /final-capability-credential-drift/u,
    },
  );
  const bootstrapQueries = harness.clients.get("legacy_bootstrap").queries;
  assert.equal(
    bootstrapQueries.filter((query) =>
      query.includes("verifier_database_runtime_credential_evidence_roles"),
    ).length,
    2,
  );
  const migratorQueries = harness.clients.get("learncoding_migrator").queries;
  assert.equal(
    migratorQueries.filter((query) =>
      query.includes(
        "verifier_database_runtime_capability_foundation_authority",
      ),
    ).length,
    1,
  );
  assert.equal(harness.pools.every((pool) => pool.ended), true);
});

test("rejects hostile foundation authority before restricted-role probes", async () => {
  const harness = makePoolHarness({
    runtimeCapabilityFixtureMutator(fixture) {
      const index = fixture.foundationAuthorityRows.findIndex(
        (row) =>
          row.scope_kind === "database"
          && row.grantee_name === "learncoding_worker"
          && row.privilege_type === "CONNECT",
      );
      assert.notEqual(index, -1);
      fixture.foundationAuthorityRows.splice(index, 1);
    },
  });
  await assert.rejects(
    verifyDatabaseRoleBoundaries({
      ...validInput(),
      poolFactory: harness.factory,
      lockTimeoutMs: 50,
    }),
    { name: "VerifierDatabaseRuntimeCapabilityError" },
  );
  assert.equal(
    harness.clients
      .get("learncoding_app")
      .queries.some((query) => query.startsWith("select has_database_privilege")),
    false,
  );
  assert.equal(harness.pools.every((pool) => pool.ended), true);
});

test("preserves the exact verifier rejection when cleanup succeeds", async () => {
  for (const primaryFailure of [
    new Error("verifier primary Error"),
    "verifier-primary-primitive",
    undefined,
  ]) {
    const harness = makePoolHarness({
      connectFailureRole: "learncoding_app",
      connectFailure: primaryFailure,
    });
    const outcome = await captureRejection(() =>
      verifyDatabaseRoleBoundaries({
        ...validInput(),
        poolFactory: harness.factory,
        lockTimeoutMs: 50,
      }),
    );
    assert.equal(outcome.rejected, true);
    assert.equal(outcome.reason, primaryFailure);
    assert.equal(
      harness.pools.every((pool) => pool.ended),
      true,
    );
  }
});

test("keeps a mutable verifier Error outward and attaches cleanup failures", async () => {
  const originalCause = new Error("original verifier cause");
  const primaryFailure = new Error("verifier primary");
  Object.defineProperty(primaryFailure, "cause", {
    value: originalCause,
    configurable: true,
    writable: true,
  });
  const cleanupFailure = new Error("verifier pool cleanup");
  const harness = makePoolHarness({
    connectFailureRole: "learncoding_app",
    connectFailure: primaryFailure,
    poolEndFailureByRole: new Map([["learncoding_app", cleanupFailure]]),
  });

  const outcome = await captureRejection(() =>
    verifyDatabaseRoleBoundaries({
      ...validInput(),
      poolFactory: harness.factory,
      lockTimeoutMs: 50,
    }),
  );

  assert.equal(outcome.rejected, true);
  assert.equal(outcome.reason, primaryFailure);
  assert.ok(primaryFailure.cause instanceof AggregateError);
  assert.deepEqual(primaryFailure.cause.errors, [cleanupFailure]);
  assert.equal(primaryFailure.cause.cause, originalCause);
});

test("aggregates falsey and non-Error verifier primaries with cleanup failures", async () => {
  for (const primaryFailure of [
    false,
    "verifier-primary-primitive",
    undefined,
  ]) {
    const cleanupFailure = new Error("verifier pool cleanup");
    const harness = makePoolHarness({
      connectFailureRole: "learncoding_app",
      connectFailure: primaryFailure,
      poolEndFailureByRole: new Map([["learncoding_app", cleanupFailure]]),
    });
    const outcome = await captureRejection(() =>
      verifyDatabaseRoleBoundaries({
        ...validInput(),
        poolFactory: harness.factory,
        lockTimeoutMs: 50,
      }),
    );

    assert.equal(outcome.rejected, true);
    assert.ok(outcome.reason instanceof AggregateError);
    assert.deepEqual(outcome.reason.errors, [primaryFailure, cleanupFailure]);
    assert.equal(outcome.reason.cause, primaryFailure);
  }
});

test("does not mutate a frozen verifier Error or its cause", async () => {
  const originalCause = Object.freeze(new Error("frozen verifier cause"));
  const primaryFailure = Object.freeze(
    new Error("frozen verifier primary", { cause: originalCause }),
  );
  const cleanupFailure = new Error("verifier pool cleanup");
  const harness = makePoolHarness({
    connectFailureRole: "learncoding_app",
    connectFailure: primaryFailure,
    poolEndFailureByRole: new Map([["learncoding_app", cleanupFailure]]),
  });

  const outcome = await captureRejection(() =>
    verifyDatabaseRoleBoundaries({
      ...validInput(),
      poolFactory: harness.factory,
      lockTimeoutMs: 50,
    }),
  );

  assert.equal(outcome.rejected, true);
  assert.ok(outcome.reason instanceof AggregateError);
  assert.deepEqual(outcome.reason.errors, [primaryFailure, cleanupFailure]);
  assert.equal(outcome.reason.cause, primaryFailure);
  assert.equal(primaryFailure.cause, originalCause);
});

test("rejects with an exact sole falsey or primitive verifier cleanup failure", async () => {
  for (const cleanupFailure of [undefined, false, "cleanup-primitive"]) {
    const harness = makePoolHarness({
      poolEndFailureByRole: new Map([["learncoding_app", cleanupFailure]]),
    });
    const outcome = await captureRejection(() =>
      verifyDatabaseRoleBoundaries({
        ...validInput(),
        poolFactory: harness.factory,
        lockTimeoutMs: 50,
      }),
    );

    assert.equal(outcome.rejected, true);
    assert.equal(outcome.reason, cleanupFailure);
    assert.equal(
      harness.pools.every((pool) => pool.ended),
      true,
    );
  }
});

test("retains every verifier cleanup failure in execution order", async () => {
  const unlockFailure = undefined;
  const backupReleaseFailure = false;
  const workerPoolFailure = new Error("worker pool cleanup");
  const appReleaseFailure = "app-release-cleanup-primitive";
  const harness = makePoolHarness({
    unlockFailure,
    releaseFailureByRole: new Map([
      ["learncoding_backup_reporter", backupReleaseFailure],
      ["learncoding_app", appReleaseFailure],
    ]),
    poolEndFailureByRole: new Map([["learncoding_worker", workerPoolFailure]]),
  });

  const outcome = await captureRejection(() =>
    verifyDatabaseRoleBoundaries({
      ...validInput(),
      poolFactory: harness.factory,
      lockTimeoutMs: 50,
    }),
  );

  assert.equal(outcome.rejected, true);
  assert.ok(outcome.reason instanceof AggregateError);
  assert.deepEqual(outcome.reason.errors, [
    unlockFailure,
    backupReleaseFailure,
    workerPoolFailure,
    appReleaseFailure,
  ]);
  assert.equal(outcome.reason.cause, unlockFailure);
  assert.equal(
    harness.pools.every((pool) => pool.ended),
    true,
  );
  for (const client of harness.clients.values()) {
    assert.deepEqual(client.releaseArguments, [true]);
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
    rolesAuthenticated: 5,
    positiveChecks: 106,
    negativeChecks: 29,
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
  const reporterQueries = harness.clients.get(
    "learncoding_backup_reporter",
  ).queries;
  assert.equal(
    reporterQueries.some((sql) => sql.startsWith("explain (format json)")),
    false,
  );
});

test("discovers only a table with shared runtime CRUD authority", async () => {
  const harness = makePoolHarness({ protectedTableSortsFirst: true });
  await verifyDatabaseRoleBoundaries({
    ...validInput(),
    poolFactory: harness.factory,
    lockTimeoutMs: 50,
    requireApplicationObjects: true,
  });

  for (const role of [
    "learncoding_app",
    "learncoding_worker",
    "learncoding_ops",
  ]) {
    const queries = harness.clients.get(role).queries;
    assert.equal(
      queries.some((sql) => sql.includes('"backup_status_mail_admin_guard"')),
      false,
    );
    assert.equal(
      queries.some((sql) => sql.includes('"sample"')),
      true,
    );
  }
});

test("boundary verification never reads the protected backup guard", async () => {
  const harness = makePoolHarness({ restrictedGuardReadDenied: true });
  await verifyDatabaseRoleBoundaries({
    ...validInput(),
    poolFactory: harness.factory,
    lockTimeoutMs: 50,
    requireApplicationObjects: true,
  });
  assert.equal(
    harness.clients
      .get("learncoding_ops")
      .queries.some((sql) => sql.includes("backup_status_mail_admin_guard")),
    false,
  );
});

test("authenticates guarded-delivery privileges only with schema usage", async () => {
  const verified = makePoolHarness({ guardedSchemaResolutionDenied: true });
  await verifyDatabaseRoleBoundaries({
    ...validInput(),
    poolFactory: verified.factory,
    lockTimeoutMs: 50,
    requireApplicationObjects: true,
  });
  for (const [role, client] of verified.clients.entries()) {
    assert.equal(
      client.queries.some((query) =>
        query.includes("authenticated_guarded_delivery_privileges_exact"),
      ),
      !["legacy_bootstrap", "learncoding_migrator"].includes(role),
    );
  }
  const workerProbe = verified.clients
    .get("learncoding_worker")
    .queries.find((query) =>
      query.includes("authenticated_guarded_delivery_privileges_exact"),
    );
  assert.match(
    workerProbe,
    /current_user = 'learncoding_worker'\s+and privilege\.privilege_type = 'update'\s+and attribute\.attname = any\(array\[\s*'provider_request_body_sha256',\s*'provider_request_body_length'/u,
  );
  await assert.rejects(
    verifyDatabaseRoleBoundaries({
      ...validInput(),
      poolFactory: makePoolHarness({
        authenticatedGuardedDeliveryTamper: true,
      }).factory,
      lockTimeoutMs: 50,
      requireApplicationObjects: true,
    }),
    DatabaseRoleBoundaryError,
  );
});
test("requires the exact reviewed 0062 through 0069 routine contracts in application-object mode", async () => {
  const verified = makePoolHarness();
  const result = await verifyDatabaseRoleBoundaries({
    ...validInput(),
    poolFactory: verified.factory,
    lockTimeoutMs: 50,
    requireApplicationObjects: true,
  });

  assert.deepEqual(result, {
    rolesAuthenticated: 5,
    positiveChecks: 106,
    negativeChecks: 29,
  });
  const routineQueries = verified.clients
    .get("learncoding_ops")
    .queries.filter((sql) => sql.includes("routine_direct_acl_exact"));
  assert.equal(routineQueries.length, REVIEWED_PHASE_0069.routines.length);
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
  assert.doesNotMatch(routineQueries[0], /server_version_num|\$29::jsonb/iu);
  assert.doesNotMatch(routineQueries[0], /pg_catalog\.md5/iu);
  const routineQueryIndex = verified.clients
    .get("learncoding_ops")
    .queries.indexOf(routineQueries[0]);
  const restrictedRoles = [
    "learncoding_app",
    "learncoding_migrator",
    "learncoding_worker",
    "learncoding_ops",
    "learncoding_backup_reporter",
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
    REVIEWED_PHASE_0069.routines.map((routine) => [
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

test("preserves a reviewed catalog failure through top-level cleanup", async () => {
  const tampered = makePoolHarness({
    workerContractTamper: "table-acl",
  });

  await assert.rejects(
    verifyDatabaseRoleBoundaries({
      ...validInput(),
      poolFactory: tampered.factory,
      lockTimeoutMs: 50,
      requireApplicationObjects: true,
    }),
    (error) =>
      error instanceof DatabaseRoleBoundaryError &&
      error.message.includes(
        "mail-worker-outbox-contract:worker_table_direct_acl_exact",
      ),
    "the top-level verifier must retain the exact failed catalog invariant",
  );
  assert.equal(
    tampered.pools.every((pool) => pool.ended),
    true,
  );
});

test("freezes both 0067 email_outbox CHECK manifests", () => {
  for (const expected of [
    {
      name: "email_outbox_variables_object_valid",
      columns: ["variables"],
      reviewedSqlExpressionSha256:
        "474e75e58049be566e89f5e17641091aebefb946928e5ed97987db96bb7d7e33",
      normalizedExpressionSha256:
        "9a0d45d473dbe0925bc515e3061a94f53cc9c4684e843565c7ee64946b2521ca",
    },
    {
      name: "email_outbox_recipient_canonical_valid",
      columns: ["to_email"],
      reviewedSqlExpressionSha256:
        "5a2426a2aafcdec419fc4d534d8558d82110e0759c1445a2c917bbf2ec27b447",
      normalizedExpressionSha256:
        "02ba45407386c19b742347bf29e39fa5a5d3d09b8cd8ca74a31bf1c1aeae8a0b",
    },
  ]) {
    const constraint = REVIEWED_APPLICATION_CONSTRAINTS.find(
      ({ name }) => name === expected.name,
    );
    assert.deepEqual(
      constraint
        ? {
            relation: constraint.relation,
            relationOwner: constraint.relationOwner,
            type: constraint.type,
            validated: constraint.validated,
            noInherit: constraint.noInherit,
            columns: constraint.columns,
            reviewedSqlExpressionSha256: constraint.reviewedSqlExpressionSha256,
            normalizedExpressionSha256: constraint.normalizedExpressionSha256,
          }
        : null,
      {
        relation: "public.email_outbox",
        relationOwner: "learncoding_owner",
        type: "c",
        validated: true,
        noInherit: false,
        columns: expected.columns,
        reviewedSqlExpressionSha256: expected.reviewedSqlExpressionSha256,
        normalizedExpressionSha256: expected.normalizedExpressionSha256,
      },
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
    rolesAuthenticated: 5,
    positiveChecks: 106,
    negativeChecks: 29,
  });

  const opsClient = verified.clients.get("learncoding_ops");
  const triggerQueries = opsClient.queries.filter((sql) =>
    sql.includes("reviewed_trigger_catalog_exact"),
  );
  assert.equal(triggerQueries.length, REVIEWED_PHASE_0069.triggers.length);
  assert.match(triggerQueries[0], /pg_catalog\.pg_trigger/iu);
  assert.match(triggerQueries[0], /tgqual/iu);
  assert.match(triggerQueries[0], /tgnargs/iu);
  assert.match(triggerQueries[0], /tgattr/iu);
  assert.match(triggerQueries[0], /octet_length/iu);
  const workerQuery = opsClient.queries.find((sql) =>
    sql.includes("worker_column_direct_acl_exact"),
  );
  const workerQueryIndex = opsClient.queries.indexOf(workerQuery);
  const reviewed0067Checks = JSON.parse(
    opsClient.queryParameters[workerQueryIndex]?.[30],
  );
  assert.deepEqual(
    reviewed0067Checks.map(
      ({
        constraint_name,
        constraint_type,
        validated,
        no_inherit,
        normalized_expression_sha256,
        columns,
      }) => ({
        constraint_name,
        constraint_type,
        validated,
        no_inherit,
        normalized_expression_sha256,
        columns,
      }),
    ),
    [
      {
        constraint_name: "email_outbox_variables_object_valid",
        constraint_type: "c",
        validated: true,
        no_inherit: false,
        normalized_expression_sha256:
          "9a0d45d473dbe0925bc515e3061a94f53cc9c4684e843565c7ee64946b2521ca",
        columns: ["variables"],
      },
      {
        constraint_name: "email_outbox_recipient_canonical_valid",
        constraint_type: "c",
        validated: true,
        no_inherit: false,
        normalized_expression_sha256:
          "02ba45407386c19b742347bf29e39fa5a5d3d09b8cd8ca74a31bf1c1aeae8a0b",
        columns: ["to_email"],
      },
    ],
  );
  assert.match(workerQuery, /jsonb_to_recordset/iu);
  assert.match(workerQuery, /except all/iu);
  assert.equal(
    opsClient.queryParameters[workerQueryIndex]?.[4],
    "email_outbox_dispatch_binding_valid",
  );
  assert.equal(
    opsClient.queryParameters[workerQueryIndex]?.[7],
    reviewedApplicationConstraint("email_outbox_dispatch_binding_valid")
      .normalizedExpression,
  );
  assert.doesNotMatch(workerQuery, /\slike\s/iu);
  assert.match(workerQuery, /pg_catalog\.aclexplode/iu);
  assert.deepEqual(opsClient.queryParameters[workerQueryIndex]?.[2], [
    "dispatch_binding_version",
    "dispatch_binding_sha256",
  ]);
  assert.deepEqual(opsClient.queryParameters[workerQueryIndex]?.[12], [
    "provider_correlation_version",
    "provider_evidence_version",
    "provider_evidence_sha256",
  ]);
  assert.equal(
    opsClient.queryParameters[workerQueryIndex]?.[15],
    "email_outbox_provider_correlation_evidence_valid",
  );
  assert.equal(
    opsClient.queryParameters[workerQueryIndex]?.[18],
    reviewedApplicationConstraint(
      "email_outbox_provider_correlation_evidence_valid",
    ).normalizedExpressionSha256,
  );
  assert.deepEqual(
    opsClient.queryParameters[workerQueryIndex]?.[19],
    reviewedApplicationConstraint(
      "email_outbox_provider_correlation_evidence_valid",
    ).columns,
  );
  assert.equal(opsClient.queryParameters[workerQueryIndex]?.[20], true);
  assert.deepEqual(opsClient.queryParameters[workerQueryIndex]?.slice(21, 30), [
    [
      "idempotency_authority_version",
      "idempotency_authority_sha256",
      "idempotency_original_payload_sha256",
    ],
    3,
    "public.email_outbox",
    "email_outbox_idempotency_authority_valid",
    "c",
    true,
    JSON.stringify(REPLAY_AUTHORITY_CONSTRAINT_HASHES_BY_POSTGRES_MAJOR),
    reviewedApplicationConstraint("email_outbox_idempotency_authority_valid")
      .columns,
    true,
  ]);
  assert.match(workerQuery, /pg_catalog\.sha256/iu);
  assert.match(workerQuery, /pg_catalog\.pg_get_expr/iu);

  for (const triggerContractTamper of [
    "relation",
    "function",
    "enabled",
    "type",
    "predicate",
    "arguments",
    "watched-columns",
    "constraint",
    "deferrable",
    "initially-deferred",
    "constraint-catalog",
    "transition-tables",
    "catalog",
  ]) {
    const tampered = makeClient("learncoding_ops", "learncoding", {
      triggerContractTamper,
    });
    await assert.rejects(
      verifyReviewedApplicationTriggers(tampered, REVIEWED_PHASE_0069.triggers),
      DatabaseRoleBoundaryError,
    );
  }

  await assert.rejects(
    verifyMailWorkerOutboxContract(
      makeClient("learncoding_ops", "learncoding", {
        workerContractTamper: "table-acl",
      }),
      {
        requiresDispatchBinding: true,
        requiresProviderEvidence: true,
      },
    ),
    (error) =>
      error instanceof DatabaseRoleBoundaryError &&
      error.message.includes("mail-worker-outbox-contract") &&
      error.message.includes("worker_table_direct_acl_exact"),
    "the aggregate worker contract must identify its failed invariant",
  );

  await assert.rejects(
    verifyMailWorkerOutboxContract(
      makeClient("learncoding_ops", "learncoding", {
        trustedSearchPath: "public,pg_catalog",
      }),
      {
        requiresDispatchBinding: true,
        requiresProviderEvidence: true,
      },
    ),
    (error) =>
      error instanceof DatabaseRoleBoundaryError &&
      error.message.includes("trusted-search-path"),
    "the worker contract must reject an untrusted deparse search_path",
  );

  for (const workerContractTamper of [
    "variables-constraint-missing",
    "variables-constraint-expression",
    "variables-constraint-columns",
    "variables-constraint-type",
    "variables-constraint-validation",
    "variables-constraint-noinherit",
    "recipient-constraint-missing",
    "recipient-constraint-expression",
    "recipient-constraint-columns",
    "recipient-constraint-type",
    "recipient-constraint-validation",
    "recipient-constraint-noinherit",
    "table",
    "owner",
    "binding-columns",
    "constraint-always-true",
    "constraint-state-arm-removed",
    "constraint-unknown-version",
    "constraint",
    "provider-evidence-columns",
    "provider-constraint",
    "provider-constraint-type",
    "provider-constraint-validation",
    "provider-constraint-hash",
    "provider-constraint-columns",
    "replay-columns",
    "replay-constraint",
    "replay-constraint-type",
    "replay-constraint-validation",
    "replay-constraint-hash",
    "replay-constraint-columns",
    "table-acl",
    "column-acl",
    "effective-acl",
  ]) {
    const tampered = makeClient("learncoding_ops", "learncoding", {
      workerContractTamper,
    });
    await assert.rejects(
      verifyMailWorkerOutboxContract(tampered, {
        requiresDispatchBinding: true,
        requiresProviderEvidence: true,
      }),
      DatabaseRoleBoundaryError,
    );
  }

  for (const replayAuthorityTableTamper of [
    "relation",
    "owner",
    "columns",
    "extra-column",
    "primary-key",
    "digest-check",
    "payload-check",
    "delivery-scope",
    "extra-trigger",
    "routine-overload",
    "direct-acl",
    "effective-acl",
    "column-acl",
    "lookup-index",
    "unique-type",
    "unique-validation",
    "unique-deferrable",
    "unique-initially-deferred",
    "unique-noinherit",
    "unique-columns",
    "unique-index-nonunique",
    "unique-index-invalid",
    "unique-index-not-ready",
    "unique-index-partial",
    "unique-index-expression",
    "foreign-key-type",
    "foreign-key-validation",
    "foreign-key-noinherit",
    "foreign-key-columns",
    "foreign-key-reference",
    "foreign-key-deferrable",
    "foreign-key-initially-deferred",
    "foreign-key-match",
    "foreign-key-update",
    "foreign-key-delete",
    "foreign-key-trigger-order",
  ]) {
    const tampered = makeClient("learncoding_ops", "learncoding", {
      replayAuthorityTableTamper,
    });
    await assert.rejects(
      verifyMailWorkerOutboxContract(tampered, {
        requiresDispatchBinding: true,
        requiresProviderEvidence: true,
        requiresReplayAuthority: true,
      }),
      DatabaseRoleBoundaryError,
    );
  }

  assert.deepEqual(
    await verifyReviewedMailAuthorityCatalogContracts(
      makeClient("learncoding_ops", "learncoding", {}),
      REVIEWED_PHASE_0067,
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

test("verifies a frozen historical mail-authority catalog phase explicitly", async () => {
  const phase0064 = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.find(
    ({ index }) => index === 64,
  );
  assert.ok(phase0064);
  const client = makeClient("learncoding_ops", "learncoding", {});

  assert.deepEqual(
    await verifyReviewedMailAuthorityCatalogContracts(client, phase0064),
    {
      routinesVerified: phase0064.routines.length,
      triggersVerified: phase0064.triggers.length,
      workerContractsVerified: 1,
      totalVerified: phase0064.routines.length + phase0064.triggers.length + 1,
    },
  );
  assert.equal(
    client.queries.filter((query) => query.includes("routine_direct_acl_exact"))
      .length,
    phase0064.routines.length,
  );
});

test("restored-no-ACL structure accepts ACL-only restore state while strict verification rejects it", async () => {
  const strictClient = makeClient("learncoding_ops", "learncoding", {
    appliedMigrationIndex: 69,
    restoredNoAclState: true,
  });
  await assert.rejects(
    verifyReviewedMailAuthorityCatalogContracts(
      strictClient,
      REVIEWED_PHASE_0069,
    ),
    (error) =>
      error instanceof DatabaseRoleBoundaryError &&
      error.message.includes("effective_execute_exact") &&
      error.message.includes("routine_direct_acl_exact"),
  );

  const restoredClient = makeClient("learncoding_ops", "learncoding", {
    appliedMigrationIndex: 69,
    restoredNoAclState: true,
  });
  assert.deepEqual(
    await verifyRestoredNoAclMailAuthorityStructure(
      restoredClient,
      REVIEWED_PHASE_0069,
    ),
    {
      routinesVerified: REVIEWED_PHASE_0069.routines.length,
      triggersVerified: REVIEWED_PHASE_0069.triggers.length,
      workerContractsVerified: 1,
      totalVerified:
        REVIEWED_PHASE_0069.routines.length +
        REVIEWED_PHASE_0069.triggers.length +
        1,
    },
  );
  assert.equal(
    restoredClient.queries.some((query) =>
      query.includes("persistent_relation_grant_options_exact"),
    ),
    true,
  );
  assert.equal(
    restoredClient.queries.some((query) =>
      query.includes("guarded_delivery_catalog_phase_exact"),
    ),
    true,
  );
  assert.equal(
    restoredClient.queries.some((query) =>
      query.includes("guarded_delivery_presence_exact"),
    ),
    false,
  );
});

test("restored-no-ACL structure rejects representative structural tamper", async () => {
  for (const [label, options, mismatch] of [
    ["routine body", { routineContractTamper: "body" }, "body_sha256_exact"],
    ["trigger", { triggerContractTamper: "enabled" }, "reviewed-trigger:"],
    [
      "relation persistence",
      { replayAuthorityTableTamper: "relation-persistence" },
      "authority_relation_storage_exact",
    ],
    [
      "row-level security",
      { replayAuthorityTableTamper: "relation-rls" },
      "authority_relation_rls_exact",
    ],
    [
      "constraint",
      { workerContractTamper: "constraint" },
      "dispatch_constraint_exact",
    ],
    [
      "index",
      { replayAuthorityTableTamper: "primary-index-key" },
      "authority_primary_index_catalog_exact",
    ],
    [
      "guarded catalog index",
      { guardedDeliveryCatalogTamper: "receipt_indexes_exact" },
      "receipt_indexes_exact",
    ],
    [
      "persistent relation grant options",
      { replayAuthorityTableTamper: "relation-grant-option" },
      "persistent_relation_grant_options_exact",
    ],
  ]) {
    await assert.rejects(
      verifyRestoredNoAclMailAuthorityStructure(
        makeClient("learncoding_ops", "learncoding", {
          appliedMigrationIndex: 69,
          restoredNoAclState: true,
          ...options,
        }),
        REVIEWED_PHASE_0069,
      ),
      (error) =>
        error instanceof DatabaseRoleBoundaryError &&
        error.message.includes(mismatch),
      label,
    );
  }
});

test("restored-no-ACL structure accepts only a canonical frozen phase", async () => {
  const client = {
    calls: 0,
    async query() {
      this.calls += 1;
      throw new Error("phase validation must happen before catalog access");
    },
  };
  await assert.rejects(
    verifyRestoredNoAclMailAuthorityStructure(
      client,
      Object.freeze({ ...REVIEWED_PHASE_0069 }),
    ),
    /reviewed-mail-authority-catalog-phase-contract/u,
  );
  assert.equal(client.calls, 0);
});
test("rejects Phase A replay-authority relation and catalog-footprint tampering", async () => {
  for (const replayAuthorityTableTamper of [
    "relation-persistence",
    "relation-rls",
    "relation-force-rls",
    "extra-constraint",
    "extra-index",
  ]) {
    const tampered = makeClient("learncoding_ops", "learncoding", {
      replayAuthorityTableTamper,
    });
    await assert.rejects(
      verifyMailWorkerOutboxContract(tampered, {
        requiresDispatchBinding: true,
        requiresProviderEvidence: true,
        requiresReplayAuthority: true,
      }),
      DatabaseRoleBoundaryError,
      replayAuthorityTableTamper,
    );
  }
});

test("rejects Phase A2 exact PK, composite, and lookup index tampering", async () => {
  const indexProperties = [
    "kind",
    "persistence",
    "namespace",
    "access-method",
    "state",
    "key",
    "opclass",
    "collation",
    "indoption",
    "include",
    "expression",
    "predicate",
    "linkage",
  ];
  for (const indexKind of ["primary", "composite", "lookup"]) {
    for (const property of indexProperties) {
      const replayAuthorityTableTamper = `${indexKind}-index-${property}`;
      const tampered = makeClient("learncoding_ops", "learncoding", {
        replayAuthorityTableTamper,
      });
      await assert.rejects(
        verifyMailWorkerOutboxContract(tampered, {
          requiresDispatchBinding: true,
          requiresProviderEvidence: true,
          requiresReplayAuthority: true,
        }),
        DatabaseRoleBoundaryError,
        replayAuthorityTableTamper,
      );
    }
  }
});

test("rejects Phase B persistent default ACL inventory drift", async () => {
  const completePair = makeClient("learncoding_ops", "learncoding", {
    replayAuthorityTableTamper: "default-acl-additional-creator-complete-pair",
  });
  await assert.doesNotReject(
    verifyMailWorkerOutboxContract(completePair, {
      requiresDispatchBinding: true,
      requiresProviderEvidence: true,
      requiresReplayAuthority: true,
    }),
    "a complete exact global f+T pair for one additional creator",
  );

  for (const replayAuthorityTableTamper of [
    "default-acl",
    "default-acl-additional-creator-drizzle-row",
    "default-acl-additional-creator-function-only",
    "default-acl-additional-creator-unrelated-schema-row",
    "default-acl-additional-creator-public-row",
    "default-acl-additional-creator-split-pair",
    "default-acl-additional-creator-type-only",
    "default-acl-missing-managed-grantee",
    "default-acl-missing-owner-role",
    "default-acl-missing-public-schema",
    "default-acl-orphan-owner",
    "default-acl-arbitrary-owner",
    "default-acl-arbitrary-grantee",
    "default-acl-duplicate-entry",
    "default-acl-duplicate-row",
    "default-acl-empty-extra",
    "default-acl-extra-owner-privilege",
    "default-acl-global-sequence",
    "default-acl-global-table",
    "default-acl-grant-option",
    "default-acl-pseudo-public-entry",
    "default-acl-real-public-role",
    "default-acl-harmless-global-function-owner",
    "default-acl-harmless-global-type-owner",
    "default-acl-missing-owner-global-function",
    "default-acl-missing-owner-global-type",
    "default-acl-missing-owner-public-sequence",
    "default-acl-missing-owner-public-table",
    "default-acl-missing-owner-public-type",
    "default-acl-multiple-owner-tuples",
    "default-acl-object-kind",
    "default-acl-extra-row",
    "default-acl-unexpected-owner-public-function",
    "default-acl-unexpected-owner-drizzle-type",
    "default-acl-unknown-schema-owner",
    "default-acl-unknown-sequence-owner",
    "default-acl-unknown-table-owner",
    "default-acl-wrong-grantor",
    "default-acl-wrong-privilege",
  ]) {
    const tampered = makeClient("learncoding_ops", "learncoding", {
      replayAuthorityTableTamper,
    });
    await assert.rejects(
      verifyMailWorkerOutboxContract(tampered, {
        requiresDispatchBinding: true,
        requiresProviderEvidence: true,
        requiresReplayAuthority: true,
      }),
      DatabaseRoleBoundaryError,
      replayAuthorityTableTamper,
    );
  }

  const exact = makeClient("learncoding_ops", "learncoding", {});
  await verifyMailWorkerOutboxContract(exact, {
    requiresDispatchBinding: true,
    requiresProviderEvidence: true,
    requiresReplayAuthority: true,
  });
  const catalogQuery = exact.queries.find((query) =>
    query.includes("persistent_default_acl_exact"),
  );
  const defaultAclStart = catalogQuery.indexOf("with owner_role as");
  const defaultAclEnd = catalogQuery.indexOf(
    ") persistent_default_acl_exact",
    defaultAclStart,
  );
  assert.ok(defaultAclStart >= 0 && defaultAclEnd > defaultAclStart);
  const defaultAclQuery = catalogQuery.slice(defaultAclStart, defaultAclEnd);
  assert.match(
    defaultAclQuery,
    /with owner_role as[\s\S]*?default_acl_rows_raw[\s\S]*?from pg_catalog[.]pg_default_acl default_acl[\s\S]*?left join pg_catalog[.]pg_namespace default_namespace[\s\S]*?managed_default_acl_creators[\s\S]*?select distinct raw_row[.]owner_oid[\s\S]*?raw_row[.]namespace_oid = 0[\s\S]*?raw_row[.]namespace_name in [(]'public', 'drizzle'[)][\s\S]*?managed_default_acl_rows[\s\S]*?join managed_default_acl_creators/iu,
  );
  assert.match(
    defaultAclQuery,
    /managed_default_acl_rows[\s\S]*?select raw_row[.]owner_oid[\s\S]*?raw_row[.]owner_name[\s\S]*?raw_row[.]namespace_oid[\s\S]*?raw_row[.]object_type[\s\S]*?raw_row[.]acl[\s\S]*?from default_acl_rows_raw raw_row[\s\S]*?join managed_default_acl_creators/iu,
  );
  const managedRowsStart = defaultAclQuery.indexOf(
    "), managed_default_acl_rows",
  );
  const managedRowsEnd = defaultAclQuery.indexOf(
    "), managed_default_acl_entries",
    managedRowsStart,
  );
  assert.ok(managedRowsStart >= 0 && managedRowsEnd > managedRowsStart);
  const managedRowsQuery = defaultAclQuery.slice(
    managedRowsStart,
    managedRowsEnd,
  );
  assert.doesNotMatch(managedRowsQuery, /\bwhere\b/iu);
  assert.match(
    defaultAclQuery,
    /managed_default_acl_entries[\s\S]*?pg_catalog[.]aclexplode[(][\s\S]*?managed_row[.]acl/iu,
  );
  assert.match(defaultAclQuery, /public_namespace as/iu);
  assert.match(defaultAclQuery, /managed_grantee_roles as/iu);
  assert.match(defaultAclQuery, /default_acl_catalog_prerequisites/iu);
  assert.match(
    defaultAclQuery,
    /owner_role_count = 1[\s\S]*?public_namespace_count = 1[\s\S]*?managed_grantee_role_count = 3[\s\S]*?managed_owner_references_exact/iu,
  );
  assert.match(defaultAclQuery, /managed_row[.]owner_name is null/iu);
  assert.match(defaultAclQuery, /expected_owner_default_acl_rows/iu);
  for (const [objectType, privilegeType] of [
    ["f", "execute"],
    ["t", "usage"],
  ]) {
    assert.match(
      catalogQuery,
      new RegExp(
        `0::oid[\\s\\S]*?'${objectType}'::text[\\s\\S]*?'${privilegeType}'::text`,
        "iu",
      ),
      `global ${objectType} owner-only default ACL entry`,
    );
  }
  assert.match(defaultAclQuery, /expected_owner_default_acl_entries/iu);
  for (const objectType of ["r", "s", "t"]) {
    assert.match(
      catalogQuery,
      new RegExp(`'public'::text, '${objectType}'::text`, "iu"),
      `public ${objectType} required default ACL row`,
    );
  }
  assert.match(
    defaultAclQuery,
    /managed_grantee_roles[\s\S]*?rolname = any[(]array\[[\s\S]*?'learncoding_app'[\s\S]*?'learncoding_worker'[\s\S]*?'learncoding_ops'/iu,
  );
  assert.match(defaultAclQuery, /additional_creator_default_acl_rows/iu);
  assert.match(defaultAclQuery, /additional_creator_default_acl_exact/iu);
  assert.match(
    defaultAclQuery,
    /pg_catalog[.]count[(][*][)] = 2[\s\S]*?object_type = 'f'[\s\S]*?object_type = 't'/iu,
  );
  assert.match(
    defaultAclQuery,
    /entry[.]grantor_oid = additional_row[.]owner_oid[\s\S]*?entry[.]grantee_oid = additional_row[.]owner_oid/iu,
  );
  assert.match(
    defaultAclQuery,
    /entry[.]privilege_type = case entry[.]object_type[\s\S]*?when 'f' then 'execute'[\s\S]*?when 't' then 'usage'/iu,
  );
  assert.match(defaultAclQuery, /not entry[.]is_grantable/iu);
  assert.match(defaultAclQuery, /group by additional_row[.]owner_oid/iu);
  assert.equal([...defaultAclQuery.matchAll(/\bexcept all\b/giu)].length, 4);
  assert.match(defaultAclQuery, /access[.]grantee = 0 is_public/iu);
  assert.match(defaultAclQuery, /additional_row[.]owner_name <> 'public'/iu);
  assert.match(defaultAclQuery, /not additional[.]owner_name_exact/iu);
  assert.doesNotMatch(defaultAclQuery, /pg_get_userbyid[(][^)]*grantee/iu);
  assert.doesNotMatch(defaultAclQuery, /permitted_extra_default_acl_rows/iu);
  assert.match(
    defaultAclQuery,
    /select [(][\s\S]*?owner_role_count = 1[\s\S]*?from default_acl_catalog_prerequisites[\s\S]*?[)] and not exists [(][\s\S]*?expected_owner_default_acl_rows[\s\S]*?[)] and not exists [(][\s\S]*?expected_owner_default_acl_entries[\s\S]*?[)] and not exists [(][\s\S]*?where not additional[.]owner_name_exact[\s\S]*?or not additional[.]rows_exact[\s\S]*?or not additional[.]entries_exact/iu,
  );

  const bootstrapSource = readFileSync(
    new URL("./bootstrap-database-roles.mjs", import.meta.url),
    "utf8",
  );
  const inventoryStart = bootstrapSource.indexOf(
    "async function loadOwnershipInventory",
  );
  const inventoryEnd = bootstrapSource.indexOf(
    "async function createAndResetRoles",
    inventoryStart,
  );
  assert.ok(inventoryStart >= 0 && inventoryEnd > inventoryStart);
  const inventorySource = bootstrapSource.slice(inventoryStart, inventoryEnd);
  const schemaInventoryStart = inventorySource.indexOf(
    "select n.nspname name, pg_get_userbyid(n.nspowner) owner",
  );
  const schemaInventoryEnd = inventorySource.indexOf(
    "order by n.nspname",
    schemaInventoryStart,
  );
  assert.ok(
    schemaInventoryStart >= 0 && schemaInventoryEnd > schemaInventoryStart,
  );
  const schemaInventorySource = inventorySource.slice(
    schemaInventoryStart,
    schemaInventoryEnd,
  );
  for (const systemSchema of [
    "'pg_catalog'",
    "'information_schema'",
    "'pg_toast'",
  ]) {
    assert.match(schemaInventorySource, new RegExp(systemSchema, "u"));
  }
  assert.match(schemaInventorySource, /n[.]nspname not like 'pg_temp_%'/u);
  assert.match(
    schemaInventorySource,
    /n[.]nspname not like 'pg_toast_temp_%'/u,
  );
  assert.doesNotMatch(schemaInventorySource, /nspowner[)] in/iu);
  const defaultAclInventoryStart = inventorySource.indexOf(
    "from pg_default_acl a",
  );
  const defaultAclInventoryEnd = inventorySource.indexOf(
    "order by 1, 2, 3, 4, 5, 6",
    defaultAclInventoryStart,
  );
  assert.ok(
    defaultAclInventoryStart >= 0 &&
      defaultAclInventoryEnd > defaultAclInventoryStart,
  );
  const defaultAclInventorySource = inventorySource.slice(
    defaultAclInventoryStart,
    defaultAclInventoryEnd,
  );
  assert.match(
    defaultAclInventorySource,
    /from pg_default_acl a[\s\S]*?left join pg_namespace n[\s\S]*?left join lateral aclexplode[(]a[.]defaclacl[)] privilege on true/iu,
  );
  assert.doesNotMatch(defaultAclInventorySource, /\bwhere\b/iu);

  const runStart = bootstrapSource.indexOf(
    "export async function runDatabaseRoleBootstrap(options)",
  );
  const loadInventory = bootstrapSource.indexOf(
    "const inventory = await loadOwnershipInventory",
    runStart,
  );
  const validateInventory = bootstrapSource.indexOf(
    "validateOwnershipInventory(inventory)",
    loadInventory,
  );
  const resetRoles = bootstrapSource.indexOf(
    "await createAndResetRoles(client)",
    validateInventory,
  );
  assert.ok(
    runStart >= 0 &&
      loadInventory > runStart &&
      validateInventory > loadInventory &&
      resetRoles > validateInventory,
  );
});

test("rejects Phase B grant options on any managed relation", async () => {
  const tampered = makeClient("learncoding_ops", "learncoding", {
    replayAuthorityTableTamper: "relation-grant-option",
  });
  await assert.rejects(
    verifyMailWorkerOutboxContract(tampered, {
      requiresDispatchBinding: true,
      requiresProviderEvidence: true,
      requiresReplayAuthority: true,
    }),
    DatabaseRoleBoundaryError,
    "relation-grant-option",
  );
});

test("rejects Phase B exact column ACL manifest drift", async () => {
  for (const replayAuthorityTableTamper of [
    "column-acl-unexpected",
    "column-acl-missing",
    "column-acl-wrong-grantor",
    "column-acl-wrong-grantee",
    "column-acl-grantable",
    "authority-column-acl",
  ]) {
    const tampered = makeClient("learncoding_ops", "learncoding", {
      replayAuthorityTableTamper,
    });
    await assert.rejects(
      verifyMailWorkerOutboxContract(tampered, {
        requiresDispatchBinding: true,
        requiresProviderEvidence: true,
        requiresReplayAuthority: true,
      }),
      DatabaseRoleBoundaryError,
      replayAuthorityTableTamper,
    );
  }
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
  assert.equal(
    verified.queries[0],
    "select pg_catalog.set_config('search_path', 'pg_catalog,pg_temp', false) trusted_search_path",
  );
  const queryIndex = verified.queries.findIndex((sql) =>
    sql.includes("routine_direct_acl_exact"),
  );
  assert.deepEqual(verified.queryParameters[queryIndex]?.[5], []);

  await assert.rejects(
    verifyReviewedApplicationRoutines(
      makeClient("learncoding_ops", "learncoding", {
        trustedSearchPath: "public,pg_catalog",
      }),
      [contract],
    ),
    (error) =>
      error instanceof DatabaseRoleBoundaryError &&
      error.message.includes("trusted-search-path"),
  );

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
    rolesAuthenticated: 5,
    positiveChecks: 106,
    negativeChecks: 29,
  });
  for (const role of [
    "learncoding_app",
    "learncoding_migrator",
    "learncoding_worker",
    "learncoding_ops",
    "learncoding_backup_reporter",
  ]) {
    const queries = harness.clients.get(role).queries;
    const probesWithGrant = [
      "learncoding_app",
      "learncoding_worker",
      "learncoding_ops",
    ].includes(role);
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
    const primaryFailure = Object.assign(
      new Error("redacted grant probe failure"),
      { code: grantProbeErrorCode },
    );
    const harness = makePoolHarness({
      grantProbeErrorCode,
      grantProbeFailure: primaryFailure,
    });
    await assert.rejects(
      verifyDatabaseRoleBoundaries({
        ...validInput(),
        poolFactory: harness.factory,
        lockTimeoutMs: 50,
        requireApplicationObjects: true,
      }),
      (error) => error === primaryFailure,
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

test("keeps P2-A catalog-based without a conditional throw probe", () => {
  const source = readFileSync(
    new URL("./verify-database-role-boundaries.mjs", import.meta.url),
    "utf8",
  );
  const probe =
    source.match(
      /async function tablePrivilegeDelegationState[\s\S]*?(?=\nasync function discoverApplicationObjects)/u,
    )?.[0] ?? "";
  assert.match(probe, /pg_catalog\.aclexplode/u);
  assert.match(probe, /acl\.is_grantable/u);
  assert.match(probe, /current_role_effective_grantable/u);
  assert.match(probe, /current_role_direct_grantable/u);
  assert.match(probe, /if \(RUNTIME_ROLES\.has\(role\)\)/u);
  assert.match(probe, /if \(!exactRow\(after, before\)\) fail\(\)/u);
  assert.doesNotMatch(probe, /catch\s*\(/u);
  assert.doesNotMatch(probe, /error\?\.code\s*!==\s*"42501"/u);
  assert.doesNotMatch(probe, /savepoint codestead_table_grant_probe/u);
});

test("post-migration mode fails closed on insecure or missing authority routines", async () => {
  const harness = makePoolHarness({
    backupContractTamper: "routine-direct-acl",
  });
  await assert.rejects(
    verifyDatabaseRoleBoundaries({
      ...validInput(),
      poolFactory: harness.factory,
      lockTimeoutMs: 50,
      requireApplicationObjects: true,
    }),
    (error) =>
      error?.name === "BackupStatusMailAuthorityContractError" &&
      error.message.includes(
        "routine:public.reject_backup_status_mail_authority_mutation():direct_acl_exact",
      ),
  );
  assert.equal(
    harness.pools.every((pool) => pool.ended),
    true,
  );
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
  const connectionPrimaryFailure = new Error("redacted connection failure");
  const connectionFailure = makePoolHarness({
    connectFailureRole: "learncoding_worker",
    connectFailure: connectionPrimaryFailure,
  });
  await assert.rejects(
    verifyDatabaseRoleBoundaries({
      ...validInput(),
      poolFactory: connectionFailure.factory,
    }),
    (error) => error === connectionPrimaryFailure,
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
      POSTGRES_USER: "legacy_bootstrap",
      POSTGRES_DB: "learncoding",
      DATABASE_BOOTSTRAP_URL: validInput().databaseBootstrapUrl,
      DATABASE_APP_URL: `postgresql://learncoding_app:${canary}@wrong-host:5432/learncoding`,
      DATABASE_MIGRATOR_URL: validInput().databaseMigratorUrl,
      DATABASE_WORKER_URL: validInput().databaseWorkerUrl,
      DATABASE_OPS_URL: validInput().databaseOpsUrl,
      DATABASE_BACKUP_REPORTER_URL: validInput().databaseBackupReporterUrl,
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

test("CLI consumes only the exact named application credential", () => {
  const source = readFileSync(
    new URL("./verify-database-role-boundaries.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /databaseAppUrl:\s*process\.env\.DATABASE_APP_URL\s*\?\?\s*""/u,
  );
  assert.doesNotMatch(
    source,
    /databaseAppUrl:\s*process\.env\.DATABASE_URL/u,
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

const FIXED_0067_OUTBOX_CHECK_NAMES = Object.freeze([
  "email_outbox_variables_object_valid",
  "email_outbox_recipient_canonical_valid",
]);

async function assertPremature0067ChecksRejected(
  premature0067CheckConstraints,
) {
  const client = makeClient("learncoding_ops", "learncoding", {
    premature0067CheckConstraints,
  });
  await assert.rejects(
    verifyMailWorkerOutboxContract(client, {
      requiresDispatchBinding: true,
      requiresProviderEvidence: true,
      requiresReplayAuthority: false,
    }),
    DatabaseRoleBoundaryError,
  );

  const workerQuery = client.queries.find((sql) =>
    sql.includes("worker_column_direct_acl_exact"),
  );
  assert.ok(workerQuery, "worker contract query is missing");
  const observedStart = workerQuery.indexOf(
    "reviewed_0067_check_constraints_observed as",
  );
  const observedEnd = workerQuery.indexOf(
    "select",
    workerQuery.indexOf("reviewed_0067_check_constraints_exact"),
  );
  assert.ok(observedStart >= 0 && observedEnd > observedStart);
  const observed = workerQuery.slice(observedStart, observedEnd);
  for (const constraintName of FIXED_0067_OUTBOX_CHECK_NAMES) {
    assert.match(
      observed,
      new RegExp(`'${constraintName}'`, "u"),
      `${constraintName} must always be observed`,
    );
  }
  assert.doesNotMatch(
    observed,
    /select expected[.]constraint_name/u,
    "the observed-name inventory must not disappear with the expected phase",
  );
  const workerQueryIndex = client.queries.indexOf(workerQuery);
  assert.deepEqual(
    JSON.parse(client.queryParameters[workerQueryIndex]?.[30]),
    [],
    "pre-0067 expected rows remain phase-gated to the empty set",
  );
}

test("G rejects premature 0067 CHECK presence before cutover: variables-only", async () => {
  await assertPremature0067ChecksRejected([
    FIXED_0067_OUTBOX_CHECK_NAMES[0],
  ]);
});

test("G rejects premature 0067 CHECK presence before cutover: recipient-only", async () => {
  await assertPremature0067ChecksRejected([
    FIXED_0067_OUTBOX_CHECK_NAMES[1],
  ]);
});

test("G rejects premature 0067 CHECK presence before cutover: both", async () => {
  await assertPremature0067ChecksRejected([
    ...FIXED_0067_OUTBOX_CHECK_NAMES,
  ]);
});
