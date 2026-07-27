#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { allocateDisposableLoopbackPort } from "../../scripts/lib/disposable-loopback-port.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");
const migrationDirectory = path.join(repositoryRoot, "drizzle");
const database = "mail_guarded_delivery_0069";
const LIBPQ_ENVIRONMENT_KEYS = Object.freeze([
  "PGAPPNAME",
  "PGCHANNELBINDING",
  "PGCLIENTENCODING",
  "PGCONNECT_TIMEOUT",
  "PGDATABASE",
  "PGGSSENCMODE",
  "PGGSSLIB",
  "PGHOST",
  "PGHOSTADDR",
  "PGKRBSRVNAME",
  "PGLOADBALANCEHOSTS",
  "PGLOCALEDIR",
  "PGOPTIONS",
  "PGPASSFILE",
  "PGPASSWORD",
  "PGPORT",
  "PGREALM",
  "PGREQUIRESSL",
  "PGREQUIREAUTH",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGSSLCERT",
  "PGSSLCRL",
  "PGSSLCRLDIR",
  "PGSSLKEY",
  "PGSSLMODE",
  "PGSSLNEGOTIATION",
  "PGSSLROOTCERT",
  "PGSYSCONFDIR",
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
assert.ok(postgresBin, "the selected PostgreSQL binary directory is empty");

const childEnvironment = Object.freeze({
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  PGCONNECT_TIMEOUT: "5",
  PGOPTIONS:
    "-c statement_timeout=25000 -c idle_in_transaction_session_timeout=25000",
});

const ADMIN_ID = "mail-guarded-delivery-0069-admin";
const ADMIN_EMAIL = "mail-guarded-delivery-0069@example.invalid";
const FIXTURES = Object.freeze({
  main: Object.freeze({
    id: "69000000-0000-4000-8000-000000000001",
    operationId: "69100000-0000-4000-8000-000000000001",
    key: "a".repeat(64),
  }),
  delayed: Object.freeze({
    id: "69000000-0000-4000-8000-000000000002",
    operationId: "69100000-0000-4000-8000-000000000002",
    key: "b".repeat(64),
  }),
  rollback: Object.freeze({
    id: "69000000-0000-4000-8000-000000000003",
    operationId: "69100000-0000-4000-8000-000000000003",
    key: "c".repeat(64),
  }),
  finalGuard: Object.freeze({
    id: "69000000-0000-4000-8000-000000000004",
    operationId: "69100000-0000-4000-8000-000000000004",
    key: "d".repeat(64),
  }),
  stateArc: Object.freeze({
    id: "69000000-0000-4000-8000-000000000005",
    operationId: "69100000-0000-4000-8000-000000000005",
    key: "e".repeat(64),
  }),
  lateInsert: Object.freeze({
    id: "69000000-0000-4000-8000-000000000006",
    operationId: "69100000-0000-4000-8000-000000000006",
    key: "f".repeat(64),
  }),
  replicaDelete: Object.freeze({
    id: "69000000-0000-4000-8000-000000000007",
    operationId: "69100000-0000-4000-8000-000000000007",
    key: "7".repeat(64),
  }),
  futureTimestamp: Object.freeze({
    id: "69000000-0000-4000-8000-000000000008",
    operationId: "69100000-0000-4000-8000-000000000008",
    key: "8".repeat(64),
  }),
});

function executable(name) {
  const candidate = path.join(postgresBin, `${name}${executableSuffix}`);
  assert.ok(
    existsSync(candidate),
    `missing PostgreSQL executable: ${candidate}`,
  );
  return candidate;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: childEnvironment,
    input: options.input,
    maxBuffer: 32 * 1024 * 1024,
    stdio: options.stdio,
    timeout: options.timeoutMs ?? 120_000,
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
    scalar: true,
    username,
  }).stdout.trim();
}

