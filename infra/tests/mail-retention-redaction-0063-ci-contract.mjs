import assert from "node:assert/strict";

export const mailRetentionRedaction0063CiContract = Object.freeze({
  registrationScript: "test:mail-retention-redaction-0063:registration",
  harnessScript: "test:mail-retention-redaction-0063",
  registrationCommand:
    "node infra/tests/mail-retention-redaction-0063-registration.test.mjs",
  harnessCommand:
    "node infra/tests/mail-retention-redaction-0063.integration.mjs",
  pg17Command:
    "POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run test:mail-retention-redaction-0063",
  pg18Command:
    "POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:mail-retention-redaction-0063",
});

export function assertMailRetentionRedaction0063PostgresProjection(
  postgresProjection,
) {
  const {
    registrationScript,
    pg17Command,
    pg18Command,
  } = mailRetentionRedaction0063CiContract;
  assert.match(
    postgresProjection,
    /^    runs-on: ubuntu-24\.04$/mu,
    "the 0063 matrix must remain in the Ubuntu PostgreSQL integration job",
  );
  assert.doesNotMatch(
    postgresProjection,
    /^    (?:if|needs):/mu,
    "the PostgreSQL integration job must remain an unconditional independent gate",
  );
  assert.doesNotMatch(
    postgresProjection,
    /continue-on-error:/u,
    "the 0063 matrix must never become advisory",
  );
  assert.doesNotMatch(
    postgresProjection,
    /(?:postgresql-16|POSTGRES_16_BIN|\/postgresql\/16\/bin)/u,
    "the 0063 matrix must not restore PostgreSQL 16",
  );

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

  const installCommand =
    "          sudo apt-get install --yes --no-install-recommends postgresql-17 postgresql-18";
  assert.equal(
    postgresProjection.split(installCommand).length,
    2,
    "the 0063 matrix must install exactly PostgreSQL 17 and PostgreSQL 18",
  );

  const registrationIndex = postgresProjection.indexOf(
    `      - run: npm run ${registrationScript}`,
  );
  const installIndex = postgresProjection.indexOf(installCommand);
  const pg17Index = postgresProjection.indexOf(`      - run: ${pg17Command}`);
  const pg18Index = postgresProjection.indexOf(`      - run: ${pg18Command}`);

  assert.ok(registrationIndex >= 0, "the 0063 registration guard must run in CI");
  assert.ok(
    installIndex > registrationIndex,
    "the 0063 registration guard must run before PostgreSQL installation",
  );
  assert.ok(
    pg17Index > installIndex,
    "the production-primary PostgreSQL 17 harness must run after installation",
  );
  assert.ok(
    pg18Index > pg17Index,
    "the PostgreSQL 18 compatibility harness must run after PostgreSQL 17",
  );
  assert.doesNotMatch(
    postgresProjection.slice(pg17Index, pg18Index),
    /(?:&|parallel|concurrently)\s+.*mail-retention-redaction/iu,
    "the PostgreSQL 17 and PostgreSQL 18 harnesses must remain sequential",
  );
}
