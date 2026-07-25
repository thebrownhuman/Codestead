#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import {
  REVIEWED_MIGRATION_LEDGER,
  verifyAppliedMigrationLedger,
} from "../../scripts/lib/reviewed-migration-ledger.mjs";

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

function prefixMigrationVerifier(maximumIndex) {
  const expected = REVIEWED_MIGRATION_LEDGER.slice(0, maximumIndex + 1);
  assert.equal(expected.at(-1)?.idx, maximumIndex);
  return {
    verifyReviewedMigrationRepository({ drizzleDirectory }) {
      const journal = JSON.parse(readFileSync(
        path.join(drizzleDirectory, "meta", "_journal.json"),
        "utf8",
      ));
      assert.deepEqual(
        journal,
        {
          version: "7",
          dialect: "postgresql",
          entries: expected.map(({ sqlSha256: omitted, ...entry }) => {
            assert.match(omitted, /^[0-9a-f]{64}$/u);
            return entry;
          }),
        },
        `staged migration journal must be the exact prefix through ${maximumIndex}`,
      );
      const actualNames = readdirSync(drizzleDirectory)
        .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
        .sort();
      assert.deepEqual(
        actualNames,
        expected.map(({ tag }) => `${tag}.sql`),
        `staged SQL inventory must be exact through ${maximumIndex}`,
      );
      for (const entry of expected) {
        assert.equal(
          createHash("sha256")
            .update(readFileSync(path.join(
              drizzleDirectory,
              `${entry.tag}.sql`,
            )))
            .digest("hex"),
          entry.sqlSha256,
          `staged migration ${entry.idx} bytes differ from the reviewed ledger`,
        );
      }
    },
    async verifyAppliedMigrationLedgerPrefix(
      client,
      { requireComplete = false } = {},
    ) {
      const result = await verifyAppliedMigrationLedger(client, {
        requireComplete: false,
      });
      if (requireComplete) {
        assert.equal(
          result.appliedCount,
          expected.length,
          `database migration prefix through ${maximumIndex} is incomplete`,
        );
      }
      return result;
    },
  };
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

function apply0066WithDelegatedAcl(port, database) {
  const functionSealMarker = "DO $seal_function_acl$";
  const columnSealMarker = "DO $seal_column_acl$";
  const functionSealIndex = migration0066.indexOf(functionSealMarker);
  const columnSealIndex = migration0066.indexOf(columnSealMarker);
  assert.notEqual(functionSealIndex, -1);
  assert.notEqual(columnSealIndex, -1);
  assert.ok(functionSealIndex < columnSealIndex);

  const beforeFunctionSeal = migration0066.slice(0, functionSealIndex);
  const beforeColumnSeal = migration0066.slice(
    functionSealIndex,
    columnSealIndex,
  );
  const fromColumnSeal = migration0066.slice(columnSealIndex);
  const pendingRowId = fixture(4).id;
  const authorityColumns = [
    "provider_correlation_version",
    "provider_evidence_version",
    "provider_evidence_sha256",
  ];
  const mutationProof = authorityColumns.map((column) => `
    WITH changed AS (
      UPDATE public.email_outbox
         SET ${column} = ${column}
       WHERE id = '${pendingRowId}'::uuid
       RETURNING id
    )
    SELECT 1 / CASE WHEN pg_catalog.count(*) = 1 THEN 1 ELSE 0 END
      FROM changed;
  `).join("\n");

  psql(
    port,
    database,
    `
      SET ROLE learncoding_owner;
      ${beforeFunctionSeal}
      RESET ROLE;
      SET ROLE mail_acl_probe;
      GRANT EXECUTE ON FUNCTION
        public.enforce_email_outbox_provider_correlation_evidence()
        TO mail_acl_leaf;
      RESET ROLE;
      SELECT 1 / CASE WHEN pg_catalog.has_function_privilege(
        'mail_acl_leaf',
        'public.enforce_email_outbox_provider_correlation_evidence()',
        'EXECUTE'
      ) THEN 1 ELSE 0 END;

      SET ROLE learncoding_owner;
      ${beforeColumnSeal}
      GRANT SELECT ON TABLE public.email_outbox TO mail_acl_leaf;
      GRANT UPDATE (
        provider_correlation_version,
        provider_evidence_version,
        provider_evidence_sha256
      ) ON TABLE public.email_outbox
        TO mail_acl_probe WITH GRANT OPTION;
      RESET ROLE;
      SET ROLE mail_acl_probe;
      GRANT UPDATE (
        provider_correlation_version,
        provider_evidence_version,
        provider_evidence_sha256
      ) ON TABLE public.email_outbox TO mail_acl_leaf;
      RESET ROLE;
      SELECT 1 / CASE WHEN (
        NOT pg_catalog.has_table_privilege(
          'mail_acl_leaf',
          'public.email_outbox',
          'UPDATE'
        )
        AND pg_catalog.has_column_privilege(
          'mail_acl_leaf',
          'public.email_outbox',
          'provider_correlation_version',
          'UPDATE'
        )
        AND pg_catalog.has_column_privilege(
          'mail_acl_leaf',
          'public.email_outbox',
          'provider_evidence_version',
          'UPDATE'
        )
        AND pg_catalog.has_column_privilege(
          'mail_acl_leaf',
          'public.email_outbox',
          'provider_evidence_sha256',
          'UPDATE'
        )
      ) THEN 1 ELSE 0 END;
      SET ROLE mail_acl_leaf;
      ${mutationProof}
      RESET ROLE;

      SET ROLE learncoding_owner;
      ${fromColumnSeal}
    `,
    {
      username: "postgres",
      singleTransaction: true,
      timeoutMs: 60_000,
    },
  );
}

function ownerSql(port, database, sql) {
  return psql(
    port,
    database,
    `SET ROLE learncoding_owner;\n${sql}`,
    { username: "learncoding_migrator" },
  );
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

function fixture(number) {
  const tail = String(number).padStart(12, "0");
  return {
    id: `66000000-0000-4000-8000-${tail}`,
    operationId: `66100000-0000-4000-8000-${tail}`,
    sourceId: `66200000-0000-4000-8000-${tail}`,
    claimToken: `66300000-0000-4000-8000-${tail}`,
    suffix: String(number),
  };
}

function insertFixtureSql(row) {
  return `
INSERT INTO public.email_outbox (
  id, operation_id, user_id, delivery_scope_key, to_email, template,
  template_version, variables, idempotency_key, status, next_attempt_at,
  created_at, updated_at
) VALUES (
  '${row.id}'::uuid,
  '${row.operationId}'::uuid,
  NULL,
  's:${row.operationId}',
  'provider-correlation-${row.suffix}@example.invalid',
  'access-request-admin',
  '1',
  pg_catalog.jsonb_build_object(
    '_mailOperationId', '${row.operationId}',
    '_mailRecipient',
      'provider-correlation-${row.suffix}@example.invalid',
    '_mailProducer', 'access-request-admin',
    '_mailSourceId', '${row.sourceId}'
  ),
  'provider-correlation-${row.suffix}',
  'pending',
  pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp()
)`;
}

function claimFixtureSql(row) {
  return `
UPDATE public.email_outbox
   SET status = 'sending',
       attempt_count = 1,
       claim_token = '${row.claimToken}'::uuid,
       claim_owner = 'mail-provider-correlation-0066',
       claim_version = 1,
       lease_expires_at =
         pg_catalog.statement_timestamp() + interval '120 seconds',
       last_error_code = NULL,
       updated_at = pg_catalog.statement_timestamp()
 WHERE id = '${row.id}'::uuid`;
}

function insertAndClaim(port, database, row) {
  ownerSql(
    port,
    database,
    `${insertFixtureSql(row)};\n${claimFixtureSql(row)};`,
  );
}

function armSql(
  row,
  {
    adapter,
    bindingVersion,
    bindingDigest,
    correlationVersion = "opaque-sha256-v1",
    evidenceVersion = null,
    evidenceDigest = null,
  },
) {
  const sqlValue = (value) => value === null ? "NULL" : `'${value}'`;
  return `
UPDATE public.email_outbox
   SET provider_call_started = pg_catalog.statement_timestamp(),
       adapter = '${adapter}',
       dispatch_binding_version = ${sqlValue(bindingVersion)},
       dispatch_binding_sha256 = ${sqlValue(bindingDigest)},
       provider_correlation_version = ${sqlValue(correlationVersion)},
       provider_evidence_version = ${sqlValue(evidenceVersion)},
       provider_evidence_sha256 = ${sqlValue(evidenceDigest)},
       lease_expires_at =
         pg_catalog.statement_timestamp() + interval '60 seconds',
       updated_at = pg_catalog.statement_timestamp()
 WHERE id = '${row.id}'::uuid`;
}

function legacyArmSql(row, adapter, bindingVersion, bindingDigest) {
  return `
UPDATE public.email_outbox
   SET provider_call_started = pg_catalog.statement_timestamp(),
       adapter = '${adapter}',
       dispatch_binding_version = '${bindingVersion}',
       dispatch_binding_sha256 = '${bindingDigest}',
       lease_expires_at =
         pg_catalog.statement_timestamp() + interval '60 seconds',
       updated_at = pg_catalog.statement_timestamp()
 WHERE id = '${row.id}'::uuid`;
}

function seedPre0064Rows(port, database) {
  ownerSql(
    port,
    database,
    `
INSERT INTO public.email_outbox (
  id, operation_id, user_id, delivery_scope_key, to_email, template,
  template_version, variables, idempotency_key, status,
  provider_call_started, adapter, quarantined_at, last_error_code,
  created_at, updated_at
) VALUES
(
  '${fixture(1).id}'::uuid, '${fixture(1).operationId}'::uuid, NULL,
  'o:${fixture(1).operationId}', 'legacy-ambiguous@example.invalid',
  'weekly-summary', '1', '{}'::jsonb, 'provider-correlation-legacy-1',
  'quarantined', NULL, NULL, pg_catalog.statement_timestamp(),
  'LEGACY_SENDING_AMBIGUOUS', pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp()
),
(
  '${fixture(2).id}'::uuid, '${fixture(2).operationId}'::uuid, NULL,
  'o:${fixture(2).operationId}', 'legacy-gmail@example.invalid',
  'weekly-summary', '1', '{}'::jsonb, 'provider-correlation-legacy-2',
  'quarantined', pg_catalog.statement_timestamp(), 'gmail',
  pg_catalog.statement_timestamp(), 'GMAIL_RESULT_UNKNOWN',
  pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp()
),
(
  '${fixture(3).id}'::uuid, '${fixture(3).operationId}'::uuid, NULL,
  'o:${fixture(3).operationId}', 'legacy-console@example.invalid',
  'weekly-summary', '1', '{}'::jsonb, 'provider-correlation-legacy-3',
  'quarantined', pg_catalog.statement_timestamp(), 'console',
  pg_catalog.statement_timestamp(), 'CONSOLE_RESULT_UNKNOWN',
  pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp()
);
`,
  );
}

function seedPost0064Rows(port, database) {
  const legacyRawBound = fixture(5);
  ownerSql(
    port,
    database,
    `
${insertFixtureSql(fixture(4))};
${insertFixtureSql(legacyRawBound)};
${claimFixtureSql(legacyRawBound)};
`,
  );
  psql(
    port,
    database,
    `${legacyArmSql(
      legacyRawBound,
      "gmail",
      "gmail-raw-v1",
      "a".repeat(64),
    )};`,
    { username: "learncoding_worker" },
  );
}

function routineContract(port, database) {
  return scalar(
    port,
    database,
    `
      SELECT pg_catalog.current_setting('server_version_num') || '|' ||
             namespace.nspname || '|' ||
             routine.proname || '|' ||
             pg_catalog.pg_get_userbyid(routine.proowner) || '|' ||
             routine.prosecdef::text || '|' ||
             COALESCE(
               pg_catalog.array_to_string(routine.proconfig, ','),
               ''
             ) || '|' ||
             language.lanname || '|' ||
             routine.prokind::text || '|' ||
             routine.provolatile::text || '|' ||
             routine.proisstrict::text || '|' ||
             routine.proparallel::text || '|' ||
             routine.proleakproof::text || '|' ||
             pg_catalog.cardinality(
               COALESCE(routine.proargnames, '{}'::text[])
             )::text || '|' ||
             pg_catalog.cardinality(
               COALESCE(routine.proargmodes, '{}'::"char"[])
             )::text || '|' ||
             pg_catalog.cardinality(
               COALESCE(
                 routine.proallargtypes,
                 routine.proargtypes::pg_catalog.oid[]
               )
             )::text || '|' ||
             routine.pronargs::text || '|' ||
             routine.pronargdefaults::text || '|' ||
             (routine.proargdefaults IS NULL)::text || '|' ||
             pg_catalog.format_type(routine.prorettype, NULL) || '|' ||
             routine.proretset::text || '|' ||
             (routine.provariadic <> 0)::text || '|' ||
             routine.procost::text || '|' ||
             routine.prorows::text || '|' ||
             (routine.prosupport = 0)::text || '|' ||
             pg_catalog.cardinality(
               COALESCE(routine.protrftypes, '{}'::pg_catalog.oid[])
             )::text || '|' ||
             (routine.probin IS NULL)::text || '|' ||
             (routine.prosqlbody IS NULL)::text || '|' ||
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
        JOIN pg_catalog.pg_namespace namespace
          ON namespace.oid = routine.pronamespace
        JOIN pg_catalog.pg_language language
          ON language.oid = routine.prolang
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
               CASE WHEN acl.grantor = 0
                 THEN 'PUBLIC'
                 ELSE pg_catalog.pg_get_userbyid(acl.grantor)
               END || '->' ||
               CASE WHEN acl.grantee = 0
                 THEN 'PUBLIC'
                 ELSE pg_catalog.pg_get_userbyid(acl.grantee)
               END || ':' || acl.privilege_type || ':' ||
               acl.is_grantable::text,
               ',' ORDER BY acl.grantor, acl.grantee,
                 acl.privilege_type
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
               CASE WHEN acl.grantor = 0
                 THEN 'PUBLIC'
                 ELSE pg_catalog.pg_get_userbyid(acl.grantor)
               END || '->' ||
               CASE WHEN acl.grantee = 0
                 THEN 'PUBLIC'
                 ELSE pg_catalog.pg_get_userbyid(acl.grantee)
               END || ':' || acl.privilege_type || ':' ||
               acl.is_grantable::text,
               ',' ORDER BY attribute.attname, acl.grantor,
                 acl.grantee, acl.privilege_type
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

function columnContract(port, database) {
  return scalar(
    port,
    database,
    `
      SELECT pg_catalog.string_agg(
               attribute.attname || ':' ||
               pg_catalog.format_type(
                 attribute.atttypid,
                 attribute.atttypmod
               ) || ':' ||
               attribute.atttypmod::text || ':' ||
               attribute.attnotnull::text || ':' ||
               attribute.atthasdef::text || ':' ||
               attribute.attgenerated::text || ':' ||
               attribute.attidentity::text || ':' ||
               attribute.attisdropped::text,
               ',' ORDER BY attribute.attname
             )
        FROM pg_catalog.pg_attribute attribute
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

function constraintExpressionHash(port, database) {
  return scalar(
    port,
    database,
    `
      SELECT pg_catalog.encode(
               pg_catalog.sha256(
                 pg_catalog.convert_to(
                   pg_catalog.regexp_replace(
                     pg_catalog.regexp_replace(
                       pg_catalog.pg_get_expr(
                         constraint_data.conbin,
                         constraint_data.conrelid,
                         true
                       ),
                       '"?email_outbox"?[.]',
                       '',
                       'g'
                     ),
                     '[[:space:]"]',
                     '',
                     'g'
                   ),
                   'UTF8'
                 )
               ),
               'hex'
             )
        FROM pg_catalog.pg_constraint constraint_data
       WHERE constraint_data.conrelid =
         'public.email_outbox'::pg_catalog.regclass
         AND constraint_data.conname =
           'email_outbox_provider_correlation_evidence_valid';
    `,
  );
}

function proveCatalog(port, database) {
  const routine = routineContract(port, database);
  assert.match(
    routine,
    new RegExp(
      `^${postgresMajor}[0-9]{4}\\|public\\|`
      + "enforce_email_outbox_provider_correlation_evidence\\|"
      + "learncoding_owner\\|false\\|search_path=pg_catalog\\|"
      + "plpgsql\\|f\\|v\\|false\\|u\\|false\\|"
      + "0\\|0\\|0\\|0\\|0\\|true\\|trigger\\|false\\|false\\|"
      + "100\\|0\\|true\\|0\\|true\\|true\\|"
      + "62ff4885055979fb7eaf0fda3ae8170a14a430cb69d8f310e6aba742cf700e1a\\|"
      + "afaab6796f97aa0294ff5a761679895f9ccfb78fea21e0be362979c5c4e5ab11$",
      "u",
    ),
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT pg_catalog.pg_get_userbyid(relation.relowner)
         FROM pg_catalog.pg_class relation
        WHERE relation.oid = 'public.email_outbox'::pg_catalog.regclass;`,
    ),
    "learncoding_owner",
  );
  assert.equal(
    functionAcl(port, database),
    "learncoding_owner->learncoding_owner:EXECUTE:false",
  );
  assert.equal(
    columnAcl(port, database),
    [
      "provider_correlation_version:learncoding_owner->learncoding_worker:UPDATE:false",
      "provider_evidence_sha256:learncoding_owner->learncoding_worker:UPDATE:false",
      "provider_evidence_version:learncoding_owner->learncoding_worker:UPDATE:false",
    ].join(","),
  );
  assert.equal(
    columnContract(port, database),
    [
      "provider_correlation_version:text:-1:false:false:::false",
      "provider_evidence_sha256:text:-1:false:false:::false",
      "provider_evidence_version:text:-1:false:false:::false",
    ].join(","),
  );
  assert.equal(
    scalar(
      port,
      database,
      `
        SELECT trigger.tgname || '|' ||
               pg_catalog.pg_get_userbyid(relation.relowner) || '|' ||
               trigger.tgenabled::text || '|' ||
               trigger.tgtype::text || '|' ||
               (trigger.tgfoid =
                 'public.enforce_email_outbox_provider_correlation_evidence()'
                   ::pg_catalog.regprocedure)::text || '|' ||
               (pg_catalog.pg_get_expr(
                 trigger.tgqual,
                 trigger.tgrelid
               ) IS NULL)::text || '|' ||
               (trigger.tgnargs = 0)::text || '|' ||
               (pg_catalog.octet_length(trigger.tgargs) = 0)::text || '|' ||
               (pg_catalog.cardinality(
                 trigger.tgattr::smallint[]
               ) = 0)::text || '|' ||
               trigger.tgisinternal::text
          FROM pg_catalog.pg_trigger trigger
          JOIN pg_catalog.pg_class relation
            ON relation.oid = trigger.tgrelid
         WHERE trigger.tgrelid =
           'public.email_outbox'::pg_catalog.regclass
           AND trigger.tgname =
             'email_outbox_provider_correlation_evidence_guard'
           AND NOT trigger.tgisinternal;
      `,
    ),
    "email_outbox_provider_correlation_evidence_guard|learncoding_owner|"
      + "O|23|true|true|true|true|true|false",
  );
  assert.equal(
    scalar(
      port,
      database,
      `
        SELECT pg_catalog.pg_get_userbyid(relation.relowner) || '|' ||
               constraint_data.contype::text || '|' ||
               constraint_data.convalidated::text || '|' ||
               constraint_data.connoinherit::text || '|' ||
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
                    ORDER BY attribute.attname
                 ),
                 ','
               )
          FROM pg_catalog.pg_constraint constraint_data
          JOIN pg_catalog.pg_class relation
            ON relation.oid = constraint_data.conrelid
         WHERE constraint_data.conrelid =
           'public.email_outbox'::pg_catalog.regclass
           AND constraint_data.conname =
             'email_outbox_provider_correlation_evidence_valid';
      `,
    ),
    "learncoding_owner|c|true|false|adapter,claim_owner,claim_token,"
      + "claim_version,dispatch_binding_sha256,dispatch_binding_version,"
      + "last_error_code,lease_expires_at,provider_call_started,"
      + "provider_correlation_version,provider_evidence_sha256,"
      + "provider_evidence_version,provider_message_id,quarantined_at,"
      + "sent_at,status",
  );
  assert.equal(
    constraintExpressionHash(port, database),
    "02a5367ba5c5eed54bc69732c38f1517fa05d7321aaad3c11d30200ee6b06dc8",
  );
  return routine;
}

function proveDelegatedAclRevocation(port, database) {
  assert.equal(
    scalar(
      port,
      database,
      `SELECT pg_catalog.has_function_privilege(
         'mail_acl_leaf',
         'public.enforce_email_outbox_provider_correlation_evidence()',
         'EXECUTE'
       )::text;`,
    ),
    "false",
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT pg_catalog.has_table_privilege(
         'mail_acl_leaf',
         'public.email_outbox',
         'UPDATE'
       )::text;`,
    ),
    "false",
  );
  for (const column of [
    "provider_correlation_version",
    "provider_evidence_version",
    "provider_evidence_sha256",
  ]) {
    assert.equal(
      scalar(
        port,
        database,
        `SELECT pg_catalog.has_column_privilege(
           'mail_acl_leaf',
           'public.email_outbox',
           '${column}',
           'UPDATE'
         )::text;`,
      ),
      "false",
    );
    expectSqlState(
      port,
      database,
      "postgres",
      `UPDATE public.email_outbox
          SET ${column} = ${column}
        WHERE id = '${fixture(4).id}'::uuid`,
      "42501",
      "SET ROLE mail_acl_leaf;",
    );
  }
}

function proveBackfill(port, database) {
  assert.equal(
    scalar(
      port,
      database,
      `
        SELECT pg_catalog.string_agg(
                 id::text || '|' ||
                 COALESCE(provider_correlation_version, 'NULL') || '|' ||
                 COALESCE(provider_evidence_version, 'NULL') || '|' ||
                 COALESCE(provider_evidence_sha256, 'NULL') || '|' ||
                 COALESCE(dispatch_binding_version, 'NULL') || '|' ||
                 COALESCE(dispatch_binding_sha256, 'NULL'),
                 ',' ORDER BY id
               )
          FROM public.email_outbox
         WHERE id >= '${fixture(1).id}'::uuid
           AND id <= '${fixture(5).id}'::uuid;
      `,
    ),
    [
      `${fixture(1).id}|legacy-raw-v0|NULL|NULL|NULL|NULL`,
      `${fixture(2).id}|legacy-raw-v0|NULL|NULL|NULL|NULL`,
      `${fixture(3).id}|legacy-raw-v0|NULL|NULL|NULL|NULL`,
      `${fixture(4).id}|NULL|NULL|NULL|NULL|NULL`,
      `${fixture(5).id}|legacy-raw-v0|NULL|NULL|gmail-raw-v1|${
        "a".repeat(64)
      }`,
    ].join(","),
  );
}

function proveWorkerPrivileges(port, database) {
  assert.equal(
    scalar(
      port,
      database,
      `
        SELECT rolsuper::text || '|' || rolinherit::text || '|' ||
               rolcreaterole::text || '|' || rolcreatedb::text || '|' ||
               rolreplication::text || '|' || rolbypassrls::text
          FROM pg_catalog.pg_roles
         WHERE rolname = 'learncoding_worker';
      `,
    ),
    "false|false|false|false|false|false",
  );
  assert.equal(
    scalar(
      port,
      database,
      `
        SELECT pg_catalog.pg_has_role(
                 'learncoding_worker', 'learncoding_owner', 'MEMBER'
               )::text || '|' ||
               pg_catalog.pg_has_role(
                 'learncoding_worker', 'learncoding_migrator', 'MEMBER'
               )::text || '|' ||
               pg_catalog.pg_has_role(
                 'learncoding_worker', 'learncoding_app', 'MEMBER'
               )::text || '|' ||
               pg_catalog.pg_has_role(
                 'learncoding_worker', 'learncoding_ops', 'MEMBER'
               )::text;
      `,
    ),
    "false|false|false|false",
  );
  assert.equal(
    scalar(
      port,
      database,
      `
        SELECT pg_catalog.has_table_privilege(
                 'learncoding_worker', 'public.email_outbox', 'SELECT'
               )::text || '|' ||
               pg_catalog.has_table_privilege(
                 'learncoding_worker', 'public.email_outbox', 'INSERT'
               )::text || '|' ||
               pg_catalog.has_table_privilege(
                 'learncoding_worker', 'public.email_outbox', 'UPDATE'
               )::text || '|' ||
               pg_catalog.has_table_privilege(
                 'learncoding_worker', 'public.email_outbox', 'DELETE'
               )::text || '|' ||
               pg_catalog.has_table_privilege(
                 'learncoding_worker', 'public.email_outbox', 'TRUNCATE'
               )::text || '|' ||
               pg_catalog.has_table_privilege(
                 'learncoding_worker', 'public.email_outbox', 'REFERENCES'
               )::text || '|' ||
               pg_catalog.has_table_privilege(
                 'learncoding_worker', 'public.email_outbox', 'TRIGGER'
               )::text;
      `,
    ),
    "true|false|false|false|false|false|false",
  );
  assert.equal(
    scalar(
      port,
      database,
      `
        SELECT pg_catalog.string_agg(attribute.attname, ',' ORDER BY attribute.attnum)
          FROM pg_catalog.pg_attribute attribute
         WHERE attribute.attrelid =
                 'public.email_outbox'::pg_catalog.regclass
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND pg_catalog.has_column_privilege(
                 'learncoding_worker',
                 'public.email_outbox',
                 attribute.attname,
                 'INSERT'
               );
      `,
    ),
    [
      "user_id",
      "to_email",
      "template",
      "template_version",
      "variables",
      "idempotency_key",
      "status",
      "next_attempt_at",
      "operation_id",
      "delivery_scope_key",
    ].join(","),
  );
  assert.equal(
    scalar(
      port,
      database,
      `
        SELECT pg_catalog.string_agg(attribute.attname, ',' ORDER BY attribute.attnum)
          FROM pg_catalog.pg_attribute attribute
         WHERE attribute.attrelid =
                 'public.email_outbox'::pg_catalog.regclass
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND pg_catalog.has_column_privilege(
                 'learncoding_worker',
                 'public.email_outbox',
                 attribute.attname,
                 'UPDATE'
               );
      `,
    ),
    [
      "status",
      "attempt_count",
      "next_attempt_at",
      "sent_at",
      "last_error_code",
      "updated_at",
      "claim_token",
      "claim_owner",
      "claim_version",
      "lease_expires_at",
      "provider_call_started",
      "adapter",
      "provider_message_id",
      "quarantined_at",
      "dispatch_binding_version",
      "dispatch_binding_sha256",
      "provider_correlation_version",
      "provider_evidence_version",
      "provider_evidence_sha256",
    ].join(","),
  );
  assert.equal(
    scalar(
      port,
      database,
      `
        WITH grants AS (
          SELECT acl.grantor = relation.relowner grantor_exact,
                 acl.is_grantable
            FROM pg_catalog.pg_class relation
            CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(
                relation.relacl,
                pg_catalog.acldefault('r', relation.relowner)
              )
            ) acl
           WHERE relation.oid = 'public.email_outbox'::pg_catalog.regclass
             AND acl.grantee = pg_catalog.to_regrole('learncoding_worker')
          UNION ALL
          SELECT acl.grantor = relation.relowner grantor_exact,
                 acl.is_grantable
            FROM pg_catalog.pg_attribute attribute
            JOIN pg_catalog.pg_class relation
              ON relation.oid = attribute.attrelid
            CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) acl
           WHERE attribute.attrelid =
                   'public.email_outbox'::pg_catalog.regclass
             AND acl.grantee = pg_catalog.to_regrole('learncoding_worker')
        )
        SELECT COALESCE(pg_catalog.bool_and(grantor_exact), false)::text
               || '|' ||
               COALESCE(pg_catalog.bool_or(is_grantable), false)::text
          FROM grants;
      `,
    ),
    "true|false",
  );
}

function proveCatalogGrantProbe(port, database) {
  const aclBefore = scalar(
    port,
    database,
    `SELECT COALESCE(relacl::text, '')
       FROM pg_catalog.pg_class
      WHERE oid = 'public.email_outbox'::pg_catalog.regclass;`,
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT pg_catalog.has_table_privilege(
         'mail_grant_probe', 'public.email_outbox', 'SELECT'
       )::text;`,
    ),
    "false",
  );
  psql(
    port,
    database,
    "GRANT SELECT ON TABLE public.email_outbox TO mail_grant_probe;",
    { username: "learncoding_worker" },
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT pg_catalog.has_table_privilege(
         'mail_grant_probe', 'public.email_outbox', 'SELECT'
       )::text;`,
    ),
    "false",
    "object GRANT without grant option must be proven by catalog state",
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT COALESCE(relacl::text, '')
         FROM pg_catalog.pg_class
        WHERE oid = 'public.email_outbox'::pg_catalog.regclass;`,
    ),
    aclBefore,
  );
}

function proveTransitionMatrix(port, database) {
  const gmail = fixture(20);
  const consoleRow = fixture(21);
  const oldWorker = fixture(22);
  const partial = fixture(23);
  const wrongConsole = fixture(24);
  const legacyNew = fixture(25);
  const malformed = fixture(26);
  const appAttempt = fixture(27);
  const opsAttempt = fixture(28);
  const ownerAttempt = fixture(29);
  const impersonated = fixture(30);
  for (const row of [
    gmail,
    consoleRow,
    oldWorker,
    partial,
    wrongConsole,
    legacyNew,
    malformed,
    appAttempt,
    opsAttempt,
    ownerAttempt,
    impersonated,
  ]) {
    insertAndClaim(port, database, row);
  }

  psql(
    port,
    database,
    `${armSql(gmail, {
      adapter: "gmail",
      bindingVersion: "gmail-raw-v1",
      bindingDigest: "b".repeat(64),
      evidenceVersion: "gmail-header-evidence-v1",
      evidenceDigest: "c".repeat(64),
    })};`,
    { username: "learncoding_worker" },
  );
  psql(
    port,
    database,
    `${armSql(consoleRow, {
      adapter: "console",
      bindingVersion: "console-json-v1",
      bindingDigest: "d".repeat(64),
    })};`,
    { username: "learncoding_worker" },
  );
  expectSqlState(
    port,
    database,
    "learncoding_worker",
    legacyArmSql(oldWorker, "gmail", "gmail-raw-v1", "e".repeat(64)),
    "23514",
  );
  expectSqlState(
    port,
    database,
    "learncoding_worker",
    armSql(partial, {
      adapter: "gmail",
      bindingVersion: "gmail-raw-v1",
      bindingDigest: "f".repeat(64),
    }),
    "23514",
  );
  expectSqlState(
    port,
    database,
    "learncoding_worker",
    armSql(wrongConsole, {
      adapter: "console",
      bindingVersion: "console-json-v1",
      bindingDigest: "1".repeat(64),
      evidenceVersion: "gmail-header-evidence-v1",
      evidenceDigest: "2".repeat(64),
    }),
    "23514",
  );
  expectSqlState(
    port,
    database,
    "learncoding_worker",
    armSql(legacyNew, {
      adapter: "gmail",
      bindingVersion: "gmail-raw-v1",
      bindingDigest: "3".repeat(64),
      correlationVersion: "legacy-raw-v0",
    }),
    "23514",
  );
  expectSqlState(
    port,
    database,
    "learncoding_worker",
    armSql(malformed, {
      adapter: "gmail",
      bindingVersion: "gmail-raw-v1",
      bindingDigest: "4".repeat(64),
      evidenceVersion: "gmail-header-evidence-v1",
      evidenceDigest: "not-a-sha256",
    }),
    "23514",
  );

  ownerSql(
    port,
    database,
    "GRANT UPDATE ON TABLE public.email_outbox "
      + "TO learncoding_app, learncoding_ops;",
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT pg_catalog.has_table_privilege(
         'learncoding_app', 'public.email_outbox', 'UPDATE'
       )::text || '|' ||
       pg_catalog.has_table_privilege(
         'learncoding_ops', 'public.email_outbox', 'UPDATE'
       )::text;`,
    ),
    "true|true",
    "P3-2 broad app/ops DML remains explicitly deferred",
  );
  const privilegedArm = (row) => armSql(row, {
    adapter: "gmail",
    bindingVersion: "gmail-raw-v1",
    bindingDigest: "5".repeat(64),
    evidenceVersion: "gmail-header-evidence-v1",
    evidenceDigest: "6".repeat(64),
  });
  expectSqlState(
    port,
    database,
    "learncoding_app",
    privilegedArm(appAttempt),
    "42501",
  );
  expectSqlState(
    port,
    database,
    "learncoding_ops",
    privilegedArm(opsAttempt),
    "42501",
  );
  ownerSql(
    port,
    database,
    "REVOKE UPDATE ON TABLE public.email_outbox "
      + "FROM learncoding_app, learncoding_ops;",
  );
  expectSqlState(
    port,
    database,
    "learncoding_migrator",
    privilegedArm(ownerAttempt),
    "42501",
    "SET ROLE learncoding_owner;",
  );
  expectSqlState(
    port,
    database,
    "postgres",
    privilegedArm(impersonated),
    "42501",
    "SET ROLE learncoding_worker;",
  );

  expectSqlState(
    port,
    database,
    "learncoding_worker",
    `UPDATE public.email_outbox
        SET provider_evidence_sha256 = '${"7".repeat(64)}'
      WHERE id = '${gmail.id}'::uuid`,
    "23514",
  );
  psql(
    port,
    database,
    `UPDATE public.email_outbox
        SET status = 'sent',
            provider_message_id = 'gmail-provider-correlation-0066',
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
              dispatch_binding_sha256 || '|' ||
              provider_correlation_version || '|' ||
              provider_evidence_version || '|' ||
              provider_evidence_sha256 || '|' ||
              provider_message_id
         FROM public.email_outbox
        WHERE id = '${gmail.id}'::uuid;`,
    ),
    `sent|gmail|gmail-raw-v1|${"b".repeat(64)}|`
      + `opaque-sha256-v1|gmail-header-evidence-v1|${"c".repeat(64)}|`
      + "gmail-provider-correlation-0066",
  );
  expectSqlState(
    port,
    database,
    "learncoding_migrator",
    `INSERT INTO public.email_outbox (
       operation_id, user_id, delivery_scope_key, to_email, template,
       template_version, variables, idempotency_key, status,
       next_attempt_at, provider_correlation_version
     ) VALUES (
       '${fixture(31).operationId}'::uuid, NULL,
       'o:${fixture(31).operationId}', 'invalid-insert@example.invalid',
       'weekly-summary', '1', '{}'::jsonb,
       'provider-correlation-invalid-insert', 'pending',
       pg_catalog.statement_timestamp(), 'opaque-sha256-v1'
     )`,
    "23514",
    "SET ROLE learncoding_owner;",
  );
}

