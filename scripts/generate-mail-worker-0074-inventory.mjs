import { createHash } from "node:crypto";
import {
  REVIEWED_MIGRATION_LEDGER_SHA256,
  verifyAppliedMigrationLedger,
} from "./lib/reviewed-migration-ledger.mjs";

// Called by the PostgreSQL migration replay, never derived from a snapshot or
// guessed ACLs. No credentials or credential hashes enter the artifact.
export async function collectMailWorker0074Inventory(client) {
  // pg_get_functiondef/format_type depend on visibility. Match the trusted
  // catalog search_path used by bootstrap and the independent verifier.
  await client.query("select pg_catalog.set_config('search_path','pg_catalog,pg_temp',false)");
  await verifyAppliedMigrationLedger(client, { requireComplete: true });
  const names = [
    "enforce_email_outbox_dispatch_binding",
    "backup_status_mail_authorized",
    "enforce_email_outbox_provider_correlation_evidence",
    "enforce_email_outbox_delivery_hold",
    "enforce_email_outbox_delivery_release_insert_xid",
    "enforce_mail_delivery_release_receipt_insert",
    "release_email_outbox_delivery",
    "attest_email_outbox_delivery_release_lineage",
    "enforce_email_outbox_provider_request_body_immutable",
    "mail_worker_lock_source_v1",
    "mail_worker_mail_delivery_release_receipt_sha256",
    "mail_worker_backup_status_mail_authorized",
    "mail_worker_attest_email_outbox_delivery_release_lineage",
    "mail_worker_release_email_outbox_delivery",
  ];
  const routines = await client.query(`select
    'public.'||p.proname||'('||array_to_string(array(
      select format_type(arg, null) from unnest(p.proargtypes::oid[]) arg
    ), ',')||')' as signature,
    pg_get_userbyid(p.proowner) as owner,
    p.prosecdef as "securityDefiner", p.proconfig as configuration,
    l.lanname as language, p.prokind as kind, p.provolatile as volatility,
    p.proisstrict as strict, p.proparallel as parallel,
    p.proleakproof as leakproof,
    coalesce(p.proargnames, array[]::text[]) as "argumentNames",
    coalesce(p.proargmodes::text[], array[]::text[]) as "argumentModes",
    array(select format_type(arg,null) from unnest(coalesce(
      p.proallargtypes,p.proargtypes::oid[])) arg) as "argumentTypes",
    p.pronargs as "inputArgumentCount", p.pronargdefaults as "argumentDefaultCount",
    format_type(p.prorettype,null) as "returnType", p.proretset as "returnsSet",
    p.provariadic<>0 as variadic, p.procost as cost, p.prorows as rows,
    encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') as "bodySha256",
    encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') as "definitionSha256",
    array(select pg_get_userbyid(a.grantee)::text from aclexplode(p.proacl) a
      where a.privilege_type='EXECUTE' and a.grantee<>p.proowner
      order by pg_get_userbyid(a.grantee) collate "C") as "allowedRoles"
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    join pg_catalog.pg_language l on l.oid=p.prolang
    where n.nspname='public' and p.proname=any($1::text[])
    order by p.proname collate "C"`, [names]);
  if (routines.rows.length !== names.length) throw new Error("0074 routine inventory mismatch");
  if (routines.rows.some(row => !Array.isArray(row.allowedRoles))) {
    throw new Error("0074 routine ACL inventory must contain text arrays");
  }
  // Existing routine ACLs stay governed by their independent reviewed phase
  // contracts. Their owner-only migration state and reconciled runtime state
  // differ; neither state should alter this body/definition inventory.
  for (const routine of routines.rows) {
    if (!routine.signature.startsWith("public.mail_worker_")) {
      delete routine.allowedRoles;
    }
  }
  const grants = await client.query(`with grants as (select 'column' as "objectKind",
    n.nspname||'.'||c.relname||'.'||a.attname as "objectIdentity",
    access.privilege_type as privilege, access.is_grantable as grantable
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid=c.oid
    cross join lateral pg_catalog.aclexplode(a.attacl) access
    where access.grantee='learncoding_mail_worker'::regrole
    union all select 'schema',n.nspname,access.privilege_type,access.is_grantable
    from pg_catalog.pg_namespace n
    cross join lateral pg_catalog.aclexplode(n.nspacl) access
    where access.grantee='learncoding_mail_worker'::regrole)
    select * from grants
    order by "objectKind" collate "C","objectIdentity" collate "C",privilege collate "C"`);
  if (grants.rows.some(row => row.grantable)) throw new Error("0074 grant option is forbidden");
  const value = {
    schemaVersion: 1,
    contract: "codestead-mail-worker-runtime-0074-v1",
    reviewedMigrationLedgerSha256: REVIEWED_MIGRATION_LEDGER_SHA256,
    routines: routines.rows,
    grants: grants.rows,
  };
  return {
    value,
    sha256: createHash("sha256").update(JSON.stringify(value) + "\n").digest("hex"),
  };
}