function assertFailure(result, pattern) {
  assert.notEqual(result.status, 0, "SQL unexpectedly succeeded");
  assert.match(`${result.stdout ?? ""}${result.stderr ?? ""}`, pattern);
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
    RAISE EXCEPTION '0069 harness migration session identity is invalid'
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
    RAISE EXCEPTION '0069 harness delegated owner identity is invalid'
      USING ERRCODE = '42501';
  END IF;
END
$migration_owner_assertion$;
${sql}
;
RESET ROLE;
DO $migration_reset_assertion$
BEGIN
  IF session_user <> 'learncoding_migrator'
     OR current_user <> 'learncoding_migrator'
  THEN
    RAISE EXCEPTION '0069 harness migration role reset is invalid'
      USING ERRCODE = '42501',
            DETAIL = pg_catalog.format(
              'session_user=%s current_user=%s',
              session_user, current_user
            );
  END IF;
END
$migration_reset_assertion$;
COMMIT;`;
}

function applyAsOwner(port, sql, options = {}) {
  return psql(port, database, ownerTransactionSql(sql), {
    allowFailure: options.allowFailure,
    timeoutMs: options.timeoutMs ?? 240_000,
    username: "learncoding_migrator",
  });
}

function applyAsOwnerFromFile(
  port,
  sql,
  temporaryRoot,
  fileName,
  options = {},
) {
  assertTemporaryRoot(temporaryRoot);
  assert.match(fileName, /^migration-0069-[a-z0-9-]+\.sql$/u);
  const exactRoot = path.resolve(temporaryRoot);
  const sqlFile = path.resolve(exactRoot, fileName);
  assert.equal(path.dirname(sqlFile), exactRoot);
  writeFileSync(sqlFile, ownerTransactionSql(sql), {
    encoding: "utf8",
    flag: "wx",
  });
  return run(
    executable("psql"),
    [
      ...connectionArgs(port, database, "learncoding_migrator"),
      "--set=ON_ERROR_STOP=1",
      "--set=VERBOSITY=verbose",
      "--quiet",
      `--file=${sqlFile}`,
    ],
    {
      allowFailure: options.allowFailure,
      timeoutMs: options.timeoutMs ?? 240_000,
    },
  );
}

function mailAuthorityDigest(port) {
  return scalar(
    port,
    database,
    `
    SELECT pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.concat_ws(
      '|',
      COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(outbox) ORDER BY outbox.id
        )::pg_catalog.text
          FROM public.email_outbox AS outbox
      ), '[]'),
      COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(authority)
          ORDER BY authority.idempotency_sha256
        )::pg_catalog.text
          FROM public.email_outbox_idempotency_authority AS authority
      ), '[]'),
      COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(receipt) ORDER BY receipt.outbox_id
        )::pg_catalog.text
          FROM public.mail_delivery_release_receipt AS receipt
      ), '[]'),
      COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(source) ORDER BY source.id
        )::pg_catalog.text
          FROM public.backup_status_mail_authority AS source
      ), '[]')
      ), 'UTF8')),
      'hex'
    );`,
  );
}

function guardedAclDigest(port) {
  return scalar(
    port,
    database,
    `
    WITH guarded(identity) AS (
      VALUES
        ('public.email_outbox_original_payload_sha256(text,text,text,text,jsonb)'::pg_catalog.text),
        ('public.email_outbox_event_sha256(text,text,text)'),
        ('public.claim_email_outbox_idempotency_authority()'),
        ('public.persist_email_outbox_idempotency_authority()'),
        ('public.enforce_email_outbox_idempotency_metadata_immutable()'),
        ('public.enforce_email_outbox_idempotency_append_only()'),
        ('public.email_outbox_idempotency_coverage_authority(uuid[])'),
        ('public.enforce_email_outbox_dispatch_binding()'),
        ('public.enforce_email_outbox_provider_correlation_evidence()'),
        ('public.classify_email_outbox_quarantine_redaction_v2(public.email_outbox,timestamp with time zone)'),
        ('public.redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)'),
        ('public.mail_delivery_release_receipt_sha256(uuid,uuid,text,text,text,text)'::pg_catalog.text),
        ('public.enforce_email_outbox_delivery_release_insert_xid()'),
        ('public.enforce_email_outbox_delivery_release_identity()'),
        ('public.enforce_email_outbox_delivery_release_insert_final()'),
        ('public.enforce_email_outbox_delivery_release_commit_exact()'),
        ('public.enforce_email_outbox_delivery_release_delete_exact()'),
        ('public.enforce_mail_delivery_release_receipt_append_only()'),
        ('public.enforce_mail_delivery_release_receipt_delete_exact()'),
        ('public.enforce_mail_delivery_release_receipt_insert()'),
        ('public.release_email_outbox_delivery(uuid,uuid,text,text,text)'),
        ('public.enforce_email_outbox_provider_request_body_immutable()'),
        ('public.enforce_email_outbox_delivery_hold()'),
        ('public.enforce_email_outbox_payload_immutable()'),
        ('public.enqueue_backup_status_mail_authority_unreleased_0067(text,text)'),
        ('public.enqueue_backup_status_mail_authority(text,text)')
    ), function_state AS (
      SELECT guarded.identity,
             pg_catalog.pg_get_functiondef(routine.oid) AS definition,
             pg_catalog.pg_get_userbyid(routine.proowner) AS owner_name,
             COALESCE((
               SELECT pg_catalog.string_agg(
                 pg_catalog.concat_ws(
                   ':',
                   CASE WHEN expanded.grantor = 0 THEN 'PUBLIC'
                     ELSE pg_catalog.pg_get_userbyid(expanded.grantor) END,
                   CASE WHEN expanded.grantee = 0 THEN 'PUBLIC'
                     ELSE pg_catalog.pg_get_userbyid(expanded.grantee) END,
                   pg_catalog.lower(expanded.privilege_type),
                   expanded.is_grantable::pg_catalog.text
                 ),
                 ',' ORDER BY expanded.grantor, expanded.grantee,
                              expanded.privilege_type, expanded.is_grantable
               )
                 FROM pg_catalog.aclexplode(COALESCE(
                   routine.proacl,
                   pg_catalog.acldefault('f', routine.proowner)
                 )) AS expanded
             ), '') AS acl_state
        FROM guarded
        JOIN pg_catalog.pg_proc AS routine
          ON routine.oid = pg_catalog.to_regprocedure(guarded.identity)
    ), relation_acl_state AS (
      SELECT relation.oid::pg_catalog.regclass::pg_catalog.text AS relation_name,
             COALESCE(pg_catalog.string_agg(
               pg_catalog.concat_ws(
                 ':',
                 CASE WHEN expanded.grantor = 0 THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(expanded.grantor) END,
                 CASE WHEN expanded.grantee = 0 THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(expanded.grantee) END,
                 pg_catalog.lower(expanded.privilege_type),
                 expanded.is_grantable::pg_catalog.text
               ),
               ',' ORDER BY expanded.grantor, expanded.grantee,
                            expanded.privilege_type, expanded.is_grantable
             ), '') AS acl_state
        FROM pg_catalog.pg_class AS relation
        CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )) AS expanded
       WHERE relation.oid IN (
         'public.email_outbox'::pg_catalog.regclass,
         'public.email_outbox_idempotency_authority'::pg_catalog.regclass,
         'public.mail_delivery_release_receipt'::pg_catalog.regclass
       )
       GROUP BY relation.oid
    ), column_acl_state AS (
      SELECT attribute.attrelid::pg_catalog.regclass::pg_catalog.text
               AS relation_name,
             attribute.attname,
             COALESCE(pg_catalog.string_agg(
               pg_catalog.concat_ws(
                 ':',
                 CASE WHEN expanded.grantor = 0 THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(expanded.grantor) END,
                 CASE WHEN expanded.grantee = 0 THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(expanded.grantee) END,
                 pg_catalog.lower(expanded.privilege_type),
                 expanded.is_grantable::pg_catalog.text
               ),
               ',' ORDER BY expanded.grantor, expanded.grantee,
                            expanded.privilege_type, expanded.is_grantable
             ), '') AS acl_state
        FROM pg_catalog.pg_attribute AS attribute
        LEFT JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS expanded
          ON true
       WHERE attribute.attrelid IN (
         'public.email_outbox'::pg_catalog.regclass,
         'public.email_outbox_idempotency_authority'::pg_catalog.regclass,
         'public.mail_delivery_release_receipt'::pg_catalog.regclass
       )
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
       GROUP BY attribute.attrelid, attribute.attnum, attribute.attname
    ), trigger_state AS (
      SELECT trigger_row.tgrelid::pg_catalog.regclass::pg_catalog.text
               AS relation_name,
             trigger_row.tgname,
             trigger_row.tgfoid::pg_catalog.regprocedure::pg_catalog.text
               AS function_name,
             trigger_row.tgtype,
             trigger_row.tgenabled,
             trigger_row.tgattr::pg_catalog.text AS watched_columns,
             COALESCE(
               pg_catalog.pg_get_expr(
                 trigger_row.tgqual,
                 trigger_row.tgrelid,
                 true
               ),
               ''
             ) AS predicate,
             pg_catalog.pg_get_triggerdef(trigger_row.oid, true) AS definition
        FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid IN (
         'public.email_outbox'::pg_catalog.regclass,
         'public.email_outbox_idempotency_authority'::pg_catalog.regclass,
         'public.mail_delivery_release_receipt'::pg_catalog.regclass
       )
         AND NOT trigger_row.tgisinternal
    ), membership_state AS (
      SELECT member.rolname AS member_name,
             granted.rolname AS granted_name,
             membership.admin_option,
             membership.inherit_option,
             membership.set_option
        FROM pg_catalog.pg_auth_members AS membership
        JOIN pg_catalog.pg_roles AS member
          ON member.oid = membership.member
        JOIN pg_catalog.pg_roles AS granted
          ON granted.oid = membership.roleid
       WHERE member.rolname LIKE 'learncoding_%'
          OR granted.rolname LIKE 'learncoding_%'
    )
    SELECT pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.concat_ws(
        '|',
        (SELECT pg_catalog.string_agg(
           pg_catalog.concat_ws(
             ':', identity, owner_name, definition, acl_state
           ),
           E'\n' ORDER BY identity
         ) FROM function_state),
        (SELECT pg_catalog.string_agg(
           relation_name || ':' || acl_state,
           E'\n' ORDER BY relation_name
         ) FROM relation_acl_state),
        (SELECT pg_catalog.string_agg(
           pg_catalog.concat_ws(
             ':', relation_name, attname, acl_state
           ),
           E'\n' ORDER BY relation_name, attname
         ) FROM column_acl_state),
        (SELECT pg_catalog.string_agg(
           pg_catalog.concat_ws(
             ':', relation_name, tgname, function_name,
             tgtype::pg_catalog.text, tgenabled::pg_catalog.text,
             watched_columns, predicate, definition
           ),
           E'\n' ORDER BY relation_name, tgname
         ) FROM trigger_state),
        (SELECT pg_catalog.string_agg(
           pg_catalog.concat_ws(
             ':', member_name, granted_name,
             admin_option::pg_catalog.text,
             inherit_option::pg_catalog.text,
             set_option::pg_catalog.text
           ),
           E'\n' ORDER BY member_name, granted_name
         ) FROM membership_state)
      ), 'UTF8')),
      'hex'
    );`,
  );
}

function predecessorDataDigest(port) {
  return scalar(
    port,
    database,
    `
    WITH hold AS (
      SELECT routine.*
        FROM pg_catalog.pg_proc AS routine
       WHERE routine.oid =
         'public.enforce_email_outbox_delivery_hold()'::pg_catalog.regprocedure
    )
    SELECT pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.concat_ws(
        '|',
        (SELECT pg_catalog.pg_get_functiondef(hold.oid) FROM hold),
        (SELECT pg_catalog.pg_get_triggerdef(trigger_row.oid, true)
          FROM pg_catalog.pg_trigger AS trigger_row
         WHERE trigger_row.tgrelid =
                 'public.email_outbox'::pg_catalog.regclass
           AND trigger_row.tgname = 'email_outbox_delivery_hold'
           AND NOT trigger_row.tgisinternal),
        (SELECT pg_catalog.string_agg(
           pg_catalog.concat_ws(
             ':',
             CASE WHEN expanded.grantor = 0 THEN 'PUBLIC'
               ELSE pg_catalog.pg_get_userbyid(expanded.grantor) END,
             CASE WHEN expanded.grantee = 0 THEN 'PUBLIC'
               ELSE pg_catalog.pg_get_userbyid(expanded.grantee) END,
             pg_catalog.lower(expanded.privilege_type),
             expanded.is_grantable::pg_catalog.text
           ),
           ',' ORDER BY expanded.grantor, expanded.grantee,
                        expanded.privilege_type, expanded.is_grantable
         )
           FROM hold
           CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
             hold.proacl,
             pg_catalog.acldefault('f', hold.proowner)
           )) AS expanded),
        COALESCE((
          SELECT pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(outbox) ORDER BY outbox.id
          )::pg_catalog.text
            FROM public.email_outbox AS outbox
        ), '[]'),
        COALESCE((
          SELECT pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(authority)
            ORDER BY authority.idempotency_sha256
          )::pg_catalog.text
            FROM public.email_outbox_idempotency_authority AS authority
        ), '[]'),
        COALESCE((
          SELECT pg_catalog.jsonb_agg(
            pg_catalog.to_jsonb(source) ORDER BY source.run_key
          )::pg_catalog.text
            FROM public.backup_status_mail_authority AS source
        ), '[]')
      ), 'UTF8')),
      'hex'
    );`,
  );
}

function predecessorCatalogDigest(port) {
  return scalar(
    port,
    database,
    `
    WITH guarded(identity) AS (
      VALUES
        ('public.email_outbox_original_payload_sha256(text,text,text,text,jsonb)'::pg_catalog.text),
        ('public.email_outbox_event_sha256(text,text,text)'),
        ('public.claim_email_outbox_idempotency_authority()'),
        ('public.persist_email_outbox_idempotency_authority()'),
        ('public.enforce_email_outbox_idempotency_metadata_immutable()'),
        ('public.enforce_email_outbox_idempotency_append_only()'),
        ('public.email_outbox_idempotency_coverage_authority(uuid[])'),
        ('public.enforce_email_outbox_dispatch_binding()'),
        ('public.enforce_email_outbox_provider_correlation_evidence()'),
        ('public.classify_email_outbox_quarantine_redaction_v2(public.email_outbox,timestamp with time zone)'),
        ('public.redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)'),
        ('public.enforce_email_outbox_delivery_hold()'::pg_catalog.text),
        ('public.enforce_email_outbox_payload_immutable()'),
        ('public.enqueue_backup_status_mail_authority(text,text)')
    ), function_state AS (
      SELECT guarded.identity,
             COALESCE(
               pg_catalog.pg_get_functiondef(routine.oid),
               '<missing>'
             ) AS definition,
             COALESCE(
               pg_catalog.pg_get_userbyid(routine.proowner),
               '<missing>'
             ) AS owner_name,
             COALESCE(language.lanname, '<missing>') AS language_name,
             COALESCE(routine.prokind::pg_catalog.text, '<missing>') AS kind,
             COALESCE(routine.prosecdef::pg_catalog.text, '<missing>')
               AS security_definer,
             COALESCE(routine.provolatile::pg_catalog.text, '<missing>')
               AS volatility,
             COALESCE(routine.proparallel::pg_catalog.text, '<missing>')
               AS parallel_safety,
             COALESCE(routine.proconfig::pg_catalog.text, '<missing>')
               AS configuration,
             COALESCE((
               SELECT pg_catalog.string_agg(
                 pg_catalog.concat_ws(
                   ':',
                   CASE WHEN expanded.grantor = 0 THEN 'PUBLIC'
                     ELSE pg_catalog.pg_get_userbyid(expanded.grantor) END,
                   CASE WHEN expanded.grantee = 0 THEN 'PUBLIC'
                     ELSE pg_catalog.pg_get_userbyid(expanded.grantee) END,
                   pg_catalog.lower(expanded.privilege_type),
                   expanded.is_grantable::pg_catalog.text
                 ),
                 ',' ORDER BY expanded.grantor, expanded.grantee,
                              expanded.privilege_type,
                              expanded.is_grantable
               )
                 FROM pg_catalog.aclexplode(COALESCE(
                   routine.proacl,
                   pg_catalog.acldefault('f', routine.proowner)
                 )) AS expanded
             ), '<missing>') AS acl_state
        FROM guarded
        LEFT JOIN pg_catalog.pg_proc AS routine
          ON routine.oid = pg_catalog.to_regprocedure(guarded.identity)
        LEFT JOIN pg_catalog.pg_language AS language
          ON language.oid = routine.prolang
    ), relation_acl_state AS (
      SELECT relation.oid::pg_catalog.regclass::pg_catalog.text
               AS relation_name,
             pg_catalog.pg_get_userbyid(relation.relowner) AS owner_name,
             COALESCE(pg_catalog.string_agg(
               pg_catalog.concat_ws(
                 ':',
                 CASE WHEN expanded.grantor = 0 THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(expanded.grantor) END,
                 CASE WHEN expanded.grantee = 0 THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(expanded.grantee) END,
                 pg_catalog.lower(expanded.privilege_type),
                 expanded.is_grantable::pg_catalog.text
               ),
               ',' ORDER BY expanded.grantor, expanded.grantee,
                            expanded.privilege_type,
                            expanded.is_grantable
             ), '') AS acl_state
        FROM pg_catalog.pg_class AS relation
        CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )) AS expanded
       WHERE relation.oid IN (
         'public.email_outbox'::pg_catalog.regclass,
         'public.email_outbox_idempotency_authority'::pg_catalog.regclass,
         'public.backup_status_mail_authority'::pg_catalog.regclass
       )
       GROUP BY relation.oid
    ), column_acl_state AS (
      SELECT attribute.attrelid::pg_catalog.regclass::pg_catalog.text
               AS relation_name,
             attribute.attnum,
             attribute.attname,
             COALESCE(pg_catalog.string_agg(
               pg_catalog.concat_ws(
                 ':',
                 CASE WHEN expanded.grantor = 0 THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(expanded.grantor) END,
                 CASE WHEN expanded.grantee = 0 THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(expanded.grantee) END,
                 pg_catalog.lower(expanded.privilege_type),
                 expanded.is_grantable::pg_catalog.text
               ),
               ',' ORDER BY expanded.grantor, expanded.grantee,
                            expanded.privilege_type,
                            expanded.is_grantable
             ), '') AS acl_state
        FROM pg_catalog.pg_attribute AS attribute
        LEFT JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS expanded
          ON true
       WHERE attribute.attrelid IN (
         'public.email_outbox'::pg_catalog.regclass,
         'public.email_outbox_idempotency_authority'::pg_catalog.regclass,
         'public.backup_status_mail_authority'::pg_catalog.regclass
       )
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
       GROUP BY attribute.attrelid, attribute.attnum, attribute.attname
    ), trigger_state AS (
      SELECT trigger_row.tgrelid::pg_catalog.regclass::pg_catalog.text
               AS relation_name,
             trigger_row.tgname,
             trigger_row.tgfoid::pg_catalog.regprocedure::pg_catalog.text
               AS function_name,
             trigger_row.tgtype,
             trigger_row.tgenabled,
             trigger_row.tgattr::pg_catalog.text AS watched_columns,
             COALESCE(pg_catalog.pg_get_expr(
               trigger_row.tgqual,
               trigger_row.tgrelid,
               true
             ), '') AS predicate,
             pg_catalog.pg_get_triggerdef(trigger_row.oid, true) AS definition
        FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid IN (
         'public.email_outbox'::pg_catalog.regclass,
         'public.email_outbox_idempotency_authority'::pg_catalog.regclass,
         'public.backup_status_mail_authority'::pg_catalog.regclass
       )
         AND NOT trigger_row.tgisinternal
    )
    SELECT pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.concat_ws(
        '|',
        (SELECT pg_catalog.string_agg(
           pg_catalog.concat_ws(
             ':', identity, definition, owner_name, language_name, kind,
             security_definer, volatility, parallel_safety,
             configuration, acl_state
           ),
           E'\n' ORDER BY identity
         ) FROM function_state),
        (SELECT pg_catalog.string_agg(
           pg_catalog.concat_ws(':', relation_name, owner_name, acl_state),
           E'\n' ORDER BY relation_name
         ) FROM relation_acl_state),
        (SELECT pg_catalog.string_agg(
           pg_catalog.concat_ws(
             ':', relation_name, attnum::pg_catalog.text,
             attname, acl_state
           ),
           E'\n' ORDER BY relation_name, attnum
         ) FROM column_acl_state),
        (SELECT pg_catalog.string_agg(
           pg_catalog.concat_ws(
             ':', relation_name, tgname, function_name,
             tgtype::pg_catalog.text, tgenabled::pg_catalog.text,
             watched_columns, predicate, definition
           ),
           E'\n' ORDER BY relation_name, tgname
         ) FROM trigger_state)
      ), 'UTF8')),
      'hex'
    );`,
  );
}

function predecessorDigest(port) {
  return createHash("sha256")
    .update(predecessorDataDigest(port), "utf8")
    .update("\0", "utf8")
    .update(predecessorCatalogDigest(port), "utf8")
    .digest("hex");
}

function assertNo0069Footprint(port) {
  assert.equal(
    scalar(
      port,
      database,
      `
      WITH successor_routines(identity) AS (
        VALUES
          ('public.mail_delivery_release_receipt_sha256(uuid,uuid,text,text,text,text)'::pg_catalog.text),
          ('public.enforce_email_outbox_delivery_release_insert_xid()'),
          ('public.enforce_email_outbox_delivery_release_identity()'),
          ('public.enforce_email_outbox_delivery_release_insert_final()'),
          ('public.enforce_email_outbox_delivery_release_commit_exact()'),
          ('public.enforce_email_outbox_delivery_release_delete_exact()'),
          ('public.enforce_mail_delivery_release_receipt_append_only()'),
          ('public.enforce_mail_delivery_release_receipt_delete_exact()'),
          ('public.enforce_mail_delivery_release_receipt_insert()'),
          ('public.release_email_outbox_delivery(uuid,uuid,text,text,text)'),
          ('public.enforce_email_outbox_provider_request_body_immutable()'),
          ('public.enqueue_backup_status_mail_authority_unreleased_0067(text,text)')
      ), successor_triggers(trigger_name) AS (
        VALUES
          ('email_outbox_delivery_release_insert_xid'::pg_catalog.text),
          ('email_outbox_delivery_release_insert_xid_immutable'),
          ('zz_email_outbox_delivery_release_identity'),
          ('zz_email_outbox_delivery_release_insert_final'),
          ('email_outbox_delivery_release_commit_exact'),
          ('email_outbox_delivery_release_delete_exact'),
          ('email_outbox_provider_request_body_immutable'),
          ('email_outbox_delivery_hold_final'),
          ('mail_delivery_release_receipt_insert_authority'),
          ('mail_delivery_release_receipt_append_only'),
          ('mail_delivery_release_receipt_no_truncate'),
          ('mail_delivery_release_receipt_delete_exact')
      )
      SELECT (
        pg_catalog.to_regclass(
          'public.mail_delivery_release_receipt'
        ) IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_attribute AS attribute
           WHERE attribute.attrelid =
                   'public.email_outbox'::pg_catalog.regclass
             AND attribute.attname IN (
               'delivery_release_insert_xid',
               'delivery_release_insert_system_identifier',
               'provider_request_body_sha256',
               'provider_request_body_length'
             )
             AND attribute.attnum > 0
             AND NOT attribute.attisdropped
        )
        AND NOT EXISTS (
          SELECT 1
            FROM successor_routines AS expected
           WHERE pg_catalog.to_regprocedure(expected.identity) IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_trigger AS trigger_row
            JOIN successor_triggers AS expected
              ON expected.trigger_name = trigger_row.tgname
           WHERE trigger_row.tgrelid =
                   'public.email_outbox'::pg_catalog.regclass
             AND NOT trigger_row.tgisinternal
        )
      )::pg_catalog.text;`,
    ),
    "true",
  );
}

function poison0069Acl(port) {
  applyAsOwner(
    port,
    `
    GRANT USAGE ON SCHEMA public TO
      learncoding_acl_default,
      learncoding_acl_grantor,
      learncoding_acl_leaf;
    ALTER DEFAULT PRIVILEGES FOR ROLE learncoding_owner IN SCHEMA public
      GRANT EXECUTE ON FUNCTIONS TO learncoding_acl_grantor
      WITH GRANT OPTION;
    ALTER DEFAULT PRIVILEGES FOR ROLE learncoding_owner IN SCHEMA public
      GRANT EXECUTE ON FUNCTIONS TO learncoding_acl_default;
    ALTER DEFAULT PRIVILEGES FOR ROLE learncoding_owner IN SCHEMA public
      GRANT ALL PRIVILEGES ON TABLES TO learncoding_acl_grantor
      WITH GRANT OPTION;
    ALTER DEFAULT PRIVILEGES FOR ROLE learncoding_owner IN SCHEMA public
      GRANT SELECT ON TABLES TO learncoding_acl_default;
    DO $poison_inherited_functions$
    DECLARE
      routine_identity pg_catalog.text;
    BEGIN
      FOREACH routine_identity IN ARRAY ARRAY[
        'public.email_outbox_original_payload_sha256(text,text,text,text,jsonb)',
        'public.email_outbox_event_sha256(text,text,text)',
        'public.claim_email_outbox_idempotency_authority()',
        'public.persist_email_outbox_idempotency_authority()',
        'public.enforce_email_outbox_idempotency_metadata_immutable()',
        'public.enforce_email_outbox_idempotency_append_only()',
        'public.email_outbox_idempotency_coverage_authority(uuid[])',
        'public.enforce_email_outbox_dispatch_binding()',
        'public.enforce_email_outbox_provider_correlation_evidence()',
        'public.classify_email_outbox_quarantine_redaction_v2(public.email_outbox,timestamp with time zone)',
        'public.redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)',
        'public.enforce_email_outbox_delivery_hold()',
        'public.enforce_email_outbox_payload_immutable()',
        'public.enqueue_backup_status_mail_authority(text,text)'
      ]::pg_catalog.text[]
      LOOP
        EXECUTE pg_catalog.format(
          'GRANT EXECUTE ON FUNCTION %s TO PUBLIC, learncoding_acl_default',
          routine_identity
        );
        EXECUTE pg_catalog.format(
          'GRANT EXECUTE ON FUNCTION %s TO learncoding_acl_grantor WITH GRANT OPTION',
          routine_identity
        );
      END LOOP;
    END
    $poison_inherited_functions$;
    GRANT EXECUTE ON FUNCTION
      public.enforce_email_outbox_delivery_hold()
      TO learncoding_acl_grantor WITH GRANT OPTION;
    GRANT EXECUTE ON FUNCTION
      public.enforce_email_outbox_delivery_hold()
      TO learncoding_acl_default;
  `,
  );
  psql(
    port,
    database,
    `
    DO $delegate_inherited_functions$
    DECLARE
      routine_identity pg_catalog.text;
    BEGIN
      FOREACH routine_identity IN ARRAY ARRAY[
        'public.email_outbox_original_payload_sha256(text,text,text,text,jsonb)',
        'public.email_outbox_event_sha256(text,text,text)',
        'public.claim_email_outbox_idempotency_authority()',
        'public.persist_email_outbox_idempotency_authority()',
        'public.enforce_email_outbox_idempotency_metadata_immutable()',
        'public.enforce_email_outbox_idempotency_append_only()',
        'public.email_outbox_idempotency_coverage_authority(uuid[])',
        'public.enforce_email_outbox_dispatch_binding()',
        'public.enforce_email_outbox_provider_correlation_evidence()',
        'public.classify_email_outbox_quarantine_redaction_v2(public.email_outbox,timestamp with time zone)',
        'public.redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)',
        'public.enforce_email_outbox_delivery_hold()',
        'public.enforce_email_outbox_payload_immutable()',
        'public.enqueue_backup_status_mail_authority(text,text)'
      ]::pg_catalog.text[]
      LOOP
        EXECUTE pg_catalog.format(
          'GRANT EXECUTE ON FUNCTION %s TO learncoding_acl_leaf WITH GRANT OPTION',
          routine_identity
        );
      END LOOP;
    END
    $delegate_inherited_functions$;
    GRANT EXECUTE ON FUNCTION
      public.enforce_email_outbox_delivery_hold()
      TO learncoding_acl_leaf WITH GRANT OPTION;
  `,
    { username: "learncoding_acl_grantor" },
  );
}

function restoreInheritedRoutineAcls(port) {
  applyAsOwner(
    port,
    `
    DO $restore_inherited_function_acls$
    DECLARE
      routine_oid pg_catalog.oid;
      routine_identity pg_catalog.text;
      acl_entry pg_catalog.record;
      grantee_sql pg_catalog.text;
    BEGIN
      FOREACH routine_oid IN ARRAY ARRAY[
        pg_catalog.to_regprocedure('public.email_outbox_original_payload_sha256(text,text,text,text,jsonb)')::pg_catalog.oid,
        pg_catalog.to_regprocedure('public.email_outbox_event_sha256(text,text,text)')::pg_catalog.oid,
        pg_catalog.to_regprocedure('public.claim_email_outbox_idempotency_authority()')::pg_catalog.oid,
        pg_catalog.to_regprocedure('public.persist_email_outbox_idempotency_authority()')::pg_catalog.oid,
        pg_catalog.to_regprocedure('public.enforce_email_outbox_idempotency_metadata_immutable()')::pg_catalog.oid,
        pg_catalog.to_regprocedure('public.enforce_email_outbox_idempotency_append_only()')::pg_catalog.oid,
        pg_catalog.to_regprocedure('public.email_outbox_idempotency_coverage_authority(uuid[])')::pg_catalog.oid,
        pg_catalog.to_regprocedure('public.enforce_email_outbox_dispatch_binding()')::pg_catalog.oid,
        pg_catalog.to_regprocedure('public.enforce_email_outbox_provider_correlation_evidence()')::pg_catalog.oid,
        pg_catalog.to_regprocedure('public.classify_email_outbox_quarantine_redaction_v2(public.email_outbox,timestamp with time zone)')::pg_catalog.oid,
        pg_catalog.to_regprocedure('public.redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)')::pg_catalog.oid,
        pg_catalog.to_regprocedure('public.enforce_email_outbox_delivery_hold()')::pg_catalog.oid,
        pg_catalog.to_regprocedure('public.enforce_email_outbox_payload_immutable()')::pg_catalog.oid,
        pg_catalog.to_regprocedure('public.enqueue_backup_status_mail_authority(text,text)')::pg_catalog.oid
      ]
      LOOP
        IF routine_oid IS NULL THEN
          RAISE EXCEPTION '0069 harness inherited ACL routine is missing';
        END IF;
        routine_identity :=
          routine_oid::pg_catalog.regprocedure::pg_catalog.text;
        FOR acl_entry IN
          SELECT DISTINCT access.grantee
            FROM pg_catalog.pg_proc AS routine
            CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
              routine.proacl,
              pg_catalog.acldefault('f', routine.proowner)
            )) AS access
           WHERE routine.oid = routine_oid
           ORDER BY access.grantee
        LOOP
          grantee_sql := CASE
            WHEN acl_entry.grantee = 0 THEN 'PUBLIC'
            ELSE pg_catalog.format(
              '%I',
              pg_catalog.pg_get_userbyid(acl_entry.grantee)
            )
          END;
          EXECUTE pg_catalog.format(
            'REVOKE ALL ON FUNCTION %s FROM %s CASCADE',
            routine_identity,
            grantee_sql
          );
        END LOOP;
        EXECUTE pg_catalog.format(
          'GRANT EXECUTE ON FUNCTION %s TO learncoding_owner',
          routine_identity
        );
      END LOOP;
    END
    $restore_inherited_function_acls$;
    GRANT EXECUTE ON FUNCTION
      public.email_outbox_idempotency_coverage_authority(pg_catalog.uuid[]),
      public.redact_quarantined_email_outbox_authority_v2(
        timestamp with time zone,
        integer
      )
      TO learncoding_ops;
    GRANT EXECUTE ON FUNCTION
      public.enqueue_backup_status_mail_authority(
        pg_catalog.text,
        pg_catalog.text
      )
      TO learncoding_backup_reporter;
  `,
  );

  assert.equal(
    scalar(
      port,
      database,
      `
      WITH reviewed(identity, ops_execute, backup_execute) AS (
        VALUES
          ('public.email_outbox_original_payload_sha256(text,text,text,text,jsonb)'::pg_catalog.text, false, false),
          ('public.email_outbox_event_sha256(text,text,text)', false, false),
          ('public.claim_email_outbox_idempotency_authority()', false, false),
          ('public.persist_email_outbox_idempotency_authority()', false, false),
          ('public.enforce_email_outbox_idempotency_metadata_immutable()', false, false),
          ('public.enforce_email_outbox_idempotency_append_only()', false, false),
          ('public.email_outbox_idempotency_coverage_authority(uuid[])', true, false),
          ('public.enforce_email_outbox_dispatch_binding()', false, false),
          ('public.enforce_email_outbox_provider_correlation_evidence()', false, false),
          ('public.classify_email_outbox_quarantine_redaction_v2(public.email_outbox,timestamp with time zone)', false, false),
          ('public.redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)', true, false),
          ('public.enforce_email_outbox_delivery_hold()', false, false),
          ('public.enforce_email_outbox_payload_immutable()', false, false),
          ('public.enqueue_backup_status_mail_authority(text,text)', false, true)
      ), actual AS (
        SELECT reviewed.identity,
               COALESCE(pg_catalog.array_agg(
                 pg_catalog.concat_ws(
                   '|',
                   CASE WHEN access.grantee = 0 THEN 'PUBLIC'
                     ELSE pg_catalog.pg_get_userbyid(access.grantee) END,
                   CASE WHEN access.grantor = 0 THEN 'PUBLIC'
                     ELSE pg_catalog.pg_get_userbyid(access.grantor) END,
                   pg_catalog.lower(access.privilege_type),
                   access.is_grantable::pg_catalog.text
                 ) ORDER BY access.grantee, access.grantor,
                            access.privilege_type, access.is_grantable
               ), ARRAY[]::pg_catalog.text[]) AS acl_rows,
               reviewed.ops_execute,
               reviewed.backup_execute
          FROM reviewed
          JOIN pg_catalog.pg_proc AS routine
            ON routine.oid = pg_catalog.to_regprocedure(reviewed.identity)
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
            routine.proacl,
            pg_catalog.acldefault('f', routine.proowner)
          )) AS access
         GROUP BY reviewed.identity, reviewed.ops_execute,
                  reviewed.backup_execute
      )
      SELECT (
        pg_catalog.count(*) = 14
        AND pg_catalog.bool_and(
          actual.acl_rows = CASE
            WHEN actual.ops_execute THEN ARRAY[
              'learncoding_owner|learncoding_owner|execute|false',
              'learncoding_ops|learncoding_owner|execute|false'
            ]::pg_catalog.text[]
            WHEN actual.backup_execute THEN ARRAY[
              'learncoding_owner|learncoding_owner|execute|false',
              'learncoding_backup_reporter|learncoding_owner|execute|false'
            ]::pg_catalog.text[]
            ELSE ARRAY[
              'learncoding_owner|learncoding_owner|execute|false'
            ]::pg_catalog.text[]
          END
        )
      )::pg_catalog.text
        FROM actual;`,
    ),
    "true",
  );
}

function proveInheritedAclTamperRollback(port, migration0069, temporaryRoot) {
  const poisoned = predecessorDigest(port);
  const result = applyAsOwnerFromFile(
    port,
    migration0069,
    temporaryRoot,
    "migration-0069-inherited-acl-poison.sql",
    { allowFailure: true },
  );
  assertFailure(result, /0069 inherited mail authority routines are invalid/u);
  assert.equal(predecessorDigest(port), poisoned);
  assertNo0069Footprint(port);
  restoreInheritedRoutineAcls(port);
  assert.notEqual(predecessorDigest(port), poisoned);
}

function proveDigestHelperTamperRollback(port, migration0069, temporaryRoot) {
  const pristine = predecessorDigest(port);
  const cases = [
    {
      identity:
        "public.email_outbox_original_payload_sha256(text,text,text,text,jsonb)",
      original: "mail-replay-conflict-v1",
      replacement: "mail-replay-conflict-v0",
      slug: "original-payload-helper",
    },
    {
      identity: "public.email_outbox_event_sha256(text,text,text)",
      original: "mail-event-v1",
      replacement: "mail-event-v0",
      slug: "event-helper",
    },
  ];
  for (const testCase of cases) {
    const originalDefinition = scalar(
      port,
      database,
      `
      SELECT pg_catalog.pg_get_functiondef(
        pg_catalog.to_regprocedure('${testCase.identity}')
      );`,
    );
    assert.match(originalDefinition, new RegExp(testCase.original, "u"));
    const tamperedDefinition = originalDefinition.replace(
      testCase.original,
      testCase.replacement,
    );
    assert.notEqual(tamperedDefinition, originalDefinition);
    applyAsOwner(port, tamperedDefinition);
    const tampered = predecessorDigest(port);
    assert.notEqual(tampered, pristine);
    const result = applyAsOwnerFromFile(
      port,
      migration0069,
      temporaryRoot,
      `migration-0069-${testCase.slug}.sql`,
      { allowFailure: true },
    );
    assertFailure(result, /0069 inherited mail digest helpers are invalid/u);
    assert.equal(predecessorDigest(port), tampered);
    assertNo0069Footprint(port);
    applyAsOwner(port, originalDefinition);
    assert.equal(predecessorDigest(port), pristine);
  }
}

function repoison0069Acl(port) {
  applyAsOwner(
    port,
    `
    DO $poison_successor_functions$
    DECLARE
      routine_identity pg_catalog.text;
    BEGIN
      FOREACH routine_identity IN ARRAY ARRAY[
        'public.mail_delivery_release_receipt_sha256(uuid,uuid,text,text,text,text)',
        'public.enforce_email_outbox_delivery_release_insert_xid()',
        'public.enforce_email_outbox_delivery_release_identity()',
        'public.enforce_email_outbox_delivery_release_insert_final()',
        'public.enforce_email_outbox_delivery_release_commit_exact()',
        'public.enforce_email_outbox_delivery_release_delete_exact()',
        'public.enforce_mail_delivery_release_receipt_append_only()',
        'public.enforce_mail_delivery_release_receipt_delete_exact()',
        'public.enforce_mail_delivery_release_receipt_insert()',
        'public.release_email_outbox_delivery(uuid,uuid,text,text,text)',
        'public.enforce_email_outbox_provider_request_body_immutable()',
        'public.enforce_email_outbox_delivery_hold()',
        'public.enforce_email_outbox_payload_immutable()',
        'public.enqueue_backup_status_mail_authority_unreleased_0067(text,text)'
      ]::pg_catalog.text[]
      LOOP
        EXECUTE pg_catalog.format(
          'GRANT EXECUTE ON FUNCTION %s TO learncoding_acl_grantor WITH GRANT OPTION',
          routine_identity
        );
        EXECUTE pg_catalog.format(
          'GRANT EXECUTE ON FUNCTION %s TO PUBLIC, learncoding_acl_default',
          routine_identity
        );
      END LOOP;
    END
    $poison_successor_functions$;
    GRANT ALL PRIVILEGES ON TABLE public.mail_delivery_release_receipt
      TO learncoding_acl_grantor WITH GRANT OPTION;
    GRANT SELECT ON TABLE public.mail_delivery_release_receipt
      TO learncoding_acl_default;
    GRANT UPDATE (
      delivery_release_insert_xid,
      delivery_release_insert_system_identifier,
      provider_request_body_sha256,
      provider_request_body_length
    ) ON TABLE public.email_outbox
      TO learncoding_acl_grantor WITH GRANT OPTION;
  `,
  );
  psql(
    port,
    database,
    `
    DO $delegate_successor_functions$
    DECLARE
      routine_identity pg_catalog.text;
    BEGIN
      FOREACH routine_identity IN ARRAY ARRAY[
        'public.mail_delivery_release_receipt_sha256(uuid,uuid,text,text,text,text)',
        'public.enforce_email_outbox_delivery_release_insert_xid()',
        'public.enforce_email_outbox_delivery_release_identity()',
        'public.enforce_email_outbox_delivery_release_insert_final()',
        'public.enforce_email_outbox_delivery_release_commit_exact()',
        'public.enforce_email_outbox_delivery_release_delete_exact()',
        'public.enforce_mail_delivery_release_receipt_append_only()',
        'public.enforce_mail_delivery_release_receipt_delete_exact()',
        'public.enforce_mail_delivery_release_receipt_insert()',
        'public.release_email_outbox_delivery(uuid,uuid,text,text,text)',
        'public.enforce_email_outbox_provider_request_body_immutable()',
        'public.enforce_email_outbox_delivery_hold()',
        'public.enforce_email_outbox_payload_immutable()',
        'public.enqueue_backup_status_mail_authority_unreleased_0067(text,text)'
      ]::pg_catalog.text[]
      LOOP
        EXECUTE pg_catalog.format(
          'GRANT EXECUTE ON FUNCTION %s TO learncoding_acl_leaf WITH GRANT OPTION',
          routine_identity
        );
      END LOOP;
    END
    $delegate_successor_functions$;
    GRANT SELECT ON TABLE public.mail_delivery_release_receipt
      TO learncoding_acl_leaf WITH GRANT OPTION;
    GRANT UPDATE (
      delivery_release_insert_xid,
      delivery_release_insert_system_identifier,
      provider_request_body_sha256,
      provider_request_body_length
    ) ON TABLE public.email_outbox
      TO learncoding_acl_leaf WITH GRANT OPTION;
  `,
    { username: "learncoding_acl_grantor" },
  );
}

function restoreTask5RelationAcls(port) {
  applyAsOwner(
    port,
    `
    DO $restore_task5_relation_acls$
    DECLARE
      acl_entry pg_catalog.record;
      column_row pg_catalog.record;
      grantee_sql pg_catalog.text;
    BEGIN
      FOR column_row IN
        SELECT attribute.attname, attribute.attacl
          FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid =
               'public.email_outbox_idempotency_authority'
                 ::pg_catalog.regclass
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND attribute.attacl IS NOT NULL
         ORDER BY attribute.attnum
      LOOP
        FOR acl_entry IN
          SELECT DISTINCT access.grantee
            FROM pg_catalog.aclexplode(column_row.attacl) AS access
           ORDER BY access.grantee
        LOOP
          grantee_sql := CASE
            WHEN acl_entry.grantee = 0 THEN 'PUBLIC'
            ELSE pg_catalog.format(
              '%I',
              pg_catalog.pg_get_userbyid(acl_entry.grantee)
            )
          END;
          EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES (%I) ON TABLE public.email_outbox_idempotency_authority FROM %s CASCADE',
            column_row.attname,
            grantee_sql
          );
        END LOOP;
      END LOOP;

      FOR acl_entry IN
        SELECT DISTINCT access.grantee
          FROM pg_catalog.pg_class AS relation
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
            relation.relacl,
            pg_catalog.acldefault('r', relation.relowner)
          )) AS access
         WHERE relation.oid =
               'public.email_outbox_idempotency_authority'
                 ::pg_catalog.regclass
         ORDER BY access.grantee
      LOOP
        grantee_sql := CASE
          WHEN acl_entry.grantee = 0 THEN 'PUBLIC'
          ELSE pg_catalog.format(
            '%I',
            pg_catalog.pg_get_userbyid(acl_entry.grantee)
          )
        END;
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON TABLE public.email_outbox_idempotency_authority FROM %s CASCADE',
          grantee_sql
        );
      END LOOP;
    END
    $restore_task5_relation_acls$;
    GRANT ALL PRIVILEGES
      ON TABLE public.email_outbox_idempotency_authority
      TO learncoding_owner;
  `,
  );
  assert.equal(
    scalar(
      port,
      database,
      `
      WITH relation_acl AS (
        SELECT access.*
          FROM pg_catalog.pg_class AS relation
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
            relation.relacl,
            pg_catalog.acldefault('r', relation.relowner)
          )) AS access
         WHERE relation.oid =
               'public.email_outbox_idempotency_authority'
                 ::pg_catalog.regclass
      )
      SELECT (
        (SELECT pg_catalog.array_agg(
           pg_catalog.lower(access.privilege_type)
           ORDER BY pg_catalog.lower(access.privilege_type)
         ) FROM relation_acl AS access) = ARRAY[
           'delete', 'insert', 'maintain', 'references',
           'select', 'trigger', 'truncate', 'update'
         ]::pg_catalog.text[]
        AND (SELECT pg_catalog.bool_and(
          access.grantee = (
            SELECT role.oid FROM pg_catalog.pg_roles AS role
             WHERE role.rolname = 'learncoding_owner'
          )
          AND access.grantor = access.grantee
          AND NOT access.is_grantable
        ) FROM relation_acl AS access)
        AND NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_attribute AS attribute
           WHERE attribute.attrelid =
                 'public.email_outbox_idempotency_authority'
                   ::pg_catalog.regclass
             AND attribute.attnum > 0
             AND NOT attribute.attisdropped
             AND attribute.attacl IS NOT NULL
        )
      )::pg_catalog.text;`,
    ),
    "true",
  );
}

function proveTask5RelationAclTamperRollback(
  port,
  migration0069,
  temporaryRoot,
) {
  applyAsOwner(
    port,
    `
    GRANT ALL PRIVILEGES
      ON TABLE public.email_outbox_idempotency_authority
      TO learncoding_acl_grantor WITH GRANT OPTION;
    GRANT SELECT
      ON TABLE public.email_outbox_idempotency_authority
      TO learncoding_acl_default;
    GRANT UPDATE (original_payload_sha256)
      ON TABLE public.email_outbox_idempotency_authority
      TO learncoding_acl_grantor WITH GRANT OPTION;
  `,
  );
  psql(
    port,
    database,
    `
    GRANT ALL PRIVILEGES
      ON TABLE public.email_outbox_idempotency_authority
      TO learncoding_acl_leaf WITH GRANT OPTION;
    GRANT UPDATE (original_payload_sha256)
      ON TABLE public.email_outbox_idempotency_authority
      TO learncoding_acl_leaf WITH GRANT OPTION;
  `,
    { username: "learncoding_acl_grantor" },
  );

  const poisonedData = mailAuthorityDigest(port);
  const poisonedCatalog = guardedAclDigest(port);
  const result = applyAsOwnerFromFile(
    port,
    migration0069,
    temporaryRoot,
    "migration-0069-task5-relation-acl-poison.sql",
    { allowFailure: true },
  );
  assertFailure(
    result,
    /0069 (inherited|terminal).*authority.*invalid|0069 terminal catalog contract is invalid/u,
  );
  assert.equal(mailAuthorityDigest(port), poisonedData);
  assert.equal(guardedAclDigest(port), poisonedCatalog);
  restoreTask5RelationAcls(port);
  assert.equal(mailAuthorityDigest(port), poisonedData);
  assert.notEqual(guardedAclDigest(port), poisonedCatalog);
}

function provePredecessorTamperRollback(port, migration0069) {
  const before = predecessorDigest(port);
  const preflightEndMarker = "$preflight$;--> statement-breakpoint";
  const preflightEnd = migration0069.indexOf(preflightEndMarker);
  assert.ok(preflightEnd >= 0);
  const migration0069Preflight = migration0069.slice(
    0,
    preflightEnd + preflightEndMarker.length,
  );
  const tampered = `
    CREATE OR REPLACE FUNCTION public.enforce_email_outbox_delivery_hold()
    RETURNS pg_catalog.trigger
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $tampered$
    BEGIN
      RETURN NEW;
    END
    $tampered$;
    ${migration0069Preflight}
  `;
  const result = applyAsOwner(port, tampered, {
    allowFailure: true,
    timeoutMs: 240_000,
  });
  assertFailure(
    result,
    /0069 (exact shared 0068 functions|predecessor hold authority) is invalid/u,
  );
  assert.equal(predecessorDigest(port), before);
  assert.equal(
    scalar(
      port,
      database,
      `
      SELECT (
        pg_catalog.to_regclass('public.mail_delivery_release_receipt') IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_attribute AS attribute
           WHERE attribute.attrelid =
                   'public.email_outbox'::pg_catalog.regclass
             AND attribute.attname IN (
               'delivery_release_insert_xid',
               'delivery_release_insert_system_identifier',
               'provider_request_body_sha256',
               'provider_request_body_length'
             )
             AND attribute.attnum > 0
             AND NOT attribute.attisdropped
        )
      )::pg_catalog.text;`,
    ),
    "true",
  );
}

function proveDrainedBacklogRollback(port, migration0069, temporaryRoot) {
  const runKey = "69000000-0000-4000-8000-000000000020";
  const queued = backupResult(port, runKey, "success");
  const [acknowledgement, authorityId, outboxId, operationId] =
    queued.split("|");
  assert.equal(acknowledgement, "queued");
  for (const identifier of [authorityId, outboxId, operationId]) {
    assert.match(identifier, /^[0-9a-f-]{36}$/u);
  }
  assert.equal(
    scalar(
      port,
      database,
      `
      SELECT (
        source.id = '${authorityId}'::pg_catalog.uuid
        AND source.outbox_id = '${outboxId}'::pg_catalog.uuid
        AND source.operation_id = '${operationId}'::pg_catalog.uuid
        AND outbox.status NOT IN ('sent', 'failed', 'suppressed')
        AND outbox.operation_id = source.operation_id
        AND durable.idempotency_sha256 =
              outbox.idempotency_authority_sha256
        AND durable.original_payload_sha256 =
              outbox.idempotency_original_payload_sha256
      )::pg_catalog.text
        FROM public.backup_status_mail_authority AS source
        JOIN public.email_outbox AS outbox
          ON outbox.id = source.outbox_id
        JOIN public.email_outbox_idempotency_authority AS durable
          ON durable.idempotency_sha256 =
               outbox.idempotency_authority_sha256
         AND durable.original_payload_sha256 =
               outbox.idempotency_original_payload_sha256
       WHERE source.run_key = '${runKey}';`,
    ),
    "true",
  );
  const before = predecessorDigest(port);
  const result = applyAsOwnerFromFile(
    port,
    migration0069,
    temporaryRoot,
    "migration-0069-drained-backlog.sql",
    { allowFailure: true },
  );
  assertFailure(result, /0069 requires a drained nonterminal outbox backlog/u);
  assert.equal(predecessorDigest(port), before);
  assertNo0069Footprint(port);

  applyAsOwner(
    port,
    `
    DELETE FROM public.email_outbox
     WHERE id = '${outboxId}'::pg_catalog.uuid;
  `,
  );
  assert.equal(
    scalar(
      port,
      database,
      `
      SELECT (
        EXISTS (
          SELECT 1
            FROM public.backup_status_mail_authority
           WHERE run_key = '${runKey}'
             AND outbox_id = '${outboxId}'::pg_catalog.uuid
        )
        AND NOT EXISTS (
          SELECT 1
            FROM public.email_outbox
           WHERE id = '${outboxId}'::pg_catalog.uuid
        )
        AND NOT EXISTS (
          SELECT 1
            FROM public.email_outbox
           WHERE status IS NULL
              OR status NOT IN ('sent', 'failed', 'suppressed')
        )
      )::pg_catalog.text;`,
    ),
    "true",
  );
}

function proveLateCatalogRollback(port, migration0069, temporaryRoot) {
  applyAsOwner(
    port,
    `
    CREATE TABLE public.mail_guarded_delivery_0069_index_collision (
      left_key pg_catalog.text NOT NULL,
      right_key pg_catalog.text NOT NULL
    );
    CREATE INDEX mail_delivery_release_receipt_authority_fk_idx
      ON public.mail_guarded_delivery_0069_index_collision (
        left_key,
        right_key
      );
  `,
  );
  const before = predecessorDigest(port);
  const result = applyAsOwnerFromFile(
    port,
    migration0069,
    temporaryRoot,
    "migration-0069-late-catalog-collision.sql",
    { allowFailure: true },
  );
  assertFailure(result, /0069 terminal catalog contract is invalid/u);
  assert.equal(predecessorDigest(port), before);
  assertNo0069Footprint(port);
  assert.equal(
    scalar(
      port,
      database,
      `
      SELECT (
        pg_catalog.to_regclass(
          'public.mail_guarded_delivery_0069_index_collision'
        ) IS NOT NULL
        AND (
          SELECT index_row.indrelid =
                   'public.mail_guarded_delivery_0069_index_collision'
                     ::pg_catalog.regclass
            FROM pg_catalog.pg_index AS index_row
           WHERE index_row.indexrelid =
                 'public.mail_delivery_release_receipt_authority_fk_idx'
                   ::pg_catalog.regclass
        )
      )::pg_catalog.text;`,
    ),
    "true",
  );
  applyAsOwner(
    port,
    `
    DROP TABLE public.mail_guarded_delivery_0069_index_collision;
  `,
  );
  assertNo0069Footprint(port);
}

function assertDigestHelperCatalog(port) {
  const originalDefinitionSha256 =
    expectedMajor === "18"
      ? "365bd47aab3ce58ca2b894c7eb77ed12cb759fc3683599ef5ae987e4414f1d3c"
      : "35691db9ef3153adf2e19ebae539341797f7b4fd2a27aec1db215b9533636ed8";
  assert.equal(
    scalar(
      port,
      database,
      `
      BEGIN;
      SET LOCAL search_path = pg_catalog, pg_temp;
      WITH expected(
        identity, routine_name, argument_names, argument_types,
        source_sha256, definition_sha256
      ) AS (
        VALUES
          (
            'public.email_outbox_original_payload_sha256(text,text,text,text,jsonb)'::pg_catalog.text,
            'email_outbox_original_payload_sha256'::pg_catalog.text,
            ARRAY[
              'input_user_id', 'input_to_email', 'input_template',
              'input_template_version', 'input_variables'
            ]::pg_catalog.text[],
            ARRAY[
              'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.jsonb'::pg_catalog.regtype::pg_catalog.oid
            ]::pg_catalog.oid[],
            '6b7100af8bd25093520317e67d5a06b40848b192ca94eb4b6c63ef48adcf89a2',
            '${originalDefinitionSha256}'
          ),
          (
            'public.email_outbox_event_sha256(text,text,text)',
            'email_outbox_event_sha256',
            ARRAY[
              'input_template', 'input_scope', 'input_event_id'
            ]::pg_catalog.text[],
            ARRAY[
              'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid
            ]::pg_catalog.oid[],
            'dbb1e105e567de47875c1bdd433b61cc78745fc0bc7953daa68b6f3f2bf83315',
            '02d83d883c8f4c0b4fc22c460353834d27a67becdd96d81cee8b74609521f334'
          )
      )
      SELECT (
        pg_catalog.count(*) = 2
        AND pg_catalog.bool_and(
          pg_catalog.pg_get_userbyid(routine.proowner) =
            'learncoding_owner'
          AND language.lanname = 'sql'
          AND routine.prokind = 'f'
          AND routine.prorettype =
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid
          AND NOT routine.proretset
          AND routine.provolatile = 'i'
          AND routine.prosecdef
          AND NOT routine.proleakproof
          AND NOT routine.proisstrict
          AND routine.proparallel = 'u'
          AND routine.proconfig =
            ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
          AND routine.proargnames = expected.argument_names
          AND ARRAY(
            SELECT routine_argument.type_oid
              FROM pg_catalog.unnest(
                     routine.proargtypes::pg_catalog.oid[]
                   ) WITH ORDINALITY AS routine_argument(type_oid, position)
             ORDER BY routine_argument.position
          ) = expected.argument_types
          AND routine.pronargdefaults = 0
          AND routine.proargdefaults IS NULL
          AND routine.proallargtypes IS NULL
          AND routine.proargmodes IS NULL
          AND routine.protrftypes IS NULL
          AND routine.provariadic = 0
          AND routine.prosupport = 0
          AND routine.procost = 100
          AND routine.prorows = 0
          AND routine.probin IS NULL
          AND routine.prosqlbody IS NULL
          AND routine.proacl = ARRAY[
            'learncoding_owner=X/learncoding_owner'::pg_catalog.aclitem
          ]::pg_catalog.aclitem[]
          AND pg_catalog.encode(
            pg_catalog.sha256(pg_catalog.convert_to(
              routine.prosrc,
              'UTF8'
            )),
            'hex'
          ) = expected.source_sha256
          AND pg_catalog.encode(
            pg_catalog.sha256(pg_catalog.convert_to(
              pg_catalog.pg_get_functiondef(routine.oid),
              'UTF8'
            )),
            'hex'
          ) = expected.definition_sha256
          AND (
            SELECT pg_catalog.count(*)
              FROM pg_catalog.pg_proc AS overload
             WHERE overload.pronamespace =
                   'public'::pg_catalog.regnamespace
               AND overload.proname = expected.routine_name
          ) = 1
        )
      )::pg_catalog.text
        FROM expected
        JOIN pg_catalog.pg_proc AS routine
          ON routine.oid = pg_catalog.to_regprocedure(expected.identity)
        JOIN pg_catalog.pg_language AS language
          ON language.oid = routine.prolang;
      COMMIT;`,
    ),
    "true",
  );
}

function assertCatalogAndAcl(port) {
  assertDigestHelperCatalog(port);
  const lifecycleCatalogProbe = scalar(
    port,
    database,
    `
    BEGIN;
    SET LOCAL search_path = pg_catalog, pg_temp;
    SELECT pg_catalog.jsonb_build_object(
      'constraints', (
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'name', constraint_row.conname,
            'definition', pg_catalog.pg_get_constraintdef(constraint_row.oid, false),
            'definition_sha256', pg_catalog.encode(
              pg_catalog.sha256(pg_catalog.convert_to(
                pg_catalog.pg_get_constraintdef(constraint_row.oid, false),
                'UTF8'
              )),
              'hex'
            ),
            'conkey', constraint_row.conkey,
            'confkey', constraint_row.confkey,
            'conindid', CASE
              WHEN constraint_row.conindid = 0 THEN '0'
              ELSE constraint_row.conindid::pg_catalog.regclass::pg_catalog.text
            END
          ) ORDER BY constraint_row.conname
        )
          FROM pg_catalog.pg_constraint AS constraint_row
         WHERE constraint_row.conname IN (
           'email_outbox_delivery_release_parent_unique',
           'mail_delivery_release_receipt_outbox_fk'
         )
      ),
      'indexes', (
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'name', index_relation.relname,
            'definition', pg_catalog.pg_get_indexdef(index_relation.oid)
          ) ORDER BY index_relation.relname
        )
          FROM pg_catalog.pg_class AS index_relation
         WHERE index_relation.oid IN (
           SELECT constraint_row.conindid
             FROM pg_catalog.pg_constraint AS constraint_row
            WHERE constraint_row.conname IN (
              'email_outbox_delivery_release_parent_unique',
              'mail_delivery_release_receipt_outbox_fk'
            )
              AND constraint_row.conindid <> 0
         )
      ),
      'helpers', (
        SELECT pg_catalog.jsonb_object_agg(
          helper.identity,
          pg_catalog.encode(
            pg_catalog.sha256(pg_catalog.convert_to(
              pg_catalog.pg_get_functiondef(
                pg_catalog.to_regprocedure(helper.identity)
              ),
              'UTF8'
            )),
            'hex'
          )
        )
          FROM (VALUES
            ('public.email_outbox_event_sha256(text,text,text)'::pg_catalog.text),
            ('public.email_outbox_original_payload_sha256(text,text,text,text,jsonb)')
          ) AS helper(identity)
      )
    )::pg_catalog.text;
    COMMIT;`,
  );
  assert.deepEqual(JSON.parse(lifecycleCatalogProbe), {
    constraints: [
      {
        name: "email_outbox_delivery_release_parent_unique",
        conkey: [1, 15],
        confkey: null,
        conindid: "public.email_outbox_delivery_release_parent_unique",
        definition: "UNIQUE (id, operation_id)",
        definition_sha256:
          "2f5fa6b88fc8018a513ab5b1c5e1cf4c6f882c4463a08e04b8916f0ddd484b2b",
      },
      {
        name: "mail_delivery_release_receipt_outbox_fk",
        conkey: [1, 2],
        confkey: [1, 15],
        conindid: "public.email_outbox_delivery_release_parent_unique",
        definition:
          "FOREIGN KEY (outbox_id, operation_id) " +
          "REFERENCES public.email_outbox(id, operation_id) " +
          "ON UPDATE RESTRICT ON DELETE CASCADE",
        definition_sha256:
          "a404224075eb2229356afced34903caa44c5621308b335ec68fa36104584cc4b",
      },
    ],
    helpers: {
      "public.email_outbox_event_sha256(text,text,text)":
        "02d83d883c8f4c0b4fc22c460353834d27a67becdd96d81cee8b74609521f334",
      "public.email_outbox_original_payload_sha256(text,text,text,text,jsonb)":
        expectedMajor === "18"
          ? "365bd47aab3ce58ca2b894c7eb77ed12cb759fc3683599ef5ae987e4414f1d3c"
          : "35691db9ef3153adf2e19ebae539341797f7b4fd2a27aec1db215b9533636ed8",
    },
    indexes: [
      {
        name: "email_outbox_delivery_release_parent_unique",
        definition:
          "CREATE UNIQUE INDEX email_outbox_delivery_release_parent_unique " +
          "ON public.email_outbox USING btree (id, operation_id)",
      },
    ],
  });
  assert.equal(
    scalar(
      port,
      database,
      `
      BEGIN;
      SET LOCAL search_path = pg_catalog, pg_temp;
      WITH exact_constraint(identity, relation_oid, referenced_oid, kind,
                            local_keys, referenced_keys, update_action,
                            delete_action) AS (
        VALUES
          (
            'email_outbox_delivery_release_parent_unique'::pg_catalog.text,
            'public.email_outbox'::pg_catalog.regclass,
            0::pg_catalog.oid,
            'u'::"char",
            ARRAY[1, 15]::pg_catalog.int2[],
            NULL::pg_catalog.int2[],
            ' '::"char",
            ' '::"char"
          ),
          (
            'mail_delivery_release_receipt_outbox_fk',
            'public.mail_delivery_release_receipt'::pg_catalog.regclass,
            'public.email_outbox'::pg_catalog.regclass,
            'f'::"char",
            ARRAY[1, 2]::pg_catalog.int2[],
            ARRAY[1, 15]::pg_catalog.int2[],
            'r'::"char",
            'c'::"char"
          )
      ),
      actual AS (
        SELECT expected.identity,
               pg_catalog.encode(
            pg_catalog.sha256(pg_catalog.convert_to(
              pg_catalog.pg_get_constraintdef(constraint_row.oid, false),
              'UTF8'
            )),
            'hex'
          ) AS definition_sha256
          FROM exact_constraint AS expected
          JOIN pg_catalog.pg_constraint AS constraint_row
            ON constraint_row.conname = expected.identity
           AND constraint_row.conrelid = expected.relation_oid
           AND constraint_row.confrelid = expected.referenced_oid
           AND constraint_row.contype = expected.kind
           AND constraint_row.conkey = expected.local_keys
           AND constraint_row.confkey IS NOT DISTINCT FROM
                 expected.referenced_keys
           AND (
             expected.kind <> 'f'
             OR (
               constraint_row.confupdtype = expected.update_action
               AND constraint_row.confdeltype = expected.delete_action
             )
           )
           AND constraint_row.conindid =
             'public.email_outbox_delivery_release_parent_unique'
               ::pg_catalog.regclass
           AND constraint_row.convalidated
           AND NOT constraint_row.condeferrable
           AND NOT constraint_row.condeferred
      )
      SELECT pg_catalog.string_agg(
               actual.definition_sha256,
               '|' ORDER BY actual.identity
             )
        FROM actual;
      COMMIT;`,
    ),
    "2f5fa6b88fc8018a513ab5b1c5e1cf4c6f882c4463a08e04b8916f0ddd484b2b" +
      "|a404224075eb2229356afced34903caa44c5621308b335ec68fa36104584cc4b",
  );
  assert.equal(
    scalar(
      port,
      database,
      `
      WITH guarded_routines(identity) AS (
        VALUES
          ('public.email_outbox_original_payload_sha256(text,text,text,text,jsonb)'::pg_catalog.text),
          ('public.email_outbox_event_sha256(text,text,text)'),
          ('public.claim_email_outbox_idempotency_authority()'),
          ('public.persist_email_outbox_idempotency_authority()'),
          ('public.enforce_email_outbox_idempotency_metadata_immutable()'),
          ('public.enforce_email_outbox_idempotency_append_only()'),
          ('public.email_outbox_idempotency_coverage_authority(uuid[])'),
          ('public.enforce_email_outbox_dispatch_binding()'),
          ('public.enforce_email_outbox_provider_correlation_evidence()'),
          ('public.classify_email_outbox_quarantine_redaction_v2(public.email_outbox,timestamp with time zone)'),
          ('public.redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)'),
          ('public.mail_delivery_release_receipt_sha256(uuid,uuid,text,text,text,text)'::pg_catalog.text),
          ('public.enforce_email_outbox_delivery_release_insert_xid()'),
          ('public.enforce_email_outbox_delivery_release_identity()'),
          ('public.enforce_email_outbox_delivery_release_insert_final()'),
          ('public.enforce_email_outbox_delivery_release_commit_exact()'),
          ('public.enforce_email_outbox_delivery_release_delete_exact()'),
          ('public.enforce_mail_delivery_release_receipt_append_only()'),
          ('public.enforce_mail_delivery_release_receipt_delete_exact()'),
          ('public.enforce_mail_delivery_release_receipt_insert()'),
          ('public.release_email_outbox_delivery(uuid,uuid,text,text,text)'),
          ('public.enforce_email_outbox_provider_request_body_immutable()'),
          ('public.enforce_email_outbox_delivery_hold()'),
          ('public.enforce_email_outbox_payload_immutable()'),
          ('public.enqueue_backup_status_mail_authority_unreleased_0067(text,text)'),
          ('public.enqueue_backup_status_mail_authority(text,text)')
      ),
      expected_triggers(relation_name, trigger_name) AS (
        VALUES
          ('email_outbox', 'email_outbox_delivery_release_insert_xid'),
          ('email_outbox', 'email_outbox_delivery_release_insert_xid_immutable'),
          ('email_outbox', 'zz_email_outbox_delivery_release_identity'),
          ('email_outbox', 'zz_email_outbox_delivery_release_insert_final'),
          ('email_outbox', 'email_outbox_delivery_release_commit_exact'),
          ('email_outbox', 'email_outbox_delivery_release_delete_exact'),
          ('email_outbox', 'email_outbox_provider_request_body_immutable'),
          ('email_outbox', 'email_outbox_delivery_hold'),
          ('email_outbox', 'email_outbox_delivery_hold_final'),
          ('mail_delivery_release_receipt', 'mail_delivery_release_receipt_insert_authority'),
          ('mail_delivery_release_receipt', 'mail_delivery_release_receipt_append_only'),
          ('mail_delivery_release_receipt', 'mail_delivery_release_receipt_no_truncate'),
          ('mail_delivery_release_receipt', 'mail_delivery_release_receipt_delete_exact')
      ),
      receipt_acl AS (
        SELECT expanded.*
          FROM pg_catalog.pg_class AS relation
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(
              relation.relacl,
              pg_catalog.acldefault('r', relation.relowner)
            )
          ) AS expanded
         WHERE relation.oid =
               'public.mail_delivery_release_receipt'::pg_catalog.regclass
      )
      SELECT (
        (SELECT pg_catalog.pg_get_userbyid(relation.relowner) =
                  'learncoding_owner'
                AND relation.relnatts = 8
           FROM pg_catalog.pg_class AS relation
          WHERE relation.oid =
                'public.mail_delivery_release_receipt'::pg_catalog.regclass)
        AND (
          SELECT pg_catalog.count(*) = 1
                 AND pg_catalog.bool_and(
                   attribute.attnum = 37
                   AND attribute.atttypid =
                     'pg_catalog.int8'::pg_catalog.regtype
                   AND attribute.atttypmod = -1
                   AND attribute.attcollation = 0
                   AND NOT attribute.attnotnull
                   AND NOT attribute.atthasdef
                   AND attribute.attidentity = ''
                   AND attribute.attgenerated = ''
                   AND NOT attribute.attisdropped
                   AND attribute.attacl IS NULL
                 )
            FROM pg_catalog.pg_attribute AS attribute
           WHERE attribute.attrelid =
                 'public.email_outbox'::pg_catalog.regclass
             AND attribute.attname =
                   'delivery_release_insert_system_identifier'
        )
        AND (
          SELECT pg_catalog.count(*) = 1
                 AND pg_catalog.bool_and(
                   constraint_row.contype = 'c'
                   AND constraint_row.convalidated
                   AND NOT constraint_row.connoinherit
                   AND constraint_row.conkey =
                     ARRAY[34, 37]::pg_catalog.int2[]
                   AND NOT constraint_row.condeferrable
                   AND NOT constraint_row.condeferred
                   AND constraint_row.conislocal
                   AND constraint_row.coninhcount = 0
                   AND constraint_row.conparentid = 0
                   AND constraint_row.contypid = 0
                   AND constraint_row.conindid = 0
                   AND constraint_row.confrelid = 0
                 )
            FROM pg_catalog.pg_constraint AS constraint_row
           WHERE constraint_row.conrelid =
                 'public.email_outbox'::pg_catalog.regclass
             AND constraint_row.conname =
                   'email_outbox_delivery_release_insert_identity_valid'
        )
        AND NOT EXISTS (
          SELECT 1
            FROM (VALUES
              ('learncoding_app'::pg_catalog.name),
              ('learncoding_worker'::pg_catalog.name),
              ('learncoding_ops'::pg_catalog.name),
              ('learncoding_backup_reporter'::pg_catalog.name),
              ('learncoding_acl_default'::pg_catalog.name),
              ('learncoding_acl_grantor'::pg_catalog.name),
              ('learncoding_acl_leaf'::pg_catalog.name)
            ) AS managed(role_name)
           WHERE pg_catalog.has_column_privilege(
             managed.role_name,
             'public.email_outbox',
             'delivery_release_insert_xid',
             'UPDATE'
           )
              OR pg_catalog.has_column_privilege(
                   managed.role_name,
                   'public.email_outbox',
                   'delivery_release_insert_system_identifier',
                   'UPDATE'
                 )
        )
        AND (
          SELECT pg_catalog.array_agg(attribute.attname ORDER BY attribute.attnum)
            FROM pg_catalog.pg_attribute AS attribute
           WHERE attribute.attrelid =
                 'public.mail_delivery_release_receipt'::pg_catalog.regclass
             AND attribute.attnum > 0
             AND NOT attribute.attisdropped
        ) = ARRAY[
          'outbox_id', 'operation_id', 'idempotency_authority_version',
          'idempotency_authority_sha256',
          'idempotency_original_payload_sha256', 'release_version',
          'release_receipt_sha256', 'released_at'
        ]::pg_catalog.name[]
        AND (
          SELECT pg_catalog.count(*) = 8
                 AND pg_catalog.bool_and(
                   attribute.attnum = expected.attribute_number
                   AND attribute.atttypid = expected.type_oid
                   AND attribute.atttypmod = -1
                   AND attribute.attcollation = type_row.typcollation
                   AND attribute.attnotnull
                   AND attribute.atthasdef =
                         (expected.default_expression IS NOT NULL)
                   AND attribute.attidentity = ''
                   AND attribute.attgenerated = ''
                   AND NOT attribute.atthasmissing
                   AND attribute.attmissingval IS NULL
                   AND attribute.attoptions IS NULL
                   AND attribute.attfdwoptions IS NULL
                   AND NOT attribute.attisdropped
                   AND attribute.attinhcount = 0
                   AND attribute.attislocal
                   AND attribute.attndims = 0
                   AND attribute.attstattarget IS NULL
                   AND attribute.attlen = type_row.typlen
                   AND attribute.attbyval = type_row.typbyval
                   AND attribute.attalign = type_row.typalign
                   AND attribute.attstorage = type_row.typstorage
                   AND attribute.attcompression = ''::"char"
                   AND (
                     (
                       expected.default_expression IS NULL
                       AND default_value.oid IS NULL
                     )
                     OR (
                       expected.default_expression IS NOT NULL
                       AND default_value.oid IS NOT NULL
                       AND pg_catalog.pg_get_expr(
                             default_value.adbin,
                             default_value.adrelid,
                             true
                           ) = expected.default_expression
                     )
                   )
                 )
            FROM (VALUES
              ('outbox_id'::pg_catalog.name, 1::pg_catalog.int2,
               'pg_catalog.uuid'::pg_catalog.regtype, NULL::pg_catalog.text),
              ('operation_id', 2::pg_catalog.int2,
               'pg_catalog.uuid'::pg_catalog.regtype, NULL),
              ('idempotency_authority_version', 3::pg_catalog.int2,
               'pg_catalog.text'::pg_catalog.regtype, NULL),
              ('idempotency_authority_sha256', 4::pg_catalog.int2,
               'pg_catalog.text'::pg_catalog.regtype, NULL),
              ('idempotency_original_payload_sha256', 5::pg_catalog.int2,
               'pg_catalog.text'::pg_catalog.regtype, NULL),
              ('release_version', 6::pg_catalog.int2,
               'pg_catalog.text'::pg_catalog.regtype, NULL),
              ('release_receipt_sha256', 7::pg_catalog.int2,
               'pg_catalog.text'::pg_catalog.regtype, NULL),
              ('released_at', 8::pg_catalog.int2,
               'timestamp with time zone'::pg_catalog.regtype,
               'statement_timestamp()'::pg_catalog.text)
            ) AS expected(
              column_name,
              attribute_number,
              type_oid,
              default_expression
            )
            JOIN pg_catalog.pg_attribute AS attribute
              ON attribute.attrelid =
                   'public.mail_delivery_release_receipt'
                     ::pg_catalog.regclass
             AND attribute.attname = expected.column_name
            JOIN pg_catalog.pg_type AS type_row
              ON type_row.oid = expected.type_oid
            LEFT JOIN pg_catalog.pg_attrdef AS default_value
              ON default_value.adrelid = attribute.attrelid
             AND default_value.adnum = attribute.attnum
        )
        AND (
          pg_catalog.current_setting('server_version_num')::pg_catalog.int4
            < 180000
          OR (
            SELECT pg_catalog.count(*) = 8
                   AND pg_catalog.count(
                         DISTINCT not_null_constraint.conkey[1]
                       ) = 8
                   AND pg_catalog.bool_and(
                     not_null_constraint.connamespace =
                       'public'::pg_catalog.regnamespace
                     AND pg_catalog.cardinality(
                           not_null_constraint.conkey
                         ) = 1
                     AND not_null_constraint.conkey[1] BETWEEN 1 AND 8
                     AND not_null_constraint.convalidated
                     AND not_null_constraint.conislocal
                     AND not_null_constraint.coninhcount = 0
                     AND not_null_constraint.conparentid = 0
                     AND NOT not_null_constraint.connoinherit
                     AND NOT not_null_constraint.condeferrable
                     AND NOT not_null_constraint.condeferred
                     AND not_null_constraint.contypid = 0
                     AND not_null_constraint.conindid = 0
                     AND not_null_constraint.confrelid = 0
                     AND COALESCE(
                           (
                             pg_catalog.to_jsonb(not_null_constraint)
                               ->>'conenforced'
                           )::pg_catalog.bool,
                           true
                         )
                     AND NOT COALESCE(
                           (
                             pg_catalog.to_jsonb(not_null_constraint)
                               ->>'conperiod'
                           )::pg_catalog.bool,
                           false
                         )
                   )
              FROM pg_catalog.pg_constraint AS not_null_constraint
             WHERE not_null_constraint.conrelid =
                   'public.mail_delivery_release_receipt'
                     ::pg_catalog.regclass
               AND not_null_constraint.contype = 'n'
          )
        )
        AND (
          SELECT pg_catalog.count(*)
            FROM pg_catalog.pg_constraint AS constraint_row
           WHERE constraint_row.conrelid =
                 'public.mail_delivery_release_receipt'::pg_catalog.regclass
             AND constraint_row.convalidated
             AND constraint_row.conname IN (
               'mail_delivery_release_receipt_pkey',
               'mail_delivery_release_receipt_operation_unique',
               'mail_delivery_release_receipt_digest_unique',
               'mail_delivery_release_receipt_authority_version_valid',
               'mail_delivery_release_receipt_release_version_valid',
               'mail_delivery_release_receipt_digest_valid',
               'mail_delivery_release_receipt_digest_exact',
               'mail_delivery_release_receipt_idempotency_authority_fk',
               'mail_delivery_release_receipt_outbox_fk'
             )
        ) = 9
        AND (
          SELECT pg_catalog.array_agg(
                   constraint_row.conname
                   ORDER BY constraint_row.conname
                 )
            FROM pg_catalog.pg_constraint AS constraint_row
           WHERE constraint_row.conrelid =
                 'public.mail_delivery_release_receipt'
                   ::pg_catalog.regclass
             AND constraint_row.contype IN ('c', 'p', 'u', 'f')
        ) = ARRAY[
          'mail_delivery_release_receipt_authority_version_valid',
          'mail_delivery_release_receipt_digest_exact',
          'mail_delivery_release_receipt_digest_unique',
          'mail_delivery_release_receipt_digest_valid',
          'mail_delivery_release_receipt_idempotency_authority_fk',
          'mail_delivery_release_receipt_operation_unique',
          'mail_delivery_release_receipt_outbox_fk',
          'mail_delivery_release_receipt_pkey',
          'mail_delivery_release_receipt_release_version_valid'
        ]::pg_catalog.name[]
        AND (
          SELECT pg_catalog.count(*) = 3
                 AND pg_catalog.bool_and(
                   constraint_row.contype = expected.constraint_type
                   AND constraint_row.conindid = expected.index_oid
                 )
            FROM (VALUES
              (
                'mail_delivery_release_receipt_pkey'::pg_catalog.name,
                'p'::"char",
                'public.mail_delivery_release_receipt_pkey'
                  ::pg_catalog.regclass
              ),
              (
                'mail_delivery_release_receipt_operation_unique',
                'u'::"char",
                'public.mail_delivery_release_receipt_operation_unique'
                  ::pg_catalog.regclass
              ),
              (
                'mail_delivery_release_receipt_digest_unique',
                'u'::"char",
                'public.mail_delivery_release_receipt_digest_unique'
                  ::pg_catalog.regclass
              )
            ) AS expected(constraint_name, constraint_type, index_oid)
            JOIN pg_catalog.pg_constraint AS constraint_row
              ON constraint_row.conrelid =
                   'public.mail_delivery_release_receipt'
                     ::pg_catalog.regclass
             AND constraint_row.conname = expected.constraint_name
        )
        AND (
          SELECT pg_catalog.count(*) = 4
                 AND pg_catalog.bool_and(
                   index_relation.relkind = 'i'
                   AND index_relation.relpersistence = 'p'
                   AND pg_catalog.pg_get_userbyid(index_relation.relowner) =
                         'learncoding_owner'
                   AND index_relation.reltablespace = 0
                   AND index_relation.reloptions IS NULL
                   AND index_relation.relacl IS NULL
                   AND NOT index_relation.relispartition
                   AND access_method.amname = 'btree'
                   AND index_row.indnatts =
                         pg_catalog.cardinality(expected.key_columns)
                   AND index_row.indnkeyatts =
                         pg_catalog.cardinality(expected.key_columns)
                   AND index_row.indisunique = expected.is_unique
                   AND NOT index_row.indnullsnotdistinct
                   AND index_row.indisprimary = expected.is_primary
                   AND NOT index_row.indisexclusion
                   AND index_row.indimmediate
                   AND NOT index_row.indisclustered
                   AND index_row.indisvalid
                   AND index_row.indisready
                   AND index_row.indislive
                   AND NOT index_row.indcheckxmin
                   AND NOT index_row.indisreplident
                   AND index_row.indpred IS NULL
                   AND index_row.indexprs IS NULL
                   AND ARRAY(
                     SELECT indexed_attribute.attribute_number
                       FROM pg_catalog.unnest(
                              index_row.indkey::pg_catalog.int2[]
                            ) WITH ORDINALITY AS indexed_attribute(
                              attribute_number,
                              position
                            )
                      ORDER BY indexed_attribute.position
                   ) = expected.key_columns
                   AND ARRAY(
                     SELECT indexed_class.operator_class_oid
                       FROM pg_catalog.unnest(
                              index_row.indclass::pg_catalog.oid[]
                            ) WITH ORDINALITY AS indexed_class(
                              operator_class_oid,
                              position
                            )
                      ORDER BY indexed_class.position
                   ) = ARRAY(
                     SELECT operator_class.oid
                       FROM pg_catalog.unnest(expected.key_columns)
                              WITH ORDINALITY AS key_column(
                                attribute_number,
                                position
                              )
                       JOIN pg_catalog.pg_attribute AS attribute
                         ON attribute.attrelid = index_row.indrelid
                        AND attribute.attnum = key_column.attribute_number
                       JOIN pg_catalog.pg_opclass AS operator_class
                         ON operator_class.opcmethod = access_method.oid
                        AND operator_class.opcintype = attribute.atttypid
                        AND operator_class.opcdefault
                      ORDER BY key_column.position
                   )
                   AND ARRAY(
                     SELECT indexed_collation.collation_oid
                       FROM pg_catalog.unnest(
                              index_row.indcollation::pg_catalog.oid[]
                            ) WITH ORDINALITY AS indexed_collation(
                              collation_oid,
                              position
                            )
                      ORDER BY indexed_collation.position
                   ) = ARRAY(
                     SELECT attribute.attcollation
                       FROM pg_catalog.unnest(expected.key_columns)
                              WITH ORDINALITY AS key_column(
                                attribute_number,
                                position
                              )
                       JOIN pg_catalog.pg_attribute AS attribute
                         ON attribute.attrelid = index_row.indrelid
                        AND attribute.attnum = key_column.attribute_number
                      ORDER BY key_column.position
                   )
                   AND ARRAY(
                     SELECT indexed_option.option_value
                       FROM pg_catalog.unnest(
                              index_row.indoption::pg_catalog.int2[]
                            ) WITH ORDINALITY AS indexed_option(
                              option_value,
                              position
                            )
                      ORDER BY indexed_option.position
                   ) = ARRAY(
                     SELECT 0::pg_catalog.int2
                       FROM pg_catalog.unnest(expected.key_columns)
                   )
                 )
                 AND (
                   SELECT pg_catalog.count(*)
                     FROM pg_catalog.pg_index AS closed_world_index
                    WHERE closed_world_index.indrelid =
                          'public.mail_delivery_release_receipt'
                            ::pg_catalog.regclass
                 ) = 4
            FROM (VALUES
              (
                'mail_delivery_release_receipt_authority_fk_idx'
                  ::pg_catalog.name,
                ARRAY[4, 5]::pg_catalog.int2[],
                false,
                false
              ),
              (
                'mail_delivery_release_receipt_digest_unique',
                ARRAY[7]::pg_catalog.int2[],
                true,
                false
              ),
              (
                'mail_delivery_release_receipt_operation_unique',
                ARRAY[2]::pg_catalog.int2[],
                true,
                false
              ),
              (
                'mail_delivery_release_receipt_pkey',
                ARRAY[1]::pg_catalog.int2[],
                true,
                true
              )
            ) AS expected(
              index_name,
              key_columns,
              is_unique,
              is_primary
            )
            JOIN pg_catalog.pg_class AS index_relation
              ON index_relation.relname = expected.index_name
             AND index_relation.relnamespace =
                   'public'::pg_catalog.regnamespace
            JOIN pg_catalog.pg_index AS index_row
              ON index_row.indexrelid = index_relation.oid
             AND index_row.indrelid =
                   'public.mail_delivery_release_receipt'
                     ::pg_catalog.regclass
            JOIN pg_catalog.pg_am AS access_method
              ON access_method.oid = index_relation.relam
        )
        AND (
          SELECT pg_catalog.count(*) = 4
                 AND pg_catalog.bool_and(
                   trigger_row.tgenabled = 'A'
                   AND trigger_row.tgtype = expected.trigger_type
                   AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
                     expected.function_identity
                   )
                   AND pg_catalog.cardinality(
                         trigger_row.tgattr::pg_catalog.int2[]
                       ) = 0
                   AND trigger_row.tgqual IS NULL
                   AND trigger_row.tgoldtable IS NULL
                   AND trigger_row.tgnewtable IS NULL
                   AND trigger_row.tgnargs = 0
                   AND (
                     (
                       expected.constraint_name IS NULL
                       AND trigger_row.tgconstraint = 0
                       AND NOT trigger_row.tgdeferrable
                       AND NOT trigger_row.tginitdeferred
                     )
                     OR (
                       expected.constraint_name IS NOT NULL
                       AND trigger_row.tgdeferrable
                       AND trigger_row.tginitdeferred
                       AND EXISTS (
                         SELECT 1
                           FROM pg_catalog.pg_constraint AS trigger_constraint
                          WHERE trigger_constraint.oid =
                                trigger_row.tgconstraint
                            AND trigger_constraint.conname =
                                  expected.constraint_name
                            AND trigger_constraint.contype = 't'
                            AND trigger_constraint.conrelid =
                                  'public.mail_delivery_release_receipt'
                                    ::pg_catalog.regclass
                            AND trigger_constraint.convalidated
                            AND trigger_constraint.condeferrable
                            AND trigger_constraint.condeferred
                       )
                     )
                   )
                 )
                 AND (
                   SELECT pg_catalog.count(*)
                     FROM pg_catalog.pg_trigger AS closed_world_trigger
                    WHERE closed_world_trigger.tgrelid =
                          'public.mail_delivery_release_receipt'
                            ::pg_catalog.regclass
                      AND NOT closed_world_trigger.tgisinternal
                 ) = 4
            FROM (VALUES
              (
                'mail_delivery_release_receipt_insert_authority'
                  ::pg_catalog.text,
                7::pg_catalog.int2,
                'public.enforce_mail_delivery_release_receipt_insert()'
                  ::pg_catalog.text,
                NULL::pg_catalog.text
              ),
              (
                'mail_delivery_release_receipt_append_only',
                19::pg_catalog.int2,
                'public.enforce_mail_delivery_release_receipt_append_only()',
                NULL
              ),
              (
                'mail_delivery_release_receipt_no_truncate',
                34::pg_catalog.int2,
                'public.enforce_mail_delivery_release_receipt_append_only()',
                NULL
              ),
              (
                'mail_delivery_release_receipt_delete_exact',
                9::pg_catalog.int2,
                'public.enforce_mail_delivery_release_receipt_delete_exact()',
                'mail_delivery_release_receipt_delete_exact'
              )
            ) AS expected(
              trigger_name,
              trigger_type,
              function_identity,
              constraint_name
            )
            JOIN pg_catalog.pg_trigger AS trigger_row
              ON trigger_row.tgname = expected.trigger_name
             AND trigger_row.tgrelid =
                 'public.mail_delivery_release_receipt'
                   ::pg_catalog.regclass
             AND NOT trigger_row.tgisinternal
        )
        AND NOT EXISTS (
          SELECT 1
            FROM expected_triggers AS expected
            LEFT JOIN pg_catalog.pg_namespace AS namespace
              ON namespace.nspname = 'public'
            LEFT JOIN pg_catalog.pg_class AS relation
              ON relation.relnamespace = namespace.oid
             AND relation.relname = expected.relation_name
            LEFT JOIN pg_catalog.pg_trigger AS trigger_row
              ON trigger_row.tgrelid = relation.oid
             AND trigger_row.tgname = expected.trigger_name
             AND NOT trigger_row.tgisinternal
             AND trigger_row.tgenabled = 'A'
           WHERE trigger_row.oid IS NULL
        )
        AND (
          SELECT pg_catalog.array_agg(
                   pg_catalog.lower(expanded.privilege_type)
                   ORDER BY pg_catalog.lower(expanded.privilege_type)
                 ) = ARRAY[
                   'delete', 'insert', 'maintain', 'references',
                   'select', 'trigger', 'truncate', 'update'
                 ]::pg_catalog.text[]
                 AND pg_catalog.bool_and(
                   expanded.grantee =
                     (SELECT oid FROM pg_catalog.pg_roles
                       WHERE rolname = 'learncoding_owner')
                   AND expanded.grantor =
                     (SELECT oid FROM pg_catalog.pg_roles
                       WHERE rolname = 'learncoding_owner')
                   AND NOT expanded.is_grantable
                 )
            FROM receipt_acl AS expanded
        )
        AND (
          SELECT COALESCE(
                   pg_catalog.array_agg(
                     pg_catalog.concat_ws(
                       '|',
                       attribute.attname,
                       pg_catalog.pg_get_userbyid(expanded.grantor),
                       pg_catalog.pg_get_userbyid(expanded.grantee),
                       pg_catalog.lower(expanded.privilege_type),
                       expanded.is_grantable::pg_catalog.text
                     )
                     ORDER BY attribute.attnum, expanded.grantor,
                              expanded.grantee, expanded.privilege_type,
                              expanded.is_grantable
                   ),
                   ARRAY[]::pg_catalog.text[]
                 ) = ARRAY[
                   'outbox_id|learncoding_owner|learncoding_worker|select|false',
                   'operation_id|learncoding_owner|learncoding_worker|select|false',
                   'idempotency_authority_version|learncoding_owner|learncoding_worker|select|false',
                   'idempotency_authority_sha256|learncoding_owner|learncoding_worker|select|false',
                   'idempotency_original_payload_sha256|learncoding_owner|learncoding_worker|select|false',
                   'release_version|learncoding_owner|learncoding_worker|select|false',
                   'release_receipt_sha256|learncoding_owner|learncoding_worker|select|false'
                 ]::pg_catalog.text[]
            FROM pg_catalog.pg_attribute AS attribute
            CROSS JOIN LATERAL pg_catalog.aclexplode(
              attribute.attacl
            ) AS expanded
           WHERE attribute.attrelid =
                 'public.mail_delivery_release_receipt'
                   ::pg_catalog.regclass
             AND attribute.attnum > 0
             AND NOT attribute.attisdropped
        )
        AND (
          SELECT pg_catalog.bool_and(
                   pg_catalog.has_column_privilege(
                     managed.role_name::pg_catalog.text,
                     'public.mail_delivery_release_receipt',
                     attribute.attname::pg_catalog.text,
                     privilege.privilege_name
                   ) = (
                     managed.role_name = 'learncoding_worker'
                     AND privilege.privilege_name = 'SELECT'
                     AND attribute.attnum BETWEEN 1 AND 7
                   )
                 )
            FROM (VALUES
              ('learncoding_app'::pg_catalog.name),
              ('learncoding_worker'::pg_catalog.name),
              ('learncoding_ops'::pg_catalog.name),
              ('learncoding_backup_reporter'::pg_catalog.name),
              ('learncoding_acl_default'::pg_catalog.name),
              ('learncoding_acl_grantor'::pg_catalog.name),
              ('learncoding_acl_leaf'::pg_catalog.name)
            ) AS managed(role_name)
            CROSS JOIN (VALUES
              ('SELECT'::pg_catalog.text),
              ('INSERT'::pg_catalog.text),
              ('UPDATE'::pg_catalog.text),
              ('REFERENCES'::pg_catalog.text)
            ) AS privilege(privilege_name)
            CROSS JOIN pg_catalog.pg_attribute AS attribute
           WHERE attribute.attrelid =
                 'public.mail_delivery_release_receipt'
                   ::pg_catalog.regclass
             AND attribute.attnum > 0
             AND NOT attribute.attisdropped
        )
        AND (
          SELECT pg_catalog.bool_and(
                   NOT pg_catalog.has_table_privilege(
                     managed.role_name::pg_catalog.text,
                     'public.mail_delivery_release_receipt',
                     privilege.privilege_name
                   )
                 )
            FROM (VALUES
              ('learncoding_app'::pg_catalog.name),
              ('learncoding_worker'::pg_catalog.name),
              ('learncoding_ops'::pg_catalog.name),
              ('learncoding_backup_reporter'::pg_catalog.name),
              ('learncoding_acl_default'::pg_catalog.name),
              ('learncoding_acl_grantor'::pg_catalog.name),
              ('learncoding_acl_leaf'::pg_catalog.name)
            ) AS managed(role_name)
            CROSS JOIN (VALUES
              ('SELECT'::pg_catalog.text),
              ('INSERT'::pg_catalog.text),
              ('UPDATE'::pg_catalog.text),
              ('DELETE'::pg_catalog.text),
              ('TRUNCATE'::pg_catalog.text),
              ('REFERENCES'::pg_catalog.text),
              ('TRIGGER'::pg_catalog.text),
              ('MAINTAIN'::pg_catalog.text)
            ) AS privilege(privilege_name)
        )
        AND pg_catalog.has_function_privilege(
          'learncoding_app',
          'public.release_email_outbox_delivery(uuid,uuid,text,text,text)',
          'EXECUTE'
        )
        AND NOT pg_catalog.has_function_privilege(
          'learncoding_worker',
          'public.release_email_outbox_delivery(uuid,uuid,text,text,text)',
          'EXECUTE'
        )
        AND NOT pg_catalog.has_function_privilege(
          'learncoding_ops',
          'public.release_email_outbox_delivery(uuid,uuid,text,text,text)',
          'EXECUTE'
        )
        AND NOT pg_catalog.has_function_privilege(
          'learncoding_backup_reporter',
          'public.release_email_outbox_delivery(uuid,uuid,text,text,text)',
          'EXECUTE'
        )
        AND pg_catalog.has_function_privilege(
          'learncoding_backup_reporter',
          'public.enqueue_backup_status_mail_authority(text,text)',
          'EXECUTE'
        )
        AND NOT pg_catalog.has_function_privilege(
          'learncoding_app',
          'public.enqueue_backup_status_mail_authority(text,text)',
          'EXECUTE'
        )
        AND NOT EXISTS (
          SELECT 1
            FROM guarded_routines AS guarded
            JOIN pg_catalog.pg_proc AS routine
              ON routine.oid = pg_catalog.to_regprocedure(guarded.identity)
            CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(
                routine.proacl,
                pg_catalog.acldefault('f', routine.proowner)
              )
            ) AS expanded
            JOIN pg_catalog.pg_roles AS grantee
              ON grantee.oid = expanded.grantee
           WHERE grantee.rolname IN (
             'learncoding_acl_default',
             'learncoding_acl_grantor',
             'learncoding_acl_leaf'
           )
        )
        AND NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_class AS relation
            CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(
                relation.relacl,
                pg_catalog.acldefault('r', relation.relowner)
              )
            ) AS expanded
            JOIN pg_catalog.pg_roles AS grantee
              ON grantee.oid = expanded.grantee
           WHERE relation.oid =
                 'public.mail_delivery_release_receipt'::pg_catalog.regclass
             AND grantee.rolname IN (
               'learncoding_acl_default',
               'learncoding_acl_grantor',
               'learncoding_acl_leaf'
             )
        )
        AND NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_attribute AS attribute
            CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS expanded
            JOIN pg_catalog.pg_roles AS grantee
              ON grantee.oid = expanded.grantee
           WHERE attribute.attrelid IN (
             'public.email_outbox'::pg_catalog.regclass,
             'public.mail_delivery_release_receipt'::pg_catalog.regclass
           )
             AND attribute.attacl IS NOT NULL
             AND grantee.rolname IN (
               'learncoding_acl_default',
               'learncoding_acl_grantor',
               'learncoding_acl_leaf'
             )
        )
        AND (
          SELECT pg_catalog.pg_get_userbyid(routine.proowner) =
                   'learncoding_owner'
                 AND routine.prosecdef
                 AND routine.proconfig =
                   ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
            FROM pg_catalog.pg_proc AS routine
           WHERE routine.oid = pg_catalog.to_regprocedure(
             'public.release_email_outbox_delivery(uuid,uuid,text,text,text)'
           )
        )
      )::pg_catalog.text;`,
    ),
    "true",
  );
}

function seedAdministrator(port) {
  applyAsOwner(
    port,
    `
    INSERT INTO public."user" (
      id, name, email, email_verified, role, status, banned,
      must_change_password
    ) VALUES (
      '${ADMIN_ID}', 'Mail 0069 Administrator', '${ADMIN_EMAIL}',
      true, 'admin', 'active', false, false
    );
  `,
  );
}

function installReviewedApplicationPrivileges(port) {
  // Task 7A preserves the reviewed P3-2 DELETE capability until the later
  // owner-owned account-deletion and retention routines replace both callers.
  // Application inserts remain column-scoped; database-owned counters and
  // timestamps must come from defaults rather than a broad table grant.
  assert.equal(
    scalar(
      port,
      database,
      `
      SELECT (
        pg_catalog.has_table_privilege(
          'learncoding_app', 'public.email_outbox', 'SELECT'
        )
        AND NOT pg_catalog.has_table_privilege(
          'learncoding_app', 'public.email_outbox', 'INSERT'
        )
        AND (
          SELECT pg_catalog.bool_and(pg_catalog.has_column_privilege(
            'learncoding_app', 'public.email_outbox', reviewed.column_name,
            'INSERT'
          ))
            FROM pg_catalog.unnest(ARRAY[
              'id', 'operation_id', 'user_id', 'delivery_scope_key',
              'to_email', 'template', 'template_version', 'variables',
              'idempotency_key', 'idempotency_authority_version',
              'status', 'next_attempt_at'
            ]::pg_catalog.text[]) AS reviewed(column_name)
        )
        AND NOT EXISTS (
          SELECT 1
            FROM pg_catalog.unnest(ARRAY[
              'attempt_count', 'claim_version', 'created_at', 'updated_at'
            ]::pg_catalog.text[]) AS protected(column_name)
           WHERE pg_catalog.has_column_privilege(
             'learncoding_app', 'public.email_outbox', protected.column_name,
             'INSERT'
           )
        )
        AND NOT pg_catalog.has_table_privilege(
          'learncoding_app', 'public.email_outbox', 'UPDATE'
        )
        AND pg_catalog.has_table_privilege(
          'learncoding_app', 'public.email_outbox', 'DELETE'
        )
        AND pg_catalog.has_table_privilege(
          'learncoding_ops', 'public.email_outbox', 'SELECT'
        )
        AND NOT pg_catalog.has_table_privilege(
          'learncoding_ops', 'public.email_outbox', 'INSERT'
        )
        AND NOT pg_catalog.has_table_privilege(
          'learncoding_ops', 'public.email_outbox', 'UPDATE'
        )
        AND pg_catalog.has_table_privilege(
          'learncoding_ops', 'public.email_outbox', 'DELETE'
        )
        AND NOT pg_catalog.has_table_privilege(
          'learncoding_app', 'public.email_outbox', 'TRUNCATE'
        )
        AND NOT pg_catalog.has_table_privilege(
          'learncoding_ops', 'public.email_outbox', 'TRUNCATE'
        )
      )::pg_catalog.text;`,
    ),
    "true",
  );
}
function backupResult(port, runKey, outcome) {
  return scalar(
    port,
    database,
    `
    SELECT pg_catalog.concat_ws(
      '|',
      result.acknowledgement,
      result.authority_id::pg_catalog.text,
      result.outbox_id::pg_catalog.text,
      result.operation_id::pg_catalog.text
    )
      FROM public.enqueue_backup_status_mail_authority(
        '${runKey}', '${outcome}'
      ) AS result;`,
    "learncoding_backup_reporter",
  );
}

function proveBackupIssuance(port) {
  const runKey = "69000000-0000-4000-8000-000000000010";
  const queued = backupResult(port, runKey, "success");
  assert.match(
    queued,
    /^queued\|[0-9a-f-]{36}\|[0-9a-f-]{36}\|[0-9a-f-]{36}$/u,
  );
  assert.equal(
    backupResult(port, runKey, "success"),
    queued.replace(/^queued/u, "existing"),
  );
  const [, sourceAuthorityId, sourceOutboxId, sourceOperationId] =
    queued.split("|");
  const backupTuple = scalar(
    port,
    database,
    `
    SELECT pg_catalog.concat_ws(
      '|',
      source.id::pg_catalog.text,
      source.outbox_id::pg_catalog.text,
      source.operation_id::pg_catalog.text,
      source.outcome,
      outbox.idempotency_authority_version,
      outbox.idempotency_authority_sha256,
      outbox.idempotency_original_payload_sha256,
      receipt.idempotency_authority_version,
      receipt.idempotency_authority_sha256,
      receipt.idempotency_original_payload_sha256,
      receipt.release_version,
      receipt.release_receipt_sha256
    )
      FROM public.backup_status_mail_authority AS source
      JOIN public.email_outbox AS outbox
        ON outbox.id = source.outbox_id
       AND outbox.operation_id = source.operation_id
      JOIN public.mail_delivery_release_receipt AS receipt
        ON receipt.outbox_id = outbox.id
       AND receipt.operation_id = outbox.operation_id
     WHERE source.run_key = '${runKey}';`,
  );
  const [
    tupleAuthorityId,
    tupleOutboxId,
    tupleOperationId,
    tupleOutcome,
    outboxAuthorityVersion,
    outboxAuthoritySha256,
    outboxOriginalPayloadSha256,
    receiptAuthorityVersion,
    receiptAuthoritySha256,
    receiptOriginalPayloadSha256,
    receiptReleaseVersion,
    backupReceiptSha256,
  ] = backupTuple.split("|");
  assert.deepEqual(
    [
      tupleAuthorityId,
      tupleOutboxId,
      tupleOperationId,
      tupleOutcome,
      receiptAuthorityVersion,
      receiptAuthoritySha256,
      receiptOriginalPayloadSha256,
    ],
    [
      sourceAuthorityId,
      sourceOutboxId,
      sourceOperationId,
      "success",
      outboxAuthorityVersion,
      outboxAuthoritySha256,
      outboxOriginalPayloadSha256,
    ],
  );
  assert.equal(receiptReleaseVersion, "task7-v1");
  assert.equal(
    backupReceiptSha256,
    releaseReceiptSha256({
      authoritySha256: receiptAuthoritySha256,
      authorityVersion: receiptAuthorityVersion,
      operationId: tupleOperationId,
      originalPayloadSha256: receiptOriginalPayloadSha256,
      outboxId: tupleOutboxId,
      releaseVersion: receiptReleaseVersion,
    }),
  );
  const beforeDivergentBackupReplay = mailAuthorityDigest(port);
  const divergentOutcome = psql(
    port,
    database,
    `
    SELECT * FROM public.enqueue_backup_status_mail_authority(
      '${runKey}', 'failure'
    );`,
    {
      allowFailure: true,
      username: "learncoding_backup_reporter",
    },
  );
  assertFailure(
    divergentOutcome,
    /backup status mail replay conflicts with durable authority/u,
  );
  assert.equal(mailAuthorityDigest(port), beforeDivergentBackupReplay);
  assert.equal(
    scalar(
      port,
      database,
      `
      SELECT (
        (SELECT pg_catalog.count(*) = 1
           FROM public.backup_status_mail_authority
          WHERE run_key = '${runKey}')
        AND (SELECT pg_catalog.count(*) = 1
           FROM public.email_outbox AS outbox
          WHERE outbox.id = (
            SELECT source.outbox_id
              FROM public.backup_status_mail_authority AS source
             WHERE source.run_key = '${runKey}'
          )
            AND outbox.delivery_release_insert_xid IS NULL
            AND outbox.delivery_release_insert_system_identifier IS NULL)
        AND (SELECT pg_catalog.count(*) = 1
           FROM public.mail_delivery_release_receipt AS receipt
          WHERE receipt.outbox_id = (
            SELECT source.outbox_id
              FROM public.backup_status_mail_authority AS source
             WHERE source.run_key = '${runKey}'
          ))
      )::pg_catalog.text;`,
    ),
    "true",
  );

  const rollbackKey = "69000000-0000-4000-8000-000000000011";
  const beforeBackupRollback = mailAuthorityDigest(port);
  psql(
    port,
    database,
    `
    BEGIN;
    SELECT * FROM public.enqueue_backup_status_mail_authority(
      '${rollbackKey}', 'failure'
    );
    ROLLBACK;
  `,
    { username: "learncoding_backup_reporter" },
  );
  assert.equal(mailAuthorityDigest(port), beforeBackupRollback);
  assert.equal(
    scalar(
      port,
      database,
      `
      SELECT (
        NOT EXISTS (
          SELECT 1 FROM public.backup_status_mail_authority
           WHERE run_key = '${rollbackKey}'
        )
        AND NOT EXISTS (
          SELECT 1
            FROM public.email_outbox
           WHERE idempotency_key = 'backup-status:v1:${rollbackKey}'
        )
      )::pg_catalog.text;`,
    ),
    "true",
  );
  const cleanRetry = backupResult(port, rollbackKey, "failure");
  assert.match(
    cleanRetry,
    /^queued\|[0-9a-f-]{36}\|[0-9a-f-]{36}\|[0-9a-f-]{36}$/u,
  );
  assert.equal(
    backupResult(port, rollbackKey, "failure"),
    cleanRetry.replace(/^queued/u, "existing"),
  );

  const beforeDeniedBackupAuthority = mailAuthorityDigest(port);
  const predecessorDenied = psql(
    port,
    database,
    `
    SELECT *
      FROM public.enqueue_backup_status_mail_authority_unreleased_0067(
        '${runKey}', 'success'
      );`,
    {
      allowFailure: true,
      username: "learncoding_backup_reporter",
    },
  );
  assertFailure(
    predecessorDenied,
    /permission denied for function enqueue_backup_status_mail_authority_unreleased_0067/u,
  );
  assert.equal(mailAuthorityDigest(port), beforeDeniedBackupAuthority);
  const directReceiptDenied = psql(
    port,
    database,
    `
    INSERT INTO public.mail_delivery_release_receipt (
      outbox_id, operation_id, idempotency_authority_version,
      idempotency_authority_sha256,
      idempotency_original_payload_sha256, release_version,
      release_receipt_sha256
    ) VALUES (
      '69000000-0000-4000-8000-000000000098',
      '69100000-0000-4000-8000-000000000098',
      'event-v1-native', '${"1".repeat(64)}', '${"2".repeat(64)}',
      'task7-v1', '${"3".repeat(64)}'
    );`,
    {
      allowFailure: true,
      username: "learncoding_backup_reporter",
    },
  );
  assertFailure(
    directReceiptDenied,
    /permission denied for table mail_delivery_release_receipt/u,
  );
  assert.equal(mailAuthorityDigest(port), beforeDeniedBackupAuthority);
  const denied = psql(
    port,
    database,
    `
    SELECT * FROM public.release_email_outbox_delivery(
      '69000000-0000-4000-8000-000000000099'::pg_catalog.uuid,
      '69100000-0000-4000-8000-000000000099'::pg_catalog.uuid,
      '${"e".repeat(64)}',
      '${"f".repeat(64)}',
      'task7-v1'
    );`,
    {
      allowFailure: true,
      username: "learncoding_backup_reporter",
    },
  );
  assertFailure(
    denied,
    /permission denied for function release_email_outbox_delivery/u,
  );
  assert.equal(mailAuthorityDigest(port), beforeDeniedBackupAuthority);
}

function appInsertSql(fixture) {
  return `
    INSERT INTO public.email_outbox (
      id, operation_id, user_id, delivery_scope_key, to_email, template,
      template_version, variables, idempotency_key,
      idempotency_authority_version, status, next_attempt_at
    ) VALUES (
      '${fixture.id}'::pg_catalog.uuid,
      '${fixture.operationId}'::pg_catalog.uuid,
      '${ADMIN_ID}',
      'a:${ADMIN_ID}',
      '${ADMIN_EMAIL}',
      'weekly-summary',
      '1',
      '{"name":"Mail 0069 Harness"}'::pg_catalog.jsonb,
      '${fixture.key}',
      'event-v1-native',
      'pending',
      pg_catalog.transaction_timestamp()
    );`;
}

function appReleaseSql(fixture) {
  return `
    SELECT receipt.release_receipt_sha256
      FROM public.release_email_outbox_delivery(
        '${fixture.id}'::pg_catalog.uuid,
        '${fixture.operationId}'::pg_catalog.uuid,
        '${fixture.key}',
        (
          SELECT outbox.idempotency_original_payload_sha256
            FROM public.email_outbox AS outbox
           WHERE outbox.id = '${fixture.id}'::pg_catalog.uuid
        ),
        'task7-v1'
      ) AS receipt;`;
}

function appInsertAndRelease(port, fixture, ending = "COMMIT") {
  return psql(
    port,
    database,
    `
    BEGIN;
    ${appInsertSql(fixture)}
    ${appReleaseSql(fixture)}
    ${ending};
  `,
    {
      allowFailure: ending === "ROLLBACK" ? false : undefined,
      username: "learncoding_app",
    },
  );
}

function claimAsWorker(port, fixture) {
  return psql(
    port,
    database,
    `
    UPDATE public.email_outbox
       SET status = 'sending',
           attempt_count = attempt_count + 1,
           claim_token = '${fixture.id}'::pg_catalog.uuid,
           claim_owner = 'mail-guarded-delivery-0069',
           claim_version = claim_version + 1,
           lease_expires_at =
             pg_catalog.statement_timestamp() + interval '180 seconds',
           updated_at = pg_catalog.statement_timestamp()
     WHERE id = '${fixture.id}'::pg_catalog.uuid
     RETURNING pg_catalog.concat_ws(
       '|',
       id::pg_catalog.text,
       status::pg_catalog.text,
       attempt_count::pg_catalog.text,
       claim_version::pg_catalog.text,
       claim_token::pg_catalog.text,
       claim_owner,
       (
         lease_expires_at >=
           pg_catalog.statement_timestamp() + interval '15 seconds'
         AND lease_expires_at <=
           pg_catalog.statement_timestamp() + interval '300 seconds'
       )::pg_catalog.text,
       (provider_call_started IS NULL)::pg_catalog.text,
       (sent_at IS NULL)::pg_catalog.text,
       (quarantined_at IS NULL)::pg_catalog.text
     );`,
    {
      allowFailure: true,
      scalar: true,
      username: "learncoding_worker",
    },
  );
}

function assertExactFirstClaim(result, fixture) {
  assert.equal(
    result.status,
    0,
    `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  );
  assert.equal(
    result.stdout.trim(),
    [
      fixture.id,
      "sending",
      "1",
      "1",
      fixture.id,
      "mail-guarded-delivery-0069",
      "true",
      "true",
      "true",
      "true",
    ].join("|"),
  );
}

