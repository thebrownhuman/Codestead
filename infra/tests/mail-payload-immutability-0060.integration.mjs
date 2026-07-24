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
    { input: sql, allowFailure: options.allowFailure },
  );
}

function scalar(port, database, sql) {
  return psql(port, database, sql, { scalar: true }).stdout.trim();
}

function applyMigrations(port, database) {
  const migrations = readdirSync(migrationDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .filter((name) => Number.parseInt(name.slice(0, 4), 10) <= 60)
    .sort();
  assert.equal(migrations.length, 61);

  migrations.forEach((name, index) => {
    assert.equal(Number.parseInt(name.slice(0, 4), 10), index);
    run(executable("psql"), [
      ...connectionArgs(port, database),
      "--set=ON_ERROR_STOP=1",
      "--quiet",
      "--single-transaction",
      `--file=${path.join(migrationDirectory, name)}`,
    ]);
  });
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
    applyMigrations(port, database);
    proveImmutability(port, database);
    process.stdout.write("mail_payload_0060=immutable_payload:pass\n");
    process.stdout.write("mail_payload_0060=mutable_delivery_state:pass\n");
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
