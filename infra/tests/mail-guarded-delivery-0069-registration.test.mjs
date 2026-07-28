#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assertBackupCiApplicationCrossGuard,
  assertMailGuardedDelivery0069PostgresProjection,
  mailGuardedDelivery0069CiContract,
} from "./mail-guarded-delivery-0069-ci-contract.mjs";
import * as postgresCiContract from "./mail-guarded-delivery-0069-ci-contract.mjs";

const read = (relativePath) =>
  readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
const readJson = (relativePath) => JSON.parse(read(relativePath));

const packageManifest = readJson("package.json");
const workflow = read(".github/workflows/ci.yml");
const journal = readJson("drizzle/meta/_journal.json");
const snapshot0068 = readJson("drizzle/meta/0068_snapshot.json");
const snapshot0069 = readJson("drizzle/meta/0069_snapshot.json");
const scripts = packageManifest.scripts;
const {
  registrationScript,
  writerInventoryScript,
  roleContractScript,
  releaseRollbackScript,
  pg17Script,
  pg18Script,
  registrationCommand,
  writerInventoryCommand,
  roleContractCommand,
  releaseRollbackCommand,
  harnessCommand,
} = mailGuardedDelivery0069CiContract;

const restoreRoleBoundaryContract =
  postgresCiContract.restoreDrillRoleBoundaryCiContract;
assert.ok(
  restoreRoleBoundaryContract,
  "through-0069 CI must define the dedicated restore role-boundary contract",
);
assert.deepEqual(restoreRoleBoundaryContract, {
  extensionId: "restore-drill-role-boundary",
  registrationScript: "test:restore-drill-role-boundary:registration",
  pg17Script: "test:restore-drill-role-boundary:pg17",
  pg18Script: "test:restore-drill-role-boundary:pg18",
  registrationCommand:
    "node --test infra/tests/restore-drill-role-boundary-harness.test.mjs",
  harnessCommand: "node infra/tests/restore-drill-role-boundary.integration.mjs",
});
assert.deepEqual(
  Object.fromEntries(
    Object.entries(
      postgresCiContract.restoreDrillRoleBoundaryPostgresCiExtension,
    ),
  ),
  {
    id: restoreRoleBoundaryContract.extensionId,
    kind: "restore",
    registrationScripts: [restoreRoleBoundaryContract.registrationScript],
    productionPg17Scripts: [restoreRoleBoundaryContract.pg17Script],
    targetedPg18Scripts: [restoreRoleBoundaryContract.pg18Script],
    minimumTimeoutMinutes: 35,
  },
  "the Task 8 extension must remain the exact canonical restore extension",
);
assert.equal(
  postgresCiContract.postgresCiProjectionThrough0069.timeoutMinutes,
  35,
  "Task 8 restore compatibility needs the accepted 35-minute timeout",
);
assert.equal(
  postgresCiContract.postgresCiProjectionThrough0069.restoreExtensionId,
  restoreRoleBoundaryContract.extensionId,
  "the Task 8 cycle must be the sole restore extension",
);
assert.equal(
  postgresCiContract.postgresCiProjectionThrough0069.extensionIds.at(-1),
  restoreRoleBoundaryContract.extensionId,
  "the complete restore cycle must extend the final through-0069 projection",
);
assert.equal(
  scripts[restoreRoleBoundaryContract.registrationScript],
  restoreRoleBoundaryContract.registrationCommand,
  "the restore registration alias must execute the unit harness",
);
assert.equal(
  scripts[restoreRoleBoundaryContract.pg17Script],
  restoreRoleBoundaryContract.harnessCommand,
  "the PostgreSQL 17 alias must execute the real restore role-boundary harness",
);
assert.equal(
  scripts[restoreRoleBoundaryContract.pg18Script],
  restoreRoleBoundaryContract.harnessCommand,
  "the PostgreSQL 18 alias must execute the real restore role-boundary harness",
);

assert.equal(scripts[registrationScript], registrationCommand);
assert.equal(scripts[writerInventoryScript], writerInventoryCommand);
assert.equal(scripts[roleContractScript], roleContractCommand);
assert.equal(scripts[releaseRollbackScript], releaseRollbackCommand);
assert.equal(scripts[pg17Script], harnessCommand);
assert.equal(scripts[pg18Script], harnessCommand);

