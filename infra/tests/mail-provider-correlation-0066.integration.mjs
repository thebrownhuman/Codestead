#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
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

import { allocateDisposableLoopbackPort } from
  "../../scripts/lib/disposable-loopback-port.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");
const migrationDirectory = path.join(repositoryRoot, "drizzle");
const migration0066 = readFileSync(
  path.join(
    migrationDirectory,
    "0066_mail_outbox_provider_correlation_evidence.sql",
  ),
  "utf8",
);
const selectedRuntime = [
  ["17", process.env.POSTGRES_17_BIN],
  ["18", process.env.POSTGRES_18_BIN],
].filter(([, binaryDirectory]) => binaryDirectory !== undefined);
const executableSuffix = process.platform === "win32" ? ".exe" : "";

assert.equal(
  selectedRuntime.length,
  1,
  "exactly one of POSTGRES_17_BIN or POSTGRES_18_BIN must select the gate",
);
const [postgresMajor, postgresBin] = selectedRuntime[0];
assert.match(postgresMajor, /^(?:17|18)$/u);
assert.ok(postgresBin);

function executable(name) {
  return path.join(postgresBin, `${name}${executableSuffix}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      PGCONNECT_TIMEOUT: "5",
    },
    input: options.input,
    maxBuffer: 4 * 1024 * 1024,
    stdio: options.stdio,
    timeout: options.timeoutMs ?? 30_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(
      `${path.basename(command)} failed with status ${result.status}\n`
      + `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    );
  }
  return result;
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
      ...(options.singleTransaction ? ["--single-transaction"] : []),
    ],
    {
      input: sql,
      allowFailure: options.allowFailure,
      timeoutMs: options.timeoutMs,
    },
  );
}

function scalar(port, database, sql, username = "postgres") {
  return psql(port, database, sql, {
    username,
    scalar: true,
  }).stdout.trim();
}

function stagedMigrationsThrough(temporaryRoot, maximumIndex) {
  const staged = path.join(
    temporaryRoot,
    `migrations-through-${String(maximumIndex).padStart(4, "0")}`,
  );
  const meta = path.join(staged, "meta");
  mkdirSync(meta, { recursive: true });
  for (const name of readdirSync(migrationDirectory)) {
    if (
      /^\d{4}_.+\.sql$/u.test(name)
      && Number.parseInt(name.slice(0, 4), 10) <= maximumIndex
    ) {
      cpSync(path.join(migrationDirectory, name), path.join(staged, name));
    }
  }
  const journal = JSON.parse(readFileSync(
    path.join(migrationDirectory, "meta", "_journal.json"),
    "utf8",
  ));
  journal.entries = journal.entries.filter(
    (entry) => entry.idx <= maximumIndex,
  );
  writeFileSync(
    path.join(meta, "_journal.json"),
    `${JSON.stringify(journal, null, 2)}\n`,
    "utf8",
  );
  return staged;
}

function apply0066(port, database) {
  psql(
    port,
    database,
    `SET ROLE learncoding_owner;\n${migration0066}`,
    {
      username: "learncoding_migrator",
      singleTransaction: true,
      timeoutMs: 60_000,
    },
  );
}

function routineContract(port, database) {
  return scalar(
    port,
    database,
    `
      SELECT pg_catalog.current_setting('server_version_num') || '|' ||
             pg_catalog.pg_get_userbyid(routine.proowner) || '|' ||
             routine.prosecdef::text || '|' ||
             COALESCE(
               pg_catalog.array_to_string(routine.proconfig, ','),
               ''
             ) || '|' ||
             pg_catalog.encode(
               pg_catalog.sha256(
                 pg_catalog.convert_to(routine.prosrc, 'UTF8')
               ),
               'hex'
             ) || '|' ||
             pg_catalog.encode(
               pg_catalog.sha256(
                 pg_catalog.convert_to(
                   pg_catalog.pg_get_functiondef(routine.oid),
                   'UTF8'
                 )
               ),
               'hex'
             )
        FROM pg_catalog.pg_proc routine
       WHERE routine.oid =
         'public.enforce_email_outbox_provider_correlation_evidence()'
           ::pg_catalog.regprocedure;
    `,
  );
}

