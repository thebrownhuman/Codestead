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
  assertPostgresCiProjectionContract,
  composeCanonicalPostgresCiProjectionContract,
  definePostgresCiProjectionExtension,
} from "./mail-retention-redaction-0063-ci-contract.mjs";

const HISTORICAL_ROLE_SCRIPTS_THROUGH_0068 = Object.freeze([
  "test:mail-dispatch-binding-0064:roles",
  "test:mail-provider-correlation-0066:roles",
  "test:mail-durable-replay-0067:roles",
  "test:mail-retention-redaction-0068:roles",
]);

export const mailRetentionRedaction0068CiContract = Object.freeze({
  registrationScript: "test:mail-retention-redaction-0068:registration",
  writerInventoryScript: "test:email-outbox-writer-inventory",
  roleContractScript: "test:mail-retention-redaction-0068:roles",
  pg17Script: "test:mail-retention-redaction-0068:pg17",
  pg18Script: "test:mail-retention-redaction-0068:pg18",
  registrationCommand:
    "node --test infra/tests/mail-quarantine-redaction-0068-harness.test.mjs "
    + "&& node infra/tests/mail-retention-redaction-0068-registration.test.mjs",
  writerInventoryCommand:
    "node --test scripts/verify-email-outbox-writer-inventory.test.mjs "
    + "&& node scripts/verify-email-outbox-writer-inventory.mjs",
  roleContractCommand:
    "node --test infra/tests/mail-retention-redaction-0068-role-contract.test.mjs",
  harnessCommand:
    "node infra/tests/mail-quarantine-redaction-0068.integration.mjs",
});

export const mailRetentionRedaction0068PostgresCiExtension =
  definePostgresCiProjectionExtension({
    id: "mail-retention-redaction-0068",
    registrationScripts: [
      mailRetentionRedaction0068CiContract.registrationScript,
    ],
    productionPg17Scripts: [
      mailRetentionRedaction0068CiContract.pg17Script,
    ],
    targetedPg18Scripts: [
      mailRetentionRedaction0068CiContract.pg18Script,
    ],
  });

export const postgresCiProjectionThrough0068 =
  composeCanonicalPostgresCiProjectionContract(
    mailDispatchBinding0064PostgresCiExtension,
    backupStatusMailAuthority0065CiExtension,
    mailProviderCorrelation0066PostgresCiExtension,
    mailDurableReplay0067PostgresCiExtension,
    mailRetentionRedaction0068PostgresCiExtension,
  );

export function assertMailRoleContractProjection(
  postgresProjection,
  expectedScripts,
  { allowReviewedSuffix = false } = {},
) {
  const actualScripts = [
    ...postgresProjection.matchAll(
      /^      - run: npm run (test:[a-z0-9][a-z0-9:-]*:roles)$/gmu,
    ),
  ].map((match) => match[1]);
  assert.equal(
    new Set(actualScripts).size,
    actualScripts.length,
    "mail role-contract scripts must not be duplicated",
  );
  if (!allowReviewedSuffix) {
    assert.deepEqual(
      actualScripts,
      expectedScripts,
      "mail role-contract scripts must match the exact final contract",
    );
    return;
  }
  assert.deepEqual(
    actualScripts.slice(0, expectedScripts.length),
    expectedScripts,
    "historical mail role-contract scripts must remain an exact ordered prefix",
  );
  let lastVersion = 68;
  for (const script of actualScripts.slice(expectedScripts.length)) {
    const version = Number.parseInt(
      script.match(/-(\d{4}):roles$/u)?.[1] ?? "",
      10,
    );
    assert.ok(
      Number.isInteger(version) && version > lastVersion,
      "successor mail role-contract scripts must be strictly later and ordered",
    );
    lastVersion = version;
  }
}

export function assertMailRetentionRedaction0068PostgresProjection(
  postgresProjection,
) {
  assertPostgresCiProjectionContract(
    postgresProjection,
    postgresCiProjectionThrough0068,
    { allowReviewedSuffix: true },
  );
  assertMailRoleContractProjection(
    postgresProjection,
    HISTORICAL_ROLE_SCRIPTS_THROUGH_0068,
    { allowReviewedSuffix: true },
  );
  const {
    registrationScript,
    roleContractScript,
    pg17Script,
    pg18Script,
  } = mailRetentionRedaction0068CiContract;
  const commandLines = [
    `      - run: npm run ${registrationScript}`,
    `      - run: npm run ${roleContractScript}`,
    `      - run: POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run ${pg17Script}`,
    `      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run ${pg18Script}`,
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
    /(?:QUARANTINE_REDACTION_POSTGRES|postgresql-16|POSTGRES_16_BIN|\/postgresql\/16\/bin)/u,
    "0068 must use only the canonical PostgreSQL 17/18 runtime selectors",
  );

  const registration0067Index = postgresProjection.indexOf(
    "      - run: npm run test:mail-durable-replay-0067:registration",
  );
  const registration0068Index = postgresProjection.indexOf(commandLines[0]);
  const role0067Index = postgresProjection.indexOf(
    "      - run: npm run test:mail-durable-replay-0067:roles",
  );
  const role0068Index = postgresProjection.indexOf(commandLines[1]);
  const liveIntegrationIndex = postgresProjection.indexOf(
    "      - run: npm run test:integration",
  );
  const pg17ReplayIndex = postgresProjection.indexOf(
    "      - run: POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run test:mail-durable-replay-0067:pg17",
  );
  const pg17RedactionIndex = postgresProjection.indexOf(commandLines[2]);
  const pg18ReplayIndex = postgresProjection.indexOf(
    "      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:mail-durable-replay-0067:pg18",
  );
  const pg18RedactionIndex = postgresProjection.indexOf(commandLines[3]);

  assert.ok(
    registration0068Index > registration0067Index,
    "0068 registration must follow its 0067 dependency",
  );
  assert.ok(
    role0068Index > role0067Index,
    "0068 role-contract verification must follow the 0067 role contract",
  );
  assert.ok(
    liveIntegrationIndex > role0068Index,
    "the pinned PostgreSQL 17 integration suite must follow role contracts",
  );
  assert.ok(
    pg17RedactionIndex > pg17ReplayIndex,
    "the 0068 PostgreSQL 17 proof must follow the 0067 proof",
  );
  assert.ok(
    pg18RedactionIndex > pg18ReplayIndex,
    "the 0068 PostgreSQL 18 proof must follow the 0067 proof",
  );
  assert.ok(
    pg18RedactionIndex > pg17RedactionIndex,
    "the production-primary PostgreSQL 17 proof must precede PostgreSQL 18",
  );
}