const checkCommands = scripts.check.split(" && ");
for (const script of [
  registrationScript,
  restoreRoleBoundaryContract.registrationScript,
  releaseRollbackScript,
  writerInventoryScript,
  roleContractScript,
]) {
  assert.equal(
    checkCommands.filter((command) => command === `npm run ${script}`).length,
    1,
    `npm run check must execute ${script} exactly once`,
  );
}
const requiredCheckOrder = [
  "npm run test:mail-durable-replay-0067:registration",
  "npm run test:mail-retention-redaction-0068:registration",
  "npm run test:mail-guarded-delivery-0069:registration",
  `npm run ${restoreRoleBoundaryContract.registrationScript}`,
  `npm run ${releaseRollbackScript}`,
  `npm run ${writerInventoryScript}`,
  "npm run test:mail-dispatch-binding-0064:roles",
  "npm run test:mail-provider-correlation-0066:roles",
  "npm run test:mail-durable-replay-0067:roles",
  "npm run test:mail-retention-redaction-0068:roles",
  "npm run test:mail-guarded-delivery-0069:roles",
];
let previousCheckIndex = -1;
for (const command of requiredCheckOrder) {
  const index = checkCommands.indexOf(command);
  assert.ok(index > previousCheckIndex, `${command} is out of order`);
  previousCheckIndex = index;
}

const applicationJob = workflow.match(
  /^  application:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/mu,
)?.[0] ?? "";
assertBackupCiApplicationCrossGuard(applicationJob);

const postgresJob = workflow.match(
  /^  postgres-integration:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/mu,
)?.[0] ?? "";
assertMailGuardedDelivery0069PostgresProjection(postgresJob);

const replaceExactly = (source, before, after) => {
  assert.equal(
    source.split(before).length,
    2,
    `0069 mutation anchor must be unique: ${before}`,
  );
  return source.replace(before, after);
};
const registrationLine =
  "      - run: npm run test:mail-guarded-delivery-0069:registration";
const restoreRegistrationLine =
  "      - run: npm run test:restore-drill-role-boundary:registration";
const roleLine =
  "      - run: npm run test:mail-guarded-delivery-0069:roles";
const pg17Line =
  "      - run: POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run test:mail-guarded-delivery-0069:pg17";
const pg18Line =
  "      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:mail-guarded-delivery-0069:pg18";
const restorePg17Line =
  "      - run: POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run test:restore-drill-role-boundary:pg17";
const restorePg18Line =
  "      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:restore-drill-role-boundary:pg18";
const applicationGuardLine =
  "      - run: node infra/tests/backup-ci-registration.test.mjs";
const runnerContextGuardLine =
  "      - run: npm run test:github-runner-context:registration";
const releaseRollbackLine =
  `      - run: npm run ${releaseRollbackScript}`;

for (const [mutated, expected] of [
  [replaceExactly(postgresJob, registrationLine, ""), /registration scripts/u],
  [
    replaceExactly(
      postgresJob,
      registrationLine,
      `${registrationLine}\n${registrationLine}`,
    ),
    /duplicated|scripts must not be duplicated/u,
  ],
  [
    replaceExactly(postgresJob, restoreRegistrationLine, ""),
    /registration scripts|command must appear exactly once/u,
  ],
  [
    replaceExactly(
      postgresJob,
      restoreRegistrationLine,
      `${restoreRegistrationLine}\n${restoreRegistrationLine}`,
    ),
    /duplicated|registration scripts|command must appear exactly once/u,
  ],
  [
    replaceExactly(
      postgresJob,
      restoreRegistrationLine,
      `${restoreRegistrationLine}\n        continue-on-error: true`,
    ),
    /step-level workflow controls|advisory/u,
  ],
  [replaceExactly(postgresJob, roleLine, ""), /role-contract/u],
  [
    replaceExactly(postgresJob, pg17Line, `${pg17Line}\n${pg17Line}`),
    /PostgreSQL 17 scripts/u,
  ],
  [
    replaceExactly(postgresJob, restorePg17Line, ""),
    /PostgreSQL 17 scripts|command must appear exactly once/u,
  ],
  [
    replaceExactly(
      postgresJob,
      restorePg18Line,
      `${restorePg18Line}\n${restorePg18Line}`,
    ),
    /PostgreSQL 18 scripts|command must appear exactly once/u,
  ],
  [
    replaceExactly(
      postgresJob,
      registrationLine,
      `${registrationLine}\n        if: false`,
    ),
    /step-level workflow controls/u,
  ],
  [
    replaceExactly(
      postgresJob,
      roleLine,
      `${roleLine}\n        continue-on-error: true`,
    ),
    /advisory|step-level workflow controls/u,
  ],
  [
    replaceExactly(
      postgresJob,
      pg17Line,
      `${pg17Line}\n        working-directory: /tmp`,
    ),
    /step-level workflow controls/u,
  ],
  [
    replaceExactly(
      postgresJob,
      pg18Line,
      `${pg18Line}\n      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:self-test-mail-authority-0070:pg18`,
    ),
    /PostgreSQL 18 scripts/u,
  ],
  [
    postgresJob.replace(
      "    timeout-minutes: 35",
      "    timeout-minutes: 20\n    continue-on-error: true",
    ),
    /advisory|unconditional independent gate/u,
  ],
  [
    postgresJob.replace(
      "    timeout-minutes: 35",
      "    timeout-minutes: 20\n    needs: application",
    ),
    /unconditional independent gate/u,
  ],
]) {
  assert.throws(
    () => assertMailGuardedDelivery0069PostgresProjection(mutated),
    expected,
  );
}

