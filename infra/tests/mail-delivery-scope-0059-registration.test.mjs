#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertMailDeliveryScope0059PostgresProjection } from "./mail-delivery-scope-0059-ci-contract.mjs";

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

assertMailDeliveryScope0059PostgresProjection(postgresJob);

for (const command of [
  `npm run ${registrationScript}`,
  `POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run ${harnessScript}`,
]) {
  assert.equal(
    workflow.split(`      - run: ${command}`).length,
    2,
    `CI command must appear exactly once in the workflow: ${command}`,
  );
}

console.log("mail-delivery-scope-0059-registration-tests-ok");