function functionAcl(port, database) {
  return scalar(
    port,
    database,
    `
      SELECT pg_catalog.string_agg(
               CASE WHEN acl.grantee = 0
                 THEN 'PUBLIC'
                 ELSE pg_catalog.pg_get_userbyid(acl.grantee)
               END || ':' || acl.privilege_type || ':' ||
               acl.is_grantable::text,
               ',' ORDER BY acl.grantee, acl.privilege_type
             )
        FROM pg_catalog.pg_proc routine
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            routine.proacl,
            pg_catalog.acldefault('f', routine.proowner)
          )
        ) acl
       WHERE routine.oid =
         'public.enforce_email_outbox_provider_correlation_evidence()'
           ::pg_catalog.regprocedure;
    `,
  );
}

function columnAcl(port, database) {
  return scalar(
    port,
    database,
    `
      SELECT pg_catalog.string_agg(
               attribute.attname || ':' ||
               CASE WHEN acl.grantee = 0
                 THEN 'PUBLIC'
                 ELSE pg_catalog.pg_get_userbyid(acl.grantee)
               END || ':' || acl.privilege_type || ':' ||
               acl.is_grantable::text,
               ',' ORDER BY attribute.attname, acl.grantee,
                 acl.privilege_type
             )
        FROM pg_catalog.pg_attribute attribute
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          attribute.attacl
        ) acl
       WHERE attribute.attrelid =
         'public.email_outbox'::pg_catalog.regclass
         AND attribute.attname = ANY (ARRAY[
           'provider_correlation_version',
           'provider_evidence_version',
           'provider_evidence_sha256'
         ]::pg_catalog.name[]);
    `,
  );
}

function proveCatalog(port, database) {
  const routine = routineContract(port, database);
  assert.match(
    routine,
    new RegExp(
      `^${postgresMajor}[0-9]{4}\\|learncoding_owner\\|false\\|`
      + "search_path=pg_catalog\\|[0-9a-f]{64}\\|[0-9a-f]{64}$",
      "u",
    ),
  );
  assert.equal(
    functionAcl(port, database),
    "learncoding_owner:EXECUTE:false",
  );
  assert.equal(
    columnAcl(port, database),
    [
      "provider_correlation_version:learncoding_worker:UPDATE:false",
      "provider_evidence_sha256:learncoding_worker:UPDATE:false",
      "provider_evidence_version:learncoding_worker:UPDATE:false",
    ].join(","),
  );
  assert.equal(
    scalar(
      port,
      database,
      `
        SELECT trigger.tgname || '|' ||
               trigger.tgenabled::text || '|' ||
               trigger.tgtype::text || '|' || routine.proname
          FROM pg_catalog.pg_trigger trigger
          JOIN pg_catalog.pg_proc routine
            ON routine.oid = trigger.tgfoid
         WHERE trigger.tgrelid =
           'public.email_outbox'::pg_catalog.regclass
           AND trigger.tgname =
             'email_outbox_provider_correlation_evidence_guard'
           AND NOT trigger.tgisinternal;
      `,
    ),
    "email_outbox_provider_correlation_evidence_guard|O|23|"
      + "enforce_email_outbox_provider_correlation_evidence",
  );
  assert.equal(
    scalar(
      port,
      database,
      `
        SELECT constraint_data.convalidated::text || '|' ||
               pg_catalog.array_to_string(
                 ARRAY(
                   SELECT attribute.attname
                     FROM pg_catalog.unnest(
                       constraint_data.conkey
                     ) WITH ORDINALITY key(attnum, position)
                     JOIN pg_catalog.pg_attribute attribute
                       ON attribute.attrelid =
                            constraint_data.conrelid
                      AND attribute.attnum = key.attnum
                    ORDER BY key.position
                 ),
                 ','
               )
          FROM pg_catalog.pg_constraint constraint_data
         WHERE constraint_data.conrelid =
           'public.email_outbox'::pg_catalog.regclass
           AND constraint_data.conname =
             'email_outbox_provider_correlation_evidence_valid';
      `,
    ),
    "true|provider_call_started,adapter,provider_message_id,last_error_code,"
      + "dispatch_binding_version,"
      + "dispatch_binding_sha256,provider_correlation_version,"
      + "provider_evidence_version,provider_evidence_sha256,status,"
      + "claim_version,claim_token,claim_owner,lease_expires_at,sent_at,"
      + "quarantined_at",
  );
  return routine;
}

