#!/usr/bin/env node

import assert from "node:assert/strict";
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
const migration0067 = path.join(
  migrationDirectory,
  "0067_mail_outbox_quarantine_redaction_authority_v2.sql",
);
const predecessor0065 =
  process.env.MAIL_0067_PREDECESSOR_0065_SQL?.trim()
  || path.join(migrationDirectory, "0065_backup_status_mail_authority.sql");
const predecessor0066 =
  process.env.MAIL_0067_PREDECESSOR_0066_SQL?.trim()
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
  ["0065 predecessor", predecessor0065],
  ["0066 predecessor", predecessor0066],
  ["0067 component", migration0067],
]) {
  assert.ok(existsSync(candidate), `${label} SQL is missing: ${candidate}`);
}

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
    .map((name) => readFileSync(path.join(migrationDirectory, name), "utf8"))
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
                  (
                    CASE WHEN acl.grantee = 0
                      THEN 'PUBLIC'
                      ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                    END
                  ) || '|' || acl.privilege_type || '|' ||
                  acl.is_grantable::text
                  ORDER BY
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
             ARRAY['learncoding_owner|EXECUTE|false']::text[]
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
                  (
                    CASE WHEN acl.grantee = 0
                      THEN 'PUBLIC'
                      ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                    END
                  ) || '|' || acl.privilege_type || '|' ||
                  acl.is_grantable::text
                  ORDER BY
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
         'learncoding_ops|EXECUTE|false',
         'learncoding_owner|EXECUTE|false'
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
                  (
                    CASE WHEN acl.grantee = 0
                      THEN 'PUBLIC'
                      ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                    END
                  ) || '|' || acl.privilege_type || '|' ||
                  acl.is_grantable::text
                  ORDER BY
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
             ARRAY['learncoding_owner|EXECUTE|false']::text[]
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
ALTER TABLE public.email_outbox DISABLE TRIGGER USER;

