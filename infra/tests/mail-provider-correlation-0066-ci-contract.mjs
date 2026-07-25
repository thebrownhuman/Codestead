import assert from "node:assert/strict";

import {
  backupStatusMailAuthority0065CiExtension,
} from "./backup-status-mail-authority-0065-ci-contract.mjs";
import {
  mailDispatchBinding0064PostgresCiExtension,
} from "./mail-dispatch-binding-0064-ci-contract.mjs";
import {
  assertPostgresCiProjectionContract,
  composeCanonicalPostgresCiProjectionContract,
  definePostgresCiProjectionExtension,
} from "./mail-retention-redaction-0063-ci-contract.mjs";

export const mailProviderCorrelation0066CiContract = Object.freeze({
  registrationScript: "test:mail-provider-correlation-0066:registration",
  roleContractScript: "test:mail-provider-correlation-0066:roles",
  pg17Script: "test:mail-provider-correlation-0066:pg17",
  pg18Script: "test:mail-provider-correlation-0066:pg18",
  registrationCommand:
    "node infra/tests/mail-provider-correlation-0066-registration.test.mjs",
  roleContractCommand:
    "node --test infra/tests/mail-provider-correlation-0066-role-contract.test.mjs",
  harnessCommand:
    "node infra/tests/mail-provider-correlation-0066.integration.mjs",
});

export const mailProviderCorrelation0066PostgresCiExtension =
  definePostgresCiProjectionExtension({
    id: "mail-provider-correlation-0066",
    registrationScripts: [
      mailProviderCorrelation0066CiContract.registrationScript,
    ],
    productionPg17Scripts: [
      mailProviderCorrelation0066CiContract.pg17Script,
    ],
    targetedPg18Scripts: [
      mailProviderCorrelation0066CiContract.pg18Script,
    ],
  });

export const postgresCiProjectionThrough0066 =
  composeCanonicalPostgresCiProjectionContract(
    mailDispatchBinding0064PostgresCiExtension,
    backupStatusMailAuthority0065CiExtension,
    mailProviderCorrelation0066PostgresCiExtension,
  );

export function assertMailProviderCorrelation0066PostgresProjection(
  postgresProjection,
) {
  assertPostgresCiProjectionContract(
    postgresProjection,
    postgresCiProjectionThrough0066,
  );
  const {
    registrationScript,
    roleContractScript,
    pg17Script,
    pg18Script,
  } = mailProviderCorrelation0066CiContract;
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
    /(?:PROVIDER_CORRELATION_POSTGRES|postgresql-16|POSTGRES_16_BIN|\/postgresql\/16\/bin)/u,
    "0066 must use only the canonical PostgreSQL 17/18 runtime selectors",
  );

  const registration0065Index = postgresProjection.indexOf(
    "      - run: npm run test:backup-status-mail-authority-0065:registration",
  );
  const registration0066Index = postgresProjection.indexOf(commandLines[0]);
  const role0064Index = postgresProjection.indexOf(
    "      - run: npm run test:mail-dispatch-binding-0064:roles",
  );
  const role0066Index = postgresProjection.indexOf(commandLines[1]);
  const liveIntegrationIndex = postgresProjection.indexOf(
    "      - run: npm run test:integration",
  );
  const pg17BackupIndex = postgresProjection.indexOf(
    "      - run: POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run test:backup-status-mail-authority-0065",
  );
  const pg17CorrelationIndex = postgresProjection.indexOf(commandLines[2]);
  const pg18BackupIndex = postgresProjection.indexOf(
    "      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:backup-status-mail-authority-0065",
  );
  const pg18CorrelationIndex = postgresProjection.indexOf(commandLines[3]);

  assert.ok(
    registration0066Index > registration0065Index,
    "0066 registration must follow its 0065 dependency",
  );
  assert.ok(
    role0064Index > registration0066Index,
    "all static registrations must precede role-contract checks",
  );
  assert.ok(
    role0066Index > role0064Index,
    "0066 role-contract verification must follow the 0064 role contract",
  );
  assert.ok(
    liveIntegrationIndex > role0066Index,
    "the pinned PostgreSQL 17 integration suite must follow role contracts",
  );
  assert.ok(
    pg17CorrelationIndex > pg17BackupIndex,
    "the 0066 PostgreSQL 17 proof must follow the 0065 proof",
  );
  assert.ok(
    pg18CorrelationIndex > pg18BackupIndex,
    "the 0066 PostgreSQL 18 proof must follow the 0065 proof",
  );
  assert.ok(
    pg18CorrelationIndex > pg17CorrelationIndex,
    "the production-primary PostgreSQL 17 proof must precede PostgreSQL 18",
  );
}
