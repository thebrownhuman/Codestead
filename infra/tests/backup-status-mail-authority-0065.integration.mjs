#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const { Client } = pg;
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const postgresBin = process.env.BACKUP_STATUS_POSTGRES_BIN ?? "";
const expectedMajor = process.env.BACKUP_STATUS_POSTGRES_MAJOR ?? "";

assert.match(
  expectedMajor,
  /^(?:17|18)$/u,
  "BACKUP_STATUS_POSTGRES_MAJOR must be exactly 17 or 18",
);
assert.ok(
  postgresBin,
  "BACKUP_STATUS_POSTGRES_BIN must name the reviewed PostgreSQL binary directory",
);

function executable(name) {
  return path.join(postgresBin, `${name}${executableSuffix}`);
}

function childEnvironment() {
  const allowed = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "SystemRoot",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
  ];
  return Object.fromEntries(
    allowed.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]]),
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: childEnvironment(),
    input: options.input,
    maxBuffer: 4 * 1024 * 1024,
    timeout: options.timeoutMs ?? 30_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
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
  const { port } = address;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

function clientConfig(port, user, database = "backup_status_0065") {
  return {
    host: "127.0.0.1",
    port,
    user,
    database,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: "codestead-backup-status-0065-proof",
    ssl: false,
  };
}

async function connected(config) {
  const client = new Client(config);
  await client.connect();
  return client;
}

async function asOwner(client, sql, parameters = []) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE learncoding_owner");
    const result = await client.query(sql, parameters);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function expectCode(action, expectedCode, label) {
  await assert.rejects(
    action,
    (error) => {
      assert.equal(error?.code, expectedCode, label);
      return true;
    },
  );
}

const fixedSummary = Object.freeze({
  success:
    "The nightly encrypted backup completed and passed local verification. No archive is attached to this email.",
  failure:
    "The nightly encrypted backup did not complete. Review the protected operations logs; no archive or log is attached to this email.",
});