async function main() {
  const version = run(executable("postgres"), ["--version"]).stdout.trim();
  assert.match(
    version,
    new RegExp(`PostgreSQL\\) ${postgresMajor}\\.`, "u"),
  );
  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), `codestead-mail-0066-pg${postgresMajor}-`),
  );
  const dataDirectory = path.join(temporaryRoot, "data");
  const logFile = path.join(temporaryRoot, "postgres.log");
  const baselineMigrations = stagedMigrationsThrough(temporaryRoot, 64);
  const port = await allocateDisposableLoopbackPort();
  let startAttempted = false;
  let operationError;
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
    assert.match(
      scalar(
        port,
        "postgres",
        "SELECT pg_catalog.current_setting('server_version_num');",
      ),
      new RegExp(`^${postgresMajor}[0-9]{4}$`, "u"),
    );
    psql(
      port,
      "postgres",
      `
        CREATE ROLE learncoding_owner NOLOGIN NOINHERIT;
        CREATE ROLE learncoding_migrator LOGIN NOINHERIT;
        CREATE ROLE learncoding_app LOGIN NOINHERIT;
        CREATE ROLE learncoding_worker LOGIN NOINHERIT;
        CREATE ROLE learncoding_ops LOGIN NOINHERIT;
        GRANT learncoding_owner TO learncoding_migrator
          WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
      `,
    );
    run(executable("createdb"), [
      "--host=127.0.0.1",
      `--port=${port}`,
      "--username=postgres",
      "--owner=learncoding_owner",
      "mail0066_template",
    ]);
    const { runProductionMigration } =
      await import("../../scripts/migrate-production.mjs");
    await runProductionMigration({
      connectionString:
        `postgresql://learncoding_migrator@127.0.0.1:${port}/mail0066_template`,
      migrationsFolder: baselineMigrations,
    });
    for (const database of ["mail0066_absent", "mail0066_present"]) {
      run(executable("createdb"), [
        "--host=127.0.0.1",
        `--port=${port}`,
        "--username=postgres",
        "--owner=learncoding_owner",
        "--template=mail0066_template",
        database,
      ]);
    }

    assert.equal(
      scalar(
        port,
        "mail0066_absent",
        "SELECT (pg_catalog.to_regrole('learncoding_backup_reporter') IS NULL)::text;",
      ),
      "true",
      "the absent-role scenario must apply 0066 before the optional backup role exists",
    );
    apply0066(port, "mail0066_absent");
    psql(
      port,
      "mail0066_present",
      `
        CREATE ROLE learncoding_backup_reporter NOLOGIN NOINHERIT;
        CREATE ROLE mail_default_grantee NOLOGIN NOINHERIT;
        ALTER DEFAULT PRIVILEGES FOR ROLE learncoding_owner
          IN SCHEMA public
          GRANT EXECUTE ON FUNCTIONS
          TO learncoding_backup_reporter, mail_default_grantee;
        SET ROLE learncoding_owner;
        CREATE FUNCTION public.default_acl_sentinel_0066()
        RETURNS integer
        LANGUAGE sql
        AS 'SELECT 1';
        RESET ROLE;
      `,
    );
    const sentinelAcl = scalar(
      port,
      "mail0066_present",
      `
        SELECT pg_catalog.string_agg(
                 CASE WHEN acl.grantee = 0
                   THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                 END,
                 ',' ORDER BY acl.grantee
               )
          FROM pg_catalog.pg_proc routine
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(
              routine.proacl,
              pg_catalog.acldefault('f', routine.proowner)
            )
          ) acl
         WHERE routine.oid =
           'public.default_acl_sentinel_0066()'::pg_catalog.regprocedure;
      `,
    );
    assert.match(sentinelAcl, /learncoding_backup_reporter/u);
    assert.match(sentinelAcl, /mail_default_grantee/u);
    apply0066(port, "mail0066_present");

    const absentContract = proveCatalog(port, "mail0066_absent");
    const presentContract = proveCatalog(port, "mail0066_present");
    assert.equal(absentContract, presentContract);
    process.stdout.write(
      `mail_provider_correlation_0066=postgres:${postgresMajor}:catalog:pass\n`,
    );
    process.stdout.write(
      `mail_provider_correlation_0066=routine:${absentContract}\n`,
    );
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let cleanupError;
    if (startAttempted) {
      const stopped = run(
        executable("pg_ctl"),
        ["-D", dataDirectory, "stop", "-m", "immediate", "-w"],
        {
          allowFailure: true,
          stdio: "ignore",
          timeoutMs: 30_000,
        },
      );
      if (stopped.status !== 0) {
        cleanupError = new Error(
          `temporary PostgreSQL shutdown failed\n${
            readFileSync(logFile, "utf8")
          }`,
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
    `${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
