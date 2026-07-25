#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import pg from "pg";
import {
  BackupStatusMailAuthorityContractError,
  verifyBackupStatusMailAuthorityObjects,
} from "../../scripts/verify-backup-status-mail-authority.mjs";
import {
  reconcileBackupStatusAuthorityPrivileges,
  verifyBackupStatusAuthorityAfterRepair,
  verifyBackupStatusAuthorityBeforeRepair,
} from "../../scripts/bootstrap-database-roles.mjs";
import { allocateDisposableLoopbackPort } from
  "../../scripts/lib/disposable-loopback-port.mjs";

const { Client } = pg;
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
function resolvePostgresRuntime(environment) {
  const canonical = [
    ["17", environment.POSTGRES_17_BIN ?? ""],
    ["18", environment.POSTGRES_18_BIN ?? ""],
  ].filter(([, binaryDirectory]) => binaryDirectory !== "");
  const fallbackBin = environment.BACKUP_STATUS_POSTGRES_BIN ?? "";
  const fallbackMajor = environment.BACKUP_STATUS_POSTGRES_MAJOR ?? "";

  if (canonical.length > 0) {
    assert.equal(
      canonical.length,
      1,
      "exactly one canonical PostgreSQL runtime must be selected",
    );
    assert.equal(
      fallbackBin,
      "",
      "canonical and fallback PostgreSQL binaries cannot be combined",
    );
    assert.equal(
      fallbackMajor,
      "",
      "canonical and fallback PostgreSQL majors cannot be combined",
    );
    return {
      expectedMajor: canonical[0][0],
      postgresBin: canonical[0][1],
    };
  }

  assert.match(
    fallbackMajor,
    /^(?:17|18)$/u,
    "BACKUP_STATUS_POSTGRES_MAJOR must be exactly 17 or 18",
  );
  assert.ok(
    fallbackBin,
    "a reviewed PostgreSQL binary directory is required",
  );
  return {
    expectedMajor: fallbackMajor,
    postgresBin: fallbackBin,
  };
}

const { postgresBin, expectedMajor } =
  resolvePostgresRuntime(process.env);
const externalPostgresPortText =
  process.env.BACKUP_STATUS_POSTGRES_PORT ?? "";

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
    stdio: options.stdio ?? "pipe",
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

async function waitForPostgres(port) {
  const deadline = Date.now() + 30_000;
  let lastStatus = "not-started";
  while (Date.now() < deadline) {
    const probe = run(
      executable("pg_isready"),
      [
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--username",
        "postgres",
        "--dbname",
        "postgres",
      ],
      { allowFailure: true, timeoutMs: 5_000 },
    );
    lastStatus = `${probe.status}:${probe.stderr ?? probe.stdout ?? ""}`.trim();
    if (probe.status === 0) return;
    await delay(100);
  }
  throw new Error(
    `PostgreSQL did not become ready on the loopback port: ${lastStatus}`,
  );
}


function parseExternalPostgresPort(value) {
  if (value === "") return undefined;
  assert.match(
    value,
    /^[1-9][0-9]{0,4}$/u,
    "BACKUP_STATUS_POSTGRES_PORT must be a decimal loopback port",
  );
  const port = Number(value);
  assert.ok(port <= 65_535, "BACKUP_STATUS_POSTGRES_PORT is out of range");
  assert.notEqual(
    port,
    5432,
    "the disposable PostgreSQL proof must never use host port 5432",
  );
  return port;
}

