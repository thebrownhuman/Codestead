#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relativePath) =>
  readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");

const packageManifest = JSON.parse(read("package.json"));
const workflow = read(".github/workflows/ci.yml");
const runner = read("scripts/run-full-schema-restore-gate.ts");
const archiveHelper = read("scripts/lib/full-schema-restore-archive.ts");
const lifecycleHelper = read("scripts/lib/full-schema-restore-lifecycle.ts");
const runtimeHelper = read("scripts/lib/full-schema-restore-runtime.ts");
const scripts = packageManifest.scripts;

const registrationScript = "test:full-schema-restore:registration";
const primaryScript = "test:full-schema-restore";
const registrationCommand =
  "node infra/tests/full-schema-restore-registration.test.mjs";
const primaryCommand = "tsx scripts/run-full-schema-restore-gate.ts";
const pg17Command = `npm run ${primaryScript} -- --postgres-major=17`;
const pg18Command = `npm run ${primaryScript} -- --postgres-major=18`;

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
assert.doesNotMatch(postgresJob, /continue-on-error:/u);

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
  "sudo apt-get install --yes --no-install-recommends postgresql-18",
);
const pg18Index = postgresJob.indexOf(`      - run: ${pg18Command}`);
assert.ok(registrationIndex >= 0);
assert.ok(registrationIndex < pg17Index);
assert.ok(pg17Index < installPg18Index);
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
assert.match(runner, /createDisposableIntegrationChildController/u);
assert.match(runner, /buildDisposableIntegrationChildLaunch/u);
assert.match(runner, /runFullSchemaArchiveDump/u);
assert.match(runner, /runFullSchemaArchiveRestore/u);
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
assert.doesNotMatch(runner, /\bfetch\s*\(|gmail|oauth/iu);
assert.doesNotMatch(
  runner,
  /console\.(?:error|info|log)\([^)]*(?:error|password|recipient|message)/iu,
  "runner logs must remain fixed-code and non-PII",
);

console.log("full-schema-restore-registration-tests-ok");
