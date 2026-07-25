#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import {
  assertMailDispatchBinding0064PostgresProjection,
  mailDispatchBinding0064CiContract,
} from "./mail-dispatch-binding-0064-ci-contract.mjs";

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
const pinnedRunner = read("scripts/run-integration-tests.ts");
const vitestIntegration = read("vitest.integration.config.ts");
const pinnedPg17Test = read(
  "integration/mail-dispatch-binding-0064.integration.test.ts",
);
const pg18Harness = read(
  "infra/tests/mail-dispatch-binding-0064.integration.mjs",
);
const scripts = packageManifest.scripts;

const {
  registrationScript,
  roleContractScript,
  harnessScript,
  registrationCommand,
  roleContractCommand,
  harnessCommand,
} = mailDispatchBinding0064CiContract;

assert.equal(scripts[registrationScript], registrationCommand);
assert.equal(scripts[roleContractScript], roleContractCommand);
assert.equal(scripts[harnessScript], harnessCommand);
for (const script of [registrationScript, roleContractScript]) {
  assert.equal(
    scripts.check.split(" && ").filter((command) =>
      command === `npm run ${script}`).length,
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
  journal.entries
    .filter((entry) => entry.idx === 64)
    .map((entry) => entry.tag),
  ["0064_mail_outbox_dispatch_binding"],
);

assert.equal(
  snapshot.prevId,
  "d2a68a3d-c790-4f56-b83e-7c7ba0eb6d68",
  "0064 snapshot must descend from the latest structural snapshot 0060",
);
assert.match(migration, /LOCK TABLE public\.email_outbox IN ACCESS EXCLUSIVE MODE/u);
assert.match(migration, /dispatch_binding_version/u);
assert.match(migration, /dispatch_binding_sha256/u);
assert.match(migration, /SECURITY INVOKER[\s\S]*SET search_path = pg_catalog/u);

assert.match(
  pinnedRunner,
  /postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193/u,
  "the production-primary integration runner must remain pinned to PG17",
);
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
assert.match(
  pinnedPg17Test,
  /production-pinned PostgreSQL 17/u,
);
assert.match(
  pinnedPg17Test,
  /server_version_num/u,
);
assert.match(
  pg18Harness,
  /POSTGRES_MAJOR must select the targeted native PostgreSQL 18 gate/u,
);
assert.match(pg18Harness, /\/\^18\$\/u/u);

const postgresJob = workflow.match(
  /^  postgres-integration:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/mu,
)?.[0] ?? "";
assertMailDispatchBinding0064PostgresProjection(postgresJob);

console.log("mail-dispatch-binding-0064-registration-tests-ok");
