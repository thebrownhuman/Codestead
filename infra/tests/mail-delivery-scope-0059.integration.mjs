import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");
const migrationDirectory = path.join(repositoryRoot, "drizzle");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const defaultPostgresBin = process.platform === "win32"
  ? "C:\\Program Files\\PostgreSQL\\18\\bin"
  : "";
const postgresBin = process.env.POSTGRES_18_BIN ?? defaultPostgresBin;
const commandTimeoutMs = 30_000;
const maxOutputBytes = 4 * 1024 * 1024;

function executable(name) {
  return postgresBin
    ? path.join(postgresBin, `${name}${executableSuffix}`)
    : name;
}

function printableCommand(command, args) {
  return [command, ...args]
    .map((value) => (/[\s"]/u.test(value) ? JSON.stringify(value) : value))
    .join(" ");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    input: options.input,
    env: {
      ...process.env,
      PGCONNECT_TIMEOUT: "5",
    },
    maxBuffer: maxOutputBytes,
    stdio: options.stdio,
    timeout: options.timeoutMs ?? commandTimeoutMs,
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(
      `${printableCommand(command, args)} could not run: ${result.error.message}`,
    );
  }
  if (!options.allowFailure && result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(
      `${printableCommand(command, args)} failed with status ${result.status}`
      + (output ? `\n${output}` : ""),
    );
  }
  return result;
}

async function unusedLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const { port } = address;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function migrationsThrough(index) {
  const migrations = readdirSync(migrationDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .filter((name) => Number.parseInt(name.slice(0, 4), 10) <= index)
    .sort();
  assert.equal(
    migrations.length,
    index + 1,
    `expected migrations 0000 through ${String(index).padStart(4, "0")}`,
  );
  migrations.forEach((name, expectedIndex) => {
    assert.equal(
      Number.parseInt(name.slice(0, 4), 10),
      expectedIndex,
      `migration sequence is not contiguous at ${name}`,
    );
  });
  return migrations;
}

function migration0059() {
  const candidates = readdirSync(migrationDirectory)
    .filter((name) => /^0059_.+\.sql$/u.test(name))
    .sort();
  if (candidates.length !== 1) {
    throw new Error(
      `mail_scope_0059=missing_migration:red; expected exactly one drizzle/0059_*.sql, found ${candidates.length}`,
    );
  }
  return path.join(migrationDirectory, candidates[0]);
}

function connectionArgs(port, database) {
  return [
    "--host=127.0.0.1",
    `--port=${port}`,
    "--username=postgres",
    `--dbname=${database}`,
    "--no-psqlrc",
  ];
}

function psql(port, database, sql, options = {}) {
  return run(
    executable("psql"),
    [
      ...connectionArgs(port, database),
      "--set=ON_ERROR_STOP=1",
      "--quiet",
      ...(options.scalar ? ["--tuples-only", "--no-align"] : []),
    ],
    {
      input: sql,
      allowFailure: options.allowFailure,
    },
  );
}

function psqlFile(port, database, filename, options = {}) {
  return run(
    executable("psql"),
    [
      ...connectionArgs(port, database),
      "--set=ON_ERROR_STOP=1",
      "--quiet",
      "--single-transaction",
      `--file=${filename}`,
    ],
    { allowFailure: options.allowFailure },
  );
}

function scalar(port, database, sql) {
  return psql(port, database, sql, { scalar: true }).stdout.trim();
}

function fixtureDigest(port, database) {
  return scalar(
    port,
    database,
    `select md5(string_agg(to_jsonb(outbox)::text, '|' order by idempotency_key))
       from public.email_outbox outbox
      where idempotency_key like 'scope-0059-%';`,
  );
}

function catalogFingerprint(port, database) {
  return scalar(
    port,
    database,
    `select md5(concat_ws('|',
       coalesce((
         select a.attnotnull::text
           from pg_attribute a
          where a.attrelid = 'public.email_outbox'::regclass
            and a.attname = 'delivery_scope_key'
            and not a.attisdropped
       ), '<missing-column>'),
       coalesce((
         select pg_get_constraintdef(c.oid, true)
           from pg_constraint c
          where c.conrelid = 'public.email_outbox'::regclass
            and c.conname = 'email_outbox_delivery_scope_valid'
       ), '<missing-constraint>')
     ));`,
  );
}

function seedFixtures(port, database) {
  psql(
    port,
    database,
    `
      insert into public."user" (id, name, email)
      values ('scope-0059-user', 'Scope 0059 User', 'scope-0059-user@example.invalid');

      insert into public.email_outbox
        (user_id, to_email, template, template_version, variables,
         idempotency_key, operation_id, delivery_scope_key, status,
         claim_token, claim_owner, claim_version, lease_expires_at,
         provider_call_started)
      values
        ('scope-0059-user', 'scope-account@example.invalid',
         'inactivity-reminder', '1', '{"fixture":"active-account"}'::jsonb,
         'scope-0059-active-account',
         '59000000-0000-4000-8000-000000000001', null, 'sending',
         '59100000-0000-4000-8000-000000000001', 'scope-worker-account',
         11, clock_timestamp() + interval '30 days', null),
        (null, 'scope-invitation@example.invalid',
         'invitation', '1', '{"fixture":"active-invitation"}'::jsonb,
         'scope-0059-active-invitation',
         '59000000-0000-4000-8000-000000000002', null, 'sending',
         '59100000-0000-4000-8000-000000000002', 'scope-worker-invitation',
         12, clock_timestamp() + interval '30 days', null),
        (null, 'scope-rejected@example.invalid',
         'access-rejected', '1', '{"fixture":"active-access-rejected"}'::jsonb,
         'scope-0059-active-access-rejected',
         '59000000-0000-4000-8000-000000000003', null, 'sending',
         '59100000-0000-4000-8000-000000000003', 'scope-worker-rejected',
         13, clock_timestamp() + interval '30 days', null),
        (null, 'ACTIVE_ORPHAN_RECIPIENT_CANARY@example.invalid',
         'unregistered-template', '99',
         '{"fixture":"ACTIVE_ORPHAN_VARIABLE_CANARY"}'::jsonb,
         'scope-0059-active-orphan',
         '59000000-0000-4000-8000-000000000004', null, 'sending',
         '59100000-0000-4000-8000-000000000004', 'scope-worker-orphan',
         14, clock_timestamp() + interval '30 days', null);
    `,
  );
}

function assertRollback(port, database, beforeRows, beforeCatalog, failure) {
  assert.notEqual(
    failure.status,
    0,
    "0059 must fail while an active unregistered delivery scope remains",
  );
  const failureOutput = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  assert.doesNotMatch(failureOutput, /ACTIVE_ORPHAN_RECIPIENT_CANARY/u);
  assert.doesNotMatch(failureOutput, /ACTIVE_ORPHAN_VARIABLE_CANARY/u);
  assert.equal(
    fixtureDigest(port, database),
    beforeRows,
    "failed 0059 attempt partially changed fixture rows",
  );
  assert.equal(
    catalogFingerprint(port, database),
    beforeCatalog,
    "failed 0059 attempt partially changed the delivery-scope catalog",
  );
  assert.equal(
    scalar(
      port,
      database,
      `select count(*) from public.email_outbox
        where idempotency_key like 'scope-0059-%'
          and delivery_scope_key is null;`,
    ),
    "4",
    "failed 0059 attempt did not roll active account/system classification back",
  );
}

function expireOrphanLease(port, database) {
  psql(
    port,
    database,
    `update public.email_outbox
        set lease_expires_at = clock_timestamp() - interval '1 minute'
      where idempotency_key = 'scope-0059-active-orphan';`,
  );
}

function assertSuccessfulClassification(port, database) {
  psql(
    port,
    database,
    `
      do $proof$
      begin
        if not exists (
          select 1 from public.email_outbox
           where idempotency_key = 'scope-0059-active-account'
             and delivery_scope_key = 'a:scope-0059-user'
             and status = 'sending'
             and to_email = 'scope-account@example.invalid'
             and variables = '{"fixture":"active-account"}'::jsonb
             and claim_token = '59100000-0000-4000-8000-000000000001'::uuid
             and claim_owner = 'scope-worker-account'
             and claim_version = 11
             and lease_expires_at is not null
        ) then
          raise exception 'active account scope was not classified in place';
        end if;

        if 2 <> (
          select count(*) from public.email_outbox
           where idempotency_key in (
             'scope-0059-active-invitation',
             'scope-0059-active-access-rejected'
           )
             and delivery_scope_key = 's:' || operation_id::text
             and status = 'sending'
             and to_email <> 'unresolved-recipient@invalid.local'
             and variables <> '{}'::jsonb
             and claim_token is not null
             and claim_owner is not null
             and claim_version in (12, 13)
             and lease_expires_at is not null
        ) then
          raise exception 'active registered system scopes were not classified in place';
        end if;

        if not exists (
          select 1 from public.email_outbox
           where idempotency_key = 'scope-0059-active-orphan'
             and delivery_scope_key = 'o:' || operation_id::text
             and status = 'quarantined'
             and last_error_code = 'UNRESOLVED_DELIVERY_SCOPE'
             and quarantined_at is not null
             and to_email = 'unresolved-recipient@invalid.local'
             and variables = '{}'::jsonb
             and claim_token is null
             and claim_owner is null
             and claim_version = 15
             and lease_expires_at is null
        ) then
          raise exception 'expired orphan was not quarantined on retry';
        end if;

        if exists (
          select 1 from public.email_outbox where delivery_scope_key is null
        ) then
          raise exception '0059 left nullable delivery authority';
        end if;

        if not exists (
          select 1
            from pg_attribute
           where attrelid = 'public.email_outbox'::regclass
             and attname = 'delivery_scope_key'
             and attnotnull
             and not attisdropped
        ) then
          raise exception 'delivery_scope_key is not catalog NOT NULL';
        end if;

        if not exists (
          select 1
            from pg_constraint
           where conrelid = 'public.email_outbox'::regclass
             and conname = 'email_outbox_delivery_scope_valid'
             and convalidated
        ) then
          raise exception 'strict delivery-scope check is absent or unvalidated';
        end if;

        begin
          insert into public.email_outbox
            (to_email, template, template_version, variables,
             idempotency_key, operation_id, delivery_scope_key, status)
          values
            ('null-scope@example.invalid', 'invitation', '1', '{}'::jsonb,
             'scope-0059-null-rejected',
             '59000000-0000-4000-8000-000000000005', null, 'pending');
          raise exception 'NULL delivery scope unexpectedly succeeded';
        exception when not_null_violation then
          null;
        end;

        begin
          insert into public.email_outbox
            (to_email, template, template_version, variables,
             idempotency_key, operation_id, delivery_scope_key, status)
          values
            ('invalid-scope@example.invalid', 'unregistered-template', '99',
             '{}'::jsonb, 'scope-0059-invalid-rejected',
             '59000000-0000-4000-8000-000000000006',
             's:59000000-0000-4000-8000-000000000006', 'pending');
          raise exception 'invalid delivery scope unexpectedly satisfied the check';
        exception when check_violation then
          null;
        end;
      end
      $proof$;
    `,
  );

  const constraintDefinition = scalar(
    port,
    database,
    `select pg_get_constraintdef(oid, true)
       from pg_constraint
      where conrelid = 'public.email_outbox'::regclass
        and conname = 'email_outbox_delivery_scope_valid';`,
  );
  assert.doesNotMatch(
    constraintDefinition,
    /delivery_scope_key\s+IS\s+NULL\s+OR/iu,
    "0059 retained the nullable escape hatch in its delivery-scope check",
  );
}

async function main() {
  const strictMigration = migration0059();
  const predecessorMigrations = migrationsThrough(58);
  const version = run(executable("postgres"), ["--version"]).stdout.trim();
  assert.match(
    version,
    /PostgreSQL\) 18\./u,
    `POSTGRES_18_BIN must select PostgreSQL 18, observed: ${version}`,
  );

  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), "codestead-mail-0059-pg18-"),
  );
  const dataDirectory = path.join(temporaryRoot, "data");
  const logFile = path.join(temporaryRoot, "postgres.log");
  const database = "mail_scope_0059";
  const port = await unusedLoopbackPort();
  let operationError;
  let startAttempted = false;

  try {
    run(executable("initdb"), [
      `--pgdata=${dataDirectory}`,
      "--username=postgres",
      "--auth=trust",
      "--encoding=UTF8",
      "--no-locale",
    ]);
    startAttempted = true;
    run(executable("pg_ctl"), [
      "-D",
      dataDirectory,
      "-l",
      logFile,
      "-o",
      `-p ${port} -h 127.0.0.1 -c max_connections=20`,
      "-w",
      "start",
    ], {
      stdio: "ignore",
      timeoutMs: 60_000,
    });

    run(executable("createdb"), [
      "--host=127.0.0.1",
      `--port=${port}`,
      "--username=postgres",
      database,
    ]);

    const identity = scalar(
      port,
      database,
      `select current_setting('server_version') || '|' ||
              current_setting('data_directory') || '|' ||
              current_setting('listen_addresses') || '|' ||
              inet_server_port()::text;`,
    );
    const [serverVersion, observedDataDirectory, listenAddresses, observedPort] =
      identity.split("|");
    assert.match(serverVersion, /^18\./u);
    assert.equal(path.resolve(observedDataDirectory), path.resolve(dataDirectory));
    assert.equal(listenAddresses, "127.0.0.1");
    assert.equal(observedPort, String(port));

    for (const migration of predecessorMigrations) {
      psqlFile(port, database, path.join(migrationDirectory, migration));
    }
    assert.equal(
      scalar(
        port,
        database,
        `select
           (select exists(
             select 1 from information_schema.columns
              where table_schema='public' and table_name='email_outbox'
                and column_name='delivery_scope_key'
           ))::text || '|' ||
           (select is_nullable from information_schema.columns
             where table_schema='public' and table_name='email_outbox'
               and column_name='delivery_scope_key');`,
      ),
      "true|YES",
      "0058 predecessor must expose a nullable delivery_scope_key",
    );

    seedFixtures(port, database);
    const beforeRows = fixtureDigest(port, database);
    const beforeCatalog = catalogFingerprint(port, database);
    const blocked = psqlFile(port, database, strictMigration, {
      allowFailure: true,
    });
    assertRollback(port, database, beforeRows, beforeCatalog, blocked);
    process.stdout.write("mail_scope_0059=active_orphan_rollback:pass\n");

    expireOrphanLease(port, database);
    psqlFile(port, database, strictMigration);
    assertSuccessfulClassification(port, database);
    process.stdout.write("mail_scope_0059=expired_retry_and_strictness:pass\n");

    const successfulRows = fixtureDigest(port, database);
    const successfulCatalog = catalogFingerprint(port, database);
    psqlFile(port, database, strictMigration);
    assert.equal(
      fixtureDigest(port, database),
      successfulRows,
      "idempotent 0059 replay changed classified rows",
    );
    assert.equal(
      catalogFingerprint(port, database),
      successfulCatalog,
      "idempotent 0059 replay changed strict catalog semantics",
    );
    process.stdout.write("mail_scope_0059=idempotent_replay:pass\n");
    process.stdout.write(`mail_scope_0059=postgres:${serverVersion}:pass\n`);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let cleanupError;
    if (startAttempted) {
      let stopped = run(
        executable("pg_ctl"),
        ["-D", dataDirectory, "stop", "-m", "fast", "-w"],
        {
          allowFailure: true,
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
            stdio: "ignore",
            timeoutMs: 30_000,
          },
        );
      }
      if (stopped.status !== 0) {
        cleanupError = new Error(
          `temporary PostgreSQL shutdown failed\n${readFileSync(logFile, "utf8")}`,
        );
      }
    }
    if (!cleanupError) {
      try {
        rmSync(temporaryRoot, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError) {
      if (operationError) {
        process.stderr.write(
          `cleanup_error=${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`,
        );
      } else {
        throw cleanupError;
      }
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
