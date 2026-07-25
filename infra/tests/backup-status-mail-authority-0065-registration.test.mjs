#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import {
  REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES,
} from "../../scripts/bootstrap-database-roles.mjs";
import {
  REVIEWED_MIGRATION_LEDGER,
  REVIEWED_MIGRATION_LEDGER_SHA256,
  appendReviewedMigrationLedgerEntry,
  reviewedMigrationLedgerSha256,
} from "../../scripts/lib/reviewed-migration-ledger.mjs";
import {
  assertBackupStatusMailAuthority0065PostgresProjection,
  backupStatusMailAuthority0065CiContract,
} from "./backup-status-mail-authority-0065-ci-contract.mjs";

const readBytes = (relativePath) =>
  readFileSync(new URL(`../../${relativePath}`, import.meta.url));
const read = (relativePath) => readBytes(relativePath).toString("utf8");
const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

const expected0065LedgerEntry = Object.freeze({
  idx: 65,
  version: "7",
  when: 1784936400000,
  tag: "0065_backup_status_mail_authority",
  breakpoints: true,
  sqlSha256:
    "3aedb0c34774e187fd853808e78584c64b8828d346a94fc7b817cfc6235fb6a7",
});
const reviewedMigrationLedgerThrough0065 =
  appendReviewedMigrationLedgerEntry(
    REVIEWED_MIGRATION_LEDGER,
    expected0065LedgerEntry,
  );

const packageManifest = JSON.parse(read("package.json"));
const workflow = read(".github/workflows/ci.yml");
const journal = JSON.parse(read("drizzle/meta/_journal.json"));
const migrationBytes = readBytes(
  "drizzle/0065_backup_status_mail_authority.sql",
);
const snapshot0064 = JSON.parse(
  read("drizzle/meta/0064_snapshot.json"),
);
const snapshot0065 = JSON.parse(
  read("drizzle/meta/0065_snapshot.json"),
);
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
  scripts.check
    .split(" && ")
    .filter((command) => command === `npm run ${registrationScript}`).length,
  1,
  "npm run check must execute the 0065 registration guard exactly once",
);

assert.equal(
  reviewedMigrationLedgerSha256(REVIEWED_MIGRATION_LEDGER),
  REVIEWED_MIGRATION_LEDGER_SHA256,
  "the canonical through-0064 ledger digest must verify before append",
);
assert.equal(REVIEWED_MIGRATION_LEDGER.at(-1)?.idx, 64);
assert.deepEqual(
  reviewedMigrationLedgerThrough0065.at(-1),
  expected0065LedgerEntry,
);
assert.match(
  reviewedMigrationLedgerSha256(reviewedMigrationLedgerThrough0065),
  /^[0-9a-f]{64}$/u,
);
assert.notEqual(
  reviewedMigrationLedgerSha256(reviewedMigrationLedgerThrough0065),
  REVIEWED_MIGRATION_LEDGER_SHA256,
);

const migrationNames = readdirSync(
  new URL("../../drizzle", import.meta.url),
)
  .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
  .filter((name) => Number.parseInt(name.slice(0, 4), 10) <= 65)
  .sort();
assert.deepEqual(
  migrationNames,
  reviewedMigrationLedgerThrough0065.map(({ tag }) => `${tag}.sql`),
  "the canonical ordered ledger must name every migration through 0065",
);
for (const entry of reviewedMigrationLedgerThrough0065) {
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
  reviewedMigrationLedgerThrough0065.map(({
    sqlSha256: omittedSqlSha256,
    ...entry
  }) => {
    assert.match(omittedSqlSha256, /^[0-9a-f]{64}$/u);
    return entry;
  }),
  "Drizzle journal metadata must match the canonical ledger through 0065",
);

assert.match(
  snapshot0065.id,
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
);
assert.notEqual(snapshot0065.id, snapshot0064.id);
assert.equal(
  snapshot0065.prevId,
  snapshot0064.id,
  "0065 snapshot must descend exactly from 0064",
);
assert.equal(snapshot0065.version, "7");
assert.equal(snapshot0065.dialect, "postgresql");
const withoutSnapshotIdentity = (snapshot) =>
  Object.fromEntries(
    Object.entries(snapshot)
      .filter(([key]) => !["id", "prevId"].includes(key)),
  );
assert.deepEqual(
  withoutSnapshotIdentity(snapshot0065),
  withoutSnapshotIdentity(snapshot0064),
  "raw 0065 authority objects are not Drizzle schema-modeled",
);

assert.deepEqual(
  REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.map((phase) => phase.index),
  [62, 63, 64, 65],
);
const phase0065 = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.at(-1);
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

const postgresJob =
  workflow.match(
    /^  postgres-integration:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/mu,
  )?.[0] ?? "";
assertBackupStatusMailAuthority0065PostgresProjection(postgresJob);

console.log("backup-status-mail-authority-0065-registration-tests-ok");
