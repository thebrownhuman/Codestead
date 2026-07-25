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

import { Client } from "pg";

import { verifyPostMigrationReviewedContractsBeforeReconciliation } from "../../scripts/bootstrap-database-roles.mjs";
import { allocateDisposableLoopbackPort } from "../../scripts/lib/disposable-loopback-port.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");
const migrationDirectory = path.join(repositoryRoot, "drizzle");
const selectedPostgresRuntime = [
  ["17", process.env.POSTGRES_17_BIN],
  ["18", process.env.POSTGRES_18_BIN],
].filter(([, binaryDirectory]) => binaryDirectory !== undefined);
const executableSuffix = process.platform === "win32" ? ".exe" : "";

assert.equal(
  selectedPostgresRuntime.length,
  1,
  "exactly one of POSTGRES_17_BIN or POSTGRES_18_BIN must select the native gate",
);
const [postgresMajor, postgresBin] = selectedPostgresRuntime[0];
assert.match(postgresMajor, /^(?:17|18)$/u);
// The CI PGDG repository intentionally floats within major 18. The live
// server check binds the selected major. This is not byte-pinned evidence.
assert.ok(
  postgresBin,
  "the selected PostgreSQL binary directory must be non-empty",
);
const escapedPostgresMajor = postgresMajor.replace(
  /[.*+?^${}()|[\]\\]/gu,
  "\\$&",
);

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
      `${path.basename(command)} failed with status ${result.status}\n` +
        `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
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
    ],
    { input: sql, allowFailure: options.allowFailure },
  );
}

function scalar(port, database, sql, username = "postgres") {
  return psql(port, database, sql, {
    username,
    scalar: true,
  }).stdout.trim();
}

function assertMigrationLineage() {
  const journal = JSON.parse(
    readFileSync(
      path.join(migrationDirectory, "meta", "_journal.json"),
      "utf8",
    ),
  );
  const names = readdirSync(migrationDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .filter((name) => Number.parseInt(name.slice(0, 4), 10) <= 64)
    .sort();
  assert.equal(names.length, 65);
  assert.equal(journal.entries.length >= 65, true);
  names.forEach((name, index) => {
    const tag = name.slice(0, -4);
    assert.equal(Number.parseInt(name.slice(0, 4), 10), index);
    assert.deepEqual(
      {
        idx: journal.entries[index]?.idx,
        version: journal.entries[index]?.version,
        tag: journal.entries[index]?.tag,
        breakpoints: journal.entries[index]?.breakpoints,
      },
      { idx: index, version: "7", tag, breakpoints: true },
    );
  });
  assert.equal(
    journal.entries[63].tag,
    "0063_mail_outbox_redaction_fence_release",
  );
  assert.equal(journal.entries[64].tag, "0064_mail_outbox_dispatch_binding");
}

function stagedMigrationsThrough(temporaryRoot, maximumIndex) {
  assert.ok(
    Number.isInteger(maximumIndex) && maximumIndex >= 0 && maximumIndex <= 63,
  );
  const suffix = String(maximumIndex).padStart(4, "0");
  const staged = path.join(temporaryRoot, `migrations-through-${suffix}`);
  const meta = path.join(staged, "meta");
  mkdirSync(meta, { recursive: true });
  for (const name of readdirSync(migrationDirectory)) {
    if (
      /^\d{4}_.+\.sql$/u.test(name) &&
      Number.parseInt(name.slice(0, 4), 10) <= maximumIndex
    ) {
      cpSync(path.join(migrationDirectory, name), path.join(staged, name));
    }
  }
  const journal = JSON.parse(
    readFileSync(
      path.join(migrationDirectory, "meta", "_journal.json"),
      "utf8",
    ),
  );
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

function ownerSql(port, database, sql) {
  return psql(port, database, `SET ROLE learncoding_owner;\n${sql}`, {
    username: "learncoding_migrator",
  });
}

async function verifyRawReviewedPhase(connectionString) {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
  });
  await client.connect();
  try {
    assert.equal(
      await verifyPostMigrationReviewedContractsBeforeReconciliation(client),
      1,
    );
  } finally {
    await client.end();
  }
}

async function proveRawPhaseTamperDetection(port, database, connectionString) {
  ownerSql(
    port,
    database,
    `
GRANT EXECUTE ON FUNCTION
  public.classify_email_outbox_retention_redaction(
    public.email_outbox,
    timestamp with time zone
  ) TO learncoding_app;`,
  );
  try {
    await assert.rejects(
      verifyRawReviewedPhase(connectionString),
      /database role boundary verification failed/u,
    );
  } finally {
    ownerSql(
      port,
      database,
      `
REVOKE EXECUTE ON FUNCTION
  public.classify_email_outbox_retention_redaction(
    public.email_outbox,
    timestamp with time zone
  ) FROM learncoding_app;`,
    );
  }
  await verifyRawReviewedPhase(connectionString);

  psql(
    port,
    database,
    `
ALTER ROLE learncoding_app INHERIT;
GRANT learncoding_owner TO learncoding_app
  WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;`,
  );
  try {
    assert.equal(
      scalar(
        port,
        database,
        `SELECT pg_catalog.has_function_privilege(
           'learncoding_app',
           'public.classify_email_outbox_retention_redaction(public.email_outbox,timestamp with time zone)',
           'EXECUTE'
         );`,
      ),
      "t",
      "inherited owner membership did not create the intended EXECUTE drift",
    );
    await assert.rejects(
      verifyRawReviewedPhase(connectionString),
      /database role boundary verification failed/u,
    );
  } finally {
    psql(
      port,
      database,
      `
REVOKE learncoding_owner FROM learncoding_app;
ALTER ROLE learncoding_app NOINHERIT;`,
    );
  }
  await verifyRawReviewedPhase(connectionString);
}

function expectSqlState(
  port,
  database,
  username,
  sql,
  expectedSqlState,
  prefix = "",
) {
  psql(
    port,
    database,
    `${prefix}
DO $proof$
BEGIN
  BEGIN
    ${sql};
    RAISE EXCEPTION 'expected protected statement to fail';
  EXCEPTION
    WHEN SQLSTATE '${expectedSqlState}' THEN NULL;
  END;