function outboxStateDigest(port, outboxId) {
  return scalar(
    port,
    database,
    `
    SELECT pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(
        pg_catalog.to_jsonb(outbox)::pg_catalog.text,
        'UTF8'
      )),
      'hex'
    )
      FROM public.email_outbox AS outbox
     WHERE outbox.id = '${outboxId}'::pg_catalog.uuid;`,
  );
}
function armConsoleSql(fixture) {
  return `
    UPDATE public.email_outbox
       SET provider_call_started = pg_catalog.statement_timestamp(),
           adapter = 'console',
           dispatch_binding_version = 'console-json-v1',
           dispatch_binding_sha256 = '${"6".repeat(64)}',
           provider_correlation_version = 'opaque-sha256-v1',
           provider_evidence_version = NULL,
           provider_evidence_sha256 = NULL,
           provider_request_body_sha256 = '${"7".repeat(64)}',
           provider_request_body_length = 42,
           lease_expires_at =
             pg_catalog.statement_timestamp() + interval '180 seconds',
           updated_at = pg_catalog.statement_timestamp()
     WHERE id = '${fixture.id}'::pg_catalog.uuid;`;
}

function armAsWorker(port, fixture) {
  const sql = armConsoleSql(fixture).replace(
    /;\s*$/u,
    `
    RETURNING pg_catalog.concat_ws(
      '|',
      id::pg_catalog.text,
      status::pg_catalog.text,
      claim_version::pg_catalog.text,
      claim_token::pg_catalog.text,
      claim_owner,
      (provider_call_started IS NOT NULL)::pg_catalog.text,
      adapter,
      dispatch_binding_version,
      dispatch_binding_sha256,
      provider_correlation_version,
      (provider_evidence_version IS NULL)::pg_catalog.text,
      (provider_evidence_sha256 IS NULL)::pg_catalog.text,
      provider_request_body_sha256,
      provider_request_body_length::pg_catalog.text,
      (
        lease_expires_at >=
          pg_catalog.statement_timestamp() + interval '15 seconds'
        AND lease_expires_at <=
          pg_catalog.statement_timestamp() + interval '300 seconds'
      )::pg_catalog.text
    );`,
  );
  const result = psql(port, database, sql, {
    allowFailure: true,
    scalar: true,
    username: "learncoding_worker",
  });
  assert.equal(result.status, 0);
  assert.equal(
    result.stdout.trim(),
    [
      fixture.id,
      "sending",
      "1",
      fixture.id,
      "mail-guarded-delivery-0069",
      "true",
      "console",
      "console-json-v1",
      "6".repeat(64),
      "opaque-sha256-v1",
      "true",
      "true",
      "7".repeat(64),
      "42",
      "true",
    ].join("|"),
  );
}

