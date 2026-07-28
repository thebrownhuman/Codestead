import assert from "node:assert/strict";

import {
  backupStatusMailAuthority0065CiExtension,
} from "./backup-status-mail-authority-0065-ci-contract.mjs";
import {
  mailDispatchBinding0064PostgresCiExtension,
} from "./mail-dispatch-binding-0064-ci-contract.mjs";
import {
  mailDurableReplay0067PostgresCiExtension,
} from "./mail-durable-replay-0067-ci-contract.mjs";
import {
  mailProviderCorrelation0066PostgresCiExtension,
} from "./mail-provider-correlation-0066-ci-contract.mjs";
import {
  assertMailRoleContractProjection,
  mailRetentionRedaction0068PostgresCiExtension,
} from "./mail-retention-redaction-0068-ci-contract.mjs";
import {
  assertPostgresCiProjectionContract,
  composeCanonicalPostgresCiProjectionContract,
  definePostgresCiProjectionExtension,
} from "./mail-retention-redaction-0063-ci-contract.mjs";

const FINAL_ROLE_SCRIPTS_THROUGH_0069 = Object.freeze([
  "test:mail-dispatch-binding-0064:roles",
  "test:mail-provider-correlation-0066:roles",
  "test:mail-durable-replay-0067:roles",
  "test:mail-retention-redaction-0068:roles",
  "test:mail-guarded-delivery-0069:roles",
]);

export const mailGuardedDelivery0069CiContract = Object.freeze({
  registrationScript: "test:mail-guarded-delivery-0069:registration",
  writerInventoryScript: "test:email-outbox-writer-inventory",
  roleContractScript: "test:mail-guarded-delivery-0069:roles",
  releaseRollbackScript:
    "test:mail-guarded-delivery-0069:release-rollback",
  pg17Script: "test:mail-guarded-delivery-0069:pg17",
  pg18Script: "test:mail-guarded-delivery-0069:pg18",
  registrationCommand:
    "node --test infra/tests/mail-guarded-delivery-0069-harness.test.mjs "
    + "&& node infra/tests/mail-guarded-delivery-0069-registration.test.mjs "
    + "&& node infra/tests/backup-ci-registration.test.mjs",
  writerInventoryCommand:
    "node --test scripts/verify-email-outbox-writer-inventory.test.mjs "
    + "&& node scripts/verify-email-outbox-writer-inventory.mjs",
  roleContractCommand:
    "node --test infra/tests/mail-guarded-delivery-0069-role-contract.test.mjs",
  releaseRollbackCommand:
    "node --test infra/tests/mail-guarded-delivery-0069-release-rollback-contract.test.mjs",
  harnessCommand:
    "node infra/tests/mail-guarded-delivery-0069.integration.mjs",
});

export const mailGuardedDelivery0069PostgresCiExtension =
  definePostgresCiProjectionExtension({
    id: "mail-guarded-delivery-0069",
    registrationScripts: [
      mailGuardedDelivery0069CiContract.registrationScript,
    ],
    productionPg17Scripts: [
      mailGuardedDelivery0069CiContract.pg17Script,
    ],
    targetedPg18Scripts: [
      mailGuardedDelivery0069CiContract.pg18Script,
    ],
  });

export const restoreDrillRoleBoundaryCiContract = Object.freeze({
  extensionId: "restore-drill-role-boundary",
  registrationScript: "test:restore-drill-role-boundary:registration",
  pg17Script: "test:restore-drill-role-boundary:pg17",
  pg18Script: "test:restore-drill-role-boundary:pg18",
  registrationCommand:
    "node --test infra/tests/restore-drill-role-boundary-harness.test.mjs",
  harnessCommand: "node infra/tests/restore-drill-role-boundary.integration.mjs",
});

export const restoreDrillRoleBoundaryPostgresCiExtension =
  definePostgresCiProjectionExtension({
    id: restoreDrillRoleBoundaryCiContract.extensionId,
    kind: "restore",
    minimumTimeoutMinutes: 35,
    registrationScripts: [
      restoreDrillRoleBoundaryCiContract.registrationScript,
    ],
    productionPg17Scripts: [restoreDrillRoleBoundaryCiContract.pg17Script],
    targetedPg18Scripts: [restoreDrillRoleBoundaryCiContract.pg18Script],
  });

