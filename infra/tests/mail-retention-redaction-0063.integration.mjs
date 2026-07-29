#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");
const migrationDirectory = path.join(repositoryRoot, "drizzle");
const journalPath = path.join(migrationDirectory, "meta", "_journal.json");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const requestedPg18Bin = process.env.POSTGRES_18_BIN?.trim();
const requestedPg17Bin = process.env.POSTGRES_17_BIN?.trim();
const expectedPostgresMajor = requestedPg18Bin ? 18 : 17;
const defaultPostgresBin = process.platform === "win32"
  ? `C:\\Program Files\\PostgreSQL\\${expectedPostgresMajor}\\bin`
  : "";
const postgresBin =
  requestedPg18Bin || requestedPg17Bin || defaultPostgresBin;
const commandTimeoutMs = 45_000;

function executable(name) {
  return postgresBin
    ? path.join(postgresBin, `${name}${executableSuffix}`)
    : name;
}

const posixPlatformChildEnvironmentNames = Object.freeze([
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
]);
const posixPlatformChildEnvironmentNameSet = new Set(
  posixPlatformChildEnvironmentNames,
);
const windowsPlatformChildEnvironmentNames = Object.freeze([
  "PATH",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
]);
const windowsPlatformChildEnvironmentByLowercase = new Map(
  windowsPlatformChildEnvironmentNames.map((name) => [
    name.toLowerCase(),
    name,
  ]),
);
const postgresChildEnvironmentNames = Object.freeze([
  "POSTGRES_17_BIN",
  "POSTGRES_18_BIN",
]);
const postgresChildEnvironmentByLowercase = new Map(
  postgresChildEnvironmentNames.map((name) => [name.toLowerCase(), name]),
);
const selectedPostgresChildEnvironment = Object.freeze({
  ...(requestedPg17Bin ? { POSTGRES_17_BIN: requestedPg17Bin } : {}),
  ...(requestedPg18Bin ? { POSTGRES_18_BIN: requestedPg18Bin } : {}),
});
const pgConnectTimeoutSeconds = 5;
let activeNativeChildFilesystem;

class NativeHarnessError extends Error {
  constructor(code) {
    super(code);
    this.name = "NativeHarnessError";
    this.code = code;
  }
}

function nativeHarnessFailure(code) {
  return new NativeHarnessError(code);
}

export function outwardFailureCode(error) {
  if (error instanceof assert.AssertionError) return "assertion_failed";
  if (error instanceof NativeHarnessError) return error.code;
  const boundarySectionMatch =
    error instanceof Error
    && error.name === "DatabaseRoleBoundaryError"
      ? /^database role boundary verification failed: ((?:mail-worker-outbox-contract|mail-replay-authority-table-contract):[a-z0-9_,]{1,192})$/u.exec(
        error.message,
      )
      : null;
  if (boundarySectionMatch !== null) {
    return `database_role_boundary_${boundarySectionMatch[1]
      .replaceAll(":", "_")
      .replaceAll(",", "_")
      .replaceAll("-", "_")}`;
  }
  const safeErrorNames = new Map([
    ["BackupStatusMailAuthorityContractError", "backup_status_contract_error"],
    [
      "DatabaseBootstrapCleanupTimeoutError",
      "database_bootstrap_cleanup_timeout",
    ],
    ["DatabaseRoleBootstrapInvariantError", "database_role_bootstrap_error"],
    ["DatabaseRoleBoundaryError", "database_role_boundary_error"],
  ]);
  const safeErrorName = safeErrorNames.get(error?.name);
  if (safeErrorName !== undefined) return safeErrorName;
  const safeErrorMessages = new Map([
    [
      "database bootstrap authority verification failed",
      "database_bootstrap_authority_verification_failed",
    ],
  ]);
  const safeErrorMessage = safeErrorMessages.get(error?.message);
  if (safeErrorMessage !== undefined) return safeErrorMessage;
  const bootstrapInvariantMatch = error instanceof Error
    ? /^database role bootstrap invariant verification failed \[([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:: [^\]\r\n]*)?\]$/u.exec(
      error.message,
    )
    : null;
  if (bootstrapInvariantMatch !== null) {
    return `database_role_bootstrap_${bootstrapInvariantMatch[1].replaceAll(
      "-",
      "_",
    )}`;
  }
  if (
    typeof error?.code === "string"
    && /^[0-9A-Z]{5}$/u.test(error.code)
  ) {
    return `postgres_sqlstate_${error.code.toLowerCase()}`;
  }
  if (
    error instanceof Error
    && /^[a-z0-9_]{1,128}$/u.test(error.message)
  ) {
    return error.message;
  }
  return "unexpected_failure";
}

function invalidChildEnvironmentInput() {
  return nativeHarnessFailure("invalid_child_environment_input");
}

function platformPathImplementation(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function nullDeviceFor(platform) {
  return platform === "win32" ? String.raw`\\.\nul` : "/dev/null";
}

function canonicalFilesystemPath(value, platform) {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidChildEnvironmentInput();
  }
  const pathImplementation = platformPathImplementation(platform);
  if (!pathImplementation.isAbsolute(value)) {
    throw invalidChildEnvironmentInput();
  }
  const resolved = pathImplementation.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function validatedNativeChildFilesystem(filesystem, platform) {
  if (
    filesystem === null
    || typeof filesystem !== "object"
    || Array.isArray(filesystem)
  ) {
    throw invalidChildEnvironmentInput();
  }
  canonicalFilesystemPath(filesystem.taskRoot, platform);
  canonicalFilesystemPath(filesystem.profileDirectory, platform);
  canonicalFilesystemPath(filesystem.tempDirectory, platform);
  const pathImplementation = platformPathImplementation(platform);
  const taskRoot = pathImplementation.resolve(filesystem.taskRoot);
  const profileDirectory = pathImplementation.resolve(
    filesystem.profileDirectory,
  );
  const tempDirectory = pathImplementation.resolve(filesystem.tempDirectory);
  if (
    !/^codestead-mail-retention-0063-pg(?:17|18)-/u.test(
      pathImplementation.basename(taskRoot),
    )
    || canonicalFilesystemPath(profileDirectory, platform)
      !== canonicalFilesystemPath(
        pathImplementation.join(taskRoot, "profile"),
        platform,
      )
    || canonicalFilesystemPath(tempDirectory, platform)
      !== canonicalFilesystemPath(
        pathImplementation.join(taskRoot, "tmp"),
        platform,
      )
  ) {
    throw invalidChildEnvironmentInput();
  }
  return Object.freeze({ taskRoot, profileDirectory, tempDirectory });
}

export function createNativeChildFilesystem(taskRoot) {
  validateTemporaryRoot(taskRoot);
  const childFilesystem = validatedNativeChildFilesystem({
    taskRoot,
    profileDirectory: path.join(taskRoot, "profile"),
    tempDirectory: path.join(taskRoot, "tmp"),
  }, process.platform);
  mkdirSync(childFilesystem.profileDirectory, {
    mode: 0o700,
    recursive: false,
  });
  mkdirSync(childFilesystem.tempDirectory, {
    mode: 0o700,
    recursive: false,
  });
  return childFilesystem;
}

function platformChildEnvironment(sourceEnvironment, platform) {
  if (
    sourceEnvironment === null
    || typeof sourceEnvironment !== "object"
    || Array.isArray(sourceEnvironment)
  ) {
    throw invalidChildEnvironmentInput();
  }
  const observed = new Map();
  for (const [name, value] of Object.entries(sourceEnvironment)) {
    const canonicalName = platform === "win32"
      ? windowsPlatformChildEnvironmentByLowercase.get(name.toLowerCase())
      : posixPlatformChildEnvironmentNameSet.has(name)
        ? name
        : undefined;
    if (!canonicalName) continue;
    if (
      observed.has(canonicalName)
      || typeof value !== "string"
      || value.length === 0
    ) {
      throw invalidChildEnvironmentInput();
    }
    observed.set(canonicalName, value);
  }
  const orderedNames = platform === "win32"
    ? windowsPlatformChildEnvironmentNames
    : posixPlatformChildEnvironmentNames;
  return Object.fromEntries(
    orderedNames
      .filter((name) => observed.has(name))
      .map((name) => [name, observed.get(name)]),
  );
}

function explicitPostgresChildEnvironment(explicitEnvironment, platform) {
  if (
    explicitEnvironment === null
    || typeof explicitEnvironment !== "object"
    || Array.isArray(explicitEnvironment)
  ) {
    throw invalidChildEnvironmentInput();
  }
  const observed = new Map();
  const pathImplementation = platformPathImplementation(platform);
  for (const [name, value] of Object.entries(explicitEnvironment)) {
    const canonicalName = platform === "win32"
      ? postgresChildEnvironmentByLowercase.get(name.toLowerCase())
      : postgresChildEnvironmentNames.includes(name)
        ? name
        : undefined;
    const normalizedValue = typeof value === "string" ? value.trim() : "";
    if (
      !canonicalName
      || observed.has(canonicalName)
      || normalizedValue.length === 0
      || !pathImplementation.isAbsolute(normalizedValue)
    ) {
      throw invalidChildEnvironmentInput();
    }
    observed.set(canonicalName, normalizedValue);
  }
  if (
    observed.has("POSTGRES_17_BIN")
    && observed.has("POSTGRES_18_BIN")
  ) {
    throw invalidChildEnvironmentInput();
  }
  return Object.fromEntries(
    postgresChildEnvironmentNames
      .filter((name) => observed.has(name))
      .map((name) => [name, observed.get(name)]),
  );
}

function deterministicNativeChildPath(
  platformEnvironment,
  explicitPostgresEnvironment,
  platform,
) {
  const entries = postgresChildEnvironmentNames
    .filter((name) => Object.hasOwn(explicitPostgresEnvironment, name))
    .map((name) => explicitPostgresEnvironment[name]);
  if (platform === "win32") {
    const systemRoot =
      platformEnvironment.SystemRoot ?? platformEnvironment.WINDIR;
    if (
      typeof systemRoot !== "string"
      || !path.win32.isAbsolute(systemRoot)
    ) {
      throw invalidChildEnvironmentInput();
    }
    entries.push(
      path.win32.join(systemRoot, "System32"),
      path.win32.resolve(systemRoot),
      path.win32.join(systemRoot, "System32", "Wbem"),
    );
  } else {
    entries.push("/usr/bin", "/bin");
  }
  const observed = new Set();
  return entries
    .filter((entry) => {
      const key = platform === "win32" ? entry.toLowerCase() : entry;
      if (observed.has(key)) return false;
      observed.add(key);
      return true;
    })
    .join(platform === "win32" ? ";" : ":");
}

function filesystemChildEnvironment(filesystem, platform) {
  if (platform !== "win32") {
    return {
      HOME: filesystem.profileDirectory,
      TEMP: filesystem.tempDirectory,
      TMP: filesystem.tempDirectory,
      TMPDIR: filesystem.tempDirectory,
    };
  }
  const driveMatch = filesystem.profileDirectory.match(/^([a-zA-Z]:)\\/u);
  if (!driveMatch) throw invalidChildEnvironmentInput();
  const homeDrive = driveMatch[1].toUpperCase();
  const homePath = filesystem.profileDirectory.slice(homeDrive.length);
  if (!homePath.startsWith("\\")) throw invalidChildEnvironmentInput();
  return {
    HOME: filesystem.profileDirectory,
    USERPROFILE: filesystem.profileDirectory,
    HOMEDRIVE: homeDrive,
    HOMEPATH: homePath,
    TEMP: filesystem.tempDirectory,
    TMP: filesystem.tempDirectory,
    LOGONSERVER: "CODESTEAD_TEST",
    SYSTEMDRIVE: homeDrive,
    USERDOMAIN: "CODESTEAD_TEST",
    USERNAME: "codestead_test",
  };
}

export function buildNativeChildEnvironment(
  sourceEnvironment = process.env,
  explicitEnvironment = selectedPostgresChildEnvironment,
  filesystem = activeNativeChildFilesystem,
  platform = process.platform,
) {
  const childFilesystem = validatedNativeChildFilesystem(filesystem, platform);
  const platformEnvironment = platformChildEnvironment(
    sourceEnvironment,
    platform,
  );
  const explicitPostgresEnvironment = explicitPostgresChildEnvironment(
    explicitEnvironment,
    platform,
  );
  return Object.freeze({
    ...platformEnvironment,
    PATH: deterministicNativeChildPath(
      platformEnvironment,
      explicitPostgresEnvironment,
      platform,
    ),
    ...filesystemChildEnvironment(childFilesystem, platform),
    ...explicitPostgresEnvironment,
    PGCONNECT_TIMEOUT: String(pgConnectTimeoutSeconds),
    PSQL_HISTORY: nullDeviceFor(platform),
  });
}

export function buildNativeChildSpawnOptions(
  options = {},
  sourceEnvironment = process.env,
  explicitEnvironment = selectedPostgresChildEnvironment,
  filesystem = activeNativeChildFilesystem,
  platform = process.platform,
) {
  return {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: buildNativeChildEnvironment(
      sourceEnvironment,
      explicitEnvironment,
      filesystem,
      platform,
    ),
    input: options.input,
    maxBuffer: 4 * 1024 * 1024,
    stdio: options.stdio,
    timeout: options.timeoutMs ?? commandTimeoutMs,
    windowsHide: true,
  };
}

function quotePostgresServerOption(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || /[\u0000\r\n]/u.test(value)
  ) {
    throw invalidChildEnvironmentInput();
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function buildPostgresServerOptions(
  port,
  filesystem = activeNativeChildFilesystem,
  platform = process.platform,
) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw invalidChildEnvironmentInput();
  }
  const childFilesystem = validatedNativeChildFilesystem(filesystem, platform);
  const options = [
    `-p ${port}`,
    "-h 127.0.0.1",
    "-c max_connections=25",
    "-c statement_timeout=30000",
    "-c lock_timeout=5000",
    "-c idle_in_transaction_session_timeout=30000",
  ];
  if (platform !== "win32") {
    options.push(
      "-c unix_socket_directories="
        + quotePostgresServerOption(childFilesystem.tempDirectory),
    );
  }
  return options.join(" ");
}