function releaseReceiptSha256({
  authoritySha256,
  authorityVersion,
  operationId,
  originalPayloadSha256,
  outboxId,
  releaseVersion,
}) {
  return createHash("sha256")
    .update(
      [
        "mail-delivery-release-v1",
        outboxId,
        operationId,
        authorityVersion,
        authoritySha256,
        originalPayloadSha256,
        releaseVersion,
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
}
function proveApplicationRelease(port) {
  appInsertAndRelease(port, FIXTURES.main);
  const receiptTuple = scalar(
    port,
    database,
    `
    SELECT pg_catalog.concat_ws(
      '|',
      receipt.outbox_id::pg_catalog.text,
      receipt.operation_id::pg_catalog.text,
      receipt.idempotency_authority_version,
      receipt.idempotency_authority_sha256,
      receipt.idempotency_original_payload_sha256,
      receipt.release_version,
      receipt.release_receipt_sha256
    )
      FROM public.mail_delivery_release_receipt AS receipt
     WHERE receipt.outbox_id = '${FIXTURES.main.id}'::pg_catalog.uuid;`,
  );
  const [
    receiptOutboxId,
    receiptOperationId,
    receiptAuthorityVersion,
    receiptAuthoritySha256,
    receiptOriginalPayloadSha256,
    receiptReleaseVersion,
    receiptDigest,
  ] = receiptTuple.split("|");
  assert.deepEqual(
    [
      receiptOutboxId,
      receiptOperationId,
      receiptAuthorityVersion,
      receiptAuthoritySha256,
      receiptReleaseVersion,
    ],
    [
      FIXTURES.main.id,
      FIXTURES.main.operationId,
      "event-v1-native",
      FIXTURES.main.key,
      "task7-v1",
    ],
  );
  assert.match(receiptOriginalPayloadSha256, /^[0-9a-f]{64}$/u);
  assert.equal(
    receiptDigest,
    releaseReceiptSha256({
      authoritySha256: receiptAuthoritySha256,
      authorityVersion: receiptAuthorityVersion,
      operationId: receiptOperationId,
      originalPayloadSha256: receiptOriginalPayloadSha256,
      outboxId: receiptOutboxId,
      releaseVersion: receiptReleaseVersion,
    }),
  );
  assert.equal(
    scalar(
      port,
      database,
      `
      SELECT (
        outbox.delivery_release_insert_xid IS NULL
        AND outbox.delivery_release_insert_system_identifier IS NULL
        AND receipt.release_receipt_sha256 = '${receiptDigest}'
      )::pg_catalog.text
        FROM public.email_outbox AS outbox
        JOIN public.mail_delivery_release_receipt AS receipt
          ON receipt.outbox_id = outbox.id
         AND receipt.operation_id = outbox.operation_id
       WHERE outbox.id = '${FIXTURES.main.id}'::pg_catalog.uuid;`,
    ),
    "true",
  );

  const beforeUnauthorizedRelease = mailAuthorityDigest(port);
  const workerDenied = psql(
    port,
    database,
    `
    SELECT * FROM public.release_email_outbox_delivery(
      '${receiptOutboxId}'::pg_catalog.uuid,
      '${receiptOperationId}'::pg_catalog.uuid,
      '${receiptAuthoritySha256}',
      '${receiptOriginalPayloadSha256}',
      '${receiptReleaseVersion}'
    );`,
    {
      allowFailure: true,
      username: "learncoding_worker",
    },
  );
  assertFailure(
    workerDenied,
    /permission denied for function release_email_outbox_delivery/u,
  );
  assert.equal(mailAuthorityDigest(port), beforeUnauthorizedRelease);

  const missingCandidate = psql(
    port,
    database,
    `
    SELECT * FROM public.release_email_outbox_delivery(
      '69000000-0000-4000-8000-000000000097'::pg_catalog.uuid,
      '69100000-0000-4000-8000-000000000097'::pg_catalog.uuid,
      '${"a".repeat(64)}',
      '${"b".repeat(64)}',
      'task7-v1'
    );`,
    {
      allowFailure: true,
      username: "learncoding_app",
    },
  );
  assertFailure(
    missingCandidate,
    /email outbox delivery release candidate is missing/u,
  );
  assert.equal(mailAuthorityDigest(port), beforeUnauthorizedRelease);

  assert.equal(
    scalar(port, database, appReleaseSql(FIXTURES.main), "learncoding_app"),
    receiptDigest,
  );

  const beforeWrongRelease = mailAuthorityDigest(port);
  const wrong = psql(
    port,
    database,
    `
    SELECT * FROM public.release_email_outbox_delivery(
      '${FIXTURES.main.id}'::pg_catalog.uuid,
      '${FIXTURES.main.operationId}'::pg_catalog.uuid,
      '${"0".repeat(64)}',
      (
        SELECT idempotency_original_payload_sha256
          FROM public.email_outbox
         WHERE id = '${FIXTURES.main.id}'::pg_catalog.uuid
      ),
      'task7-v1'
    );`,
    {
      allowFailure: true,
      username: "learncoding_app",
    },
  );
  assertFailure(wrong, /email outbox delivery release receipt conflicts/u);
  assert.equal(mailAuthorityDigest(port), beforeWrongRelease);

  const beforeUnreleasedInsert = mailAuthorityDigest(port);
  const unreleasedInsert = psql(
    port,
    database,
    `
    BEGIN;
    ${appInsertSql(FIXTURES.delayed)}
    COMMIT;
  `,
    {
      allowFailure: true,
      username: "learncoding_app",
    },
  );
  assertFailure(
    unreleasedInsert,
    /email outbox delivery release is incomplete at commit/u,
  );
  assert.equal(mailAuthorityDigest(port), beforeUnreleasedInsert);
  assert.equal(
    scalar(
      port,
      database,
      `
      SELECT (
        NOT EXISTS (
          SELECT 1 FROM public.email_outbox
           WHERE id = '${FIXTURES.delayed.id}'::pg_catalog.uuid
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.mail_delivery_release_receipt
           WHERE outbox_id = '${FIXTURES.delayed.id}'::pg_catalog.uuid
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.email_outbox_idempotency_authority
           WHERE idempotency_sha256 = '${FIXTURES.delayed.key}'
        )
      )::pg_catalog.text;`,
    ),
    "true",
  );

  const beforeAppRollback = mailAuthorityDigest(port);
  appInsertAndRelease(port, FIXTURES.rollback, "ROLLBACK");
  assert.equal(mailAuthorityDigest(port), beforeAppRollback);
  assert.equal(
    scalar(
      port,
      database,
      `
      SELECT (
        NOT EXISTS (
          SELECT 1 FROM public.email_outbox
           WHERE id = '${FIXTURES.rollback.id}'::pg_catalog.uuid
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.mail_delivery_release_receipt
           WHERE outbox_id = '${FIXTURES.rollback.id}'::pg_catalog.uuid
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.email_outbox_idempotency_authority
           WHERE idempotency_sha256 = '${FIXTURES.rollback.key}'
        )
      )::pg_catalog.text;`,
    ),
    "true",
  );
  appInsertAndRelease(port, FIXTURES.rollback);
  appInsertAndRelease(port, FIXTURES.finalGuard);

  appInsertAndRelease(port, FIXTURES.stateArc);
  const beforeDirectReceipt = mailAuthorityDigest(port);
  const direct = psql(
    port,
    database,
    `
    INSERT INTO public.mail_delivery_release_receipt (
      outbox_id, operation_id, idempotency_authority_version,
      idempotency_authority_sha256,
      idempotency_original_payload_sha256, release_version,
      release_receipt_sha256
    ) VALUES (
      '${FIXTURES.main.id}', '${FIXTURES.main.operationId}',
      'event-v1-native', '${FIXTURES.main.key}', '${"1".repeat(64)}',
      'task7-v1', '${"2".repeat(64)}'
    );`,
    {
      allowFailure: true,
      username: "learncoding_app",
    },
  );
  assertFailure(
    direct,
    /permission denied for table mail_delivery_release_receipt/u,
  );
  assert.equal(mailAuthorityDigest(port), beforeDirectReceipt);
}

function proveMarkerPairIsolation(port) {
  const currentSystemIdentifier = BigInt(
    scalar(
      port,
      database,
      `
      SELECT control.system_identifier::pg_catalog.text
        FROM pg_catalog.pg_control_system() AS control;`,
    ),
  );
  const wrongSystemIdentifier = currentSystemIdentifier === 1n ? 2n : 1n;
  const before = mailAuthorityDigest(port);
  const wrongClusterMarker = applyAsOwner(
    port,
    `
    UPDATE public.email_outbox
       SET delivery_release_insert_xid = pg_catalog.pg_current_xact_id(),
           delivery_release_insert_system_identifier =
             ${wrongSystemIdentifier}
     WHERE id = '${FIXTURES.main.id}'::pg_catalog.uuid;
  `,
    { allowFailure: true },
  );
  assertFailure(
    wrongClusterMarker,
    /email outbox delivery release (insert xid is immutable|insert identity is invalid)/u,
  );
  assert.equal(mailAuthorityDigest(port), before);
  assert.equal(
    scalar(
      port,
      database,
      `
      SELECT (
        delivery_release_insert_xid IS NULL
        AND delivery_release_insert_system_identifier IS NULL
      )::pg_catalog.text
        FROM public.email_outbox
       WHERE id = '${FIXTURES.main.id}'::pg_catalog.uuid;`,
    ),
    "true",
  );
}

function installLateInsertMutationTrigger(port) {
  applyAsOwner(
    port,
    `
    CREATE OR REPLACE FUNCTION
      public.mail_guarded_delivery_0069_late_insert_mutation()
    RETURNS pg_catalog.trigger
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, pg_temp
    AS $function$
    BEGIN
      IF TG_OP IS DISTINCT FROM 'INSERT'
         OR TG_RELID IS DISTINCT FROM
              'public.email_outbox'::pg_catalog.regclass
      THEN
        RAISE EXCEPTION 'mail 0069 late insert mutation trigger is misbound'
          USING ERRCODE = '23514';
      END IF;
      NEW.to_email :=
        'mail-guarded-delivery-0069-mutated@example.invalid';
      RETURN NEW;
    END
    $function$;
    ALTER FUNCTION
      public.mail_guarded_delivery_0069_late_insert_mutation()
      OWNER TO learncoding_owner;
    CREATE TRIGGER zzzz_mail_guarded_delivery_0069_late_insert_mutation
    BEFORE INSERT ON public.email_outbox
    FOR EACH ROW
    EXECUTE FUNCTION
      public.mail_guarded_delivery_0069_late_insert_mutation();
    ALTER TABLE ONLY public.email_outbox
      ENABLE ALWAYS TRIGGER
        zzzz_mail_guarded_delivery_0069_late_insert_mutation;
  `,
  );
}

function removeLateInsertMutationTrigger(port) {
  applyAsOwner(
    port,
    `
    DROP TRIGGER zzzz_mail_guarded_delivery_0069_late_insert_mutation
      ON public.email_outbox;
    DROP FUNCTION
      public.mail_guarded_delivery_0069_late_insert_mutation();
  `,
  );
}

function proveLateInsertMutationRollback(port) {
  installLateInsertMutationTrigger(port);
  const before = mailAuthorityDigest(port);
  const lateInsert = psql(
    port,
    database,
    `
    BEGIN;
    ${appInsertSql(FIXTURES.lateInsert)}
    ${appReleaseSql(FIXTURES.lateInsert)}
    COMMIT;
  `,
    {
      allowFailure: true,
      username: "learncoding_app",
    },
  );
  assertFailure(
    lateInsert,
    /email outbox delivery release final insert state is invalid/u,
  );
  assert.equal(mailAuthorityDigest(port), before);
  assert.equal(
    scalar(
      port,
      database,
      `
      SELECT (
        NOT EXISTS (
          SELECT 1
            FROM public.email_outbox
           WHERE id = '${FIXTURES.lateInsert.id}'::pg_catalog.uuid
        )
        AND NOT EXISTS (
          SELECT 1
            FROM public.mail_delivery_release_receipt
           WHERE outbox_id =
                 '${FIXTURES.lateInsert.id}'::pg_catalog.uuid
        )
        AND NOT EXISTS (
          SELECT 1
            FROM public.email_outbox_idempotency_authority
           WHERE idempotency_sha256 = '${FIXTURES.lateInsert.key}'
        )
      )::pg_catalog.text;`,
    ),
    "true",
  );
  removeLateInsertMutationTrigger(port);
}

function proveDeferredInitialTimestampRollback(port) {
  const futureInsert = appInsertSql(FIXTURES.futureTimestamp).replaceAll(
    "pg_catalog.transaction_timestamp()",
    "pg_catalog.transaction_timestamp() + interval '1 day'",
  );
  const beforeData = mailAuthorityDigest(port);
  const beforeCatalog = guardedAclDigest(port);
  const futureTimestamp = psql(
    port,
    database,
    `
    BEGIN;
    ALTER TABLE ONLY public.email_outbox
      DISABLE TRIGGER zz_email_outbox_delivery_release_insert_final;
    SET SESSION AUTHORIZATION learncoding_app;
    ${futureInsert}
    SET CONSTRAINTS
      email_outbox_delivery_release_commit_exact IMMEDIATE;
    COMMIT;
  `,
    {
      allowFailure: true,
      username: "postgres",
    },
  );
  assertFailure(
    futureTimestamp,
    /email outbox initial timestamps are invalid/u,
  );
  assert.equal(mailAuthorityDigest(port), beforeData);
  assert.equal(guardedAclDigest(port), beforeCatalog);
  assert.equal(
    scalar(
      port,
      database,
      `
      SELECT (
        (
          SELECT trigger_row.tgenabled = 'A'
            FROM pg_catalog.pg_trigger AS trigger_row
           WHERE trigger_row.tgrelid =
                 'public.email_outbox'::pg_catalog.regclass
             AND trigger_row.tgname =
                   'zz_email_outbox_delivery_release_insert_final'
             AND NOT trigger_row.tgisinternal
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.email_outbox
           WHERE id = '${FIXTURES.futureTimestamp.id}'::pg_catalog.uuid
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.mail_delivery_release_receipt
           WHERE outbox_id =
                 '${FIXTURES.futureTimestamp.id}'::pg_catalog.uuid
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.email_outbox_idempotency_authority
           WHERE idempotency_sha256 = '${FIXTURES.futureTimestamp.key}'
        )
      )::pg_catalog.text;`,
    ),
    "true",
  );
}

function proveReplicaDeleteRollback(port) {
  const created = appInsertAndRelease(port, FIXTURES.replicaDelete);
  assert.equal(created.status, 0);
  const assertFixtureIntact = () => {
    assert.equal(
      scalar(
        port,
        database,
        `
        SELECT (
          (
            SELECT pg_catalog.count(*)
              FROM public.email_outbox
             WHERE id = '${FIXTURES.replicaDelete.id}'::pg_catalog.uuid
          ) = 1
          AND (
            SELECT pg_catalog.count(*)
              FROM public.mail_delivery_release_receipt
             WHERE outbox_id =
                   '${FIXTURES.replicaDelete.id}'::pg_catalog.uuid
          ) = 1
          AND (
            SELECT pg_catalog.count(*)
              FROM public.email_outbox_idempotency_authority
             WHERE idempotency_sha256 = '${FIXTURES.replicaDelete.key}'
          ) = 1
        )::pg_catalog.text;`,
      ),
      "true",
    );
  };

  const before = mailAuthorityDigest(port);
  const replicaDelete = psql(
    port,
    database,
    `
    BEGIN;
    SET LOCAL session_replication_role = replica;
    DELETE FROM public.email_outbox
     WHERE id = '${FIXTURES.replicaDelete.id}'::pg_catalog.uuid;
    COMMIT;
  `,
    {
      allowFailure: true,
      username: "postgres",
    },
  );
  assertFailure(
    replicaDelete,
    /email outbox deletion would orphan a durable release receipt/u,
  );
  assert.equal(mailAuthorityDigest(port), before);
  assertFixtureIntact();

  const beforeReceiptDelete = mailAuthorityDigest(port);
  const replicaReceiptDelete = psql(
    port,
    database,
    `
    BEGIN;
    SET LOCAL session_replication_role = replica;
    DELETE FROM public.mail_delivery_release_receipt
     WHERE outbox_id =
           '${FIXTURES.replicaDelete.id}'::pg_catalog.uuid;
    COMMIT;
  `,
    {
      allowFailure: true,
      username: "postgres",
    },
  );
  assertFailure(
    replicaReceiptDelete,
    /mail delivery release receipt parent still exists/u,
  );
  assert.equal(mailAuthorityDigest(port), beforeReceiptDelete);
  assertFixtureIntact();
}

function installLateMutationTrigger(port, mutationKind) {
  const mutationSql = {
    createdAt: "NEW.created_at := NEW.created_at + interval '1 second';",
    dispatch: `NEW.dispatch_binding_sha256 := '${"9".repeat(64)}';`,
    fence: "NEW.claim_version := OLD.claim_version + 1;",
    payload: "NEW.to_email := 'late-mutation@example.invalid';",
    requestBody: `NEW.provider_request_body_sha256 := '${"9".repeat(64)}';`,
  }[mutationKind];
  assert.ok(mutationSql, `unsupported late-mutation kind: ${mutationKind}`);
  applyAsOwner(
    port,
    `
    DROP TRIGGER IF EXISTS zzz_mail_guarded_delivery_0069_late_mutation
      ON public.email_outbox;
    DROP FUNCTION IF EXISTS
      public.mail_guarded_delivery_0069_late_mutation();
    CREATE OR REPLACE FUNCTION
      public.mail_guarded_delivery_0069_late_mutation()
    RETURNS pg_catalog.trigger
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, pg_temp
    AS $function$
    BEGIN
      IF OLD.status = 'sending' AND NEW.status = 'sent' THEN
        ${mutationSql}
      END IF;
      RETURN NEW;
    END
    $function$;
    ALTER FUNCTION public.mail_guarded_delivery_0069_late_mutation()
      OWNER TO learncoding_owner;
    CREATE TRIGGER zzz_mail_guarded_delivery_0069_late_mutation
    BEFORE UPDATE OF status ON public.email_outbox
    FOR EACH ROW
    EXECUTE FUNCTION public.mail_guarded_delivery_0069_late_mutation();
    ALTER TABLE public.email_outbox
      ENABLE ALWAYS TRIGGER zzz_mail_guarded_delivery_0069_late_mutation;
  `,
  );
}

function removeLateMutationTrigger(port) {
  applyAsOwner(
    port,
    `
    DROP TRIGGER zzz_mail_guarded_delivery_0069_late_mutation
      ON public.email_outbox;
    DROP FUNCTION public.mail_guarded_delivery_0069_late_mutation();
  `,
  );
}

function installLeaseDelayTrigger(port) {
  applyAsOwner(
    port,
    `
    CREATE OR REPLACE FUNCTION
      public.mail_guarded_delivery_0069_lease_delay()
    RETURNS pg_catalog.trigger
    LANGUAGE plpgsql
    VOLATILE
    SECURITY INVOKER
    SET search_path = pg_catalog, pg_temp
    AS $function$
    BEGIN
      PERFORM pg_catalog.pg_sleep(0.35);
      RETURN NEW;
    END
    $function$;
    ALTER FUNCTION public.mail_guarded_delivery_0069_lease_delay()
      OWNER TO learncoding_owner;
    CREATE TRIGGER zzz_mail_guarded_delivery_0069_lease_delay
    BEFORE UPDATE OF provider_call_started ON public.email_outbox
    FOR EACH ROW
    EXECUTE FUNCTION public.mail_guarded_delivery_0069_lease_delay();
    ALTER TABLE public.email_outbox
      ENABLE ALWAYS TRIGGER zzz_mail_guarded_delivery_0069_lease_delay;
  `,
  );
}

function removeLeaseDelayTrigger(port) {
  applyAsOwner(
    port,
    `
    DROP TRIGGER zzz_mail_guarded_delivery_0069_lease_delay
      ON public.email_outbox;
    DROP FUNCTION public.mail_guarded_delivery_0069_lease_delay();
  `,
  );
}

function proveStateArcBounds(port) {
  assertExactFirstClaim(
    claimAsWorker(port, FIXTURES.stateArc),
    FIXTURES.stateArc,
  );
  const sendingDigest = outboxStateDigest(port, FIXTURES.stateArc.id);
  installLeaseDelayTrigger(port);
  const delayedArm = psql(
    port,
    database,
    armConsoleSql(FIXTURES.stateArc).replace(
      "interval '180 seconds'",
      "interval '15.2 seconds'",
    ),
    { allowFailure: true, username: "learncoding_worker" },
  );
  assertFailure(delayedArm, /email outbox delivery state arc is invalid/u);
  removeLeaseDelayTrigger(port);
  assert.equal(outboxStateDigest(port, FIXTURES.stateArc.id), sendingDigest);

  for (const deadline of [
    "'infinity'::pg_catalog.timestamptz",
    "pg_catalog.statement_timestamp() + interval '7 hours'",
  ]) {
    const invalidRetry = psql(
      port,
      database,
      `
      UPDATE public.email_outbox
         SET status = 'pending',
             claim_token = NULL,
             claim_owner = NULL,
             claim_version = claim_version + 1,
             lease_expires_at = NULL,
             next_attempt_at = ${deadline},
             last_error_code = 'TRANSIENT_DELIVERY_FAILURE',
             updated_at = pg_catalog.statement_timestamp()
       WHERE id = '${FIXTURES.stateArc.id}'::pg_catalog.uuid;`,
      {
        allowFailure: true,
        username: "learncoding_worker",
      },
    );
    assertFailure(invalidRetry, /email outbox delivery state arc is invalid/u);
    assert.equal(outboxStateDigest(port, FIXTURES.stateArc.id), sendingDigest);
  }

  const validRetry = psql(
    port,
    database,
    `
    UPDATE public.email_outbox
       SET status = 'pending',
           claim_token = NULL,
           claim_owner = NULL,
           claim_version = claim_version + 1,
           lease_expires_at = NULL,
           next_attempt_at =
             pg_catalog.statement_timestamp() + interval '5 hours',
           last_error_code = 'TRANSIENT_DELIVERY_FAILURE',
           updated_at = pg_catalog.statement_timestamp()
     WHERE id = '${FIXTURES.stateArc.id}'::pg_catalog.uuid
     RETURNING pg_catalog.concat_ws(
       '|',
       status::pg_catalog.text,
       claim_version::pg_catalog.text,
       attempt_count::pg_catalog.text,
       (
         claim_token IS NULL
         AND claim_owner IS NULL
         AND lease_expires_at IS NULL
       )::pg_catalog.text,
       pg_catalog.isfinite(next_attempt_at)::pg_catalog.text,
       (next_attempt_at > pg_catalog.clock_timestamp())::pg_catalog.text,
       (
         next_attempt_at <=
           pg_catalog.clock_timestamp() + interval '6 hours'
       )::pg_catalog.text
     );`,
    {
      allowFailure: true,
      scalar: true,
      username: "learncoding_worker",
    },
  );
  assert.equal(validRetry.status, 0);
  assert.equal(validRetry.stdout.trim(), "pending|2|1|true|true|true|true");
}

function proveIssuanceAndRequestHold(port) {
  installReviewedApplicationPrivileges(port);
  proveBackupIssuance(port);
  proveApplicationRelease(port);
  proveLateInsertMutationRollback(port);
  proveDeferredInitialTimestampRollback(port);
  proveReplicaDeleteRollback(port);
  proveStateArcBounds(port);
  proveMarkerPairIsolation(port);

  const claimedMain = claimAsWorker(port, FIXTURES.main);
  assertExactFirstClaim(claimedMain, FIXTURES.main);
  const unarmedDigest = outboxStateDigest(port, FIXTURES.main.id);
  const partial = psql(
    port,
    database,
    `
    UPDATE public.email_outbox
       SET provider_request_body_sha256 = '${"7".repeat(64)}',
           updated_at = pg_catalog.statement_timestamp()
     WHERE id = '${FIXTURES.main.id}'::pg_catalog.uuid;`,
    {
      allowFailure: true,
      username: "learncoding_worker",
    },
  );
  assertFailure(
    partial,
    /email outbox (request-body arm transition|delivery state arc|delivery state shape) is invalid|email_outbox_provider_request_body_valid/u,
  );
  assert.equal(outboxStateDigest(port, FIXTURES.main.id), unarmedDigest);

  const invalidArms = [
    armConsoleSql(FIXTURES.main).replace(
      "provider_request_body_length = 42",
      "provider_request_body_length = -1",
    ),
    armConsoleSql(FIXTURES.main).replace(
      "interval '180 seconds'",
      "interval '5 seconds'",
    ),
    armConsoleSql(FIXTURES.main).replace(
      "dispatch_binding_version = 'console-json-v1'",
      "dispatch_binding_version = 'gmail-raw-v1'",
    ),
  ];
  for (const invalidArm of invalidArms) {
    const denied = psql(port, database, invalidArm, {
      allowFailure: true,
      username: "learncoding_worker",
    });
    assertFailure(
      denied,
      /email outbox (delivery state arc|delivery state shape|provider correlation evidence transition|dispatch binding transition|request-body arm transition) is invalid|email_outbox_provider_request_body_valid/u,
    );
    assert.equal(outboxStateDigest(port, FIXTURES.main.id), unarmedDigest);
  }

  const nonWorker = psql(port, database, armConsoleSql(FIXTURES.main), {
    allowFailure: true,
    username: "learncoding_app",
  });
  assertFailure(
    nonWorker,
    /permission denied for table email_outbox|email outbox (delivery state requires worker authority|request-body arm requires worker identity)/u,
  );
  assert.equal(outboxStateDigest(port, FIXTURES.main.id), unarmedDigest);
  armAsWorker(port, FIXTURES.main);
  assert.equal(
    scalar(
      port,
      database,
      `
      SELECT (
        provider_call_started IS NOT NULL
        AND adapter = 'console'
        AND dispatch_binding_version = 'console-json-v1'
        AND provider_correlation_version = 'opaque-sha256-v1'
        AND provider_request_body_sha256 = '${"7".repeat(64)}'
        AND provider_request_body_length = 42
      )::pg_catalog.text
        FROM public.email_outbox
       WHERE id = '${FIXTURES.main.id}'::pg_catalog.uuid;`,
    ),
    "true",
  );
  const armedDigest = outboxStateDigest(port, FIXTURES.main.id);
  const mutation = psql(
    port,
    database,
    `
    UPDATE public.email_outbox
       SET provider_request_body_sha256 = '${"8".repeat(64)}',
           updated_at = pg_catalog.statement_timestamp()
     WHERE id = '${FIXTURES.main.id}'::pg_catalog.uuid;`,
    {
      allowFailure: true,
      username: "learncoding_worker",
    },
  );
  assertFailure(
    mutation,
    /email outbox (request-body binding is immutable|delivery state arc is invalid)/u,
  );
  assert.equal(outboxStateDigest(port, FIXTURES.main.id), armedDigest);

  const lengthMutation = psql(
    port,
    database,
    `
    UPDATE public.email_outbox
       SET provider_request_body_length = 43,
           updated_at = pg_catalog.statement_timestamp()
     WHERE id = '${FIXTURES.main.id}'::pg_catalog.uuid;`,
    {
      allowFailure: true,
      username: "learncoding_worker",
    },
  );
  assertFailure(
    lengthMutation,
    /email outbox (request-body binding is immutable|delivery state arc is invalid)/u,
  );
  assert.equal(outboxStateDigest(port, FIXTURES.main.id), armedDigest);

  psql(
    port,
    database,
    `
    UPDATE public.email_outbox
       SET status = 'sent',
           claim_token = NULL,
           claim_owner = NULL,
           lease_expires_at = NULL,
           provider_message_id = 'mail-0069-console-result',
           sent_at = pg_catalog.statement_timestamp(),
           last_error_code = NULL,
           updated_at = pg_catalog.statement_timestamp()
     WHERE id = '${FIXTURES.main.id}'::pg_catalog.uuid;`,
    {
      username: "learncoding_worker",
    },
  );
  const sentDigest = outboxStateDigest(port, FIXTURES.main.id);
  const providerIdentity = psql(
    port,
    database,
    `
    UPDATE public.email_outbox
       SET provider_message_id = 'mail-0069-rewritten-result',
           updated_at = pg_catalog.statement_timestamp()
     WHERE id = '${FIXTURES.main.id}'::pg_catalog.uuid;`,
    {
      allowFailure: true,
      username: "learncoding_worker",
    },
  );
  assertFailure(
    providerIdentity,
    /email outbox provider identity is immutable/u,
  );
  assert.equal(outboxStateDigest(port, FIXTURES.main.id), sentDigest);

  assertExactFirstClaim(
    claimAsWorker(port, FIXTURES.finalGuard),
    FIXTURES.finalGuard,
  );
  armAsWorker(port, FIXTURES.finalGuard);
  const lateMutationCases = [
    [
      "requestBody",
      /email outbox (request-body binding is immutable|delivery state arc is invalid)/u,
    ],
    [
      "dispatch",
      /email outbox (dispatch binding is immutable|dispatch binding transition is invalid|delivery state arc is invalid)/u,
    ],
    [
      "payload",
      /email_outbox[.]to_email is immutable|email outbox delivery transition changed immutable payload/u,
    ],
    ["createdAt", /email outbox created_at is immutable/u],
    ["fence", /email outbox delivery state arc is invalid/u],
  ];
  for (const [mutationKind, rejection] of lateMutationCases) {
    installLateMutationTrigger(port, mutationKind);
    const beforeLateMutation = mailAuthorityDigest(port);
    const finalGuardDigest = outboxStateDigest(port, FIXTURES.finalGuard.id);
    const lateMutation = psql(
      port,
      database,
      `
      UPDATE public.email_outbox
         SET status = 'sent',
             claim_token = NULL,
             claim_owner = NULL,
             lease_expires_at = NULL,
             provider_message_id =
               'mail-0069-late-${mutationKind}',
             sent_at = pg_catalog.statement_timestamp(),
             last_error_code = NULL,
             updated_at = pg_catalog.statement_timestamp()
       WHERE id = '${FIXTURES.finalGuard.id}'::pg_catalog.uuid;`,
      {
        allowFailure: true,
        username: "learncoding_worker",
      },
    );
    assertFailure(lateMutation, rejection);
    assert.equal(
      outboxStateDigest(port, FIXTURES.finalGuard.id),
      finalGuardDigest,
    );
    assert.equal(mailAuthorityDigest(port), beforeLateMutation);
    removeLateMutationTrigger(port);
  }

  const beforeReceiptMutations = mailAuthorityDigest(port);
  const appendOnly = applyAsOwner(
    port,
    `
    UPDATE public.mail_delivery_release_receipt
       SET released_at = released_at + interval '1 second'
     WHERE outbox_id = '${FIXTURES.main.id}'::pg_catalog.uuid;
  `,
    { allowFailure: true },
  );
  assertFailure(appendOnly, /mail delivery release receipts are append-only/u);
  assert.equal(mailAuthorityDigest(port), beforeReceiptMutations);
  for (const username of [
    "learncoding_app",
    "learncoding_worker",
    "learncoding_ops",
    "learncoding_backup_reporter",
  ]) {
    const deleteReceipt = psql(
      port,
      database,
      `
      DELETE FROM public.mail_delivery_release_receipt
       WHERE outbox_id = '${FIXTURES.main.id}'::pg_catalog.uuid;`,
      {
        allowFailure: true,
        username,
      },
    );
    assertFailure(
      deleteReceipt,
      /permission denied for table mail_delivery_release_receipt/u,
    );
    const truncateReceipt = psql(
      port,
      database,
      `
      TRUNCATE TABLE public.mail_delivery_release_receipt;`,
      {
        allowFailure: true,
        username,
      },
    );
    assertFailure(
      truncateReceipt,
      /permission denied for table mail_delivery_release_receipt/u,
    );
  }
  assert.equal(mailAuthorityDigest(port), beforeReceiptMutations);

  const replayAuthorityDigest = scalar(
    port,
    database,
    `
    SELECT pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(
        pg_catalog.to_jsonb(authority)::pg_catalog.text,
        'UTF8'
      )),
      'hex'
    )
      FROM public.email_outbox_idempotency_authority AS authority
     WHERE authority.idempotency_sha256 = '${FIXTURES.main.key}';`,
  );
  assert.match(replayAuthorityDigest, /^[0-9a-f]{64}$/u);
  applyAsOwner(
    port,
    `
    DELETE FROM public.email_outbox
     WHERE id = '${FIXTURES.main.id}'::pg_catalog.uuid;
  `,
  );
  assert.equal(
    scalar(
      port,
      database,
      `
      SELECT pg_catalog.concat_ws(
        '|',
        (
          SELECT pg_catalog.count(*) FROM public.email_outbox
           WHERE id = '${FIXTURES.main.id}'::pg_catalog.uuid
        ),
        (
          SELECT pg_catalog.count(*)
            FROM public.mail_delivery_release_receipt
           WHERE outbox_id = '${FIXTURES.main.id}'::pg_catalog.uuid
        ),
        (
          SELECT pg_catalog.count(*)
            FROM public.email_outbox_idempotency_authority
           WHERE idempotency_sha256 = '${FIXTURES.main.key}'
        ),
        (
          SELECT pg_catalog.encode(
            pg_catalog.sha256(pg_catalog.convert_to(
              pg_catalog.to_jsonb(authority)::pg_catalog.text,
              'UTF8'
            )),
            'hex'
          )
            FROM public.email_outbox_idempotency_authority AS authority
           WHERE authority.idempotency_sha256 = '${FIXTURES.main.key}'
        )
      );`,
    ),
    `0|0|1|${replayAuthorityDigest}`,
  );
  const afterParentDelete = mailAuthorityDigest(port);
  const exactReplay = psql(
    port,
    database,
    `
    BEGIN;
    ${appInsertSql(FIXTURES.main)}
    COMMIT;`,
    {
      allowFailure: true,
      username: "learncoding_app",
    },
  );
  assert.equal(exactReplay.status, 0);
  assert.equal(mailAuthorityDigest(port), afterParentDelete);
  const divergentReplay = psql(
    port,
    database,
    `
    BEGIN;
    ${appInsertSql(FIXTURES.main).replace(
      "Mail 0069 Harness",
      "Mail 0069 Divergent",
    )}
    COMMIT;`,
    {
      allowFailure: true,
      username: "learncoding_app",
    },
  );
  assertFailure(
    divergentReplay,
    /email outbox idempotency event payload conflict/u,
  );
  assert.equal(mailAuthorityDigest(port), afterParentDelete);
}

function readExactPostmasterPid(dataDirectory) {
  const pidFile = path.join(dataDirectory, "postmaster.pid");
  if (!existsSync(pidFile)) return undefined;
  const firstLine = readFileSync(pidFile, "utf8").split(/\r?\n/u, 1)[0];
  assert.match(firstLine, /^[1-9][0-9]*$/u, "postmaster.pid is malformed");
  const postmasterPid = Number.parseInt(firstLine, 10);
  assert.ok(Number.isSafeInteger(postmasterPid) && postmasterPid > 0);
  return postmasterPid;
}

function processStillExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function assertNoListener(port) {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`loopback listener check timed out on port ${port}`));
    }, 3_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`unexpected listener remains on port ${port}`));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      if (error?.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });
}

