#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assertMailDurableReplay0067PostgresProjection,
  mailDurableReplay0067CiContract,
} from "./mail-durable-replay-0067-ci-contract.mjs";
import {
  projectHistoricalPostgresCiProjection,
} from "./mail-guarded-delivery-0069-ci-contract.mjs";

const read = (relativePath) =>
  readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");

const packageManifest = JSON.parse(read("package.json"));
const workflow = read(".github/workflows/ci.yml");
const harness = read("infra/tests/mail-durable-replay-0067.impl.mjs");
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
} = mailDurableReplay0067CiContract;

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
const registrationCheckIndex = checkCommands.indexOf(
  `npm run ${registrationScript}`,
);
const writerInventoryCheckIndex = checkCommands.indexOf(
  `npm run ${writerInventoryScript}`,
);
const roleContractCheckIndex = checkCommands.indexOf(
  `npm run ${roleContractScript}`,
);
assert.ok(writerInventoryCheckIndex > registrationCheckIndex);
assert.ok(roleContractCheckIndex > writerInventoryCheckIndex);

const applicationJob = workflow.match(
  /^  application:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/mu,
)?.[0] ?? "";
const writerInventoryApplicationLine =
  `      - run: npm run ${writerInventoryScript}`;
assert.equal(
  applicationJob.split(writerInventoryApplicationLine).length,
  2,
  "the application job must execute the writer inventory exactly once",
);
assert.ok(
  applicationJob.indexOf(writerInventoryApplicationLine)
    > applicationJob.indexOf("      - run: npm run test:migration-ledger"),
  "the writer inventory must follow reviewed migration-ledger registration",
);

const currentPostgresJob = workflow.match(
  /^  postgres-integration:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/mu,
)?.[0] ?? "";
const postgresJob =
  projectHistoricalPostgresCiProjection(currentPostgresJob);
assertMailDurableReplay0067PostgresProjection(postgresJob);

const replaceProjectionExactly = (projection, before, after) => {
  assert.equal(
    projection.split(before).length,
    2,
    `0067 mutation anchor must be unique: ${before}`,
  );
  return projection.replace(before, after);
};
const projectionThrough0067 = postgresJob
  .split(/\r?\n/u)
  .filter((line) => {
    const versionText = line.match(
      /\bnpm run test:[a-z0-9][a-z0-9:-]*-(\d{4})(?::|$)/u,
    )?.[1];
    return (
      versionText === undefined
      || Number.parseInt(versionText, 10) <= 67
    );
  })
  .join("\n");
const projectionWith0068Suffix = replaceProjectionExactly(
  replaceProjectionExactly(
    replaceProjectionExactly(
      projectionThrough0067,
      "      - run: npm run test:mail-durable-replay-0067:registration",
      [
        "      - run: npm run test:mail-durable-replay-0067:registration",
        "      - run: npm run test:self-test-mail-authority-0068:registration",
      ].join("\n"),
    ),
    "      - run: POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run test:mail-durable-replay-0067:pg17",
    [
      "      - run: POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run test:mail-durable-replay-0067:pg17",
      "      - run: POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run test:self-test-mail-authority-0068:pg17",
    ].join("\n"),
  ),
  "      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:mail-durable-replay-0067:pg18",
  [
    "      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:mail-durable-replay-0067:pg18",
    "      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:self-test-mail-authority-0068:pg18",
  ].join("\n"),
);
assert.doesNotThrow(
  () => assertMailDurableReplay0067PostgresProjection(projectionWith0068Suffix),
  "the historical 0067 contract must accept a strictly later reviewed suffix",
);

assert.match(harness, /POSTGRES_17_BIN/u);
assert.match(harness, /POSTGRES_18_BIN/u);
assert.match(
  harness,
  /assert\.notEqual\(\s*port,\s*5432,\s*"0067 disposable PostgreSQL port must not be 5432",?\s*\)/u,
);
assert.match(harness, /mkdirSync\(socketDirectory\)/u);
assert.match(
  harness,
  /socketOption =\s*process\.platform === "win32"\s*\?\s*""\s*:\s*` -k "\$\{socketDirectory\}"`;/u,
);
assert.match(
  harness,
  /async function proveWriterInventoryRoutineCatalog\(/u,
);
assert.match(harness, /BACKUP_STATUS_AUTHORITY_0067_ROUTINES/u);
assert.match(harness, /WITH RECURSIVE user_routines AS/u);
assert.match(harness, /pg_catalog\.pg_proc/u);
assert.match(harness, /routine\.prokind IN \('f', 'p'\)/u);
assert.match(harness, /pg_catalog\.pg_language/u);
assert.match(harness, /pg_catalog\.pg_depend/u);
assert.match(harness, /dependency\.deptype = 'e'/u);
assert.match(
  harness,
  /pg_catalog\.pg_get_function_identity_arguments\(routine\.oid\)/u,
);
assert.match(
  harness,
  /pg_catalog\.pg_get_functiondef\(routine\.oid\)/u,
);
assert.match(harness, /routine\.prosrc AS source/u);
assert.match(harness, /pg_catalog\.sha256/u);
assert.match(harness, /direct_writers AS/u);
assert.match(harness, /dynamic_routines AS/u);
assert.match(harness, /call_edges AS/u);
assert.match(harness, /writer_reachable\(oid\) AS/u);
assert.match(harness, /pg_catalog\.pg_trigger/u);
assert.match(harness, /trigger_writers AS/u);
assert.match(
  harness,
  /pg_catalog\.to_regprocedure\(\$\{sqlLiteral\(signature\)\}\)::oid/u,
);
assert.match(
  harness,
  /"1\|1\|0\|0\|1\|true\|0\|0"/u,
);
assert.equal(
  harness.split(
    'await proveWriterInventoryRoutineCatalog(port, "mail0067");',
  ).length,
  2,
  "both PostgreSQL majors must execute one final-catalog graph proof",
);
assert.equal(
  harness.split(
    "mail_durable_replay_0067=writer_inventory_catalog_graph:pass",
  ).length,
  2,
  "the live catalog graph proof must emit one stable marker",
);
assert.doesNotMatch(
  harness,
  /(?:POSTGRES_16_BIN|postgresql-16|\/postgresql\/16\/bin)/u,
);

console.log("mail-durable-replay-0067-registration-tests-ok");