END
$proof$;`,
    { username },
  );
}

function systemFixture(id, operationId, suffix) {
  return `
INSERT INTO public.email_outbox (
  id, operation_id, user_id, delivery_scope_key, to_email, template,
  template_version, variables, idempotency_key, status, next_attempt_at,
  created_at, updated_at
) VALUES (
  '${id}'::uuid,
  '${operationId}'::uuid,
  NULL,
  's:${operationId}',
  'dispatch-${suffix}@example.invalid',
  'access-request-admin',
  '1',
  pg_catalog.jsonb_build_object(
    '_mailOperationId', '${operationId}',
    '_mailRecipient', 'dispatch-${suffix}@example.invalid',
    '_mailProducer', 'access-request-admin',
    '_mailSourceId', '64200000-0000-4000-8000-${suffix.padStart(12, "0")}'
  ),
  'dispatch-binding-${suffix}',
  'pending',
  pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp()
);`;
}

function claimFixture(id, claimToken) {
  return `
UPDATE public.email_outbox
   SET status = 'sending',
       attempt_count = 1,
       claim_token = '${claimToken}'::uuid,
       claim_owner = 'mail-dispatch-0064',
       claim_version = 1,
       lease_expires_at = pg_catalog.statement_timestamp() + interval '120 seconds',
       last_error_code = NULL,
       updated_at = pg_catalog.statement_timestamp()
 WHERE id = '${id}'::uuid;`;
}

function insertAndClaim(port, database, fixture) {
  ownerSql(
    port,
    database,
    `${systemFixture(fixture.id, fixture.operationId, fixture.suffix)}
${claimFixture(fixture.id, fixture.claimToken)}`,
  );
}

function armSql(fixture, adapter, version, digest, options = {}) {
  const leaseSeconds = options.leaseSeconds ?? 30;
  const extraAssignments = options.extraAssignments ?? [];
  assert.ok(Number.isInteger(leaseSeconds));
  assert.ok(Array.isArray(extraAssignments));
  const extraSql =
    extraAssignments.length > 0
      ? `${extraAssignments.join(",\n       ")},\n       `
      : "";
  return `
UPDATE public.email_outbox
   SET ${extraSql}provider_call_started = pg_catalog.statement_timestamp(),
       adapter = '${adapter}',
       dispatch_binding_version = ${version === null ? "NULL" : `'${version}'`},
       dispatch_binding_sha256 = ${digest === null ? "NULL" : `'${digest}'`},
       lease_expires_at =
         pg_catalog.statement_timestamp() + interval '${leaseSeconds} seconds',
       updated_at = pg_catalog.statement_timestamp()
 WHERE id = '${fixture.id}'::uuid`;
}

function catalogDigest(port, database) {
  return scalar(
    port,
    database,
    `SELECT pg_catalog.md5(
       pg_catalog.pg_get_functiondef(
         'public.enforce_email_outbox_dispatch_binding()'::pg_catalog.regprocedure
       ) || E'\\n' ||
       pg_catalog.pg_get_triggerdef(trigger.oid, true) || E'\\n' ||
       pg_catalog.pg_get_constraintdef(constraint_row.oid, true) || E'\\n' ||
       pg_catalog.pg_get_userbyid(routine.proowner) || ':' ||
       routine.prosecdef::text || ':' ||
       coalesce(
         pg_catalog.array_to_string(routine.proconfig, ','),
         ''
       ) || ':' ||
       coalesce(routine.proacl::text, '') || E'\\n' ||
       trigger.tgenabled::text || ':' || trigger.tgtype::text || ':' ||
       coalesce(trigger.tgqual::text, '') || ':' ||
       pg_catalog.encode(trigger.tgargs, 'hex') || ':' ||
       trigger.tgattr::text || ':' || trigger.tgfoid::text || E'\\n' ||
       constraint_row.convalidated::text || E'\\n' ||
       coalesce(pg_catalog.string_agg(
         attribute.attname || ':' ||
         pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) || ':' ||
         attribute.attnotnull::text || ':' ||
         attribute.attgenerated::text || ':' ||
         coalesce(
           pg_catalog.pg_get_expr(
             default_value.adbin,
             default_value.adrelid
           ),
           ''
         ) || ':' || coalesce(attribute.attacl::text, ''),
         '|' ORDER BY attribute.attnum
       ), '')
     )
       FROM pg_catalog.pg_proc routine
       JOIN pg_catalog.pg_trigger trigger
         ON trigger.tgfoid = routine.oid
        AND trigger.tgname = 'email_outbox_dispatch_binding_guard'
       JOIN pg_catalog.pg_constraint constraint_row
         ON constraint_row.conrelid = 'public.email_outbox'::pg_catalog.regclass
        AND constraint_row.conname = 'email_outbox_dispatch_binding_valid'
       JOIN pg_catalog.pg_attribute attribute
         ON attribute.attrelid = 'public.email_outbox'::pg_catalog.regclass
        AND attribute.attname IN (
          'dispatch_binding_version',
          'dispatch_binding_sha256'
        )
       LEFT JOIN pg_catalog.pg_attrdef default_value
         ON default_value.adrelid = attribute.attrelid
        AND default_value.adnum = attribute.attnum
      WHERE routine.oid =
        'public.enforce_email_outbox_dispatch_binding()'::pg_catalog.regprocedure
      GROUP BY routine.oid, routine.proowner, routine.prosecdef,
               routine.proconfig, routine.proacl,
               trigger.oid, trigger.tgenabled, trigger.tgtype,
               trigger.tgqual, trigger.tgargs, trigger.tgattr, trigger.tgfoid,
               constraint_row.oid, constraint_row.convalidated;`,
  );
}

function proveCatalogContract(port, database) {
  psql(
    port,
    database,
    `
DO $proof$
DECLARE
  function_row record;
  trigger_row record;
  constraint_row record;
  function_acl text[];
  column_count integer;
  invalid_column_acl_count integer;
