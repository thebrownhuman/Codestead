#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relativePath) =>
  readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");

const packageManifest = JSON.parse(read("package.json"));
const workflow = read(".github/workflows/ci.yml");
const scripts = packageManifest.scripts;

const registrationScript =
  "test:mail-payload-immutability-0060:registration";
const harnessScript = "test:mail-payload-immutability-0060";
const registrationCommand =
  "node infra/tests/mail-payload-immutability-0060-registration.test.mjs";
const harnessCommand =
  "node infra/tests/mail-payload-immutability-0060.integration.mjs";
const precedingHarness =
  "POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:mail-delivery-scope-0059";
const currentHarness =
  `POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run ${harnessScript}`;

assert.equal(
  scripts[registrationScript],
  registrationCommand,
  "package.json must expose the 0060/0062 registration guard",
);
assert.equal(
  scripts[harnessScript],
  harnessCommand,
  "package.json must expose the real PostgreSQL 18 payload/retention harness",
);

const checkCommands = scripts.check.split(" && ");
assert.equal(
  checkCommands.filter((command) =>
    command === `npm run ${registrationScript}`).length,
  1,
  "npm run check must execute the 0060/0062 registration guard exactly once",
);

const postgresJob = workflow.match(
  /^  postgres-integration:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/mu,
)?.[0] ?? "";

assert.match(
  postgresJob,
  /^  postgres-integration:\n    runs-on: ubuntu-24\.04\n/mu,
  "the 0060/0062 gate must remain in the PostgreSQL integration job",
);
assert.doesNotMatch(postgresJob, /continue-on-error:/u);

for (const command of [
  `npm run ${registrationScript}`,
  currentHarness,
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
const installIndex = postgresJob.indexOf(
  "sudo apt-get install --yes --no-install-recommends postgresql-18",
);
const precedingHarnessIndex = postgresJob.indexOf(
  `      - run: ${precedingHarness}`,
);
const currentHarnessIndex = postgresJob.indexOf(
  `      - run: ${currentHarness}`,
);

assert.ok(registrationIndex >= 0);
assert.ok(registrationIndex < installIndex);
assert.ok(installIndex < precedingHarnessIndex);
assert.ok(
  precedingHarnessIndex < currentHarnessIndex,
  "the two heavyweight PG18 harnesses must remain sequential standalone steps",
);
assert.doesNotMatch(
  postgresJob.slice(precedingHarnessIndex, currentHarnessIndex),
  /(?:&|parallel|concurrently)\s+.*mail-payload/iu,
  "the PG18 harnesses must not be parallelized",
);

console.log("mail-payload-immutability-0060-registration-tests-ok");