async function main() {
  const version = run(executable("postgres"), ["--version"]).stdout.trim();
  assert.match(
    version,
    new RegExp(`PostgreSQL\\) ${expectedMajor}\\.`, "u"),
    "the harness must run against its declared PostgreSQL major",
  );

  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), `codestead-backup-status-0065-pg${expectedMajor}-`),
  );
  const dataDirectory = path.join(temporaryRoot, "data");
  const port = await unusedLoopbackPort();
  let serverStarted = false;
  let admin;
  let reporter;
  let worker;
  let app;

  try {
    run(executable("initdb"), [
      "--pgdata",
      dataDirectory,
      "--username=postgres",
      "--auth-local=trust",
      "--auth-host=trust",
      "--encoding=UTF8",
      "--no-locale",
    ]);
    run(
      executable("pg_ctl"),
      [
        "--pgdata",
        dataDirectory,
        "--options",
        `-h 127.0.0.1 -p ${port} -F -c listen_addresses=127.0.0.1`,
        "--wait",
        "start",
      ],
      { timeoutMs: 30_000 },
    );
    serverStarted = true;

    const bootstrap = await connected(clientConfig(port, "postgres", "postgres"));
    await bootstrap.query("CREATE DATABASE backup_status_0065");
    await bootstrap.end();

    admin = await connected(clientConfig(port, "postgres"));
    await admin.query(`
      CREATE ROLE learncoding_owner NOLOGIN;
      CREATE ROLE learncoding_migrator NOLOGIN NOINHERIT;
      CREATE ROLE learncoding_app LOGIN NOINHERIT;
      CREATE ROLE learncoding_worker LOGIN NOINHERIT;
      CREATE ROLE learncoding_ops LOGIN NOINHERIT;
      CREATE ROLE learncoding_backup_reporter LOGIN NOINHERIT;
      GRANT learncoding_owner TO postgres;
      ALTER SCHEMA public OWNER TO learncoding_owner;
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public
        TO learncoding_app, learncoding_worker, learncoding_ops,
           learncoding_backup_reporter;
    `);
    await asOwner(admin, `
      CREATE TABLE public."user" (
        id text PRIMARY KEY,
        email text NOT NULL,
        role text NOT NULL,
        status text NOT NULL,
        banned boolean DEFAULT false NOT NULL
      );
      CREATE TABLE public.email_outbox (
        id uuid PRIMARY KEY,
        operation_id uuid NOT NULL,
        user_id text,
        delivery_scope_key text NOT NULL,
        to_email text NOT NULL,
        template text NOT NULL,
        template_version text NOT NULL,
        variables jsonb NOT NULL,
        idempotency_key text NOT NULL UNIQUE
      );
      REVOKE ALL ON public."user", public.email_outbox
        FROM PUBLIC, learncoding_migrator, learncoding_app,
             learncoding_worker, learncoding_ops,
             learncoding_backup_reporter;
    `);

    const migration = readFileSync(
      path.join(
        repositoryRoot,
        "drizzle",
        "0065_backup_status_mail_authority.sql",
      ),
      "utf8",
    );
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL ROLE learncoding_owner");
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await admin.query(statement);
      }
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }

    const routines = await admin.query(`
      SELECT p.oid::regprocedure::text signature,
             owner_role.rolname owner_name,
             p.prosecdef security_definer,
             p.proconfig settings,
             COALESCE(
               jsonb_agg(
                 jsonb_build_object(
                   'grantee',
                   CASE WHEN acl.grantee = 0
                     THEN 'PUBLIC'
                     ELSE pg_get_userbyid(acl.grantee)
                   END,
                   'privilege', acl.privilege_type,
                   'grantable', acl.is_grantable,
                   'grantor', pg_get_userbyid(acl.grantor)
                 )
                 ORDER BY acl.grantee
               ) FILTER (WHERE acl.grantee <> p.proowner),
               '[]'::jsonb
             ) direct_acl
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_roles owner_role ON owner_role.oid = p.proowner
        CROSS JOIN LATERAL aclexplode(
          COALESCE(p.proacl, acldefault('f', p.proowner))
        ) acl
       WHERE p.oid IN (
         'public.enqueue_backup_status_mail_authority(text,text)'::regprocedure,
         'public.backup_status_mail_authorized(uuid)'::regprocedure
       )
       GROUP BY p.oid, owner_role.rolname, p.prosecdef, p.proconfig
       ORDER BY signature
    `);
    assert.equal(routines.rowCount, 2);
    const routineBySignature = Object.fromEntries(
      routines.rows.map((row) => [row.signature, row]),
    );
    for (const routine of routines.rows) {
      assert.equal(routine.owner_name, "learncoding_owner");
      assert.equal(routine.security_definer, true);
      assert.deepEqual(routine.settings, ["search_path=pg_catalog"]);
    }
    assert.deepEqual(
      routineBySignature["backup_status_mail_authorized(uuid)"].direct_acl,
      [{
        grantee: "learncoding_worker",
        privilege: "EXECUTE",
        grantable: false,
        grantor: "learncoding_owner",
      }],
    );
    assert.deepEqual(
      routineBySignature[
        "enqueue_backup_status_mail_authority(text,text)"
      ].direct_acl,
      [{
        grantee: "learncoding_backup_reporter",
        privilege: "EXECUTE",
        grantable: false,
        grantor: "learncoding_owner",
      }],
    );

    reporter = await connected(
      clientConfig(port, "learncoding_backup_reporter"),
    );
    worker = await connected(clientConfig(port, "learncoding_worker"));
    app = await connected(clientConfig(port, "learncoding_app"));

    await expectCode(
      () => reporter.query(
        "SELECT * FROM public.enqueue_backup_status_mail_authority($1, $2)",
        ["20260101T000000Z", "success"],
      ),
      "23514",
      "a run without an active administrator must fail closed",
    );
    await asOwner(admin, `
      INSERT INTO public."user" (id, email, role, status, banned) VALUES
        ('admin-1', 'admin@example.invalid', 'admin', 'active', false),
        ('admin-2', 'admin-2@example.invalid', 'admin', 'active', false)
    `);
    await expectCode(
      () => reporter.query(
        "SELECT * FROM public.enqueue_backup_status_mail_authority($1, $2)",
        ["20260101T000001Z", "failure"],
      ),
      "23514",
      "multiple active administrators must fail closed",
    );
    await asOwner(
      admin,
      "UPDATE public.\"user\" SET role = 'learner' WHERE id = 'admin-2'",
    );
    await expectCode(
      () => reporter.query(
        "SELECT * FROM public.enqueue_backup_status_mail_authority($1, $2)",
        ["invalid-run-key", "success"],
      ),
      "22023",
      "invalid run keys must fail closed",
    );
    await expectCode(
      () => reporter.query(
        "SELECT * FROM public.enqueue_backup_status_mail_authority($1, $2)",
        ["20260101T000002Z", "partial"],
      ),
      "22023",
      "unknown outcomes must fail closed",
    );

    const runKey = "20260101T000003Z";
    const queued = await reporter.query(
      "SELECT * FROM public.enqueue_backup_status_mail_authority($1, $2)",
      [runKey, "success"],
    );
    assert.equal(queued.rowCount, 1);
    assert.equal(queued.rows[0].acknowledgement, "queued");
    for (const field of ["authority_id", "outbox_id", "operation_id"]) {
      assert.match(
        queued.rows[0][field],
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
    }
    const outboxId = queued.rows[0].outbox_id;
    const payload = await admin.query(
      `SELECT source.run_key, source.outcome, source.recipient_user_id,
              source.recipient_email, source.operation_id,
              candidate.user_id, candidate.delivery_scope_key,
              candidate.to_email, candidate.template,
              candidate.template_version, candidate.variables,
              candidate.idempotency_key,
              candidate.variables ? 'url' has_url
         FROM public.backup_status_mail_authority source
         JOIN public.email_outbox candidate ON candidate.id = source.outbox_id
        WHERE source.outbox_id = $1`,
      [outboxId],
    );
    assert.deepEqual(payload.rows, [{
      run_key: runKey,
      outcome: "success",
      recipient_user_id: "admin-1",
      recipient_email: "admin@example.invalid",
      operation_id: queued.rows[0].operation_id,
      user_id: "admin-1",
      delivery_scope_key: "a:admin-1",
      to_email: "admin@example.invalid",
      template: "backup-status",
      template_version: "1",
      variables: {
        name: "Administrator",
        summary: fixedSummary.success,
      },
      idempotency_key: `backup-status:v1:${runKey}`,
      has_url: false,
    }]);

    const replay = await reporter.query(
      "SELECT * FROM public.enqueue_backup_status_mail_authority($1, $2)",
      [runKey, "success"],
    );
    assert.equal(replay.rows[0].acknowledgement, "existing");
    assert.deepEqual(
      replay.rows[0],
      {
        ...queued.rows[0],
        acknowledgement: "existing",
      },
    );
    await expectCode(
      () => reporter.query(
        "SELECT * FROM public.enqueue_backup_status_mail_authority($1, $2)",
        [runKey, "failure"],
      ),
      "23514",
      "same-run outcome divergence must fail closed",
    );

    assert.equal(
      (await worker.query(
        "SELECT public.backup_status_mail_authorized($1) authorized",
        [outboxId],
      )).rows[0].authorized,
      true,
    );
    for (const [label, mutation, restore] of [
      [
        "operation",
        "UPDATE public.email_outbox SET operation_id = gen_random_uuid() WHERE id = $1",
        "UPDATE public.email_outbox SET operation_id = $2 WHERE id = $1",
      ],
      [
        "recipient",
        "UPDATE public.email_outbox SET user_id = 'admin-2' WHERE id = $1",
        "UPDATE public.email_outbox SET user_id = 'admin-1' WHERE id = $1",
      ],
      [
        "scope",
        "UPDATE public.email_outbox SET delivery_scope_key = 'a:admin-2' WHERE id = $1",
        "UPDATE public.email_outbox SET delivery_scope_key = 'a:admin-1' WHERE id = $1",
      ],
      [
        "recipient email",
        "UPDATE public.email_outbox SET to_email = 'forged@example.invalid' WHERE id = $1",
        "UPDATE public.email_outbox SET to_email = 'admin@example.invalid' WHERE id = $1",
      ],
      [
        "template",
        "UPDATE public.email_outbox SET template = 'verify-email' WHERE id = $1",
        "UPDATE public.email_outbox SET template = 'backup-status' WHERE id = $1",
      ],
      [
        "version",
        "UPDATE public.email_outbox SET template_version = '2' WHERE id = $1",
        "UPDATE public.email_outbox SET template_version = '1' WHERE id = $1",
      ],
      [
        "variables",
        "UPDATE public.email_outbox SET variables = '{\"name\":\"Administrator\",\"summary\":\"forged\",\"url\":\"https://invalid.example\"}'::jsonb WHERE id = $1",
        "UPDATE public.email_outbox SET variables = jsonb_build_object('name','Administrator','summary',$2) WHERE id = $1",
      ],
      [
        "idempotency",
        "UPDATE public.email_outbox SET idempotency_key = 'forged' WHERE id = $1",
        "UPDATE public.email_outbox SET idempotency_key = 'backup-status:v1:' || $2 WHERE id = $1",
      ],
    ]) {
      await asOwner(admin, mutation, [outboxId]);
      assert.equal(
        (await worker.query(
          "SELECT public.backup_status_mail_authorized($1) authorized",
          [outboxId],
        )).rows[0].authorized,
        false,
        `${label} forgery must fail closed`,
      );
      const restoreValue = label === "operation"
        ? queued.rows[0].operation_id
        : label === "variables"
          ? fixedSummary.success
          : runKey;
      await asOwner(
        admin,
        restore,
        restore.includes("$2") ? [outboxId, restoreValue] : [outboxId],
      );
    }

    await asOwner(
      admin,
      "UPDATE public.email_outbox SET template = 'verify-email' WHERE id = $1",
      [outboxId],
    );
    await expectCode(
      () => reporter.query(
        "SELECT * FROM public.enqueue_backup_status_mail_authority($1, $2)",
        [runKey, "success"],
      ),
      "23514",
      "a replay after payload forgery must fail closed",
    );
    await asOwner(
      admin,
      "UPDATE public.email_outbox SET template = 'backup-status' WHERE id = $1",
      [outboxId],
    );

    for (const [label, mutation, restore] of [
      [
        "demotion",
        "UPDATE public.\"user\" SET role = 'learner' WHERE id = 'admin-1'",
        "UPDATE public.\"user\" SET role = 'admin' WHERE id = 'admin-1'",
      ],
      [
        "ban",
        "UPDATE public.\"user\" SET banned = true WHERE id = 'admin-1'",
        "UPDATE public.\"user\" SET banned = false WHERE id = 'admin-1'",
      ],
      [
        "email change",
        "UPDATE public.\"user\" SET email = 'changed@example.invalid' WHERE id = 'admin-1'",
        "UPDATE public.\"user\" SET email = 'admin@example.invalid' WHERE id = 'admin-1'",
      ],
    ]) {
      await asOwner(admin, mutation);
      assert.equal(
        (await worker.query(
          "SELECT public.backup_status_mail_authorized($1) authorized",
          [outboxId],
        )).rows[0].authorized,
        false,
        `${label} must revoke backup-status authority`,
      );
      await asOwner(admin, restore);
    }
    await asOwner(
      admin,
      "UPDATE public.\"user\" SET role = 'admin' WHERE id = 'admin-2'",
    );
    assert.equal(
      (await worker.query(
        "SELECT public.backup_status_mail_authorized($1) authorized",
        [outboxId],
      )).rows[0].authorized,
      false,
      "a second active administrator must revoke authority",
    );
    await asOwner(
      admin,
      "UPDATE public.\"user\" SET role = 'learner' WHERE id = 'admin-2'",
    );
    await asOwner(
      admin,
      "DELETE FROM public.\"user\" WHERE id = 'admin-1'",
    );
    assert.equal(
      (await worker.query(
        "SELECT public.backup_status_mail_authorized($1) authorized",
        [outboxId],
      )).rows[0].authorized,
      false,
      "administrator deletion must revoke authority",
    );
    await asOwner(
      admin,
      `INSERT INTO public."user" (id, email, role, status, banned)
       VALUES ('admin-1', 'admin@example.invalid', 'admin', 'active', false)`,
    );

    const forgedOutboxId = (
      await asOwner(
        admin,
        `INSERT INTO public.email_outbox (
           id, operation_id, user_id, delivery_scope_key, to_email, template,
           template_version, variables, idempotency_key
         ) VALUES (
           gen_random_uuid(), gen_random_uuid(), 'admin-1', 'a:admin-1',
           'admin@example.invalid', 'backup-status', '1',
           jsonb_build_object('name','Administrator','summary',$1),
           'backup-status:v1:20990101T000000Z'
         ) RETURNING id`,
        [fixedSummary.success],
      )
    ).rows[0].id;
    assert.equal(
      (await worker.query(
        "SELECT public.backup_status_mail_authorized($1) authorized",
        [forgedOutboxId],
      )).rows[0].authorized,
      false,
      "an outbox row without its exact durable source must fail closed",
    );
    await expectCode(
      () => asOwner(
        admin,
        `UPDATE public.backup_status_mail_authority
            SET recipient_email = 'forged@example.invalid'
          WHERE outbox_id = $1`,
        [outboxId],
      ),
      "23514",
      "the durable source must reject mutation even by its owner",
    );
    await expectCode(
      () => asOwner(
        admin,
        "TRUNCATE TABLE public.backup_status_mail_authority",
      ),
      "23514",
      "the durable source must reject truncation even by its owner",
    );

    for (const [client, sql, label] of [
      [
        reporter,
        "SELECT * FROM public.backup_status_mail_authority",
        "reporter table read",
      ],
      [
        reporter,
        "INSERT INTO public.email_outbox (id, operation_id, user_id, delivery_scope_key, to_email, template, template_version, variables, idempotency_key) VALUES (gen_random_uuid(), gen_random_uuid(), NULL, 'a:forged', 'forged@example.invalid', 'backup-status', '1', '{}'::jsonb, 'forged-direct')",
        "reporter direct outbox insert",
      ],
      [
        worker,
        "SELECT * FROM public.enqueue_backup_status_mail_authority('20260101T000004Z', 'success')",
        "worker enqueue",
      ],
      [
        reporter,
        `SELECT public.backup_status_mail_authorized(
          '00000000-0000-0000-0000-000000000000'::uuid
        )`,
        "reporter predicate",
      ],
      [
        app,
        "SELECT * FROM public.enqueue_backup_status_mail_authority('20260101T000005Z', 'success')",
        "app enqueue",
      ],
    ]) {
      await expectCode(
        () => client.query(sql),
        "42501",
        `${label} must be denied`,
      );
    }
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL ROLE learncoding_backup_reporter");
      await expectCode(
        () => admin.query(
          "SELECT * FROM public.enqueue_backup_status_mail_authority($1, $2)",
          ["20260101T000006Z", "success"],
        ),
        "42501",
        "SET ROLE must not forge the reporter session authority",
      );
    } finally {
      await admin.query("ROLLBACK");
    }

    process.stdout.write(
      `backup_status_mail_authority_0065=postgres:${expectedMajor}:pass\n`,
    );
    process.stdout.write(
      "backup_status_mail_authority_0065=owner_security_acl:pass\n",
    );
    process.stdout.write(
      "backup_status_mail_authority_0065=replay_revocation_forgery:pass\n",
    );
  } finally {
    await Promise.allSettled(
      [app, worker, reporter, admin]
        .filter(Boolean)
        .map((client) => client.end()),
    );
    if (serverStarted) {
      run(
        executable("pg_ctl"),
        ["--pgdata", dataDirectory, "--wait", "--mode=immediate", "stop"],
        { allowFailure: true, timeoutMs: 15_000 },
      );
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