function clientConfig(
  port,
  user,
  database = "backup_status_0065",
  applicationName = "codestead-backup-status-0065-probe",
) {
  return {
    host: "127.0.0.1",
    port,
    user,
    database,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: applicationName,
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
  const externalPostgresPort = parseExternalPostgresPort(
    externalPostgresPortText,
  );
  const managedServer = externalPostgresPort === undefined;
  if (managedServer) {
    const version = run(executable("postgres"), ["--version"]).stdout.trim();
    assert.match(
      version,
      new RegExp(`PostgreSQL\\) ${expectedMajor}\\.`, "u"),
      "the harness must run against its declared PostgreSQL major",
    );
  }

  const temporaryRoot = managedServer
    ? mkdtempSync(
      path.join(os.tmpdir(), `codestead-backup-status-0065-pg${expectedMajor}-`),
    )
    : undefined;
  const dataDirectory = temporaryRoot
    ? path.join(temporaryRoot, "data")
    : undefined;
  const serverLog = temporaryRoot
    ? path.join(temporaryRoot, "postgres.log")
    : undefined;
  const postmasterPid = dataDirectory
    ? path.join(dataDirectory, "postmaster.pid")
    : undefined;
  const port = externalPostgresPort ??
    await allocateDisposableLoopbackPort();
  assert.notEqual(port, 5432, "the disposable PostgreSQL proof must never use host port 5432");
  let serverStartAttempted = false;
  let bootstrap;
  let admin;
  let observer;
  let reporter;
  let worker;
  let app;
  let authorityWriter;
  let primaryError;
  const cleanupErrors = [];

  try {
    if (managedServer) {
      run(executable("initdb"), [
        "--pgdata",
        dataDirectory,
        "--username=postgres",
        "--auth-local=trust",
        "--auth-host=trust",
        "--encoding=UTF8",
        "--no-locale",
      ]);
      serverStartAttempted = true;
      run(
        executable("pg_ctl"),
        [
          "--pgdata",
          dataDirectory,
          "--log",
          serverLog,
          "--options",
          `-h 127.0.0.1 -p ${port} -F -c listen_addresses=127.0.0.1`,
          "--no-wait",
          "start",
        ],
        { stdio: "ignore", timeoutMs: 10_000 },
      );
    }
    await waitForPostgres(port);

    bootstrap = await connected(
      clientConfig(
        port,
        "postgres",
        "postgres",
        "codestead-backup-status-0065-bootstrap",
      ),
    );
    const serverVersion = await bootstrap.query("SHOW server_version_num");
    assert.equal(
      Math.trunc(Number(serverVersion.rows[0].server_version_num) / 10_000),
      Number(expectedMajor),
      "the live server must match BACKUP_STATUS_POSTGRES_MAJOR",
    );
    await bootstrap.query("CREATE DATABASE backup_status_0065");
    await bootstrap.end();
    bootstrap = undefined;

    admin = await connected(
      clientConfig(
        port,
        "postgres",
        "backup_status_0065",
        "codestead-backup-status-0065-admin",
      ),
    );
    observer = await connected(
      clientConfig(
        port,
        "postgres",
        "backup_status_0065",
        "codestead-backup-status-0065-observer",
      ),
    );
    await admin.query(`
      CREATE ROLE learncoding_owner NOLOGIN;
      CREATE ROLE learncoding_migrator NOLOGIN NOINHERIT;
      CREATE ROLE learncoding_app LOGIN NOINHERIT;
      CREATE ROLE learncoding_worker LOGIN NOINHERIT;
      CREATE ROLE learncoding_ops LOGIN NOINHERIT;
      CREATE ROLE learncoding_backup_reporter LOGIN NOINHERIT;
      CREATE ROLE backup_status_acl_probe NOLOGIN;
      CREATE ROLE backup_status_acl_leaf NOLOGIN;
      GRANT learncoding_owner TO postgres;
      ALTER SCHEMA public OWNER TO learncoding_owner;
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public
        TO learncoding_app, learncoding_worker, learncoding_ops,
           learncoding_backup_reporter, backup_status_acl_probe,
           backup_status_acl_leaf;
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

    await asOwner(admin, `
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
        ON TABLES TO backup_status_acl_probe
        WITH GRANT OPTION;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT USAGE, SELECT, UPDATE
        ON SEQUENCES TO backup_status_acl_probe
        WITH GRANT OPTION;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT EXECUTE ON FUNCTIONS TO backup_status_acl_probe
        WITH GRANT OPTION
    `);

    const migration = readFileSync(
      path.join(
        repositoryRoot,
        "drizzle",
        "0065_backup_status_mail_authority.sql",
      ),
      "utf8",
    );
    let ownedSequenceInjected = false;
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL ROLE learncoding_owner");
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (!statement.trim()) continue;
        if (statement.includes("codestead_backup_status_acl_scrub")) {
          await admin.query(`
            CREATE SEQUENCE
              public.backup_status_mail_authority_acl_probe;
            ALTER SEQUENCE
              public.backup_status_mail_authority_acl_probe
              OWNED BY public.backup_status_mail_authority.created_at;
            REVOKE ALL PRIVILEGES
              ON TABLE public.backup_status_mail_authority
              FROM backup_status_acl_probe;
            GRANT SELECT (outcome), INSERT (run_key),
                  UPDATE (created_at), REFERENCES (id)
              ON TABLE public.backup_status_mail_authority
              TO backup_status_acl_probe
              WITH GRANT OPTION;
            SET LOCAL ROLE backup_status_acl_probe;
            GRANT SELECT
              ON TABLE public.backup_status_mail_admin_guard
              TO backup_status_acl_leaf;
            GRANT SELECT (outcome)
              ON TABLE public.backup_status_mail_authority
              TO backup_status_acl_leaf;
            GRANT SELECT
              ON SEQUENCE
                public.backup_status_mail_authority_acl_probe
              TO backup_status_acl_leaf;
            GRANT EXECUTE ON FUNCTION
              public.backup_status_mail_authorized(uuid)
              TO backup_status_acl_leaf;
            SET LOCAL ROLE learncoding_owner
          `);
          ownedSequenceInjected = true;
        }
        await admin.query(statement);
      }
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }

    assert.equal(
      await verifyBackupStatusAuthorityBeforeRepair(admin),
      true,
      "a freshly migrated authority must pass the pre-repair boundary",
    );
    const columnAuthority = await admin.query(`
      WITH target AS (
        SELECT relation.oid
          FROM pg_catalog.pg_class AS relation
         WHERE relation.oid = ANY(
           ARRAY[
             'public.backup_status_mail_authority'::regclass::oid,
             'public.backup_status_mail_admin_guard'::regclass::oid
           ]
         )
      )
      SELECT NOT EXISTS (
               SELECT 1
                 FROM target
                 JOIN pg_catalog.pg_attribute AS attribute
                   ON attribute.attrelid = target.oid
                  AND attribute.attnum > 0
                  AND NOT attribute.attisdropped
                 CROSS JOIN LATERAL pg_catalog.aclexplode(
                   attribute.attacl
                 ) AS column_acl
             ) direct_column_acl_exact,
             NOT EXISTS (
               SELECT 1
                 FROM target
                 JOIN pg_catalog.pg_attribute AS attribute
                   ON attribute.attrelid = target.oid
                  AND attribute.attnum > 0
                  AND NOT attribute.attisdropped
                 CROSS JOIN pg_catalog.unnest(
                   ARRAY[
                     'backup_status_acl_probe',
                     'backup_status_acl_leaf'
                   ]::text[]
                 ) AS restricted(role_name)
                WHERE pg_catalog.has_column_privilege(
                        restricted.role_name,
                        target.oid,
                        attribute.attnum,
                        'SELECT'
                      )
                   OR pg_catalog.has_column_privilege(
                        restricted.role_name,
                        target.oid,
                        attribute.attnum,
                        'INSERT'
                      )
                   OR pg_catalog.has_column_privilege(
                        restricted.role_name,
                        target.oid,
                        attribute.attnum,
                        'UPDATE'
                      )
                   OR pg_catalog.has_column_privilege(
                        restricted.role_name,
                        target.oid,
                        attribute.attnum,
                        'REFERENCES'
                      )
             ) delegated_roles_denied
    `);
    assert.deepEqual(columnAuthority.rows, [{
      direct_column_acl_exact: true,
      delegated_roles_denied: true,
    }]);
    assert.equal(
      ownedSequenceInjected,
      true,
      "the live proof must exercise an authority-owned sequence ACL",
    );
    const sequenceAuthority = await admin.query(`
      WITH target AS (
        SELECT sequence_relation.*
          FROM pg_catalog.pg_class AS sequence_relation
         WHERE sequence_relation.oid =
               'public.backup_status_mail_authority_acl_probe'::regclass
      ),
      observed(grantor, grantee, privilege_type, is_grantable) AS (
        SELECT acl.grantor,
               acl.grantee,
               acl.privilege_type,
               acl.is_grantable
          FROM target
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            coalesce(
              target.relacl,
              pg_catalog.acldefault('s', target.relowner)
            )
          ) AS acl
      ),
      expected(grantor, grantee, privilege_type, is_grantable) AS (
        SELECT acl.grantor,
               acl.grantee,
               acl.privilege_type,
               acl.is_grantable
          FROM target
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            pg_catalog.acldefault('s', target.relowner)
          ) AS acl
      )
      SELECT pg_catalog.pg_get_userbyid(target.relowner) =
               'learncoding_owner' owner_exact,
             NOT EXISTS (
               (SELECT * FROM observed EXCEPT ALL SELECT * FROM expected)
               UNION ALL
               (SELECT * FROM expected EXCEPT ALL SELECT * FROM observed)
             ) direct_acl_exact,
             NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.unnest(
                   ARRAY[
                     'backup_status_acl_probe',
                     'backup_status_acl_leaf'
                   ]::text[]
                 ) AS restricted(role_name)
                WHERE pg_catalog.has_sequence_privilege(
                        restricted.role_name, target.oid, 'USAGE'
                      )
                   OR pg_catalog.has_sequence_privilege(
                        restricted.role_name, target.oid, 'SELECT'
                      )
                   OR pg_catalog.has_sequence_privilege(
                        restricted.role_name, target.oid, 'UPDATE'
                      )
             ) delegated_roles_denied
        FROM target
    `);
    assert.deepEqual(sequenceAuthority.rows, [{
      owner_exact: true,
      direct_acl_exact: true,
      delegated_roles_denied: true,
    }]);
    await asOwner(
      admin,
      "DROP SEQUENCE public.backup_status_mail_authority_acl_probe",
    );
    await admin.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
        public.backup_status_mail_authority,
        public.backup_status_mail_admin_guard
        TO learncoding_app, learncoding_worker, learncoding_ops;
      GRANT SELECT (authority_epoch) ON TABLE
        public.backup_status_mail_admin_guard
        TO learncoding_backup_reporter;
      GRANT UPDATE (run_key) ON TABLE
        public.backup_status_mail_authority
        TO learncoding_migrator
    `);
    await assert.rejects(
      verifyBackupStatusAuthorityBeforeRepair(admin),
      /backup-status-authority-pre-repair/u,
      "pre-repair verification must expose privilege drift",
    );
    assert.equal(
      await reconcileBackupStatusAuthorityPrivileges(admin),
      true,
      "the focused reconciler must detect both authority relations",
    );
    assert.equal(
      await verifyBackupStatusAuthorityAfterRepair(admin),
      true,
      "post-repair verification must prove the exact authority contract",
    );

    const restrictedAuthorityRoles = [
      "learncoding_app",
      "learncoding_migrator",
      "learncoding_worker",
      "learncoding_ops",
      "learncoding_backup_reporter",
    ];
    const verifyExactAuthority = () =>
      verifyBackupStatusMailAuthorityObjects(
        admin,
        restrictedAuthorityRoles,
      );
    assert.equal(
      await verifyExactAuthority(),
      7,
    );
    const expectVerifierTamper = async (statements, label) => {
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL ROLE learncoding_owner");
        for (const statement of statements) await admin.query(statement);
        await assert.rejects(
          verifyExactAuthority,
          BackupStatusMailAuthorityContractError,
          label,
        );
      } finally {
        await admin.query("ROLLBACK");
      }
      assert.equal(
        await verifyExactAuthority(),
        7,
        `${label}: rollback must restore the exact manifest`,
      );
    };
    const expectVerifierClusterTamper = async (statements, label) => {
      await admin.query("BEGIN");
      try {
        for (const statement of statements) await admin.query(statement);
        await assert.rejects(
          verifyExactAuthority,
          BackupStatusMailAuthorityContractError,
          label,
        );
      } finally {
        await admin.query("ROLLBACK");
      }
      assert.equal(
        await verifyExactAuthority(),
        7,
        `${label}: rollback must restore the exact manifest`,
      );
    };
    await expectVerifierTamper(
      [
        `ALTER TABLE public.backup_status_mail_admin_guard
           ALTER COLUMN authority_epoch DROP DEFAULT`,
      ],
      "guard epoch default tamper must fail closed",
    );
    await expectVerifierTamper(
      [
        `ALTER TABLE public.backup_status_mail_authority
           ALTER COLUMN authority_epoch DROP NOT NULL`,
      ],
      "source epoch nullability tamper must fail closed",
    );
    await expectVerifierTamper(
      [
        `ALTER TABLE public.backup_status_mail_admin_guard
           DROP CONSTRAINT backup_status_mail_admin_guard_epoch_valid`,
        `ALTER TABLE public.backup_status_mail_admin_guard
           ADD CONSTRAINT backup_status_mail_admin_guard_epoch_valid
           CHECK (
             authority_epoch <>
               '00000000-0000-0000-0000-000000000000'::uuid
           ) NOT VALID`,
      ],
      "unvalidated guard epoch constraint must fail closed",
    );
    await expectVerifierTamper(
      [
        `ALTER TABLE public.backup_status_mail_authority
           DROP CONSTRAINT backup_status_mail_authority_epoch_valid`,
      ],
      "missing source epoch constraint must fail closed",
    );
    await expectVerifierTamper(
      [
        `ALTER TABLE public.backup_status_mail_admin_guard
           DROP CONSTRAINT backup_status_mail_admin_guard_pkey`,
      ],
      "missing primary-key constraint and index must fail closed",
    );
    await expectVerifierTamper(
      [
        `ALTER TABLE public.backup_status_mail_authority
           DROP CONSTRAINT backup_status_mail_authority_operation_id_key`,
      ],
      "missing unique constraint and index must fail closed",
    );
    await expectVerifierTamper(
      [
        `ALTER TABLE public.backup_status_mail_authority
           DROP CONSTRAINT backup_status_mail_authority_run_key_valid`,
      ],
      "missing check constraint must fail closed",
    );
    await expectVerifierTamper(
      [
        `CREATE INDEX backup_status_mail_authority_unexpected_probe
             ON public.backup_status_mail_authority (created_at)`,
      ],
      "an unexpected index must fail closed",
    );
    await expectVerifierTamper(
      [
        `ALTER INDEX public.backup_status_mail_authority_run_key_key
           SET (fillfactor = 80)`,
      ],
      "index reloptions tamper must fail closed",
    );
    await expectVerifierTamper(
      [
        `ALTER TABLE public.backup_status_mail_authority
           SET (fillfactor = 80)`,
      ],
      "relation reloptions tamper must fail closed",
    );
    await expectVerifierTamper(
      [
        `ALTER TABLE public.backup_status_mail_authority
           REPLICA IDENTITY FULL`,
      ],
      "replica-identity tamper must fail closed",
    );
    await expectVerifierTamper(
      [
        `CREATE TRIGGER backup_status_mail_admin_guard_unexpected_probe
           BEFORE UPDATE ON public.backup_status_mail_admin_guard
           FOR EACH ROW
           EXECUTE FUNCTION
             public.reject_backup_status_mail_authority_mutation()`,
      ],
      "an unexpected guard-table trigger must fail closed",
    );


    const routineTamperContracts = [
      {
        signature:
          "public.reject_backup_status_mail_authority_mutation()",
        replacement: `
          CREATE OR REPLACE FUNCTION
            public.reject_backup_status_mail_authority_mutation()
          RETURNS trigger
          LANGUAGE plpgsql
          SET search_path = pg_catalog
          AS $tamper$
          BEGIN
            RETURN NEW;
          END
          $tamper$`,
      },
      {
        signature:
          "public.lock_backup_status_mail_admin_authority()",
        replacement: `
          CREATE OR REPLACE FUNCTION
            public.lock_backup_status_mail_admin_authority()
          RETURNS trigger
          LANGUAGE plpgsql
          SECURITY DEFINER
          SET search_path = pg_catalog
          AS $tamper$
          BEGIN
            IF TG_OP = 'DELETE' THEN
              RETURN OLD;
            END IF;
            RETURN NEW;
          END
          $tamper$`,
      },
      {
        signature:
          "public.enqueue_backup_status_mail_authority(text,text)",
        replacement: `
          CREATE OR REPLACE FUNCTION
            public.enqueue_backup_status_mail_authority(
              p_run_key text,
              p_outcome text
            )
          RETURNS TABLE(
            acknowledgement text,
            authority_id uuid,
            outbox_id uuid,
            operation_id uuid
          )
          LANGUAGE plpgsql
          SECURITY DEFINER
          SET search_path = pg_catalog
          AS $tamper$
          BEGIN
            RETURN;
          END
          $tamper$`,
      },
      {
        signature: "public.backup_status_mail_authorized(uuid)",
        replacement: `
          CREATE OR REPLACE FUNCTION
            public.backup_status_mail_authorized(
              p_candidate_outbox_id uuid
            )
          RETURNS boolean
          LANGUAGE plpgsql
          SECURITY DEFINER
          SET search_path = pg_catalog
          AS $tamper$
          BEGIN
            RETURN false;
          END
          $tamper$`,
      },
    ];
    for (const routine of routineTamperContracts) {
      await expectVerifierTamper(
        [routine.replacement],
        `${routine.signature}: body tamper must fail closed`,
      );
      await expectVerifierTamper(
        [`ALTER FUNCTION ${routine.signature} COST 99`],
        `${routine.signature}: metadata tamper must fail closed`,
      );
      await expectVerifierTamper(
        [`GRANT EXECUTE ON FUNCTION ${routine.signature}
            TO learncoding_app`],
        `${routine.signature}: direct ACL tamper must fail closed`,
      );
    }
    await expectVerifierClusterTamper(
      [
        "CREATE ROLE backup_status_authority_inherited_probe NOLOGIN",
        `GRANT EXECUTE ON FUNCTION
           public.enqueue_backup_status_mail_authority(text,text)
           TO backup_status_authority_inherited_probe`,
        `GRANT backup_status_authority_inherited_probe
           TO learncoding_app`,
      ],
      "inherited effective EXECUTE tamper must fail closed",
    );

    reporter = await connected(
      clientConfig(
        port,
        "learncoding_backup_reporter",
        "backup_status_0065",
        "codestead-backup-status-0065-reporter",
      ),
    );
    worker = await connected(
      clientConfig(
        port,
        "learncoding_worker",
        "backup_status_0065",
        "codestead-backup-status-0065-worker",
      ),
    );
    app = await connected(
      clientConfig(
        port,
        "learncoding_app",
        "backup_status_0065",
        "codestead-backup-status-0065-app",
      ),
    );
    authorityWriter = await connected(
      clientConfig(
        port,
        "postgres",
        "backup_status_0065",
        "codestead-backup-status-0065-authority-writer",
      ),
    );
    for (const client of [reporter, worker]) {
      await client.query("SET plpgsql.variable_conflict = 'error'");
      assert.equal(
        (await client.query(
          "SELECT current_setting('plpgsql.variable_conflict') setting",
        )).rows[0].setting,
        "error",
      );
    }

    const ledgerColumns = await admin.query(`
      SELECT attribute.attname
        FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid =
             'public.backup_status_mail_authority'::regclass
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
       ORDER BY attribute.attnum
    `);
    assert.deepEqual(
      ledgerColumns.rows.map(({ attname }) => attname),
      [
        "id",
        "run_key",
        "outcome",
        "outbox_id",
        "operation_id",
        "authority_epoch",
        "created_at",
      ],
      "the immutable authority ledger must not retain a durable user identifier",
    );

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

    const guardEpoch = async (client = admin) => (
      await client.query(
        `SELECT authority_epoch
           FROM public.backup_status_mail_admin_guard
          WHERE singleton IS TRUE`,
      )
    ).rows[0].authority_epoch;
    const committedEpochBeforeRoundTrip = await guardEpoch();
    await authorityWriter.query("BEGIN");
    try {
      await authorityWriter.query("SET LOCAL ROLE learncoding_owner");
      await authorityWriter.query(
        `UPDATE public."user"
            SET email = 'round-trip@example.invalid'
          WHERE id = 'admin-1'`,
      );
      const firstRoundTripEpoch = await guardEpoch(authorityWriter);
      assert.notEqual(
        firstRoundTripEpoch,
        committedEpochBeforeRoundTrip,
        "the first eligible change in a transaction must rotate authority",
      );
      await authorityWriter.query(
        `UPDATE public."user"
            SET email = 'admin@example.invalid'
          WHERE id = 'admin-1'`,
      );
      const secondRoundTripEpoch = await guardEpoch(authorityWriter);
      assert.notEqual(
        secondRoundTripEpoch,
        firstRoundTripEpoch,
        "returning to the original value must rotate authority again",
      );
      await authorityWriter.query("COMMIT");
      assert.equal(await guardEpoch(), secondRoundTripEpoch);
    } catch (error) {
      await authorityWriter.query("ROLLBACK");
      throw error;
    }

    const committedEpochBeforeRollback = await guardEpoch();
    await authorityWriter.query("BEGIN");
    try {
      await authorityWriter.query("SET LOCAL ROLE learncoding_owner");
      await authorityWriter.query(
        `UPDATE public."user"
            SET email = email
          WHERE id = 'admin-1'`,
      );
      assert.notEqual(
        await guardEpoch(authorityWriter),
        committedEpochBeforeRollback,
        "an identical-value eligible update must still rotate in-transaction",
      );
      await authorityWriter.query("ROLLBACK");
    } catch (error) {
      await authorityWriter.query("ROLLBACK");
      throw error;
    }
    assert.equal(
      await guardEpoch(),
      committedEpochBeforeRollback,
      "a rolled-back admin change must not durably rotate authority",
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

    let runKey = "20260101T000003Z";
    let queued = await reporter.query(
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
    let outboxId = queued.rows[0].outbox_id;
    const payload = await admin.query(
      `SELECT source.run_key, source.outcome,
              source.operation_id,
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
    assert.doesNotMatch(
      JSON.stringify(payload.rows[0].variables),
      /authority_epoch|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu,
      "the opaque authority epoch must never enter the mail payload",
    );

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
    const epochBeforeRejectedIdChange = await guardEpoch();
    for (const [query, label] of [
      [
        `UPDATE public."user"
            SET id = 'renamed-admin-1'
          WHERE id = 'admin-1'`,
        "id-only administrator update",
      ],
      [
        `UPDATE public."user"
            SET id = 'renamed-admin-1',
                email = 'renamed-admin@example.invalid'
          WHERE id = 'admin-1'`,
        "id-plus-email administrator update",
      ],
    ]) {
      await expectCode(
        () => asOwner(admin, query),
        "23514",
        `${label} must fail closed`,
      );
      assert.equal(
        await guardEpoch(),
        epochBeforeRejectedIdChange,
        `${label} must not rotate the authority epoch`,
      );
    }
    const retainedIdentity = await admin.query(
      `SELECT candidate.user_id,
              admin_recipient.id AS authority_id
         FROM public.backup_status_mail_authority AS source
         JOIN public.email_outbox AS candidate
           ON candidate.id = source.outbox_id
         JOIN public."user" AS admin_recipient
           ON admin_recipient.id = candidate.user_id
        WHERE source.outbox_id = $1`,
      [outboxId],
    );
    assert.deepEqual(
      retainedIdentity.rows,
      [{ user_id: "admin-1", authority_id: "admin-1" }],
      "rejected identifier changes must retain the bound source identity",
    );
    assert.equal(
      (await worker.query(
        "SELECT public.backup_status_mail_authorized($1) authorized",
        [outboxId],
      )).rows[0].authorized,
      true,
      "rejected identifier changes must retain provider authority",
    );


    await worker.query("BEGIN");
    try {
      assert.equal(
        (await worker.query(
          "SELECT public.backup_status_mail_authorized($1) authorized",
          [outboxId],
        )).rows[0].authorized,
        true,
      );

      await authorityWriter.query("BEGIN");
      try {
        await authorityWriter.query("SET LOCAL ROLE learncoding_owner");
        await authorityWriter.query("SET LOCAL lock_timeout = '500ms'");
        const unrelatedWrite = await authorityWriter.query(
          `UPDATE public."user"
              SET email = 'learner-updated@example.invalid'
            WHERE id = 'admin-2' AND role = 'learner'`,
        );
        assert.equal(
          unrelatedWrite.rowCount,
          1,
          "the provider-boundary guard must not block unrelated user writes",
        );
        await authorityWriter.query("COMMIT");
      } catch (error) {
        await authorityWriter.query("ROLLBACK");
        throw error;
      }

      await authorityWriter.query("BEGIN");
      try {
        await authorityWriter.query("SET LOCAL ROLE learncoding_owner");
        await authorityWriter.query("SET LOCAL lock_timeout = '500ms'");
        await expectCode(
          () => authorityWriter.query(
            `UPDATE public."user"
                SET role = 'admin'
              WHERE id = 'admin-2'`,
          ),
          "55P03",
          "a second administrator must not become active across the boundary",
        );
      } finally {
        await authorityWriter.query("ROLLBACK");
      }

      await authorityWriter.query("BEGIN");
      try {
        await authorityWriter.query("SET LOCAL ROLE learncoding_owner");
        const deletionAccountLock = await authorityWriter.query(
          `SELECT pg_catalog.pg_try_advisory_xact_lock(
             pg_catalog.hashtext(
               'user-authority:admin-1'
             )::pg_catalog.int8
           ) locked`,
        );
        assert.equal(
          deletionAccountLock.rows[0].locked,
          false,
          "canonical deletion must stop at boundary-held A before U/O",
        );
      } finally {
        await authorityWriter.query("ROLLBACK");
      }
    } finally {
      await worker.query("ROLLBACK");
    }

    const adminPid = (
      await admin.query("SELECT pg_backend_pid() pid")
    ).rows[0].pid;
    const authorityWriterPid = (
      await authorityWriter.query("SELECT pg_backend_pid() pid")
    ).rows[0].pid;
    const workerPid = (
      await worker.query("SELECT pg_backend_pid() pid")
    ).rows[0].pid;
    let userFirstTransactionOpen = false;
    let advisoryFirstBoundaryOutcome;
    try {
      await authorityWriter.query("BEGIN");
      userFirstTransactionOpen = true;
      await authorityWriter.query("SET LOCAL ROLE learncoding_owner");
      await authorityWriter.query("SET LOCAL statement_timeout = '5s'");
      await authorityWriter.query(
        `SELECT id
           FROM public."user"
          WHERE id = 'admin-1'
          FOR UPDATE`,
      );

      advisoryFirstBoundaryOutcome = worker.query(
        "SELECT public.backup_status_mail_authorized($1) authorized",
        [outboxId],
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );

      let boundaryWaitObserved = false;
      let lastBoundaryActivity;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const boundaryActivity = await observer.query(
          `SELECT state, wait_event_type, wait_event, query, usename,
                  application_name,
                  pg_catalog.pg_blocking_pids(pid) blocker_pids
             FROM pg_catalog.pg_stat_activity
            WHERE pid = $1`,
          [workerPid],
        );
        lastBoundaryActivity = boundaryActivity.rows[0];
        if (
          Array.isArray(lastBoundaryActivity?.blocker_pids)
          && lastBoundaryActivity.blocker_pids.length > 0
          && lastBoundaryActivity.wait_event_type === "Lock"
          && lastBoundaryActivity.wait_event === "transactionid"
        ) {
          boundaryWaitObserved = true;
          break;
        }
        await delay(25);
      }
      assert.equal(
        boundaryWaitObserved,
        true,
        `the boundary must own A before waiting on U: ${JSON.stringify(lastBoundaryActivity)}`,
      );
      assert.deepEqual(
        lastBoundaryActivity.blocker_pids.map(Number),
        [Number(authorityWriterPid)],
      );
      assert.equal(
        lastBoundaryActivity.application_name,
        "codestead-backup-status-0065-worker",
      );
      assert.equal(lastBoundaryActivity.usename, "learncoding_worker");
      assert.equal(lastBoundaryActivity.wait_event_type, "Lock");
      assert.equal(lastBoundaryActivity.wait_event, "transactionid");
      assert.match(
        lastBoundaryActivity.query,
        /backup_status_mail_authorized/iu,
      );

      await expectCode(
        () => authorityWriter.query(
          `UPDATE public."user"
              SET email = 'must-not-commit@example.invalid'
            WHERE id = 'admin-1'`,
        ),
        "55P03",
        "a privileged U-first mutation must fail instead of waiting on A",
      );
      await authorityWriter.query("ROLLBACK");
      userFirstTransactionOpen = false;

      const boundary = await advisoryFirstBoundaryOutcome;
      if (boundary.error) throw boundary.error;
      assert.equal(
        boundary.value.rows[0].authorized,
        true,
        "the rejected U-first mutation must not revoke valid authority",
      );
    } finally {
      if (userFirstTransactionOpen) await authorityWriter.query("ROLLBACK");
      if (advisoryFirstBoundaryOutcome) await advisoryFirstBoundaryOutcome;
    }

    let guardTransactionOpen = false;
    let writerTransactionOpen = false;
    let adminChangeOutcome;
    let boundaryOutcome;
    try {
      await admin.query("BEGIN");
      guardTransactionOpen = true;
      await admin.query("SET LOCAL ROLE learncoding_owner");
      await admin.query(`
        SELECT authority_guard.singleton
          FROM public.backup_status_mail_admin_guard AS authority_guard
         WHERE authority_guard.singleton IS TRUE
         FOR SHARE OF authority_guard
      `);

      await authorityWriter.query("BEGIN");
      writerTransactionOpen = true;
      await authorityWriter.query("SET LOCAL ROLE learncoding_owner");
      await authorityWriter.query("SET LOCAL statement_timeout = '5s'");
      await authorityWriter.query(
        `SELECT pg_catalog.pg_advisory_xact_lock(
           pg_catalog.hashtext(
             'user-authority:admin-1'
           )::pg_catalog.int8
         )`,
      );
      adminChangeOutcome = authorityWriter.query(
        `UPDATE public."user"
            SET email = 'admin-raced@example.invalid'
          WHERE id = 'admin-1'`,
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );

      await delay(25);
      let writerWaitObserved = false;
      let lastWriterActivity;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const writerActivity = await observer.query(
          `SELECT state, wait_event_type, wait_event, query, usename,
                  application_name,
                  pg_catalog.pg_blocking_pids(pid) blocker_pids
             FROM pg_catalog.pg_stat_activity
            WHERE pid = $1`,
          [authorityWriterPid],
        );
        lastWriterActivity = writerActivity.rows[0];
        if (
          Array.isArray(lastWriterActivity?.blocker_pids)
          && lastWriterActivity.blocker_pids.length > 0
          && lastWriterActivity.wait_event_type === "Lock"
          && lastWriterActivity.wait_event === "transactionid"
        ) {
          writerWaitObserved = true;
          break;
        }
        await delay(25);
      }
      assert.equal(
        writerWaitObserved,
        true,
        `the canonical admin change must own A and U before waiting on G: ${JSON.stringify(lastWriterActivity)}`,
      );
      assert.deepEqual(
        lastWriterActivity.blocker_pids.map(Number),
        [Number(adminPid)],
      );
      assert.equal(
        lastWriterActivity.application_name,
        "codestead-backup-status-0065-authority-writer",
      );
      assert.equal(lastWriterActivity.usename, "postgres");
      assert.equal(lastWriterActivity.wait_event_type, "Lock");
      assert.equal(lastWriterActivity.wait_event, "transactionid");
      assert.match(lastWriterActivity.query, /UPDATE public\."user"/u);

      boundaryOutcome = worker.query(
        "SELECT public.backup_status_mail_authorized($1) authorized",
        [outboxId],
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );

      let boundaryWaitObserved = false;
      let lastBoundaryActivity;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const boundaryActivity = await observer.query(
          `SELECT state, wait_event_type, wait_event, query, usename,
                  application_name,
                  pg_catalog.pg_blocking_pids(pid) blocker_pids
             FROM pg_catalog.pg_stat_activity
            WHERE pid = $1`,
          [workerPid],
        );
        lastBoundaryActivity = boundaryActivity.rows[0];
        if (
          Array.isArray(lastBoundaryActivity?.blocker_pids)
          && lastBoundaryActivity.blocker_pids.length > 0
          && lastBoundaryActivity.wait_event_type === "Lock"
          && lastBoundaryActivity.wait_event === "advisory"
        ) {
          boundaryWaitObserved = true;
          break;
        }
        await delay(25);
      }
      assert.equal(
        boundaryWaitObserved,
        true,
        `the provider boundary must stop at A behind the canonical writer: ${JSON.stringify(lastBoundaryActivity)}`,
      );
      assert.deepEqual(
        lastBoundaryActivity.blocker_pids.map(Number),
        [Number(authorityWriterPid)],
      );
      assert.equal(
        lastBoundaryActivity.application_name,
        "codestead-backup-status-0065-worker",
      );
      assert.equal(lastBoundaryActivity.usename, "learncoding_worker");
      assert.equal(lastBoundaryActivity.wait_event_type, "Lock");
      assert.equal(lastBoundaryActivity.wait_event, "advisory");
      assert.match(
        lastBoundaryActivity.query,
        /backup_status_mail_authorized/iu,
      );

      await admin.query("COMMIT");
      guardTransactionOpen = false;

      const adminChange = await adminChangeOutcome;
      if (adminChange.error) throw adminChange.error;
      assert.equal(adminChange.value.rowCount, 1);
      await authorityWriter.query("COMMIT");
      writerTransactionOpen = false;

      const boundary = await boundaryOutcome;
      if (boundary.error) throw boundary.error;
      assert.equal(
        boundary.value.rows[0].authorized,
        false,
        "the boundary must revalidate after the earlier admin change",
      );
    } finally {
      if (guardTransactionOpen) await admin.query("ROLLBACK");
      if (adminChangeOutcome) await adminChangeOutcome;
      if (writerTransactionOpen) await authorityWriter.query("ROLLBACK");
      if (boundaryOutcome) await boundaryOutcome;
    }
    await asOwner(
      admin,
      `UPDATE public."user"
          SET email = 'admin@example.invalid'
        WHERE id = 'admin-1'`,
    );

    let deletionTransactionOpen = false;
    let deletionBoundaryOutcome;
    try {
      await authorityWriter.query("BEGIN");
      deletionTransactionOpen = true;
      await authorityWriter.query("SET LOCAL ROLE learncoding_owner");
      await authorityWriter.query("SET LOCAL statement_timeout = '5s'");
      await authorityWriter.query(
        `SELECT pg_catalog.pg_advisory_xact_lock(
           pg_catalog.hashtext(
             'user-authority:admin-1'
           )::pg_catalog.int8
         )`,
      );
      await authorityWriter.query(
        `SELECT id
           FROM public."user"
          WHERE id = 'admin-1'
          FOR UPDATE`,
      );
      await authorityWriter.query(
        "DELETE FROM public.email_outbox WHERE id = $1",
        [outboxId],
      );
      await authorityWriter.query(
        `DELETE FROM public."user" WHERE id = 'admin-1'`,
      );

      deletionBoundaryOutcome = worker.query(
        "SELECT public.backup_status_mail_authorized($1) authorized",
        [outboxId],
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );

      let boundaryWaitObserved = false;
      let lastBoundaryActivity;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const boundaryActivity = await observer.query(
          `SELECT state, wait_event_type, wait_event, query, usename,
                  application_name,
                  pg_catalog.pg_blocking_pids(pid) blocker_pids
             FROM pg_catalog.pg_stat_activity
            WHERE pid = $1`,
          [workerPid],
        );
        lastBoundaryActivity = boundaryActivity.rows[0];
        if (
          Array.isArray(lastBoundaryActivity?.blocker_pids)
          && lastBoundaryActivity.blocker_pids.length > 0
          && lastBoundaryActivity.wait_event_type === "Lock"
          && lastBoundaryActivity.wait_event === "advisory"
        ) {
          boundaryWaitObserved = true;
          break;
        }
        await delay(25);
      }
      assert.equal(
        boundaryWaitObserved,
        true,
        `the boundary must wait on deletion's canonical user lock: ${JSON.stringify(lastBoundaryActivity)}`,
      );
      assert.deepEqual(
        lastBoundaryActivity.blocker_pids.map(Number),
        [Number(authorityWriterPid)],
      );
      assert.equal(
        lastBoundaryActivity.application_name,
        "codestead-backup-status-0065-worker",
      );
      assert.equal(lastBoundaryActivity.usename, "learncoding_worker");
      assert.equal(lastBoundaryActivity.wait_event_type, "Lock");
      assert.equal(lastBoundaryActivity.wait_event, "advisory");
      assert.match(
        lastBoundaryActivity.query,
        /backup_status_mail_authorized/iu,
      );

      await authorityWriter.query("COMMIT");
      deletionTransactionOpen = false;
      const deletionBoundary = await deletionBoundaryOutcome;
      if (deletionBoundary.error) throw deletionBoundary.error;
      assert.equal(
        deletionBoundary.value.rows[0].authorized,
        false,
        "a committed deletion must revoke the provider boundary",
      );
    } finally {
      if (deletionTransactionOpen) await authorityWriter.query("ROLLBACK");
      if (deletionBoundaryOutcome) await deletionBoundaryOutcome;
    }
    await asOwner(
      admin,
      `INSERT INTO public."user" (id, email, role, status, banned)
       VALUES ('admin-1', 'admin@example.invalid', 'admin', 'active', false)`,
    );
    await asOwner(
      admin,
      `INSERT INTO public.email_outbox (
         id, operation_id, user_id, delivery_scope_key, to_email, template,
         template_version, variables, idempotency_key
       ) VALUES (
         $1, $2, 'admin-1', 'a:admin-1', 'admin@example.invalid',
         'backup-status', '1',
         pg_catalog.jsonb_build_object('name','Administrator','summary',$3::text),
         'backup-status:v1:' || $4::text
       )`,
      [outboxId, queued.rows[0].operation_id, fixedSummary.success, runKey],
    );
    assert.equal(
      (await worker.query(
        "SELECT public.backup_status_mail_authorized($1) authorized",
        [outboxId],
      )).rows[0].authorized,
      false,
      "same-ID recreation plus exact outbox restoration must stay revoked",
    );
    await expectCode(
      () => reporter.query(
        "SELECT * FROM public.enqueue_backup_status_mail_authority($1, $2)",
        [runKey, "success"],
      ),
      "23514",
      "same-ID recreation must not make exact replay authoritative",
    );
    runKey = "20260101T000004Z";
    queued = await reporter.query(
      "SELECT * FROM public.enqueue_backup_status_mail_authority($1, $2)",
      [runKey, "success"],
    );
    outboxId = queued.rows[0].outbox_id;
    assert.equal(
      (await worker.query(
        "SELECT public.backup_status_mail_authorized($1) authorized",
        [outboxId],
      )).rows[0].authorized,
      true,
      "a new run must bind to the recreated administrator generation",
    );
    await asOwner(
      admin,
      `UPDATE public."user"
          SET email = 'admin-2@example.invalid'
        WHERE id = 'admin-2'`,
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
        "UPDATE public.email_outbox SET variables = jsonb_build_object('name','Administrator','summary',$2::text) WHERE id = $1",
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
    runKey = "20260101T000005Z";
    queued = await reporter.query(
      "SELECT * FROM public.enqueue_backup_status_mail_authority($1, $2)",
      [runKey, "success"],
    );
    outboxId = queued.rows[0].outbox_id;
    assert.equal(
      (await worker.query(
        "SELECT public.backup_status_mail_authorized($1) authorized",
        [outboxId],
      )).rows[0].authorized,
      true,
      "the exact pre-deletion operation must begin authorized",
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
    const durableSource = await admin.query(
      `SELECT pg_catalog.row_to_json(source)::text AS source_json
         FROM public.backup_status_mail_authority AS source
        WHERE source.outbox_id = $1`,
      [outboxId],
    );
    assert.equal(durableSource.rowCount, 1);
    assert.doesNotMatch(
      durableSource.rows[0].source_json,
      /admin-1|@/u,
      "the immutable ledger must remain free of user identifiers after deletion",
    );
    await asOwner(
      admin,
      `INSERT INTO public."user" (id, email, role, status, banned)
       VALUES ('admin-1', 'admin@example.invalid', 'admin', 'active', false)`,
    );
    assert.equal(
      (await worker.query(
        "SELECT public.backup_status_mail_authorized($1) authorized",
        [outboxId],
      )).rows[0].authorized,
      false,
      "same-ID/email/admin recreation must never resurrect an old operation",
    );
    await expectCode(
      () => reporter.query(
        "SELECT * FROM public.enqueue_backup_status_mail_authority($1, $2)",
        [runKey, "success"],
      ),
      "23514",
      "same-ID recreation must not make exact replay authoritative",
    );
    const postRecreation = await reporter.query(
      "SELECT * FROM public.enqueue_backup_status_mail_authority($1, $2)",
      ["20260101T000006Z", "failure"],
    );
    assert.equal(postRecreation.rows[0].acknowledgement, "queued");
    assert.equal(
      (await worker.query(
        "SELECT public.backup_status_mail_authorized($1) authorized",
        [postRecreation.rows[0].outbox_id],
      )).rows[0].authorized,
      true,
      "a new operation may bind to the new administrator generation",
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
           jsonb_build_object('name','Administrator','summary',$1::text),
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
            SET outcome = 'failure'
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

    const reporterPid = (
      await reporter.query("SELECT pg_backend_pid() pid")
    ).rows[0].pid;
    const setAdmin2RoleWithCanonicalLock = async (role) => {
      await authorityWriter.query("BEGIN");
      try {
        await authorityWriter.query("SET LOCAL ROLE learncoding_owner");
        await authorityWriter.query(
          `SELECT pg_catalog.pg_advisory_xact_lock(
             pg_catalog.hashtext(
               'user-authority:admin-2'
             )::pg_catalog.int8
           )`,
        );
        const changed = await authorityWriter.query(
          `UPDATE public."user"
              SET role = $1
            WHERE id = 'admin-2'`,
          [role],
        );
        assert.equal(changed.rowCount, 1);
        await authorityWriter.query("COMMIT");
      } catch (error) {
        await authorityWriter.query("ROLLBACK");
        throw error;
      }
    };

    const enqueueFirstRunKey = "20260101T000007Z";
    let enqueueFirstReporterOpen = false;
    let enqueueFirstWriterOpen = false;
    let enqueueFirstPromotionOutcome;
    let enqueueFirst;
    const enqueueFirstGuardBefore = (
      await admin.query(
        `SELECT authority_epoch
           FROM public.backup_status_mail_admin_guard
          WHERE singleton IS TRUE`,
      )
    ).rows[0].authority_epoch;
    try {
      await reporter.query("BEGIN");
      enqueueFirstReporterOpen = true;
      enqueueFirst = await reporter.query(
        "SELECT * FROM public.enqueue_backup_status_mail_authority($1, $2)",
        [enqueueFirstRunKey, "success"],
      );

      await authorityWriter.query("BEGIN");
      enqueueFirstWriterOpen = true;
      await authorityWriter.query("SET LOCAL ROLE learncoding_owner");
      await authorityWriter.query("SET LOCAL statement_timeout = '5s'");
      await authorityWriter.query(
        `SELECT pg_catalog.pg_advisory_xact_lock(
           pg_catalog.hashtext(
             'user-authority:admin-2'
           )::pg_catalog.int8
         )`,
      );
      enqueueFirstPromotionOutcome = authorityWriter.query(
        `UPDATE public."user"
            SET role = 'admin'
          WHERE id = 'admin-2'`,
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );

      let promotionWaitObserved = false;
      let lastPromotionActivity;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const promotionActivity = await observer.query(
          `SELECT state, wait_event_type, wait_event, query, usename,
                  application_name,
                  pg_catalog.pg_blocking_pids(pid) blocker_pids
             FROM pg_catalog.pg_stat_activity
            WHERE pid = $1`,
          [authorityWriterPid],
        );
        lastPromotionActivity = promotionActivity.rows[0];
        if (
          Array.isArray(lastPromotionActivity?.blocker_pids)
          && lastPromotionActivity.blocker_pids.length > 0
          && lastPromotionActivity.wait_event_type === "Lock"
          && lastPromotionActivity.wait_event === "transactionid"
        ) {
          promotionWaitObserved = true;
          break;
        }
        await delay(25);
      }
      assert.equal(
        promotionWaitObserved,
        true,
        `different-user A2/U2 promotion must wait on enqueue-held G: ${JSON.stringify(lastPromotionActivity)}`,
      );
      assert.deepEqual(
        lastPromotionActivity.blocker_pids.map(Number),
        [Number(reporterPid)],
      );
      assert.equal(
        lastPromotionActivity.application_name,
        "codestead-backup-status-0065-authority-writer",
      );
      assert.equal(lastPromotionActivity.usename, "postgres");
      assert.equal(lastPromotionActivity.wait_event_type, "Lock");
      assert.equal(lastPromotionActivity.wait_event, "transactionid");
      assert.match(lastPromotionActivity.query, /UPDATE public\."user"/u);

      await reporter.query("COMMIT");
      enqueueFirstReporterOpen = false;
      const promotion = await enqueueFirstPromotionOutcome;
      if (promotion.error) throw promotion.error;
      assert.equal(promotion.value.rowCount, 1);
      await authorityWriter.query("COMMIT");
      enqueueFirstWriterOpen = false;
    } finally {
      if (enqueueFirstReporterOpen) await reporter.query("ROLLBACK");
      if (enqueueFirstPromotionOutcome) await enqueueFirstPromotionOutcome;
      if (enqueueFirstWriterOpen) await authorityWriter.query("ROLLBACK");
    }
    const enqueueFirstGuardAfter = (
      await admin.query(
        `SELECT authority_epoch
           FROM public.backup_status_mail_admin_guard
          WHERE singleton IS TRUE`,
      )
    ).rows[0].authority_epoch;
    assert.notEqual(enqueueFirstGuardAfter, enqueueFirstGuardBefore);
    assert.equal(
      (await worker.query(
        "SELECT public.backup_status_mail_authorized($1) authorized",
        [enqueueFirst.rows[0].outbox_id],
      )).rows[0].authorized,
      false,
      "post-commit different-user promotion must revoke the enqueued source",
    );
    await setAdmin2RoleWithCanonicalLock("learner");

    const rotationFirstRunKey = "20260101T000008Z";
    let rotationFirstWriterOpen = false;
    let rotationFirstEnqueueOutcome;
    const rotationFirstGuardBefore = (
      await admin.query(
        `SELECT authority_epoch
           FROM public.backup_status_mail_admin_guard
          WHERE singleton IS TRUE`,
      )
    ).rows[0].authority_epoch;
    try {
      await authorityWriter.query("BEGIN");
      rotationFirstWriterOpen = true;
      await authorityWriter.query("SET LOCAL ROLE learncoding_owner");
      await authorityWriter.query(
        `SELECT pg_catalog.pg_advisory_xact_lock(
           pg_catalog.hashtext(
             'user-authority:admin-2'
           )::pg_catalog.int8
         )`,
      );
      const promoted = await authorityWriter.query(
        `UPDATE public."user"
            SET role = 'admin'
          WHERE id = 'admin-2'`,
      );
      assert.equal(promoted.rowCount, 1);

      rotationFirstEnqueueOutcome = reporter.query(
        "SELECT * FROM public.enqueue_backup_status_mail_authority($1, $2)",
        [rotationFirstRunKey, "failure"],
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );

      let enqueueWaitObserved = false;
      let lastEnqueueActivity;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const enqueueActivity = await observer.query(
          `SELECT state, wait_event_type, wait_event, query, usename,
                  application_name,
                  pg_catalog.pg_blocking_pids(pid) blocker_pids
             FROM pg_catalog.pg_stat_activity
            WHERE pid = $1`,
          [reporterPid],
        );
        lastEnqueueActivity = enqueueActivity.rows[0];
        if (
          Array.isArray(lastEnqueueActivity?.blocker_pids)
          && lastEnqueueActivity.blocker_pids.length > 0
          && lastEnqueueActivity.wait_event_type === "Lock"
          && lastEnqueueActivity.wait_event === "transactionid"
        ) {
          enqueueWaitObserved = true;
          break;
        }
        await delay(25);
      }
      assert.equal(
        enqueueWaitObserved,
        true,
        `rotation-first enqueue must wait on the writer-held G: ${JSON.stringify(lastEnqueueActivity)}`,
      );
      assert.deepEqual(
        lastEnqueueActivity.blocker_pids.map(Number),
        [Number(authorityWriterPid)],
      );
      assert.equal(
        lastEnqueueActivity.application_name,
        "codestead-backup-status-0065-reporter",
      );
      assert.equal(
        lastEnqueueActivity.usename,
        "learncoding_backup_reporter",
      );
      assert.equal(lastEnqueueActivity.wait_event_type, "Lock");
      assert.equal(lastEnqueueActivity.wait_event, "transactionid");
      assert.match(
        lastEnqueueActivity.query,
        /enqueue_backup_status_mail_authority/iu,
      );

      await authorityWriter.query("COMMIT");
      rotationFirstWriterOpen = false;
      const enqueue = await rotationFirstEnqueueOutcome;
      assert.equal(enqueue.value, undefined);
      assert.equal(enqueue.error?.code, "23514");
      assert.notEqual(enqueue.error?.code, "40P01");
    } finally {
      if (rotationFirstWriterOpen) await authorityWriter.query("ROLLBACK");
      if (rotationFirstEnqueueOutcome) await rotationFirstEnqueueOutcome;
    }
    const rotationFirstGuardAfter = (
      await admin.query(
        `SELECT authority_epoch
           FROM public.backup_status_mail_admin_guard
          WHERE singleton IS TRUE`,
      )
    ).rows[0].authority_epoch;
    assert.notEqual(rotationFirstGuardAfter, rotationFirstGuardBefore);
    const rolledBackRotation = await admin.query(
      `SELECT
         (
           SELECT pg_catalog.count(*)
             FROM public.backup_status_mail_authority
            WHERE run_key = $1
         ) source_count,
         (
           SELECT pg_catalog.count(*)
             FROM public.email_outbox
            WHERE idempotency_key = 'backup-status:v1:' || $1
         ) outbox_count`,
      [rotationFirstRunKey],
    );
    assert.deepEqual(rolledBackRotation.rows, [{
      source_count: "0",
      outbox_count: "0",
    }]);
    await setAdmin2RoleWithCanonicalLock("learner");

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
    process.stdout.write(
      "backup_status_mail_authority_0065=narrow_admin_lock:pass\n",
    );
    process.stdout.write(
      "backup_status_mail_authority_0065=both_order_admin_lock:pass\n",
    );
    process.stdout.write(
      "backup_status_mail_authority_0065=deletion_boundary_sql_lock_orders:pass\n",
    );
    process.stdout.write(
      "backup_status_mail_authority_0065=different_user_guard_orders:pass\n",
    );
    process.stdout.write(
      "backup_status_mail_authority_0065=epoch_incarnation_and_catalog_tamper:pass\n",
    );
  } catch (error) {
    primaryError = error;
  } finally {
    const clientCleanup = await Promise.allSettled(
      [authorityWriter, app, worker, reporter, observer, admin, bootstrap]
        .filter(Boolean)
        .map((client) => client.end()),
    );
    for (const result of clientCleanup) {
      if (result.status === "rejected") cleanupErrors.push(result.reason);
    }
    if (serverStartAttempted && existsSync(postmasterPid)) {
      try {
        run(
          executable("pg_ctl"),
          [
            "--pgdata",
            dataDirectory,
            "--wait",
            "--timeout=30",
            "--mode=immediate",
            "stop",
          ],
          { timeoutMs: 35_000 },
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (temporaryRoot !== undefined) {
      try {
        rmSync(temporaryRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (cleanupErrors.length > 0) {
    if (primaryError instanceof Error) {
      primaryError.cause ??= new AggregateError(
        cleanupErrors,
        "PostgreSQL 0065 integration cleanup failed",
      );
    } else {
      primaryError = new AggregateError(
        cleanupErrors,
        "PostgreSQL 0065 integration cleanup failed",
      );
    }
  }
  if (primaryError) throw primaryError;
}

await main();