function childCommandLabel(label) {
  return typeof label === "string" && /^[a-z0-9_]+$/u.test(label)
    ? label
    : "command";
}

export function childCommandFailure(result, label = "command") {
  const safeLabel = childCommandLabel(label);
  if (result?.error) {
    return nativeHarnessFailure(`${safeLabel}_spawn_failed`);
  }
  if (result?.status === 0) return undefined;
  const safeStatus = Number.isSafeInteger(result?.status) && result.status >= 0
    ? String(result.status)
    : "none";
  return nativeHarnessFailure(`${safeLabel}_failed_status_${safeStatus}`);
}

export function runNativeChild(
  command,
  args,
  options = {},
  sourceEnvironment = process.env,
  explicitEnvironment = selectedPostgresChildEnvironment,
  filesystem = activeNativeChildFilesystem,
  platform = process.platform,
) {
  const result = spawnSync(
    command,
    args,
    buildNativeChildSpawnOptions(
      options,
      sourceEnvironment,
      explicitEnvironment,
      filesystem,
      platform,
    ),
  );
  if (result.error) {
    throw childCommandFailure(result, options.label);
  }
  if (!options.allowFailure && result.status !== 0) {
    throw childCommandFailure(result, options.label);
  }
  return result;
}

function run(command, args, options = {}) {
  return runNativeChild(command, args, options);
}

function connectionArgs(port, database, username = "postgres") {
  return [
    "--host=127.0.0.1",
    `--port=${port}`,
    `--username=${username}`,
    `--dbname=${database}`,
    "--no-psqlrc",
  ];
}

function psql(port, database, sql, options = {}) {
  return run(
    executable("psql"),
    [
      ...connectionArgs(port, database, options.username),
      "--set=ON_ERROR_STOP=1",
      "--quiet",
      ...(options.scalar ? ["--tuples-only", "--no-align"] : []),
    ],
    {
      allowFailure: options.allowFailure,
      input: sql,
      label: options.label ?? "psql",
    },
  );
}

function psqlAs(port, database, username, sql, options = {}) {
  return psql(port, database, sql, { ...options, username });
}

function scalar(port, database, sql, username = "postgres") {
  return psql(port, database, sql, {
    scalar: true,
    username,
    label: "psql_scalar",
  }).stdout.trim();
}

function labeledScalar(port, database, sql, label) {
  return psql(port, database, sql, {
    scalar: true,
    label,
  }).stdout.trim();
}

export function parseChildJsonOutput(output, label = "child_json") {
  const safeLabel = childCommandLabel(label);
  if (typeof output !== "string") {
    throw nativeHarnessFailure(`${safeLabel}_invalid_json`);
  }
  try {
    return JSON.parse(output);
  } catch {
    throw nativeHarnessFailure(`${safeLabel}_invalid_json`);
  }
}

function jsonScalar(port, database, sql, username = "postgres") {
  return parseChildJsonOutput(
    scalar(port, database, sql, username),
    "psql_json",
  );
}

function parsePostgresMajorVersion(output) {
  if (typeof output !== "string") {
    throw nativeHarnessFailure("postgres_version_output_invalid");
  }
  const versionMatch = output.match(/PostgreSQL\) (\d+)(?:\.|\s|$)/u);
  if (!versionMatch) {
    throw nativeHarnessFailure("postgres_version_output_invalid");
  }
  const major = Number(versionMatch[1]);
  if (!Number.isSafeInteger(major)) {
    throw nativeHarnessFailure("postgres_version_output_invalid");
  }
  return major;
}

function parseSystemIdentifier(output) {
  if (typeof output !== "string") {
    throw nativeHarnessFailure("pg_controldata_output_invalid");
  }
  const identifierMatch = output.match(
    /^Database system identifier:\s*(\d+)\s*$/mu,
  );
  if (!identifierMatch) {
    throw nativeHarnessFailure("pg_controldata_output_invalid");
  }
  return identifierMatch[1];
}

function assertExpectedServerIdentity(
  output,
  expectedMajor,
  expectedDataDirectory,
  expectedPort,
) {
  if (typeof output !== "string") {
    throw nativeHarnessFailure("postgres_server_identity_invalid");
  }
  const fields = output.trim().split("|");
  const matchesExpected = fields.length === 4
    && new RegExp(`^${expectedMajor}\\.`, "u").test(fields[0])
    && path.resolve(fields[1]) === path.resolve(expectedDataDirectory)
    && fields[2] === "127.0.0.1"
    && fields[3] === String(expectedPort);
  if (!matchesExpected) {
    throw nativeHarnessFailure("postgres_server_identity_invalid");
  }
}

function assertExpectedSystemIdentifier(output, expectedIdentifier) {
  if (
    typeof output !== "string"
    || !/^\d+$/u.test(output)
    || output !== expectedIdentifier
  ) {
    throw nativeHarnessFailure("postgres_system_identifier_invalid");
  }
}

