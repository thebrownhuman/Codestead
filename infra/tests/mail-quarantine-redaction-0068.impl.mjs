#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { allocateDisposableLoopbackPort } from
  "../../scripts/lib/disposable-loopback-port.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");
const migrationDirectory = path.join(repositoryRoot, "drizzle");
const LIBPQ_ENVIRONMENT_KEYS = Object.freeze([
  "PGAPPNAME",
  "PGDATABASE",
  "PGHOST",
  "PGHOSTADDR",
  "PGOPTIONS",
  "PGPASSFILE",
  "PGPASSWORD",
  "PGPORT",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGSSLMODE",
  "PGTARGETSESSIONATTRS",
  "PGUSER",
]);
for (const key of LIBPQ_ENVIRONMENT_KEYS) delete process.env[key];

const selected = [
  ["17", process.env.POSTGRES_17_BIN],
  ["18", process.env.POSTGRES_18_BIN],
].filter(([, binaryDirectory]) => binaryDirectory !== undefined);
assert.equal(
  selected.length,
  1,
  "exactly one of POSTGRES_17_BIN or POSTGRES_18_BIN must be set",
);
const [expectedMajor, postgresBinValue] = selected[0];
const postgresBin = postgresBinValue?.trim();
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const database = "mail_quarantine_redaction_0068";
// migrationFilesThrough(66) -> seedQuiescentFixtures -> migration0067 ->
// installClaimStateFixtures -> migration0068

const childEnvironment = Object.freeze({
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  PGCONNECT_TIMEOUT: "5",
});

assert.ok(postgresBin, "the selected PostgreSQL binary directory is empty");