export const postgresCiProjectionThrough0069 =
  composeCanonicalPostgresCiProjectionContract(
    mailDispatchBinding0064PostgresCiExtension,
    backupStatusMailAuthority0065CiExtension,
    mailProviderCorrelation0066PostgresCiExtension,
    mailDurableReplay0067PostgresCiExtension,
    mailRetentionRedaction0068PostgresCiExtension,
    mailGuardedDelivery0069PostgresCiExtension,
    restoreDrillRoleBoundaryPostgresCiExtension,
  );

function assertExactWorkflowControls(
  projection,
  label,
  { expectedJobProperties, allowedStepProperties },
) {
  const lines = projection.split(/\r?\n/u);
  const jobProperties = lines.filter(
    (line) => /^    \S/u.test(line) && !/^    #/u.test(line),
  );
  assert.deepEqual(
    jobProperties,
    expectedJobProperties,
    `${label} must remain an unconditional independent gate`,
  );
  const allowedSteps = new Set(allowedStepProperties);
  for (const line of lines.filter(
    (candidate) =>
      /^        \S/u.test(candidate) && !/^        #/u.test(candidate),
  )) {
    assert.ok(
      allowedSteps.has(line.trim()),
      `${label} must not contain step-level workflow controls`,
    );
  }
}

export function assertBackupCiApplicationCrossGuard(applicationProjection) {
  assertExactWorkflowControls(
    applicationProjection,
    "the application cross-guard",
    {
      expectedJobProperties: [
        "    runs-on: ubuntu-24.04",
        "    timeout-minutes: 70",
        "    steps:",
      ],
      allowedStepProperties: ["with:"],
    },
  );
  const backupGuardLine =
    "      - run: node infra/tests/backup-ci-registration.test.mjs";
  const releaseRollbackLine =
    `      - run: npm run ${mailGuardedDelivery0069CiContract.releaseRollbackScript}`;
  for (const [line, label] of [
    [backupGuardLine, "backup CI cross-guard"],
    [releaseRollbackLine, "0069 release/rollback gate"],
  ]) {
    assert.equal(
      applicationProjection.split(line).length,
      2,
      `${label} must appear exactly once in the application job`,
    );
  }
  const npmCiIndex = applicationProjection.indexOf("      - run: npm ci");
  const backupGuardIndex = applicationProjection.indexOf(backupGuardLine);
  const releaseRollbackIndex =
    applicationProjection.indexOf(releaseRollbackLine);
  const migrationLedgerIndex = applicationProjection.indexOf(
    "      - run: npm run test:migration-ledger",
  );
  assert.ok(
    backupGuardIndex > npmCiIndex,
    "the backup CI cross-guard must follow dependency installation",
  );
  assert.ok(
    releaseRollbackIndex > backupGuardIndex,
    "the backup CI cross-guard must precede the 0069 release/rollback gate",
  );
  assert.ok(
    migrationLedgerIndex > releaseRollbackIndex,
    "the 0069 release/rollback gate must precede migration-ledger checks",
  );
}

