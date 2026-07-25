#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
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
const nativeHarness = read(
  "infra/tests/mail-retention-redaction-0063.integration.mjs",
);
const scripts = packageManifest.scripts;
const staticOnly = process.argv.includes("--static-only");

const {
  registrationScript,
  harnessScript,
  registrationCommand,
  harnessCommand,
  pg17Command,
  pg18Command,
} = mailRetentionRedaction0063CiContract;
assert.doesNotMatch(
  nativeHarness,
  /\.\.\.process\.env/u,
  "0063 native children must not inherit the parent environment",
);
assert.equal(
  [...nativeHarness.matchAll(/\bspawnSync\(/gu)].length,
  1,
  "all 0063 native children must use one reviewed spawn wrapper",
);

const {
  buildNativeChildSpawnOptions,
  childCommandFailure,
} = await import("./mail-retention-redaction-0063.integration.mjs");
const seededSensitiveValues = Object.freeze({
  AWS_SECRET_ACCESS_KEY: "fake-cloud-secret-0063",
  AZURE_STORAGE_CONNECTION_STRING: "fake-azure-secret-0063",
  GOOGLE_APPLICATION_CREDENTIALS: "fake-google-secret-0063",
  GITHUB_TOKEN: "fake-token-0063",
  HTTP_PROXY: "http://fake-proxy-secret-0063.invalid",
  HTTPS_PROXY: "https://fake-proxy-secret-0063.invalid",
  ALL_PROXY: "socks5://fake-proxy-secret-0063.invalid",
  NO_PROXY: "fake-no-proxy-secret-0063.invalid",
  DATABASE_URL: "postgresql://secret:secret@database.invalid/secret",
  POSTGRES_URL: "postgresql://secret:secret@database.invalid/secret",
  PGPASSWORD: "fake-pg-password-0063",
  PGSERVICEFILE: "fake-pg-service-secret-0063",
});
const seededParentEnvironment = Object.freeze({
  PATH: "C:\\reviewed-path",
  SystemRoot: "C:\\Windows",
  WINDIR: "C:\\Windows",
  ComSpec: "C:\\Windows\\System32\\cmd.exe",
  PATHEXT: ".COM;.EXE;.CMD",
  TEMP: "C:\\reviewed-temp",
  TMP: "C:\\reviewed-tmp",
  HOME: "/home/reviewed",
  USERPROFILE: "C:\\Users\\reviewed",
  HOMEDRIVE: "C:",
  HOMEPATH: "\\Users\\reviewed",
  LANG: "en_US.UTF-8",
  LC_ALL: "C.UTF-8",
  LC_CTYPE: "C.UTF-8",
  POSTGRES_18_BIN: "parent-value-must-not-be-implicit",
  PGCONNECT_TIMEOUT: "999999",
  PSQL_HISTORY: "history-must-remain-disabled",
  ...seededSensitiveValues,
});
const explicitPostgresEnvironment = Object.freeze({
  POSTGRES_18_BIN: "C:\\Program Files\\PostgreSQL\\18\\bin",
});
const expectedChildEnvironment = Object.freeze({
  PATH: seededParentEnvironment.PATH,
  SystemRoot: seededParentEnvironment.SystemRoot,
  WINDIR: seededParentEnvironment.WINDIR,
  ComSpec: seededParentEnvironment.ComSpec,
  PATHEXT: seededParentEnvironment.PATHEXT,
  TEMP: seededParentEnvironment.TEMP,
  TMP: seededParentEnvironment.TMP,
  HOME: seededParentEnvironment.HOME,
  USERPROFILE: seededParentEnvironment.USERPROFILE,
  HOMEDRIVE: seededParentEnvironment.HOMEDRIVE,
  HOMEPATH: seededParentEnvironment.HOMEPATH,
  LANG: seededParentEnvironment.LANG,
  LC_ALL: seededParentEnvironment.LC_ALL,
  LC_CTYPE: seededParentEnvironment.LC_CTYPE,
  POSTGRES_18_BIN: explicitPostgresEnvironment.POSTGRES_18_BIN,
  PGCONNECT_TIMEOUT: "5",
  PSQL_HISTORY: os.devNull,
});

for (const label of [
  "initdb",
  "postgres_version",
  "psql",
  "migration_0063_replay",
]) {
  const childOptions = buildNativeChildSpawnOptions(
    { label },
    seededParentEnvironment,
    explicitPostgresEnvironment,
  );
  assert.deepEqual(childOptions.env, expectedChildEnvironment);
  const serializedEnvironment = JSON.stringify(childOptions.env);
  for (const secret of Object.values(seededSensitiveValues)) {
    assert.equal(serializedEnvironment.includes(secret), false);
  }
}

for (const invalidEnvironment of [
  { DATABASE_URL: seededSensitiveValues.DATABASE_URL },
  {
    POSTGRES_18_BIN: explicitPostgresEnvironment.POSTGRES_18_BIN,
    postgres_18_bin: "duplicate-postgres-bin",
  },
  {
    POSTGRES_17_BIN: "/usr/lib/postgresql/17/bin",
    POSTGRES_18_BIN: "/usr/lib/postgresql/18/bin",
  },
]) {
  assert.throws(
    () => buildNativeChildSpawnOptions(
      { label: "postgres_version" },
      seededParentEnvironment,
      invalidEnvironment,
    ),
    (error) => {
      assert.equal(error?.message, "invalid_child_environment_input");
      for (const value of Object.values(invalidEnvironment)) {
        assert.equal((error?.message ?? "").includes(value), false);
      }
      return true;
    },
  );
}
assert.throws(
  () => buildNativeChildSpawnOptions(
    { label: "postgres_version" },
    { PATH: "first-path", Path: "duplicate-path" },
    explicitPostgresEnvironment,
  ),
  { message: "invalid_child_environment_input" },
);

for (const [result, expectedMessage] of [
  [
    {
      error: new Error(seededSensitiveValues.GITHUB_TOKEN),
      status: null,
      stdout: "",
      stderr: "",
    },
    "migration_0063_replay_spawn_failed",
  ],
  [
    {
      status: 1,
      stdout: seededSensitiveValues.DATABASE_URL,
      stderr: seededSensitiveValues.PGPASSWORD,
    },
    "migration_0063_replay_failed_status_1",
  ],
]) {
  const error = childCommandFailure(result, "migration_0063_replay");
  assert.equal(error?.message, expectedMessage);
  assert.equal(error?.cause, undefined);
  const serializedError = `${error?.message ?? ""}\n${error?.stack ?? ""}`;
  for (const secret of Object.values(seededSensitiveValues)) {
    assert.equal(serializedError.includes(secret), false);
  }
}

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
