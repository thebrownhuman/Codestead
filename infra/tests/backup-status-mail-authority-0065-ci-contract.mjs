import assert from "node:assert/strict";
import {
  assertPostgresCiProjectionContract,
  composeCanonicalPostgresCiProjectionContract,
  definePostgresCiProjectionExtension,
} from "./mail-retention-redaction-0063-ci-contract.mjs";
import { mailDispatchBinding0064PostgresCiExtension } from "./mail-dispatch-binding-0064-ci-contract.mjs";

export const backupStatusMailAuthority0065CiContract = Object.freeze({
  registrationScript: "test:backup-status-mail-authority-0065:registration",
  harnessScript: "test:backup-status-mail-authority-0065",
  registrationCommand:
    "node infra/tests/backup-status-mail-authority-0065-registration.test.mjs",
  harnessCommand:
    "node infra/tests/backup-status-mail-authority-0065.integration.mjs",
  pg17Command:
    "POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run test:backup-status-mail-authority-0065",
  pg18Command:
    "POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:backup-status-mail-authority-0065",
});

export const backupStatusMailAuthority0065CiExtension =
  definePostgresCiProjectionExtension({
    id: "backup-status-mail-authority-0065",
    registrationScripts: [
      backupStatusMailAuthority0065CiContract.registrationScript,
    ],
    productionPg17Scripts: [
      backupStatusMailAuthority0065CiContract.harnessScript,
    ],
    targetedPg18Scripts: [
      backupStatusMailAuthority0065CiContract.harnessScript,
    ],
  });

export const postgresCiProjectionThrough0065 =
  composeCanonicalPostgresCiProjectionContract(
    mailDispatchBinding0064PostgresCiExtension,
    backupStatusMailAuthority0065CiExtension,
  );

export function assertBackupStatusMailAuthority0065PostgresProjection(
  postgresProjection,
) {
  assertPostgresCiProjectionContract(
    postgresProjection,
    postgresCiProjectionThrough0065,
    { allowReviewedSuffix: true },
  );
  const { registrationScript, pg17Command, pg18Command } =
    backupStatusMailAuthority0065CiContract;

  for (const command of [
    `npm run ${registrationScript}`,
    pg17Command,
    pg18Command,
  ]) {
    assert.equal(
      postgresProjection.split(`      - run: ${command}`).length,
      2,
      `PostgreSQL job command must appear exactly once: ${command}`,
    );
  }
  assert.doesNotMatch(
    postgresProjection,
    /(?:BACKUP_STATUS_POSTGRES_BIN|BACKUP_STATUS_POSTGRES_MAJOR|postgresql-16|POSTGRES_16_BIN|\/postgresql\/16\/bin)/u,
    "0065 must use only the canonical PostgreSQL 17/18 runtime selectors",
  );

  const registration0064Index = postgresProjection.indexOf(
    "      - run: npm run test:mail-dispatch-binding-0064:registration",
  );
  const registration0065Index = postgresProjection.indexOf(
    `      - run: npm run ${registrationScript}`,
  );
  const roleContract0064Index = postgresProjection.indexOf(
    "      - run: npm run test:mail-dispatch-binding-0064:roles",
  );
  const pg17BindingIndex = postgresProjection.indexOf(
    "      - run: POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run test:mail-dispatch-binding-0064:pg17",
  );
  const pg17BackupIndex = postgresProjection.indexOf(
    `      - run: ${pg17Command}`,
  );
  const pg18BindingIndex = postgresProjection.indexOf(
    "      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:mail-dispatch-binding-0064:pg18",
  );
  const pg18BackupIndex = postgresProjection.indexOf(
    `      - run: ${pg18Command}`,
  );

  assert.ok(
    registration0065Index > registration0064Index,
    "0065 registration must follow its 0064 dependency",
  );
  assert.ok(
    roleContract0064Index > registration0065Index,
    "the 0064 role contract must follow all static migration registrations",
  );
  assert.ok(
    pg17BackupIndex > pg17BindingIndex,
    "the 0065 PostgreSQL 17 proof must follow the 0064 proof",
  );
  assert.ok(
    pg18BackupIndex > pg18BindingIndex,
    "the 0065 PostgreSQL 18 proof must follow the 0064 proof",
  );
  assert.ok(
    pg18BackupIndex > pg17BackupIndex,
    "the production-pinned PostgreSQL 17 proof must precede PostgreSQL 18",
  );
  assert.doesNotMatch(
    postgresProjection.slice(pg17BackupIndex, pg18BackupIndex),
    /(?:&|parallel|concurrently)\s+.*backup-status/iu,
    "the 0065 PostgreSQL 17 and 18 proofs must remain sequential",
  );
}
