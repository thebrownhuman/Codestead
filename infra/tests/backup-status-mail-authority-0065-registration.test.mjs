#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES } from "../../scripts/bootstrap-database-roles.mjs";
import {
  BACKUP_STATUS_AUTHORITY_RELATIONS,
  BACKUP_STATUS_AUTHORITY_ROUTINES,
} from "../../scripts/verify-backup-status-mail-authority.mjs";
import {
  REVIEWED_MIGRATION_LEDGER,
  reviewedMigrationLedgerSha256,
} from "../../scripts/lib/reviewed-migration-ledger.mjs";
import {
  assertBackupStatusMailAuthority0065PostgresProjection,
  backupStatusMailAuthority0065CiContract,
} from "./backup-status-mail-authority-0065-ci-contract.mjs";
import {
  projectHistoricalPostgresCiProjection,
} from "./mail-guarded-delivery-0069-ci-contract.mjs";

const readBytes = (relativePath) =>
  readFileSync(new URL(`../../${relativePath}`, import.meta.url));
const read = (relativePath) => readBytes(relativePath).toString("utf8");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const expected0065LedgerEntry = Object.freeze({
  idx: 65,
  version: "7",
  when: 1784936400000,
  tag: "0065_backup_status_mail_authority",
  breakpoints: true,
  sqlSha256: "1274dda8013fe80f09df63f7ddc73b24b0a9a482a40e5f5042eaef2373c14b3c",
});
const reviewedLedgerThrough0065 = REVIEWED_MIGRATION_LEDGER.slice(0, 66);
const reviewedLedgerThrough0065Sha256 =
  reviewedMigrationLedgerSha256(reviewedLedgerThrough0065);

const packageManifest = JSON.parse(read("package.json"));
const workflow = read(".github/workflows/ci.yml");
const journal = JSON.parse(read("drizzle/meta/_journal.json"));
const migrationBytes = readBytes(
  "drizzle/0065_backup_status_mail_authority.sql",
);
const snapshot0064 = JSON.parse(read("drizzle/meta/0064_snapshot.json"));
const snapshot0065 = JSON.parse(read("drizzle/meta/0065_snapshot.json"));
const harnessSource = read(
  "infra/tests/backup-status-mail-authority-0065.integration.mjs",
);
const normalPg17Runner = read(
  "infra/tests/database-least-privilege-integration.mjs",
);
const productionCompose = read("compose.yaml");
const scripts = packageManifest.scripts;
const {
  registrationScript,
  harnessScript,
  registrationCommand,
  harnessCommand,
} = backupStatusMailAuthority0065CiContract;

assert.equal(scripts[registrationScript], registrationCommand);
assert.equal(scripts[harnessScript], harnessCommand);
assert.equal(
  scripts["test:backup-status-mail-authority:contract"],
  "node --test scripts/verify-backup-status-mail-authority.test.mjs",
);
assert.equal(
  scripts.check
    .split(" && ")
    .filter((command) => command === `npm run ${registrationScript}`).length,
  1,
  "npm run check must execute the 0065 registration guard exactly once",
);
for (const command of [
  "npm run test:database-role-boundaries",
  "npm run test:backup-status-mail-authority:contract",
]) {
  assert.equal(
    scripts.check.split(" && ").filter((candidate) => candidate === command)
      .length,
    1,
    `npm run check must execute ${command} exactly once`,
  );
}

assert.equal(reviewedLedgerThrough0065.length, 66);
assert.equal(reviewedLedgerThrough0065.at(-1)?.idx, 65);
assert.deepEqual(reviewedLedgerThrough0065.at(-1), expected0065LedgerEntry);
assert.equal(
  reviewedLedgerThrough0065Sha256,
  "cfe0f4ae4ad8dd34a018fff730acbc09413e2d4f7e461f8ee033814412735fa9",
);

const migrationNames = readdirSync(new URL("../../drizzle", import.meta.url))
  .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
  .filter((name) => Number.parseInt(name.slice(0, 4), 10) <= 65)
  .sort();