BEGIN
  SELECT proc.proowner,
         pg_catalog.pg_get_userbyid(proc.proowner) AS owner,
         proc.prosecdef,
         proc.proconfig,
         proc.proacl
    INTO STRICT function_row
    FROM pg_catalog.pg_proc proc
   WHERE proc.oid =
     'public.enforce_email_outbox_dispatch_binding()'::pg_catalog.regprocedure;
  SELECT pg_catalog.array_agg(
           (CASE WHEN acl.grantee = 0
             THEN 'PUBLIC'
             ELSE pg_catalog.pg_get_userbyid(acl.grantee)
           END) || '|' || acl.privilege_type || '|' || acl.is_grantable::text
           ORDER BY acl.grantee, acl.privilege_type, acl.is_grantable
         )
    INTO function_acl
    FROM pg_catalog.aclexplode(
      coalesce(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) acl;
  IF function_row.owner <> 'learncoding_owner'
     OR function_row.prosecdef
     OR function_row.proconfig
          IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
     OR function_acl IS DISTINCT FROM
          ARRAY['learncoding_owner|EXECUTE|false']::text[] THEN
    RAISE EXCEPTION 'dispatch binding function catalog contract failed';
  END IF;

  SELECT trigger.tgenabled, trigger.tgtype, trigger.tgqual,
         trigger.tgnargs, trigger.tgargs, trigger.tgattr, trigger.tgfoid,
         pg_catalog.pg_get_triggerdef(trigger.oid, true) AS definition
    INTO STRICT trigger_row
    FROM pg_catalog.pg_trigger trigger
   WHERE trigger.tgrelid = 'public.email_outbox'::pg_catalog.regclass
     AND trigger.tgname = 'email_outbox_dispatch_binding_guard'
     AND NOT trigger.tgisinternal;
  IF trigger_row.tgenabled <> 'O'
     OR trigger_row.tgtype <> 23
     OR trigger_row.tgqual IS NOT NULL
     OR trigger_row.tgnargs <> 0
     OR pg_catalog.octet_length(trigger_row.tgargs) <> 0
     OR trigger_row.tgattr <> ''::pg_catalog.int2vector
     OR trigger_row.tgfoid <>
       'public.enforce_email_outbox_dispatch_binding()'::pg_catalog.regprocedure
     OR position(
       'BEFORE INSERT OR UPDATE' IN trigger_row.definition
     ) = 0
     OR position('UPDATE OF' IN trigger_row.definition) <> 0
     OR position(
       'enforce_email_outbox_dispatch_binding()' IN trigger_row.definition
     ) = 0 THEN
    RAISE EXCEPTION 'dispatch binding trigger catalog contract failed';
  END IF;

  SELECT constraint_data.convalidated,
         pg_catalog.pg_get_constraintdef(constraint_data.oid, true) AS definition
    INTO STRICT constraint_row
    FROM pg_catalog.pg_constraint constraint_data
   WHERE constraint_data.conrelid =
     'public.email_outbox'::pg_catalog.regclass
     AND constraint_data.conname = 'email_outbox_dispatch_binding_valid'
     AND constraint_data.contype = 'c';
  IF NOT constraint_row.convalidated
     OR constraint_row.definition NOT LIKE '%gmail-raw-v1%'
     OR constraint_row.definition NOT LIKE '%console-json-v1%'
     OR constraint_row.definition NOT LIKE '%[0-9a-f]{64}%' THEN
    RAISE EXCEPTION 'dispatch binding check catalog contract failed';
  END IF;

  SELECT pg_catalog.count(*)::integer
    INTO column_count
    FROM pg_catalog.pg_attribute attribute
    LEFT JOIN pg_catalog.pg_attrdef default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
   WHERE attribute.attrelid = 'public.email_outbox'::pg_catalog.regclass
     AND attribute.attname IN (
       'dispatch_binding_version',
       'dispatch_binding_sha256'
     )
     AND attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
     AND NOT attribute.attnotnull
     AND attribute.attgenerated = ''
     AND default_value.oid IS NULL;
  IF column_count <> 2 THEN
    RAISE EXCEPTION 'dispatch binding column catalog contract failed';
  END IF;

  SELECT pg_catalog.count(*)::integer
    INTO invalid_column_acl_count
    FROM pg_catalog.pg_attribute attribute
    LEFT JOIN LATERAL (
      SELECT pg_catalog.array_agg(
               (CASE WHEN acl.grantee = 0
                 THEN 'PUBLIC'
                 ELSE pg_catalog.pg_get_userbyid(acl.grantee)
               END) || '|' || acl.privilege_type || '|' ||
               acl.is_grantable::text
               ORDER BY acl.grantee, acl.privilege_type, acl.is_grantable
             ) entries
        FROM pg_catalog.aclexplode(attribute.attacl) acl
    ) observed_acl ON true
   WHERE attribute.attrelid = 'public.email_outbox'::pg_catalog.regclass
     AND attribute.attname IN (
       'dispatch_binding_version',
       'dispatch_binding_sha256'
     )
     AND observed_acl.entries IS DISTINCT FROM
       ARRAY['learncoding_worker|UPDATE|false']::text[];
  IF invalid_column_acl_count <> 0 THEN
    RAISE EXCEPTION 'dispatch binding direct column ACL contract failed';
  END IF;

  IF NOT pg_catalog.has_column_privilege(
       'learncoding_worker',
       'public.email_outbox',
       'dispatch_binding_version',
       'UPDATE'
     )
     OR NOT pg_catalog.has_column_privilege(
       'learncoding_worker',
       'public.email_outbox',
       'dispatch_binding_sha256',
       'UPDATE'
     )
     OR pg_catalog.has_column_privilege(
       'learncoding_worker',
       'public.email_outbox',
       'dispatch_binding_version',
       'INSERT'
     )
     OR pg_catalog.has_column_privilege(
       'learncoding_worker',
       'public.email_outbox',
       'dispatch_binding_sha256',
       'INSERT'
     )
     OR pg_catalog.has_column_privilege(
       'learncoding_worker',
       'public.email_outbox',
       'dispatch_binding_version',
       'UPDATE WITH GRANT OPTION'
     ) THEN
    RAISE EXCEPTION 'dispatch binding column privilege contract failed';
  END IF;
END
$proof$;`,
  );
}

function restoreTriggerFunctionAcl(port, database) {
  ownerSql(
    port,
    database,
    `
REVOKE ALL ON FUNCTION public.enforce_email_outbox_dispatch_binding()
  FROM PUBLIC, learncoding_app, learncoding_worker, learncoding_migrator,
       learncoding_ops, learncoding_owner;
GRANT EXECUTE ON FUNCTION public.enforce_email_outbox_dispatch_binding()
  TO learncoding_owner;`,
  );
}

function proveCatalogAclTamperDetection(port, database) {
  const expectRejected = (message) => {
    assert.throws(
      () => proveCatalogContract(port, database),
      /psql(?:\.exe)? failed with status/u,
      message,
    );
  };

  ownerSql(
    port,
    database,
    `GRANT EXECUTE ON FUNCTION
       public.enforce_email_outbox_dispatch_binding()
       TO learncoding_app;`,
  );
  try {
    expectRejected("catalog proof accepted an extra routine grantee");
  } finally {
    restoreTriggerFunctionAcl(port, database);
  }

  ownerSql(
    port,
    database,
    `REVOKE ALL ON FUNCTION
       public.enforce_email_outbox_dispatch_binding()
       FROM learncoding_owner;`,
  );
  try {
    expectRejected("catalog proof accepted a missing explicit owner ACL");
  } finally {
    restoreTriggerFunctionAcl(port, database);
  }

  ownerSql(
    port,
    database,
    `GRANT EXECUTE ON FUNCTION
       public.enforce_email_outbox_dispatch_binding()
       TO learncoding_owner WITH GRANT OPTION;`,
  );
  try {
    expectRejected("catalog proof accepted an owner grant option");
  } finally {
    restoreTriggerFunctionAcl(port, database);
  }

  proveCatalogContract(port, database);
}

function restoreBindingColumnAcls(port, database) {
  ownerSql(
    port,
    database,
    `
REVOKE ALL (
  dispatch_binding_version,
  dispatch_binding_sha256
) ON public.email_outbox
  FROM PUBLIC, learncoding_app, learncoding_worker, learncoding_migrator,
       learncoding_ops;
GRANT UPDATE (
  dispatch_binding_version,
  dispatch_binding_sha256
) ON public.email_outbox TO learncoding_worker;`,
  );
}

function proveColumnAclTamperDetection(port, database) {
  const expectRejected = (message) => {
    assert.throws(
      () => proveCatalogContract(port, database),
      /psql(?:\.exe)? failed with status/u,
      message,
    );
  };

  for (const column of [
    "dispatch_binding_version",
    "dispatch_binding_sha256",
  ]) {
    ownerSql(
      port,
      database,
      `GRANT UPDATE (${column}) ON public.email_outbox TO learncoding_app;`,
    );
    try {
      expectRejected(`catalog proof accepted an extra ${column} grantee`);
    } finally {
      restoreBindingColumnAcls(port, database);
    }

    ownerSql(
      port,
      database,
      `REVOKE UPDATE (${column})
         ON public.email_outbox FROM learncoding_worker;`,
    );
    try {
      expectRejected(`catalog proof accepted missing ${column} worker ACL`);
    } finally {
      restoreBindingColumnAcls(port, database);
    }

    ownerSql(
      port,
      database,
      `GRANT UPDATE (${column})
         ON public.email_outbox
         TO learncoding_worker WITH GRANT OPTION;`,
    );
    try {
      expectRejected(`catalog proof accepted ${column} grant option`);
    } finally {
      restoreBindingColumnAcls(port, database);
    }
  }

  proveCatalogContract(port, database);
}

function proveTransitionMatrix(port, database) {
  const gmail = {
    id: "64000000-0000-4000-8000-000000000010",
    operationId: "64100000-0000-4000-8000-000000000010",
    claimToken: "64300000-0000-4000-8000-000000000010",
    suffix: "10",
  };
  const consoleFixture = {
    id: "64000000-0000-4000-8000-000000000011",
    operationId: "64100000-0000-4000-8000-000000000011",
    claimToken: "64300000-0000-4000-8000-000000000011",
    suffix: "11",
  };
  const malformed = {
    id: "64000000-0000-4000-8000-000000000012",
    operationId: "64100000-0000-4000-8000-000000000012",
    claimToken: "64300000-0000-4000-8000-000000000012",
    suffix: "12",
  };
  const ownerAttempt = {
    id: "64000000-0000-4000-8000-000000000013",
    operationId: "64100000-0000-4000-8000-000000000013",
    claimToken: "64300000-0000-4000-8000-000000000013",
    suffix: "13",
  };
  const impersonated = {
    id: "64000000-0000-4000-8000-000000000014",
    operationId: "64100000-0000-4000-8000-000000000014",
    claimToken: "64300000-0000-4000-8000-000000000014",
    suffix: "14",
  };
  const opsAttempt = {
    id: "64000000-0000-4000-8000-000000000015",
    operationId: "64100000-0000-4000-8000-000000000015",
    claimToken: "64300000-0000-4000-8000-000000000015",
    suffix: "15",
  };

  for (const fixture of [
    gmail,
    consoleFixture,
    malformed,
    ownerAttempt,
    impersonated,
    opsAttempt,
  ]) {
    insertAndClaim(port, database, fixture);
  }

  psql(
    port,
    database,
    `${armSql(gmail, "gmail", "gmail-raw-v1", "a".repeat(64))};`,
    { username: "learncoding_worker" },
  );
  psql(
    port,
    database,
    `${armSql(consoleFixture, "console", "console-json-v1", "b".repeat(64))};`,
    { username: "learncoding_worker" },
  );

  expectSqlState(
    port,
    database,
    "learncoding_worker",
    armSql(malformed, "gmail", null, null),
    "23514",
  );
  expectSqlState(
    port,
    database,
    "learncoding_migrator",
    armSql(ownerAttempt, "gmail", "gmail-raw-v1", "c".repeat(64)),
    "42501",
    "SET ROLE learncoding_owner;",
  );
  expectSqlState(
    port,
    database,
    "postgres",
    armSql(impersonated, "gmail", "gmail-raw-v1", "d".repeat(64)),
    "42501",
    "SET ROLE learncoding_worker;",
  );

  ownerSql(
    port,
    database,
    `GRANT UPDATE (
       provider_call_started, adapter, dispatch_binding_version,
       dispatch_binding_sha256, lease_expires_at, updated_at
     ) ON public.email_outbox TO learncoding_ops;`,
  );
  expectSqlState(
    port,
    database,
    "learncoding_ops",
    armSql(opsAttempt, "gmail", "gmail-raw-v1", "e".repeat(64)),
    "42501",
  );
  ownerSql(
    port,
    database,
    `REVOKE UPDATE (
       provider_call_started, adapter, dispatch_binding_version,
       dispatch_binding_sha256, lease_expires_at, updated_at
     ) ON public.email_outbox FROM learncoding_ops;`,
  );

  expectSqlState(
    port,
    database,
    "learncoding_worker",
    `UPDATE public.email_outbox
        SET dispatch_binding_sha256 = '${"f".repeat(64)}'
      WHERE id = '${gmail.id}'::uuid`,
    "23514",
  );
  psql(
    port,
    database,
    `UPDATE public.email_outbox
        SET status = 'sent',
            provider_message_id = 'gmail-dispatch-binding-0064',
            sent_at = pg_catalog.statement_timestamp(),
            claim_token = NULL,
            claim_owner = NULL,
            lease_expires_at = NULL,
            updated_at = pg_catalog.statement_timestamp()
      WHERE id = '${gmail.id}'::uuid;`,
    { username: "learncoding_worker" },
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT status::text || '|' || adapter || '|' ||
              dispatch_binding_version || '|' ||
              dispatch_binding_sha256 || '|' || provider_message_id
         FROM public.email_outbox
        WHERE id = '${gmail.id}'::uuid;`,
    ),
    `sent|gmail|gmail-raw-v1|${"a".repeat(64)}|gmail-dispatch-binding-0064`,
  );

  expectSqlState(
    port,
    database,
    "learncoding_worker",
    `UPDATE public.email_outbox
        SET dispatch_binding_version = 'gmail-raw-v1',
            dispatch_binding_sha256 = '${"a".repeat(64)}'
      WHERE id = '64000000-0000-4000-8000-000000000001'::uuid`,
    "23514",
  );
  psql(
    port,
    database,
    `UPDATE public.email_outbox
        SET status = 'sent',
            provider_message_id = 'gmail-legacy-reconciled-0064',
            sent_at = pg_catalog.statement_timestamp(),
            quarantined_at = NULL,
            last_error_code = NULL,
            updated_at = pg_catalog.statement_timestamp()
      WHERE id = '64000000-0000-4000-8000-000000000001'::uuid;`,
    { username: "learncoding_worker" },
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT status::text || '|' || provider_message_id || '|' ||
              (dispatch_binding_version IS NULL)::text || '|' ||
              (dispatch_binding_sha256 IS NULL)::text
         FROM public.email_outbox
        WHERE id = '64000000-0000-4000-8000-000000000001'::uuid;`,
    ),
    "sent|gmail-legacy-reconciled-0064|true|true",
  );

  expectSqlState(
    port,
    database,
    "learncoding_migrator",
    `INSERT INTO public.email_outbox (
       operation_id, user_id, delivery_scope_key, to_email, template,
       template_version, variables, idempotency_key, status,
       provider_call_started, adapter, dispatch_binding_version,
       dispatch_binding_sha256, quarantined_at, last_error_code
     ) VALUES (
       '64100000-0000-4000-8000-000000000099'::uuid,
       NULL,
       'o:64100000-0000-4000-8000-000000000099',
       'invalid-insert@example.invalid',
       'weekly-summary',
       '1',
       '{}'::jsonb,
       'dispatch-binding-invalid-insert',
       'quarantined',
       pg_catalog.statement_timestamp(),
       'gmail',
       'gmail-raw-v1',
       '${"a".repeat(64)}',
       pg_catalog.statement_timestamp(),
       'GMAIL_RESULT_UNKNOWN'
     )`,
    "23514",
    "SET ROLE learncoding_owner;",
  );
}

function extendedFixture(number) {
  const suffix = String(number);
  const tail = suffix.padStart(12, "0");
  return {
    id: `64000000-0000-4000-8000-${tail}`,
    operationId: `64100000-0000-4000-8000-${tail}`,
    claimToken: `64300000-0000-4000-8000-${tail}`,
    suffix,
  };
}

function expectUnbound(port, database, fixture, message) {
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
         provider_call_started IS NULL
         AND adapter IS NULL
         AND dispatch_binding_version IS NULL
         AND dispatch_binding_sha256 IS NULL
       )::text
         FROM public.email_outbox
        WHERE id = '${fixture.id}'::uuid;`,
    ),
    "true",
    message,
  );
}