for (const property of [
  "'if': false",
  "if : false",
  "<<: *skip-postgres-step",
]) {
  assert.throws(
    () =>
      assertMailGuardedDelivery0069PostgresProjection(
        replaceExactly(
          postgresJob,
          registrationLine,
          `${registrationLine}\n        ${property}`,
        ),
      ),
    /step-level workflow controls/u,
  );
}
for (const property of [
  "    'if': false",
  "    if : false",
  "    <<: *skip-postgres-job",
]) {
  assert.throws(
    () =>
      assertMailGuardedDelivery0069PostgresProjection(
        postgresJob.replace(
          "    timeout-minutes: 35",
          `    timeout-minutes: 20\n${property}`,
        ),
      ),
    /unconditional independent gate/u,
  );
}

for (const [mutated, expected] of [
  [
    replaceExactly(applicationJob, applicationGuardLine, ""),
    /exactly once/u,
  ],
  [
    replaceExactly(
      applicationJob,
      applicationGuardLine,
      `${applicationGuardLine}\n${applicationGuardLine}`,
    ),
    /exactly once/u,
  ],
  [
    replaceExactly(applicationJob, releaseRollbackLine, ""),
    /release\/rollback gate must appear exactly once/u,
  ],
  [
    replaceExactly(
      applicationJob,
      releaseRollbackLine,
      `${releaseRollbackLine}\n${releaseRollbackLine}`,
    ),
    /release\/rollback gate must appear exactly once/u,
  ],
  [
    applicationJob.replace(
      "    timeout-minutes: 70",
      "    timeout-minutes: 70\n    if: false",
    ),
    /unconditional independent gate/u,
  ],
  [
    replaceExactly(
      applicationJob,
      applicationGuardLine,
      `${applicationGuardLine}\n        if: false`,
    ),
    /step-level workflow controls/u,
  ],
  [
    replaceExactly(
      applicationJob,
      `${applicationGuardLine}\n${runnerContextGuardLine}\n${releaseRollbackLine}`,
      `${releaseRollbackLine}\n${applicationGuardLine}\n${runnerContextGuardLine}`,
    ),
    /must precede the 0069 release\/rollback gate/u,
  ],
]) {
  assert.throws(() => assertBackupCiApplicationCrossGuard(mutated), expected);
}

for (const property of [
  "'if': false",
  "if : false",
  "<<: *skip-application-step",
]) {
  assert.throws(
    () =>
      assertBackupCiApplicationCrossGuard(
        replaceExactly(
          applicationJob,
          applicationGuardLine,
          `${applicationGuardLine}\n        ${property}`,
        ),
      ),
    /step-level workflow controls/u,
  );
}
for (const property of [
  "    'if': false",
  "    if : false",
  "    <<: *skip-application-job",
]) {
  assert.throws(
    () =>
      assertBackupCiApplicationCrossGuard(
        applicationJob.replace(
          "    timeout-minutes: 70",
          `    timeout-minutes: 70\n${property}`,
        ),
      ),
    /unconditional independent gate/u,
  );
}

const pg18BeforePg17 = replaceExactly(
  replaceExactly(postgresJob, pg17Line, "__PG17_0069__"),
  pg18Line,
  pg17Line,
).replace("__PG17_0069__", pg18Line);
assert.throws(
  () => assertMailGuardedDelivery0069PostgresProjection(pg18BeforePg17),
  /PostgreSQL 17 scripts|PostgreSQL 18 scripts|must run before/u,
);

assert.equal(snapshot0069.prevId, snapshot0068.id);
assert.equal(snapshot0069.id, "44745a18-9cab-4fe2-97ed-f25eef12af95");
assert.deepEqual(journal.entries[69], {
  idx: 69,
  version: "7",
  when: 1785009372253,
  tag: "0069_mail_outbox_guarded_delivery_authority",
  breakpoints: true,
});
assert.equal(journal.entries.length, 70);

console.log("mail-guarded-delivery-0069-registration-tests-ok");
