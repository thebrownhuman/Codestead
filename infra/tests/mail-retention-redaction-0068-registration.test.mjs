#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assertMailRetentionRedaction0068PostgresProjection,
  mailRetentionRedaction0068CiContract,
} from "./mail-retention-redaction-0068-ci-contract.mjs";
import {
  projectHistoricalPostgresCiProjection,
} from "./mail-guarded-delivery-0069-ci-contract.mjs";

const read = (relativePath) =>
  readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
const readJson = (relativePath) => JSON.parse(read(relativePath));

const packageManifest = readJson("package.json");
const workflow = read(".github/workflows/ci.yml");
const journal = readJson("drizzle/meta/_journal.json");
const snapshot0067 = readJson("drizzle/meta/0067_snapshot.json");
const snapshot0068 = readJson("drizzle/meta/0068_snapshot.json");
const scripts = packageManifest.scripts;
const {
  registrationScript,
  writerInventoryScript,
  roleContractScript,
  pg17Script,
  pg18Script,
  registrationCommand,
  writerInventoryCommand,
  roleContractCommand,
  harnessCommand,
} = mailRetentionRedaction0068CiContract;

assert.equal(scripts[registrationScript], registrationCommand);
assert.equal(scripts[writerInventoryScript], writerInventoryCommand);
assert.equal(scripts[roleContractScript], roleContractCommand);
assert.equal(scripts[pg17Script], harnessCommand);
assert.equal(scripts[pg18Script], harnessCommand);

const checkCommands = scripts.check.split(" && ");
for (const script of [
  registrationScript,
  writerInventoryScript,
  roleContractScript,
]) {
  assert.equal(
    checkCommands.filter((command) => command === `npm run ${script}`).length,
    1,
    `npm run check must execute ${script} exactly once`,
  );
}
assert.ok(
  checkCommands.indexOf(`npm run ${registrationScript}`)
    > checkCommands.indexOf(
      "npm run test:mail-durable-replay-0067:registration",
    ),
);
assert.ok(
  checkCommands.indexOf(`npm run ${writerInventoryScript}`)
    > checkCommands.indexOf(`npm run ${registrationScript}`),
);
assert.ok(
  checkCommands.indexOf(`npm run ${roleContractScript}`)
    > checkCommands.indexOf(
      "npm run test:mail-durable-replay-0067:roles",
    ),
);

const currentPostgresJob = workflow.match(
  /^  postgres-integration:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/mu,
)?.[0] ?? "";
const postgresJob =
  projectHistoricalPostgresCiProjection(currentPostgresJob);
assertMailRetentionRedaction0068PostgresProjection(postgresJob);

assert.equal(snapshot0068.prevId, snapshot0067.id);
assert.equal(snapshot0068.id, "c42a819d-8944-49e6-913e-ab30d59e1755");
assert.deepEqual(journal.entries[68], {
  idx: 68,
  version: "7",
  when: 1785005772253,
  tag: "0068_mail_outbox_quarantine_redaction_authority_v2",
  breakpoints: true,
});

console.log("mail-retention-redaction-0068-registration-tests-ok");
