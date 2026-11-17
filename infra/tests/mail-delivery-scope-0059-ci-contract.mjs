import assert from "node:assert/strict";
import { assertReviewedPostgresDatabaseGate } from "./mail-retention-redaction-0063-ci-contract.mjs";

const registrationScript = "test:mail-delivery-scope-0059:registration";
const harnessScript = "test:mail-delivery-scope-0059";

export function assertMailDeliveryScope0059PostgresProjection(
  postgresProjection,
) {
  assert.match(
    postgresProjection,
    /^    runs-on: ubuntu-24\.04$/mu,
    "the mail-scope gate must remain in the Ubuntu PostgreSQL integration job",
  );
  assertReviewedPostgresDatabaseGate(
    postgresProjection,
    "the PostgreSQL integration job",
  );
  assert.doesNotMatch(
    postgresProjection,
    /continue-on-error:/u,
    "the mail-scope gate must never become advisory",
  );

  for (const command of [
    `npm run ${registrationScript}`,
    `POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run ${harnessScript}`,
  ]) {
    assert.equal(
      postgresProjection.split(`      - run: ${command}`).length,
      2,
      `PostgreSQL job command must appear exactly once: ${command}`,
    );
  }

  for (const requiredSetup of [
    "https://www.postgresql.org/media/keys/ACCC4CF8.asc",
    "B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8",
    "URIs: https://apt.postgresql.org/pub/repos/apt",
    "Suites: noble-pgdg",
    "Signed-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc",
  ]) {
    assert.equal(
      postgresProjection.split(requiredSetup).length,
      2,
      `PostgreSQL 18 setup is missing or ambiguous: ${requiredSetup}`,
    );
  }

  const installLines = postgresProjection.match(
    /^          sudo apt-get install --yes --no-install-recommends (?:postgresql-18|postgresql-17=17\.11-1\.pgdg24\.04\+2 postgresql-client-17=17\.11-1\.pgdg24\.04\+2 postgresql-18=18\.6-1\.pgdg24\.04\+2 postgresql-client-18=18\.6-1\.pgdg24\.04\+2)$/gmu,
  ) ?? [];
  assert.equal(
    installLines.length,
    1,
    "PostgreSQL 18 install command is missing or outside the reviewed forms",
  );
  const installIndex = postgresProjection.indexOf(installLines[0]);
  const registrationIndex = postgresProjection.indexOf(
    `      - run: npm run ${registrationScript}`,
  );
  const harnessIndex = postgresProjection.indexOf(
    `      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run ${harnessScript}`,
  );

  assert.ok(registrationIndex >= 0, "the registration guard must run in CI");
  assert.ok(
    installIndex > registrationIndex,
    "the lightweight registration guard must run before PostgreSQL installation",
  );
  assert.ok(
    harnessIndex > installIndex,
    "the real mail-scope harness must run after PostgreSQL 18 is installed",
  );
}
