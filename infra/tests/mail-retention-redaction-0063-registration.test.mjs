#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const nativeHarness = read(
  "infra/tests/mail-retention-redaction-0063.integration.mjs",
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
  buildPostgresServerOptions,
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
const posixPostgresBin = "/usr/lib/postgresql/18/bin";
const posixEnvironment = buildNativeChildSpawnOptions(
  { label: "posix_model" },
  {
    PATH: "/home/ambient-profile/.local/bin:/reviewed/bin",
    path: "/unreviewed/lowercase/bin",
    LANG: "C.UTF-8",
    HOME: "/home/ambient-profile",
    TEMP: "/ambient/temp-secret",
    TMPDIR: "/ambient/tmpdir-secret",
    ...seededSecretEnvironment,
  },
  { POSTGRES_18_BIN: posixPostgresBin },
  posixFilesystem,
  "linux",
).env;
assert.deepEqual(posixEnvironment, {
  PATH: `${posixPostgresBin}:/usr/bin:/bin`,
  LANG: "C.UTF-8",
  HOME: posixFilesystem.profileDirectory,
  TEMP: posixFilesystem.tempDirectory,
  TMP: posixFilesystem.tempDirectory,
  TMPDIR: posixFilesystem.tempDirectory,
  POSTGRES_18_BIN: posixPostgresBin,
  PGCONNECT_TIMEOUT: "5",
  PSQL_HISTORY: "/dev/null",
});
assert.equal(posixEnvironment.PATH.includes("/home/ambient-profile"), false);
const posixLowercaseOnly = buildNativeChildSpawnOptions(
  { label: "posix_lowercase_model" },
  { path: "/home/ambient-profile/unreviewed/bin" },
  { POSTGRES_18_BIN: posixPostgresBin },
  posixFilesystem,
  "linux",
).env;
assert.equal(
  posixLowercaseOnly.PATH,
  `${posixPostgresBin}:/usr/bin:/bin`,
);
const posixLowercasePostgresFailure = captureFailure(() =>
  buildNativeChildSpawnOptions(
    { label: "posix_lowercase_postgres_model" },
    { PATH: "/home/ambient-profile/bin", HOME: "/home/ambient-profile" },
    { postgres_18_bin: posixPostgresBin },
    posixFilesystem,
    "linux",
  ));
assertSafeFailure(
  posixLowercasePostgresFailure,
  "invalid_child_environment_input",
);

const windowsFilesystem = Object.freeze({
  taskRoot: "C:\\Temp\\codestead-mail-retention-0063-pg18-windows-model",
  profileDirectory:
    "C:\\Temp\\codestead-mail-retention-0063-pg18-windows-model\\profile",
  tempDirectory:
    "C:\\Temp\\codestead-mail-retention-0063-pg18-windows-model\\tmp",
});
const windowsPostgresBin = "C:\\PostgreSQL\\18\\bin";
const windowsEnvironment = buildNativeChildSpawnOptions(
  { label: "windows_model" },
  {
    Path: "C:\\Users\\ambient-profile-secret\\bin;C:\\reviewed-bin",
    SYSTEMROOT: "C:\\Windows",
    windir: "C:\\Windows",
    COMSPEC: "C:\\Windows\\System32\\cmd.exe",
    pathext: ".COM;.EXE;.CMD",
    lang: "en_US.UTF-8",
    HOME: "C:\\Users\\ambient-profile-secret",
    USERPROFILE: "C:\\Users\\ambient-profile-secret",
    TEMP: "C:\\Users\\ambient-profile-secret\\Temp",
    ...ambientIdentityEnvironment,
    ...seededSecretEnvironment,
  },
  { POSTGRES_18_BIN: windowsPostgresBin },
  windowsFilesystem,
  "win32",
).env;
assert.deepEqual(windowsEnvironment, {
  PATH: [
    windowsPostgresBin,
    "C:\\Windows\\System32",
    "C:\\Windows",
    "C:\\Windows\\System32\\Wbem",
  ].join(";"),
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
  POSTGRES_18_BIN: windowsPostgresBin,
  PGCONNECT_TIMEOUT: "5",
  PSQL_HISTORY: nullDeviceFor("win32"),
});
assert.equal(
  windowsEnvironment.PATH.toLowerCase()
    .includes("c:\\users\\ambient-profile-secret"),
  false,
);
const windowsLowercasePostgresEnvironment = buildNativeChildSpawnOptions(
  { label: "windows_lowercase_postgres_model" },
  {
    Path: "C:\\Users\\ambient-profile-secret\\bin",
    SystemRoot: "C:\\Windows",
  },
  { postgres_18_bin: windowsPostgresBin },
  windowsFilesystem,
  "win32",
).env;
assert.equal(
  windowsLowercasePostgresEnvironment.POSTGRES_18_BIN,
  windowsPostgresBin,
);
assert.equal(
  windowsLowercasePostgresEnvironment.PATH,
  [
    windowsPostgresBin,
    "C:\\Windows\\System32",
    "C:\\Windows",
    "C:\\Windows\\System32\\Wbem",
  ].join(";"),
);
assert.throws(
  () => buildNativeChildSpawnOptions(
    { label: "windows_duplicate_model" },
    { PATH: "first-path", Path: "duplicate-path" },
    { POSTGRES_18_BIN: windowsPostgresBin },
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
    POSTGRES_18_BIN: posixPostgresBin,
  },
]) {
  const error = captureFailure(() => buildNativeChildSpawnOptions(
    { label: "postgres_version" },
    { PATH: "/home/ambient-profile/bin", HOME: "/home/ambient-profile" },
    invalidEnvironment,
    posixFilesystem,
    "linux",
  ));
  assertSafeFailure(error, "invalid_child_environment_input");
}

