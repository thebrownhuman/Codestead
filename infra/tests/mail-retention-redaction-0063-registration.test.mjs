#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import * as postgresCiProjectionModule from "./mail-retention-redaction-0063-ci-contract.mjs";

const { mailRetentionRedaction0063CiContract } =
  postgresCiProjectionModule;

const read = (relativePath) =>
  readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");

const packageManifest = JSON.parse(read("package.json"));
const workflow = read(".github/workflows/ci.yml");
const productionCompose = read("compose.yaml");
const restoreCompose = read("infra/restore/restore-drill.compose.yaml");
const releaseScript = read("infra/ops/release-production.sh");
const restoreScript = read("scripts/backup/restore-drill-isolated.sh");
const journal = JSON.parse(read("drizzle/meta/_journal.json"));
const migrationNames = readdirSync(
  new URL("../../drizzle", import.meta.url),
).filter((name) => /^\d{4}_.+\.sql$/u.test(name));
const migration0063 = read(
  "drizzle/0063_mail_outbox_redaction_fence_release.sql",
);
const scripts = packageManifest.scripts;
const staticOnly = process.argv.includes("--static-only");

assert.equal(
  typeof postgresCiProjectionModule.definePostgresCiProjectionExtension,
  "function",
  "the shared PostgreSQL CI contract must expose an extension definition API",
);
assert.equal(
  typeof postgresCiProjectionModule.composeCanonicalPostgresCiProjectionContract,
  "function",
  "the shared PostgreSQL CI contract must expose a canonical composition API",
);

assert.equal(
  typeof postgresCiProjectionModule.assertPostgresCiProjectionContract,
  "function",
  "the shared PostgreSQL CI contract must expose one canonical projection assertion",
);

for (const unauthorizedTimeout of [21, 34, 35]) {
  assert.throws(
    () =>
      postgresCiProjectionModule.definePostgresCiProjectionExtension({
        id: `self-test-non-restore-timeout-${unauthorizedTimeout}`,
        registrationScripts: [
          `test:self-test-non-restore-timeout-${unauthorizedTimeout}:registration`,
        ],
        minimumTimeoutMinutes: unauthorizedTimeout,
      }),
    /only the dedicated restore extension may raise the PostgreSQL CI timeout/u,
    `a normal extension cannot raise the timeout to ${unauthorizedTimeout}`,
  );
}

const selfTest0064Extension =
  postgresCiProjectionModule.definePostgresCiProjectionExtension({
    id: "self-test-0064",
    registrationScripts: ["test:self-test-0064:registration"],
    productionPg17Scripts: ["test:self-test-0064"],
    targetedPg18Scripts: ["test:self-test-0064"],
  });
const selfTest0065Extension =
  postgresCiProjectionModule.definePostgresCiProjectionExtension({
    id: "self-test-0065",
    registrationScripts: ["test:self-test-0065:registration"],
    productionPg17Scripts: ["test:self-test-0065"],
    targetedPg18Scripts: ["test:self-test-0065"],
  });
const selfTestRestoreExtension =
  postgresCiProjectionModule.definePostgresCiProjectionExtension({
    id: "self-test-restore",
    kind: "restore",
    registrationScripts: ["test:self-test-restore:registration"],
    productionPg17Scripts: ["test:self-test-restore"],
    targetedPg18Scripts: ["test:self-test-restore"],
    minimumTimeoutMinutes: 35,
  });
const composedSelfTestContract =
  postgresCiProjectionModule.composeCanonicalPostgresCiProjectionContract(
    selfTest0064Extension,
    selfTest0065Extension,
    selfTestRestoreExtension,
  );
for (const key of [
  "registrationScripts",
  "productionPg17Scripts",
  "targetedPg18Scripts",
]) {
  assert.deepEqual(
    composedSelfTestContract[key].slice(
      0,
      postgresCiProjectionModule.canonicalPostgresCiProjectionContract[key]
        .length,
    ),
    postgresCiProjectionModule.canonicalPostgresCiProjectionContract[key],
    `0064, 0065, and restore extensions must preserve canonical ${key}`,
  );
}
assert.equal(
  composedSelfTestContract.registrationScripts.at(-1),
  "test:self-test-restore:registration",
);
assert.equal(
  composedSelfTestContract.timeoutMinutes,
  35,
  "the restore extension must raise the single composed timeout to exactly 35 minutes",
);
assert.throws(
  () => composedSelfTestContract.registrationScripts.push("test:mutation"),
  TypeError,
  "composed contract collections must be immutable",
);
assert.throws(
  () =>
    postgresCiProjectionModule.composeCanonicalPostgresCiProjectionContract(
      selfTest0064Extension,
      selfTest0064Extension,
    ),
  /duplicate PostgreSQL CI extension id/u,
  "an extension cannot silently replace or duplicate a prior gate set",
);

