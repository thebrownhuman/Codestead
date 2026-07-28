#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assertMailDispatchBinding0064PostgresProjection,
  mailDispatchBinding0064CiContract,
} from "./mail-dispatch-binding-0064-ci-contract.mjs";
import {
  projectHistoricalPostgresCiProjection,
} from "./mail-guarded-delivery-0069-ci-contract.mjs";

const allocatorProbePath = fileURLToPath(
  new URL(
    "../../scripts/__tests__/disposable-loopback-port-native-probe.mjs",
    import.meta.url,
  ),
);
const read = (relativePath) =>
  readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");

const packageManifest = JSON.parse(read("package.json"));
const workflow = read(".github/workflows/ci.yml");
const journal = JSON.parse(read("drizzle/meta/_journal.json"));
const migrationNames = readdirSync(
  new URL("../../drizzle", import.meta.url),
).filter((name) => /^\d{4}_.+\.sql$/u.test(name));
const migration = read("drizzle/0064_mail_outbox_dispatch_binding.sql");
const snapshot = JSON.parse(read("drizzle/meta/0064_snapshot.json"));
const sharedPostgresContainerUrl = new URL(
  "../../scripts/lib/disposable-postgres-container.ts",
  import.meta.url,
);
const sharedPostgresContainerPresent = existsSync(sharedPostgresContainerUrl);
const postgresImageAuthority = sharedPostgresContainerPresent
  ? read("scripts/lib/disposable-postgres-container.ts")
  : read("scripts/run-integration-tests.ts");
const vitestIntegration = read("vitest.integration.config.ts");
const pinnedPg17Test = read(
  "integration/mail-dispatch-binding-0064.integration.test.ts",
);
const pg18Harness = read(
  "infra/tests/mail-dispatch-binding-0064.integration.mjs",
);
const scripts = packageManifest.scripts;

const harnessMainStart = pg18Harness.indexOf("async function main()");
assert.ok(harnessMainStart >= 0);
const harnessMainBody = pg18Harness.slice(harnessMainStart);
const temporaryRootIndex = harnessMainBody.indexOf(
  "const temporaryRoot = mkdtempSync",
);
const topLevelTryIndex = harnessMainBody.indexOf("try {", temporaryRootIndex);
const temporaryRootStatementEnd =
  harnessMainBody.indexOf(");", temporaryRootIndex) + 2;
assert.ok(temporaryRootIndex >= 0 && topLevelTryIndex > temporaryRootIndex);
assert.ok(temporaryRootStatementEnd > temporaryRootIndex);
assert.equal(
  harnessMainBody
    .slice(temporaryRootStatementEnd, topLevelTryIndex)
    .trim(),
  "",
  "the 0064 top-level try must begin literally immediately after mkdtemp",
);
for (const fallibleMarker of [
  'path.join(temporaryRoot, "data")',
  'path.join(temporaryRoot, "socket")',
  "mkdirSync(socketDirectory)",
  'path.join(temporaryRoot, "postgres.log")',
  "stagedMigrationsThrough(temporaryRoot, 61)",
  "prefixMigrationVerifier(61)",
  "allocateDisposableLoopbackPort()",
]) {
  const markerIndex = harnessMainBody.indexOf(
    fallibleMarker,
    temporaryRootIndex,
  );
  assert.ok(
    markerIndex > topLevelTryIndex,
    `${fallibleMarker} must be inside the 0064 top-level try/finally`,
  );
}

const {
  registrationScript,
  roleContractScript,
  pg17Script,
  pg18Script,
  registrationCommand,
  roleContractCommand,
  nativeHarnessCommand,
} = mailDispatchBinding0064CiContract;

assert.equal(scripts[registrationScript], registrationCommand);
assert.equal(scripts[roleContractScript], roleContractCommand);
assert.equal(scripts[pg17Script], nativeHarnessCommand);
assert.equal(scripts[pg18Script], nativeHarnessCommand);
for (const script of [registrationScript, roleContractScript]) {
  assert.equal(
    scripts.check
      .split(" && ")
      .filter((command) => command === `npm run ${script}`).length,
    1,
    `npm run check must execute ${script} exactly once`,
  );
}

const through0064 = migrationNames
  .filter((name) => Number.parseInt(name.slice(0, 4), 10) <= 64)
  .sort();
assert.equal(through0064.length, 65);
through0064.forEach((name, expectedIndex) => {
  assert.equal(
    Number.parseInt(name.slice(0, 4), 10),
    expectedIndex,
    `migration sequence is not contiguous at ${name}`,
  );
});
assert.deepEqual(
  through0064.filter((name) => name.startsWith("0064_")),
  ["0064_mail_outbox_dispatch_binding.sql"],
);