function migrationLedgerThrough0063() {
  const migrations = readdirSync(migrationDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .filter((name) => Number.parseInt(name.slice(0, 4), 10) <= 63)
    .sort();
  assert.equal(migrations.length, 64, "expected migrations 0000 through 0063");
  migrations.forEach((name, expectedIndex) => {
    assert.equal(
      Number.parseInt(name.slice(0, 4), 10),
      expectedIndex,
      `migration ledger is not contiguous at ${name}`,
    );
  });

  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const entries = journal.entries ?? [];
  const entriesThrough0063 = entries
    .filter((entry) => entry.idx <= 63)
    .sort((left, right) => left.idx - right.idx);
  assert.equal(entriesThrough0063.length, 64);
  entriesThrough0063.forEach((entry, expectedIndex) => {
    assert.equal(entry.idx, expectedIndex);
    assert.equal(
      `${entry.tag}.sql`,
      migrations[expectedIndex],
      `journal tag does not name migration ${migrations[expectedIndex]}`,
    );
  });
  assert.equal(
    entries.filter((entry) => entry.idx === 62).length,
    1,
    "journal must contain exactly one 0062 predecessor",
  );
  assert.equal(
    entries.find((entry) => entry.idx === 62)?.tag,
    "0062_mail_outbox_retention_redaction",
  );
  assert.equal(
    entries.filter((entry) => entry.idx === 63).length,
    1,
    "journal must contain exactly one 0063 successor",
  );
  assert.equal(
    entries.find((entry) => entry.idx === 63)?.tag,
    "0063_mail_outbox_redaction_fence_release",
  );

  const candidates = migrations.filter((name) => name.startsWith("0063_"));
  assert.deepEqual(candidates, [
    "0063_mail_outbox_redaction_fence_release.sql",
  ]);
  return path.join(migrationDirectory, candidates[0]);
}

function createFrameworkMigrationSlice(temporaryRoot, maximumIndex) {
  assert.ok(
    [62, 63, 64].includes(maximumIndex),
    "0063 harness migration slice must end at 0062, 0063, or 0064",
  );
  const target = path.join(
    temporaryRoot,
    `migrations-through-${String(maximumIndex).padStart(4, "0")}`,
  );
  const targetMeta = path.join(target, "meta");
  mkdirSync(targetMeta, { recursive: true });
  const migrations = readdirSync(migrationDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .filter(
      (name) =>
        Number.parseInt(name.slice(0, 4), 10) <= maximumIndex,
    )
    .sort();
  assert.equal(
    migrations.length,
    maximumIndex + 1,
    `expected migrations 0000 through ${String(maximumIndex).padStart(4, "0")}`,
  );
  for (const migration of migrations) {
    copyFileSync(
      path.join(migrationDirectory, migration),
      path.join(target, migration),
    );
  }
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = (journal.entries ?? [])
    .filter((entry) => entry.idx <= maximumIndex);
  writeFileSync(
    path.join(targetMeta, "_journal.json"),
    `${JSON.stringify(journal, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  return target;
}

function installHostilePre0063CatalogState(port, database) {
  psql(port, database, `
    create role mail_retention_hostile_default nologin;
    create role mail_retention_hostile_grantor nologin;
    create role mail_retention_hostile_leaf nologin;

    set role learncoding_owner;
    grant usage on schema public
      to mail_retention_hostile_default,
         mail_retention_hostile_grantor;
    alter default privileges for role learncoding_owner in schema public
      grant execute on functions
      to mail_retention_hostile_default with grant option;

    create or replace function
      public.classify_email_outbox_retention_redaction(
        candidate public.email_outbox,
        cutoff_at timestamp with time zone
      )
    returns text
    language sql
    volatile
    security invoker
    set search_path = public
    as $hostile_classifier$
      select 'hostile';
    $hostile_classifier$;
    reset role;
  `, { label: "install_hostile_pre_0063_default_acl" });

  psql(port, database, `
    set role mail_retention_hostile_default;
    grant execute on function
      public.classify_email_outbox_retention_redaction(
        public.email_outbox,
        timestamp with time zone
      )
      to mail_retention_hostile_leaf;
    reset role;
  `, { label: "install_hostile_pre_0063_default_delegation" });

  psql(port, database, `
    set role learncoding_owner;
    alter default privileges for role learncoding_owner in schema public
      revoke execute on functions from mail_retention_hostile_default;

    create or replace function
      public.enforce_email_outbox_payload_immutable()
    returns trigger
    language plpgsql
    security definer
    set search_path = public
    as $hostile_trigger$
    begin
      return new;
    end
    $hostile_trigger$;
    reset role;
  `, { label: "install_hostile_pre_0063_function_drift" });

  psql(port, database, `
    set role learncoding_owner;
    grant execute on function
      public.classify_email_outbox_retention_redaction(
        public.email_outbox,
        timestamp with time zone
      ),
      public.enforce_email_outbox_payload_immutable(),
      public.redact_unresolved_email_outbox_authority(
        timestamp with time zone,
        integer
      )
      to mail_retention_hostile_grantor with grant option;
    reset role;
  `, { label: "install_hostile_pre_0063_owner_grants" });

  psql(port, database, `
    set role mail_retention_hostile_grantor;
    grant execute on function
      public.classify_email_outbox_retention_redaction(
        public.email_outbox,
        timestamp with time zone
      ),
      public.enforce_email_outbox_payload_immutable(),
      public.redact_unresolved_email_outbox_authority(
        timestamp with time zone,
        integer
      )
      to mail_retention_hostile_leaf;
    reset role;

    set role learncoding_owner;
    revoke usage on schema public
      from mail_retention_hostile_default,
           mail_retention_hostile_grantor,
           mail_retention_hostile_leaf;
    reset role;
  `, { label: "install_hostile_pre_0063_delegation" });

  psql(port, database, `
    set role learncoding_owner;
    drop trigger email_outbox_payload_immutable on public.email_outbox;
    create trigger email_outbox_payload_immutable
      before update of to_email
      on public.email_outbox
      for each row
      execute function public.enforce_email_outbox_payload_immutable();
    alter table public.email_outbox
      disable trigger email_outbox_payload_immutable;
    reset role;
  `, { label: "install_hostile_pre_0063_trigger" });
}

function assertHostilePre0063CatalogState(port, database) {
  assert.equal(
    labeledScalar(
      port,
      database,
      `select pg_catalog.count(*)::text
         from pg_catalog.pg_proc as routine
         cross join lateral pg_catalog.aclexplode(
           coalesce(
             routine.proacl,
             pg_catalog.acldefault('f', routine.proowner)
           )
         ) as access
         join pg_catalog.pg_roles as grantee
           on grantee.oid = access.grantee
        where routine.oid in (
          'public.classify_email_outbox_retention_redaction(public.email_outbox,timestamp with time zone)'::pg_catalog.regprocedure,
          'public.enforce_email_outbox_payload_immutable()'::pg_catalog.regprocedure,
          'public.redact_unresolved_email_outbox_authority(timestamp with time zone,integer)'::pg_catalog.regprocedure
        )
          and grantee.rolname in (
            'mail_retention_hostile_default',
            'mail_retention_hostile_grantor',
            'mail_retention_hostile_leaf'
          );`,
      "hostile_pre_0063_acl_count",
    ),
    "8",
    "hostile direct/default/delegated function ACL fixture was incomplete",
  );
  assert.equal(
    labeledScalar(
      port,
      database,
      `select pg_catalog.count(*)::text
         from pg_catalog.pg_proc as routine
         cross join lateral pg_catalog.aclexplode(
           coalesce(
             routine.proacl,
             pg_catalog.acldefault('f', routine.proowner)
           )
         ) as access
         join pg_catalog.pg_roles as grantor
           on grantor.oid = access.grantor
         join pg_catalog.pg_roles as grantee
           on grantee.oid = access.grantee
        where routine.oid in (
          'public.classify_email_outbox_retention_redaction(public.email_outbox,timestamp with time zone)'::pg_catalog.regprocedure,
          'public.enforce_email_outbox_payload_immutable()'::pg_catalog.regprocedure,
          'public.redact_unresolved_email_outbox_authority(timestamp with time zone,integer)'::pg_catalog.regprocedure
        )
          and grantor.rolname in (
            'mail_retention_hostile_default',
            'mail_retention_hostile_grantor'
          )
          and grantee.rolname = 'mail_retention_hostile_leaf'
          and not access.is_grantable;`,
      "hostile_pre_0063_delegation_count",
    ),
    "4",
    "hostile non-owner grantor chain fixture was incomplete",
  );
  assert.equal(
    labeledScalar(
      port,
      database,
      `select trigger.tgenabled::text || ':' ||
              (
                select pg_catalog.count(*)::text
                  from pg_catalog.unnest(
                    trigger.tgattr::smallint[]
                  ) as watched(attnum)
              )
         from pg_catalog.pg_trigger as trigger
        where trigger.tgrelid =
                'public.email_outbox'::pg_catalog.regclass
          and trigger.tgname = 'email_outbox_payload_immutable'
          and not trigger.tgisinternal;`,
      "hostile_pre_0063_trigger_shape",
    ),
    "D:1",
    "hostile payload trigger fixture was incomplete",
  );
}

function assertHostileFunctionAclsRemoved(port, database) {
  assert.equal(
    labeledScalar(
      port,
      database,
      `select pg_catalog.count(*)::text
         from pg_catalog.pg_proc as routine
         cross join lateral pg_catalog.aclexplode(
           coalesce(
             routine.proacl,
             pg_catalog.acldefault('f', routine.proowner)
           )
         ) as access
         left join pg_catalog.pg_roles as grantor
           on grantor.oid = access.grantor
         left join pg_catalog.pg_roles as grantee
           on grantee.oid = access.grantee
        where routine.oid in (
          'public.classify_email_outbox_retention_redaction(public.email_outbox,timestamp with time zone)'::pg_catalog.regprocedure,
          'public.enforce_email_outbox_payload_immutable()'::pg_catalog.regprocedure,
          'public.redact_unresolved_email_outbox_authority(timestamp with time zone,integer)'::pg_catalog.regprocedure
        )
          and (
            grantor.rolname like 'mail_retention_hostile_%'
            or grantee.rolname like 'mail_retention_hostile_%'
          );`,
      "hostile_post_0063_acl_count",
    ),
    "0",
    "0063 left a hostile direct or delegated function ACL",
  );
}

function removeHostileCatalogRoles(port, database) {
  psql(port, database, `
    drop role mail_retention_hostile_leaf;
    drop role mail_retention_hostile_grantor;
    drop role mail_retention_hostile_default;
  `, { label: "remove_hostile_post_0063_roles" });
  assert.equal(
    labeledScalar(
      port,
      database,
      `select pg_catalog.count(*)::text
         from pg_catalog.pg_roles
        where rolname like 'mail_retention_hostile_%';`,
      "hostile_post_0063_role_count",
    ),
    "0",
    "hostile ACL fixture roles remained after exact convergence",
  );
}

async function unusedLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  assert.notEqual(address.port, 5432, "temporary PostgreSQL must not use 5432");
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitForScalar(port, database, sql, expected, message) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (scalar(port, database, sql) === expected) return;
    await delay(25);
  }
  throw new Error(message);
}

async function runLiveRoleBootstrap(port, database) {
  const [{ Pool }, { runDatabaseRoleBootstrap }] = await Promise.all([
    import("pg"),
    import("../../scripts/bootstrap-database-roles.mjs"),
  ]);
  const pool = new Pool({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database,
    max: 1,
    connectionTimeoutMillis: 5_000,
  });
  const clusterAdministrationPool = new Pool({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database: "postgres",
    max: 1,
    connectionTimeoutMillis: 5_000,
  });
  const roleUrl = (role, password) =>
    `postgresql://${role}:${password}@postgres:5432/${database}`;

  return runDatabaseRoleBootstrap({
    postgresUser: "postgres",
    postgresDatabase: database,
    databaseBootstrapUrl: roleUrl("postgres", "b".repeat(48)),
    databaseAppUrl: roleUrl("learncoding_app", "a".repeat(48)),
    databaseMigratorUrl: roleUrl("learncoding_migrator", "m".repeat(48)),
    databaseWorkerUrl: roleUrl("learncoding_worker", "w".repeat(48)),
    databaseOpsUrl: roleUrl("learncoding_ops", "o".repeat(48)),
    databaseBackupReporterUrl: roleUrl(
      "learncoding_backup_reporter", "r".repeat(48)),
    lockTimeoutMs: 5_000,
    cleanupTimeoutMs: 5_000,
    pool,
    clusterAdministrationPool,
  });
}

async function runHistoricalPhase0064CatalogVerifier(port, database) {
  const [
    { Pool },
    { verifyReviewedMailAuthorityCatalogContracts },
    { REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES },
  ] = await Promise.all([
    import("pg"),
    import("../../scripts/verify-database-role-boundaries.mjs"),
    import("../../scripts/bootstrap-database-roles.mjs"),
  ]);
  const phase0064 = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.find(
    ({ index }) => index === 64,
  );
  if (phase0064 === undefined) {
    throw nativeHarnessFailure("reviewed_phase_0064_missing");
  }
  const pool = new Pool({
    host: "127.0.0.1",
    port,
    user: "learncoding_ops",
    database,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
  });
  const client = await pool.connect();
  try {
    return await verifyReviewedMailAuthorityCatalogContracts(
      client,
      phase0064,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

async function applyMigrationsWithFramework(port, database, migrationsFolder) {
  const [{ Client }, { drizzle }, { migrate }] = await Promise.all([
    import("pg"),
    import("drizzle-orm/node-postgres"),
    import("drizzle-orm/node-postgres/migrator"),
  ]);
  const client = new Client({
    host: "127.0.0.1",
    port,
    user: "learncoding_migrator",
    database,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    await client.query("set statement_timeout = '30s'");
    await client.query("set lock_timeout = '5s'");
    await client.query("set role learncoding_owner");
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end();
  }
}

function replayMigration0063(port, database, migrationPath) {
  run(
    executable("psql"),
    [
      ...connectionArgs(port, database, "learncoding_migrator"),
      "--set=ON_ERROR_STOP=1",
      "--quiet",
      "--single-transaction",
      "--command=SET ROLE learncoding_owner",
      `--file=${migrationPath}`,
    ],
    { label: "migration_0063_replay" },
  );
}

function catalogAssertionSql() {
  return `
    do $catalog_contract$
    declare
      routine_failure_count integer;
      trigger_failure_count integer;
    begin
      perform pg_catalog.set_config(
        'search_path',
        'pg_catalog,pg_temp',
        true
      );
      with expected(signature, expected_owner, expected_definer,
                    expected_config, expected_body_sha256,
                    expected_definition_sha256, expected_acl) as (
        values
          (
            'public.classify_email_outbox_retention_redaction(public.email_outbox,timestamp with time zone)',
            'learncoding_owner',
            true,
            array['search_path=pg_catalog']::text[],
            '7c2d6df1168a89d63ed026c63bc390201a2a6b618e75967eddbe27c3d5bf672c',
            '43ea2a3bed7514efdb28ee52dfb128af57f39f525bb8842ce49c0eb4fa245466',
            array[
              'learncoding_owner>learncoding_owner:EXECUTE:false'
            ]::text[]
          ),
          (
            'public.enforce_email_outbox_payload_immutable()',
            'learncoding_owner',
            false,
            array['search_path=pg_catalog']::text[],
            '8f78735c7181306c3bfe4f459eaf3f16b69ddbc3f9ea6ee27bb55cfd3dc7eef3',
            'fe8117eea4298f330247789fb23f0ebe98b09c5184b7e00e29e4409843c83541',
            array[
              'learncoding_owner>learncoding_owner:EXECUTE:false'
            ]::text[]
          ),
          (
            'public.redact_unresolved_email_outbox_authority(timestamp with time zone,integer)',
            'learncoding_owner',
            true,
            array['search_path=pg_catalog']::text[],
            'b0ea5923720615a4b1de4df477a7905410cc7cabda7f613ccc88415501cb2469',
            '81ca308334c8297402ea1788c7fe3728277ddce891572fed6469ceae58e134bb',
            array[
              'learncoding_owner>learncoding_ops:EXECUTE:false',
              'learncoding_owner>learncoding_owner:EXECUTE:false'
            ]::text[]
          )
      ), observed as (
        select expected.*,
               routine.oid,
               pg_catalog.pg_get_userbyid(routine.proowner) as observed_owner,
               routine.prosecdef as observed_definer,
               COALESCE(
                 routine.proconfig,
                 array[]::text[]
               ) as observed_config,
               pg_catalog.encode(
                 pg_catalog.sha256(
                   pg_catalog.convert_to(routine.prosrc, 'UTF8')
                 ),
                 'hex'
               ) as observed_body_sha256,
               pg_catalog.encode(
                 pg_catalog.sha256(
                   pg_catalog.convert_to(
                     pg_catalog.pg_get_functiondef(routine.oid),
                     'UTF8'
                   )
                 ),
                 'hex'
               ) as observed_definition_sha256,
               COALESCE(
                 (
                   select pg_catalog.array_agg(
                     pg_catalog.pg_get_userbyid(expanded.grantor) || '>' ||
                     (
                       case when expanded.grantee = 0
                         then 'PUBLIC'
                         else pg_catalog.pg_get_userbyid(expanded.grantee)
                       end
                     ) || ':' || expanded.privilege_type || ':' ||
                     expanded.is_grantable::text
                     order by
                       pg_catalog.pg_get_userbyid(expanded.grantor),
                       case when expanded.grantee = 0
                         then 'PUBLIC'
                         else pg_catalog.pg_get_userbyid(expanded.grantee)
                       end,
                       expanded.privilege_type,
                       expanded.is_grantable
                   )
                     from pg_catalog.aclexplode(
                       COALESCE(
                         routine.proacl,
                         pg_catalog.acldefault('f', routine.proowner)
                       )
                     ) as expanded
                 ),
                 array[]::text[]
               ) as observed_acl
          from expected
          left join pg_catalog.pg_proc as routine
            on routine.oid = pg_catalog.to_regprocedure(expected.signature)
      )
      select pg_catalog.count(*)::integer
        into routine_failure_count
        from observed
       where oid is null
          or observed_owner is distinct from expected_owner
          or observed_definer is distinct from expected_definer
          or observed_config is distinct from expected_config
          or observed_body_sha256 is distinct from expected_body_sha256
          or observed_definition_sha256 is distinct from
               expected_definition_sha256
          or observed_acl is distinct from expected_acl;

      select pg_catalog.count(*)::integer
        into trigger_failure_count
        from pg_catalog.pg_trigger as trigger
       where trigger.tgrelid = 'public.email_outbox'::pg_catalog.regclass
         and trigger.tgname = 'email_outbox_payload_immutable'
         and not trigger.tgisinternal
         and (
           trigger.tgenabled is distinct from 'O'
           or trigger.tgtype is distinct from 19::smallint
           or trigger.tgqual is not null
           or trigger.tgnargs is distinct from 0::smallint
           or trigger.tgfoid is distinct from
             'public.enforce_email_outbox_payload_immutable()'::pg_catalog.regprocedure
           or (
             select pg_catalog.array_agg(attribute.attname order by attribute.attname)
               from pg_catalog.unnest(trigger.tgattr::smallint[]) as number(attnum)
               join pg_catalog.pg_attribute as attribute
                 on attribute.attrelid = trigger.tgrelid
                and attribute.attnum = number.attnum
           ) is distinct from array[
             'delivery_scope_key',
             'idempotency_key',
             'operation_id',
             'template',
             'template_version',
             'to_email',
             'user_id',
             'variables'
           ]::name[]
         );

      if routine_failure_count <> 0
         or (
           select pg_catalog.count(*)
             from pg_catalog.pg_trigger
            where tgrelid = 'public.email_outbox'::pg_catalog.regclass
              and tgname = 'email_outbox_payload_immutable'
              and not tgisinternal
         ) <> 1
         or trigger_failure_count <> 0 then
        raise exception 'MAIL_RETENTION_0063_CATALOG_INVALID'
          using errcode = '23514';
      end if;
    end
    $catalog_contract$;
  `;
}

function assertCatalogContract(port, database) {
  psql(port, database, catalogAssertionSql(), {
    label: "catalog_contract",
  });
}

function catalogFingerprint(port, database) {
  return scalar(
    port,
    database,
    `select pg_catalog.jsonb_build_object(
       'routines',
       (
         select pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
             'name', routine.proname,
             'owner', pg_catalog.pg_get_userbyid(routine.proowner),
             'definer', routine.prosecdef,
             'config', routine.proconfig,
             'acl', routine.proacl,
             'definition', pg_catalog.md5(
               pg_catalog.pg_get_functiondef(routine.oid)
             )
           )
           order by routine.proname
         )
           from pg_catalog.pg_proc as routine
          where routine.oid in (
            'public.classify_email_outbox_retention_redaction(public.email_outbox,timestamp with time zone)'::pg_catalog.regprocedure,
            'public.enforce_email_outbox_payload_immutable()'::pg_catalog.regprocedure,
            'public.redact_unresolved_email_outbox_authority(timestamp with time zone,integer)'::pg_catalog.regprocedure
          )
       ),
       'trigger',
       (
         select pg_catalog.jsonb_build_object(
           'enabled', trigger.tgenabled,
           'definition', pg_catalog.pg_get_triggerdef(trigger.oid, true)
         )
           from pg_catalog.pg_trigger as trigger
          where trigger.tgrelid = 'public.email_outbox'::pg_catalog.regclass
            and trigger.tgname = 'email_outbox_payload_immutable'
            and not trigger.tgisinternal
       )
     )::text;`,
  );
}

function expectCatalogTamperRejected(port, database, tamperSql, label) {
  const result = psql(
    port,
    database,
    `begin;
     ${tamperSql}
     ${catalogAssertionSql()}
     commit;`,
    {
      allowFailure: true,
      label: `catalog_tamper_${label}`,
    },
  );
  assert.notEqual(result.status, 0, `${label} tamper escaped verification`);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /MAIL_RETENTION_0063_CATALOG_INVALID/u,
    `${label} tamper failed for an unexpected reason`,
  );
  assertCatalogContract(port, database);
}

function insertFixtures(port, database) {
  psql(port, database, `
    set role learncoding_owner;
    insert into public."user" (id, name, email)
    values (
      'retention-0063-user',
      'Retention 0063 User',
      'retention-0063-user@example.invalid'
    );

    insert into public.email_outbox (
      id, user_id, to_email, template, template_version, variables,
      idempotency_key, operation_id, delivery_scope_key, status,
      attempt_count, claim_token, claim_owner, claim_version,
      lease_expires_at, provider_call_started, adapter,
      provider_message_id, next_attempt_at, sent_at, quarantined_at,
      last_error_code, created_at, updated_at
    ) values
      (
        '63000000-0000-4000-8000-000000000001',
        'retention-0063-user',
        'account-secret@example.invalid',
        'weekly-summary',
        '1',
        '{"secret":"account-pii"}'::jsonb,
        'retention-0063-account',
        '63100000-0000-4000-8000-000000000001',
        'a:retention-0063-user',
        'quarantined',
        4, null, null, 9, null,
        '2025-01-02T00:00:00Z'::timestamptz,
        'gmail', null,
        '2025-01-03T00:00:00Z'::timestamptz,
        null,
        '2025-01-04T00:00:00Z'::timestamptz,
        'GMAIL_RESULT_UNKNOWN',
        '2025-01-01T00:00:00Z'::timestamptz,
        '2025-01-05T00:00:00Z'::timestamptz
      ),
      (
        '63000000-0000-4000-8000-000000000002',
        null,
        'admin-secret@example.invalid',
        'access-request-admin',
        '1',
        pg_catalog.jsonb_build_object(
          '_mailOperationId', '63100000-0000-4000-8000-000000000002',
          '_mailRecipient', 'admin-secret@example.invalid',
          '_mailProducer', 'access-request-admin',
          '_mailSourceId', '63300000-0000-4000-8000-000000000002',
          'name', 'Private Admin',
          'url', 'https://example.invalid/bearer/admin'
        ),
        'retention-0063-admin',
        '63100000-0000-4000-8000-000000000002',
        's:63100000-0000-4000-8000-000000000002',
        'quarantined',
        3, null, null, 7, null,
        '2025-01-02T00:00:00Z'::timestamptz,
        'gmail', null,
        '2025-01-03T00:00:00Z'::timestamptz,
        null,
        '2025-01-04T00:00:00Z'::timestamptz,
        'GMAIL_RESULT_UNKNOWN',
        '2025-01-01T00:00:00Z'::timestamptz,
        '2025-01-06T00:00:00Z'::timestamptz
      ),
      (
        '63000000-0000-4000-8000-000000000003',
        null,
        'invite-secret@example.invalid',
        'invitation',
        '1',
        pg_catalog.jsonb_build_object(
          '_mailOperationId', '63100000-0000-4000-8000-000000000003',
          '_mailRecipient', 'invite-secret@example.invalid',
          '_mailProducer', 'access-request-approved',
          '_mailSourceId', '63300000-0000-4000-8000-000000000003',
          'name', 'Private Invitee',
          'url', 'https://example.invalid/bearer/invitation'
        ),
        'retention-0063-invitation',
        '63100000-0000-4000-8000-000000000003',
        's:63100000-0000-4000-8000-000000000003',
        'quarantined',
        3, null, null, 8, null,
        '2025-01-02T00:00:00Z'::timestamptz,
        'gmail', null,
        '2025-01-03T00:00:00Z'::timestamptz,
        null,
        '2025-01-04T00:00:00Z'::timestamptz,
        'GMAIL_RESULT_UNKNOWN',
        '2025-01-01T00:00:00Z'::timestamptz,
        '2025-01-07T00:00:00Z'::timestamptz
      ),
      (
        '63000000-0000-4000-8000-000000000004',
        null,
        'rejected-secret@example.invalid',
        'access-rejected',
        '1',
        pg_catalog.jsonb_build_object(
          '_mailOperationId', '63100000-0000-4000-8000-000000000004',
          '_mailRecipient', 'rejected-secret@example.invalid',
          '_mailProducer', 'access-request-rejected',
          '_mailSourceId', '63300000-0000-4000-8000-000000000004',
          'name', 'Private Rejected User',
          'url', 'https://example.invalid/bearer/rejected'
        ),
        'retention-0063-rejected',
        '63100000-0000-4000-8000-000000000004',
        's:63100000-0000-4000-8000-000000000004',
        'quarantined',
        3, null, null, 6, null,
        '2025-01-02T00:00:00Z'::timestamptz,
        'gmail', null,
        '2025-01-03T00:00:00Z'::timestamptz,
        null,
        '2025-01-04T00:00:00Z'::timestamptz,
        'GMAIL_RESULT_UNKNOWN',
        '2025-01-01T00:00:00Z'::timestamptz,
        '2025-01-08T00:00:00Z'::timestamptz
      ),
      (
        '63000000-0000-4000-8000-000000000005',
        'retention-0063-user',
        'held-secret@example.invalid',
        'weekly-summary',
        '1',
        '{"secret":"held-pii"}'::jsonb,
        'retention-0063-held',
        '63100000-0000-4000-8000-000000000005',
        'a:retention-0063-user',
        'quarantined',
        5,
        '63200000-0000-4000-8000-000000000005',
        'retention-held-worker',
        10,
        '2025-01-03T00:00:00Z'::timestamptz,
        '2025-01-02T00:00:00Z'::timestamptz,
        'gmail', null,
        '2025-01-03T00:00:00Z'::timestamptz,
        null,
        '2025-01-04T00:00:00Z'::timestamptz,
        'GMAIL_RESULT_UNKNOWN',
        '2025-01-01T00:00:00Z'::timestamptz,
        '2025-01-09T00:00:00Z'::timestamptz
      ),
      (
        '63000000-0000-4000-8000-000000000006',
        'retention-0063-user',
        'malformed-secret@example.invalid',
        'weekly-summary',
        '1',
        '{"secret":"malformed-pii"}'::jsonb,
        'retention-0063-malformed',
        '63100000-0000-4000-8000-000000000006',
        'a:retention-0063-user',
        'quarantined',
        5,
        '63200000-0000-4000-8000-000000000006',
        null,
        11,
        null,
        '2025-01-02T00:00:00Z'::timestamptz,
        'gmail', null,
        '2025-01-03T00:00:00Z'::timestamptz,
        null,
        '2025-01-04T00:00:00Z'::timestamptz,
        'GMAIL_RESULT_UNKNOWN',
        '2025-01-01T00:00:00Z'::timestamptz,
        '2025-01-10T00:00:00Z'::timestamptz
      ),
      (
        '63000000-0000-4000-8000-000000000007',
        'retention-0063-user',
        'active-held-secret@example.invalid',
        'weekly-summary',
        '1',
        '{"secret":"active-held-pii"}'::jsonb,
        'retention-0063-active-held',
        '63100000-0000-4000-8000-000000000007',
        'a:retention-0063-user',
        'quarantined',
        5,
        '63200000-0000-4000-8000-000000000007',
        'retention-active-worker',
        12,
        pg_catalog.statement_timestamp() + interval '1 hour',
        '2025-01-02T00:00:00Z'::timestamptz,
        'gmail', null,
        '2025-01-03T00:00:00Z'::timestamptz,
        null,
        '2025-01-04T00:00:00Z'::timestamptz,
        'GMAIL_RESULT_UNKNOWN',
        '2025-01-01T00:00:00Z'::timestamptz,
        '2025-01-11T00:00:00Z'::timestamptz
      ),
      (
        '63000000-0000-4000-8000-000000000008',
        'retention-0063-user',
        'recent-quarantine-secret@example.invalid',
        'weekly-summary',
        '1',
        '{"secret":"recent-quarantine-pii"}'::jsonb,
        'retention-0063-recent-quarantine',
        '63100000-0000-4000-8000-000000000008',
        'a:retention-0063-user',
        'quarantined',
        2, null, null, 4, null,
        '2025-01-02T00:00:00Z'::timestamptz,
        'gmail', null,
        '2025-01-03T00:00:00Z'::timestamptz,
        null,
        pg_catalog.statement_timestamp() - interval '5 days',
        'GMAIL_RESULT_UNKNOWN',
        '2025-01-01T00:00:00Z'::timestamptz,
        '2025-01-12T00:00:00Z'::timestamptz
      ),
      (
        '63000000-0000-4000-8000-000000000009',
        'retention-0063-user',
        'recent-update-secret@example.invalid',
        'weekly-summary',
        '1',
        '{"secret":"recent-update-pii"}'::jsonb,
        'retention-0063-recent-update',
        '63100000-0000-4000-8000-000000000009',
        'a:retention-0063-user',
        'quarantined',
        2, null, null, 5, null,
        '2025-01-02T00:00:00Z'::timestamptz,
        'gmail', null,
        '2025-01-03T00:00:00Z'::timestamptz,
        null,
        '2025-01-04T00:00:00Z'::timestamptz,
        'GMAIL_RESULT_UNKNOWN',
        '2025-01-01T00:00:00Z'::timestamptz,
        pg_catalog.statement_timestamp() - interval '5 days'
      );

    insert into public.email_outbox (
      id, user_id, to_email, template, template_version, variables,
      idempotency_key, operation_id, delivery_scope_key, status,
      attempt_count, claim_token, claim_owner, claim_version,
      lease_expires_at, provider_call_started, adapter,
      provider_message_id, next_attempt_at, sent_at, quarantined_at,
      last_error_code, created_at, updated_at
    )
    select fixture.id::uuid,
           'retention-0063-user',
           fixture.label || '-secret@example.invalid',
           'weekly-summary',
           '1',
           pg_catalog.jsonb_build_object('secret', fixture.label || '-pii'),
           'retention-0063-' || fixture.label,
           fixture.operation_id::uuid,
           'a:retention-0063-user',
           'quarantined',
           5,
           fixture.claim_token::uuid,
           fixture.claim_owner,
           20,
           fixture.lease_expires_at::timestamptz,
           '2025-01-02T00:00:00Z'::timestamptz,
           'gmail',
           null,
           '2025-01-03T00:00:00Z'::timestamptz,
           null,
           '2025-01-04T00:00:00Z'::timestamptz,
           'GMAIL_RESULT_UNKNOWN',
           '2025-01-01T00:00:00Z'::timestamptz,
           '2025-01-13T00:00:00Z'::timestamptz
      from (values
        (
          '63000000-0000-4000-8000-000000000011',
          '63100000-0000-4000-8000-000000000011',
          'mixed-owner-only',
          null,
          'retention-mixed-owner',
          null
        ),
        (
          '63000000-0000-4000-8000-000000000012',
          '63100000-0000-4000-8000-000000000012',
          'mixed-lease-only',
          null,
          null,
          '2025-01-03T00:00:00Z'
        ),
        (
          '63000000-0000-4000-8000-000000000013',
          '63100000-0000-4000-8000-000000000013',
          'mixed-token-owner',
          '63200000-0000-4000-8000-000000000013',
          'retention-mixed-token-owner',
          null
        ),
        (
          '63000000-0000-4000-8000-000000000014',
          '63100000-0000-4000-8000-000000000014',
          'mixed-token-lease',
          '63200000-0000-4000-8000-000000000014',
          null,
          '2025-01-03T00:00:00Z'
        ),
        (
          '63000000-0000-4000-8000-000000000015',
          '63100000-0000-4000-8000-000000000015',
          'mixed-owner-lease',
          null,
          'retention-mixed-owner-lease',
          '2025-01-03T00:00:00Z'
        )
      ) as fixture(
        id, operation_id, label, claim_token, claim_owner, lease_expires_at
      );
  `, { label: "fixture_insert" });
}

function fixtureDigest(port, database) {
  return scalar(
    port,
    database,
    `select pg_catalog.jsonb_agg(
       pg_catalog.to_jsonb(outbox)
       order by outbox.id
     )::text
       from public.email_outbox as outbox
      where outbox.id::text like '63000000-0000-4000-8000-%';`,
  );
}

function providerEvidenceDigest(port, database) {
  return scalar(
    port,
    database,
    `select pg_catalog.jsonb_agg(
       pg_catalog.to_jsonb(outbox)
         - array['to_email', 'variables', 'updated_at']::text[]
       order by outbox.id
     )::text
       from public.email_outbox as outbox
      where outbox.id in (
        '63000000-0000-4000-8000-000000000001',
        '63000000-0000-4000-8000-000000000002',
        '63000000-0000-4000-8000-000000000003',
        '63000000-0000-4000-8000-000000000004'
      );`,
  );
}

function protectedRowDigest(port, database) {
  return scalar(
    port,
    database,
    `select pg_catalog.jsonb_agg(
       pg_catalog.to_jsonb(outbox)
       order by outbox.id
     )::text
       from public.email_outbox as outbox
      where outbox.id in (
        '63000000-0000-4000-8000-000000000005',
        '63000000-0000-4000-8000-000000000006',
        '63000000-0000-4000-8000-000000000007',
        '63000000-0000-4000-8000-000000000008',
        '63000000-0000-4000-8000-000000000009',
        '63000000-0000-4000-8000-000000000011',
        '63000000-0000-4000-8000-000000000012',
        '63000000-0000-4000-8000-000000000013',
        '63000000-0000-4000-8000-000000000014',
        '63000000-0000-4000-8000-000000000015'
      );`,
  );
}

function assertFenceAndAgeFixtures(port, database) {
  assert.deepEqual(
    jsonScalar(
      port,
      database,
      `select pg_catalog.jsonb_object_agg(
         outbox.id::text,
         pg_catalog.jsonb_build_object(
           'leaseState', case
             when outbox.claim_token is null
              and outbox.claim_owner is null
              and outbox.lease_expires_at is null then 'released'
             when outbox.lease_expires_at > pg_catalog.statement_timestamp()
               then 'active'
             else 'expired'
           end,
           'classification',
             public.classify_email_outbox_retention_redaction(
               outbox,
               pg_catalog.statement_timestamp() - interval '30 days'
             )
         )
         order by outbox.id
       )::text
         from public.email_outbox as outbox
        where outbox.id in (
          '63000000-0000-4000-8000-000000000005',
          '63000000-0000-4000-8000-000000000007',
          '63000000-0000-4000-8000-000000000008',
          '63000000-0000-4000-8000-000000000009'
        );`,
    ),
    {
      "63000000-0000-4000-8000-000000000005": {
        classification: "blocked",
        leaseState: "expired",
      },
      "63000000-0000-4000-8000-000000000007": {
        classification: "blocked",
        leaseState: "active",
      },
      "63000000-0000-4000-8000-000000000008": {
        classification: null,
        leaseState: "released",
      },
      "63000000-0000-4000-8000-000000000009": {
        classification: null,
        leaseState: "released",
      },
    },
    "held leases or independent age anchors were classified unsafely",
  );
}
function redactionReport(port, database, batchLimit) {
  return jsonScalar(
    port,
    database,
    `set statement_timeout = '2s';
     select pg_catalog.jsonb_object_agg(
       result.disposition,
       pg_catalog.jsonb_build_object(
         'eligible', result.eligible,
         'transitioned', result.transitioned
       )
       order by result.disposition
     )::text
       from public.redact_unresolved_email_outbox_authority(
         pg_catalog.statement_timestamp() - interval '30 days',
         ${batchLimit}
       ) as result;`,
    "learncoding_ops",
  );
}

async function proveReportOnlyDoesNotLockRows(port, database) {
  const { Client } = await import("pg");
  const ops = new Client({
    host: "127.0.0.1",
    port,
    user: "learncoding_ops",
    database,
    connectionTimeoutMillis: 5_000,
  });
  await ops.connect();
  try {
    await ops.query("begin");
    const result = await ops.query(`
      select disposition,
             eligible::integer,
             transitioned::integer
        from public.redact_unresolved_email_outbox_authority(
          pg_catalog.statement_timestamp() - interval '30 days',
          0
        )
    `);
    const report = Object.fromEntries(result.rows.map((row) => [
      row.disposition,
      { eligible: row.eligible, transitioned: row.transitioned },
    ]));
    assert.deepEqual(report, {
      blocked: { eligible: 2, transitioned: 0 },
      eligible: { eligible: 4, transitioned: 0 },
      malformed: { eligible: 6, transitioned: 0 },
    });
    psql(
      port,
      database,
      `begin;
       select id
         from public.email_outbox
        where id::text like '63000000-0000-4000-8000-%'
        order by id
        for update nowait;
       rollback;`,
      { label: "report_only_all_rows_nowait" },
    );
  } finally {
    await ops.query("rollback").catch(() => undefined);
    await ops.end().catch(() => undefined);
  }
}

function assertDirectDenials(port, database) {
  for (const role of [
    "learncoding_app",
    "learncoding_worker",
    "learncoding_ops",
  ]) {
    const directMutation = psqlAs(
      port,
      database,
      role,
      `update public.email_outbox
          set to_email = 'forbidden@example.invalid'
        where id = '63000000-0000-4000-8000-000000000001';`,
      {
        allowFailure: true,
        label: `direct_mutation_${role}`,
      },
    );
    assert.notEqual(
      directMutation.status,
      0,
      `${role} unexpectedly bypassed the redaction authority`,
    );
    assert.match(
      `${directMutation.stdout}${directMutation.stderr}`,
      /permission denied|immutable/iu,
    );

    const classifier = psqlAs(
      port,
      database,
      role,
      `select public.classify_email_outbox_retention_redaction(
         null::public.email_outbox,
         pg_catalog.statement_timestamp() - interval '30 days'
       );`,
      {
        allowFailure: true,
        label: `classifier_${role}`,
      },
    );
    assert.notEqual(classifier.status, 0, `${role} invoked private classifier`);
    assert.match(
      `${classifier.stdout}${classifier.stderr}`,
      /permission denied/iu,
    );
  }

  for (const role of ["learncoding_app", "learncoding_worker"]) {
    const redactor = psqlAs(
      port,
      database,
      role,
      `select *
         from public.redact_unresolved_email_outbox_authority(
           pg_catalog.statement_timestamp() - interval '30 days',
           0
         );`,
      {
        allowFailure: true,
        label: `redactor_${role}`,
      },
    );
    assert.notEqual(redactor.status, 0, `${role} invoked ops redactor`);
    assert.match(`${redactor.stdout}${redactor.stderr}`, /permission denied/iu);
  }
}

function assertSystemRedaction(port, database) {
  const rows = jsonScalar(
    port,
    database,
    `select pg_catalog.jsonb_agg(
       pg_catalog.jsonb_build_object(
         'id', outbox.id,
         'operationId', outbox.operation_id,
         'template', outbox.template,
         'to', outbox.to_email,
         'variables', outbox.variables
       )
       order by outbox.id
     )::text
       from public.email_outbox as outbox
      where outbox.id in (
        '63000000-0000-4000-8000-000000000002',
        '63000000-0000-4000-8000-000000000003',
        '63000000-0000-4000-8000-000000000004'
      );`,
  );
  assert.equal(rows.length, 3);
  for (const row of rows) {
    const expectedRecipient = `redacted+${row.id}@invalid.local`;
    assert.equal(row.to, expectedRecipient);
    assert.deepEqual(
      Object.keys(row.variables).sort(),
      [
        "_mailOperationId",
        "_mailProducer",
        "_mailRecipient",
        "_mailSourceId",
      ],
    );
    assert.equal(row.variables._mailOperationId, row.operationId);
    assert.equal(row.variables._mailRecipient, expectedRecipient);
    const expectedSourceId = {
      "63000000-0000-4000-8000-000000000002":
        "63300000-0000-4000-8000-000000000002",
      "63000000-0000-4000-8000-000000000003":
        "63300000-0000-4000-8000-000000000003",
      "63000000-0000-4000-8000-000000000004":
        "63300000-0000-4000-8000-000000000004",
    }[row.id];
    assert.equal(row.variables._mailSourceId, expectedSourceId);
    const expectedProducer = {
      "access-request-admin": "access-request-admin",
      invitation: "access-request-approved",
      "access-rejected": "access-request-rejected",
    }[row.template];
    assert.equal(row.variables._mailProducer, expectedProducer);
  }

  assert.equal(
    scalar(
      port,
      database,
      `select convalidated::text
         from pg_catalog.pg_constraint
        where conrelid = 'public.email_outbox'::pg_catalog.regclass
          and conname = 'email_outbox_delivery_scope_valid';`,
    ),
    "true",
    "0059 delivery-scope constraint is not validated",
  );
  assert.equal(
    scalar(
      port,
      database,
      `select attnotnull::text
         from pg_catalog.pg_attribute
        where attrelid = 'public.email_outbox'::pg_catalog.regclass
          and attname = 'delivery_scope_key'
          and not attisdropped;`,
    ),
    "true",
    "0059 delivery_scope_key must remain NOT NULL",
  );

  const nullScope = psql(
    port,
    database,
    `insert into public.email_outbox (
       id, user_id, to_email, template, template_version, variables,
       idempotency_key, operation_id, delivery_scope_key
     ) values (
       '63900000-0000-4000-8000-000000000001',
       'retention-0063-user',
       'invalid-null-scope@example.invalid',
       'weekly-summary',
       '1',
       '{}'::jsonb,
       'retention-0063-invalid-null-scope',
       '63910000-0000-4000-8000-000000000001',
       null
     );`,
    { allowFailure: true, label: "0059_null_scope_probe" },
  );
  assert.notEqual(nullScope.status, 0);
  assert.match(`${nullScope.stdout}${nullScope.stderr}`, /null value|not-null/iu);

  const wrongAccountScope = psql(
    port,
    database,
    `insert into public.email_outbox (
       id, user_id, to_email, template, template_version, variables,
       idempotency_key, operation_id, delivery_scope_key
     ) values (
       '63900000-0000-4000-8000-000000000002',
       'retention-0063-user',
       'invalid-account-scope@example.invalid',
       'weekly-summary',
       '1',
       '{}'::jsonb,
       'retention-0063-invalid-account-scope',
       '63910000-0000-4000-8000-000000000002',
       'a:another-user'
     );`,
    { allowFailure: true, label: "0059_wrong_account_scope_probe" },
  );
  assert.notEqual(wrongAccountScope.status, 0);
  assert.match(
    `${wrongAccountScope.stdout}${wrongAccountScope.stderr}`,
    /email_outbox_delivery_scope_valid|check constraint/iu,
  );

  const systemEnvelopeProbes = [
    { label: "missing", missingEnvelope: true },
    {
      label: "operation",
      envelopeOperationId: "63919999-0000-4000-8000-000000000001",
    },
    {
      label: "recipient",
      envelopeRecipient: "different-recipient@example.invalid",
    },
    { label: "producer", producer: "unreviewed-producer" },
    { label: "source", sourceId: "not-a-uuid" },
    { label: "template", template: "weekly-summary" },
    { label: "version", templateVersion: "2" },
    {
      label: "scope",
      deliveryScope: "s:63919999-0000-4000-8000-000000000002",
    },
  ];
  for (const [index, probe] of systemEnvelopeProbes.entries()) {
    const ordinal = String(index + 11).padStart(12, "0");
    const id = `63900000-0000-4000-8000-${ordinal}`;
    const operationId = `63910000-0000-4000-8000-${ordinal}`;
    const sourceId = probe.sourceId
      ?? `63920000-0000-4000-8000-${ordinal}`;
    const recipient = `invalid-${probe.label}@example.invalid`;
    const variables = probe.missingEnvelope
      ? "'{}'::jsonb"
      : `pg_catalog.jsonb_build_object(
           '_mailOperationId', '${probe.envelopeOperationId ?? operationId}',
           '_mailRecipient', '${probe.envelopeRecipient ?? recipient}',
           '_mailProducer', '${probe.producer ?? "access-request-approved"}',
           '_mailSourceId', '${sourceId}'
         )`;
    const result = psql(
      port,
      database,
      `insert into public.email_outbox (
         id, user_id, to_email, template, template_version, variables,
         idempotency_key, operation_id, delivery_scope_key
       ) values (
         '${id}',
         null,
         '${recipient}',
         '${probe.template ?? "invitation"}',
         '${probe.templateVersion ?? "1"}',
         ${variables},
         'retention-0063-invalid-system-${probe.label}',
         '${operationId}',
         '${probe.deliveryScope ?? `s:${operationId}`}'
       );`,
      {
        allowFailure: true,
        label: `0059_invalid_system_${probe.label}_probe`,
      },
    );
    assert.notEqual(
      result.status,
      0,
      `invalid system ${probe.label} envelope unexpectedly passed 0059`,
    );
    assert.match(
      `${result.stdout}${result.stderr}`,
      /email_outbox_delivery_scope_valid|check constraint/iu,
    );
  }
}

async function proveRedactionContract(port, database) {
  insertFixtures(port, database);
  assertDirectDenials(port, database);

  assertFenceAndAgeFixtures(port, database);
  const completeBeforeReport = fixtureDigest(port, database);
  const evidenceBefore = providerEvidenceDigest(port, database);
  const protectedBefore = protectedRowDigest(port, database);
  assert.deepEqual(redactionReport(port, database, 0), {
    blocked: { eligible: 2, transitioned: 0 },
    eligible: { eligible: 4, transitioned: 0 },
    malformed: { eligible: 6, transitioned: 0 },
  });
  assert.equal(
    fixtureDigest(port, database),
    completeBeforeReport,
    "batch_limit=0 report-only call mutated an outbox row",
  );
  await proveReportOnlyDoesNotLockRows(port, database);
  assert.equal(
    fixtureDigest(port, database),
    completeBeforeReport,
    "non-locking report-only call invoked the payload trigger or changed a row",
  );

  assert.deepEqual(redactionReport(port, database, 2), {
    blocked: { eligible: 2, transitioned: 0 },
    eligible: { eligible: 4, transitioned: 2 },
    malformed: { eligible: 6, transitioned: 0 },
  });
  assert.deepEqual(redactionReport(port, database, 5000), {
    blocked: { eligible: 2, transitioned: 0 },
    eligible: { eligible: 2, transitioned: 2 },
    malformed: { eligible: 6, transitioned: 0 },
  });
  assert.deepEqual(redactionReport(port, database, 0), {
    blocked: { eligible: 2, transitioned: 0 },
    eligible: { eligible: 0, transitioned: 0 },
    malformed: { eligible: 6, transitioned: 0 },
  });

  assert.equal(
    scalar(
      port,
      database,
      `select to_email || '|' || variables::text
         from public.email_outbox
        where id = '63000000-0000-4000-8000-000000000001';`,
    ),
    "redacted+63000000-0000-4000-8000-000000000001@invalid.local|{}",
  );
  assertSystemRedaction(port, database);
  assert.equal(
    providerEvidenceDigest(port, database),
    evidenceBefore,
    "redaction changed provider, fence, or reconciliation evidence",
  );
  assert.equal(
    protectedRowDigest(port, database),
    protectedBefore,
    "held, malformed, or recently quarantined/updated payload was redacted",
  );
}

function installRevalidationRaceFixture(port, database) {
  psql(port, database, `
    set role learncoding_owner;
    insert into public.email_outbox (
      id, user_id, to_email, template, template_version, variables,
      idempotency_key, operation_id, delivery_scope_key, status,
      attempt_count, claim_token, claim_owner, claim_version,
      lease_expires_at, provider_call_started, adapter,
      provider_message_id, next_attempt_at, sent_at, quarantined_at,
      last_error_code, created_at, updated_at
    ) values (
      '63000000-0000-4000-8000-000000000010',
      'retention-0063-user',
      'revalidation-race-secret@example.invalid',
      'weekly-summary',
      '1',
      '{"secret":"revalidation-race-pii"}'::jsonb,
      'retention-0063-revalidation-race',
      '63100000-0000-4000-8000-000000000010',
      'a:retention-0063-user',
      'quarantined',
      3, null, null, 30, null,
      '2025-01-02T00:00:00Z'::timestamptz,
      'gmail', null,
      '2025-01-03T00:00:00Z'::timestamptz,
      null,
      '2025-01-04T00:00:00Z'::timestamptz,
      'GMAIL_RESULT_UNKNOWN',
      '2025-01-01T00:00:00Z'::timestamptz,
      '2025-01-14T00:00:00Z'::timestamptz
    );

    create table public.mail_retention_0063_pause (
      singleton boolean primary key,
      claimed boolean not null
    );
    insert into public.mail_retention_0063_pause(singleton, claimed)
    values (true, false);

    alter function public.classify_email_outbox_retention_redaction(
      public.email_outbox,
      timestamp with time zone
    ) rename to classify_email_outbox_retention_redaction_base_0063_test;

    create function public.classify_email_outbox_retention_redaction(
      candidate public.email_outbox,
      cutoff_at timestamp with time zone
    )
    returns text
    language plpgsql
    security definer
    set search_path = pg_catalog
    as $pause$
    declare
      should_pause boolean;
    begin
      if candidate.id =
           '63000000-0000-4000-8000-000000000010'::uuid then
        update public.mail_retention_0063_pause
           set claimed = true
         where singleton
           and not claimed
        returning true into should_pause;
        if COALESCE(should_pause, false) then
          perform pg_catalog.pg_sleep(3);
        end if;
      end if;
      return public.classify_email_outbox_retention_redaction_base_0063_test(
        candidate,
        cutoff_at
      );
    end
    $pause$;
    alter function public.classify_email_outbox_retention_redaction(
      public.email_outbox,
      timestamp with time zone
    ) owner to learncoding_owner;
    revoke all on function
      public.classify_email_outbox_retention_redaction(
        public.email_outbox,
        timestamp with time zone
      )
      from public, learncoding_app, learncoding_worker,
           learncoding_migrator, learncoding_ops;
  `, { label: "revalidation_race_install" });
}

function restoreClassifierAfterRace(port, database, migration0063) {
  psql(port, database, `
    set role learncoding_owner;
    drop function public.classify_email_outbox_retention_redaction(
      public.email_outbox,
      timestamp with time zone
    );
    alter function
      public.classify_email_outbox_retention_redaction_base_0063_test(
        public.email_outbox,
        timestamp with time zone
      )
      rename to classify_email_outbox_retention_redaction;
    drop table public.mail_retention_0063_pause;
  `, { label: "revalidation_race_restore" });
  replayMigration0063(port, database, migration0063);
  assertCatalogContract(port, database);
}

async function proveClassificationFenceRevalidationRace(
  port,
  database,
  migration0063,
) {
  const { Client } = await import("pg");
  installRevalidationRaceFixture(port, database);
  const redactor = new Client({
    host: "127.0.0.1",
    port,
    user: "learncoding_ops",
    database,
    connectionTimeoutMillis: 5_000,
  });
  let redactionPromise;
  await redactor.connect();
  try {
    await redactor.query(
      "set application_name = 'mail_retention_0063_revalidation_race'",
    );
    await redactor.query("set statement_timeout = '10s'");
    redactionPromise = redactor.query(`
      select disposition,
             eligible::integer,
             transitioned::integer
        from public.redact_unresolved_email_outbox_authority(
          pg_catalog.statement_timestamp() - interval '30 days',
          5000
        )
    `);
    await waitForScalar(
      port,
      database,
      `select pg_catalog.count(*)::text
         from pg_catalog.pg_stat_activity
        where application_name =
                'mail_retention_0063_revalidation_race'
          and wait_event = 'PgSleep';`,
      "1",
      "revalidation_race_did_not_reach_classification_pause",
    );

    psql(port, database, `
      set role learncoding_owner;
      update public.email_outbox
         set claim_token =
               '63200000-0000-4000-8000-000000000010'::uuid,
             claim_owner = 'retention-race-worker',
             lease_expires_at =
               pg_catalog.statement_timestamp() + interval '1 hour'
       where id = '63000000-0000-4000-8000-000000000010';
    `, { label: "revalidation_race_fence_change" });

    const result = await redactionPromise;
    redactionPromise = undefined;
    const report = Object.fromEntries(result.rows.map((row) => [
      row.disposition,
      { eligible: row.eligible, transitioned: row.transitioned },
    ]));
    assert.deepEqual(report, {
      blocked: { eligible: 2, transitioned: 0 },
      eligible: { eligible: 1, transitioned: 0 },
      malformed: { eligible: 6, transitioned: 0 },
    });
    assert.equal(
      scalar(
        port,
        database,
        `select to_email || '|' || variables::text || '|' ||
                (claim_token is not null)::text || '|' ||
                claim_owner || '|' ||
                (lease_expires_at >
                   pg_catalog.statement_timestamp())::text
           from public.email_outbox
          where id = '63000000-0000-4000-8000-000000000010';`,
      ),
      "revalidation-race-secret@example.invalid|"
        + '{"secret": "revalidation-race-pii"}|true|'
        + "retention-race-worker|true",
      "a fence change after classification was not revalidated",
    );
  } finally {
    await redactionPromise?.catch(() => undefined);
    await redactor.end().catch(() => undefined);
    restoreClassifierAfterRace(port, database, migration0063);
  }
}

function proveReconciliationAfterRedaction(port, database) {
  psqlAs(
    port,
    database,
    "learncoding_worker",
    `update public.email_outbox
        set status = 'sent',
            provider_message_id = 'gmail-retention-0063-account',
            sent_at = pg_catalog.statement_timestamp(),
            quarantined_at = null,
            last_error_code = null,
            updated_at = pg_catalog.statement_timestamp()
      where id = '63000000-0000-4000-8000-000000000001'
        and status = 'quarantined'
        and provider_call_started is not null
        and provider_message_id is null;`,
    { label: "worker_reconciliation" },
  );
  assert.equal(
    scalar(
      port,
      database,
      `select status::text || '|' || provider_message_id || '|' ||
              to_email || '|' || variables::text
         from public.email_outbox
        where id = '63000000-0000-4000-8000-000000000001';`,
    ),
    "sent|gmail-retention-0063-account|"
      + "redacted+63000000-0000-4000-8000-000000000001@invalid.local|{}",
  );
}

async function assertHistoricalPhaseBoundaryRejects(port, database, label) {
  await assert.rejects(
    runHistoricalPhase0064CatalogVerifier(port, database),
    { name: "DatabaseRoleBoundaryError" },
    `${label} tamper escaped the historical phase-0064 catalog verifier`,
  );
}

async function proveHistoricalPhaseBoundaryTamperAndRestore(
  port,
  database,
  migration0063,
) {
  await runHistoricalPhase0064CatalogVerifier(port, database);
  psql(port, database, `
    alter function public.redact_unresolved_email_outbox_authority(
      timestamp with time zone,
      integer
    ) rename to redact_unresolved_email_outbox_authority_missing;
  `, {
    label: "production_boundary_missing_routine",
  });
  await assertHistoricalPhaseBoundaryRejects(port, database, "missing_routine");
  psql(port, database, `
    alter function public.redact_unresolved_email_outbox_authority_missing(
      timestamp with time zone,
      integer
    ) rename to redact_unresolved_email_outbox_authority;
  `, { label: "production_boundary_restore_missing_routine" });

  psql(port, database, `
    grant execute on function
      public.classify_email_outbox_retention_redaction(
        public.email_outbox,
        timestamp with time zone
      ) to learncoding_app;
  `, { label: "production_boundary_classifier_acl" });
  await assertHistoricalPhaseBoundaryRejects(port, database, "classifier_acl");
  replayMigration0063(port, database, migration0063);

  psql(port, database, `
    alter function public.redact_unresolved_email_outbox_authority(
      timestamp with time zone,
      integer
    ) security invoker;
  `, { label: "production_boundary_redactor_security" });
  await assertHistoricalPhaseBoundaryRejects(port, database, "redactor_security");
  replayMigration0063(port, database, migration0063);

  psql(port, database, `
    alter table public.email_outbox
      disable trigger email_outbox_payload_immutable;
  `, { label: "production_boundary_trigger_disabled" });
  await assertHistoricalPhaseBoundaryRejects(port, database, "trigger_disabled");
  psql(port, database, `
    alter table public.email_outbox
      enable trigger email_outbox_payload_immutable;
  `, { label: "production_boundary_restore_trigger" });
  replayMigration0063(port, database, migration0063);

  await runHistoricalPhase0064CatalogVerifier(port, database);
  assertCatalogContract(port, database);
}
function proveCatalogTamperDetection(port, database) {
  expectCatalogTamperRejected(
    port,
    database,
    `alter function public.redact_unresolved_email_outbox_authority(
       timestamp with time zone, integer
     ) rename to redact_unresolved_email_outbox_authority_missing;`,
    "missing_routine",
  );
  expectCatalogTamperRejected(
    port,
    database,
    `alter function public.redact_unresolved_email_outbox_authority(
       timestamp with time zone, integer
     ) security invoker;`,
    "security_mode",
  );
  expectCatalogTamperRejected(
    port,
    database,
    `alter function public.classify_email_outbox_retention_redaction(
       public.email_outbox, timestamp with time zone
     ) reset search_path;`,
    "search_path",
  );
  expectCatalogTamperRejected(
    port,
    database,
    `create or replace function
       public.classify_email_outbox_retention_redaction(
         candidate public.email_outbox,
         cutoff_at timestamp with time zone
       )
     returns text
     language plpgsql
     stable
     security definer
     set search_path = pg_catalog
     as $tampered_body$
     begin
       return 'tampered';
     end
     $tampered_body$;`,
    "routine_body",
  );
  expectCatalogTamperRejected(
    port,
    database,
    `grant execute on function
       public.classify_email_outbox_retention_redaction(
         public.email_outbox, timestamp with time zone
       ) to learncoding_app;`,
    "routine_acl",
  );
  expectCatalogTamperRejected(
    port,
    database,
    `alter function public.enforce_email_outbox_payload_immutable()
       owner to learncoding_migrator;`,
    "trigger_owner",
  );
  expectCatalogTamperRejected(
    port,
    database,
    `alter table public.email_outbox
       disable trigger email_outbox_payload_immutable;`,
    "trigger_disabled",
  );
}

function validateTemporaryRoot(temporaryRoot) {
  const resolvedRoot = path.resolve(temporaryRoot);
  const resolvedTemporaryDirectory = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert.ok(
    resolvedRoot.startsWith(resolvedTemporaryDirectory),
    "temporary PostgreSQL root escaped the operating-system temp directory",
  );
  assert.match(
    path.basename(resolvedRoot),
    /^codestead-mail-retention-0063-pg(?:17|18)-/u,
  );
}

const defaultHarnessControl = Object.freeze({
  cleanupReportPath: undefined,
  injectCleanupLeak: false,
});

function parseHarnessControlArguments(argumentsList) {
  if (!Array.isArray(argumentsList)) {
    throw nativeHarnessFailure("invalid_harness_arguments");
  }
  let cleanupReportPath;
  let injectCleanupLeak = false;
  for (const argument of argumentsList) {
    if (
      typeof argument === "string"
      && argument.startsWith("--cleanup-report=")
    ) {
      if (cleanupReportPath !== undefined) {
        throw nativeHarnessFailure("invalid_harness_arguments");
      }
      cleanupReportPath = argument.slice("--cleanup-report=".length);
      if (cleanupReportPath.length === 0) {
        throw nativeHarnessFailure("invalid_harness_arguments");
      }
    } else if (argument === "--inject-cleanup-leak") {
      if (injectCleanupLeak) {
        throw nativeHarnessFailure("invalid_harness_arguments");
      }
      injectCleanupLeak = true;
    } else {
      throw nativeHarnessFailure("invalid_harness_arguments");
    }
  }
  if (injectCleanupLeak && cleanupReportPath === undefined) {
    throw nativeHarnessFailure("invalid_harness_arguments");
  }
  return Object.freeze({ cleanupReportPath, injectCleanupLeak });
}

function filesystemEntryExists(entryPath) {
  try {
    lstatSync(entryPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw nativeHarnessFailure("invalid_cleanup_report_path");
  }
}

function validatedCleanupReportPath(reportPath, temporaryRoot) {
  if (reportPath === undefined) return undefined;
  if (typeof reportPath !== "string" || !path.isAbsolute(reportPath)) {
    throw nativeHarnessFailure("invalid_cleanup_report_path");
  }
  const resolvedReportPath = path.resolve(reportPath);
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  const childTempDirectory = path.resolve(os.tmpdir());
  const outerCanaryRoot = path.dirname(childTempDirectory);
  const hostTemporaryDirectory = path.dirname(outerCanaryRoot);
  const reportParent = path.dirname(resolvedReportPath);
  let reportParentStatus;
  try {
    reportParentStatus = lstatSync(reportParent);
  } catch {
    throw nativeHarnessFailure("invalid_cleanup_report_path");
  }
  if (
    reportPath !== resolvedReportPath
    || path.basename(childTempDirectory) !== "tmp"
    || !/^codestead-mail-retention-0063-pg18-canary-/u.test(
      path.basename(outerCanaryRoot),
    )
    || normalizedInvocationPath(path.dirname(reportParent))
      !== normalizedInvocationPath(hostTemporaryDirectory)
    || !/^codestead-mail-retention-0063-cleanup-reports-[a-zA-Z0-9_-]{6}$/u
      .test(path.basename(reportParent))
    || !new Set([
      "success.json",
      "injected-leak.json",
      "existing.json",
      "symlink.json",
    ]).has(path.basename(resolvedReportPath))
    || resolvedReportPath.startsWith(`${resolvedTemporaryRoot}${path.sep}`)
    || !reportParentStatus.isDirectory()
    || reportParentStatus.isSymbolicLink()
    || filesystemEntryExists(resolvedReportPath)
  ) {
    throw nativeHarnessFailure("invalid_cleanup_report_path");
  }
  return resolvedReportPath;
}

function temporaryRootRemovalState(temporaryRoot) {
  return Object.freeze({
    taskRootRemoved: !existsSync(temporaryRoot),
    profileDirectoryRemoved:
      !existsSync(path.join(temporaryRoot, "profile")),
    tempDirectoryRemoved:
      !existsSync(path.join(temporaryRoot, "tmp")),
  });
}

function removalStateVerified(state) {
  return state.taskRootRemoved
    && state.profileDirectoryRemoved
    && state.tempDirectoryRemoved;
}

function writeCleanupReport(reportPath, report) {
  if (reportPath === undefined) return;
  writeFileSync(
    reportPath,
    `${JSON.stringify(report)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}

async function main(control = defaultHarnessControl) {
  assert.ok(
    !(requestedPg18Bin && requestedPg17Bin),
    "set only one of POSTGRES_17_BIN or POSTGRES_18_BIN",
  );
  const temporaryRoot = mkdtempSync(
    path.join(
      os.tmpdir(),
      `codestead-mail-retention-0063-pg${expectedPostgresMajor}-`,
    ),
  );
  validateTemporaryRoot(temporaryRoot);
  const dataDirectory = path.join(temporaryRoot, "data");
  const logFile = path.join(temporaryRoot, "postgres.log");
  const database = "mail_retention_0063";
  let operationError;
  let startAttempted = false;
  let cleanupReportPath;

  try {
    cleanupReportPath = validatedCleanupReportPath(
      control.cleanupReportPath,
      temporaryRoot,
    );
    activeNativeChildFilesystem =
      createNativeChildFilesystem(temporaryRoot);
    const migration0063 = migrationLedgerThrough0063();
    const observedPostgresMajor = parsePostgresMajorVersion(
      run(executable("postgres"), ["--version"], {
        label: "postgres_version",
      }).stdout,
    );
    if (observedPostgresMajor !== expectedPostgresMajor) {
      throw nativeHarnessFailure("postgres_version_mismatch");
    }
    const frameworkMigrationDirectoryThrough0062 =
      createFrameworkMigrationSlice(temporaryRoot, 62);
    const frameworkMigrationDirectoryThrough0063 =
      createFrameworkMigrationSlice(temporaryRoot, 63);
    const frameworkMigrationDirectoryThrough0064 =
      createFrameworkMigrationSlice(temporaryRoot, 64);
    const port = await unusedLoopbackPort();

    run(
      executable("initdb"),
      [
        `--pgdata=${dataDirectory}`,
        "--username=postgres",
        "--auth=trust",
        "--encoding=UTF8",
        "--no-locale",
        "--no-sync",
      ],
      { label: "initdb", timeoutMs: 60_000 },
    );
    const expectedSystemIdentifier = parseSystemIdentifier(
      run(
        executable("pg_controldata"),
        [dataDirectory],
        { label: "pg_controldata" },
      ).stdout,
    );
    startAttempted = true;
    run(
      executable("pg_ctl"),
      [
        "-D",
        dataDirectory,
        "-l",
        logFile,
        "-o",
        buildPostgresServerOptions(port),
        "-w",
        "start",
      ],
      { label: "pg_start", stdio: "ignore", timeoutMs: 60_000 },
    );
    assertExpectedServerIdentity(
      scalar(
        port,
        "postgres",
        `select pg_catalog.current_setting('server_version') || '|' ||
                pg_catalog.current_setting('data_directory') || '|' ||
                pg_catalog.current_setting('listen_addresses') || '|' ||
                pg_catalog.inet_server_port()::text;`,
      ),
      expectedPostgresMajor,
      dataDirectory,
      port,
    );
    assertExpectedSystemIdentifier(
      scalar(
        port,
        "postgres",
        `select system_identifier::text
           from pg_catalog.pg_control_system();`,
      ),
      expectedSystemIdentifier,
    );
    run(
      executable("createdb"),
      [
        "--host=127.0.0.1",
        `--port=${port}`,
        "--username=postgres",
        database,
      ],
      { label: "createdb" },
    );

    await runLiveRoleBootstrap(port, database);
    await applyMigrationsWithFramework(
      port,
      database,
      frameworkMigrationDirectoryThrough0062,
    );
    assert.equal(
      scalar(
        port,
        database,
        `select pg_catalog.count(*)::text
           from drizzle.__drizzle_migrations;`,
      ),
      "63",
      "framework did not record migrations 0000 through 0062",
    );

    installHostilePre0063CatalogState(port, database);
    assertHostilePre0063CatalogState(port, database);

    await applyMigrationsWithFramework(
      port,
      database,
      frameworkMigrationDirectoryThrough0063,
    );
    assert.equal(
      scalar(
        port,
        database,
        `select pg_catalog.count(*)::text
           from drizzle.__drizzle_migrations;`,
      ),
      "64",
      "framework did not record migrations 0000 through 0063",
    );
    // The migration must establish authority before bootstrap can repair it.
    assertCatalogContract(port, database);
    assertHostileFunctionAclsRemoved(port, database);
    removeHostileCatalogRoles(port, database);
    await runLiveRoleBootstrap(port, database);
    assertCatalogContract(port, database);

    await proveRedactionContract(port, database);
    await proveClassificationFenceRevalidationRace(
      port,
      database,
      migration0063,
    );

    const rowsBeforeDirectReplay = fixtureDigest(port, database);
    const catalogBeforeDirectReplay = catalogFingerprint(port, database);
    replayMigration0063(port, database, migration0063);
    assertCatalogContract(port, database);
    assert.equal(
      fixtureDigest(port, database),
      rowsBeforeDirectReplay,
      "direct idempotent 0063 replay changed application rows",
    );
    assert.equal(
      catalogFingerprint(port, database),
      catalogBeforeDirectReplay,
      "direct idempotent 0063 replay changed catalog semantics",
    );

    await applyMigrationsWithFramework(
      port,
      database,
      frameworkMigrationDirectoryThrough0063,
    );
    assert.equal(
      scalar(
        port,
        database,
        `select pg_catalog.count(*)::text
           from drizzle.__drizzle_migrations;`,
      ),
      "64",
      "framework replay changed the migration count through 0063",
    );
    assert.equal(
      fixtureDigest(port, database),
      rowsBeforeDirectReplay,
      "framework replay changed application rows",
    );
    assert.equal(
      catalogFingerprint(port, database),
      catalogBeforeDirectReplay,
      "framework replay changed catalog semantics",
    );

    proveCatalogTamperDetection(port, database);
    proveReconciliationAfterRedaction(port, database);

    await applyMigrationsWithFramework(
      port,
      database,
      frameworkMigrationDirectoryThrough0064,
    );
    assert.equal(
      scalar(
        port,
        database,
        `select pg_catalog.count(*)::text
           from drizzle.__drizzle_migrations;`,
      ),
      "65",
      "framework did not record migrations 0000 through 0064",
    );
    await runHistoricalPhase0064CatalogVerifier(port, database);
    await proveHistoricalPhaseBoundaryTamperAndRestore(
      port,
      database,
      migration0063,
    );

    process.stdout.write("mail_retention_0063=ledger_contiguous:pass\n");
    process.stdout.write("mail_retention_0063=catalog_authority:pass\n");
    process.stdout.write("mail_retention_0063=hostile_acl_convergence:pass\n");
    process.stdout.write("mail_retention_0063=report_only_and_apply:pass\n");
    process.stdout.write("mail_retention_0063=system_envelopes:pass\n");
    process.stdout.write("mail_retention_0063=fence_classification:pass\n");
    process.stdout.write("mail_retention_0063=fence_revalidation_race:pass\n");
    process.stdout.write("mail_retention_0063=evidence_preserved:pass\n");
    process.stdout.write("mail_retention_0063=replay_and_tamper:pass\n");
    process.stdout.write(
      `mail_retention_0063=postgres:${expectedPostgresMajor}:pass\n`,
    );
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let cleanupFailed = false;
    let stopFailed = false;
    try {
      if (startAttempted) {
        let stopped = run(
          executable("pg_ctl"),
          ["-D", dataDirectory, "stop", "-m", "fast", "-w"],
          {
            allowFailure: true,
            label: "pg_stop_fast",
            stdio: "ignore",
            timeoutMs: 30_000,
          },
        );
        if (stopped.status !== 0) {
          stopped = run(
            executable("pg_ctl"),
            ["-D", dataDirectory, "stop", "-m", "immediate", "-w"],
            {
              allowFailure: true,
              label: "pg_stop_immediate",
              stdio: "ignore",
              timeoutMs: 30_000,
            },
          );
        }
        stopFailed = stopped.status !== 0;
        cleanupFailed = stopFailed;
      }
    } catch {
      stopFailed = true;
      cleanupFailed = true;
    } finally {
      activeNativeChildFilesystem = undefined;
    }

    if (!stopFailed) {
      try {
        validateTemporaryRoot(temporaryRoot);
        if (!control.injectCleanupLeak) {
          rmSync(temporaryRoot, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 100,
          });
        }
      } catch {
        cleanupFailed = true;
      }
    }

    const primaryRemovalState =
      temporaryRootRemovalState(temporaryRoot);
    const cleanupVerified =
      !stopFailed && removalStateVerified(primaryRemovalState);
    if (!cleanupVerified) cleanupFailed = true;
    const injectedLeakDetected =
      control.injectCleanupLeak && !cleanupVerified;

    if (!stopFailed && !cleanupVerified) {
      try {
        validateTemporaryRoot(temporaryRoot);
        rmSync(temporaryRoot, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } catch {
        cleanupFailed = true;
      }
    }
    const recoveryVerified = removalStateVerified(
      temporaryRootRemovalState(temporaryRoot),
    );
    if (!recoveryVerified) cleanupFailed = true;

    try {
      writeCleanupReport(cleanupReportPath, {
        schemaVersion: 1,
        cleanupVerified,
        ...primaryRemovalState,
        injectedLeakDetected,
        recoveryVerified,
      });
    } catch {
      cleanupFailed = true;
    }

    if (cleanupFailed) {
      if (operationError) {
        process.stderr.write(
          "mail_retention_0063=temporary_postgres_cleanup_failed\n",
        );
      } else {
        throw nativeHarnessFailure("temporary_postgres_cleanup_failed");
      }
    }
  }
}

function normalizedInvocationPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function runDirectHarness() {
  const control = parseHarnessControlArguments(process.argv.slice(2));
  await main(control);
}

const invokedDirectly = process.argv[1] !== undefined
  && normalizedInvocationPath(process.argv[1])
    === normalizedInvocationPath(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  runDirectHarness().catch((error) => {
    const safeCode = outwardFailureCode(error);
    process.stderr.write(`mail_retention_0063=${safeCode}\n`);
    process.exitCode = 1;
  });
}