const {
  registrationScript,
  harnessScript,
  registrationCommand,
  harnessCommand,
} = mailRetentionRedaction0063CiContract;

if (!staticOnly) {
  assert.equal(
    scripts[registrationScript],
    registrationCommand,
    "package.json must expose the 0063 registration guard",
  );
  assert.equal(
    scripts[harnessScript],
    harnessCommand,
    "package.json must expose the real 0063 PostgreSQL harness",
  );
  assert.equal(
    scripts.check.split(" && ").filter((command) =>
      command === `npm run ${registrationScript}`).length,
    1,
    "npm run check must execute the 0063 registration guard exactly once",
  );
}

const through0063 = migrationNames
  .filter((name) => Number.parseInt(name.slice(0, 4), 10) <= 63)
  .sort();
assert.equal(through0063.length, 64);
through0063.forEach((name, expectedIndex) => {
  assert.equal(
    Number.parseInt(name.slice(0, 4), 10),
    expectedIndex,
    `migration sequence is not contiguous at ${name}`,
  );
});
assert.deepEqual(
  through0063.filter((name) => name.startsWith("0062_")),
  ["0062_mail_outbox_retention_redaction.sql"],
);
assert.deepEqual(
  through0063.filter((name) => name.startsWith("0063_")),
  ["0063_mail_outbox_redaction_fence_release.sql"],
);

const journalThrough0063 = journal.entries
  .filter((entry) => entry.idx <= 63)
  .sort((left, right) => left.idx - right.idx);
assert.equal(journalThrough0063.length, 64);
journalThrough0063.forEach((entry, expectedIndex) => {
  assert.equal(entry.idx, expectedIndex);
  assert.equal(
    `${entry.tag}.sql`,
    through0063[expectedIndex],
    `journal tag does not name migration ${through0063[expectedIndex]}`,
  );
});
const entry0062 = journal.entries.filter((entry) => entry.idx === 62);
const entry0063 = journal.entries.filter((entry) => entry.idx === 63);
assert.deepEqual(
  entry0062.map((entry) => entry.tag),
  ["0062_mail_outbox_retention_redaction"],
);
assert.deepEqual(
  entry0063.map((entry) => entry.tag),
  ["0063_mail_outbox_redaction_fence_release"],
);
assert.doesNotMatch(
  migration0063,
  /statement-breakpoint(?:ALTER|CREATE|DROP|GRANT|REVOKE)/u,
  "every 0063 statement breakpoint must be followed by a real newline",
);
assert.match(
  migration0063,
  /RETURNS TABLE\("disposition" text, "eligible" bigint, "transitioned" bigint\)/u,
);
assert.match(migration0063, /"batch_limit" integer/u);
assert.match(migration0063, /report_only boolean := batch_limit = 0/u);
const reportOnlyBranch = migration0063.match(
  /IF report_only THEN([\s\S]*?)\n\s*RETURN;\n\s*END IF;/u,
)?.[1] ?? "";
assert.ok(reportOnlyBranch, "0063 must retain an explicit report-only branch");
assert.doesNotMatch(
  reportOnlyBranch,
  /\b(?:UPDATE|DELETE|INSERT|FOR UPDATE|FOR NO KEY UPDATE)\b/iu,
  "batch_limit=0 must not mutate or acquire row locks",
);
assert.match(migration0063, /'eligible_system'/u);
for (const template of [
  "access-request-admin",
  "invitation",
  "access-rejected",
]) {
  assert.match(migration0063, new RegExp(`'${template}'`, "u"));
}
for (const envelopeKey of [
  "_mailOperationId",
  "_mailRecipient",
  "_mailProducer",
  "_mailSourceId",
]) {
  assert.match(migration0063, new RegExp(`'${envelopeKey}'`, "u"));
}
for (const fence of [
  "candidate.claim_token IS NULL",
  "candidate.claim_owner IS NULL",
  "candidate.lease_expires_at IS NULL",
]) {
  assert.match(migration0063, new RegExp(fence.replace(".", "\\."), "u"));
}
assert.match(
  migration0063,
  /SECURITY DEFINER[\s\S]*SET search_path = pg_catalog/u,
);
assert.match(
  migration0063,
  /GRANT EXECUTE ON FUNCTION[\s\S]*TO learncoding_ops/u,
);

const boundaryVerifierCommand =
  'command: ["node", "/app/scripts/verify-database-role-boundaries.mjs", "--require-application-objects"]';
