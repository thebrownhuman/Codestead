import assert from "node:assert/strict";

import {
  backupStatusMailAuthority0065CiExtension,
} from "./backup-status-mail-authority-0065-ci-contract.mjs";
import {
  mailDispatchBinding0064PostgresCiExtension,
} from "./mail-dispatch-binding-0064-ci-contract.mjs";
import {
  mailProviderCorrelation0066PostgresCiExtension,
} from "./mail-provider-correlation-0066-ci-contract.mjs";
import {
  assertPostgresCiProjectionContract,
  composeCanonicalPostgresCiProjectionContract,
  definePostgresCiProjectionExtension,
} from "./mail-retention-redaction-0063-ci-contract.mjs";

export const mailDurableReplay0067CiContract = Object.freeze({
  registrationScript: "test:mail-durable-replay-0067:registration",
  writerInventoryScript: "test:email-outbox-writer-inventory",
  roleContractScript: "test:mail-durable-replay-0067:roles",
  pg17Script: "test:mail-durable-replay-0067:pg17",
  pg18Script: "test:mail-durable-replay-0067:pg18",
  registrationCommand:
    "node infra/tests/mail-durable-replay-0067-registration.test.mjs",
  writerInventoryCommand:
    "node --test scripts/verify-email-outbox-writer-inventory.test.mjs "
    + "&& node scripts/verify-email-outbox-writer-inventory.mjs",
  roleContractCommand:
    "node --test infra/tests/mail-durable-replay-0067-role-contract.test.mjs",
  harnessCommand:
    "node infra/tests/mail-durable-replay-0067.integration.mjs",
});

export const mailDurableReplay0067PostgresCiExtension =
  definePostgresCiProjectionExtension({
    id: "mail-durable-replay-0067",
    registrationScripts: [
      mailDurableReplay0067CiContract.registrationScript,
    ],
    productionPg17Scripts: [
      mailDurableReplay0067CiContract.pg17Script,
    ],
    targetedPg18Scripts: [
      mailDurableReplay0067CiContract.pg18Script,
    ],
  });

export const postgresCiProjectionThrough0067 =
  composeCanonicalPostgresCiProjectionContract(
    mailDispatchBinding0064PostgresCiExtension,
    backupStatusMailAuthority0065CiExtension,
    mailProviderCorrelation0066PostgresCiExtension,
    mailDurableReplay0067PostgresCiExtension,
  );

export function assertMailDurableReplay0067PostgresProjection(
  postgresProjection,
) {
  assertPostgresCiProjectionContract(
    postgresProjection,
    postgresCiProjectionThrough0067,
  );
  const {
    registrationScript,
    roleContractScript,
    pg17Script,
    pg18Script,
  } = mailDurableReplay0067CiContract;
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
    /(?:DURABLE_REPLAY_POSTGRES|postgresql-16|POSTGRES_16_BIN|\/postgresql\/16\/bin)/u,
    "0067 must use only the canonical PostgreSQL 17/18 runtime selectors",
  );

  const registration0066Index = postgresProjection.indexOf(
    "      - run: npm run test:mail-provider-correlation-0066:registration",
  );
  const registration0067Index = postgresProjection.indexOf(commandLines[0]);
  const role0066Index = postgresProjection.indexOf(
    "      - run: npm run test:mail-provider-correlation-0066:roles",
  );
  const role0067Index = postgresProjection.indexOf(commandLines[1]);
  const liveIntegrationIndex = postgresProjection.indexOf(
    "      - run: npm run test:integration",
  );
  const pg17CorrelationIndex = postgresProjection.indexOf(
    "      - run: POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run test:mail-provider-correlation-0066:pg17",
  );
  const pg17ReplayIndex = postgresProjection.indexOf(commandLines[2]);
  const pg18CorrelationIndex = postgresProjection.indexOf(
    "      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:mail-provider-correlation-0066:pg18",
  );
  const pg18ReplayIndex = postgresProjection.indexOf(commandLines[3]);

  assert.ok(
    registration0067Index > registration0066Index,
    "0067 registration must follow its 0066 dependency",
  );
  assert.ok(
    role0066Index > registration0067Index,
    "all static registrations must precede role-contract checks",
  );
  assert.ok(
    role0067Index > role0066Index,
    "0067 role-contract verification must follow the 0066 role contract",
  );
  assert.ok(
    liveIntegrationIndex > role0067Index,
    "the pinned PostgreSQL 17 integration suite must follow role contracts",
  );
  assert.ok(
    pg17ReplayIndex > pg17CorrelationIndex,
    "the 0067 PostgreSQL 17 proof must follow the 0066 proof",
  );
  assert.ok(
    pg18ReplayIndex > pg18CorrelationIndex,
    "the 0067 PostgreSQL 18 proof must follow the 0066 proof",
  );
  assert.ok(
    pg18ReplayIndex > pg17ReplayIndex,
    "the production-primary PostgreSQL 17 proof must precede PostgreSQL 18",
  );
}
