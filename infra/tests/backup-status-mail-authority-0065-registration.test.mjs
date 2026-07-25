#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relativePath) =>
  readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");

const packageManifest = JSON.parse(read("package.json"));
const workflow = read(".github/workflows/ci.yml");
const harnessSource = read(
  "infra/tests/backup-status-mail-authority-0065.integration.mjs",
);
const scripts = packageManifest.scripts;
const registrationScript =
  "test:backup-status-mail-authority-0065:registration";
const harnessScript = "test:backup-status-mail-authority-0065";
const registrationCommand =
  "node infra/tests/backup-status-mail-authority-0065-registration.test.mjs";
const harnessCommand =
  "node infra/tests/backup-status-mail-authority-0065.integration.mjs";
const pg17Command =
  `BACKUP_STATUS_POSTGRES_BIN=/usr/lib/postgresql/17/bin BACKUP_STATUS_POSTGRES_MAJOR=17 npm run ${harnessScript}`;
const pg18Command =
  `BACKUP_STATUS_POSTGRES_BIN=/usr/lib/postgresql/18/bin BACKUP_STATUS_POSTGRES_MAJOR=18 npm run ${harnessScript}`;

assert.equal(scripts[registrationScript], registrationCommand);
assert.equal(scripts[harnessScript], harnessCommand);
assert.equal(
  scripts.check.split(" && ").filter(
    (command) => command === `npm run ${registrationScript}`,
  ).length,
  1,
  "npm run check must execute the 0065 registration guard exactly once",
);

const postgresJob = workflow.match(
  /^  postgres-integration:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/mu,
)?.[0] ?? "";
assert.match(postgresJob, /runs-on: ubuntu-24\.04/u);
assert.doesNotMatch(postgresJob, /continue-on-error:/u);
assert.match(
  postgresJob,
  /sudo apt-get install --yes --no-install-recommends postgresql-17/u,
);
assert.match(
  postgresJob,
  /sudo apt-get install --yes --no-install-recommends postgresql-18/u,
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
const pg18Index = postgresJob.indexOf(`      - run: ${pg18Command}`);
assert.ok(registrationIndex >= 0 && registrationIndex < pg17Index);
assert.ok(
  pg17Index < pg18Index,
  "the production-pinned PostgreSQL 17 proof must run before targeted PG18",
);
assert.doesNotMatch(
  postgresJob.slice(pg17Index, pg18Index),
  /(?:&|parallel|concurrently)\s+.*backup-status/iu,
  "the two live database proofs must remain sequential",
);
assert.doesNotMatch(
  `${postgresJob}\n${harnessCommand}`,
  /postgres(?:ql)?[-_: ]*16|\b16\/18\b/iu,
  "0065 must not substitute PostgreSQL 16 for production-pinned 17",
);
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
assert.match(harnessSource, /serverStartAttempted && existsSync\(postmasterPid\)/u);
assert.match(harnessSource, /"--no-wait",\s*"start"/u);
assert.match(harnessSource, /await waitForPostgres\(port\);/u);
assert.match(harnessSource, /stdio: options\.stdio \?\? "pipe"/u);
assert.match(harnessSource, /BACKUP_STATUS_POSTGRES_PORT/u);
assert.match(harnessSource, /assert\.notEqual\(port, 5432/u);
assert.match(harnessSource, /SHOW server_version_num/u);

console.log("backup-status-mail-authority-0065-registration-tests-ok");