assert.deepEqual(
  migrationNames,
  reviewedLedgerThrough0065.map(({ tag }) => `${tag}.sql`),
  "the canonical ordered ledger must name every migration through 0065",
);
for (const entry of reviewedLedgerThrough0065) {
  assert.equal(
    sha256(readBytes(`drizzle/${entry.tag}.sql`)),
    entry.sqlSha256,
    `migration ${entry.idx} raw-byte SHA differs from the canonical ledger`,
  );
}
assert.equal(
  sha256(migrationBytes),
  expected0065LedgerEntry.sqlSha256,
  "0065 raw migration bytes changed without reviewed ledger advancement",
);

const journalThrough0065 = journal.entries
  .filter((entry) => entry.idx <= 65)
  .sort((left, right) => left.idx - right.idx);
assert.deepEqual(
  journalThrough0065,
  reviewedLedgerThrough0065.map(({ sqlSha256: omittedSqlSha256, ...entry }) => {
    assert.match(omittedSqlSha256, /^[0-9a-f]{64}$/u);
    return entry;
  }),
  "Drizzle journal metadata must match the canonical ledger through 0065",
);

assert.equal(snapshot0065.id, "e8c1a2f4-6b73-4d90-8f21-5a7c3e9b0645");
assert.notEqual(snapshot0065.id, snapshot0064.id);
assert.equal(
  snapshot0065.prevId,
  "5bfa9769-f63a-4b31-8532-515d735bf4df",
  "0065 snapshot must descend exactly from 0064",
);
assert.equal(snapshot0065.prevId, snapshot0064.id);
assert.equal(snapshot0065.version, "7");
assert.equal(snapshot0065.dialect, "postgresql");
const withoutSnapshotIdentity = (snapshot) =>
  Object.fromEntries(
    Object.entries(snapshot).filter(([key]) => !["id", "prevId"].includes(key)),
  );
assert.deepEqual(
  withoutSnapshotIdentity(snapshot0065),
  withoutSnapshotIdentity(snapshot0064),
  "raw 0065 authority objects are not Drizzle schema-modeled",
);
assert.equal(
  sha256(readBytes("drizzle/meta/0065_snapshot.json")),
  "b00262072a03a6536fce88decaf0adfe01fc067211687822848f5a268215819d",
  "0065 snapshot raw bytes changed without reviewed metadata advancement",
);