async function proveExtendedTransitionMatrix(port, database) {
  const invalidCases = [
    {
      fixture: extendedFixture(110),
      adapter: "gmail",
      version: "gmail-raw-v1",
      digest: null,
      message: "half-null digest",
    },
    {
      fixture: extendedFixture(111),
      adapter: "gmail",
      version: null,
      digest: "a".repeat(64),
      message: "half-null version",
    },
    {
      fixture: extendedFixture(112),
      adapter: "gmail",
      version: "gmail-raw-v1",
      digest: "A".repeat(64),
      message: "uppercase digest",
    },
    {
      fixture: extendedFixture(113),
      adapter: "gmail",
      version: "gmail-raw-v1",
      digest: "g".repeat(64),
      message: "non-hex digest",
    },
    {
      fixture: extendedFixture(114),
      adapter: "gmail",
      version: "gmail-raw-v1",
      digest: "a".repeat(63),
      message: "short digest",
    },
    {
      fixture: extendedFixture(115),
      adapter: "gmail",
      version: "gmail-raw-v1",
      digest: "a".repeat(65),
      message: "long digest",
    },
    {
      fixture: extendedFixture(116),
      adapter: "gmail",
      version: "console-json-v1",
      digest: "a".repeat(64),
      message: "Gmail/version mismatch",
    },
    {
      fixture: extendedFixture(117),
      adapter: "console",
      version: "gmail-raw-v1",
      digest: "a".repeat(64),
      message: "console/version mismatch",
    },
    {
      fixture: extendedFixture(118),
      adapter: "smtp",
      version: "gmail-raw-v1",
      digest: "a".repeat(64),
      message: "unknown adapter",
    },
    {
      fixture: extendedFixture(119),
      adapter: "gmail",
      version: "gmail-raw-v1",
      digest: "a".repeat(64),
      options: { leaseSeconds: 14 },
      message: "short provider lease",
    },
    {
      fixture: extendedFixture(120),
      adapter: "gmail",
      version: "gmail-raw-v1",
      digest: "a".repeat(64),
      options: { leaseSeconds: 301 },
      message: "long provider lease",
    },
    {
      fixture: extendedFixture(121),
      adapter: "gmail",
      version: "gmail-raw-v1",
      digest: "a".repeat(64),
      options: {
        extraAssignments: [
          "claim_token = '64300000-0000-4000-8000-000000009999'::uuid",
        ],
      },
      message: "claim mutation",
    },
    {
      fixture: extendedFixture(122),
      adapter: "gmail",
      version: "gmail-raw-v1",
      digest: "a".repeat(64),
      options: { extraAssignments: ["status = 'failed'"] },
      message: "status mutation",
    },
    {
      fixture: extendedFixture(123),
      adapter: "gmail",
      version: "gmail-raw-v1",
      digest: "a".repeat(64),
      options: { extraAssignments: ["attempt_count = attempt_count + 1"] },
      message: "attempt mutation",
    },
  ];
  const payloadMutation = extendedFixture(124);
  const prebinding = extendedFixture(125);
  const providerMessageMutation = extendedFixture(126);
  const rollbackFixture = extendedFixture(127);
  const raceFixture = extendedFixture(128);
  const redactionFixture = extendedFixture(129);
  const allFixtures = [
    ...invalidCases.map(({ fixture }) => fixture),
    payloadMutation,
    prebinding,
    providerMessageMutation,
    rollbackFixture,
    raceFixture,
    redactionFixture,
  ];
  for (const fixture of allFixtures) insertAndClaim(port, database, fixture);

  for (const testCase of invalidCases) {
    expectSqlState(
      port,
      database,
      "learncoding_worker",
      armSql(
        testCase.fixture,
        testCase.adapter,
        testCase.version,
        testCase.digest,
        testCase.options,
      ),
      "23514",
    );
    expectUnbound(
      port,
      database,
      testCase.fixture,
      `${testCase.message} changed the row`,
    );
  }

  ownerSql(
    port,
    database,
    "GRANT UPDATE (to_email) ON public.email_outbox TO learncoding_worker;",
  );
  try {
    expectSqlState(
      port,
      database,
      "learncoding_worker",
      armSql(payloadMutation, "gmail", "gmail-raw-v1", "a".repeat(64), {
        extraAssignments: ["to_email = 'mutated-payload@example.invalid'"],
      }),
      "23514",
    );
  } finally {
    ownerSql(
      port,
      database,
      "REVOKE UPDATE (to_email) ON public.email_outbox FROM learncoding_worker;",
    );
  }
  expectUnbound(
    port,
    database,
    payloadMutation,
    "payload mutation armed a row",
  );

  expectSqlState(
    port,
    database,
    "learncoding_worker",
    `UPDATE public.email_outbox
        SET dispatch_binding_version = 'gmail-raw-v1',
            dispatch_binding_sha256 = '${"a".repeat(64)}'
      WHERE id = '${prebinding.id}'::uuid`,
    "23514",
  );
  expectUnbound(port, database, prebinding, "prebinding changed a row");

  expectSqlState(
    port,
    database,
    "learncoding_worker",
    armSql(providerMessageMutation, "gmail", "gmail-raw-v1", "a".repeat(64), {
      extraAssignments: ["provider_message_id = 'premature-provider-id'"],
    }),
    "23514",
  );
  expectUnbound(
    port,
    database,
    providerMessageMutation,
    "provider identity mutation armed a row",
  );

  expectSqlState(
    port,
    database,
    "learncoding_worker",
    `UPDATE public.email_outbox
        SET to_email = 'forbidden-payload@example.invalid'
      WHERE id = '${prebinding.id}'::uuid`,
    "42501",
  );
  expectSqlState(
    port,
    database,
    "learncoding_worker",
    `DELETE FROM public.email_outbox
      WHERE id = '${prebinding.id}'::uuid`,
    "42501",
  );
  expectSqlState(
    port,
    database,
    "learncoding_worker",
    `INSERT INTO public.email_outbox (
       operation_id, user_id, delivery_scope_key, to_email, template,
       template_version, variables, idempotency_key,
       dispatch_binding_version, dispatch_binding_sha256
     ) VALUES (
       '64100000-0000-4000-8000-000000000198'::uuid,
       NULL,
       's:64100000-0000-4000-8000-000000000198',
       'insert-binding@example.invalid',
       'access-request-admin',
       '1',
       pg_catalog.jsonb_build_object(
         '_mailOperationId', '64100000-0000-4000-8000-000000000198',
         '_mailRecipient', 'insert-binding@example.invalid',
         '_mailProducer', 'access-request-admin',
         '_mailSourceId', '64200000-0000-4000-8000-000000000198'
       ),
       'dispatch-binding-worker-insert',
       NULL,
       NULL
     )`,
    "42501",
  );

  const { Client } = await import("pg");
  const clientOptions = {
    host: "127.0.0.1",
    port,
    database,
    user: "learncoding_worker",
  };
  const rollbackClient = new Client(clientOptions);
  await rollbackClient.connect();
  try {
    await rollbackClient.query("BEGIN");
    await rollbackClient.query(
      `${armSql(
        rollbackFixture,
        "gmail",
        "gmail-raw-v1",
        "c".repeat(64),
      )} RETURNING id`,
    );
    await rollbackClient.query("ROLLBACK");
  } finally {
    await rollbackClient.end();
  }
  expectUnbound(
    port,
    database,
    rollbackFixture,
    "rolled-back arm persisted authority",
  );
  psql(
    port,
    database,
    `${armSql(rollbackFixture, "gmail", "gmail-raw-v1", "c".repeat(64))};`,
    { username: "learncoding_worker" },
  );

  const first = new Client(clientOptions);
  const second = new Client(clientOptions);
  await Promise.all([first.connect(), second.connect()]);
  try {
    const competingSql = `${armSql(
      raceFixture,
      "gmail",
      "gmail-raw-v1",
      "d".repeat(64),
    )}
       AND provider_call_started IS NULL
       AND adapter IS NULL
       AND dispatch_binding_version IS NULL
       AND dispatch_binding_sha256 IS NULL
       RETURNING id`;
    const results = await Promise.all([
      first.query(competingSql),
      second.query(competingSql),
    ]);
    assert.deepEqual(
      results.map(({ rowCount }) => rowCount).sort(),
      [0, 1],
      "competing worker arms did not resolve to exactly one winner",
    );
  } finally {
    await Promise.all([first.end(), second.end()]);
  }

  psql(
    port,
    database,
    `${armSql(redactionFixture, "gmail", "gmail-raw-v1", "e".repeat(64))};`,
    { username: "learncoding_worker" },
  );
  psql(
    port,
    database,
    `UPDATE public.email_outbox
        SET status = 'quarantined',
            claim_token = NULL,
            claim_owner = NULL,
            lease_expires_at = NULL,
            quarantined_at =
              pg_catalog.statement_timestamp() - interval '31 days',
            last_error_code = 'GMAIL_RESULT_UNKNOWN',
            updated_at =
              pg_catalog.statement_timestamp() - interval '31 days'
      WHERE id = '${redactionFixture.id}'::uuid;`,
    { username: "learncoding_worker" },
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT disposition || '|' || eligible::text || '|' ||
              transitioned::text
         FROM public.redact_unresolved_email_outbox_authority(
           pg_catalog.statement_timestamp() - interval '30 days',
           1000
         )
        WHERE disposition = 'eligible';`,
      "learncoding_ops",
    ),
    "eligible|1|1",
    "0063 redaction summary did not transition the released bound fixture",
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT to_email || '|' || dispatch_binding_version || '|' ||
              dispatch_binding_sha256
         FROM public.email_outbox
        WHERE id = '${redactionFixture.id}'::uuid;`,
    ),
    `redacted+${redactionFixture.id}@invalid.local|gmail-raw-v1|${"e".repeat(64)}`,
    "0063 redaction changed or lost the dispatch binding",
  );
}

