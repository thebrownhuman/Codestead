#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relativePath) =>
  readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");

const packageManifest = JSON.parse(read("package.json"));
const workflow = read(".github/workflows/ci.yml");
const runner = read("scripts/run-full-schema-restore-gate.ts");
const archiveHelper = read("scripts/lib/full-schema-restore-archive.ts");
const databaseHelper = read("scripts/lib/full-schema-restore-database.ts");
const gateHelper = read("scripts/lib/full-schema-restore-gate.ts");
const lifecycleHelper = read("scripts/lib/full-schema-restore-lifecycle.ts");
const runtimeHelper = read("scripts/lib/full-schema-restore-runtime.ts");
const ledgerHelper = read("scripts/lib/restore-migration-ledger.mjs");
const preRepairVerifier = read(
  "scripts/verify-pre-repair-restored-database.mjs",
);
const dockerfile = read("Dockerfile");
const scripts = packageManifest.scripts;
const restoreExtensionModule = await import(
  "./full-schema-restore-postgres-ci-extension.mjs",
).catch(() => null);

const registrationScript = "test:full-schema-restore:registration";
const primaryScript = "test:full-schema-restore";
const pg17Script = "test:full-schema-restore:pg17";
const pg18Script = "test:full-schema-restore:pg18";
const registrationCommand =
  "node infra/tests/full-schema-restore-registration.test.mjs";
const primaryCommand = "tsx scripts/run-full-schema-restore-gate.ts";
const pg17ScriptCommand = `${primaryCommand} --postgres-major=17`;
const pg18ScriptCommand = `${primaryCommand} --postgres-major=18`;
const pg17Command =
  `POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run ${pg17Script}`;
const pg18Command =
  `POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run ${pg18Script}`;

assert.equal(
  scripts[registrationScript],
  registrationCommand,
  "package.json must expose the full-schema restore registration guard",
);
assert.equal(
  scripts[primaryScript],
  primaryCommand,
  "package.json must expose the real full-schema restore verifier",
);
assert.equal(
  scripts[pg17Script],
  pg17ScriptCommand,
  "package.json must expose the production-pinned PG17 restore verifier",
);
assert.equal(
  scripts[pg18Script],
  pg18ScriptCommand,
  "package.json must expose the targeted PG18 restore verifier",
);
assert.notEqual(
  restoreExtensionModule,
  null,
  "restore registration must expose a canonical PostgreSQL CI extension",
);
const extensionSentinel = Object.freeze({ kind: "canonical-extension" });
let receivedExtensionInput = null;
const extensionResult =
  restoreExtensionModule.defineFullSchemaRestorePostgresCiExtension((input) => {
    receivedExtensionInput = input;
    return extensionSentinel;
  });
assert.equal(extensionResult, extensionSentinel);
assert.deepEqual(receivedExtensionInput, {
  id: "full-schema-restore",
  kind: "restore",
  registrationScripts: [registrationScript],
  productionPg17Scripts: [pg17Script],
  targetedPg18Scripts: [pg18Script],
  minimumTimeoutMinutes: 35,
});

const checkCommands = scripts.check.split(" && ");
assert.equal(
  checkCommands.filter((command) =>
    command === `npm run ${registrationScript}`).length,
  1,
  "npm run check must execute the restore registration guard exactly once",
);

const postgresJob = workflow.match(
  /^  postgres-integration:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/mu,
)?.[0] ?? "";
assert.match(
  postgresJob,
  /^  postgres-integration:\n    runs-on: ubuntu-24\.04\n/mu,
);
assert.match(
  postgresJob,
  /^    timeout-minutes: 35$/mu,
);
assert.doesNotMatch(postgresJob, /continue-on-error:/u);
assert.deepEqual(
  postgresJob.match(/^      - run: docker pull postgres:\S+$/gmu) ?? [],
  [
    "      - run: docker pull postgres:17-bookworm@sha256:4f736ae292687621d4be0d499ffd024a36bd2ee7d8ca6f2ccd4c800f047b394",
  ],
  "restore registration must preserve the single canonical PostgreSQL pull",
);
assert.doesNotMatch(
  postgresJob,
  /docker pull postgres:(?:17|18)-alpine/iu,
  "restore registration must not create a second PostgreSQL image authority",
);

