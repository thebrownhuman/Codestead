#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  assertMailRetentionRedaction0063PostgresProjection,
  mailRetentionRedaction0063CiContract,
} from "./mail-retention-redaction-0063-ci-contract.mjs";

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
  assertMailRetentionRedaction0063PostgresProjection(postgresJob);
}

console.log(
  staticOnly
    ? "mail-retention-redaction-0063-static-tests-ok"
    : "mail-retention-redaction-0063-registration-tests-ok",
);
