import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  MAIL_WORKER_OUTBOX_INSERT_COLUMNS,
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
  reconcileDatabaseRolePrivileges,
  reviewedApplicationFunctionPrivilegesSql,
  verifyBackupStatusAuthorityAfterRepair,
  verifyBackupStatusAuthorityBeforeRepair,
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

function reviewedPhase(index) {
  const phase = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.find(
    (candidate) => candidate.index === index,
  );
  assert.ok(phase, `reviewed phase ${index} must be registered`);
  return phase;
}

const REVIEWED_PHASE_0064 = reviewedPhase(64);
const REVIEWED_PHASE_0065 = reviewedPhase(65);
const REVIEWED_PHASE_0066 = reviewedPhase(66);
const REVIEWED_PHASE_0067 = reviewedPhase(67);

function reviewedPhaseForOptions(options) {
  if (options.journalPresent === false || options.appliedMigrationIndex === null) {
    return null;
  }
  return reviewedPhase(options.appliedMigrationIndex ?? 67);
}

const password = (character) => character.repeat(48);
const validInput = () => ({
  postgresDatabase: "learncoding",
  databaseAppUrl: `postgresql://learncoding_app:${password("a")}@postgres:5432/learncoding`,
  databaseMigratorUrl: `postgresql://learncoding_migrator:${password("m")}@postgres:5432/learncoding`,
  databaseWorkerUrl: `postgresql://learncoding_worker:${password("w")}@postgres:5432/learncoding`,
  databaseOpsUrl: `postgresql://learncoding_ops:${password("o")}@postgres:5432/learncoding`,
  databaseBackupReporterUrl: `postgresql://learncoding_backup_reporter:${password("r")}@postgres:5432/learncoding`,
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

function normalizedReviewedCheck(expression) {
  return expression
    .replace(
      /"?(email_outbox|email_outbox_idempotency_authority)"?[.]/gu,
      "",
    )
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
  const authorityChecks = snapshot.tables[
    "public.email_outbox_idempotency_authority"
  ].checkConstraints;
  const outboxChecks =
    snapshot.tables["public.email_outbox"].checkConstraints;
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
      normalizedReviewedCheck(
        outboxChecks[contract.deliveryScope.name].value,
      ),
    ),
    contract.deliveryScope.reviewedSqlExpressionSha256,
  );
  assert.equal(contract.triggers.length, 8);
  assert.equal(contract.routines.length, 7);
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

  const routineSql = reviewedApplicationFunctionPrivilegesSql(
    REVIEWED_PHASE_0067,
  );
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
              post_migration_provider_column_count: 0,
              post_migration_provider_column_exact_count: 0,
              post_migration_replay_column_count: 0,
              post_migration_replay_column_exact_count: 0,
            },
          ],
        };
      }
      if (normalized.includes("backup_status_authority_present")) {
        return {
          rows: [
            {
              backup_status_authority_present: false,
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
              reviewed_provider_evidence_constraint_presence_exact: true,
              reviewed_replay_authority_constraint_presence_exact: true,
              reviewed_replay_authority_relation_presence_exact: true,
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
    await databaseRoleBootstrap.reconcileDatabaseRolePrivileges(
      client,
      null,
    );
    passes.push(currentPass);
    currentPass = [];
  }

  assert.deepEqual(passes[1], passes[0]);
  const scrubSql = passes[0].find((sql) =>
    sql.includes("do $codestead_managed_column_acl_scrub$"),
  );
  assert.equal(typeof scrubSql, "string");
  assert.match(scrubSql, /pg_catalog\.pg_attribute/iu);
  assert.match(scrubSql, /pg_catalog\.aclexplode/iu);
  assert.match(scrubSql, /namespace\.nspname in \('public', 'drizzle'\)/iu);
  assert.match(
    scrubSql,
    /revoke all privileges \(%i\) on table %i\.%i from %s cascade/iu,
  );

  const workerSql = passes[0].find((sql) =>
    sql.includes("do $codestead_mail_worker_outbox$"),
  );
  assert.equal(typeof workerSql, "string");
  assert.match(
    workerSql,
    /grant insert \(idempotency_authority_version\) on table public\.email_outbox to learncoding_app/iu,
  );
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
  const repair = bootstrapSource.indexOf("await createAndResetRoles(client)");
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
  for (const [appliedMigrationIndex, expectedConfiguration] of
    expectedConfigurations) {
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
        parameters?.[0]
          === "public.enqueue_backup_status_mail_authority(text,text)",
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
  assert.deepEqual(
    finalEnqueueContracts[0].configuration,
    ["search_path=pg_catalog, pg_temp"],
  );
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
  const sql0065 = reviewedApplicationFunctionPrivilegesSql(
    REVIEWED_PHASE_0065,
  );
  const sql0066 = reviewedApplicationFunctionPrivilegesSql(
    REVIEWED_PHASE_0066,
  );
  const sql0067 = reviewedApplicationFunctionPrivilegesSql(
    REVIEWED_PHASE_0067,
  );
  assert.doesNotMatch(
    sql0065,
    /enforce_email_outbox_provider_correlation_evidence/u,
  );
  assert.match(
    sql0066,
    /enforce_email_outbox_provider_correlation_evidence/u,
  );
  for (const preReplaySql of [sql0065, sql0066]) {
    assert.doesNotMatch(
      preReplaySql,
      /email_outbox_original_payload_sha256/u,
    );
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
  const commit = source.indexOf('await client.query("commit")', callback);
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
    "await reconcileDatabaseRolePrivileges(",
    runStart,
  );
  const postReconciliationVerify = source.indexOf(
    "await verifyPostMigrationReviewedContractsBeforeReconciliation(",
    reconcile + 1,
  );
  const stateVerify = source.indexOf(
    "await verifyDatabaseRoleBootstrapState(",
    reconcile + 1,
  );
  assert.ok(runStart >= 0 && reconcile > runStart);
  assert.ok(postReconciliationVerify > reconcile);
  assert.ok(stateVerify > postReconciliationVerify);
});

test("accepts only the exact five distinct restricted-role URLs", () => {
  const parsed = validateDatabaseRoleBoundaryUrls(validInput());
  assert.deepEqual(Object.keys(parsed), [
    "app",
    "migrator",
    "worker",
    "ops",
    "backupReporter",
  ]);
  assert.equal(parsed.app.username, "learncoding_app");
  assert.equal(parsed.backupReporter.username, "learncoding_backup_reporter");

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

function makeClient(role, database, options) {
  const queries = [];
  const queryParameters = [];
  let delegated = false;
  let grantCatalogVersion = 0;
  const latestApplied =
    options.appliedMigrationIndex === undefined
      ? 67
      : options.appliedMigrationIndex;
  const backupAuthorityPresent =
    options.backupAuthorityPresent ??
    (options.journalPresent !== false &&
      latestApplied !== null &&
      latestApplied >= 65 &&
      options.missingMigrationIndex !== 65);
  return {
    queries,
    queryParameters,
    release() {},
    async query(sql, parameters) {
      const normalized = String(sql).replace(/\s+/gu, " ").trim().toLowerCase();
      queries.push(normalized);
      queryParameters.push(parameters);
      if (normalized.includes("trusted_search_path")) {
        return {
          rows: [{
            trusted_search_path:
              options.trustedSearchPath ?? "pg_catalog,pg_temp",
          }],
        };
      }
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
                options.providerColumnCount
                ?? (
                  options.journalPresent === false
                  || latestApplied === null
                  || latestApplied < 66 ? 0 : 3
                ),
              post_migration_provider_column_exact_count:
                options.providerColumnExactCount
                ?? options.providerColumnCount
                ?? (latestApplied !== null && latestApplied >= 66 ? 3 : 0),
              post_migration_replay_column_count:
                options.replayColumnCount
                ?? (
                  options.journalPresent === false
                  || latestApplied === null
                  || latestApplied < 67 ? 0 : 3
                ),
              post_migration_replay_column_exact_count:
                options.replayColumnExactCount
                ?? options.replayColumnCount
                ?? (
                  options.journalPresent === false
                  || latestApplied === null
                  || latestApplied < 67 ? 0 : 3
                ),

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
        const premature0067CheckObserved = (
          options.premature0067CheckConstraints ?? []
        ).some((constraintName) =>
          normalized.includes(`'${constraintName}'`)
        );
        return {
          rows: [
            {
              outbox_present_exact: tamper !== "table",
              outbox_owner_exact: tamper !== "owner",
              binding_columns_exact: tamper !== "binding-columns",
              provider_evidence_columns_exact:
                tamper !== "provider-evidence-columns",
              idempotency_authority_columns_exact:
                tamper !== "replay-columns",
              reviewed_0067_check_constraints_exact: !tamper?.startsWith("variables-constraint-")
                && !tamper?.startsWith("recipient-constraint-")
                && !premature0067CheckObserved,
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
                tamper === "default-acl-additional-creator-complete-pair"
                  ? normalized.includes(
                    "additional_creator_default_acl_exact",
                  ) &&
                    normalized.includes(
                      "additional_creator_default_acl_rows",
                    ) &&
                    normalized.includes(
                      "default_acl_catalog_prerequisites",
                    )
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
                  ].includes(tamper),
              persistent_relation_grant_options_exact:
                tamper !== "relation-grant-option",
              persistent_column_acl_exact: ![
                "column-acl-unexpected",
                "column-acl-missing",
                "column-acl-wrong-grantor",
                "column-acl-wrong-grantee",
                "column-acl-grantable",
              ].includes(tamper),
              authority_owner_exact: tamper !== "owner",
              authority_columns_exact: !["columns", "extra-column"].includes(tamper),
              authority_primary_key_exact: tamper !== "primary-key",
              authority_checks_exact: ![
                "digest-check",
                "payload-check",
              ].includes(tamper),
              outbox_delivery_scope_exact: tamper !== "delivery-scope",
              reviewed_trigger_set_exact: tamper !== "extra-trigger",
              reviewed_routine_overloads_exact: tamper !== "routine-overload",
              authority_direct_acl_exact: tamper !== "direct-acl",
              authority_effective_acl_exact: tamper !== "effective-acl",
              authority_column_acl_exact: ![
                "column-acl",
                "authority-column-acl",
              ].includes(tamper),
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
        return { rows: [{
          delegated,
          current_role_effective_grantable:
            options.currentRoleEffectiveGrantable === true,
          current_role_direct_grantable:
            options.currentRoleDirectGrantable === true,
          table_acl: `catalog-version-${grantCatalogVersion}`,
        }] };
      }
      if (normalized.includes("effective_table_acl_exact")) {
        const tamper = options.backupContractTamper;
        return { rows: [{
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
        }] };
      }
      if (normalized.includes("routine_kind_exact")) {
        const tamper = options.backupContractTamper;
        return { rows: [{
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
        }] };
      }
      if (normalized.includes("triggers_exact")) {
        return { rows: [{
          relations_present: true,
          guard_state_exact: options.backupContractTamper !== "guard-state",
          triggers_exact: options.backupContractTamper !== "triggers",
        }] };
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
    assert.deepEqual(
      priorPhase.queryParameters[workerQueryIndex]?.slice(10),
      [
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
        "3f32ee19567df8889a129cc1e2e95af9f70a8e4e5878c7f7930ec396259ceefc",
        reviewedApplicationConstraint(
          "email_outbox_idempotency_authority_valid",
        ).columns,
        false,
        "[]",
      ],
    );
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

  for (const options of [
    { bindingColumnCount: 1, bindingColumnExactCount: 1 },
    { bindingColumnCount: 2, bindingColumnExactCount: 1 },
    { providerColumnCount: 1, providerColumnExactCount: 1 },
    { providerColumnCount: 3, providerColumnExactCount: 2 },
    { appliedMigrationIndex: 65, providerColumnCount: 3 },
    { footprintContractTamper: "routine" },
    { footprintContractTamper: "trigger" },
    { footprintContractTamper: "constraint" },
    { footprintContractTamper: "provider-constraint" },
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
    ...backupStatusAuthorityTamperCases,
  ]) {
    const tampered = makeClient("learncoding_ops", "learncoding", options);
    await assert.rejects(
      reconcileDatabaseRolePrivileges(
        tampered,
        reviewedPhaseForOptions(options),
      ),
    );
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
    rolesAuthenticated: 5,
    positiveChecks: 16,
    negativeChecks: 19,
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
  assert.equal(
    harness.clients.get("learncoding_backup_reporter").queries.includes("set role learncoding_owner"),
    true,
  );
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
    positiveChecks: 71,
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
  const reporterQueries = harness.clients.get("learncoding_backup_reporter").queries;
  assert.equal(
    reporterQueries.some((sql) => sql.startsWith("explain (format json)")),
    false,
  );
});

test("requires the exact reviewed 0062 through 0067 routine contracts in application-object mode", async () => {
  const verified = makePoolHarness();
  const result = await verifyDatabaseRoleBoundaries({
    ...validInput(),
    poolFactory: verified.factory,
    lockTimeoutMs: 50,
    requireApplicationObjects: true,
  });

  assert.deepEqual(result, {
    rolesAuthenticated: 5,
    positiveChecks: 71,
    negativeChecks: 29,
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
      error instanceof DatabaseRoleBoundaryError
      && error.message.includes(
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
            reviewedSqlExpressionSha256:
              constraint.reviewedSqlExpressionSha256,
            normalizedExpressionSha256:
              constraint.normalizedExpressionSha256,
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
    positiveChecks: 71,
    negativeChecks: 29,
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
    reviewedApplicationConstraint(
      "email_outbox_dispatch_binding_valid",
    ).normalizedExpression,
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
  assert.deepEqual(
    opsClient.queryParameters[workerQueryIndex]?.slice(21, 30),
    [
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
      reviewedApplicationConstraint(
        "email_outbox_idempotency_authority_valid",
      ).normalizedExpressionSha256,
      reviewedApplicationConstraint(
        "email_outbox_idempotency_authority_valid",
      ).columns,
      true,
    ],
  );
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
      error instanceof DatabaseRoleBoundaryError
      && error.message.includes("mail-worker-outbox-contract")
      && error.message.includes("worker_table_direct_acl_exact"),
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
      error instanceof DatabaseRoleBoundaryError
      && error.message.includes("trusted-search-path"),
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
      totalVerified:
        phase0064.routines.length + phase0064.triggers.length + 1,
    },
  );
  assert.equal(
    client.queries.filter((query) =>
      query.includes("routine_direct_acl_exact")
    ).length,
    phase0064.routines.length,
  );
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
    replayAuthorityTableTamper:
      "default-acl-additional-creator-complete-pair",
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
  const defaultAclQuery = catalogQuery.slice(
    defaultAclStart,
    defaultAclEnd,
  );
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
  assert.doesNotMatch(
    managedRowsQuery,
    /\bwhere\b/iu,
  );
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
  assert.match(
    defaultAclQuery,
    /managed_row[.]owner_name is null/iu,
  );
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
  assert.match(
    defaultAclQuery,
    /group by additional_row[.]owner_oid/iu,
  );
  assert.equal(
    [...defaultAclQuery.matchAll(/\bexcept all\b/giu)].length,
    4,
  );
  assert.match(
    defaultAclQuery,
    /access[.]grantee = 0 is_public/iu,
  );
  assert.match(
    defaultAclQuery,
    /additional_row[.]owner_name <> 'public'/iu,
  );
  assert.match(defaultAclQuery, /not additional[.]owner_name_exact/iu);
  assert.doesNotMatch(
    defaultAclQuery,
    /pg_get_userbyid[(][^)]*grantee/iu,
  );
  assert.doesNotMatch(
    defaultAclQuery,
    /permitted_extra_default_acl_rows/iu,
  );
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
  const inventorySource = bootstrapSource.slice(
    inventoryStart,
    inventoryEnd,
  );
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
      error instanceof DatabaseRoleBoundaryError
      && error.message.includes("trusted-search-path"),
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
    positiveChecks: 71,
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

test("keeps P2-A catalog-based without a conditional throw probe", () => {
  const source = readFileSync(
    new URL("./verify-database-role-boundaries.mjs", import.meta.url),
    "utf8",
  );
  const probe = source.match(
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
  const harness = makePoolHarness({ backupContractTamper: "routine-direct-acl" });
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

for (const [label, premature0067CheckConstraints] of [
  ["variables-only", [FIXED_0067_OUTBOX_CHECK_NAMES[0]]],
  ["recipient-only", [FIXED_0067_OUTBOX_CHECK_NAMES[1]]],
  ["both", [...FIXED_0067_OUTBOX_CHECK_NAMES]],
]) {
  test(`G rejects premature 0067 CHECK presence before cutover: ${label}`, async () => {
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
      sql.includes("worker_column_direct_acl_exact")
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
  });
}