const phase0064 = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.find(
  ({ index }) => index === 64,
);
const phasesThrough0065 = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.filter(
  ({ index }) => index <= 65,
);
assert.deepEqual(
  phasesThrough0065.map((phase) => phase.index),
  [62, 63, 64, 65],
);
const phase0065 = phasesThrough0065.at(-1);
const reviewedRewardRoutineSignatures = [
  "public.enqueue_reward_jobs_for_attempt_v1(uuid,text,timestamp with time zone)",
  "public.enqueue_reward_jobs_for_mastery_scope_v1(uuid,text,timestamp with time zone)",
];
assert.equal(phase0064?.routines.length, 6);
assert.deepEqual(
  phase0064?.routines
    .map(({ signature }) => signature)
    .filter((signature) => reviewedRewardRoutineSignatures.includes(signature)),
  reviewedRewardRoutineSignatures,
);
assert.equal(phase0064?.triggers.length, 2);
assert.equal(phase0064?.backupStatusAuthority, null);
assert.deepEqual(
  {
    index: phase0065?.index,
    createdAt: phase0065?.createdAt,
    migrationFile: phase0065?.migrationFile,
    migrationSha256: phase0065?.migrationSha256,
    requiresWorkerContract: phase0065?.requiresWorkerContract,
  },
  {
    index: 65,
    createdAt: "1784936400000",
    migrationFile: "0065_backup_status_mail_authority.sql",
    migrationSha256: expected0065LedgerEntry.sqlSha256,
    requiresWorkerContract: true,
  },
);
assert.equal(phase0065?.routines.length, 10);
assert.deepEqual(
  phase0065?.routines
    .map(({ signature }) => signature)
    .filter((signature) => reviewedRewardRoutineSignatures.includes(signature)),
  reviewedRewardRoutineSignatures,
);
assert.equal(phase0065?.triggers.length, 7);
assert.equal(
  phase0065?.backupStatusAuthority?.relations,
  BACKUP_STATUS_AUTHORITY_RELATIONS,
);
assert.equal(
  phase0065?.backupStatusAuthority?.routines,
  BACKUP_STATUS_AUTHORITY_ROUTINES,
);
assert.equal(phase0065?.backupStatusAuthority?.relations.length, 2);
assert.equal(phase0065?.backupStatusAuthority?.routines.length, 4);
assert.equal(phase0065?.backupStatusAuthority?.triggers.length, 5);
assert.doesNotMatch(
  JSON.stringify(phase0065),
  /3aedb0c34774e187fd853808e78584c64b8828d346a94fc7b817cfc6235fb6a7/u,
);
assert.deepEqual(
  phase0065?.backupStatusAuthority?.routines.map((routine) => ({
    signature: routine.signature,
    owner: routine.owner,
    securityDefiner: routine.securityDefiner,
    configuration: routine.configuration,
    allowedRoles: routine.allowedRoles,
    bodySha256: routine.bodySha256,
    definitionSha256: routine.definitionSha256,
  })),
  [
    {
      signature: "public.reject_backup_status_mail_authority_mutation()",
      owner: "learncoding_owner",
      securityDefiner: false,
      configuration: ["search_path=pg_catalog"],
      allowedRoles: [],
      bodySha256:
        "821807d9e78e8d31b0c6ebb567a51c92f04830848de2d555e4f8be8fd370c0db",
      definitionSha256:
        "30414dca0ae964f5275372bc0c8f1607417c0fa5d22786977b25c21be877d240",
    },
    {
      signature: "public.lock_backup_status_mail_admin_authority()",
      owner: "learncoding_owner",
      securityDefiner: true,
      configuration: ["search_path=pg_catalog"],
      allowedRoles: [],
      bodySha256:
        "3c9e8f9ba6e0095a3f6868150677cf450942d9ffc91d0a34b7c2a65d044ccb1f",
      definitionSha256:
        "58188d5627aed8c443f506e3cda54ac171c2f8219bad481f26a832ace66df3bc",
    },
    {
      signature: "public.enqueue_backup_status_mail_authority(text,text)",
      owner: "learncoding_owner",
      securityDefiner: true,
      configuration: ["search_path=pg_catalog"],
      allowedRoles: ["learncoding_backup_reporter"],
      bodySha256:
        "e2d042d4948b883aa3ee307b360fc386367a496f672c37a3ba278e93cc6e2aae",
      definitionSha256:
        "25e91d413020f5ef0d6965b32079b38fa9f26cd5b75fc7eedfb131080dd705b9",
    },
    {
      signature: "public.backup_status_mail_authorized(uuid)",
      owner: "learncoding_owner",
      securityDefiner: true,
      configuration: ["search_path=pg_catalog"],
      allowedRoles: ["learncoding_worker"],
      bodySha256:
        "c947fcc0d019174fcb76c39d61fa736bd552dd6f2eeae6f46cfc772aa4dc95ae",
      definitionSha256:
        "bb7765a31c1e9e2796e554cb1445ddeba3f8ff078e210312486b817db1da4180",
    },
  ],
);
assert.deepEqual(
  phase0065?.backupStatusAuthority?.triggers.map((trigger) => ({
    relation: trigger.relation,
    name: trigger.name,
    functionSignature: trigger.functionSignature,
    enabled: trigger.enabled,
    type: trigger.type,
    predicate: trigger.predicate,
    arguments: trigger.arguments,
    watchedColumns: trigger.watchedColumns,
  })),
  [
    [
      "public.backup_status_mail_authority",
      "backup_status_mail_authority_immutable",
      "public.reject_backup_status_mail_authority_mutation()",
      "O",
      27,
      null,
      [],
      [],
    ],
    [
      "public.backup_status_mail_authority",
      "backup_status_mail_authority_no_truncate",
      "public.reject_backup_status_mail_authority_mutation()",
      "O",
      34,
      null,
      [],
      [],
    ],
    [
      'public."user"',
      "backup_status_mail_admin_insert_lock",
      "public.lock_backup_status_mail_admin_authority()",
      "O",
      7,
      null,
      [],
      [],
    ],
    [
      'public."user"',
      "backup_status_mail_admin_update_lock",
      "public.lock_backup_status_mail_admin_authority()",
      "O",
      19,
      null,
      [],
      ["id", "email", "role", "status", "banned"],
    ],
    [
      'public."user"',
      "backup_status_mail_admin_delete_lock",
      "public.lock_backup_status_mail_admin_authority()",
      "O",
      11,
      null,
      [],
      [],
    ],
  ].map(
    ([
      relation,
      name,
      functionSignature,
      enabled,
      type,
      predicate,
      triggerArguments,
      watchedColumns,
    ]) => ({
      relation,
      name,
      functionSignature,
      enabled,
      type,
      predicate,
      arguments: triggerArguments,
      watchedColumns,
    }),
  ),
);
assert.deepEqual(
  phase0065?.backupStatusAuthority?.relations.map((relation) => ({
    name: relation.name,
    columns: relation.columns.map(({ name }) => name),
    constraints: relation.constraints.map(({ name }) => name),
    indexes: relation.indexes.map(({ name }) => name),
  })),
  BACKUP_STATUS_AUTHORITY_RELATIONS.map((relation) => ({
    name: relation.name,
    columns: relation.columns.map(({ name }) => name),
    constraints: relation.constraints.map(({ name }) => name),
    indexes: relation.indexes.map(({ name }) => name),
  })),
);
assert.deepEqual(phase0065?.backupStatusAuthority?.guardState, {
  relation: "public.backup_status_mail_admin_guard",
  singletonColumn: "singleton",
  authorityEpochColumn: "authority_epoch",
  expectedRows: 1,
  singletonValue: true,
  requiresNonZeroAuthorityEpoch: true,
});

