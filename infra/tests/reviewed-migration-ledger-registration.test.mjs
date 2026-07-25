#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  REVIEWED_MIGRATION_LEDGER,
  REVIEWED_MIGRATION_LEDGER_SHA256,
  verifyReviewedMigrationRepository,
} from "../../scripts/lib/reviewed-migration-ledger.mjs";

const read = (relativePath) =>
  readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");

const packageManifest = JSON.parse(read("package.json"));
const workflow = read(".github/workflows/ci.yml");
const backupCiRegistration = read(
  "infra/tests/backup-ci-registration.test.mjs",
);
const dockerfile = read("Dockerfile");
const bootstrap = read("scripts/bootstrap-database-roles.mjs");
const migration = read("scripts/migrate-production.mjs");
const release = read("infra/ops/release-production.sh");
const restore = read("scripts/backup/restore-drill-isolated.sh");
const backupProductionE2e = read("infra/tests/backup-production-e2e.test.sh");

assert.equal(REVIEWED_MIGRATION_LEDGER.length, 67);
assert.equal(REVIEWED_MIGRATION_LEDGER.at(-1)?.idx, 66);
assert.match(REVIEWED_MIGRATION_LEDGER_SHA256, /^[0-9a-f]{64}$/u);
assert.equal(
  verifyReviewedMigrationRepository().ledgerSha256,
  REVIEWED_MIGRATION_LEDGER_SHA256,
);

assert.equal(
  packageManifest.scripts["test:migration-ledger"],
  "node --test scripts/lib/reviewed-migration-ledger.test.mjs && node infra/tests/reviewed-migration-ledger-registration.test.mjs",
);
assert.equal(
  packageManifest.scripts.check
    .split(" && ")
    .filter((command) => command === "npm run test:migration-ledger").length,
  1,
  "npm run check must execute the migration-ledger gate exactly once",
);
assert.equal(
  workflow
    .split(/\r?\n/u)
    .filter((line) => line === "      - run: npm run test:migration-ledger")
    .length,
  1,
  "the application CI job must execute the migration-ledger gate exactly once",
);
assert.match(
  backupCiRegistration,
  /"npm run test:migration-ledger"/u,
  "the canonical application-job projection must register the ledger gate",
);

const toolingStage =
  dockerfile.match(
    /^FROM final-base AS tooling\n([\s\S]*?)(?=^FROM [^\n]+\n)/mu,
  )?.[0] ?? "";
const operationsStage =
  dockerfile.match(
    /^FROM worker AS operations\n([\s\S]*?)(?=^FROM [^\n]+\n)/mu,
  )?.[0] ?? "";
assert.match(
  toolingStage,
  /COPY --chown=node:node drizzle \.\/drizzle/u,
  "tooling image must carry the exact reviewed migration bytes",
);
assert.doesNotMatch(
  operationsStage,
  /COPY --chown=node:node drizzle \.\/drizzle/u,
  "operations image must not duplicate repository migration bytes",
);
for (const [stage, label] of [
  [toolingStage, "tooling"],
  [operationsStage, "operations"],
]) {
  assert.match(
    stage,
    /scripts\/lib\/reviewed-migration-ledger\.mjs/u,
    `${label} image must carry the single canonical ledger contract`,
  );
}
assert.match(
  backupProductionE2e,
  /docker run --rm --pull never --network none --read-only --cap-drop ALL[\s\S]*?--entrypoint node "\$operations_digest"[\s\S]*?bootstrap-database-roles\.mjs[\s\S]*?offline operations image cannot import the ledger-gated bootstrap/u,
  "the real operations image must prove the ledger-gated bootstrap imports offline",
);
assert.match(
  backupProductionE2e,
  /--user 1000:1000/u,
  "the offline operations import proof must run as the image user",
);

for (const source of [bootstrap, migration]) {
  assert.match(
    source,
    /from "\.\/lib\/reviewed-migration-ledger\.mjs"/u,
    "database mutation entrypoints must import the canonical ledger contract",
  );
}

const bootstrapRun =
  bootstrap.match(
    /export async function runDatabaseRoleBootstrap\(options\) \{([\s\S]*?)\n\}/u,
  )?.[1] ?? "";
