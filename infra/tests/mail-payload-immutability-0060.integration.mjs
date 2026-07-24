import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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

function executable(name) {
  return postgresBin
    ? path.join(postgresBin, `${name}${executableSuffix}`)
    : name;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    input: options.input,
    env: { ...process.env, PGCONNECT_TIMEOUT: "5" },
    maxBuffer: 4 * 1024 * 1024,
    stdio: options.stdio,
    timeout: options.timeoutMs ?? 30_000,
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(
      `${command} failed with status ${result.status}\n`
      + `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    );
  }
  return result;
}

function startPsql(port, database, username, sql) {
  const child = spawn(
    executable("psql"),
    [
      ...connectionArgs(port, database, username),
      "--set=ON_ERROR_STOP=1",
      "--quiet",
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, PGCONNECT_TIMEOUT: "5" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(sql);

  const completion = new Promise((resolve, reject) => {
    let timeoutHandle;
    child.once("error", reject);
    child.once("close", (status, signal) => {
      clearTimeout(timeoutHandle);
      resolve({ status, signal, stdout, stderr });
    });
    timeoutHandle = setTimeout(() => {
      child.kill();
      reject(new Error(`psql session timed out for ${username}`));
    }, 15_000);
  });
  return completion;
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitForScalar(
  port,
  database,
  sql,
  expected,
  message,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (scalar(port, database, sql) === expected) return;
    await delay(25);
  }
  throw new Error(message);
}

async function unusedLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
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
    { input: sql, allowFailure: options.allowFailure },
  );
}

function scalar(port, database, sql) {
  return psql(port, database, sql, { scalar: true }).stdout.trim();
}

function psqlAs(port, database, username, sql, options = {}) {
  return psql(port, database, sql, { ...options, username });
}

function scalarAs(port, database, username, sql) {
  return psqlAs(port, database, username, sql, { scalar: true }).stdout.trim();
}

function applyMigrations(port, database) {
  const migrations = readdirSync(migrationDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .filter((name) => Number.parseInt(name.slice(0, 4), 10) <= 62)
    .sort();
  assert.equal(migrations.length, 63);

  migrations.forEach((name, index) => {
    assert.equal(Number.parseInt(name.slice(0, 4), 10), index);
    run(executable("psql"), [
      ...connectionArgs(port, database, "learncoding_migrator"),
      "--set=ON_ERROR_STOP=1",
      "--quiet",
      "--single-transaction",
      "--command=SET ROLE learncoding_owner",
      `--file=${path.join(migrationDirectory, name)}`,
    ]);
  });
}

function redactionCatalogDigest(port, database) {
  return scalar(
    port,
    database,
    `select string_agg(
       p.oid::text || ':' ||
       pg_get_userbyid(p.proowner) || ':' ||
       p.prosecdef::text || ':' ||
       coalesce(array_to_string(p.proconfig, ','), '') || ':' ||
       coalesce(p.proacl::text, '') || ':' ||
       md5(p.prosrc),
       '|' order by p.oid
     )
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname in (
          'enforce_email_outbox_payload_immutable',
          'redact_unresolved_email_outbox_authority'
        );`,
  );
}

function replayRetentionMigration(port, database) {
  run(executable("psql"), [
    ...connectionArgs(port, database, "learncoding_migrator"),
    "--set=ON_ERROR_STOP=1",
    "--quiet",
    "--single-transaction",
    "--command=SET ROLE learncoding_owner",
    `--file=${path.join(
      migrationDirectory,
      "0062_mail_outbox_retention_redaction.sql",
    )}`,
  ]);
}

async function runLiveRoleBootstrap(port, database) {
  const [{ Pool }, { runDatabaseRoleBootstrap }] = await Promise.all([
    import("pg"),
    import("../../scripts/bootstrap-database-roles.mjs"),
  ]);
  const roleUrl = (role, password) =>
    `postgresql://${role}:${password}@postgres:5432/${database}`;
  const pool = new Pool({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database,
    max: 1,
  });

  return runDatabaseRoleBootstrap({
    postgresUser: "postgres",
    postgresDatabase: database,
    databaseBootstrapUrl: roleUrl("postgres", "b".repeat(48)),
    databaseAppUrl: roleUrl("learncoding_app", "a".repeat(48)),
    databaseMigratorUrl: roleUrl("learncoding_migrator", "m".repeat(48)),
    databaseWorkerUrl: roleUrl("learncoding_worker", "w".repeat(48)),
    databaseOpsUrl: roleUrl("learncoding_ops", "o".repeat(48)),
    lockTimeoutMs: 5_000,
    cleanupTimeoutMs: 5_000,
    pool,
  });
}

async function proveBootstrapReplay(port, database, catalogBeforeBootstrap) {
  await runLiveRoleBootstrap(port, database);
  assert.equal(
    redactionCatalogDigest(port, database),
    catalogBeforeBootstrap,
    "post-migration role bootstrap stripped or changed the reviewed routine ACL",
  );
  await runLiveRoleBootstrap(port, database);
  assert.equal(
    redactionCatalogDigest(port, database),
    catalogBeforeBootstrap,
    "idempotent bootstrap/restore replay changed the reviewed routine ACL",
  );
}

function grantRuntimePrivileges(port, database) {
  psql(port, database, `
    set role learncoding_owner;
    grant usage on schema public
      to learncoding_app, learncoding_worker, learncoding_ops;
    grant usage on type public.notification_status
      to learncoding_app, learncoding_worker, learncoding_ops;
    grant select, insert, update, delete on table public.email_outbox
      to learncoding_app, learncoding_ops;
  `);
}

function proveImmutability(port, database) {
  psql(
    port,
    database,
    `
      insert into public."user" (id, name, email)
      values ('payload-0060-user', 'Payload 0060 User',
              'payload-0060-user@example.invalid');

      insert into public.email_outbox
        (user_id, to_email, template, template_version, variables,
         idempotency_key, operation_id, delivery_scope_key, status)
      values
        ('payload-0060-user', 'payload-0060@example.invalid',
         'weekly-summary', '1',
         '{"fixture":"pg18","nested":{"a":1,"b":2}}'::jsonb,
         'payload-0060-key',
         '60000000-0000-4000-8000-000000000001',
         'a:payload-0060-user', 'pending');

      do $proof$
      declare
        mutation record;
      begin
        for mutation in
          select *
            from (values
              ('user_id', $$'payload-0060-other'$$),
              ('to_email', $$'mutated@example.invalid'$$),
              ('template', $$'mutated-template'$$),
              ('template_version', $$'2'$$),
              ('variables', $$'{"fixture":"mutated"}'::jsonb$$),
              ('idempotency_key', $$'payload-0060-mutated-key'$$),
              ('operation_id',
               $$'60000000-0000-4000-8000-000000000002'::uuid$$),
              ('delivery_scope_key', $$'a:payload-0060-other'$$)
            ) as mutations(column_name, replacement)
        loop
          begin
            execute format(
              'update public.email_outbox set %I = %s '
              || 'where idempotency_key = %L',
              mutation.column_name,
              mutation.replacement,
              'payload-0060-key'
            );
            raise exception '% unexpectedly changed', mutation.column_name;
          exception
            when check_violation then
              if sqlerrm not like 'email_outbox.% is immutable' then
                raise;
              end if;
          end;
        end loop;

        update public.email_outbox
           set user_id = user_id,
               to_email = to_email,
               template = template,
               template_version = template_version,
               variables = '{"nested":{"b":2,"a":1},"fixture":"pg18"}'::jsonb,
               idempotency_key = idempotency_key,
               operation_id = operation_id,
               delivery_scope_key = delivery_scope_key
         where idempotency_key = 'payload-0060-key';

        update public.email_outbox
           set status = 'sent',
               attempt_count = 1,
               claim_token = '60100000-0000-4000-8000-000000000001',
               claim_owner = 'payload-0060-worker',
               claim_version = 1,
               lease_expires_at = statement_timestamp() + interval '5 minutes',
               provider_call_started = statement_timestamp(),
               adapter = 'payload-0060-adapter',
               provider_message_id = 'payload-0060-message',
               next_attempt_at = statement_timestamp(),
               sent_at = statement_timestamp(),
               quarantined_at = statement_timestamp(),
               last_error_code = 'PAYLOAD_0060_EVIDENCE',
               updated_at = statement_timestamp()
         where idempotency_key = 'payload-0060-key';

        begin
          update public.email_outbox
             set status = 'failed',
                 to_email = 'mixed-mutation@example.invalid'
           where idempotency_key = 'payload-0060-key';
          raise exception 'mixed payload/state mutation unexpectedly succeeded';
        exception when check_violation then
          null;
        end;
      end
      $proof$;
    `,
  );

  assert.equal(
    scalar(
      port,
      database,
      `select status || '|' || attempt_count::text || '|' || claim_owner
         from public.email_outbox
        where idempotency_key = 'payload-0060-key';`,
    ),
    "sent|1|payload-0060-worker",
  );
  assert.equal(
    scalar(
      port,
      database,
      `select count(*)::text
         from pg_trigger
        where tgrelid = 'public.email_outbox'::regclass
          and not tgisinternal
          and tgname = 'email_outbox_payload_immutable';`,
    ),
    "1",
  );
  assert.equal(
    scalar(
      port,
      database,
      `select count(*)::text
         from pg_trigger
        where tgrelid = 'public.email_outbox'::regclass
          and not tgisinternal
          and tgname = 'email_outbox_delivery_scope_immutable';`,
    ),
    "0",
  );
}

function proveRetentionRedaction(port, database) {
  assert.equal(
    scalar(
      port,
      database,
      `select p.prosecdef::text || '|' ||
              pg_get_userbyid(p.proowner) || '|' ||
              coalesce(array_to_string(p.proconfig, ','), '') || '|' ||
              has_function_privilege(
                'learncoding_ops',
                'public.redact_unresolved_email_outbox_authority(timestamptz,integer)',
                'execute'
              )::text || '|' ||
              has_function_privilege(
                'learncoding_app',
                'public.redact_unresolved_email_outbox_authority(timestamptz,integer)',
                'execute'
              )::text || '|' ||
              has_function_privilege(
                'learncoding_worker',
                'public.redact_unresolved_email_outbox_authority(timestamptz,integer)',
                'execute'
              )::text || '|' ||
              has_function_privilege(
                'learncoding_migrator',
                'public.redact_unresolved_email_outbox_authority(timestamptz,integer)',
                'execute'
              )::text
         from pg_proc p
        where p.oid =
          'public.redact_unresolved_email_outbox_authority(timestamptz,integer)'::regprocedure;`,
    ),
    "true|learncoding_owner|search_path=pg_catalog|true|false|false|false",
  );

  psql(port, database, `
    set role learncoding_owner;
    insert into public."user" (id, name, email)
    values (
      'retention-0062-user',
      'Retention 0062 User',
      'retention-0062-user@example.invalid'
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
        '62000000-0000-4000-8000-000000000001',
        'retention-0062-user', 'eligible-secret@example.invalid',
        'weekly-summary', '1', '{"secret":"eligible"}'::jsonb,
        'retention-0062-eligible',
        '62200000-0000-4000-8000-000000000001',
        'a:retention-0062-user', 'quarantined', 2,
        '62100000-0000-4000-8000-000000000001',
        'gmail-worker-0062', 4,
        statement_timestamp() - interval '39 days',
        statement_timestamp() - interval '40 days', 'gmail', null,
        statement_timestamp() - interval '40 days', null,
        statement_timestamp() - interval '39 days', 'GMAIL_RESULT_UNKNOWN',
        statement_timestamp() - interval '45 days',
        statement_timestamp() - interval '40 days'
      ),
      (
        '62000000-0000-4000-8000-000000000002',
        'retention-0062-user', 'active-lease-secret@example.invalid',
        'weekly-summary', '1', '{"secret":"active-lease"}'::jsonb,
        'retention-0062-active-lease',
        '62200000-0000-4000-8000-000000000002',
        'a:retention-0062-user', 'quarantined', 2,
        '62100000-0000-4000-8000-000000000002',
        'gmail-worker-active', 5,
        statement_timestamp() + interval '1 hour',
        statement_timestamp() - interval '40 days', 'gmail', null,
        statement_timestamp() - interval '40 days', null,
        statement_timestamp() - interval '39 days', 'GMAIL_RESULT_UNKNOWN',
        statement_timestamp() - interval '45 days',
        statement_timestamp() - interval '40 days'
      ),
      (
        '62000000-0000-4000-8000-000000000003',
        'retention-0062-user', 'young-secret@example.invalid',
        'weekly-summary', '1', '{"secret":"young"}'::jsonb,
        'retention-0062-young',
        '62200000-0000-4000-8000-000000000003',
        'a:retention-0062-user', 'quarantined', 1, null, null, 2, null,
        statement_timestamp() - interval '5 days', 'gmail', null,
        statement_timestamp() - interval '5 days', null,
        statement_timestamp() - interval '5 days', 'GMAIL_RESULT_UNKNOWN',
        statement_timestamp() - interval '5 days',
        statement_timestamp() - interval '5 days'
      ),
      (
        '62000000-0000-4000-8000-000000000004',
        'retention-0062-user', 'wrong-state-secret@example.invalid',
        'weekly-summary', '1', '{"secret":"wrong-state"}'::jsonb,
        'retention-0062-wrong-state',
        '62200000-0000-4000-8000-000000000004',
        'a:retention-0062-user', 'failed', 1, null, null, 2, null,
        statement_timestamp() - interval '40 days', 'gmail', null,
        statement_timestamp() - interval '40 days', null, null,
        'PROVIDER_REJECTED',
        statement_timestamp() - interval '45 days',
        statement_timestamp() - interval '40 days'
      ),
      (
        '62000000-0000-4000-8000-000000000005',
        null, 'system-secret@example.invalid', 'access-rejected', '1',
        '{
          "_mailOperationId":"62200000-0000-4000-8000-000000000005",
          "_mailRecipient":"system-secret@example.invalid",
          "_mailProducer":"access-request-rejected",
          "_mailSourceId":"62300000-0000-4000-8000-000000000005"
        }'::jsonb,
        'retention-0062-system',
        '62200000-0000-4000-8000-000000000005',
        's:62200000-0000-4000-8000-000000000005',
        'quarantined', 1, null, null, 2, null,
        statement_timestamp() - interval '40 days', 'gmail', null,
        statement_timestamp() - interval '40 days', null,
        statement_timestamp() - interval '39 days', 'GMAIL_RESULT_UNKNOWN',
        statement_timestamp() - interval '45 days',
        statement_timestamp() - interval '40 days'
      ),
      (
        '62000000-0000-4000-8000-000000000006',
        'retention-0062-user', 'console-secret@example.invalid',
        'weekly-summary', '1', '{"secret":"non-gmail"}'::jsonb,
        'retention-0062-non-gmail',
        '62200000-0000-4000-8000-000000000006',
        'a:retention-0062-user', 'quarantined', 1, null, null, 2, null,
        statement_timestamp() - interval '40 days', 'console', null,
        statement_timestamp() - interval '40 days', null,
        statement_timestamp() - interval '39 days', 'PROVIDER_RESULT_UNKNOWN',
        statement_timestamp() - interval '45 days',
        statement_timestamp() - interval '40 days'
      ),
      (
        '62000000-0000-4000-8000-000000000008',
        null, 'orphan-secret@example.invalid',
        'weekly-summary', '1', '{"secret":"orphan"}'::jsonb,
        'retention-0062-orphan',
        '62200000-0000-4000-8000-000000000008',
        'o:62200000-0000-4000-8000-000000000008',
        'quarantined', 1,
        '62100000-0000-4000-8000-000000000008',
        'gmail-worker-orphan', 2,
        statement_timestamp() - interval '39 days',
        statement_timestamp() - interval '40 days', 'gmail', null,
        statement_timestamp() - interval '40 days', null,
        statement_timestamp() - interval '39 days', 'GMAIL_RESULT_UNKNOWN',
        statement_timestamp() - interval '45 days',
        statement_timestamp() - interval '40 days'
      ),
      (
        '62000000-0000-4000-8000-000000000009',
        'retention-0062-user', 'null-lease-secret@example.invalid',
        'weekly-summary', '1', '{"secret":"null-lease"}'::jsonb,
        'retention-0062-null-lease',
        '62200000-0000-4000-8000-000000000009',
        'a:retention-0062-user', 'quarantined', 1,
        null, null, 2, null,
        statement_timestamp() - interval '40 days', 'gmail', null,
        statement_timestamp() - interval '40 days', null,
        statement_timestamp() - interval '39 days', 'GMAIL_RESULT_UNKNOWN',
        statement_timestamp() - interval '45 days',
        statement_timestamp() - interval '40 days'
      );
  `);

  for (const role of [
    "learncoding_ops",
    "learncoding_app",
    "learncoding_worker",
    "learncoding_migrator",
  ]) {
    const rejected = psqlAs(
      port,
      database,
      role,
      `update public.email_outbox
          set to_email =
                'redacted+' || id::text || '@invalid.local',
              variables = '{}'::jsonb,
              updated_at = pg_catalog.statement_timestamp()
        where id = '62000000-0000-4000-8000-000000000001';`,
      { allowFailure: true },
    );
    assert.notEqual(rejected.status, 0, `${role} raw payload update succeeded`);
    assert.match(
      `${rejected.stdout}${rejected.stderr}`,
      /immutable|permission denied/iu,
      `${role} raw payload update failed for the wrong reason`,
    );
  }

  const orphanRejected = psqlAs(
    port,
    database,
    "learncoding_ops",
    `update public.email_outbox
        set to_email = 'redacted+' || id::text || '@invalid.local',
            variables = '{}'::jsonb,
            updated_at = pg_catalog.statement_timestamp()
      where id = '62000000-0000-4000-8000-000000000008';`,
    { allowFailure: true },
  );
  assert.notEqual(
    orphanRejected.status,
    0,
    "ops raw update reached the orphan-scope payload",
  );
  assert.match(
    `${orphanRejected.stdout}${orphanRejected.stderr}`,
    /immutable/iu,
    "orphan-scope runtime denial failed for the wrong reason",
  );

  for (const role of [
    "learncoding_app",
    "learncoding_worker",
    "learncoding_migrator",
  ]) {
    const rejected = psqlAs(
      port,
      database,
      role,
      `select * from public.redact_unresolved_email_outbox_authority(
         pg_catalog.statement_timestamp() - interval '30 days',
         10
       );`,
      { allowFailure: true },
    );
    assert.notEqual(rejected.status, 0, `${role} executed redaction routine`);
    assert.match(`${rejected.stdout}${rejected.stderr}`, /permission denied/iu);
  }

  for (const role of ["learncoding_app", "learncoding_worker"]) {
    for (const target of ["learncoding_owner", "learncoding_ops"]) {
      const rejected = psqlAs(
        port,
        database,
        role,
        `set role ${target};
         select * from public.redact_unresolved_email_outbox_authority(
           pg_catalog.statement_timestamp() - interval '30 days',
           10
         );`,
        { allowFailure: true },
      );
      assert.notEqual(
        rejected.status,
        0,
        `${role} unexpectedly assumed ${target}`,
      );
      assert.match(`${rejected.stdout}${rejected.stderr}`, /permission denied/iu);
    }
  }

  const migratorRoutine = psqlAs(
    port,
    database,
    "learncoding_migrator",
    `begin;
     set local role learncoding_owner;
     select * from public.redact_unresolved_email_outbox_authority(
       pg_catalog.statement_timestamp() - interval '30 days',
       10
     );
     rollback;`,
    { allowFailure: true },
  );
  assert.notEqual(migratorRoutine.status, 0, "migrator invoked owner routine");
  assert.match(
    `${migratorRoutine.stdout}${migratorRoutine.stderr}`,
    /caller is not authorized/iu,
  );

  const migratorRaw = psqlAs(
    port,
    database,
    "learncoding_migrator",
    `begin;
     set local role learncoding_owner;
     update public.email_outbox
        set to_email = 'redacted+' || id::text || '@invalid.local',
            variables = '{}'::jsonb,
            updated_at = pg_catalog.statement_timestamp()
      where id = '62000000-0000-4000-8000-000000000001';
     rollback;`,
    { allowFailure: true },
  );
  assert.notEqual(migratorRaw.status, 0, "migrator reached trigger exception");
  assert.match(
    `${migratorRaw.stdout}${migratorRaw.stderr}`,
    /immutable/iu,
  );

  const invalidCutoff = psqlAs(
    port,
    database,
    "learncoding_ops",
    `select * from public.redact_unresolved_email_outbox_authority(
       pg_catalog.statement_timestamp(),
       10
     );`,
    { allowFailure: true },
  );
  assert.notEqual(invalidCutoff.status, 0);
  assert.match(
    `${invalidCutoff.stdout}${invalidCutoff.stderr}`,
    /cutoff violates retention policy/iu,
  );

  const authorityBefore = scalar(
    port,
    database,
    `select (
       to_jsonb(outbox) - 'to_email' - 'variables' - 'updated_at'
     )::text
       from public.email_outbox outbox
      where id = '62000000-0000-4000-8000-000000000001';`,
  );

  psqlAs(port, database, "learncoding_ops", `
    begin;
    do $proof$
    declare
      redacted_ids uuid[];
    begin
      select array_agg(candidate.id order by candidate.id)
        into redacted_ids
        from public.redact_unresolved_email_outbox_authority(
          pg_catalog.statement_timestamp() - interval '30 days',
          10
        ) candidate;
      if redacted_ids is distinct from array[
        '62000000-0000-4000-8000-000000000001'::uuid
      ] then
        raise exception 'unexpected redaction set: %', redacted_ids;
      end if;
    end
    $proof$;
    commit;
  `);

  assert.equal(
    scalar(
      port,
      database,
      `select to_email || '|' || variables::text || '|' || status::text
         from public.email_outbox
        where id = '62000000-0000-4000-8000-000000000001';`,
    ),
    "redacted+62000000-0000-4000-8000-000000000001@invalid.local|{}|quarantined",
  );
  assert.equal(
    scalar(
      port,
      database,
      `select (
         to_jsonb(outbox) - 'to_email' - 'variables' - 'updated_at'
       )::text
         from public.email_outbox outbox
        where id = '62000000-0000-4000-8000-000000000001';`,
    ),
    authorityBefore,
    "redaction changed delivery authority or provider evidence",
  );
  assert.equal(
    scalar(
      port,
      database,
      `select count(*)::text
         from public.email_outbox
        where id in (
          '62000000-0000-4000-8000-000000000002',
          '62000000-0000-4000-8000-000000000003',
          '62000000-0000-4000-8000-000000000004',
          '62000000-0000-4000-8000-000000000005',
          '62000000-0000-4000-8000-000000000006',
          '62000000-0000-4000-8000-000000000008',
          '62000000-0000-4000-8000-000000000009'
        )
          and variables <> '{}'::jsonb
          and to_email like '%secret@example.invalid';`,
    ),
    "7",
    "active, young, wrong-state, system, non-Gmail, orphan, or null-lease row was redacted",
  );

  const redactedAt = scalar(
    port,
    database,
    `select updated_at::text from public.email_outbox
      where id = '62000000-0000-4000-8000-000000000001';`,
  );
  assert.equal(
    scalarAs(
      port,
      database,
      "learncoding_ops",
      `select count(*)::text
         from public.redact_unresolved_email_outbox_authority(
           pg_catalog.statement_timestamp() - interval '30 days',
           10
         );`,
    ),
    "0",
  );
  assert.equal(
    scalar(
      port,
      database,
      `select updated_at::text from public.email_outbox
        where id = '62000000-0000-4000-8000-000000000001';`,
    ),
    redactedAt,
    "idempotent replay changed updated_at",
  );

  psqlAs(port, database, "learncoding_worker", `
    update public.email_outbox
       set status = 'sent',
           provider_message_id = 'gmail-retention-0062-message',
           sent_at = pg_catalog.statement_timestamp(),
           quarantined_at = null,
           last_error_code = null,
           claim_token = null,
           claim_owner = null,
           lease_expires_at = null,
           updated_at = pg_catalog.statement_timestamp()
     where id = '62000000-0000-4000-8000-000000000001'
       and status = 'quarantined'
       and provider_call_started is not null
       and provider_message_id is null;
  `);
  assert.equal(
    scalar(
      port,
      database,
      `select status::text || '|' || provider_message_id || '|' ||
              (sent_at is not null)::text || '|' ||
              (quarantined_at is null)::text || '|' ||
              to_email || '|' || variables::text
         from public.email_outbox
        where id = '62000000-0000-4000-8000-000000000001';`,
    ),
    "sent|gmail-retention-0062-message|true|true|"
      + "redacted+62000000-0000-4000-8000-000000000001@invalid.local|{}",
  );
}

function insertRaceFixture(port, database, fixture) {
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
      '${fixture.id}',
      'retention-0062-user', '${fixture.email}',
      'weekly-summary', '1', '{"secret":"race"}'::jsonb,
      '${fixture.idempotencyKey}',
      '${fixture.operationId}',
      'a:retention-0062-user', 'quarantined', 3,
      '${fixture.claimToken}',
      'gmail-worker-race', 6,
      '2025-01-03T00:00:00Z'::timestamptz,
      '2025-01-02T00:00:00Z'::timestamptz, 'gmail', null,
      '2025-01-03T00:00:00Z'::timestamptz, null,
      '2025-01-04T00:00:00Z'::timestamptz, 'GMAIL_RESULT_UNKNOWN',
      '2025-01-01T00:00:00Z'::timestamptz,
      '2025-01-05T00:00:00Z'::timestamptz
    );
  `);
}

function gmailFinalizationCasSql(fixture, providerMessageId) {
  return `
    select id
      from public.email_outbox
     where id = '${fixture.id}'::uuid
       and operation_id = '${fixture.operationId}'::uuid
       and claim_version = 6
       and user_id is not distinct from 'retention-0062-user'
       and delivery_scope_key = 'a:retention-0062-user'
       and adapter = 'gmail'
       and claim_token is not distinct from '${fixture.claimToken}'::uuid
       and claim_owner is not distinct from 'gmail-worker-race'
       and lease_expires_at is not distinct from
             '2025-01-03T00:00:00Z'::timestamptz
       and provider_call_started =
             '2025-01-02T00:00:00Z'::timestamptz
       and quarantined_at = '2025-01-04T00:00:00Z'::timestamptz
       and last_error_code = 'GMAIL_RESULT_UNKNOWN'
       and provider_message_id is null
       and sent_at is null
       and status = 'quarantined';
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('user-authority:retention-0062-user')
    );
    update public.email_outbox
       set status = 'sent',
           provider_message_id = '${providerMessageId}',
           sent_at = pg_catalog.statement_timestamp(),
           quarantined_at = null,
           last_error_code = null,
           claim_token = null,
           claim_owner = null,
           lease_expires_at = null,
           updated_at = pg_catalog.statement_timestamp()
     where id = '${fixture.id}'::uuid
       and operation_id = '${fixture.operationId}'::uuid
       and claim_version = 6
       and user_id is not distinct from 'retention-0062-user'
       and delivery_scope_key = 'a:retention-0062-user'
       and adapter = 'gmail'
       and claim_token is not distinct from '${fixture.claimToken}'::uuid
       and claim_owner is not distinct from 'gmail-worker-race'
       and lease_expires_at is not distinct from
             '2025-01-03T00:00:00Z'::timestamptz
       and provider_call_started =
             '2025-01-02T00:00:00Z'::timestamptz
       and quarantined_at = '2025-01-04T00:00:00Z'::timestamptz
       and last_error_code = 'GMAIL_RESULT_UNKNOWN'
       and provider_message_id is null
       and sent_at is null
       and status = 'quarantined'
     returning id;`;
}

async function proveConcurrentRedactionAndFinalization(port, database) {
  const redactorFirst = {
    id: "62000000-0000-4000-8000-000000000007",
    operationId: "62200000-0000-4000-8000-000000000007",
    claimToken: "62100000-0000-4000-8000-000000000007",
    idempotencyKey: "retention-0062-race-redactor-first",
    email: "race-redactor-first-secret@example.invalid",
  };
  const finalizerFirst = {
    id: "62000000-0000-4000-8000-000000000010",
    operationId: "62200000-0000-4000-8000-000000000010",
    claimToken: "62100000-0000-4000-8000-000000000010",
    idempotencyKey: "retention-0062-race-finalizer-first",
    email: "race-finalizer-first-secret@example.invalid",
  };
  const { Client } = await import("pg");
  const controller = new Client({
    host: "127.0.0.1", port, user: "postgres", database,
  });
  await controller.connect();
  try {
    insertRaceFixture(port, database, redactorFirst);
    await controller.query("select pg_catalog.pg_advisory_lock(620063)");

    const redactor = startPsql(
      port,
      database,
      "learncoding_ops",
      `begin;
     set application_name = 'mail_retention_0062_redactor';
     select id
       from public.redact_unresolved_email_outbox_authority(
         pg_catalog.statement_timestamp() - interval '30 days',
         10
       );
     select pg_catalog.pg_advisory_lock(620062);
     select pg_catalog.pg_advisory_lock(620063);
     select pg_catalog.pg_advisory_unlock(620063);
     select pg_catalog.pg_advisory_unlock(620062);
     commit;`,
    );

    await waitForScalar(
      port,
      database,
      `select count(*)::text
         from pg_catalog.pg_locks locks
         join pg_catalog.pg_stat_activity activity using (pid)
        where locks.locktype = 'advisory'
          and locks.granted
          and activity.application_name = 'mail_retention_0062_redactor';`,
      "1",
      "redaction session never reached its held-row phase",
    );

    const finalizer = startPsql(
      port,
      database,
      "learncoding_worker",
      `begin;
       set application_name = 'mail_retention_0062_finalizer';
       ${gmailFinalizationCasSql(
         redactorFirst,
         "gmail-retention-0062-redactor-first",
       )}
       commit;`,
    );

    await waitForScalar(
      port,
      database,
      `select count(*)::text
         from pg_catalog.pg_stat_activity
        where application_name = 'mail_retention_0062_finalizer'
          and wait_event_type = 'Lock';`,
      "1",
      "finalizer did not overlap and block on the redaction transaction",
    );
    await controller.query("select pg_catalog.pg_advisory_unlock(620063)");

    const [redactorResult, finalizerResult] = await Promise.all([
      redactor,
      finalizer,
    ]);
    assert.equal(
      redactorResult.status,
      0,
      `redactor failed\n${redactorResult.stdout}${redactorResult.stderr}`,
    );
    assert.equal(
      finalizerResult.status,
      0,
      `finalizer failed\n${finalizerResult.stdout}${finalizerResult.stderr}`,
    );
    assert.equal(
      scalar(
        port,
        database,
        `select status::text || '|' || provider_message_id || '|' ||
                (sent_at is not null)::text || '|' ||
                to_email || '|' || variables::text
           from public.email_outbox
          where id = '${redactorFirst.id}';`,
      ),
      "sent|gmail-retention-0062-redactor-first|true|"
        + `redacted+${redactorFirst.id}@invalid.local|{}`,
    );

    insertRaceFixture(port, database, finalizerFirst);
    await controller.query("select pg_catalog.pg_advisory_lock(620065)");
    const firstFinalizer = startPsql(
      port,
      database,
      "learncoding_worker",
      `begin;
       set application_name = 'mail_retention_0062_first_finalizer';
       ${gmailFinalizationCasSql(
         finalizerFirst,
         "gmail-retention-0062-finalizer-first",
       )}
       select pg_catalog.pg_advisory_lock(620064);
       select pg_catalog.pg_advisory_lock(620065);
       select pg_catalog.pg_advisory_unlock(620065);
       select pg_catalog.pg_advisory_unlock(620064);
       commit;`,
    );
    await waitForScalar(
      port,
      database,
      `select count(*)::text
         from pg_catalog.pg_locks locks
         join pg_catalog.pg_stat_activity activity using (pid)
        where locks.locktype = 'advisory'
          and locks.granted
          and activity.application_name =
                'mail_retention_0062_first_finalizer';`,
      "2",
      "finalizer-first session never reached its held-row phase",
    );

    const secondRedactor = await startPsql(
      port,
      database,
      "learncoding_ops",
      `set application_name = 'mail_retention_0062_second_redactor';
       do $proof$
       declare redacted_count integer;
       begin
         select count(*)::integer
           into redacted_count
           from public.redact_unresolved_email_outbox_authority(
             pg_catalog.statement_timestamp() - interval '30 days',
             10
           );
         if redacted_count <> 0 then
           raise exception 'locked resolved row was redacted';
         end if;
       end
       $proof$;`,
    );
    assert.equal(
      secondRedactor.status,
      0,
      `second redactor failed\n${secondRedactor.stdout}${secondRedactor.stderr}`,
    );
    assert.equal(
      scalar(
        port,
        database,
        `select count(*)::text
           from pg_catalog.pg_locks locks
           join pg_catalog.pg_stat_activity activity using (pid)
          where locks.locktype = 'advisory'
            and locks.granted
            and activity.application_name =
                  'mail_retention_0062_first_finalizer';`,
      ),
      "2",
      "redactor did not finish while the finalizer still held the row",
    );
    await controller.query("select pg_catalog.pg_advisory_unlock(620065)");
    const firstFinalizerResult = await firstFinalizer;
    assert.equal(
      firstFinalizerResult.status,
      0,
      `first finalizer failed\n`
        + `${firstFinalizerResult.stdout}${firstFinalizerResult.stderr}`,
    );
    assert.equal(
      scalar(
        port,
        database,
        `select status::text || '|' || provider_message_id || '|' ||
                to_email || '|' || variables::text
           from public.email_outbox
          where id = '${finalizerFirst.id}';`,
      ),
      "sent|gmail-retention-0062-finalizer-first|"
        + `${finalizerFirst.email}|{"secret": "race"}`,
    );
  } finally {
    await controller.query("select pg_catalog.pg_advisory_unlock_all()")
      .catch(() => undefined);
    await controller.end().catch(() => undefined);
  }
}

async function main() {
  const version = run(executable("postgres"), ["--version"]).stdout.trim();
  assert.match(version, /PostgreSQL\) 18\./u);

  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), "codestead-mail-0060-pg18-"),
  );
  const dataDirectory = path.join(temporaryRoot, "data");
  const logFile = path.join(temporaryRoot, "postgres.log");
  const database = "mail_payload_0060";
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
    run(
      executable("pg_ctl"),
      [
        "-D",
        dataDirectory,
        "-l",
        logFile,
        "-o",
        `-p ${port} -h 127.0.0.1 -c max_connections=20`,
        "-w",
        "start",
      ],
      { stdio: "ignore", timeoutMs: 60_000 },
    );
    run(executable("createdb"), [
      "--host=127.0.0.1",
      `--port=${port}`,
      "--username=postgres",
      database,
    ]);
    await runLiveRoleBootstrap(port, database);
    applyMigrations(port, database);
    const catalogBeforeReplay = redactionCatalogDigest(port, database);
    replayRetentionMigration(port, database);
    assert.equal(
      redactionCatalogDigest(port, database),
      catalogBeforeReplay,
      "0062 replay changed its function catalog contract",
    );
    await proveBootstrapReplay(port, database, catalogBeforeReplay);
    grantRuntimePrivileges(port, database);
    proveImmutability(port, database);
    proveRetentionRedaction(port, database);
    await proveConcurrentRedactionAndFinalization(port, database);
    process.stdout.write("mail_payload_0060=immutable_payload:pass\n");
    process.stdout.write("mail_payload_0060=mutable_delivery_state:pass\n");
    process.stdout.write("mail_retention_0062=restricted_redaction:pass\n");
    process.stdout.write("mail_retention_0062=reconciliation_after_redaction:pass\n");
    process.stdout.write("mail_retention_0062=migration_replay:pass\n");
    process.stdout.write("mail_retention_0062=bootstrap_restore_replay:pass\n");
    process.stdout.write("mail_retention_0062=concurrent_reconciliation:pass\n");
    process.stdout.write(`mail_payload_0060=postgres:${version}:pass\n`);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let cleanupError;
    if (startAttempted) {
      const stopped = run(
        executable("pg_ctl"),
        ["-D", dataDirectory, "stop", "-m", "immediate", "-w"],
        { allowFailure: true, stdio: "ignore", timeoutMs: 30_000 },
      );
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
        process.stderr.write(`cleanup_error=${String(cleanupError)}\n`);
      } else {
        throw cleanupError;
      }
    }
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