function executable(name) {
  const candidate = path.join(postgresBin, `${name}${executableSuffix}`);
  assert.ok(existsSync(candidate), `missing PostgreSQL executable: ${candidate}`);
  return candidate;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: childEnvironment,
    input: options.input,
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.stdio,
    timeout: options.timeoutMs ?? 120_000,
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

function connectionArgs(port, targetDatabase, username = "postgres") {
  return [
    "--host=127.0.0.1",
    `--port=${port}`,
    `--username=${username}`,
    `--dbname=${targetDatabase}`,
    "--no-psqlrc",
  ];
}

function psql(port, targetDatabase, sql, options = {}) {
  return run(
    executable("psql"),
    [
      ...connectionArgs(port, targetDatabase, options.username),
      "--set=ON_ERROR_STOP=1",
      "--set=VERBOSITY=verbose",
      "--quiet",
      ...(options.scalar ? ["--tuples-only", "--no-align"] : []),
    ],
    {
      input: sql,
      allowFailure: options.allowFailure,
      timeoutMs: options.timeoutMs,
    },
  );
}

function scalar(port, targetDatabase, sql, username = "postgres") {
  return psql(port, targetDatabase, sql, {
    username,
    scalar: true,
  }).stdout.trim();
}

function migrationFilesThrough(limit) {
  const names = readdirSync(migrationDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .filter((name) => Number.parseInt(name.slice(0, 4), 10) <= limit)
    .sort();
  assert.equal(names.length, limit + 1);
  names.forEach((name, expectedIndex) => {
    assert.equal(Number.parseInt(name.slice(0, 4), 10), expectedIndex);
  });
  return names.map((name) => path.join(migrationDirectory, name));
}

function ownerTransactionSql(sql) {
  return `
BEGIN;
DO $migration_session_assertion$
BEGIN
  IF session_user <> 'learncoding_migrator'
     OR current_user <> 'learncoding_migrator'
  THEN
    RAISE EXCEPTION '0068 harness migration session identity is invalid'
      USING ERRCODE = '42501';
  END IF;
END
$migration_session_assertion$;
SET ROLE learncoding_owner;
DO $migration_owner_assertion$
BEGIN
  IF session_user <> 'learncoding_migrator'
     OR current_user <> 'learncoding_owner'
  THEN
    RAISE EXCEPTION '0068 harness delegated owner identity is invalid'
      USING ERRCODE = '42501';
  END IF;
END
$migration_owner_assertion$;
${sql}
RESET ROLE;
DO $migration_reset_assertion$
BEGIN
  IF session_user <> 'learncoding_migrator'
     OR current_user <> 'learncoding_migrator'
  THEN
    RAISE EXCEPTION '0068 harness migration role reset is invalid'
      USING ERRCODE = '42501';
  END IF;
END
$migration_reset_assertion$;
COMMIT;`;
}

function applyAsOwner(port, sql, options = {}) {
  return psql(
    port,
    database,
    ownerTransactionSql(sql),
    {
      allowFailure: options.allowFailure,
      timeoutMs: options.timeoutMs ?? 180_000,
      username: "learncoding_migrator",
    },
  );
}

const FIXTURE_IDS = Object.freeze({
  "eligible-account": "68000000-0000-4000-8000-000000000001",
  "eligible-system": "68000000-0000-4000-8000-000000000002",
  "eligible-system-audience": "68000000-0000-4000-8000-000000000003",
  "eligible-operation": "68000000-0000-4000-8000-000000000004",
  "partial-claim": "68000000-0000-4000-8000-000000000005",
  "expired-claim": "68000000-0000-4000-8000-000000000006",
  "live-claim": "68000000-0000-4000-8000-000000000007",
  "already-redacted": "68000000-0000-4000-8000-000000000008",
  malformed: "68000000-0000-4000-8000-000000000009",
  "malformed-system-shaped": "68000000-0000-4000-8000-000000000010",
  "live-malformed": "68000000-0000-4000-8000-000000000011",
  "batch-oldest-a": "68000000-0000-4000-8000-000000000012",
  "batch-oldest-b": "68000000-0000-4000-8000-000000000013",
  "batch-next": "68000000-0000-4000-8000-000000000014",
});

const FIXTURE_USER_ID = "retention-0068-user";
const FIXTURE_SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const FIXTURE_AUDIENCE_ID = "22222222-2222-4222-8222-222222222222";

function sqlLiteral(value) {
  if (value === null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function makeQuiescentFixture(label, options = {}) {
  const id = FIXTURE_IDS[label];
  const operationId = id.replace("68000000", "68100000");
  const userId = options.userId === undefined
    ? FIXTURE_USER_ID
    : options.userId;
  const recipient = options.redacted
    ? `redacted+${id}@invalid.local`
    : `${label}@example.invalid`;
  const system = options.system === true;
  const variables = options.redacted
    ? {}
    : system
      ? {
          _mailOperationId: operationId,
          _mailRecipient: recipient,
          _mailProducer: "access-request-approved",
          _mailSourceId: FIXTURE_SOURCE_ID,
          ...(options.audience
            ? { _mailAudienceId: FIXTURE_AUDIENCE_ID }
            : {}),
        }
      : { private: label };
  return {
    id,
    operationId,
    userId,
    recipient,
    scope: options.operationScope
      ? `o:${operationId}`
      : system
        ? `s:${operationId}`
        : userId === null ? `o:${operationId}` : `a:${userId}`,
    template: system ? "invitation" : "weekly-summary",
    variables,
    quarantinedAt: options.quarantinedAt ?? "2025-01-01T00:00:00Z",
  };
}

function seedFixtureRows(port) {
  const rows = [
    makeQuiescentFixture("eligible-account"),
    makeQuiescentFixture("eligible-system", { system: true, userId: null }),
    makeQuiescentFixture("eligible-system-audience", {
      audience: true,
      system: true,
      userId: null,
    }),
    makeQuiescentFixture("eligible-operation", { userId: null }),
    makeQuiescentFixture("partial-claim"),
    makeQuiescentFixture("expired-claim"),
    makeQuiescentFixture("live-claim"),
    makeQuiescentFixture("already-redacted", { redacted: true }),
    makeQuiescentFixture("malformed", { userId: null }),
    makeQuiescentFixture("malformed-system-shaped", {
      system: true,
      operationScope: true,
      userId: null,
    }),
    makeQuiescentFixture("live-malformed", { userId: null }),
    makeQuiescentFixture("batch-oldest-a", {
      quarantinedAt: "2024-01-01T00:00:00Z",
    }),
    makeQuiescentFixture("batch-oldest-b", {
      quarantinedAt: "2024-01-01T00:00:00Z",
    }),
    makeQuiescentFixture("batch-next", {
      quarantinedAt: "2024-02-01T00:00:00Z",
    }),
  ];
  const values = rows.map((row, index) => `(
    ${sqlLiteral(row.id)}, ${sqlLiteral(row.operationId)},
    ${sqlLiteral(row.userId)}, ${sqlLiteral(row.scope)},
    ${sqlLiteral(row.recipient)}, ${sqlLiteral(row.template)}, '1',
    ${sqlLiteral(JSON.stringify(row.variables))}::jsonb,
    ${sqlLiteral(`retention-0068-${index + 1}`)}, 'quarantined', 0,
    '2025-01-01T00:00:00Z', ${sqlLiteral(row.quarantinedAt)},
    'RETENTION_0068_FIXTURE', '2025-01-01T00:00:00Z',
    '2025-01-01T00:00:00Z'
  )`).join(",\n");
  applyAsOwner(port, `
    INSERT INTO public."user" (
      id, name, email, email_verified, role, status, banned,
      must_change_password
    ) VALUES (
      '${FIXTURE_USER_ID}', 'Retention 0068 User',
      'retention-0068@example.invalid', true, 'learner', 'active', false, false
    );
    INSERT INTO public.email_outbox (
      id, operation_id, user_id, delivery_scope_key, to_email, template,
      template_version, variables, idempotency_key, status, claim_version,
      next_attempt_at, quarantined_at, last_error_code, created_at, updated_at
    ) VALUES ${values};
  `);
}

function seedQuiescentFixtures(port) {
  seedFixtureRows(port);
}

function installProtectedProviderEvidence(port) {
  applyAsOwner(port, `
    ALTER TABLE public.email_outbox
      DISABLE TRIGGER email_outbox_dispatch_binding_guard;
    ALTER TABLE public.email_outbox
      DISABLE TRIGGER email_outbox_provider_correlation_evidence_guard;
    UPDATE public.email_outbox
       SET attempt_count = 1,
           provider_call_started = '2025-01-01T00:00:00Z'::timestamptz,
           adapter = 'gmail',
           dispatch_binding_version = 'gmail-raw-v1',
           dispatch_binding_sha256 = '${"a".repeat(64)}',
           provider_correlation_version = 'opaque-sha256-v1',
           provider_evidence_version = 'gmail-header-evidence-v1',
           provider_evidence_sha256 = '${"b".repeat(64)}',
           provider_message_id = 'retention-0068-expired-gmail-message'
     WHERE id = '${FIXTURE_IDS["expired-claim"]}'::uuid;
    ALTER TABLE public.email_outbox
      ENABLE ALWAYS TRIGGER
        email_outbox_provider_correlation_evidence_guard;
    ALTER TABLE public.email_outbox
      ENABLE ALWAYS TRIGGER email_outbox_dispatch_binding_guard;
  `);
}

function installFixtureClaimsAndMalformedStates(port) {
  applyAsOwner(port, `
    ALTER TABLE public.email_outbox
      DISABLE TRIGGER email_outbox_delivery_hold;
    UPDATE public.email_outbox
       SET claim_token = '68300000-0000-4000-8000-000000000005',
           claim_version = 1
     WHERE id = '${FIXTURE_IDS["partial-claim"]}'::uuid;
    UPDATE public.email_outbox
       SET claim_owner = 'retention-0068-owner-only', claim_version = 1
     WHERE id = '${FIXTURE_IDS.malformed}'::uuid;
    UPDATE public.email_outbox
       SET claim_version = 1,
           lease_expires_at = pg_catalog.statement_timestamp() + interval '1 day'
     WHERE id = '${FIXTURE_IDS["malformed-system-shaped"]}'::uuid;

    UPDATE public.email_outbox
       SET claim_token = '68300000-0000-4000-8000-000000000006',
           claim_owner = 'retention-0068-expired', claim_version = 1,
           lease_expires_at = '2025-01-02T00:00:00Z'::timestamptz
     WHERE id = '${FIXTURE_IDS["expired-claim"]}'::uuid;
    UPDATE public.email_outbox
       SET claim_token = '68300000-0000-4000-8000-000000000007',
           claim_owner = 'retention-0068-live', claim_version = 1,
           lease_expires_at = pg_catalog.statement_timestamp() + interval '1 day'
     WHERE id = '${FIXTURE_IDS["live-claim"]}'::uuid;
    UPDATE public.email_outbox
       SET claim_token = '68300000-0000-4000-8000-000000000011',
           claim_owner = 'retention-0068-live-malformed', claim_version = 1,
           lease_expires_at = pg_catalog.statement_timestamp() + interval '1 day'
     WHERE id = '${FIXTURE_IDS["live-malformed"]}'::uuid;
    ALTER TABLE public.email_outbox
      ENABLE ALWAYS TRIGGER email_outbox_delivery_hold;
  `);
}

function assertFinal0067Hold(port) {
  assert.equal(
    scalar(port, database, `
      SELECT (
        (SELECT tgenabled = 'A'
           FROM pg_catalog.pg_trigger
          WHERE tgrelid = 'public.email_outbox'::pg_catalog.regclass
            AND tgname = 'email_outbox_delivery_hold'
            AND NOT tgisinternal)
        AND (SELECT tgenabled = 'O'
           FROM pg_catalog.pg_trigger
          WHERE tgrelid = 'public.email_outbox'::pg_catalog.regclass
            AND tgname = 'email_outbox_payload_immutable'
            AND NOT tgisinternal)
        AND (SELECT tgenabled = 'A'
           FROM pg_catalog.pg_trigger
          WHERE tgrelid = 'public.email_outbox'::pg_catalog.regclass
            AND tgname = 'email_outbox_dispatch_binding_guard'
            AND NOT tgisinternal)
        AND (SELECT tgenabled = 'A'
           FROM pg_catalog.pg_trigger
          WHERE tgrelid = 'public.email_outbox'::pg_catalog.regclass
            AND tgname =
                  'email_outbox_provider_correlation_evidence_guard'
            AND NOT tgisinternal)
        AND (SELECT
               attempt_count = 1
               AND provider_call_started =
                     '2025-01-01T00:00:00Z'::timestamptz
               AND adapter = 'gmail'
               AND dispatch_binding_version = 'gmail-raw-v1'
               AND dispatch_binding_sha256 = '${"a".repeat(64)}'
               AND provider_correlation_version = 'opaque-sha256-v1'
               AND provider_evidence_version =
                     'gmail-header-evidence-v1'
               AND provider_evidence_sha256 = '${"b".repeat(64)}'
               AND provider_message_id =
                     'retention-0068-expired-gmail-message'
             FROM public.email_outbox
            WHERE id = '${FIXTURE_IDS["expired-claim"]}'::uuid)
      )::text;`),
    "true",
  );
  const denied = psql(port, database, `
    BEGIN;
    SET ROLE learncoding_owner;
    UPDATE public.email_outbox
       SET claim_version = claim_version + 1
     WHERE id = '${FIXTURE_IDS["eligible-account"]}'::uuid;
  `, {
    allowFailure: true,
    username: "learncoding_migrator",
  });
  assert.notEqual(denied.status, 0);
  assert.match(
    `${denied.stdout}${denied.stderr}`,
    /email outbox delivery remains held for task7-v1/u,
  );
}

function installClaimStateFixtures(port) {
  installFixtureClaimsAndMalformedStates(port);
}

function poison0068DefaultAcl(port) {
  applyAsOwner(port, `
    GRANT USAGE ON SCHEMA public TO
      learncoding_app,
      learncoding_worker,
      learncoding_migrator,
      learncoding_backup_reporter,
      learncoding_acl_default,
      learncoding_acl_grantor,
      learncoding_acl_leaf;
    ALTER DEFAULT PRIVILEGES FOR ROLE learncoding_owner IN SCHEMA public
      GRANT EXECUTE ON FUNCTIONS TO learncoding_acl_grantor
      WITH GRANT OPTION;
    ALTER DEFAULT PRIVILEGES FOR ROLE learncoding_owner IN SCHEMA public
      GRANT EXECUTE ON FUNCTIONS TO learncoding_acl_default;
    GRANT EXECUTE ON FUNCTION
      public.enforce_email_outbox_payload_immutable()
      TO learncoding_acl_grantor WITH GRANT OPTION;
    GRANT EXECUTE ON FUNCTION
      public.enforce_email_outbox_payload_immutable()
      TO learncoding_acl_default;
  `);
}

function repoisonExisting0068Acl(port) {
  applyAsOwner(port, `
    GRANT EXECUTE ON FUNCTION
      public.classify_email_outbox_quarantine_redaction_v2(
        public.email_outbox, timestamp with time zone
      ),
      public.enforce_email_outbox_payload_immutable(),
      public.redact_quarantined_email_outbox_authority_v2(
        timestamp with time zone, integer
      ) TO learncoding_acl_default;
    GRANT EXECUTE ON FUNCTION
      public.classify_email_outbox_quarantine_redaction_v2(
        public.email_outbox, timestamp with time zone
      ),
      public.enforce_email_outbox_payload_immutable(),
      public.redact_quarantined_email_outbox_authority_v2(
        timestamp with time zone, integer
      ) TO learncoding_acl_grantor WITH GRANT OPTION;
    SET ROLE learncoding_acl_grantor;
    GRANT EXECUTE ON FUNCTION
      public.classify_email_outbox_quarantine_redaction_v2(
        public.email_outbox, timestamp with time zone
      ),
      public.enforce_email_outbox_payload_immutable(),
      public.redact_quarantined_email_outbox_authority_v2(
        timestamp with time zone, integer
      ) TO learncoding_acl_leaf WITH GRANT OPTION;
    RESET ROLE;
    SET ROLE learncoding_owner;
  `);
}

function injectHostile0068Acl(migration0068) {
  const marker = "DO $scrub_function_acls$";
  assert.equal(migration0068.split(marker).length, 2);
  const hostileAcl = `
    SET ROLE learncoding_acl_grantor;
    GRANT EXECUTE ON FUNCTION
      public.classify_email_outbox_quarantine_redaction_v2(
        public.email_outbox, timestamp with time zone
      ) TO learncoding_acl_leaf WITH GRANT OPTION;
    GRANT EXECUTE ON FUNCTION
      public.enforce_email_outbox_payload_immutable()
      TO learncoding_acl_leaf WITH GRANT OPTION;
    GRANT EXECUTE ON FUNCTION
      public.redact_quarantined_email_outbox_authority_v2(
        timestamp with time zone, integer
      ) TO learncoding_acl_leaf WITH GRANT OPTION;
    RESET ROLE;
    SET ROLE learncoding_owner;
  `;
  return migration0068.replace(marker, `${hostileAcl}\n${marker}`);
}

function assertDenied(port, username, sql) {
  const denied = psql(port, database, sql, {
    allowFailure: true,
    username,
  });
  assert.notEqual(denied.status, 0, `${username} unexpectedly executed SQL`);
  assert.match(
    `${denied.stdout}${denied.stderr}`,
    /ERROR:\s+42501:\s+permission denied for function redact_quarantined_email_outbox_authority_v2/u,
  );
}

function assertMigratorDelegationCannotInvokeRedactor(port) {
  const denied = psql(port, database, `
    BEGIN;
    SET ROLE learncoding_owner;
    DO $delegated_owner_assertion$
    BEGIN
      IF session_user <> 'learncoding_migrator'
         OR current_user <> 'learncoding_owner'
      THEN
        RAISE EXCEPTION '0068 delegated owner test identity is invalid'
          USING ERRCODE = '42501';
      END IF;
    END
    $delegated_owner_assertion$;
    SELECT *
      FROM public.redact_quarantined_email_outbox_authority_v2(
        pg_catalog.statement_timestamp() - interval '31 days',
        0
      );
  `, {
    allowFailure: true,
    username: "learncoding_migrator",
  });
  assert.notEqual(denied.status, 0);
  assert.match(
    `${denied.stdout}${denied.stderr}`,
    /ERROR:\s+42501:\s+email outbox redaction caller is not authorized/u,
  );
}

function assertDelegatedOwnerCannotMutatePayload(port) {
  const before = piiDigest(port);
  const denied = psql(port, database, `
    BEGIN;
    SET ROLE learncoding_owner;
    DO $delegated_payload_assertion$
    BEGIN
      IF session_user <> 'learncoding_migrator'
         OR current_user <> 'learncoding_owner'
      THEN
        RAISE EXCEPTION '0068 delegated payload test identity is invalid'
          USING ERRCODE = '42501';
      END IF;
    END
    $delegated_payload_assertion$;
    UPDATE public.email_outbox
       SET to_email =
             'redacted+${FIXTURE_IDS["eligible-account"]}@invalid.local',
           variables = '{}'::pg_catalog.jsonb,
           updated_at = pg_catalog.statement_timestamp()
     WHERE id = '${FIXTURE_IDS["eligible-account"]}'::pg_catalog.uuid;
  `, {
    allowFailure: true,
    username: "learncoding_migrator",
  });
  assert.notEqual(denied.status, 0);
  assert.match(
    `${denied.stdout}${denied.stderr}`,
    /ERROR:\s+23514:\s+email_outbox[.]to_email is immutable/u,
  );
  assert.equal(
    piiDigest(port),
    before,
    "delegated owner payload denial must roll back exactly",
  );
}

const PROTECTED_AUTHORITY_COLUMNS = Object.freeze([
  "idempotency_authority_version",
  "idempotency_authority_sha256",
  "idempotency_original_payload_sha256",
  "delivery_hold_version",
  "provider_correlation_version",
  "provider_evidence_sha256",
  "dispatch_binding_sha256",
  "operation_id",
  "claim_token",
  "lease_expires_at",
]);

function protectedDigest(port) {
  assert.ok(PROTECTED_AUTHORITY_COLUMNS.length >= 10);
  return scalar(port, database, `
    SELECT pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(pg_catalog.string_agg(
          outbox.id::text || pg_catalog.chr(31) ||
          (pg_catalog.to_jsonb(outbox)
            - 'to_email' - 'variables' - 'updated_at')::text,
          pg_catalog.chr(30) ORDER BY outbox.id
        ), ''),
        'UTF8'
      )),
      'hex'
    )
    FROM public.email_outbox AS outbox
    WHERE outbox.id::text LIKE '68000000-%';
  `);
}

function authorityDigest(port) {
  assert.ok(
    Number.parseInt(scalar(port, database, `
      SELECT pg_catalog.count(*)::text
        FROM public.email_outbox_idempotency_authority;
    `), 10) > 0,
    "0068 authority digest fixture must be non-empty",
  );
  return scalar(port, database, `
    SELECT pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(pg_catalog.string_agg(
          authority.idempotency_sha256 || pg_catalog.chr(31) ||
          pg_catalog.to_jsonb(authority)::text,
          pg_catalog.chr(30) ORDER BY authority.idempotency_sha256
        ), ''),
        'UTF8'
      )),
      'hex'
    )
    FROM public.email_outbox_idempotency_authority AS authority;
  `);
}


function predecessorCatalogDigest(port) {
  return scalar(port, database, `
    WITH catalog_state(kind, identity, definition) AS (
      SELECT
        'function'::pg_catalog.text,
        routine.oid::pg_catalog.regprocedure::pg_catalog.text,
        pg_catalog.pg_get_functiondef(routine.oid)
        FROM pg_catalog.pg_proc AS routine
       WHERE routine.oid IN (
         'public.enforce_email_outbox_delivery_hold()'
           ::pg_catalog.regprocedure,
         'public.email_outbox_idempotency_coverage_authority(
            pg_catalog.uuid[]
          )'::pg_catalog.regprocedure
       )
      UNION ALL
      SELECT
        'trigger'::pg_catalog.text,
        trigger_row.tgname::pg_catalog.text,
        pg_catalog.pg_get_triggerdef(trigger_row.oid, true)
        FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid =
               'public.email_outbox'::pg_catalog.regclass
         AND trigger_row.tgname = 'email_outbox_delivery_hold'
         AND NOT trigger_row.tgisinternal
    )
    SELECT pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(
        pg_catalog.string_agg(
          kind || pg_catalog.chr(31) || identity || pg_catalog.chr(31) ||
            definition,
          pg_catalog.chr(30) ORDER BY kind, identity
        ),
        'UTF8'
      )),
      'hex'
    )
      FROM catalog_state;
  `);
}

function assertStableProtectedState(port, expected, label) {
  assert.equal(protectedDigest(port), expected.protected, `${label}: protected`);
  assert.equal(authorityDigest(port), expected.authority, `${label}: authority`);
}
function piiDigest(port) {
  return scalar(port, database, `
    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      COALESCE(pg_catalog.string_agg(
        outbox.id::text || pg_catalog.chr(31) || outbox.to_email ||
        pg_catalog.chr(31) || outbox.variables::text,
        pg_catalog.chr(30) ORDER BY outbox.id
      ), ''), 'UTF8')), 'hex')
      FROM public.email_outbox AS outbox
     WHERE outbox.id::text LIKE '68000000-%';
  `);
}

function assertRedactedFixtureState(port) {
  const rows = JSON.parse(scalar(port, database, `
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', id::text, 'toEmail', to_email, 'variables', variables
    ) ORDER BY id)::text
      FROM public.email_outbox
     WHERE id::text LIKE '68000000-%';
  `));
  assert.equal(rows.length, 14);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const expectedEmail = (label) =>
    `redacted+${FIXTURE_IDS[label]}@invalid.local`;
  for (const label of [
    "eligible-account",
    "eligible-operation",
    "partial-claim",
    "expired-claim",
    "malformed",
    "malformed-system-shaped",
    "batch-oldest-a",
    "batch-oldest-b",
    "batch-next",
  ]) {
    assert.deepEqual(byId.get(FIXTURE_IDS[label]), {
      id: FIXTURE_IDS[label],
      toEmail: expectedEmail(label),
      variables: {},
    });
  }
  for (const label of ["eligible-system", "eligible-system-audience"]) {
    const id = FIXTURE_IDS[label];
    const operationId = id.replace("68000000", "68100000");
    const expectedVariables = {
      _mailOperationId: operationId,
      _mailRecipient: expectedEmail(label),
      _mailProducer: "access-request-approved",
      _mailSourceId: FIXTURE_SOURCE_ID,
      ...(label === "eligible-system-audience"
        ? { _mailAudienceId: FIXTURE_AUDIENCE_ID }
        : {}),
    };
    assert.deepEqual(byId.get(id), {
      id,
      toEmail: expectedEmail(label),
      variables: expectedVariables,
    });
  }
  for (const label of ["live-claim", "live-malformed"]) {
    assert.deepEqual(byId.get(FIXTURE_IDS[label]), {
      id: FIXTURE_IDS[label],
      toEmail: `${label}@example.invalid`,
      variables: { private: label },
    });
  }
  assert.deepEqual(byId.get(FIXTURE_IDS["already-redacted"]), {
    id: FIXTURE_IDS["already-redacted"],
    toEmail: expectedEmail("already-redacted"),
    variables: {},
  });
}

function routineAcl(port, signature) {
  return scalar(port, database, `
    SELECT COALESCE(
      pg_catalog.array_agg(
        pg_catalog.pg_get_userbyid(access.grantee) || '|' ||
        pg_catalog.pg_get_userbyid(access.grantor) || '|' ||
        pg_catalog.lower(access.privilege_type) || '|' ||
        access.is_grantable::text
        ORDER BY pg_catalog.pg_get_userbyid(access.grantee),
                 pg_catalog.pg_get_userbyid(access.grantor),
                 access.privilege_type,
                 access.is_grantable
      )::text,
      '{}'
    )
      FROM pg_catalog.pg_proc AS routine
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
      ) AS access
     WHERE routine.oid = ${sqlLiteral(signature)}::pg_catalog.regprocedure;
  `);
}

function assertCatalogAndAcl(port) {
  assert.equal(
    scalar(
      port,
      database,
      `
SELECT (
  (
    SELECT pg_catalog.pg_get_userbyid(p.proowner) = 'learncoding_owner'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND p.proconfig = ARRAY['search_path=pg_catalog']::text[]
      FROM pg_catalog.pg_proc AS p
     WHERE p.oid =
       'public.classify_email_outbox_quarantine_redaction_v2(
          public.email_outbox,timestamp with time zone
        )'::pg_catalog.regprocedure
  )
  AND (
    SELECT pg_catalog.pg_get_userbyid(p.proowner) = 'learncoding_owner'
       AND NOT p.prosecdef
       AND p.provolatile = 'v'
       AND p.proconfig = ARRAY['search_path=pg_catalog']::text[]
      FROM pg_catalog.pg_proc AS p
     WHERE p.oid =
       'public.enforce_email_outbox_payload_immutable()'
         ::pg_catalog.regprocedure
  )
  AND (
    SELECT pg_catalog.pg_get_userbyid(p.proowner) = 'learncoding_owner'
       AND p.prosecdef
       AND p.provolatile = 'v'
       AND p.proconfig = ARRAY['search_path=pg_catalog']::text[]
      FROM pg_catalog.pg_proc AS p
     WHERE p.oid =
       'public.redact_quarantined_email_outbox_authority_v2(
          timestamp with time zone,integer
        )'::pg_catalog.regprocedure
  )
  AND (
    SELECT t.tgenabled = 'A'
      FROM pg_catalog.pg_trigger AS t
     WHERE t.tgrelid = 'public.email_outbox'::pg_catalog.regclass
       AND t.tgname = 'email_outbox_payload_immutable'
       AND NOT t.tgisinternal
  )
  AND pg_catalog.to_regprocedure(
        'public.redact_unresolved_email_outbox_authority(
           timestamp with time zone,integer
         )'
      ) IS NULL
  AND pg_catalog.to_regprocedure(
        'public.classify_email_outbox_retention_redaction(
           public.email_outbox,timestamp with time zone
         )'
      ) IS NULL
  AND pg_catalog.has_function_privilege(
        'learncoding_ops',
        'public.redact_quarantined_email_outbox_authority_v2(
           timestamp with time zone,integer
         )',
        'EXECUTE'
      )
  AND NOT pg_catalog.has_function_privilege(
        'learncoding_app',
        'public.redact_quarantined_email_outbox_authority_v2(
           timestamp with time zone,integer
         )',
        'EXECUTE'
      )
  AND NOT pg_catalog.has_function_privilege(
        'learncoding_worker',
        'public.redact_quarantined_email_outbox_authority_v2(
           timestamp with time zone,integer
         )',
        'EXECUTE'
      )
  AND NOT pg_catalog.has_function_privilege(
        'learncoding_migrator',
        'public.redact_quarantined_email_outbox_authority_v2(
           timestamp with time zone,integer
         )',
        'EXECUTE'
      )
  AND NOT pg_catalog.has_function_privilege(
        'learncoding_ops',
        'public.classify_email_outbox_quarantine_redaction_v2(
           public.email_outbox,timestamp with time zone
         )',
        'EXECUTE'
      )
  AND NOT pg_catalog.has_function_privilege(
        'learncoding_ops',
        'public.enforce_email_outbox_payload_immutable()',
        'EXECUTE'
      )
)::text;`,
    ),
    "true",
  );

  assert.equal(
    routineAcl(
      port,
      "public.classify_email_outbox_quarantine_redaction_v2(public.email_outbox,timestamp with time zone)",
    ),
    "{learncoding_owner|learncoding_owner|execute|false}",
  );
  assert.equal(
    routineAcl(port, "public.enforce_email_outbox_payload_immutable()"),
    "{learncoding_owner|learncoding_owner|execute|false}",
  );
  assert.equal(
    routineAcl(
      port,
      "public.redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)",
    ),
    "{learncoding_ops|learncoding_owner|execute|false,learncoding_owner|learncoding_owner|execute|false}",
  );

  assert.equal(
    scalar(port, database, `
      WITH expected(
        role_name, classifier, trigger_helper, redactor
      ) AS (
        VALUES
          ('learncoding_owner', true, true, true),
          ('learncoding_ops', false, false, true),
          ('learncoding_app', false, false, false),
          ('learncoding_worker', false, false, false),
          ('learncoding_migrator', false, false, false),
          ('learncoding_backup_reporter', false, false, false),
          ('learncoding_acl_default', false, false, false),
          ('learncoding_acl_grantor', false, false, false),
          ('learncoding_acl_leaf', false, false, false)
      )
      SELECT pg_catalog.bool_and(
        pg_catalog.has_function_privilege(
          role_name::text,
          'public.classify_email_outbox_quarantine_redaction_v2(
             public.email_outbox,timestamp with time zone
           )',
          'EXECUTE'
        ) = classifier
        AND pg_catalog.has_function_privilege(
          role_name::text,
          'public.enforce_email_outbox_payload_immutable()',
          'EXECUTE'
        ) = trigger_helper
        AND pg_catalog.has_function_privilege(
          role_name::text,
          'public.redact_quarantined_email_outbox_authority_v2(
             timestamp with time zone,integer
           )',
          'EXECUTE'
        ) = redactor
      )::text
        FROM expected;
    `),
    "true",
  );

  for (const username of [
    "learncoding_app",
    "learncoding_worker",
    "learncoding_migrator",
    "learncoding_backup_reporter",
    "learncoding_acl_default",
    "learncoding_acl_leaf",
  ]) {
    assertDenied(port, username, `
      SELECT *
        FROM public.redact_quarantined_email_outbox_authority_v2(
          '2025-01-01T00:00:00Z'::timestamptz,
          0
        );
    `);
  }
}


function transitionedTotal(summary) {
  const transitioned = summary.split(",").map((entry) => {
    const value = Number.parseInt(entry.split(":")[2], 10);
    assert.ok(Number.isSafeInteger(value));
    assert.ok(value >= 0);
    return value;
  });
  return transitioned.reduce((total, value) => total + value, 0);
}

function runRedactionSummary(port, batchLimit) {
  assert.ok(Number.isInteger(batchLimit));
  assert.ok(batchLimit >= 0 && batchLimit <= 5000);
  const summary = scalar(port, database, `
    SELECT pg_catalog.string_agg(
             disposition || ':' || eligible::pg_catalog.text || ':' ||
               transitioned::pg_catalog.text,
             ',' ORDER BY disposition
           )
      FROM public.redact_quarantined_email_outbox_authority_v2(
        pg_catalog.statement_timestamp() - interval '31 days',
        ${batchLimit}
      );
  `, "learncoding_ops");
  assert.ok(
    transitionedTotal(summary) <= batchLimit,
    `redaction transitioned more than batch limit ${batchLimit}`,
  );
  return summary;
}

function redactedBatchFixtureIds(port) {
  return JSON.parse(scalar(port, database, `
    SELECT COALESCE(
      pg_catalog.jsonb_agg(outbox.id::pg_catalog.text ORDER BY outbox.id),
      '[]'::pg_catalog.jsonb
    )::pg_catalog.text
      FROM public.email_outbox AS outbox
     WHERE outbox.id = ANY(ARRAY[
       '${FIXTURE_IDS["batch-oldest-a"]}'::pg_catalog.uuid,
       '${FIXTURE_IDS["batch-oldest-b"]}'::pg_catalog.uuid,
       '${FIXTURE_IDS["batch-next"]}'::pg_catalog.uuid
     ]::pg_catalog.uuid[])
       AND outbox.to_email =
             'redacted+' || outbox.id::pg_catalog.text || '@invalid.local'
       AND outbox.variables = '{}'::pg_catalog.jsonb;
  `));
}

function assertBoundedOldestFirstRedaction(port, before0068) {
  const batchLimit = 1;
  assert.equal(
    runRedactionSummary(port, batchLimit),
    "blocked:2:0,eligible:8:1,malformed:3:0",
    "batch-1 summary",
  );
  assert.deepEqual(redactedBatchFixtureIds(port), [
    FIXTURE_IDS["batch-oldest-a"],
  ]);
  assertStableProtectedState(port, before0068, "batch-1");

  const secondBatchLimit = 2;
  assert.equal(
    runRedactionSummary(port, secondBatchLimit),
    "blocked:2:0,eligible:7:2,malformed:3:0",
    "batch-2 summary",
  );
  assert.deepEqual(redactedBatchFixtureIds(port), [
    FIXTURE_IDS["batch-oldest-a"],
    FIXTURE_IDS["batch-oldest-b"],
    FIXTURE_IDS["batch-next"],
  ]);
  assert.ok(transitionedTotal(
    "blocked:2:0,eligible:7:2,malformed:3:0",
  ) <= secondBatchLimit);
  assertStableProtectedState(port, before0068, "batch-2");
}

function prove0067PredecessorTamperRollbackAndCleanRetry(
  port,
  migration0068,
  before0068,
) {
  const catalogBefore = predecessorCatalogDigest(port);
  const cases = [
    {
      diagnostic: "delivery-hold predecessor function is invalid",
      label: "delivery-hold-body",
      tamperSql: `
        CREATE OR REPLACE FUNCTION
          public.enforce_email_outbox_delivery_hold()
        RETURNS pg_catalog.trigger
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, pg_temp
        AS $tamper$
        BEGIN
          RETURN NEW;
        END
        $tamper$;`,
    },
    {
      diagnostic: "delivery-hold predecessor function is invalid",
      label: "delivery-hold-definition",
      tamperSql: `
        ALTER FUNCTION public.enforce_email_outbox_delivery_hold()
          COST 101;`,
    },
    {
      diagnostic: "idempotency coverage predecessor function is invalid",
      label: "coverage-body",
      tamperSql: `
        CREATE OR REPLACE FUNCTION
          public.email_outbox_idempotency_coverage_authority(
            candidate_ids pg_catalog.uuid[]
          )
        RETURNS pg_catalog.bool
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, pg_temp
        AS $tamper$
        BEGIN
          RETURN TRUE;
        END
        $tamper$;`,
    },
    {
      diagnostic: "idempotency coverage predecessor function is invalid",
      label: "coverage-definition",
      tamperSql: `
        ALTER FUNCTION
          public.email_outbox_idempotency_coverage_authority(
            pg_catalog.uuid[]
          ) COST 101;`,
    },
    {
      diagnostic: "delivery-hold predecessor trigger is invalid",
      label: "conditional-delivery-hold-trigger",
      tamperSql: `
        DROP TRIGGER email_outbox_delivery_hold
          ON public.email_outbox;
        CREATE TRIGGER email_outbox_delivery_hold
        BEFORE UPDATE OF
          idempotency_authority_version,
          idempotency_authority_sha256,
          idempotency_original_payload_sha256,
          status,
          attempt_count,
          claim_token,
          claim_owner,
          claim_version,
          lease_expires_at,
          provider_call_started,
          adapter,
          dispatch_binding_version,
          dispatch_binding_sha256,
          provider_correlation_version,
          provider_evidence_version,
          provider_evidence_sha256,
          provider_message_id,
          next_attempt_at,
          sent_at,
          quarantined_at,
          last_error_code,
          delivery_hold_version
        ON public.email_outbox
        FOR EACH ROW
        WHEN (false)
        EXECUTE FUNCTION public.enforce_email_outbox_delivery_hold();
        ALTER TABLE public.email_outbox
          ENABLE ALWAYS TRIGGER email_outbox_delivery_hold;`,
    },
  ];

  for (const testCase of cases) {
    const denied = applyAsOwner(
      port,
      `${testCase.tamperSql}\n${migration0068}`,
      { allowFailure: true },
    );
    assert.notEqual(
      denied.status,
      0,
      `${testCase.label} unexpectedly passed 0068 preflight`,
    );
    assert.match(
      `${denied.stdout}${denied.stderr}`,
      new RegExp(
        `ERROR:\\s+(?:23514|42501):\\s+${testCase.diagnostic}`,
        "u",
      ),
      testCase.label,
    );
    assert.equal(
      predecessorCatalogDigest(port),
      catalogBefore,
      `${testCase.label}: transaction rollback`,
    );
    assertStableProtectedState(
      port,
      before0068,
      `${testCase.label}: rejected`,
    );

    applyAsOwner(port, migration0068);
    assert.equal(
      predecessorCatalogDigest(port),
      catalogBefore,
      `${testCase.label}: clean retry`,
    );
    assertCatalogAndAcl(port);
    assertStableProtectedState(
      port,
      before0068,
      `${testCase.label}: clean retry`,
    );
  }
}
function assertEmptyReportApplyReplay(port, migration0068, before0068) {
  const expectedInitialReport = "blocked:2:0,eligible:8:0,malformed:3:0";
  const expectedRemainingReport = "blocked:2:0,eligible:5:0,malformed:3:0";
  const expectedApply = "blocked:2:0,eligible:5:5,malformed:3:3";
  const expectedReplay = "blocked:2:0,eligible:0:0,malformed:0:0";

  assertStableProtectedState(port, before0068, "migration-apply");
  assertMigratorDelegationCannotInvokeRedactor(port);
  assertStableProtectedState(port, before0068, "migrator-redactor-denied");
  assertDelegatedOwnerCannotMutatePayload(port);
  assertStableProtectedState(port, before0068, "delegated-owner-denied");
  assert.equal(
    runRedactionSummary(port, 0),
    expectedInitialReport,
    "report-only",
  );
  assertStableProtectedState(port, before0068, "report-only");

  assertBoundedOldestFirstRedaction(port, before0068);
  assert.equal(
    runRedactionSummary(port, 0),
    expectedRemainingReport,
    "remaining report-only",
  );
  assertStableProtectedState(port, before0068, "remaining report-only");
  assert.equal(
    runRedactionSummary(port, 50),
    expectedApply,
    "apply-redaction",
  );
  assertStableProtectedState(port, before0068, "apply-redaction");
  assertRedactedFixtureState(port);
  const redactedPii = piiDigest(port);

  repoisonExisting0068Acl(port);
  applyAsOwner(port, migration0068);
  assertCatalogAndAcl(port);
  assertStableProtectedState(port, before0068, "migration-replay");
  assert.equal(piiDigest(port), redactedPii, "migration-replay: PII");
  assert.equal(
    runRedactionSummary(port, 0),
    expectedReplay,
    "migration-replay",
  );
  assert.equal(
    runRedactionSummary(port, 50),
    expectedReplay,
    "apply-redaction replay",
  );
  assertStableProtectedState(port, before0068, "redactor replay");
  assert.equal(piiDigest(port), redactedPii, "redactor replay: PII");
}

function preserveOperationAndCleanupFailures(
  operationError,
  cleanupFailures,
  message,
) {
  if (operationError !== undefined) {
    if (cleanupFailures.length === 0) return operationError;
    return new AggregateError(
      [operationError, ...cleanupFailures],
      message,
      { cause: operationError },
    );
  }
  if (cleanupFailures.length === 1) return cleanupFailures[0];
  if (cleanupFailures.length > 1) {
    return new AggregateError(cleanupFailures, message, {
      cause: cleanupFailures[0],
    });
  }
  return undefined;
}

function readExactPostmasterPid(dataDirectory) {
  try {
    const firstLine = readFileSync(
      path.join(dataDirectory, "postmaster.pid"),
      "utf8",
    ).split(/\r?\n/u, 1)[0];
    assert.match(firstLine, /^[1-9][0-9]*$/u);
    const pid = Number.parseInt(firstLine, 10);
    assert.ok(Number.isSafeInteger(pid));
    return pid;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function processStillExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH") {
      return false;
    }
    if (error && typeof error === "object" && error.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

async function assertNoListener(port) {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => finish(
      new Error(`temporary PostgreSQL port ${port} still has a listener`),
    ));
    socket.once("error", (error) => {
      if (error && error.code === "ECONNREFUSED") finish();
      else finish(error);
    });
    socket.once("timeout", () => finish(
      new Error(`loopback listener probe timed out for port ${port}`),
    ));
  });
}

function assertPostmasterStopped(dataDirectory, postmasterPid) {
  const status = run(
    executable("pg_ctl"),
    ["-D", dataDirectory, "status"],
    { allowFailure: true, stdio: "ignore", timeoutMs: 5_000 },
  );
  assert.notEqual(status.status, 0, "exact temporary cluster is still active");
  if (postmasterPid !== undefined) {
    assert.equal(
      processStillExists(postmasterPid),
      false,
      `temporary PostgreSQL PID ${postmasterPid} survived pg_ctl stop`,
    );
  }
  const lingeringPid = readExactPostmasterPid(dataDirectory);
  if (lingeringPid !== undefined) {
    assert.equal(
      processStillExists(lingeringPid),
      false,
      `postmaster.pid still names live process ${lingeringPid}`,
    );
  }
}

export async function main() {
  const version = run(executable("postgres"), ["--version"]).stdout.trim();
  assert.match(
    version,
    new RegExp(`PostgreSQL\\) ${expectedMajor}\\.`, "u"),
  );

  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), `learncoding-mail-redaction-0068-pg${expectedMajor}-`),
  );
  let dataDirectory;
  let socketDirectory;
  let logFile;
  let port;
  let postmasterPid;
  let startAttempted = false;
  let startCompleted = false;
  let operationError;
  const cleanupFailures = [];

  try {
    dataDirectory = path.join(temporaryRoot, "data");
    socketDirectory = path.join(temporaryRoot, "socket");
    logFile = path.join(temporaryRoot, "postgres.log");
    mkdirSync(socketDirectory);
    port = await allocateDisposableLoopbackPort();
    assert.notEqual(port, 5432);
    run(executable("initdb"), [
      `--pgdata=${dataDirectory}`,
      "--username=postgres",
      "--auth=trust",
      "--data-checksums",
      "--encoding=UTF8",
      "--no-locale",
    ]);
    startAttempted = true;
    const socketOption = process.platform === "win32"
      ? ""
      : ` -k "${socketDirectory}"`;
    run(
      executable("pg_ctl"),
      [
        "-D",
        dataDirectory,
        "-l",
        logFile,
        "-o",
        `-p ${port} -h 127.0.0.1 -c max_connections=20${socketOption}`,
        "-w",
        "start",
      ],
      { stdio: "ignore", timeoutMs: 60_000 },
    );
    startCompleted = true;
    postmasterPid = readExactPostmasterPid(dataDirectory);
    assert.ok(postmasterPid !== undefined);
    assert.match(
      scalar(
        port,
        "postgres",
        "SELECT pg_catalog.current_setting('server_version_num');",
      ),
      new RegExp(`^${expectedMajor}[0-9]{4}$`, "u"),
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
CREATE ROLE learncoding_acl_default LOGIN NOINHERIT;
CREATE ROLE learncoding_acl_grantor NOLOGIN NOINHERIT;
CREATE ROLE learncoding_acl_leaf LOGIN NOINHERIT;
GRANT learncoding_acl_grantor TO learncoding_owner
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
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

    for (const migrationFile of migrationFilesThrough(66)) {
      applyAsOwner(port, readFileSync(migrationFile, "utf8"));
    }
    seedQuiescentFixtures(port);
    installProtectedProviderEvidence(port);
    const migration0067 = readFileSync(
      path.join(
        migrationDirectory,
        "0067_mail_outbox_durable_replay_authority.sql",
      ),
      "utf8",
    );
    applyAsOwner(port, migration0067);
    installClaimStateFixtures(port);
    assertFinal0067Hold(port);
    poison0068DefaultAcl(port);

    const migration0068 = readFileSync(
      path.join(
        migrationDirectory,
        "0068_mail_outbox_quarantine_redaction_authority_v2.sql",
      ),
      "utf8",
    );
    const migration0068Hostile = injectHostile0068Acl(migration0068);
    const before0068 = {
      authority: authorityDigest(port),
      protected: protectedDigest(port),
    };

    applyAsOwner(port, migration0068Hostile);
    assertCatalogAndAcl(port);
    prove0067PredecessorTamperRollbackAndCleanRetry(
      port,
      migration0068,
      before0068,
    );
    assertEmptyReportApplyReplay(port, migration0068, before0068);
  } catch (error) {
    operationError = error;
  } finally {
    if (startAttempted && dataDirectory !== undefined) {
      try {
        const stopped = run(
          executable("pg_ctl"),
          ["-D", dataDirectory, "stop", "-m", "immediate", "-w"],
          { allowFailure: true, stdio: "ignore", timeoutMs: 30_000 },
        );
        if (startCompleted && stopped.status !== 0) {
          cleanupFailures.push(new Error(
            `temporary PostgreSQL shutdown failed with status ${stopped.status}`,
          ));
        }
      } catch (error) {
        cleanupFailures.push(error);
      }
    }

    let listenerStopped = port === undefined;
    if (port !== undefined) {
      try {
        await assertNoListener(port);
        listenerStopped = true;
      } catch (error) {
        listenerStopped = false;
        cleanupFailures.push(error);
      }
    }

    let postmasterStopped = !startAttempted;
    if (startAttempted && dataDirectory !== undefined) {
      try {
        assertPostmasterStopped(dataDirectory, postmasterPid);
        postmasterStopped = true;
      } catch (error) {
        postmasterStopped = false;
        cleanupFailures.push(error);
      }
    }

    if (listenerStopped && postmasterStopped) {
      try {
        rmSync(temporaryRoot, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
  }

  if (operationError !== undefined || cleanupFailures.length > 0) {
    throw preserveOperationAndCleanupFailures(
      operationError,
      cleanupFailures,
      "0068 PostgreSQL operation and cleanup failed",
    );
  }
  process.stdout.write("mail_quarantine_redaction_0068=PASS\n");
}