INSERT INTO public."user" (id, name, email)
VALUES (
  'retention-0067-user',
  'Retention 0067 User',
  'retention-0067-user@example.invalid'
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
  'retention-0067-user',
  'account-secret@example.invalid',
  'weekly-summary',
  '1',
  '{"secret":"account-pii"}'::jsonb,
  'retention-0067-account',
  '67100000-0000-4000-8000-000000000001',
  'a:retention-0067-user',
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
  'retention-0067-system',
  '67100000-0000-4000-8000-000000000002',
  's:67100000-0000-4000-8000-000000000002',
  'quarantined',
  3, NULL, NULL, 8, NULL,
  '2025-01-02T00:00:00Z', 'gmail',
  'gmail-raw-v1', repeat('c', 64),
  'gmail-message-0067-2', 'opaque-sha256-v1',
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
  'retention-0067-console',
  '67100000-0000-4000-8000-000000000003',
  'o:67100000-0000-4000-8000-000000000003',
  'quarantined',
  2, NULL, NULL, 7, NULL,
  '2025-01-02T00:00:00Z', 'console',
  'console-json-v1', repeat('e', 64),
  'console-message-0067-3', 'opaque-sha256-v1',
  NULL, NULL,
  '2025-01-03T00:00:00Z', NULL,
  '2025-01-04T00:00:00Z', 'CONSOLE_RESULT_UNKNOWN',
  '2025-01-01T00:00:00Z', '2025-01-07T00:00:00Z'
),
(
  '67000000-0000-4000-8000-000000000004',
  'retention-0067-user',
  'partial-evidence-secret@example.invalid',
  'weekly-summary',
  '1',
  '{"secret":"partial-evidence-pii"}'::jsonb,
  'retention-0067-partial-evidence',
  '67100000-0000-4000-8000-000000000004',
  'a:retention-0067-user',
  'quarantined',
  5, NULL, NULL, 10, NULL,
  '2025-01-02T00:00:00Z', 'gmail',
  'gmail-raw-v1', repeat('f', 64),
  'gmail-message-0067-4', 'opaque-sha256-v1',
  'gmail-header-evidence-v1', NULL,
  '2025-01-03T00:00:00Z', NULL,
  '2025-01-04T00:00:00Z', 'GMAIL_PARTIAL_EVIDENCE',
  '2025-01-01T00:00:00Z', '2025-01-08T00:00:00Z'
),
(
  '67000000-0000-4000-8000-000000000005',
  'retention-0067-user',
  'malformed-scope-secret@example.invalid',
  'weekly-summary',
  '1',
  '{"secret":"malformed-scope-pii"}'::jsonb,
  'retention-0067-malformed-scope',
  '67100000-0000-4000-8000-000000000005',
  'damaged:retention-0067-user',
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
  'retention-0067-user',
  'held-secret@example.invalid',
  'weekly-summary',
  '1',
  '{"secret":"held-pii"}'::jsonb,
  'retention-0067-held',
  '67100000-0000-4000-8000-000000000006',
  'a:retention-0067-user',
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
  'retention-0067-user',
  'recent-secret@example.invalid',
  'weekly-summary',
  '1',
  '{"secret":"recent-pii"}'::jsonb,
  'retention-0067-recent',
  '67100000-0000-4000-8000-000000000007',
  'a:retention-0067-user',
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
  'retention-0067-legacy',
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

ALTER TABLE public.email_outbox ENABLE TRIGGER USER;`,
  );
}

async function proveRuntime(port, database) {
  assert.equal(catalogContract(port, database), "true");

  applyAsOwner(
    port,
    database,
    `ALTER FUNCTION
       public.classify_email_outbox_quarantine_redaction_v2(
         public.email_outbox,
         timestamp with time zone
       ) SET search_path = public;`,
  );
  assert.equal(
    catalogContract(port, database),
    "false",
    "catalog tamper escaped the exact verifier",
  );
  applyAsOwner(port, database, readFileSync(migration0067, "utf8"));
  assert.equal(
    catalogContract(port, database),
    "true",
    "idempotent migration replay did not heal catalog tamper",
  );

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
CREATE FUNCTION public.mail_redaction_0067_tamper_probe()
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
ALTER FUNCTION public.mail_redaction_0067_tamper_probe()
  OWNER TO learncoding_owner;
REVOKE ALL ON FUNCTION public.mail_redaction_0067_tamper_probe()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mail_redaction_0067_tamper_probe()
  TO learncoding_ops;`,
  );
  await expectSqlState(
    port,
    database,
    "learncoding_ops",
    "SELECT public.mail_redaction_0067_tamper_probe();",
    "23514",
  );
  applyAsOwner(
    port,
    database,
    "DROP FUNCTION public.mail_redaction_0067_tamper_probe();",
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
  assert.equal(reportOnly, "eligible|5|0,blocked|1|0,malformed|1|0");
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
  assert.equal(applied, "eligible|5|5,blocked|1|0,malformed|1|1");
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
        WHERE id IN (
          '67000000-0000-4000-8000-000000000001',
          '67000000-0000-4000-8000-000000000002',
          '67000000-0000-4000-8000-000000000003',
          '67000000-0000-4000-8000-000000000004',
          '67000000-0000-4000-8000-000000000005',
          '67000000-0000-4000-8000-000000000008'
        )
          AND to_email =
                'redacted+' || id::text || '@invalid.local';`,
    ),
    "6",
    "an aged released quarantine retained its recipient",
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT to_email
         FROM public.email_outbox
        WHERE id = '67000000-0000-4000-8000-000000000006';`,
    ),
    "held-secret@example.invalid",
    "held authority was redacted before release",
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
    `gmail-message-0067-4|opaque-sha256-v1|`
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
    path.join(os.tmpdir(), `codestead-mail-redaction-0067-pg${postgresMajor}-`),
  );
  const dataDirectory = path.join(temporaryRoot, "data");
  const logFile = path.join(temporaryRoot, "postgres.log");
  const database = "mail_redaction_0067";
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
CREATE ROLE learncoding_backup_reporter LOGIN NOINHERIT;`,
    );
    run(executable("createdb"), [
      "--host=127.0.0.1",
      `--port=${port}`,
      "--username=postgres",
      "--owner=learncoding_owner",
      database,
    ]);
    applyAsOwner(port, database, reviewedSqlThrough0064());
    applyAsOwner(port, database, readFileSync(predecessor0065, "utf8"));
    applyAsOwner(port, database, readFileSync(predecessor0066, "utf8"));
    applyAsOwner(port, database, readFileSync(migration0067, "utf8"));
    await proveRuntime(port, database);

    process.stdout.write("mail_redaction_0067=catalog_acl:pass\n");
    process.stdout.write("mail_redaction_0067=tamper_repair:pass\n");
    process.stdout.write("mail_redaction_0067=scope_matrix:pass\n");
    process.stdout.write("mail_redaction_0067=provider_matrix:pass\n");
    process.stdout.write("mail_redaction_0067=no_resend:pass\n");
    process.stdout.write(
      `mail_redaction_0067=postgres:${postgresMajor}:${version}:pass\n`,
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