function newArtifactState(port, database) {
  return scalar(
    port,
    database,
    `
      SELECT (
               SELECT pg_catalog.count(*)
                 FROM pg_catalog.pg_attribute attribute
                WHERE attribute.attrelid =
                        'public.email_outbox'::pg_catalog.regclass
                  AND attribute.attname = ANY (ARRAY[
                    'provider_correlation_version',
                    'provider_evidence_version',
                    'provider_evidence_sha256'
                  ]::pg_catalog.name[])
                  AND NOT attribute.attisdropped
             )::text || '|' ||
             (
               pg_catalog.to_regprocedure(
                 'public.enforce_email_outbox_provider_correlation_evidence()'
               ) IS NULL
             )::text || '|' ||
             (
               SELECT pg_catalog.count(*)
                 FROM pg_catalog.pg_trigger trigger
                WHERE trigger.tgrelid =
                        'public.email_outbox'::pg_catalog.regclass
                  AND trigger.tgname =
                        'email_outbox_provider_correlation_evidence_guard'
                  AND NOT trigger.tgisinternal
             )::text || '|' ||
             (
               SELECT pg_catalog.count(*)
                 FROM pg_catalog.pg_constraint constraint_data
                WHERE constraint_data.conrelid =
                        'public.email_outbox'::pg_catalog.regclass
                  AND constraint_data.conname =
                        'email_outbox_provider_correlation_evidence_valid'
             )::text;
    `,
  );
}