export function assertMailGuardedDelivery0069PostgresProjection(
  postgresProjection,
) {
  assertExactWorkflowControls(
    postgresProjection,
    "the PostgreSQL integration job",
    {
      expectedJobProperties: [
        "    runs-on: ubuntu-24.04",
        "    timeout-minutes: 35",
        "    steps:",
      ],
      allowedStepProperties: ["with:", "run: |"],
    },
  );
  assertPostgresCiProjectionContract(
    postgresProjection,
    postgresCiProjectionThrough0069,
  );
  assertMailRoleContractProjection(
    postgresProjection,
    FINAL_ROLE_SCRIPTS_THROUGH_0069,
  );
  const {
    registrationScript,
    roleContractScript,
    pg17Script,
    pg18Script,
  } = mailGuardedDelivery0069CiContract;
  const restorePg17Line =
    `      - run: POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run ${restoreDrillRoleBoundaryCiContract.pg17Script}`;
  const restorePg18Line =
    `      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run ${restoreDrillRoleBoundaryCiContract.pg18Script}`;
  const restoreRegistrationLine =
    `      - run: npm run ${restoreDrillRoleBoundaryCiContract.registrationScript}`;
  const commandLines = [
    `      - run: npm run ${registrationScript}`,
    restoreRegistrationLine,
    `      - run: npm run ${roleContractScript}`,
    `      - run: POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run ${pg17Script}`,
    `      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run ${pg18Script}`,
    restorePg17Line,
    restorePg18Line,
  ];
  for (const commandLine of commandLines) {
    assert.equal(
      postgresProjection.split(commandLine).length,
      2,
      `PostgreSQL job command must appear exactly once: ${commandLine.trim()}`,
    );
  }
  assert.doesNotMatch(
    postgresProjection,
    /(?:GUARDED_DELIVERY_POSTGRES|postgresql-16|POSTGRES_16_BIN|\/postgresql\/16\/bin)/u,
    "0069 must use only the canonical PostgreSQL 17/18 runtime selectors",
  );

  const registration0068Index = postgresProjection.indexOf(
    "      - run: npm run test:mail-retention-redaction-0068:registration",
  );
  const registration0069Index = postgresProjection.indexOf(commandLines[0]);
  const role0068Index = postgresProjection.indexOf(
    "      - run: npm run test:mail-retention-redaction-0068:roles",
  );
  const restoreRegistrationIndex =
    postgresProjection.indexOf(restoreRegistrationLine);
  const role0069Index = postgresProjection.indexOf(commandLines[2]);
  const liveIntegrationIndex = postgresProjection.indexOf(
    "      - run: npm run test:integration",
  );
  const pg17RedactionIndex = postgresProjection.indexOf(
    "      - run: POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run test:mail-retention-redaction-0068:pg17",
  );
  const pg17GuardedIndex = postgresProjection.indexOf(commandLines[3]);
  const pg18RedactionIndex = postgresProjection.indexOf(
    "      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:mail-retention-redaction-0068:pg18",
  );
  const pg18GuardedIndex = postgresProjection.indexOf(commandLines[4]);
  const restorePg17Index = postgresProjection.indexOf(restorePg17Line);
  const restorePg18Index = postgresProjection.indexOf(restorePg18Line);

  assert.ok(
    registration0069Index > registration0068Index,
    "0069 registration must follow its 0068 dependency",
  );
  assert.ok(
    restoreRegistrationIndex > registration0069Index
      && role0068Index > restoreRegistrationIndex,
    "restore registration must follow 0069 registration and precede role contracts",
  );
  assert.ok(
    role0069Index > role0068Index,
    "0069 role-contract verification must follow the 0068 role contract",
  );
  assert.ok(
    liveIntegrationIndex > role0069Index,
    "the pinned PostgreSQL 17 integration suite must follow role contracts",
  );
  assert.ok(
    pg17GuardedIndex > pg17RedactionIndex,
    "the 0069 PostgreSQL 17 proof must follow the 0068 proof",
  );
  assert.ok(
    pg18GuardedIndex > pg18RedactionIndex,
    "the 0069 PostgreSQL 18 proof must follow the 0068 proof",
  );
  assert.ok(
    restorePg17Index > pg17GuardedIndex,
    "the PostgreSQL 17 restore and post-restore boundary cycle must follow the 0069 proof",
  );
  assert.ok(
    pg18RedactionIndex > restorePg17Index,
    "the complete PostgreSQL 17 restore cycle must finish before PostgreSQL 18 begins",
  );
  assert.ok(
    restorePg18Index > pg18GuardedIndex,
    "the PostgreSQL 18 restore and post-restore boundary cycle must follow the 0069 proof",
  );
  assert.ok(
    pg18GuardedIndex > pg17GuardedIndex,
    "the production-primary PostgreSQL 17 proof must precede PostgreSQL 18",
  );
}
