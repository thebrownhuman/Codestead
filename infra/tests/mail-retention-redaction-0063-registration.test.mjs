#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
assert.match(
  nativeHarness,
  /export function createNativeChildFilesystem/u,
  "0063 must derive fresh child profile and temp roots per run",
);
assert.doesNotMatch(
  nativeHarness,
  /error\.message\.replace/u,
  "0063 outward failures must use fixed codes",
);
assert.doesNotMatch(
  nativeHarness,
  /JSON\.parse\(scalar/u,
  "0063 child JSON must pass through a fixed-code parser",
);

const {
  buildNativeChildSpawnOptions,
  createNativeChildFilesystem,
  outwardFailureCode,
  parseChildJsonOutput,
  runNativeChild,
} = await import("./mail-retention-redaction-0063.integration.mjs");

const seededSecretEnvironment = Object.freeze({
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
  PGHOST: "fake-pg-host-secret-0063",
  PGPASSFILE: "fake-pg-passfile-secret-0063",
  PSQLRC: "fake-psqlrc-secret-0063",
});
const ambientIdentityEnvironment = Object.freeze({
  LOGONSERVER: "\\\\ambient-logon-secret",
  SYSTEMDRIVE: "Z:",
  USERDOMAIN: "ambient-domain-secret",
  USERNAME: "ambient-username-secret",
});
const ambientPgpassMarker = "fake-ambient-pgpass-secret-0063";
const seededSensitiveValues = Object.freeze([
  ...Object.values(seededSecretEnvironment),
  ...Object.values(ambientIdentityEnvironment),
  ambientPgpassMarker,
]);
const explicitPostgresEnvironment = Object.freeze({
  POSTGRES_18_BIN: process.platform === "win32"
    ? "C:\\Program Files\\PostgreSQL\\18\\bin"
    : "/usr/lib/postgresql/18/bin",
});
const digest = (value) => createHash("sha256")
  .update(value, "utf8")
  .digest("hex");
const nullDeviceFor = (platform) => platform === "win32"
  ? String.raw`\\.\nul`
  : "/dev/null";

function captureFailure(action) {
  let observed;
  try {
    action();
  } catch (error) {
    observed = error;
  }
  assert.ok(observed instanceof Error);
  return observed;
}

function assertSafeFailure(error, expectedCode) {
  assert.equal(outwardFailureCode(error), expectedCode);
  assert.equal(error.message, expectedCode);
  assert.equal(error.cause, undefined);
  const serialized = `${error.message}\n${error.stack ?? ""}`;
  for (const sensitiveValue of seededSensitiveValues) {
    assert.equal(serialized.includes(sensitiveValue), false);
  }
}

const posixFilesystem = Object.freeze({
  taskRoot: "/tmp/codestead-mail-retention-0063-pg18-posix-model",
  profileDirectory:
    "/tmp/codestead-mail-retention-0063-pg18-posix-model/profile",
  tempDirectory:
    "/tmp/codestead-mail-retention-0063-pg18-posix-model/tmp",
});
const posixEnvironment = buildNativeChildSpawnOptions(
  { label: "posix_model" },
  {
    PATH: "/reviewed/bin",
    path: "/unreviewed/lowercase/bin",
    LANG: "C.UTF-8",
    HOME: "/ambient/home-secret",
    TEMP: "/ambient/temp-secret",
    ...seededSecretEnvironment,
  },
  { POSTGRES_18_BIN: "/usr/lib/postgresql/18/bin" },
  posixFilesystem,
  "linux",
).env;
assert.deepEqual(posixEnvironment, {
  PATH: "/reviewed/bin",
  LANG: "C.UTF-8",
  HOME: posixFilesystem.profileDirectory,
  TEMP: posixFilesystem.tempDirectory,
  TMP: posixFilesystem.tempDirectory,
  POSTGRES_18_BIN: "/usr/lib/postgresql/18/bin",
  PGCONNECT_TIMEOUT: "5",
  PSQL_HISTORY: "/dev/null",
});
const posixLowercaseOnly = buildNativeChildSpawnOptions(
  { label: "posix_lowercase_model" },
  { path: "/unreviewed/lowercase/bin" },
  { POSTGRES_18_BIN: "/usr/lib/postgresql/18/bin" },
  posixFilesystem,
  "linux",
).env;
assert.equal(Object.hasOwn(posixLowercaseOnly, "PATH"), false);

const windowsFilesystem = Object.freeze({
  taskRoot: "C:\\Temp\\codestead-mail-retention-0063-pg18-windows-model",
  profileDirectory:
    "C:\\Temp\\codestead-mail-retention-0063-pg18-windows-model\\profile",
  tempDirectory:
    "C:\\Temp\\codestead-mail-retention-0063-pg18-windows-model\\tmp",
});
const windowsEnvironment = buildNativeChildSpawnOptions(
  { label: "windows_model" },
  {
    Path: "C:\\reviewed-bin",
    SYSTEMROOT: "C:\\Windows",
    windir: "C:\\Windows",
    COMSPEC: "C:\\Windows\\System32\\cmd.exe",
    pathext: ".COM;.EXE;.CMD",
    lang: "en_US.UTF-8",
    HOME: "C:\\ambient-home-secret",
    USERPROFILE: "C:\\ambient-profile-secret",
    TEMP: "C:\\ambient-temp-secret",
    ...ambientIdentityEnvironment,
    ...seededSecretEnvironment,
  },
  { POSTGRES_18_BIN: "C:\\PostgreSQL\\18\\bin" },
  windowsFilesystem,
  "win32",
).env;
assert.deepEqual(windowsEnvironment, {
  PATH: "C:\\reviewed-bin",
  SystemRoot: "C:\\Windows",
  WINDIR: "C:\\Windows",
  ComSpec: "C:\\Windows\\System32\\cmd.exe",
  PATHEXT: ".COM;.EXE;.CMD",
  LANG: "en_US.UTF-8",
  HOME: windowsFilesystem.profileDirectory,
  USERPROFILE: windowsFilesystem.profileDirectory,
  HOMEDRIVE: "C:",
  HOMEPATH:
    "\\Temp\\codestead-mail-retention-0063-pg18-windows-model\\profile",
  TEMP: windowsFilesystem.tempDirectory,
  TMP: windowsFilesystem.tempDirectory,
  LOGONSERVER: "CODESTEAD_TEST",
  SYSTEMDRIVE: "C:",
  USERDOMAIN: "CODESTEAD_TEST",
  USERNAME: "codestead_test",
  POSTGRES_18_BIN: "C:\\PostgreSQL\\18\\bin",
  PGCONNECT_TIMEOUT: "5",
  PSQL_HISTORY: nullDeviceFor("win32"),
});
assert.throws(
  () => buildNativeChildSpawnOptions(
    { label: "windows_duplicate_model" },
    { PATH: "first-path", Path: "duplicate-path" },
    { POSTGRES_18_BIN: "C:\\PostgreSQL\\18\\bin" },
    windowsFilesystem,
    "win32",
  ),
  { message: "invalid_child_environment_input" },
);

for (const invalidEnvironment of [
  { DATABASE_URL: seededSecretEnvironment.DATABASE_URL },
  {
    POSTGRES_18_BIN: explicitPostgresEnvironment.POSTGRES_18_BIN,
    postgres_18_bin: "duplicate-postgres-bin",
  },
  {
    POSTGRES_17_BIN: "/usr/lib/postgresql/17/bin",
    POSTGRES_18_BIN: "/usr/lib/postgresql/18/bin",
  },
]) {
  const error = captureFailure(() => buildNativeChildSpawnOptions(
    { label: "postgres_version" },
    { PATH: "/reviewed/bin" },
    invalidEnvironment,
    posixFilesystem,
    "linux",
  ));
  assertSafeFailure(error, "invalid_child_environment_input");
}

const canaryTaskRoot = mkdtempSync(path.join(
  os.tmpdir(),
  "codestead-mail-retention-0063-pg18-canary-",
));
const resolvedCanaryTaskRoot = path.resolve(canaryTaskRoot);
const resolvedOperatingSystemTemp = `${path.resolve(os.tmpdir())}${path.sep}`;
assert.ok(resolvedCanaryTaskRoot.startsWith(resolvedOperatingSystemTemp));
assert.match(
  path.basename(resolvedCanaryTaskRoot),
  /^codestead-mail-retention-0063-pg18-canary-/u,
);
try {
  const ambientProfile = path.join(canaryTaskRoot, "ambient-profile");
  mkdirSync(ambientProfile, { mode: 0o700 });
  writeFileSync(
    path.join(ambientProfile, ".pgpass"),
    `${ambientPgpassMarker}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  const childFilesystem = createNativeChildFilesystem(canaryTaskRoot);
  const reviewedSystemEnvironment = process.platform === "win32"
    ? {
        Path: process.env.PATH ?? "C:\\Windows\\System32",
        SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
        WINDIR: process.env.WINDIR ?? "C:\\Windows",
        ComSpec: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
        PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.CMD",
        ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
      }
    : {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
        ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
        ...(process.env.LC_CTYPE ? { LC_CTYPE: process.env.LC_CTYPE } : {}),
      };
  const seededParentEnvironment = Object.freeze({
    ...reviewedSystemEnvironment,
    HOME: ambientProfile,
    USERPROFILE: ambientProfile,
    HOMEDRIVE: "Z:",
    HOMEPATH: "\\ambient-profile-secret",
    TEMP: ambientProfile,
    TMP: ambientProfile,
    POSTGRES_18_BIN: "ambient-postgres-bin-must-not-pass",
    PGCONNECT_TIMEOUT: "999999",
    PSQL_HISTORY: path.join(ambientProfile, ".psql_history"),
    ...ambientIdentityEnvironment,
    ...seededSecretEnvironment,
  });
  const canaryAmbientValues = Object.freeze([
    ...seededSensitiveValues,
    ambientProfile,
    "Z:",
    "\\ambient-profile-secret",
    "ambient-postgres-bin-must-not-pass",
    "999999",
    path.join(ambientProfile, ".psql_history"),
  ]);
  const childOptions = buildNativeChildSpawnOptions(
    { label: "child_environment_canary" },
    seededParentEnvironment,
    explicitPostgresEnvironment,
    childFilesystem,
    process.platform,
  );
  assert.equal(childOptions.env.HOME, childFilesystem.profileDirectory);
  assert.equal(childOptions.env.TEMP, childFilesystem.tempDirectory);
  assert.equal(childOptions.env.TMP, childFilesystem.tempDirectory);
  assert.equal(
    childOptions.env.POSTGRES_18_BIN,
    explicitPostgresEnvironment.POSTGRES_18_BIN,
  );
  assert.equal(childOptions.env.PGCONNECT_TIMEOUT, "5");
  assert.equal(childOptions.env.PSQL_HISTORY, nullDeviceFor(process.platform));
  const serializedEnvironment = JSON.stringify(childOptions.env);
  for (const sensitiveValue of canaryAmbientValues) {
    assert.equal(serializedEnvironment.includes(sensitiveValue), false);
  }
  for (const sensitiveName of Object.keys(seededSecretEnvironment)) {
    assert.equal(Object.hasOwn(childOptions.env, sensitiveName), false);
  }

  const childCanarySource = String.raw`
    import assert from "node:assert/strict";
    import { createHash } from "node:crypto";
    import { existsSync } from "node:fs";
    import path from "node:path";

    const digest = (value) => createHash("sha256")
      .update(value, "utf8")
      .digest("hex");
    try {
      const keys = Object.keys(process.env).sort();
      for (const forbidden of [
        "AWS_SECRET_ACCESS_KEY",
        "AZURE_STORAGE_CONNECTION_STRING",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GITHUB_TOKEN",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "DATABASE_URL",
        "POSTGRES_URL",
        "PGPASSWORD",
        "PGSERVICEFILE",
        "PGHOST",
        "PGPASSFILE",
        "PSQLRC",
        "APPDATA",
        "LOCALAPPDATA",
        "USERDOMAIN_ROAMINGPROFILE",
      ]) {
        assert.equal(
          keys.some((key) => key.toUpperCase() === forbidden),
          false,
        );
      }
      const forbiddenValueHashes = new Set(JSON.parse(process.argv[3]));
      assert.equal(
        Object.values(process.env).some((value) =>
          forbiddenValueHashes.has(digest(value))),
        false,
      );
      const profileRoots = process.platform === "win32"
        ? [
            process.env.HOME,
            process.env.USERPROFILE,
            (process.env.HOMEDRIVE ?? "") + (process.env.HOMEPATH ?? ""),
          ]
        : [process.env.HOME];
      const tempRoots = [process.env.TEMP, process.env.TMP];
      assert.equal(profileRoots.every((value) => typeof value === "string"), true);
      assert.equal(tempRoots.every((value) => typeof value === "string"), true);
      assert.equal(
        profileRoots.every((value) => digest(value) === process.argv[1]),
        true,
      );
      assert.equal(
        tempRoots.every((value) => digest(value) === process.argv[2]),
        true,
      );
      assert.equal(existsSync(path.join(process.env.HOME, ".pgpass")), false);
      if (process.platform === "win32") {
        assert.equal(process.env.LOGONSERVER, "CODESTEAD_TEST");
        assert.equal(process.env.SYSTEMDRIVE, process.env.HOMEDRIVE);
        assert.equal(process.env.USERDOMAIN, "CODESTEAD_TEST");
        assert.equal(process.env.USERNAME, "codestead_test");
      }
      process.stdout.write(JSON.stringify({
        keys,
        profileRootHashes: profileRoots.map(digest),
        tempRootHashes: tempRoots.map(digest),
      }));
    } catch {
      process.stderr.write("child_environment_canary_failed\n");
      process.exitCode = 1;
    }
  `;
  const profileHash = digest(childFilesystem.profileDirectory);
  const tempHash = digest(childFilesystem.tempDirectory);
  const forbiddenValueHashes = canaryAmbientValues.map(digest).sort();
  const canaryResult = runNativeChild(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      childCanarySource,
      profileHash,
      tempHash,
      JSON.stringify(forbiddenValueHashes),
    ],
    { label: "child_environment_canary" },
    seededParentEnvironment,
    explicitPostgresEnvironment,
    childFilesystem,
    process.platform,
  );
  const canaryReport = parseChildJsonOutput(
    canaryResult.stdout,
    "child_environment_canary",
  );
  assert.equal(canaryResult.stderr, "");
  assert.deepEqual(
    canaryReport.keys,
    Object.keys(childOptions.env).sort(),
  );
  assert.equal(
    canaryReport.profileRootHashes.every((value) => value === profileHash),
    true,
  );
  assert.equal(
    canaryReport.tempRootHashes.every((value) => value === tempHash),
    true,
  );
  assert.notEqual(profileHash, digest(ambientProfile));
  const serializedReport = JSON.stringify(canaryReport);
  for (const sensitiveValue of canaryAmbientValues) {
    assert.equal(serializedReport.includes(sensitiveValue), false);
  }

  const spawnFailure = captureFailure(() => runNativeChild(
    path.join(canaryTaskRoot, "missing-native-child"),
    [],
    { label: "canary_spawn" },
    seededParentEnvironment,
    explicitPostgresEnvironment,
    childFilesystem,
    process.platform,
  ));
  assertSafeFailure(spawnFailure, "canary_spawn_spawn_failed");

  const retentionTemporaryRootNames = () => readdirSync(os.tmpdir())
    .filter((name) =>
      /^codestead-mail-retention-0063-pg(?:17|18)-/u.test(name))
    .sort();
  const rootsBeforeTopLevelCanary = retentionTemporaryRootNames();
  const topLevelResult = runNativeChild(
    process.execPath,
    [
      fileURLToPath(
        new URL(
          "./mail-retention-redaction-0063.integration.mjs",
          import.meta.url,
        ),
      ),
    ],
    { allowFailure: true, label: "canary_top_level" },
    seededParentEnvironment,
    {
      POSTGRES_18_BIN: path.join(
        canaryTaskRoot,
        "missing-postgres-bin",
      ),
    },
    childFilesystem,
    process.platform,
  );
  assert.equal(topLevelResult.status, 1);
  assert.equal(topLevelResult.stdout, "");
  assert.equal(
    topLevelResult.stderr,
    "mail_retention_0063=postgres_version_spawn_failed\n",
  );
  assert.deepEqual(
    retentionTemporaryRootNames(),
    rootsBeforeTopLevelCanary,
  );
  for (const sensitiveValue of seededSensitiveValues) {
    assert.equal(
      `${topLevelResult.stdout}${topLevelResult.stderr}`
        .includes(sensitiveValue),
      false,
    );
  }
  const nonzeroFailure = captureFailure(() => runNativeChild(
    process.execPath,
    [
      "--eval",
      `process.stdout.write(${JSON.stringify(seededSecretEnvironment.DATABASE_URL)});`
        + `process.stderr.write(${JSON.stringify(seededSecretEnvironment.PGPASSWORD)});`
        + "process.exit(7);",
    ],
    { label: "canary_nonzero" },
    seededParentEnvironment,
    explicitPostgresEnvironment,
    childFilesystem,
    process.platform,
  ));
  assertSafeFailure(nonzeroFailure, "canary_nonzero_failed_status_7");

  const malformedResult = runNativeChild(
    process.execPath,
    [
      "--eval",
      `process.stdout.write(${JSON.stringify(seededSecretEnvironment.GITHUB_TOKEN)});`,
    ],
    { label: "canary_malformed" },
    seededParentEnvironment,
    explicitPostgresEnvironment,
    childFilesystem,
    process.platform,
  );
  const malformedFailure = captureFailure(() => parseChildJsonOutput(
    malformedResult.stdout,
    "canary_json",
  ));
  assertSafeFailure(malformedFailure, "canary_json_invalid_json");
  assert.equal(
    outwardFailureCode(new Error(seededSecretEnvironment.GITHUB_TOKEN)),
    "unexpected_failure",
  );
} finally {
  const cleanupTarget = path.resolve(canaryTaskRoot);
  assert.equal(cleanupTarget, resolvedCanaryTaskRoot);
  assert.ok(cleanupTarget.startsWith(resolvedOperatingSystemTemp));
  assert.match(
    path.basename(cleanupTarget),
    /^codestead-mail-retention-0063-pg18-canary-/u,
  );
  rmSync(cleanupTarget, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
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