const posixServerOptions = buildPostgresServerOptions(
  55432,
  posixFilesystem,
  "linux",
);
assert.match(
  posixServerOptions,
  new RegExp(
    `(?:^| )-c unix_socket_directories="${posixFilesystem.tempDirectory}"`,
    "u",
  ),
);
assert.doesNotMatch(
  buildPostgresServerOptions(55432, windowsFilesystem, "win32"),
  /unix_socket_directories/u,
);

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
const cleanupReportRoot = mkdtempSync(path.join(
  os.tmpdir(),
  "codestead-mail-retention-0063-cleanup-reports-",
));
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
    TMPDIR: ambientProfile,
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
  if (process.platform === "win32") {
    assert.equal(Object.hasOwn(childOptions.env, "TMPDIR"), false);
  } else {
    assert.equal(childOptions.env.TMPDIR, childFilesystem.tempDirectory);
  }
  assert.equal(
    childOptions.env.POSTGRES_18_BIN,
    explicitPostgresEnvironment.POSTGRES_18_BIN,
  );
  assert.equal(childOptions.env.PGCONNECT_TIMEOUT, "5");
  assert.equal(childOptions.env.PSQL_HISTORY, nullDeviceFor(process.platform));
  const ambientProfileSubstrings = [
    process.env.USERPROFILE,
    process.env.HOME,
    ambientProfile,
  ].filter((value, index, values) =>
    typeof value === "string"
    && value.length > 0
    && values.indexOf(value) === index);
  for (const profileSubstring of ambientProfileSubstrings) {
    assert.equal(
      childOptions.env.PATH.toLowerCase()
        .includes(profileSubstring.toLowerCase()),
      false,
    );
  }
  const profileSubstringDigestSpecs = ambientProfileSubstrings
    .map((value) => value.toLowerCase())
    .map((value) => ({ digest: digest(value), length: value.length }));
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
      const forbiddenPathSubstrings = JSON.parse(process.argv[4]);
      const childPath = (process.env.PATH ?? "").toLowerCase();
      for (const forbidden of forbiddenPathSubstrings) {
        for (
          let index = 0;
          index <= childPath.length - forbidden.length;
          index += 1
        ) {
          assert.notEqual(
            digest(childPath.slice(index, index + forbidden.length)),
            forbidden.digest,
          );
        }
      }
      const profileRoots = process.platform === "win32"
        ? [
            process.env.HOME,
            process.env.USERPROFILE,
            (process.env.HOMEDRIVE ?? "") + (process.env.HOMEPATH ?? ""),
          ]
        : [process.env.HOME];
      const tempRoots = process.platform === "win32"
        ? [process.env.TEMP, process.env.TMP]
        : [process.env.TEMP, process.env.TMP, process.env.TMPDIR];
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
      JSON.stringify(profileSubstringDigestSpecs),
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

  const nestedTemporaryEntryNames = () =>
    readdirSync(childFilesystem.tempDirectory, { withFileTypes: true })
      .map((entry) =>
        `${entry.name}:${entry.isDirectory() ? "directory" : "entry"}`)
      .sort();
  const integrationHarnessPath = fileURLToPath(
    new URL(
      "./mail-retention-redaction-0063.integration.mjs",
      import.meta.url,
    ),
  );
  const missingPostgresEnvironment = {
    POSTGRES_18_BIN: path.join(
      canaryTaskRoot,
      "missing-postgres-bin",
    ),
  };
  const readCleanupReport = (reportPath) => {
    assert.equal(
      existsSync(reportPath),
      true,
      "nested harness must leave its cleanup report before outer cleanup",
    );
    return JSON.parse(readFileSync(reportPath, "utf8"));
  };
  const assertInvalidCleanupReportPath = (reportPath) => {
    const entriesBeforeInvalidReport = nestedTemporaryEntryNames();
    const result = runNativeChild(
      process.execPath,
      [
        integrationHarnessPath,
        `--cleanup-report=${reportPath}`,
      ],
      { allowFailure: true, label: "canary_invalid_cleanup_report" },
      seededParentEnvironment,
      missingPostgresEnvironment,
      childFilesystem,
      process.platform,
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "mail_retention_0063=invalid_cleanup_report_path\n",
    );
    assert.deepEqual(
      nestedTemporaryEntryNames(),
      entriesBeforeInvalidReport,
    );
  };
  const traversalReportPath = cleanupReportRoot
    + path.sep
    + ".."
    + path.sep
    + path.basename(cleanupReportRoot)
    + path.sep
    + "success.json";
  assertInvalidCleanupReportPath(traversalReportPath);

  const existingReportPath = path.join(
    cleanupReportRoot,
    "existing.json",
  );
  writeFileSync(existingReportPath, "preexisting-marker\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  assertInvalidCleanupReportPath(existingReportPath);
  assert.equal(
    readFileSync(existingReportPath, "utf8"),
    "preexisting-marker\n",
  );

  const symlinkReportPath = path.join(
    cleanupReportRoot,
    "symlink.json",
  );
  symlinkSync(
    path.join(cleanupReportRoot, "missing-symlink-target"),
    symlinkReportPath,
    "file",
  );
  assertInvalidCleanupReportPath(symlinkReportPath);
  assert.equal(existsSync(symlinkReportPath), false);
  const expectedSuccessfulCleanupReport = {
    schemaVersion: 1,
    cleanupVerified: true,
    taskRootRemoved: true,
    profileDirectoryRemoved: true,
    tempDirectoryRemoved: true,
    injectedLeakDetected: false,
    recoveryVerified: true,
  };
  const entriesBeforeTopLevelCanary = nestedTemporaryEntryNames();
  const successfulCleanupReportPath = path.join(
    cleanupReportRoot,
    "success.json",
  );
  const topLevelResult = runNativeChild(
    process.execPath,
    [
      integrationHarnessPath,
      `--cleanup-report=${successfulCleanupReportPath}`,
    ],
    { allowFailure: true, label: "canary_top_level" },
    seededParentEnvironment,
    missingPostgresEnvironment,
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
    nestedTemporaryEntryNames(),
    entriesBeforeTopLevelCanary,
  );
  assert.deepEqual(
    readCleanupReport(successfulCleanupReportPath),
    expectedSuccessfulCleanupReport,
  );

  const entriesBeforeLeakInjection = nestedTemporaryEntryNames();
  const injectedLeakReportPath = path.join(
    cleanupReportRoot,
    "injected-leak.json",
  );
  const injectedLeakResult = runNativeChild(
    process.execPath,
    [
      integrationHarnessPath,
      `--cleanup-report=${injectedLeakReportPath}`,
      "--inject-cleanup-leak",
    ],
    { allowFailure: true, label: "canary_injected_cleanup_leak" },
    seededParentEnvironment,
    missingPostgresEnvironment,
    childFilesystem,
    process.platform,
  );
  assert.equal(injectedLeakResult.status, 1);
  assert.equal(injectedLeakResult.stdout, "");
  assert.equal(
    injectedLeakResult.stderr,
    "mail_retention_0063=temporary_postgres_cleanup_failed\n"
      + "mail_retention_0063=postgres_version_spawn_failed\n",
  );
  assert.deepEqual(
    nestedTemporaryEntryNames(),
    entriesBeforeLeakInjection,
  );
  assert.deepEqual(
    readCleanupReport(injectedLeakReportPath),
    {
      schemaVersion: 1,
      cleanupVerified: false,
      taskRootRemoved: false,
      profileDirectoryRemoved: false,
      tempDirectoryRemoved: false,
      injectedLeakDetected: true,
      recoveryVerified: true,
    },
  );
  for (const reportPath of [
    successfulCleanupReportPath,
    injectedLeakReportPath,
  ]) {
    const serializedCleanupReport = readFileSync(reportPath, "utf8");
    for (const sensitiveValue of canaryAmbientValues) {
      assert.equal(serializedCleanupReport.includes(sensitiveValue), false);
    }
  }
  for (const sensitiveValue of seededSensitiveValues) {
    assert.equal(
      `${topLevelResult.stdout}${topLevelResult.stderr}`
        .includes(sensitiveValue),
      false,
    );
    assert.equal(
      `${injectedLeakResult.stdout}${injectedLeakResult.stderr}`
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
  const cleanupReportTarget = path.resolve(cleanupReportRoot);
  const cleanupTarget = path.resolve(canaryTaskRoot);
  try {
    assert.ok(cleanupReportTarget.startsWith(resolvedOperatingSystemTemp));
    assert.match(
      path.basename(cleanupReportTarget),
      /^codestead-mail-retention-0063-cleanup-reports-/u,
    );
    rmSync(cleanupReportTarget, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  } finally {
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
    "PostgreSQL 16 cannot re-enter the matrix",
    `${postgresJob}      - run: POSTGRES_16_BIN=/usr/lib/postgresql/16/bin npm run test:future-mail-gate\n`,
    /PostgreSQL 16/u,
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