async function main() {
  assertMigrationLineage();
  const version = run(executable("postgres"), ["--version"]).stdout.trim();
  assert.match(
    version,
    new RegExp(`PostgreSQL\\) ${escapedPostgresMajor}\\.`, "u"),
  );

  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), `codestead-mail-0064-pg${postgresMajor}-`),
  );
  const dataDirectory = path.join(temporaryRoot, "data");
  const logFile = path.join(temporaryRoot, "postgres.log");
  const database = "mail_dispatch_binding_0064";
  const stagedMigrations0062 = stagedMigrationsThrough(temporaryRoot, 62);
  const stagedMigrations0063 = stagedMigrationsThrough(temporaryRoot, 63);
  const port = await allocateDisposableLoopbackPort();
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
    const controlData = run(executable("pg_controldata"), [
      dataDirectory,
    ]).stdout;
    const controlIdentifier = controlData.match(
      /^Database system identifier:\s*([0-9]+)\s*$/mu,
    )?.[1];
    assert.match(controlIdentifier ?? "", /^[0-9]+$/u);
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
    const runningServerVersion = scalar(
      port,
      "postgres",
      "SELECT pg_catalog.current_setting('server_version_num');",
    );
    assert.match(
      runningServerVersion,
      new RegExp(`^${escapedPostgresMajor}[0-9]{4}$`, "u"),
      `the running disposable server must be PostgreSQL major ${postgresMajor}`,
    );
    assert.equal(
      path.resolve(
        scalar(
          port,
          "postgres",
          "SELECT pg_catalog.current_setting('data_directory');",
        ),
      ),
      path.resolve(dataDirectory),
      "temporary PostgreSQL identity mismatch before DDL",
    );
    assert.equal(
      scalar(
        port,
        "postgres",
        "SELECT system_identifier::text FROM pg_catalog.pg_control_system();",
      ),
      controlIdentifier,
      "temporary PostgreSQL system identifier mismatch before DDL",
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
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;`,
    );
    run(executable("createdb"), [
      "--host=127.0.0.1",
      `--port=${port}`,
      "--username=postgres",
      "--owner=learncoding_owner",
      database,
    ]);

    const { runProductionMigration } =
      await import("../../scripts/migrate-production.mjs");
    const connectionString = `postgresql://learncoding_migrator@127.0.0.1:${port}/${database}`;
    const adminConnectionString = `postgresql://postgres@127.0.0.1:${port}/${database}`;
    await runProductionMigration({
      connectionString,
      migrationsFolder: stagedMigrations0062,
    });
    assert.equal(
      scalar(
        port,
        database,
        "SELECT pg_catalog.count(*)::text FROM drizzle.__drizzle_migrations;",
      ),
      "63",
    );
    await verifyRawReviewedPhase(adminConnectionString);

    await runProductionMigration({
      connectionString,
      migrationsFolder: stagedMigrations0063,
    });
    assert.equal(
      scalar(
        port,
        database,
        "SELECT pg_catalog.count(*)::text FROM drizzle.__drizzle_migrations;",
      ),
      "64",
    );
    await verifyRawReviewedPhase(adminConnectionString);
    await proveRawPhaseTamperDetection(port, database, adminConnectionString);

    ownerSql(
      port,
      database,
      `
INSERT INTO public.email_outbox (
  id, operation_id, user_id, delivery_scope_key, to_email, template,
  template_version, variables, idempotency_key, status,
  provider_call_started, adapter, quarantined_at, last_error_code,
  created_at, updated_at
) VALUES (
  '64000000-0000-4000-8000-000000000001'::uuid,
  '64100000-0000-4000-8000-000000000001'::uuid,
  NULL,
  'o:64100000-0000-4000-8000-000000000001',
  'legacy-secret@example.invalid',
  'weekly-summary',
  '1',
  '{}'::jsonb,
  'dispatch-binding-legacy-1',
  'quarantined',
  pg_catalog.statement_timestamp(),
  'gmail',
  pg_catalog.statement_timestamp(),
  'GMAIL_RESULT_UNKNOWN',
  pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp()
);
INSERT INTO public.email_outbox (
  id, operation_id, user_id, delivery_scope_key, to_email, template,
  template_version, variables, idempotency_key, status, adapter,
  created_at, updated_at
) VALUES (
  '64000000-0000-4000-8000-000000000002'::uuid,
  '64100000-0000-4000-8000-000000000002'::uuid,
  NULL,
  'o:64100000-0000-4000-8000-000000000002',
  'malformed@example.invalid',
  'weekly-summary',
  '1',
  '{}'::jsonb,
  'dispatch-binding-malformed-2',
  'failed',
  'gmail',
  pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp()
);`,
    );

    const tableNodeBefore = scalar(
      port,
      database,
      "SELECT pg_catalog.pg_relation_filenode('public.email_outbox'::pg_catalog.regclass)::text;",
    );
    const legacyBefore = scalar(
      port,
      database,
      `SELECT ctid::text || '|' || pg_catalog.md5(pg_catalog.to_jsonb(outbox)::text)
         FROM public.email_outbox outbox
        WHERE id = '64000000-0000-4000-8000-000000000001'::uuid;`,
    );
    const failedMigration = await runProductionMigration({
      connectionString,
      migrationsFolder: migrationDirectory,
    }).then(
      () => null,
      (error) => error,
    );
    assert.ok(failedMigration instanceof Error);
    assert.equal(
      scalar(
        port,
        database,
        `SELECT pg_catalog.count(*)::text
           FROM pg_catalog.pg_attribute
          WHERE attrelid = 'public.email_outbox'::pg_catalog.regclass
            AND attname IN (
              'dispatch_binding_version',
              'dispatch_binding_sha256'
            )
            AND NOT attisdropped;`,
      ),
      "0",
      "failed 0064 migration leaked columns",
    );
    assert.equal(
      scalar(
        port,
        database,
        `SELECT (
           pg_catalog.to_regprocedure(
             'public.enforce_email_outbox_dispatch_binding()'
           ) IS NULL
         )::text || '|' ||
         (pg_catalog.count(*) FILTER (
           WHERE conname = 'email_outbox_dispatch_binding_valid'
         ))::text
           FROM pg_catalog.pg_constraint;`,
      ),
      "true|0",
      "failed 0064 migration leaked privileged objects",
    );
    assert.equal(
      scalar(
        port,
        database,
        "SELECT pg_catalog.count(*)::text FROM drizzle.__drizzle_migrations;",
      ),
      "64",
      "failed 0064 migration advanced the framework journal",
    );
    ownerSql(
      port,
      database,
      `DELETE FROM public.email_outbox
        WHERE id = '64000000-0000-4000-8000-000000000002'::uuid;`,
    );

    await runProductionMigration({
      connectionString,
      migrationsFolder: migrationDirectory,
    });
    await verifyRawReviewedPhase(adminConnectionString);
    assert.equal(
      scalar(
        port,
        database,
        "SELECT pg_catalog.count(*)::text FROM drizzle.__drizzle_migrations;",
      ),
      "65",
    );
    assert.equal(
      scalar(
        port,
        database,
        "SELECT pg_catalog.pg_relation_filenode('public.email_outbox'::pg_catalog.regclass)::text;",
      ),
      tableNodeBefore,
      "0064 rewrote the email_outbox heap",
    );
    assert.equal(
      scalar(
        port,
        database,
        `SELECT ctid::text || '|' ||
                pg_catalog.md5((
                  pg_catalog.to_jsonb(outbox)
                  - 'dispatch_binding_version'
                  - 'dispatch_binding_sha256'
                )::text) || '|' ||
                (dispatch_binding_version IS NULL)::text || '|' ||
                (dispatch_binding_sha256 IS NULL)::text
           FROM public.email_outbox outbox
          WHERE id = '64000000-0000-4000-8000-000000000001'::uuid;`,
      ),
      `${legacyBefore}|true|true`,
      "0064 changed or backfilled the legacy provider-started row",
    );

    proveCatalogContract(port, database);
    proveCatalogAclTamperDetection(port, database);
    proveColumnAclTamperDetection(port, database);
    proveTransitionMatrix(port, database);
    await proveExtendedTransitionMatrix(port, database);
    const digestBeforeReplay = catalogDigest(port, database);
    const rowsBeforeReplay = scalar(
      port,
      database,
      `SELECT pg_catalog.md5(pg_catalog.string_agg(
         id::text || ':' || pg_catalog.md5(pg_catalog.to_jsonb(outbox)::text),
         '|' ORDER BY id
       ))
         FROM public.email_outbox outbox;`,
    );
    await runProductionMigration({
      connectionString,
      migrationsFolder: migrationDirectory,
    });
    assert.equal(catalogDigest(port, database), digestBeforeReplay);
    assert.equal(
      scalar(
        port,
        database,
        `SELECT pg_catalog.md5(pg_catalog.string_agg(
           id::text || ':' || pg_catalog.md5(pg_catalog.to_jsonb(outbox)::text),
           '|' ORDER BY id
         ))
           FROM public.email_outbox outbox;`,
      ),
      rowsBeforeReplay,
    );
    assert.equal(
      scalar(
        port,
        database,
        "SELECT pg_catalog.count(*)::text FROM drizzle.__drizzle_migrations;",
      ),
      "65",
    );

    process.stdout.write(
      "mail_dispatch_binding_0064=migration_rollback:pass\n",
    );
    process.stdout.write(
      "mail_dispatch_binding_0064=legacy_grandfather:pass\n",
    );
    process.stdout.write("mail_dispatch_binding_0064=transition_matrix:pass\n");
    process.stdout.write("mail_dispatch_binding_0064=catalog_contract:pass\n");
    process.stdout.write(
      "mail_dispatch_binding_0064=privilege_contract:pass\n",
    );
    process.stdout.write("mail_dispatch_binding_0064=migration_replay:pass\n");
    process.stdout.write(
      "mail_dispatch_binding_0064=raw_phase_contracts:pass\n",
    );
    process.stdout.write(
      "mail_dispatch_binding_0064=raw_phase_tamper_detection:pass\n",
    );
    process.stdout.write(
      `mail_dispatch_binding_0064=postgres:${postgresMajor}:${version}:pass\n`,
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
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
