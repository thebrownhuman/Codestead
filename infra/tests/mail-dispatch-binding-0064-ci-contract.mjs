import assert from "node:assert/strict";
import {
  assertPostgresCiProjectionContract,
  composeCanonicalPostgresCiProjectionContract,
  definePostgresCiProjectionExtension,
} from "./mail-retention-redaction-0063-ci-contract.mjs";

export const mailDispatchBinding0064CiContract = Object.freeze({
  registrationScript: "test:mail-dispatch-binding-0064:registration",
  roleContractScript: "test:mail-dispatch-binding-0064:roles",
  pg17Script: "test:mail-dispatch-binding-0064:pg17",
  pg18Script: "test:mail-dispatch-binding-0064:pg18",
  registrationCommand:
    "node infra/tests/mail-dispatch-binding-0064-registration.test.mjs",
  roleContractCommand:
    "node --test infra/tests/mail-dispatch-binding-0064-role-contract.test.mjs",
  nativeHarnessCommand:
    "node infra/tests/mail-dispatch-binding-0064.integration.mjs",
  pg18Command:
    "POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:mail-dispatch-binding-0064:pg18",
});

export const mailDispatchBinding0064PostgresCiExtension =
  definePostgresCiProjectionExtension({
    id: "mail-dispatch-binding-0064",
    registrationScripts: [mailDispatchBinding0064CiContract.registrationScript],
    productionPg17Scripts: [mailDispatchBinding0064CiContract.pg17Script],
    targetedPg18Scripts: [mailDispatchBinding0064CiContract.pg18Script],
  });

export const postgresCiProjectionThrough0064 =
  composeCanonicalPostgresCiProjectionContract(
    mailDispatchBinding0064PostgresCiExtension,
  );

export function assertMailDispatchBinding0064PostgresProjection(
  postgresProjection,
  projectionContract = postgresCiProjectionThrough0064,
) {
  assertPostgresCiProjectionContract(postgresProjection, projectionContract);
  const { registrationScript, roleContractScript, pg18Command } =
    mailDispatchBinding0064CiContract;
  assert.match(
    postgresProjection,
    /^    runs-on: ubuntu-24\.04$/mu,
    "the 0064 gates must remain in the Ubuntu PostgreSQL integration job",
  );
  assert.doesNotMatch(
    postgresProjection,
    /^    (?:if|needs):/mu,
    "the PostgreSQL integration job must remain unconditional",
  );
  assert.doesNotMatch(
    postgresProjection,
    /continue-on-error:/u,
    "the 0064 gates must never become advisory",
  );
  assert.doesNotMatch(
    postgresProjection,
    /(?:postgresql-16|POSTGRES_16_BIN|\/postgresql\/16\/bin)/u,
    "the 0064 matrix must not introduce PostgreSQL 16",
  );

  for (const command of [
    `npm run ${registrationScript}`,
    `npm run ${roleContractScript}`,
    "npm run test:integration",
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
    "the 0064 matrix must retain the exact PostgreSQL 17/18 install",
  );

  const registration0063Index = postgresProjection.indexOf(
    "      - run: npm run test:mail-retention-redaction-0063:registration",
  );
  const registration0064Index = postgresProjection.indexOf(
    `      - run: npm run ${registrationScript}`,
  );
  const roleContractIndex = postgresProjection.indexOf(
    `      - run: npm run ${roleContractScript}`,
  );
  const pinnedPg17Index = postgresProjection.indexOf(
    "      - run: npm run test:integration",
  );
  const installIndex = postgresProjection.indexOf(installCommand);
  const pg18RedactionIndex = postgresProjection.indexOf(
    "      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:mail-retention-redaction-0063",
  );
  const pg18BindingIndex = postgresProjection.indexOf(
    `      - run: ${pg18Command}`,
  );

  assert.ok(
    registration0063Index >= 0,
    "the 0063 registration dependency must remain explicit",
  );
  assert.ok(
    pg18RedactionIndex >= 0,
    "the 0063 PG18 dependency must remain explicit",
  );
  assert.ok(
    registration0064Index > registration0063Index,
    "0064 registration must follow its 0063 dependency",
  );
  assert.ok(
    roleContractIndex > registration0064Index,
    "the 0064 role manifest must be checked after static registration",
  );
  assert.ok(
    pinnedPg17Index > roleContractIndex,
    "the pinned PostgreSQL 17 integration suite must follow lightweight gates",
  );
  assert.ok(
    installIndex > pinnedPg17Index,
    "the pinned PostgreSQL 17 Docker suite must run before native PG installation",
  );
  assert.ok(
    pg18BindingIndex > installIndex,
    "the 0064 PG18 harness must run only after native PG installation",
  );
  assert.ok(
    pg18BindingIndex > pg18RedactionIndex,
    "the 0064 PG18 harness must follow its 0063 PG18 dependency",
  );
  assert.doesNotMatch(
    postgresProjection.slice(pg18RedactionIndex, pg18BindingIndex),
    /(?:&|parallel|concurrently)\s+.*mail-dispatch-binding/iu,
    "the 0064 PG18 gate must remain a sequential standalone step",
  );
}