assert.match(harnessSource, /\["17", environment\.POSTGRES_17_BIN/u);
assert.match(harnessSource, /\["18", environment\.POSTGRES_18_BIN/u);
assert.match(
  harnessSource,
  /\.\.\/\.\.\/scripts\/lib\/disposable-loopback-port\.mjs/u,
);
assert.doesNotMatch(harnessSource, /net\.createServer|unusedLoopbackPort/u);
assert.match(harnessSource, /let primaryError;/u);
assert.match(harnessSource, /const cleanupErrors = \[\];/u);
assert.match(harnessSource, /primaryError\.cause \?\?= new AggregateError/u);
assert.match(harnessSource, /if \(primaryError\) throw primaryError;/u);
assert.doesNotMatch(
  harnessSource,
  /allowFailure:\s*true[\s\S]{0,120}pg_ctl|pg_ctl[\s\S]{0,120}allowFailure:\s*true/u,
);
assert.match(harnessSource, /mkdirSync\(socketDirectory\)/u);
assert.match(
  harnessSource,
  /const socketOption =\s*socketDirectory === undefined \|\| process\.platform === "win32"\s*\?\s*""\s*:\s*` -k "\$\{socketDirectory\}"`;/u,
);
assert.match(harnessSource, /let serverStartAttempted = false;/u);
assert.match(harnessSource, /"--log",\s*serverLog/u);
assert.match(
  harnessSource,
  /serverStartAttempted && existsSync\(postmasterPid\)/u,
);
assert.match(harnessSource, /"--no-wait",\s*"start"/u);
assert.match(harnessSource, /await waitForPostgres\(port\);/u);
assert.match(harnessSource, /BACKUP_STATUS_POSTGRES_PORT/u);
assert.match(harnessSource, /assert\.notEqual\(port, 5432/u);
assert.match(harnessSource, /SHOW server_version_num/u);

assert.match(normalPg17Runner, /databaseBackupReporterUrl:/u);
assert.match(
  normalPg17Runner,
  /url\("learncoding_backup_reporter", secret\("backup-reporter"/u,
);
assert.match(productionCompose, /DATABASE_BACKUP_REPORTER_URL_FILE:/u);
assert.match(productionCompose, /database_backup_reporter_url/u);

const currentPostgresJob =
  workflow.match(
    /^  postgres-integration:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/mu,
  )?.[0] ?? "";
const postgresJob =
  projectHistoricalPostgresCiProjection(currentPostgresJob);
assertBackupStatusMailAuthority0065PostgresProjection(postgresJob);

console.log("backup-status-mail-authority-0065-registration-tests-ok");