for (const command of [
  `npm run ${registrationScript}`,
  pg17Command,
  pg18Command,
]) {
  assert.equal(
    workflow.split(`      - run: ${command}`).length,
    2,
    `CI command must appear exactly once: ${command}`,
  );
}

const registrationIndex = postgresJob.indexOf(
  `      - run: npm run ${registrationScript}`,
);
const pg17Index = postgresJob.indexOf(`      - run: ${pg17Command}`);
const installPg18Index = postgresJob.indexOf(
  "sudo apt-get install --yes --no-install-recommends postgresql-17 postgresql-18",
);
const pg18Index = postgresJob.indexOf(`      - run: ${pg18Command}`);
assert.ok(registrationIndex >= 0);
assert.ok(registrationIndex < installPg18Index);
assert.ok(installPg18Index < pg17Index);
assert.ok(pg17Index < pg18Index);
assert.ok(installPg18Index < pg18Index);
assert.doesNotMatch(
  postgresJob.slice(pg17Index, pg18Index),
  /(?:&|parallel|concurrently)\s+.*full-schema-restore/iu,
  "the PG17 and targeted PG18 restore gates must remain sequential",
);

assert.match(
  runner,
  /POSTGRES_17_INTEGRATION_IMAGE/u,
  "the runner must select the reviewed pinned PG17 image",
);
assert.match(
  runner,
  /POSTGRES_18_INTEGRATION_IMAGE/u,
  "the runner must select the reviewed targeted PG18 image",
);
assert.match(runner, /runFullSchemaRestoreVerification/u);
assert.match(runner, /seedRepresentativeMailAuthorityRows/u);
assert.match(runner, /collectFullSchemaRestoreSnapshot/u);
assert.match(runner, /runFullSchemaRestoreDatabaseSmoke/u);
assert.match(runner, /verifyDisposableIntegrationRoleBoundaries/u);
assert.match(runner, /requireOwnedRestoreContainerId/u);
assert.match(runner, /buildPostgresArchiveCommands/u);
assert.match(runner, /deriveMigrationLedgerContract/u);
assert.match(runner, /databaseBackupReporterUrl/u);
assert.match(runner, /createSafeFullSchemaRestoreTaskRoot/u);
assert.match(runner, /createFullSchemaRestoreLifecycle/u);
assert.match(runner, /verifyPostMigrationReviewedContractsBeforeReconciliation/u);
assert.match(
  runner,
  /verifyReviewedMailAuthorityCatalogContracts/u,
);
assert.match(runner, /requireExactFullSchemaRestoreOwnerRole/u);
assert.match(runner, /requireFullSchemaAclSuppressionControl/u);
assert.match(runner, /restoreTargetWithoutAcl/u);
assert.match(runner, /resetAfterAclSuppressionControl/u);
assert.match(runner, /requireRestoreDatabaseIdentifier/u);
assert.match(runner, /drop database "\$\{database\}" with \(force\)/u);
assert.match(
  runner,
  /create database "\$\{database\}" owner learncoding_owner/u,
);
assert.match(runner, /aclSuppressionControlPublicExecute/u);
assert.match(runner, /createDisposableIntegrationChildController/u);
assert.match(runner, /buildDisposableIntegrationChildLaunch/u);
assert.match(runner, /runFullSchemaArchiveDump/u);
assert.match(runner, /runFullSchemaArchiveList/u);
assert.match(runner, /runFullSchemaArchiveRestore/u);
assert.match(archiveHelper, /deriveFullSchemaArchiveEvidence/u);
assert.match(runner, /lifecycle\.ownContainer\("source", source\)/u);
assert.match(runner, /lifecycle\.ownContainer\("target", target\)/u);
assert.match(
  runner,
  /\.\/lib\/disposable-integration-child-controller/u,
);
assert.match(
  runner,
  /\.\/lib\/disposable-integration-child-launch/u,
);
assert.match(runner, /archive\.fill\(0\)/u);
assert.equal(
  runner.match(/\bspawnSync\(/gu)?.length,
  1,
  "the only synchronous child call must remain the Docker identity probe",
);
assert.doesNotMatch(runner, /function runArchiveDump/u);
assert.doesNotMatch(runner, /function runArchiveRestore/u);
assert.equal(
  runner.match(/address\.port === 5432/gu)?.length,
  1,
  "the sole host-port allocator must reject PostgreSQL's default port",
);
assert.match(runner, /const sourcePort = await availablePort\(\)/u);
assert.match(runner, /let targetPort = await availablePort\(\)/u);
assert.match(
  runner,
  /while \(targetPort === sourcePort\) targetPort = await availablePort\(\)/u,
);
assert.doesNotMatch(
  runner,
  /Buffer\.from\(result\.stdout\)/u,
);
assert.match(archiveHelper, /controller\.spawnAndTrack/u);
assert.match(archiveHelper, /result\.stdout\.fill\(0\)/u);
const childCleanupIndex = lifecycleHelper.indexOf(
  "await input.childController.terminateAndWait(signal)",
);
const targetCleanupIndex = lifecycleHelper.indexOf("target?.cleanup");
const sourceCleanupIndex = lifecycleHelper.indexOf("source?.cleanup");
const rootCleanupIndex = lifecycleHelper.indexOf("taskRootCleanup,");
assert.ok(childCleanupIndex >= 0);
assert.ok(childCleanupIndex < targetCleanupIndex);
assert.ok(targetCleanupIndex < sourceCleanupIndex);
assert.ok(sourceCleanupIndex < rootCleanupIndex);
assert.match(runtimeHelper, /input\.ownTaskRoot\(cleanup\)/u);
assert.match(runtimeHelper, /restoreWithoutAcl/u);
assert.match(runtimeHelper, /--role=learncoding_owner/u);
const runtimeWithoutControl = runtimeHelper.replace(
  /restoreWithoutAcl:[\s\S]*?\n    restore:/u,
  "restore:",
);
assert.doesNotMatch(runtimeWithoutControl, /--no-acl/u);
assert.match(databaseHelper, /pg_catalog\.aclexplode/u);
assert.match(databaseHelper, /acl\.grantee = 0/u);
assert.match(databaseHelper, /routine\.proacl is null/u);
assert.match(gateHelper, /await dependencies\.restoreTargetWithoutAcl\(archive\)/u);
assert.match(gateHelper, /await target\.verifyAclSuppressionControl\(\)/u);
assert.match(gateHelper, /await target\.resetAfterAclSuppressionControl\(\)/u);
assert.match(gateHelper, /await dependencies\.restoreTarget\(archive\)/u);
const withoutAclIndex = gateHelper.indexOf(
  "await dependencies.restoreTargetWithoutAcl(archive)",
);
const verifySuppressionIndex = gateHelper.indexOf(
  "await target.verifyAclSuppressionControl()",
);
const resetControlIndex = gateHelper.indexOf(
  "await target.resetAfterAclSuppressionControl()",
);
const reconcileAfterControlIndex = gateHelper.indexOf(
  "await target.reconcileRoles()",
  resetControlIndex,
);
const restoreWithAclIndex = gateHelper.indexOf(
  "await dependencies.restoreTarget(archive)",
);
assert.ok(withoutAclIndex < verifySuppressionIndex);
assert.ok(verifySuppressionIndex < resetControlIndex);
assert.ok(resetControlIndex < reconcileAfterControlIndex);
assert.ok(reconcileAfterControlIndex < restoreWithAclIndex);
assert.match(ledgerHelper, /journal\.entries\.length < MINIMUM_MIGRATION_COUNT/u);
assert.match(ledgerHelper, /migration\.hash::text as migration_sha256/u);
assert.match(ledgerHelper, /result\.rows\.length !== expected\.length/u);
assert.match(preRepairVerifier, /readCheckedInRestoreMigrationLedger/u);
assert.match(preRepairVerifier, /verifyRestoredMigrationLedger/u);
assert.match(
  preRepairVerifier,
  /verifyPostMigrationReviewedContractsBeforeReconciliation/u,
);
assert.match(
  preRepairVerifier,
  /verifyReviewedMailAuthorityCatalogContracts/u,
);
assert.match(dockerfile, /COPY --chown=node:node drizzle \.\/drizzle/u);
assert.match(
  dockerfile,
  /COPY --chown=node:node scripts\/lib\/restore-migration-ledger\.mjs/u,
);
assert.doesNotMatch(runner, /\bfetch\s*\(|gmail|oauth/iu);
assert.doesNotMatch(
  runner,
  /console\.(?:error|info|log)\([^)]*(?:error|password|recipient|message)/iu,
  "runner logs must remain fixed-code and non-PII",
);

console.log("full-schema-restore-registration-tests-ok");