for (const [label, compose] of [
  ["production", productionCompose],
  ["restore", restoreCompose],
]) {
  const service = compose.match(
    /^  database-boundary-verifier:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/mu,
  )?.[0] ?? "";
  assert.ok(service, `${label} boundary-verifier service is missing`);
  assert.ok(
    service.includes(boundaryVerifierCommand),
    `${label} boundary-verifier must use the application-object CLI gate`,
  );
}
assert.match(
  releaseScript,
  /^run_one_shot database-boundary-verifier$/mu,
  "release must stop at the production application-object verifier",
);
assert.match(
  restoreScript,
  /^restore_one_shot database-boundary-verifier$/mu,
  "restore must stop at the production application-object verifier",
);

if (!staticOnly) {
  const postgresJob = workflow.match(
    /^  postgres-integration:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/mu,
  )?.[0] ?? "";
  postgresCiProjectionModule.assertPostgresCiProjectionContract(
    postgresJob,
    postgresCiProjectionModule.canonicalPostgresCiProjectionContract,
  );

  const replaceProjectionExactly = (projection, before, after) => {
    assert.equal(
      projection.split(before).length,
      2,
      `self-test mutation anchor must be unique: ${before}`,
    );
    return projection.replace(before, after);
  };
  const expectProjectionRejected = (label, projection, expectedMessage) => {
    assert.throws(
      () =>
        postgresCiProjectionModule.assertPostgresCiProjectionContract(
          projection,
          postgresCiProjectionModule.canonicalPostgresCiProjectionContract,
        ),
      expectedMessage,
      label,
    );
  };

  expectProjectionRejected(
    "the PostgreSQL timeout is one canonical policy",
    replaceProjectionExactly(
      postgresJob,
      "    timeout-minutes: 20",
      "    timeout-minutes: 21",
    ),
    /timeout-minutes/u,
  );
  expectProjectionRejected(
    "the live PostgreSQL 17 integration gate cannot be removed",
    replaceProjectionExactly(
      postgresJob,
      "      - run: npm run test:integration\n",
      "",
    ),
    /live PostgreSQL 17 integration gate must appear exactly once/u,
  );
  expectProjectionRejected(
    "the live PostgreSQL 17 integration gate cannot become a PostgreSQL 18 run",
    replaceProjectionExactly(
      postgresJob,
      "      - run: npm run test:integration",
      "      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:integration",
    ),
    /live PostgreSQL 17 integration gate must appear exactly once/u,
  );
  expectProjectionRejected(
    "the live PostgreSQL 17 integration gate must precede the pinned Docker pull",
    replaceProjectionExactly(
      postgresJob,
      [
        "      - run: npm run test:integration",
        "      - run: docker pull postgres:17-bookworm@sha256:4f736ae292687621d4be0d499ffd024a36bd2ee7d8ca6f2ccd4c800f047b394",
      ].join("\n"),
      [
        "      - run: docker pull postgres:17-bookworm@sha256:4f736ae292687621d4be0d499ffd024a36bd2ee7d8ca6f2ccd4c800f047b394",
        "      - run: npm run test:integration",
      ].join("\n"),
    ),
    /live PostgreSQL 17 integration gate must precede the pinned Docker PostgreSQL 17 pull/u,
  );
  expectProjectionRejected(
    "PostgreSQL 16 cannot re-enter the matrix",
    `${postgresJob}      - run: POSTGRES_16_BIN=/usr/lib/postgresql/16/bin npm run test:future-mail-gate\n`,
    /PostgreSQL 16/u,
  );
  expectProjectionRejected(
    "an arbitrary PostgreSQL 16 Docker image invocation cannot re-enter the matrix",
    `${postgresJob}      - run: docker run --rm postgres:16-bookworm\n`,
    /PostgreSQL 16/u,
  );
  expectProjectionRejected(
    "the pinned Docker integration cannot regress from PostgreSQL 17 to 16",
    replaceProjectionExactly(
      postgresJob,
      "docker pull postgres:17-bookworm@sha256:4f736ae292687621d4be0d499ffd024a36bd2ee7d8ca6f2ccd4c800f047b394",
      "docker pull postgres:16-bookworm@sha256:4f736ae292687621d4be0d499ffd024a36bd2ee7d8ca6f2ccd4c800f047b394",
    ),
    /pinned Docker PostgreSQL 17 integration image/u,
  );
  expectProjectionRejected(
    "the pinned Docker pull must precede its PostgreSQL 17 integration gate",
    replaceProjectionExactly(
      postgresJob,
      [
        "      - run: docker pull postgres:17-bookworm@sha256:4f736ae292687621d4be0d499ffd024a36bd2ee7d8ca6f2ccd4c800f047b394",
        "      - run: docker pull node:22.23.1-alpine3.23@sha256:4848379985144e72c7537574c1a894d4ec096704b21ce45e5eee386be9fab737",
        "      - run: CODESTEAD_DISPOSABLE_HOST=1 bash infra/tests/database-least-privilege-integration.sh",
      ].join("\n"),
      [
        "      - run: docker pull node:22.23.1-alpine3.23@sha256:4848379985144e72c7537574c1a894d4ec096704b21ce45e5eee386be9fab737",
        "      - run: CODESTEAD_DISPOSABLE_HOST=1 bash infra/tests/database-least-privilege-integration.sh",
        "      - run: docker pull postgres:17-bookworm@sha256:4f736ae292687621d4be0d499ffd024a36bd2ee7d8ca6f2ccd4c800f047b394",
      ].join("\n"),
    ),
    /Docker PostgreSQL 17 pull must precede its integration gate/u,
  );
  expectProjectionRejected(
    "runtime environment and binary majors cannot diverge",
    replaceProjectionExactly(
      postgresJob,
      "POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:mail-delivery-scope-0059",
      "POSTGRES_18_BIN=/usr/lib/postgresql/17/bin npm run test:mail-delivery-scope-0059",
    ),
    /runtime major/u,
  );
  expectProjectionRejected(
    "production PostgreSQL 17 must run before targeted PostgreSQL 18",
    replaceProjectionExactly(
      postgresJob,
      [
        "      - run: POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run test:mail-retention-redaction-0063",
        "      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:mail-delivery-scope-0059",
      ].join("\n"),
      [
        "      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:mail-delivery-scope-0059",
        "      - run: POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run test:mail-retention-redaction-0063",
      ].join("\n"),
    ),
    /PostgreSQL 17 harnesses must run before PostgreSQL 18/u,
  );
  expectProjectionRejected(
    "a prior registration gate cannot be removed",
    replaceProjectionExactly(
      postgresJob,
      "      - run: npm run test:mail-delivery-scope-0059:registration\n",
      "",
    ),
    /registration scripts/u,
  );
  expectProjectionRejected(
    "an undeclared registration gate cannot masquerade as evidence",
    replaceProjectionExactly(
      postgresJob,
      "      - run: npm run test:integration",
      [
        "      - run: npm run test:future-mail-gate:registration",
        "      - run: npm run test:integration",
      ].join("\n"),
    ),
    /registration scripts/u,
  );
  expectProjectionRejected(
    "a prior targeted PostgreSQL 18 harness cannot be removed",
    replaceProjectionExactly(
      postgresJob,
      "      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:mail-payload-immutability-0060\n",
      "",
    ),
    /PostgreSQL 18 scripts/u,
  );

  const extendedProjection = replaceProjectionExactly(
    replaceProjectionExactly(
      replaceProjectionExactly(
        replaceProjectionExactly(
          postgresJob,
          "    timeout-minutes: 20",
          "    timeout-minutes: 35",
        ),
        "      - run: npm run test:integration",
        [
          "      - run: npm run test:self-test-0064:registration",
          "      - run: npm run test:self-test-0065:registration",
          "      - run: npm run test:self-test-restore:registration",
          "      - run: npm run test:integration",
        ].join("\n"),
      ),
      "      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:mail-delivery-scope-0059",
      [
        "      - run: POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run test:self-test-0064",
        "      - run: POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run test:self-test-0065",
        "      - run: POSTGRES_17_BIN=/usr/lib/postgresql/17/bin npm run test:self-test-restore",
        "      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:mail-delivery-scope-0059",
      ].join("\n"),
    ),
    "      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:mail-retention-redaction-0063",
    [
      "      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:mail-retention-redaction-0063",
      "      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:self-test-0064",
      "      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:self-test-0065",
      "      - run: POSTGRES_18_BIN=/usr/lib/postgresql/18/bin npm run test:self-test-restore",
    ].join("\n"),
  );
  assert.doesNotThrow(
    () =>
      postgresCiProjectionModule.assertPostgresCiProjectionContract(
        extendedProjection,
        composedSelfTestContract,
      ),
    "0064, 0065, and restore must compose without replacing prior gates",
  );
  assert.throws(
    () =>
      postgresCiProjectionModule.assertPostgresCiProjectionContract(
        replaceProjectionExactly(
          extendedProjection,
          "      - run: npm run test:mail-delivery-scope-0059:registration\n",
          "",
        ),
        composedSelfTestContract,
      ),
    /registration scripts/u,
    "an extension cannot make a prior registration optional",
  );
}

console.log(
  staticOnly
    ? "mail-retention-redaction-0063-static-tests-ok"
    : "mail-retention-redaction-0063-registration-tests-ok",
);
