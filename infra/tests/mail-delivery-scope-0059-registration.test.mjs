#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relativePath) =>
  readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");

const packageManifest = JSON.parse(read("package.json"));
const workflow = read(".github/workflows/ci.yml");
const scripts = packageManifest.scripts;

const registrationScript = "test:mail-delivery-scope-0059:registration";
const harnessScript = "test:mail-delivery-scope-0059";
const registrationCommand =
  "node infra/tests/mail-delivery-scope-0059-registration.test.mjs";
const harnessCommand =
  "node infra/tests/mail-delivery-scope-0059.integration.mjs";

assert.equal(
  scripts[registrationScript],
  registrationCommand,
  "package.json must expose the mail-scope registration guard",
);
assert.equal(
  scripts[harnessScript],
  harnessCommand,
  "package.json must expose the real PostgreSQL 18 mail-scope harness",
);

const checkCommands = scripts.check.split(" && ");
assert.equal(
  checkCommands.filter((command) =>
    command === `npm run ${registrationScript}`).length,
  1,
  "npm run check must execute the mail-scope registration guard exactly once",
);

const postgresJob = workflow.match(
  /^  postgres-integration:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/mu,
)?.[0] ?? "";

assert.match(
  postgresJob,
  /^  postgres-integration:\n    runs-on: ubuntu-24\.04\n/mu,
  "the mail-scope gate must remain in the Ubuntu PostgreSQL integration job",
);
assert.doesNotMatch(
  postgresJob,
  /^    (?:if|needs):/mu,
  "the PostgreSQL integration job must remain an unconditional independent gate",
);
assert.doesNotMatch(
  postgresJob,
  /continue-on-error:/u,
  "the mail-scope gate must never become advisory",
);

for (const command of [
  `npm run ${registrationScript}`,
  `POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run ${harnessScript}`,
]) {
  assert.equal(
    workflow.split(`      - run: ${command}`).length,
    2,
    `CI command must appear exactly once: ${command}`,
  );
}

for (const requiredSetup of [
  "https://www.postgresql.org/media/keys/ACCC4CF8.asc",
  "B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8",
  "URIs: https://apt.postgresql.org/pub/repos/apt",
  "Suites: noble-pgdg",
  "Signed-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc",
  "sudo apt-get install --yes --no-install-recommends postgresql-18",
]) {
  assert.equal(
    postgresJob.split(requiredSetup).length,
    2,
    `PostgreSQL 18 setup is missing or ambiguous: ${requiredSetup}`,
  );
}

const installIndex = postgresJob.indexOf(
  "sudo apt-get install --yes --no-install-recommends postgresql-18",
);
const registrationIndex = postgresJob.indexOf(
  `      - run: npm run ${registrationScript}`,
);
const harnessIndex = postgresJob.indexOf(
  `      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run ${harnessScript}`,
);

assert.ok(registrationIndex >= 0, "the registration guard must run in CI");
assert.ok(
  installIndex > registrationIndex,
  "the lightweight registration guard must run before PostgreSQL installation",
);
assert.ok(
  harnessIndex > installIndex,
  "the real mail-scope harness must run after PostgreSQL 18 is installed",
);

console.log("mail-delivery-scope-0059-registration-tests-ok");