function provePreflightRejection(port, database, row) {
  const rowBefore = scalar(
    port,
    database,
    `SELECT pg_catalog.md5(pg_catalog.to_jsonb(outbox)::text)
       FROM public.email_outbox outbox
      WHERE id = '${row.id}'::uuid;`,
  );
  assert.throws(
    () => apply0066(port, database),
    /provider correlation predecessor state is invalid/u,
  );
  assert.equal(newArtifactState(port, database), "0|true|0|0");
  assert.equal(
    scalar(
      port,
      database,
      `SELECT pg_catalog.md5(pg_catalog.to_jsonb(outbox)::text)
         FROM public.email_outbox outbox
        WHERE id = '${row.id}'::uuid;`,
    ),
    rowBefore,
  );
}

function proveLateFailureRollback(port, database) {
  const functionBefore = scalar(
    port,
    database,
    `
      SELECT pg_catalog.encode(
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
  assert.throws(
    () => apply0066(port, database),
    /already exists/u,
  );
  assert.equal(newArtifactState(port, database), "0|false|0|0");
  assert.equal(
    scalar(
      port,
      database,
      `
        SELECT pg_catalog.encode(
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
    ),
    functionBefore,
  );
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
  const baselineMigrations = stagedMigrationsThrough(temporaryRoot, 63);
  const predecessorMigrations = stagedMigrationsThrough(
    temporaryRoot,
    64,
  );
  const baselineVerifier = prefixMigrationVerifier(63);
  const predecessorVerifier = prefixMigrationVerifier(64);
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
        CREATE ROLE mail_grant_probe NOLOGIN NOINHERIT;
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
      verifyReviewedMigrationRepository:
        baselineVerifier.verifyReviewedMigrationRepository,
      verifyAppliedMigrationLedger:
        baselineVerifier.verifyAppliedMigrationLedgerPrefix,
    });
    const scenarioDatabases = [
      "mail0066_absent",
      "mail0066_present",
      "mail0066_invalid",
      "mail0066_tamper",
      "mail0066_late_failure",
    ];
    for (const database of scenarioDatabases) {
      run(executable("createdb"), [
        "--host=127.0.0.1",
        `--port=${port}`,
        "--username=postgres",
        "--owner=learncoding_owner",
        "--template=mail0066_template",
        database,
      ]);
    }
    for (const database of ["mail0066_absent", "mail0066_present"]) {
      seedPre0064Rows(port, database);
    }
    for (const database of scenarioDatabases) {
      await runProductionMigration({
        connectionString:
          `postgresql://learncoding_migrator@127.0.0.1:${port}/${database}`,
        migrationsFolder: predecessorMigrations,
        verifyReviewedMigrationRepository:
          predecessorVerifier.verifyReviewedMigrationRepository,
        verifyAppliedMigrationLedger:
          predecessorVerifier.verifyAppliedMigrationLedgerPrefix,
      });
    }
    for (const database of ["mail0066_absent", "mail0066_present"]) {
      seedPost0064Rows(port, database);
    }
    ownerSql(
      port,
      "mail0066_invalid",
      `${insertFixtureSql(fixture(90))};
       UPDATE public.email_outbox
          SET status = 'failed',
              last_error_code = 'LEGACY_SENDING_AMBIGUOUS',
              updated_at = pg_catalog.statement_timestamp()
        WHERE id = '${fixture(90).id}'::uuid;`,
    );
    ownerSql(
      port,
      "mail0066_tamper",
      `${insertFixtureSql(fixture(91))};
       ALTER FUNCTION public.enforce_email_outbox_dispatch_binding()
         SECURITY DEFINER;`,
    );
    ownerSql(
      port,
      "mail0066_late_failure",
      `
        CREATE FUNCTION
          public.enforce_email_outbox_provider_correlation_evidence()
        RETURNS trigger
        LANGUAGE plpgsql
        SECURITY INVOKER
        SET search_path = pg_catalog
        AS $dummy$
        BEGIN
          RETURN NEW;
        END
        $dummy$;
      `,
    );
    provePreflightRejection(
      port,
      "mail0066_invalid",
      fixture(90),
    );
    provePreflightRejection(
      port,
      "mail0066_tamper",
      fixture(91),
    );
    proveLateFailureRollback(port, "mail0066_late_failure");

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
        CREATE ROLE mail_acl_probe NOLOGIN NOINHERIT;
        CREATE ROLE mail_acl_leaf NOLOGIN NOINHERIT;
        ALTER DEFAULT PRIVILEGES FOR ROLE learncoding_owner
          IN SCHEMA public
          GRANT EXECUTE ON FUNCTIONS TO learncoding_owner
          WITH GRANT OPTION;
        ALTER DEFAULT PRIVILEGES FOR ROLE learncoding_owner
          IN SCHEMA public
          GRANT EXECUTE ON FUNCTIONS
          TO learncoding_backup_reporter, mail_default_grantee;
        ALTER DEFAULT PRIVILEGES FOR ROLE learncoding_owner
          IN SCHEMA public
          GRANT EXECUTE ON FUNCTIONS TO mail_acl_probe
          WITH GRANT OPTION;
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
    assert.equal(
      scalar(
        port,
        "mail0066_present",
        `
          SELECT COALESCE(
                   pg_catalog.bool_or(
                     acl.grantee =
                       pg_catalog.to_regrole('learncoding_owner')
                     AND acl.is_grantable
                   ),
                   false
                 )::text
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
      ),
      "true",
      "the owner grant-option poison fixture must be effective before 0066",
    );
    assert.equal(
      scalar(
        port,
        "mail0066_present",
        `
          SELECT COALESCE(
                   pg_catalog.bool_or(
                     acl.grantee =
                       pg_catalog.to_regrole('mail_acl_probe')
                     AND acl.is_grantable
                   ),
                   false
                 )::text
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
      ),
      "true",
      "the delegated probe must inherit function grant option before 0066",
    );
    apply0066WithDelegatedAcl(port, "mail0066_present");

    const absentContract = proveCatalog(port, "mail0066_absent");
    const presentContract = proveCatalog(port, "mail0066_present");
    assert.equal(absentContract, presentContract);
    proveBackfill(port, "mail0066_absent");
    proveBackfill(port, "mail0066_present");
    proveWorkerPrivileges(port, "mail0066_absent");
    proveDelegatedAclRevocation(port, "mail0066_present");
    proveCatalogGrantProbe(port, "mail0066_absent");
    proveTransitionMatrix(port, "mail0066_absent");
    process.stdout.write(
      `mail_provider_correlation_0066=postgres:${postgresMajor}:catalog:pass\n`,
    );
    process.stdout.write(
      `mail_provider_correlation_0066=routine:${absentContract}\n`,
    );
    process.stdout.write(
      "mail_provider_correlation_0066=constraint_sha256:"
        + `${constraintExpressionHash(port, "mail0066_absent")}\n`,
    );
    process.stdout.write(
      "mail_provider_correlation_0066=backfill:pass\n",
    );
    process.stdout.write(
      "mail_provider_correlation_0066=privileges:pass\n",
    );
    process.stdout.write(
      "mail_provider_correlation_0066=transitions:pass\n",
    );
    process.stdout.write(
      "mail_provider_correlation_0066=rollback_and_tamper:pass\n",
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