const journalThrough0064 = journal.entries
  .filter((entry) => entry.idx <= 64)
  .sort((left, right) => left.idx - right.idx);
assert.equal(journalThrough0064.length, 65);
journalThrough0064.forEach((entry, expectedIndex) => {
  assert.equal(entry.idx, expectedIndex);
  assert.equal(
    `${entry.tag}.sql`,
    through0064[expectedIndex],
    `journal tag does not name migration ${through0064[expectedIndex]}`,
  );
});
assert.deepEqual(
  journal.entries.filter((entry) => entry.idx === 64).map((entry) => entry.tag),
  ["0064_mail_outbox_dispatch_binding"],
);

assert.equal(
  snapshot.prevId,
  "d2a68a3d-c790-4f56-b83e-7c7ba0eb6d68",
  "0064 snapshot must descend from the latest structural snapshot 0060",
);
assert.match(
  migration,
  /LOCK TABLE public\.email_outbox IN ACCESS EXCLUSIVE MODE/u,
);
assert.match(migration, /dispatch_binding_version/u);
assert.match(migration, /dispatch_binding_sha256/u);
assert.match(migration, /SECURITY INVOKER[\s\S]*SET search_path = pg_catalog/u);

assert.match(
  postgresImageAuthority,
  /postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193/u,
  "the production-primary integration runner must remain pinned to PG17",
);
assert.doesNotMatch(
  postgresImageAuthority,
  /postgres:16(?:-|@|")/u,
  "the dispatch-binding matrix must not substitute PostgreSQL 16 for production-pinned 17",
);
if (sharedPostgresContainerPresent) {
  assert.match(
    postgresImageAuthority,
    /export const POSTGRES_17_INTEGRATION_IMAGE/u,
  );
  assert.match(
    postgresImageAuthority,
    /export const POSTGRES_18_INTEGRATION_IMAGE[\s\S]*postgres:18-alpine@sha256:[0-9a-f]{64}/u,
    "the shared disposable authority must retain the targeted PostgreSQL 18 image",
  );
}
assert.match(
  vitestIntegration,
  /integration\/\*\*\/\*\.integration\.test\.ts/u,
  "the PG17 integration suite must auto-discover 0064",
);
assert.ok(
  existsSync(
    new URL(
      "../../integration/mail-dispatch-binding-0064.integration.test.ts",
      import.meta.url,
    ),
  ),
);
assert.match(pinnedPg17Test, /production-pinned PostgreSQL 17/u);
assert.match(pinnedPg17Test, /server_version_num/u);
assert.match(pg18Harness, /exactly one of POSTGRES_17_BIN or POSTGRES_18_BIN/u);
assert.match(pg18Harness, /POSTGRES_17_BIN/u);
assert.match(pg18Harness, /POSTGRES_18_BIN/u);
assert.match(pg18Harness, /\/\^\(\?:17\|18\)\$\//u);
assert.match(pg18Harness, /current_setting\('server_version_num'\)/u);
assert.match(pg18Harness, /escapedPostgresMajor/u);
assert.match(
  pg18Harness,
  /stagedMigrationsThrough\(temporaryRoot, 61\)/u,
);
assert.match(
  pg18Harness,
  /stagedMigrationsThrough\(temporaryRoot, 64\)/u,
);
assert.equal(
  pg18Harness.split("migrationsFolder: stagedMigrations0064").length - 1,
  3,
);
assert.doesNotMatch(pg18Harness, /migrationsFolder: migrationDirectory/u);
for (const helper of [
  "globalDefaultAclScrubSql",
  "managedColumnAclScrubSql",
  "mailWorkerOutboxPrivilegesSql",
]) {
  assert.match(pg18Harness, new RegExp(`${helper}\\(\\)`, "u"));
}
assert.doesNotMatch(pg18Harness, /runDatabaseRoleBootstrap/u);
assert.match(
  pg18Harness,
  /globalDefaultAclScrubSql\(\)[\s\S]*?migrationsFolder: stagedMigrations0061[\s\S]*?"62"[\s\S]*?reconcileHistoricalBaselineRewardPrivileges\(adminConnectionString\)[\s\S]*?managedColumnAclScrubSql\(\)[\s\S]*?mailWorkerOutboxPrivilegesSql\(\)[\s\S]*?migrationsFolder: stagedMigrations0062[\s\S]*?verifyRawReviewedPhase\([\s\S]*?REVIEWED_PHASE_0062/u,
  "0064 must prove default ACL hardening -> 0061 -> exact table/column ACLs -> 0062 -> raw phase-0062 verification",
);
assert.match(
  pg18Harness,
  /verifyAndRepairReviewedBaselineRewardRoutinePrivileges/u,
);
assert.doesNotMatch(
  pg18Harness,
  /verifyAndRepairReviewedPhaseRoutinePrivileges/u,
);
const rawReviewedPhaseBody = pg18Harness.match(
  /async function verifyRawReviewedPhase\([^)]*\) \{([\s\S]*?)\n\}/u,
)?.[1];
assert.equal(typeof rawReviewedPhaseBody, "string");
assert.doesNotMatch(
  rawReviewedPhaseBody,
  /verifyAndRepairReviewed/u,
  "raw reviewed-phase verification must not repair ACL drift first",
);
assert.match(
  pg18Harness,
  /verifyRawReviewedPhase\(connectionString, expectedPhase\)/u,
);
assert.doesNotMatch(
  pg18Harness,
  /verifyRawReviewedPhase\(connectionString,\s*expectedPhase\s*=/u,
);
for (const phaseName of [
  "REVIEWED_PHASE_0062",
  "REVIEWED_PHASE_0063",
  "REVIEWED_PHASE_0064",
]) {
  assert.match(
    pg18Harness,
    new RegExp(
      `verifyRawReviewedPhase\\([\\s\\S]*?${phaseName}`,
      "u",
    ),
  );
}
assert.match(
  pg18Harness,
  /\.\.\/\.\.\/scripts\/lib\/disposable-loopback-port\.mjs/u,
);
assert.doesNotMatch(pg18Harness, /net\.createServer|unusedLoopbackPort/u);
assert.match(pg18Harness, /not\s*(?:\r?\n\s*\/\/\s*)?byte-pinned/u);

const allocatorProbe = spawnSync(process.execPath, [allocatorProbePath], {
  encoding: "utf8",
  env: {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  },
  timeout: 10_000,
  windowsHide: true,
});
assert.equal(allocatorProbe.status, 0, "native allocator import probe failed");
const allocatorEvidence = JSON.parse(allocatorProbe.stdout);
assert.equal(allocatorEvidence.deterministicPort, 54_321);
assert.notEqual(allocatorEvidence.kernelAssignedPort, 5432);
assert.match(
  allocatorEvidence.modulePath,
  /scripts\/lib\/disposable-loopback-port\.mjs$/u,
);

const currentPostgresJob =
  workflow.match(
    /^  postgres-integration:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/mu,
  )?.[0] ?? "";
const postgresJob =
  projectHistoricalPostgresCiProjection(currentPostgresJob);
assert.doesNotThrow(
  () => assertMailDispatchBinding0064PostgresProjection(postgresJob),
  "the historical 0064 contract must accept ordered 0065-0067 suffixes",
);

const replaceProjectionExactly = (projection, before, after) => {
  assert.equal(
    projection.split(before).length,
    2,
    `0064 mutation anchor must be unique: ${before}`,
  );
  return projection.replace(before, after);
};
const expectHistoricalProjectionRejected = (
  label,
  projection,
  expectedMessage,
) => {
  assert.throws(
    () => assertMailDispatchBinding0064PostgresProjection(projection),
    expectedMessage,
    label,
  );
};
const registration0064Line =
  "      - run: npm run test:mail-dispatch-binding-0064:registration";
const registration0066Line =
  "      - run: npm run test:mail-provider-correlation-0066:registration";
const registration0067Line =
  "      - run: npm run test:mail-durable-replay-0067:registration";
const role0064Line =
  "      - run: npm run test:mail-dispatch-binding-0064:roles";

expectHistoricalProjectionRejected(
  "0064 cannot hide an earlier registration dependency",
  replaceProjectionExactly(
    postgresJob,
    "      - run: npm run test:mail-retention-redaction-0063:registration\n",
    "",
  ),
  /historical prefix/u,
);
expectHistoricalProjectionRejected(
  "an older migration cannot be inserted after the 0064 prefix",
  replaceProjectionExactly(
    postgresJob,
    registration0064Line,
    [
      registration0064Line,
      "      - run: npm run test:hostile-mail-authority-0062:registration",
    ].join("\n"),
  ),
  /suffix migrations must be strictly later and ordered/u,
);
expectHistoricalProjectionRejected(
  "0064 reviewed suffix registrations cannot be reordered",
  replaceProjectionExactly(
    postgresJob,
    [registration0066Line, registration0067Line].join("\n"),
    [registration0067Line, registration0066Line].join("\n"),
  ),
  /suffix migrations must be strictly later and ordered/u,
);
expectHistoricalProjectionRejected(
  "the 0064 role contract must remain exact-once",
  replaceProjectionExactly(
    postgresJob,
    role0064Line,
    [role0064Line, role0064Line].join("\n"),
  ),
  /must appear exactly once/u,
);

console.log("mail-dispatch-binding-0064-registration-tests-ok");