const bootstrapAppliedIndex = bootstrapRun.indexOf(
  "verifyAppliedMigrationLedger(",
);
const bootstrapInventoryIndex = bootstrapRun.indexOf("loadOwnershipInventory(");
const bootstrapRoleRepairIndex = bootstrapRun.indexOf("createAndResetRoles(");
assert.doesNotMatch(
  bootstrapRun,
  /verifyReviewedMigrationRepository/u,
  "operations bootstrap must consume the canonical DB ledger without repository files",
);
assert.ok(bootstrapAppliedIndex >= 0);
assert.ok(bootstrapInventoryIndex > bootstrapAppliedIndex);
assert.ok(bootstrapRoleRepairIndex > bootstrapInventoryIndex);
assert.match(
  bootstrapRun,
  /verifyAppliedMigrationLedger\(client,\s*\{\s*requireComplete:\s*requireCompleteMigrationLedger,\s*\}\)/u,
);
assert.ok(
  bootstrapRun.indexOf(
    "verifyPostMigrationReviewedContractsBeforeReconciliation(",
  ) > bootstrapAppliedIndex,
  "the exact 0062–0066 phase verifier must remain after the full-ledger preflight",
);
assert.ok(
  bootstrapRun.indexOf("reconcileDatabaseRolePrivileges(") >
    bootstrapRoleRepairIndex,
);

const migrationRun =
  migration.match(
    /export async function runProductionMigration\(options\) \{([\s\S]*?)\n\}/u,
  )?.[1] ?? "";
const migrationRepositoryIndex = migrationRun.indexOf(
  "verifyReviewedMigrationRepository(",
);
const migrationPrefixIndex = migrationRun.indexOf(
  "verifyAppliedMigrationLedger(",
);
const assumeOwnerIndex = migrationRun.indexOf(
  'client.query("SET ROLE learncoding_owner")',
);
const migrateIndex = migrationRun.indexOf("await migrate(");
const migrationFullIndex = migrationRun.indexOf("requireComplete: true");
assert.ok(migrationRepositoryIndex >= 0);
assert.match(
  migrationRun,
  /verifyReviewedMigrationRepository\(\{\s*drizzleDirectory:\s*migrationsFolder,?\s*\}\)/u,
);
assert.ok(assumeOwnerIndex > migrationRepositoryIndex);
assert.ok(migrationPrefixIndex > assumeOwnerIndex);
assert.ok(migrateIndex > migrationPrefixIndex);
assert.ok(migrationFullIndex > migrateIndex);

const releaseBootstrapCalls = [
  ...release.matchAll(/^\s*run_one_shot database-role-bootstrap$/gmu),
].map((match) => match.index);
assert.equal(releaseBootstrapCalls.length, 2);
const releaseMigrateIndex = release.indexOf("run_one_shot migrate");
assert.ok(releaseBootstrapCalls[0] < releaseMigrateIndex);
assert.ok(releaseBootstrapCalls[1] > releaseMigrateIndex);
assert.match(
  release,
  /REQUIRE_COMPLETE_MIGRATION_LEDGER=true\s*\\\s*\n\s*run_one_shot database-role-bootstrap/u,
);

const restoreBootstrapCalls = [
  ...restore.matchAll(/^\s*restore_one_shot database-role-bootstrap$/gmu),
].map((match) => match.index);
assert.equal(restoreBootstrapCalls.length, 2);
const restoreMutationIndex = restore.indexOf("exec pg_restore ");
assert.ok(restoreBootstrapCalls[0] < restoreMutationIndex);
assert.ok(restoreBootstrapCalls[1] > restoreMutationIndex);
assert.match(
  restore,
  /REQUIRE_COMPLETE_MIGRATION_LEDGER=true\s*\\\s*\n\s*restore_one_shot database-role-bootstrap/u,
);
assert.ok(
  restore.indexOf("restore_one_shot database-boundary-verifier") >
    restoreBootstrapCalls[1],
);

console.log("reviewed-migration-ledger-registration-tests-ok");