function assertPostmasterStopped(dataDirectory, postmasterPid) {
  const status = run(executable("pg_ctl"), ["-D", dataDirectory, "status"], {
    allowFailure: true,
    stdio: "ignore",
    timeoutMs: 5_000,
  });
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

function preserveOperationAndCleanupFailures(
  operationError,
  cleanupFailures,
  message,
) {
  if (operationError !== undefined && cleanupFailures.length === 0) {
    return operationError;
  }
  if (operationError === undefined && cleanupFailures.length === 1) {
    return cleanupFailures[0];
  }
  return new AggregateError(
    [
      ...(operationError === undefined ? [] : [operationError]),
      ...cleanupFailures,
    ],
    message,
  );
}

function assertTemporaryRoot(temporaryRoot) {
  const resolvedRoot = path.resolve(temporaryRoot);
  const resolvedTemp = path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolvedRoot), resolvedTemp);
  assert.match(
    path.basename(resolvedRoot),
    new RegExp(
      `^learncoding-mail-guarded-0069-pg${expectedMajor}-[A-Za-z0-9_-]{6,}$`,
      "u",
    ),
  );
}

function assertExactClusterPaths(
  temporaryRoot,
  { dataDirectory, logFile, socketDirectory },
) {
  const exactRoot = path.resolve(temporaryRoot);
  assert.equal(path.resolve(dataDirectory), path.join(exactRoot, "data"));
  assert.equal(path.resolve(socketDirectory), path.join(exactRoot, "socket"));
  assert.equal(path.resolve(logFile), path.join(exactRoot, "postgres.log"));
  for (const candidate of [dataDirectory, socketDirectory, logFile]) {
    const relative = path.relative(exactRoot, path.resolve(candidate));
    assert.ok(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    );
  }
}
export async function main() {
  const version = run(executable("postgres"), ["--version"]).stdout.trim();
  assert.match(version, new RegExp(`PostgreSQL\\) ${expectedMajor}\\.`, "u"));

  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), `learncoding-mail-guarded-0069-pg${expectedMajor}-`),
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
    assertTemporaryRoot(temporaryRoot);
    dataDirectory = path.join(temporaryRoot, "data");
    socketDirectory = path.join(temporaryRoot, "socket");
    logFile = path.join(temporaryRoot, "postgres.log");
    assertExactClusterPaths(temporaryRoot, {
      dataDirectory,
      logFile,
      socketDirectory,
    });
    mkdirSync(socketDirectory);
    port = await allocateDisposableLoopbackPort();
    assert.notEqual(port, 5432);
    await assertNoListener(port);
    run(executable("initdb"), [
      `--pgdata=${dataDirectory}`,
      "--username=postgres",
      "--auth=trust",
      "--data-checksums",
      "--encoding=UTF8",
      "--no-locale",
    ]);
    startAttempted = true;
    const socketOption =
      process.platform === "win32" ? "" : ` -k "${socketDirectory}"`;
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
    assert.equal(
      scalar(
        port,
        "postgres",
        "SELECT pg_catalog.current_setting('data_checksums');",
      ),
      "on",
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
      CREATE ROLE learncoding_acl_grantor LOGIN NOINHERIT;
      CREATE ROLE learncoding_acl_leaf LOGIN NOINHERIT;
      GRANT learncoding_owner TO learncoding_migrator
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
    `,
    );
    run(executable("createdb"), [
      "--host=127.0.0.1",
      `--port=${port}`,
      "--username=postgres",
      "--owner=learncoding_owner",
      database,
    ]);

    for (const migrationFile of migrationFilesThrough(68)) {
      applyAsOwner(port, readFileSync(migrationFile, "utf8"));
    }
    poison0069Acl(port);
    const migration0069 = readFileSync(
      path.join(
        migrationDirectory,
        "0069_mail_outbox_guarded_delivery_authority.sql",
      ),
      "utf8",
    );
    proveInheritedAclTamperRollback(port, migration0069, temporaryRoot);
    proveDigestHelperTamperRollback(port, migration0069, temporaryRoot);
    seedAdministrator(port);
    provePredecessorTamperRollback(port, migration0069);
    proveDrainedBacklogRollback(port, migration0069, temporaryRoot);
    proveLateCatalogRollback(port, migration0069, temporaryRoot);
    applyAsOwner(port, migration0069);
    assertCatalogAndAcl(port);
    applyAsOwnerFromFile(
      port,
      migration0069,
      temporaryRoot,
      "migration-0069-idempotent-replay.sql",
    );
    assertCatalogAndAcl(port);
    proveTask5RelationAclTamperRollback(port, migration0069, temporaryRoot);
    assertCatalogAndAcl(port);
    proveIssuanceAndRequestHold(port);
    const populatedDataDigest = mailAuthorityDigest(port);
    const populatedCatalogAndAclDigest = guardedAclDigest(port);
    repoison0069Acl(port);
    assert.notEqual(guardedAclDigest(port), populatedCatalogAndAclDigest);
    applyAsOwnerFromFile(
      port,
      migration0069,
      temporaryRoot,
      "migration-0069-repoison-repair.sql",
    );
    assertCatalogAndAcl(port);
    assert.equal(mailAuthorityDigest(port), populatedDataDigest);
    assert.equal(guardedAclDigest(port), populatedCatalogAndAclDigest);
  } catch (error) {
    operationError = error;
  } finally {
    if (startAttempted && dataDirectory !== undefined) {
      try {
        assertExactClusterPaths(temporaryRoot, {
          dataDirectory,
          logFile,
          socketDirectory,
        });
        const stopped = run(
          executable("pg_ctl"),
          ["-D", dataDirectory, "stop", "-m", "immediate", "-w"],
          { allowFailure: true, stdio: "ignore", timeoutMs: 30_000 },
        );
        if (startCompleted && stopped.status !== 0) {
          cleanupFailures.push(
            new Error(
              `temporary PostgreSQL shutdown failed with status ${stopped.status}`,
            ),
          );
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
        assertExactClusterPaths(temporaryRoot, {
          dataDirectory,
          logFile,
          socketDirectory,
        });
        assertPostmasterStopped(dataDirectory, postmasterPid);
        postmasterStopped = true;
      } catch (error) {
        postmasterStopped = false;
        cleanupFailures.push(error);
      }
    }

    if (listenerStopped && postmasterStopped) {
      try {
        assertExactClusterPaths(temporaryRoot, {
          dataDirectory,
          logFile,
          socketDirectory,
        });
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
      "0069 PostgreSQL operation and cleanup failed",
    );
  }
  process.stdout.write("mail_guarded_delivery_0069=PASS\n");
}
