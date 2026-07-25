#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { allocateDisposableLoopbackPort } from "../../scripts/lib/disposable-loopback-port.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");
const migrationDirectory = path.join(repositoryRoot, "drizzle");
const migration0068 = path.join(
  migrationDirectory,
  "0068_mail_outbox_quarantine_redaction_authority_v2.sql",
);
const predecessor0063 =
  process.env.MAIL_0068_PREDECESSOR_0063_SQL?.trim()
  || path.join(
    migrationDirectory,
    "0063_mail_outbox_redaction_fence_release.sql",
  );
const predecessor0065 =
  process.env.MAIL_0068_PREDECESSOR_0065_SQL?.trim()
  || path.join(migrationDirectory, "0065_backup_status_mail_authority.sql");
const predecessor0066 =
  process.env.MAIL_0068_PREDECESSOR_0066_SQL?.trim()
  || path.join(
    migrationDirectory,
    "0066_mail_outbox_provider_correlation_evidence.sql",
  );
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
assert.ok(postgresBin, "the selected PostgreSQL binary directory is empty");
for (const [label, candidate] of [
  ["0063 predecessor", predecessor0063],
  ["0065 predecessor", predecessor0065],
  ["0066 predecessor", predecessor0066],
  ["0068 component", migration0068],
]) {
  assert.ok(existsSync(candidate), `${label} SQL is missing: ${candidate}`);
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

const reviewedPrefixSql = reviewedSqlThrough0064();
const predecessorInputManifest = Object.freeze({
  through0064: {
    migration_count: 65,
    sha256: sha256Hex(reviewedPrefixSql),
    terminal_tag: "0064_mail_outbox_dispatch_binding",
  },
  migration0063: {
    path: predecessor0063,
    tag: path.basename(predecessor0063, ".sql"),
    sha256: sha256Hex(readFileSync(predecessor0063)),
  },
  migration0065: {
    path: predecessor0065,
    tag: path.basename(predecessor0065, ".sql"),
    sha256: sha256Hex(readFileSync(predecessor0065)),
  },
  migration0066: {
    path: predecessor0066,
    tag: path.basename(predecessor0066, ".sql"),
    sha256: sha256Hex(readFileSync(predecessor0066)),
  },
});
assert.deepEqual(
  {
    through0064: predecessorInputManifest.through0064.sha256,
    migration0063: predecessorInputManifest.migration0063.sha256,
    migration0065: predecessorInputManifest.migration0065.sha256,
    migration0066: predecessorInputManifest.migration0066.sha256,
  },
  {
    through0064:
      "698bc8bed81c6e3d4d96946813585dd66942794778de185e697df0590aca7fbb",
    migration0063:
      "e945482f1311c88ee41bb13b12a566aab31a0e1aadd2a1d9ce98ac12acd5c63c",
    migration0065:
      "1274dda8013fe80f09df63f7ddc73b24b0a9a482a40e5f5042eaef2373c14b3c",
    migration0066:
      "3d4962ed82c0209245ca7e0a0e9ea667001eab7ae864f89120894cc1fa915ec9",
  },
  "0068 predecessor SQL identities are not the reviewed provisional chain",
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
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.stdio,
    timeout: options.timeoutMs ?? 60_000,
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

function reviewedSqlThrough0064() {
  const names = readdirSync(migrationDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .filter((name) => Number.parseInt(name.slice(0, 4), 10) <= 64)
    .sort();
  assert.equal(names.length, 65);
  names.forEach((name, expectedIndex) => {
    assert.equal(Number.parseInt(name.slice(0, 4), 10), expectedIndex);
  });
  return names
    .map((name) =>
      readFileSync(
        name.startsWith("0063_")
          ? predecessor0063
          : path.join(migrationDirectory, name),
        "utf8",
      ))
    .join("\n");
}

function applyAsOwner(port, database, sql) {
  psql(
    port,
    database,
    `BEGIN;\nSET ROLE learncoding_owner;\n${sql}\nRESET ROLE;\nCOMMIT;`,
  );
}

async function expectSqlState(port, database, username, sql, expectedCode) {
  const client = new Client({
    host: "127.0.0.1",
    port,
    database,
    user: username,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    await assert.rejects(
      client.query(sql),
      (error) => error?.code === expectedCode,
      `${username} did not fail with SQLSTATE ${expectedCode}`,
    );
  } finally {
    await client.end();
  }
}

function catalogContract(port, database) {
  return scalar(
    port,
    database,
    `
SELECT (
  (
    SELECT pg_catalog.pg_get_userbyid(routine.proowner) =
             'learncoding_owner'
       AND routine.prosecdef
       AND routine.provolatile = 's'
       AND routine.proconfig IS NOT DISTINCT FROM
             ARRAY['search_path=pg_catalog']::text[]
       AND (
         SELECT pg_catalog.array_agg(
                  pg_catalog.pg_get_userbyid(acl.grantor) || '|' ||
                  (
                    CASE WHEN acl.grantee = 0
                      THEN 'PUBLIC'
                      ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                    END
                  ) || '|' || acl.privilege_type || '|' ||
                  acl.is_grantable::text
                  ORDER BY
                    pg_catalog.pg_get_userbyid(acl.grantor),
                    CASE WHEN acl.grantee = 0
                      THEN 'PUBLIC'
                      ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                    END,
                    acl.privilege_type
                )
           FROM pg_catalog.aclexplode(
             COALESCE(
               routine.proacl,
               pg_catalog.acldefault('f', routine.proowner)
             )
           ) AS acl
       ) IS NOT DISTINCT FROM
             ARRAY['learncoding_owner|learncoding_owner|EXECUTE|false']::text[]
      FROM pg_catalog.pg_proc AS routine
     WHERE routine.oid = pg_catalog.to_regprocedure(
       'public.classify_email_outbox_quarantine_redaction_v2(public.email_outbox,timestamp with time zone)'
     )
  )
  AND (
    SELECT pg_catalog.pg_get_userbyid(routine.proowner) =
             'learncoding_owner'
       AND routine.prosecdef
       AND routine.provolatile = 'v'
       AND routine.proconfig IS NOT DISTINCT FROM
             ARRAY['search_path=pg_catalog']::text[]
       AND (
         SELECT pg_catalog.array_agg(
                  pg_catalog.pg_get_userbyid(acl.grantor) || '|' ||
                  (
                    CASE WHEN acl.grantee = 0
                      THEN 'PUBLIC'
                      ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                    END
                  ) || '|' || acl.privilege_type || '|' ||
                  acl.is_grantable::text
                  ORDER BY
                    pg_catalog.pg_get_userbyid(acl.grantor),
                    CASE WHEN acl.grantee = 0
                      THEN 'PUBLIC'
                      ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                    END,
                    acl.privilege_type
                )
           FROM pg_catalog.aclexplode(
             COALESCE(
               routine.proacl,
               pg_catalog.acldefault('f', routine.proowner)
             )
           ) AS acl
       ) IS NOT DISTINCT FROM ARRAY[
         'learncoding_owner|learncoding_ops|EXECUTE|false',
         'learncoding_owner|learncoding_owner|EXECUTE|false'
       ]::text[]
      FROM pg_catalog.pg_proc AS routine
     WHERE routine.oid = pg_catalog.to_regprocedure(
       'public.redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)'
     )
  )
  AND (
    SELECT pg_catalog.pg_get_userbyid(routine.proowner) =
             'learncoding_owner'
       AND NOT routine.prosecdef
       AND routine.provolatile = 'v'
       AND routine.proconfig IS NOT DISTINCT FROM
             ARRAY['search_path=pg_catalog']::text[]
       AND (
         SELECT pg_catalog.array_agg(
                  pg_catalog.pg_get_userbyid(acl.grantor) || '|' ||
                  (
                    CASE WHEN acl.grantee = 0
                      THEN 'PUBLIC'
                      ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                    END
                  ) || '|' || acl.privilege_type || '|' ||
                  acl.is_grantable::text
                  ORDER BY
                    pg_catalog.pg_get_userbyid(acl.grantor),
                    CASE WHEN acl.grantee = 0
                      THEN 'PUBLIC'
                      ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                    END,
                    acl.privilege_type
                )
           FROM pg_catalog.aclexplode(
             COALESCE(
               routine.proacl,
               pg_catalog.acldefault('f', routine.proowner)
             )
           ) AS acl
       ) IS NOT DISTINCT FROM
             ARRAY['learncoding_owner|learncoding_owner|EXECUTE|false']::text[]
      FROM pg_catalog.pg_proc AS routine
     WHERE routine.oid = pg_catalog.to_regprocedure(
       'public.enforce_email_outbox_payload_immutable()'
     )
  )
  AND pg_catalog.to_regprocedure(
        'public.redact_unresolved_email_outbox_authority(timestamp with time zone,integer)'
      ) IS NULL
  AND pg_catalog.to_regprocedure(
        'public.classify_email_outbox_retention_redaction(public.email_outbox,timestamp with time zone)'
      ) IS NULL
  AND EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_record
     WHERE trigger_record.tgrelid =
             'public.email_outbox'::pg_catalog.regclass
       AND trigger_record.tgname = 'email_outbox_payload_immutable'
       AND NOT trigger_record.tgisinternal
       AND trigger_record.tgenabled = 'O'
       AND trigger_record.tgfoid = pg_catalog.to_regprocedure(
             'public.enforce_email_outbox_payload_immutable()'
           )
  )
)::text;`,
  );
}

function predecessorConstraintManifest(port, database) {
  return JSON.parse(
    scalar(
      port,
      database,
      `
SELECT pg_catalog.jsonb_build_object(
         'server_version_num',
           pg_catalog.current_setting('server_version_num'),
         'expression',
           pg_catalog.pg_get_expr(
             constraint_record.conbin,
             constraint_record.conrelid,
             false
           ),
         'expression_sha256',
           pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(
                 pg_catalog.pg_get_expr(
                   constraint_record.conbin,
                   constraint_record.conrelid,
                   false
                 ),
                 'UTF8'
               )
             ),
             'hex'
           ),
         'definition',
           pg_catalog.pg_get_constraintdef(constraint_record.oid, false),
         'definition_sha256',
           pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(
                 pg_catalog.pg_get_constraintdef(
                   constraint_record.oid,
                   false
                 ),
                 'UTF8'
               )
             ),
             'hex'
           ),
         'validated', constraint_record.convalidated,
         'enforced',
           COALESCE(
             (
               pg_catalog.to_jsonb(constraint_record)
               ->> 'conenforced'
             )::boolean,
             true
           )
       )::text
  FROM pg_catalog.pg_constraint AS constraint_record
 WHERE constraint_record.conrelid =
         'public.email_outbox'::pg_catalog.regclass
   AND constraint_record.conname =
         'email_outbox_provider_correlation_evidence_valid';`,
    ),
  );
}

function phase68NewArtifactState(port, database) {
  return scalar(
    port,
    database,
    `
SELECT (
  pg_catalog.to_regprocedure(
    'public.classify_email_outbox_quarantine_redaction_v2(public.email_outbox,timestamp with time zone)'
  ) IS NULL
)::text || '|' || (
  pg_catalog.to_regprocedure(
    'public.redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)'
  ) IS NULL
)::text;`,
  );
}

function predecessorCatalogDigest(port, database) {
  return scalar(
    port,
    database,
    `
WITH target_relation AS (
  SELECT relation.oid
    FROM pg_catalog.pg_class AS relation
   WHERE relation.oid = 'public.email_outbox'::pg_catalog.regclass
), manifest AS (
  SELECT pg_catalog.jsonb_build_object(
           'relation',
             (
               SELECT pg_catalog.to_jsonb(relation)
                      || pg_catalog.jsonb_build_object(
                           'owner_name',
                             pg_catalog.pg_get_userbyid(relation.relowner)
                         )
                 FROM pg_catalog.pg_class AS relation
                WHERE relation.oid =
                        (SELECT oid FROM target_relation)
             ),
           'row_type',
             (
               SELECT pg_catalog.to_jsonb(type_record)
                 FROM pg_catalog.pg_type AS type_record
                WHERE type_record.oid = (
                  SELECT relation.reltype
                    FROM pg_catalog.pg_class AS relation
                   WHERE relation.oid =
                           (SELECT oid FROM target_relation)
                )
             ),
           'attributes',
             (
               SELECT COALESCE(
                        pg_catalog.jsonb_agg(
                          pg_catalog.to_jsonb(attribute)
                          ORDER BY attribute.attnum
                        ),
                        '[]'::jsonb
                      )
                 FROM pg_catalog.pg_attribute AS attribute
                WHERE attribute.attrelid =
                        (SELECT oid FROM target_relation)
             ),
           'constraints',
             (
               SELECT COALESCE(
                        pg_catalog.jsonb_agg(
                          pg_catalog.to_jsonb(constraint_record)
                          || pg_catalog.jsonb_build_object(
                               'expression',
                                 pg_catalog.pg_get_expr(
                                   constraint_record.conbin,
                                   constraint_record.conrelid,
                                   false
                                 ),
                               'definition',
                                 pg_catalog.pg_get_constraintdef(
                                   constraint_record.oid,
                                   false
                                 )
                             )
                          ORDER BY constraint_record.conname
                        ),
                        '[]'::jsonb
                      )
                 FROM pg_catalog.pg_constraint AS constraint_record
                WHERE constraint_record.conrelid =
                        (SELECT oid FROM target_relation)
             ),
           'triggers',
             (
               SELECT COALESCE(
                        pg_catalog.jsonb_agg(
                          pg_catalog.to_jsonb(trigger_record)
                          || pg_catalog.jsonb_build_object(
                               'definition',
                                 pg_catalog.pg_get_triggerdef(
                                   trigger_record.oid,
                                   false
                                 )
                             )
                          ORDER BY trigger_record.tgname
                        ),
                        '[]'::jsonb
                      )
                 FROM pg_catalog.pg_trigger AS trigger_record
                WHERE trigger_record.tgrelid =
                        (SELECT oid FROM target_relation)
             ),
           'routines',
             (
               SELECT COALESCE(
                        pg_catalog.jsonb_agg(
                          pg_catalog.to_jsonb(routine)
                          || pg_catalog.jsonb_build_object(
                               'namespace', namespace.nspname,
                               'owner_name',
                                 pg_catalog.pg_get_userbyid(routine.proowner),
                               'definition',
                                 pg_catalog.pg_get_functiondef(routine.oid)
                             )
                          ORDER BY routine.oid
                        ),
                        '[]'::jsonb
                      )
                 FROM pg_catalog.pg_proc AS routine
                 JOIN pg_catalog.pg_namespace AS namespace
                   ON namespace.oid = routine.pronamespace
                WHERE namespace.nspname = 'public'
             ),
           'inheritance',
             (
               SELECT COALESCE(
                        pg_catalog.jsonb_agg(
                          pg_catalog.to_jsonb(inheritance)
                          ORDER BY inheritance.inhrelid,
                                   inheritance.inhseqno
                        ),
                        '[]'::jsonb
                      )
                 FROM pg_catalog.pg_inherits AS inheritance
                WHERE inheritance.inhrelid =
                        (SELECT oid FROM target_relation)
                   OR inheritance.inhparent =
                        (SELECT oid FROM target_relation)
             ),
           'rewrite_rules',
             (
               SELECT COALESCE(
                        pg_catalog.jsonb_agg(
                          pg_catalog.to_jsonb(rewrite_rule)
                          ORDER BY rewrite_rule.rulename
                        ),
                        '[]'::jsonb
                      )
                 FROM pg_catalog.pg_rewrite AS rewrite_rule
                WHERE rewrite_rule.ev_class =
                        (SELECT oid FROM target_relation)
             )
         ) AS value
)
SELECT pg_catalog.encode(
         pg_catalog.sha256(
           pg_catalog.convert_to(manifest.value::text, 'UTF8')
         ),
         'hex'
       )
  FROM manifest;`,
  );
}

async function expectPreflightKnownGoodAccepted(port, database) {
  const before = predecessorCatalogDigest(port, database);
  const client = new Client({
    host: "127.0.0.1",
    port,
    database,
    user: "postgres",
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET ROLE learncoding_owner");
    await client.query(readFileSync(migration0068, "utf8"));
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
  assert.equal(
    predecessorCatalogDigest(port, database),
    before,
    "known-good rolled-back preflight changed predecessor catalog state",
  );
  assert.equal(
    phase68NewArtifactState(port, database),
    "true|true",
    "known-good rolled-back preflight leaked phase-68 routines",
  );
}

async function expectPreflightTamperRejected(
  port,
  database,
  label,
  tamperSql,
) {
  const before = predecessorCatalogDigest(port, database);
  const client = new Client({
    host: "127.0.0.1",
    port,
    database,
    user: "postgres",
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(tamperSql);
    await client.query("SET ROLE learncoding_owner");
    await assert.rejects(
      client.query(readFileSync(migration0068, "utf8")),
      (error) =>
        error?.code === "23514"
        && error?.message
          === "email outbox quarantine redaction predecessor is invalid",
      `${label} did not reach the exact 0068 predecessor preflight rejection`,
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
  assert.equal(
    predecessorCatalogDigest(port, database),
    before,
    `${label} predecessor rejection changed predecessor catalog state`,
  );
  assert.equal(
    phase68NewArtifactState(port, database),
    "true|true",
    `${label} predecessor rejection leaked phase-68 routines`,
  );
}

async function provePredecessorTamperRejection(port, database) {
  await expectPreflightKnownGoodAccepted(port, database);
  const cases = [
    [
      "routine-body",
      `
CREATE OR REPLACE FUNCTION
  public.enforce_email_outbox_provider_correlation_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $tampered$
BEGIN
  RETURN NEW;
END
$tampered$;`,
    ],
    [
      "routine-acl",
      `
GRANT EXECUTE ON FUNCTION
  public.enforce_email_outbox_provider_correlation_evidence()
  TO mail_redaction_0068_leaf WITH GRANT OPTION;`,
    ],
    [
      "trigger-enabled",
      `
ALTER TABLE public.email_outbox
  DISABLE TRIGGER email_outbox_provider_correlation_evidence_guard;`,
    ],
    [
      "constraint-expression",
      `
ALTER TABLE public.email_outbox
  DROP CONSTRAINT email_outbox_provider_correlation_evidence_valid;
ALTER TABLE public.email_outbox
  ADD CONSTRAINT email_outbox_provider_correlation_evidence_valid
  CHECK (true);`,
    ],
    [
      "constraint-literal-normalization-collision",
      `
DO $tamper$
DECLARE
  reviewed_definition text;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(
           constraint_record.oid,
           false
         )
    INTO STRICT reviewed_definition
    FROM pg_catalog.pg_constraint AS constraint_record
   WHERE constraint_record.conrelid =
           'public.email_outbox'::pg_catalog.regclass
     AND constraint_record.conname =
           'email_outbox_provider_correlation_evidence_valid';

  ALTER TABLE public.email_outbox
    DROP CONSTRAINT email_outbox_provider_correlation_evidence_valid;
  EXECUTE
    'ALTER TABLE public.email_outbox ADD CONSTRAINT '
    || 'email_outbox_provider_correlation_evidence_valid '
    || pg_catalog.replace(
         reviewed_definition,
         '''^[0-9a-f]{64}$''::text',
         '''^[0-9a-f "]{64}$''::text'
       );
END
$tamper$;`,
    ],
    [
      "column-shape",
      `
ALTER TABLE public.email_outbox
  ALTER COLUMN provider_evidence_version
  SET DEFAULT 'tampered';`,
    ],
    [
      "column-acl",
      `
GRANT UPDATE (provider_evidence_sha256)
  ON TABLE public.email_outbox
  TO learncoding_ops;`,
    ],
    [
      "column-collation",
      `
ALTER TABLE public.email_outbox
  ALTER COLUMN provider_evidence_version
  TYPE text COLLATE "C";`,
    ],
    [
      "worker-table-acl-bypass",
      `
GRANT UPDATE, DELETE ON TABLE public.email_outbox
  TO learncoding_worker;`,
    ],
    [
      "inherited-child",
      `
CREATE TABLE public.email_outbox_0068_child ()
  INHERITS (public.email_outbox);
ALTER TABLE public.email_outbox_0068_child
  OWNER TO learncoding_owner;`,
    ],
    [
      "rewrite-rule",
      `
CREATE RULE email_outbox_0068_block_updates
  AS ON UPDATE TO public.email_outbox
  DO INSTEAD NOTHING;`,
    ],
    [
      "relation-owner",
      `
ALTER TABLE public.email_outbox OWNER TO learncoding_ops;
GRANT ALL PRIVILEGES ON TABLE public.email_outbox
  TO learncoding_owner;`,
    ],
  ];
  if (postgresMajor === "18") {
    cases.push([
      "constraint-not-enforced",
      `
DO $tamper$
DECLARE
  reviewed_definition text;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(
           constraint_record.oid,
           false
         )
    INTO STRICT reviewed_definition
    FROM pg_catalog.pg_constraint AS constraint_record
   WHERE constraint_record.conrelid =
           'public.email_outbox'::pg_catalog.regclass
     AND constraint_record.conname =
           'email_outbox_provider_correlation_evidence_valid';

  ALTER TABLE public.email_outbox
    DROP CONSTRAINT email_outbox_provider_correlation_evidence_valid;
  EXECUTE
    'ALTER TABLE public.email_outbox ADD CONSTRAINT '
    || 'email_outbox_provider_correlation_evidence_valid '
    || reviewed_definition
    || ' NOT ENFORCED';
END
$tamper$;`,
    ]);
  }
  for (const [label, tamperSql] of cases) {
    await expectPreflightTamperRejected(port, database, label, tamperSql);
  }
}
function phase68Manifest(port, database) {
  const manifest = JSON.parse(
    scalar(
      port,
      database,
      `
WITH signatures(ord, signature) AS (
  VALUES
    (
      1,
      'public.classify_email_outbox_quarantine_redaction_v2(public.email_outbox,timestamp with time zone)'
    ),
    (2, 'public.enforce_email_outbox_payload_immutable()'),
    (
      3,
      'public.redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)'
    )
), routines AS (
  SELECT signatures.ord,
         signatures.signature,
         routine.*,
         language.lanname
    FROM signatures
    JOIN pg_catalog.pg_proc AS routine
      ON routine.oid = pg_catalog.to_regprocedure(signatures.signature)
    JOIN pg_catalog.pg_language AS language
      ON language.oid = routine.prolang
)
SELECT pg_catalog.jsonb_build_object(
  'routines',
  (
    SELECT pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'signature', routines.signature,
               'owner', pg_catalog.pg_get_userbyid(routines.proowner),
               'language', routines.lanname,
               'kind', routines.prokind,
               'volatility', routines.provolatile,
               'strict', routines.proisstrict,
               'parallel', routines.proparallel,
               'leakproof', routines.proleakproof,
               'security_definer', routines.prosecdef,
               'configuration', routines.proconfig,
               'argument_count', routines.pronargs,
               'default_count', routines.pronargdefaults,
               'argument_names', routines.proargnames,
               'argument_modes', routines.proargmodes,
               'argument_types',
                 pg_catalog.oidvectortypes(routines.proargtypes),
               'all_argument_types',
                 CASE WHEN routines.proallargtypes IS NULL THEN NULL
                   ELSE ARRAY(
                     SELECT pg_catalog.format_type(argument_type, NULL)
                       FROM pg_catalog.unnest(routines.proallargtypes)
                            WITH ORDINALITY
                            AS argument(argument_type, position)
                      ORDER BY argument.position
                   )
                 END,
               'return_type',
                 pg_catalog.format_type(routines.prorettype, NULL),
               'returns_set', routines.proretset,
               'variadic_type', routines.provariadic,
               'source_sha256',
                 pg_catalog.encode(
                   pg_catalog.sha256(
                     pg_catalog.convert_to(routines.prosrc, 'UTF8')
                   ),
                   'hex'
                 ),
               'definition_sha256',
                 pg_catalog.encode(
                   pg_catalog.sha256(
                     pg_catalog.convert_to(
                       pg_catalog.pg_get_functiondef(routines.oid),
                       'UTF8'
                     )
                   ),
                   'hex'
                 ),
               'acl',
                 (
                   SELECT COALESCE(
                            pg_catalog.jsonb_agg(
                              pg_catalog.jsonb_build_object(
                                'grantor',
                                  pg_catalog.pg_get_userbyid(acl.grantor),
                                'grantee',
                                  CASE WHEN acl.grantee = 0
                                    THEN 'PUBLIC'
                                    ELSE pg_catalog.pg_get_userbyid(
                                      acl.grantee
                                    )
                                  END,
                                'privilege', acl.privilege_type,
                                'grantable', acl.is_grantable
                              )
                              ORDER BY
                                pg_catalog.pg_get_userbyid(acl.grantor),
                                CASE WHEN acl.grantee = 0
                                  THEN 'PUBLIC'
                                  ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                                END,
                                acl.privilege_type
                            ),
                            '[]'::jsonb
                          )
                     FROM pg_catalog.aclexplode(
                       COALESCE(
                         routines.proacl,
                         pg_catalog.acldefault('f', routines.proowner)
                       )
                     ) AS acl
                 )
             )
             ORDER BY routines.ord
           )
      FROM routines
  ),
  'relation',
  (
    SELECT pg_catalog.jsonb_build_object(
             'owner', pg_catalog.pg_get_userbyid(relation.relowner),
             'kind', relation.relkind,
             'persistence', relation.relpersistence,
             'row_security', relation.relrowsecurity,
             'force_row_security', relation.relforcerowsecurity,
             'is_partition', relation.relispartition,
             'part_bound_is_null', relation.relpartbound IS NULL,
             'typed_table_oid', relation.reloftype::text,
             'has_subclass', relation.relhassubclass,
             'has_rules', relation.relhasrules,
             'inheritance_edges',
               (
                 SELECT pg_catalog.count(*)::integer
                   FROM pg_catalog.pg_inherits AS inheritance
                  WHERE inheritance.inhrelid = relation.oid
                     OR inheritance.inhparent = relation.oid
               ),
             'rewrite_rules',
               (
                 SELECT pg_catalog.count(*)::integer
                   FROM pg_catalog.pg_rewrite AS rewrite_rule
                  WHERE rewrite_rule.ev_class = relation.oid
               ),
             'worker_select',
               pg_catalog.has_table_privilege(
                 'learncoding_worker',
                 relation.oid,
                 'SELECT'
               ),
             'worker_dangerous_table_privilege',
               pg_catalog.has_table_privilege(
                 'learncoding_worker',
                 relation.oid,
                 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
               )
           )
      FROM pg_catalog.pg_class AS relation
     WHERE relation.oid = 'public.email_outbox'::pg_catalog.regclass
  ),
  'trigger',
  (
    SELECT pg_catalog.jsonb_build_object(
             'name', trigger_record.tgname,
             'internal', trigger_record.tgisinternal,
             'enabled', trigger_record.tgenabled,
             'type', trigger_record.tgtype,
             'qualification', trigger_record.tgqual,
             'argument_count', trigger_record.tgnargs,
             'argument_octets',
               pg_catalog.octet_length(trigger_record.tgargs),
             'parent_oid', trigger_record.tgparentid::text,
             'constraint_oid', trigger_record.tgconstraint::text,
             'constraint_relation_oid',
               trigger_record.tgconstrrelid::text,
             'constraint_index_oid',
               trigger_record.tgconstrindid::text,
             'deferrable', trigger_record.tgdeferrable,
             'initially_deferred', trigger_record.tginitdeferred,
             'old_transition_table', trigger_record.tgoldtable,
             'new_transition_table', trigger_record.tgnewtable,
             'function',
               pg_catalog.format(
                 '%I.%I(%s)',
                 routine_namespace.nspname,
                 routine.proname,
                 pg_catalog.pg_get_function_identity_arguments(routine.oid)
               ),
             'watched_columns',
               (
                 SELECT pg_catalog.jsonb_agg(
                          attribute.attname ORDER BY watched.position
                        )
                   FROM pg_catalog.unnest(
                          trigger_record.tgattr::smallint[]
                        ) WITH ORDINALITY
                        AS watched(attnum, position)
                   JOIN pg_catalog.pg_attribute AS attribute
                     ON attribute.attrelid = trigger_record.tgrelid
                    AND attribute.attnum = watched.attnum
               )
           )
      FROM pg_catalog.pg_trigger AS trigger_record
      JOIN pg_catalog.pg_proc AS routine
        ON routine.oid = trigger_record.tgfoid
      JOIN pg_catalog.pg_namespace AS routine_namespace
        ON routine_namespace.oid = routine.pronamespace
     WHERE trigger_record.tgrelid =
             'public.email_outbox'::pg_catalog.regclass
       AND trigger_record.tgname = 'email_outbox_payload_immutable'
       AND NOT trigger_record.tgisinternal
  )
)::text;`,
    ),
  );

  assert.deepEqual(manifest.relation, {
    force_row_security: false,
    has_rules: false,
    has_subclass: false,
    inheritance_edges: 0,
    is_partition: false,
    kind: "r",
    owner: "learncoding_owner",
    part_bound_is_null: true,
    persistence: "p",
    rewrite_rules: 0,
    row_security: false,
    typed_table_oid: "0",
    worker_dangerous_table_privilege: false,
    worker_select: true,
  });
  assert.deepEqual(manifest.trigger, {
    argument_count: 0,
    argument_octets: 0,
    constraint_index_oid: "0",
    constraint_oid: "0",
    constraint_relation_oid: "0",
    deferrable: false,
    enabled: "O",
    function: "public.enforce_email_outbox_payload_immutable()",
    initially_deferred: false,
    internal: false,
    name: "email_outbox_payload_immutable",
    new_transition_table: null,
    old_transition_table: null,
    parent_oid: "0",
    qualification: null,
    type: 19,
    watched_columns: [
      "user_id",
      "to_email",
      "template",
      "template_version",
      "variables",
      "idempotency_key",
      "idempotency_authority_version",
      "idempotency_authority_sha256",
      "idempotency_payload_sha256",
      "operation_id",
      "delivery_scope_key",
    ],
  });

  const expectedRoutines = [
    {
      signature:
        "public.classify_email_outbox_quarantine_redaction_v2("
        + "public.email_outbox,timestamp with time zone)",
      language: "plpgsql",
      kind: "f",
      volatility: "s",
      strict: false,
      parallel: "u",
      leakproof: false,
      security_definer: true,
      configuration: ["search_path=pg_catalog"],
      argument_count: 2,
      default_count: 0,
      argument_names: ["candidate", "cutoff_at"],
      argument_modes: null,
      argument_types: "email_outbox, timestamp with time zone",
      all_argument_types: null,
      return_type: "text",
      returns_set: false,
      variadic_type: "0",
      source_sha256:
        "4123bf385566b5132359e56735bff8c5e3bbec4b57add37a912911ed364fbab7",
      definition_sha256:
        "0e2951c47c61b9fb489f58218c4a2f56aa43e6fca140aca7259fcbf62d8b4cca",
      acl: [
        {
          grantable: false,
          grantee: "learncoding_owner",
          grantor: "learncoding_owner",
          privilege: "EXECUTE",
        },
      ],
    },
    {
      signature: "public.enforce_email_outbox_payload_immutable()",
      language: "plpgsql",
      kind: "f",
      volatility: "v",
      strict: false,
      parallel: "u",
      leakproof: false,
      security_definer: false,
      configuration: ["search_path=pg_catalog"],
      argument_count: 0,
      default_count: 0,
      argument_names: null,
      argument_modes: null,
      argument_types: "",
      all_argument_types: null,
      return_type: "trigger",
      returns_set: false,
      variadic_type: "0",
      source_sha256:
        "436cf9102d266ba38832559309f5c92107ad0fe7222d28fc6291e8bcc9b9ebb5",
      definition_sha256:
        "eb876f2c70a3f6c324ae7e677092ec636a44a22b53e057e54d42acb6251edeeb",
      acl: [
        {
          grantable: false,
          grantee: "learncoding_owner",
          grantor: "learncoding_owner",
          privilege: "EXECUTE",
        },
      ],
    },
    {
      signature:
        "public.redact_quarantined_email_outbox_authority_v2("
        + "timestamp with time zone,integer)",
      language: "plpgsql",
      kind: "f",
      volatility: "v",
      strict: false,
      parallel: "u",
      leakproof: false,
      security_definer: true,
      configuration: ["search_path=pg_catalog"],
      argument_count: 2,
      default_count: 0,
      argument_names: [
        "cutoff_at",
        "batch_limit",
        "disposition",
        "eligible",
        "transitioned",
      ],
      argument_modes: ["i", "i", "t", "t", "t"],
      argument_types: "timestamp with time zone, integer",
      all_argument_types: [
        "timestamp with time zone",
        "integer",
        "text",
        "bigint",
        "bigint",
      ],
      return_type: "record",
      returns_set: true,
      variadic_type: "0",
      source_sha256:
        "0d35660771ae325d7d167cb1f2355439a5f61f90950f6ec70ed27561577a2afe",
      definition_sha256:
        "815b9f25557e71db53f7acaa271fa9e6dc5f1a88fbd1013f7ac01a6daeb64325",
      acl: [
        {
          grantable: false,
          grantee: "learncoding_ops",
          grantor: "learncoding_owner",
          privilege: "EXECUTE",
        },
        {
          grantable: false,
          grantee: "learncoding_owner",
          grantor: "learncoding_owner",
          privilege: "EXECUTE",
        },
      ],
    },
  ];
  assert.equal(manifest.routines.length, expectedRoutines.length);
  for (const [index, expected] of expectedRoutines.entries()) {
    const observed = manifest.routines[index];
    assert.equal(observed.owner, "learncoding_owner");
    const withoutOwner = Object.fromEntries(
      Object.entries(observed).filter(([key]) => key !== "owner"),
    );
    assert.deepEqual(withoutOwner, expected);
  }
  return manifest;
}
function protectedDigest(port, database) {
  return scalar(
    port,
    database,
    `
SELECT pg_catalog.md5(
         pg_catalog.string_agg(
           outbox.id::text || ':' ||
           pg_catalog.md5((
             pg_catalog.to_jsonb(outbox)
             - 'to_email'
             - 'variables'
             - 'updated_at'
           )::text),
           '|' ORDER BY outbox.id
         )
       )
  FROM public.email_outbox AS outbox
 WHERE outbox.id::text LIKE '67000000-%';`,
  );
}

function insertFixtures(port, database) {
  applyAsOwner(
    port,
    database,
    `
ALTER TABLE public.email_outbox
  DROP CONSTRAINT email_outbox_provider_correlation_evidence_valid;
ALTER TABLE public.email_outbox
  DROP CONSTRAINT email_outbox_delivery_scope_valid;
ALTER TABLE public.email_outbox
  DISABLE TRIGGER email_outbox_provider_correlation_evidence_guard;

INSERT INTO public."user" (id, name, email)
VALUES (
  'retention-0068-user',
  'Retention 0068 User',
  'retention-0068-user@example.invalid'
);

INSERT INTO public.email_outbox (
  id, user_id, to_email, template, template_version, variables,
  idempotency_key, operation_id, delivery_scope_key, status,
  attempt_count, claim_token, claim_owner, claim_version,
  lease_expires_at, provider_call_started, adapter,
  dispatch_binding_version, dispatch_binding_sha256,
  provider_message_id, provider_correlation_version,
  provider_evidence_version, provider_evidence_sha256,
  next_attempt_at, sent_at, quarantined_at, last_error_code,
  created_at, updated_at
) VALUES
(
  '67000000-0000-4000-8000-000000000001',
  'retention-0068-user',
  'account-secret@example.invalid',
  'weekly-summary',
  '1',
  '{"secret":"account-pii"}'::jsonb,
  'retention-0068-account',
  '67100000-0000-4000-8000-000000000001',
  'a:retention-0068-user',
  'quarantined',
  4, NULL, NULL, 9, NULL,
  '2025-01-02T00:00:00Z', 'gmail',
  'gmail-raw-v1', repeat('a', 64),
  NULL, 'opaque-sha256-v1',
  'gmail-header-evidence-v1', repeat('b', 64),
  '2025-01-03T00:00:00Z', NULL,
  '2025-01-04T00:00:00Z', 'GMAIL_RESULT_UNKNOWN',
  '2025-01-01T00:00:00Z', '2025-01-05T00:00:00Z'
),
(
  '67000000-0000-4000-8000-000000000002',
  NULL,
  'system-secret@example.invalid',
  'invitation',
  '1',
  pg_catalog.jsonb_build_object(
    '_mailOperationId', '67100000-0000-4000-8000-000000000002',
    '_mailRecipient', 'system-secret@example.invalid',
    '_mailProducer', 'access-request-approved',
    '_mailSourceId', '67200000-0000-4000-8000-000000000002',
    'name', 'Private Learner',
    'url', 'https://example.invalid/private-token'
  ),
  'retention-0068-system',
  '67100000-0000-4000-8000-000000000002',
  's:67100000-0000-4000-8000-000000000002',
  'quarantined',
  3, NULL, NULL, 8, NULL,
  '2025-01-02T00:00:00Z', 'gmail',
  'gmail-raw-v1', repeat('c', 64),
  'gmail-message-0068-2', 'opaque-sha256-v1',
  'gmail-header-evidence-v1', repeat('d', 64),
  '2025-01-03T00:00:00Z', NULL,
  '2025-01-04T00:00:00Z', 'GMAIL_RECEIPT_AMBIGUOUS',
  '2025-01-01T00:00:00Z', '2025-01-06T00:00:00Z'
),
(
  '67000000-0000-4000-8000-000000000003',
  NULL,
  'console-secret@example.invalid',
  'weekly-summary',
  '1',
  '{"secret":"console-pii"}'::jsonb,
  'retention-0068-console',
  '67100000-0000-4000-8000-000000000003',
  'o:67100000-0000-4000-8000-000000000003',
  'quarantined',
  2, NULL, NULL, 7, NULL,
  '2025-01-02T00:00:00Z', 'console',
  'console-json-v1', repeat('e', 64),
  'console-message-0068-3', 'opaque-sha256-v1',
  NULL, NULL,
  '2025-01-03T00:00:00Z', NULL,
  '2025-01-04T00:00:00Z', 'CONSOLE_RESULT_UNKNOWN',
  '2025-01-01T00:00:00Z', '2025-01-07T00:00:00Z'
),
(
  '67000000-0000-4000-8000-000000000004',
  'retention-0068-user',
  'partial-evidence-secret@example.invalid',
  'weekly-summary',
  '1',
  '{"secret":"partial-evidence-pii"}'::jsonb,
  'retention-0068-partial-evidence',
  '67100000-0000-4000-8000-000000000004',
  'a:retention-0068-user',
  'quarantined',
  5, NULL, NULL, 10, NULL,
  '2025-01-02T00:00:00Z', 'gmail',
  'gmail-raw-v1', repeat('f', 64),
  'gmail-message-0068-4', 'opaque-sha256-v1',
  'gmail-header-evidence-v1', NULL,
  '2025-01-03T00:00:00Z', NULL,
  '2025-01-04T00:00:00Z', 'GMAIL_PARTIAL_EVIDENCE',
  '2025-01-01T00:00:00Z', '2025-01-08T00:00:00Z'
),
(
  '67000000-0000-4000-8000-000000000005',
  'retention-0068-user',
  'malformed-scope-secret@example.invalid',
  'weekly-summary',
  '1',
  '{"secret":"malformed-scope-pii"}'::jsonb,
  'retention-0068-malformed-scope',
  '67100000-0000-4000-8000-000000000005',
  'damaged:retention-0068-user',
  'quarantined',
  6, NULL, NULL, 11, NULL,
  '2025-01-02T00:00:00Z', 'gmail',
  'gmail-raw-v1', repeat('1', 64),
  NULL, 'opaque-sha256-v1',
  'gmail-header-evidence-v1', repeat('2', 64),
  '2025-01-03T00:00:00Z', NULL,
  '2025-01-04T00:00:00Z', 'GMAIL_SCOPE_DAMAGED',
  '2025-01-01T00:00:00Z', '2025-01-09T00:00:00Z'
),
(
  '67000000-0000-4000-8000-000000000006',
  'retention-0068-user',
  'held-secret@example.invalid',
  'weekly-summary',
  '1',
  '{"secret":"held-pii"}'::jsonb,
  'retention-0068-held',
  '67100000-0000-4000-8000-000000000006',
  'a:retention-0068-user',
  'quarantined',
  7, '67300000-0000-4000-8000-000000000006', NULL, 12, NULL,
  '2025-01-02T00:00:00Z', 'gmail',
  'gmail-raw-v1', repeat('3', 64),
  NULL, 'opaque-sha256-v1',
  'gmail-header-evidence-v1', repeat('4', 64),
  '2025-01-03T00:00:00Z', NULL,
  '2025-01-04T00:00:00Z', 'GMAIL_HELD_PARTIAL_FENCE',
  '2025-01-01T00:00:00Z', '2025-01-10T00:00:00Z'
),
(
  '67000000-0000-4000-8000-000000000007',
  'retention-0068-user',
  'recent-secret@example.invalid',
  'weekly-summary',
  '1',
  '{"secret":"recent-pii"}'::jsonb,
  'retention-0068-recent',
  '67100000-0000-4000-8000-000000000007',
  'a:retention-0068-user',
  'quarantined',
  1, NULL, NULL, 3, NULL,
  '2025-01-02T00:00:00Z', 'gmail',
  'gmail-raw-v1', repeat('5', 64),
  NULL, 'opaque-sha256-v1',
  'gmail-header-evidence-v1', repeat('6', 64),
  '2025-01-03T00:00:00Z', NULL,
  pg_catalog.statement_timestamp() - interval '5 days',
  'GMAIL_RECENT_QUARANTINE',
  '2025-01-01T00:00:00Z',
  pg_catalog.statement_timestamp() - interval '5 days'
),
(
  '67000000-0000-4000-8000-000000000008',
  NULL,
  'legacy-secret@example.invalid',
  'weekly-summary',
  '1',
  '{"secret":"legacy-pii"}'::jsonb,
  'retention-0068-legacy',
  '67100000-0000-4000-8000-000000000008',
  'o:67100000-0000-4000-8000-000000000008',
  'quarantined',
  0, NULL, NULL, 0, NULL,
  NULL, NULL,
  NULL, NULL,
  NULL, 'legacy-raw-v0',
  NULL, NULL,
  '2025-01-03T00:00:00Z', NULL,
  '2025-01-04T00:00:00Z', 'LEGACY_SENDING_AMBIGUOUS',
  '2025-01-01T00:00:00Z', '2025-01-11T00:00:00Z'
);

INSERT INTO public.email_outbox (
  id, user_id, to_email, template, template_version, variables,
  idempotency_key, operation_id, delivery_scope_key, status,
  attempt_count, claim_token, claim_owner, claim_version,
  lease_expires_at, provider_call_started, adapter,
  dispatch_binding_version, dispatch_binding_sha256,
  provider_message_id, provider_correlation_version,
  provider_evidence_version, provider_evidence_sha256,
  next_attempt_at, sent_at, quarantined_at, last_error_code,
  created_at, updated_at
)
SELECT
  fence.id::uuid,
  'retention-0068-user',
  fence.label || '-secret@example.invalid',
  'weekly-summary',
  '1',
  pg_catalog.jsonb_build_object('secret', fence.label || '-pii'),
  'retention-0068-' || fence.label,
  fence.operation_id::uuid,
  'a:retention-0068-user',
  'quarantined',
  8,
  fence.claim_token::uuid,
  fence.claim_owner,
  fence.claim_version,
  fence.lease_expires_at::timestamptz,
  '2025-01-02T00:00:00Z',
  'gmail',
  'gmail-raw-v1',
  repeat('7', 64),
  NULL,
  'opaque-sha256-v1',
  'gmail-header-evidence-v1',
  repeat('8', 64),
  '2025-01-03T00:00:00Z',
  NULL,
  '2025-01-04T00:00:00Z',
  'GMAIL_CLAIM_TUPLE_' || pg_catalog.upper(
    pg_catalog.replace(fence.label, '-', '_')
  ),
  '2025-01-01T00:00:00Z',
  '2025-01-12T00:00:00Z'
FROM (VALUES
  (
    '67000000-0000-4000-8000-000000000009',
    '67100000-0000-4000-8000-000000000009',
    'owner-only',
    NULL,
    'claim-owner-009',
    NULL,
    13
  ),
  (
    '67000000-0000-4000-8000-000000000010',
    '67100000-0000-4000-8000-000000000010',
    'lease-only',
    NULL,
    NULL,
    '2025-01-20T00:00:00Z',
    14
  ),
  (
    '67000000-0000-4000-8000-000000000011',
    '67100000-0000-4000-8000-000000000011',
    'token-owner',
    '67300000-0000-4000-8000-000000000011',
    'claim-owner-011',
    NULL,
    15
  ),
  (
    '67000000-0000-4000-8000-000000000012',
    '67100000-0000-4000-8000-000000000012',
    'token-lease',
    '67300000-0000-4000-8000-000000000012',
    NULL,
    '2025-01-20T00:00:00Z',
    16
  ),
  (
    '67000000-0000-4000-8000-000000000013',
    '67100000-0000-4000-8000-000000000013',
    'owner-lease',
    NULL,
    'claim-owner-013',
    '2025-01-20T00:00:00Z',
    17
  ),
  (
    '67000000-0000-4000-8000-000000000014',
    '67100000-0000-4000-8000-000000000014',
    'complete-expired',
    '67300000-0000-4000-8000-000000000014',
    'claim-owner-014',
    '2025-01-20T00:00:00Z',
    18
  ),
  (
    '67000000-0000-4000-8000-000000000015',
    '67100000-0000-4000-8000-000000000015',
    'complete-live',
    '67300000-0000-4000-8000-000000000015',
    'claim-owner-015',
    '2100-01-20T00:00:00Z',
    19
  )
) AS fence(
  id,
  operation_id,
  label,
  claim_token,
  claim_owner,
  lease_expires_at,
  claim_version
);

ALTER TABLE public.email_outbox
  ENABLE TRIGGER email_outbox_provider_correlation_evidence_guard;`,
  );
}

async function proveRuntime(port, database, expectedManifest) {
  assert.equal(catalogContract(port, database), "true");

  applyAsOwner(
    port,
    database,
    `CREATE OR REPLACE FUNCTION
       public.classify_email_outbox_quarantine_redaction_v2(
         candidate public.email_outbox,
         cutoff_at timestamp with time zone
       )
     RETURNS text
     LANGUAGE sql
     IMMUTABLE
     SECURITY INVOKER
     SET search_path = public
     AS $tampered$
       SELECT 'blocked'::text
     $tampered$;
     GRANT EXECUTE ON FUNCTION
       public.classify_email_outbox_quarantine_redaction_v2(
         public.email_outbox,
         timestamp with time zone
       ) TO learncoding_owner WITH GRANT OPTION;
     ALTER TABLE public.email_outbox
       DISABLE TRIGGER email_outbox_payload_immutable;`,
  );
  const delegatedRoutineSignatures = [
    "public.classify_email_outbox_quarantine_redaction_v2("
      + "public.email_outbox, timestamp with time zone)",
    "public.enforce_email_outbox_payload_immutable()",
    "public.redact_quarantined_email_outbox_authority_v2("
      + "timestamp with time zone, integer)",
  ];
  for (const signature of delegatedRoutineSignatures) {
    psql(
      port,
      database,
      `GRANT EXECUTE ON FUNCTION ${signature}
         TO mail_redaction_0068_grantor WITH GRANT OPTION;`,
    );
    psql(
      port,
      database,
      `GRANT EXECUTE ON FUNCTION ${signature}
         TO mail_redaction_0068_leaf;`,
      { username: "mail_redaction_0068_grantor" },
    );
  }
  assert.equal(
    catalogContract(port, database),
    "false",
    "catalog tamper escaped the exact verifier",
  );
  applyAsOwner(port, database, readFileSync(migration0068, "utf8"));
  assert.equal(
    catalogContract(port, database),
    "true",
    "idempotent migration replay did not heal catalog tamper",
  );
  assert.deepEqual(
    phase68Manifest(port, database),
    expectedManifest,
    "idempotent migration replay did not restore the exact phase-68 manifest",
  );
  for (const signature of delegatedRoutineSignatures) {
    assert.equal(
      scalar(
        port,
        database,
        `SELECT
           pg_catalog.has_function_privilege(
             'mail_redaction_0068_grantor',
             '${signature}'::pg_catalog.regprocedure,
             'EXECUTE'
           )::text || '|' ||
           pg_catalog.has_function_privilege(
             'mail_redaction_0068_leaf',
             '${signature}'::pg_catalog.regprocedure,
             'EXECUTE'
           )::text;`,
      ),
      "false|false",
      `${signature} retained delegated EXECUTE after ACL sealing`,
    );
  }

  insertFixtures(port, database);
  const protectedBefore = protectedDigest(port, database);

  for (const role of [
    "learncoding_app",
    "learncoding_worker",
    "learncoding_migrator",
  ]) {
    await expectSqlState(
      port,
      database,
      role,
      `SELECT *
         FROM public.redact_quarantined_email_outbox_authority_v2(
           pg_catalog.statement_timestamp() - interval '30 days',
           100
         );`,
      "42501",
    );
  }
  await expectSqlState(
    port,
    database,
    "learncoding_ops",
    `SELECT public.classify_email_outbox_quarantine_redaction_v2(
       candidate,
       pg_catalog.statement_timestamp() - interval '30 days'
     )
       FROM public.email_outbox AS candidate
      LIMIT 1;`,
    "42501",
  );
  await expectSqlState(
    port,
    database,
    "learncoding_ops",
    `SELECT *
       FROM public.redact_quarantined_email_outbox_authority_v2(
         pg_catalog.statement_timestamp() - interval '29 days',
         100
       );`,
    "22023",
  );

  applyAsOwner(
    port,
    database,
    `
CREATE FUNCTION public.mail_redaction_0068_tamper_probe()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $probe$
  UPDATE public.email_outbox
     SET to_email =
           'redacted+' || id::text || '@invalid.local',
         variables = '{}'::jsonb,
         status = 'pending',
         updated_at = pg_catalog.statement_timestamp()
   WHERE id = '67000000-0000-4000-8000-000000000001'::uuid
$probe$;
ALTER FUNCTION public.mail_redaction_0068_tamper_probe()
  OWNER TO learncoding_owner;
REVOKE ALL ON FUNCTION public.mail_redaction_0068_tamper_probe()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mail_redaction_0068_tamper_probe()
  TO learncoding_ops;`,
  );
  await expectSqlState(
    port,
    database,
    "learncoding_ops",
    "SELECT public.mail_redaction_0068_tamper_probe();",
    "23514",
  );
  applyAsOwner(
    port,
    database,
    "DROP FUNCTION public.mail_redaction_0068_tamper_probe();",
  );

  const reportOnly = scalar(
    port,
    database,
    `
SELECT pg_catalog.string_agg(
         disposition || '|' || eligible::text || '|' ||
           transitioned::text,
         ',' ORDER BY CASE disposition
           WHEN 'eligible' THEN 1
           WHEN 'blocked' THEN 2
           ELSE 3
         END
       )
  FROM public.redact_quarantined_email_outbox_authority_v2(
    pg_catalog.statement_timestamp() - interval '30 days',
    0
  );`,
    "learncoding_ops",
  );
  assert.equal(reportOnly, "eligible|12|0,blocked|1|0,malformed|1|0");
  assert.equal(
    protectedDigest(port, database),
    protectedBefore,
    "report-only changed authority state",
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT pg_catalog.count(*)::text
         FROM public.email_outbox
        WHERE id::text LIKE '67000000-%'
          AND to_email LIKE 'redacted+%';`,
    ),
    "0",
    "report-only redacted payload",
  );

  const applied = scalar(
    port,
    database,
    `
SELECT pg_catalog.string_agg(
         disposition || '|' || eligible::text || '|' ||
           transitioned::text,
         ',' ORDER BY CASE disposition
           WHEN 'eligible' THEN 1
           WHEN 'blocked' THEN 2
           ELSE 3
         END
       )
  FROM public.redact_quarantined_email_outbox_authority_v2(
    pg_catalog.statement_timestamp() - interval '30 days',
    100
  );`,
    "learncoding_ops",
  );
  assert.equal(applied, "eligible|12|12,blocked|1|0,malformed|1|1");
  assert.equal(
    protectedDigest(port, database),
    protectedBefore,
    "redaction changed non-PII authority",
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT pg_catalog.count(*)::text
         FROM public.email_outbox
        WHERE id::text LIKE '67000000-%'
          AND status <> 'quarantined';`,
    ),
    "0",
    "redaction made a row sendable",
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT pg_catalog.count(*)::text
         FROM public.email_outbox
        WHERE id::text LIKE '67000000-%'
          AND id NOT IN (
            '67000000-0000-4000-8000-000000000007',
            '67000000-0000-4000-8000-000000000015'
          )
          AND to_email =
                'redacted+' || id::text || '@invalid.local';`,
    ),
    "13",
    "an aged released, expired, or partial-claim quarantine retained its recipient",
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT to_email
         FROM public.email_outbox
        WHERE id = '67000000-0000-4000-8000-000000000006';`,
    ),
    "redacted+67000000-0000-4000-8000-000000000006@invalid.local",
    "a claim-token-only quarantine retained PII",
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT to_email
         FROM public.email_outbox
        WHERE id = '67000000-0000-4000-8000-000000000007';`,
    ),
    "recent-secret@example.invalid",
    "recent quarantine crossed the retention cutoff",
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT to_email
         FROM public.email_outbox
        WHERE id = '67000000-0000-4000-8000-000000000014';`,
    ),
    "redacted+67000000-0000-4000-8000-000000000014@invalid.local",
    "expired complete authority retained PII",
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT to_email
         FROM public.email_outbox
        WHERE id = '67000000-0000-4000-8000-000000000015';`,
    ),
    "complete-live-secret@example.invalid",
    "live complete authority was not reported as blocked",
  );
  assert.equal(
    scalar(
      port,
      database,
      `
SELECT (
         SELECT pg_catalog.count(*)
           FROM pg_catalog.jsonb_object_keys(outbox.variables)
       )::text || '|' ||
       (outbox.variables ->> '_mailOperationId') || '|' ||
       (outbox.variables ->> '_mailRecipient') || '|' ||
       (outbox.variables ->> '_mailProducer') || '|' ||
       (outbox.variables ->> '_mailSourceId')
  FROM public.email_outbox AS outbox
 WHERE outbox.id = '67000000-0000-4000-8000-000000000002';`,
    ),
    "4|67100000-0000-4000-8000-000000000002|"
      + "redacted+67000000-0000-4000-8000-000000000002@invalid.local|"
      + "access-request-approved|67200000-0000-4000-8000-000000000002",
    "system envelope did not retain only its non-PII authority shell",
  );
  assert.equal(
    scalar(
      port,
      database,
      `
SELECT provider_message_id || '|' ||
       provider_correlation_version || '|' ||
       provider_evidence_version || '|' ||
       COALESCE(provider_evidence_sha256, '<null>') || '|' ||
       dispatch_binding_sha256
  FROM public.email_outbox
 WHERE id = '67000000-0000-4000-8000-000000000004';`,
    ),
    `gmail-message-0068-4|opaque-sha256-v1|`
      + `gmail-header-evidence-v1|<null>|${"f".repeat(64)}`,
    "partial provider evidence was destroyed or repaired implicitly",
  );

  const replay = scalar(
    port,
    database,
    `
SELECT pg_catalog.string_agg(
         disposition || '|' || eligible::text || '|' ||
           transitioned::text,
         ',' ORDER BY CASE disposition
           WHEN 'eligible' THEN 1
           WHEN 'blocked' THEN 2
           ELSE 3
         END
       )
  FROM public.redact_quarantined_email_outbox_authority_v2(
    pg_catalog.statement_timestamp() - interval '30 days',
    100
  );`,
    "learncoding_ops",
  );
  assert.equal(replay, "eligible|0|0,blocked|1|0,malformed|0|0");
}

async function main() {
  const version = run(executable("postgres"), ["--version"]).stdout.trim();
  assert.match(
    version,
    new RegExp(`PostgreSQL\\) ${postgresMajor}\\.`, "u"),
  );

  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), `codestead-mail-redaction-0068-pg${postgresMajor}-`),
  );
  const dataDirectory = path.join(temporaryRoot, "data");
  const logFile = path.join(temporaryRoot, "postgres.log");
  const database = "mail_redaction_0068";
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
CREATE ROLE learncoding_backup_reporter LOGIN NOINHERIT;
CREATE ROLE mail_redaction_0068_grantor LOGIN NOINHERIT;
CREATE ROLE mail_redaction_0068_leaf NOLOGIN NOINHERIT;`,
    );
    run(executable("createdb"), [
      "--host=127.0.0.1",
      `--port=${port}`,
      "--username=postgres",
      "--owner=learncoding_owner",
      database,
    ]);
    applyAsOwner(port, database, reviewedPrefixSql);
    applyAsOwner(port, database, readFileSync(predecessor0065, "utf8"));
    applyAsOwner(port, database, readFileSync(predecessor0066, "utf8"));
    const exactPredecessorConstraintManifest =
      predecessorConstraintManifest(port, database);
    psql(
      port,
      database,
      `ALTER DEFAULT PRIVILEGES FOR ROLE learncoding_owner
         IN SCHEMA public
         GRANT EXECUTE ON FUNCTIONS
         TO mail_redaction_0068_grantor WITH GRANT OPTION;
       ALTER DEFAULT PRIVILEGES FOR ROLE learncoding_migrator
         IN SCHEMA public
         GRANT EXECUTE ON FUNCTIONS
         TO mail_redaction_0068_grantor WITH GRANT OPTION;`,
    );
    await provePredecessorTamperRejection(port, database);
    applyAsOwner(port, database, readFileSync(migration0068, "utf8"));
    const exactPhase68Manifest = phase68Manifest(port, database);
    await proveRuntime(port, database, exactPhase68Manifest);

    process.stdout.write(
      "mail_redaction_0068=sql_sha256:"
      + createHash("sha256")
        .update(readFileSync(migration0068))
        .digest("hex")
      + "\n",
    );
    process.stdout.write(
      "mail_redaction_0068=phase68_manifest:"
      + JSON.stringify(exactPhase68Manifest)
      + "\n",
    );
    process.stdout.write(
      "mail_redaction_0068=predecessor_input_manifest:"
      + JSON.stringify(predecessorInputManifest)
      + "\n",
    );
    process.stdout.write(
      "mail_redaction_0068=predecessor_constraint_manifest:"
      + JSON.stringify(exactPredecessorConstraintManifest)
      + "\n",
    );
    process.stdout.write(
      "mail_redaction_0068=predecessor_tamper_rejection:pass\n",
    );
    process.stdout.write("mail_redaction_0068=catalog_acl:pass\n");
    process.stdout.write("mail_redaction_0068=tamper_repair:pass\n");
    process.stdout.write("mail_redaction_0068=scope_matrix:pass\n");
    process.stdout.write("mail_redaction_0068=provider_matrix:pass\n");
    process.stdout.write("mail_redaction_0068=no_resend:pass\n");
    process.stdout.write(
      `mail_redaction_0068=postgres:${postgresMajor}:${version}:pass\n`,
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
          `temporary PostgreSQL shutdown failed\n`
          + (existsSync(logFile) ? readFileSync(logFile, "utf8") : ""),
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
