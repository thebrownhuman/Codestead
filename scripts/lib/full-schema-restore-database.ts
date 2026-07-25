import { createHash } from "node:crypto";

import type {
  FullSchemaRestoreSmoke,
  FullSchemaRestoreSnapshot,
} from "./full-schema-restore-gate";

export type FullSchemaRestoreQueryClient = Readonly<{
  query: (
    sql: string,
    values?: readonly unknown[],
  ) => Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("full-schema restore canonical data is invalid");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"));
    if (entries.some(([, item]) => item === undefined)) {
      throw new Error("full-schema restore canonical data is invalid");
    }
    return `{${entries.map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new Error("full-schema restore canonical data is invalid");
}

export function stableSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

const JOURNAL_SQL = `
  select
    pg_catalog.count(*)::text as journal_entry_count,
    (
      select migration.hash
        from drizzle.__drizzle_migrations migration
       order by migration.id desc
       limit 1
    ) as journal_tail_sha256,
    (
      select migration.created_at::text
        from drizzle.__drizzle_migrations migration
       order by migration.id desc
       limit 1
    ) as journal_tail_when
  from drizzle.__drizzle_migrations
`;

const OBJECT_CONTRACT_SQL = `
  with catalog_contract as (
    select
      'database'::text as kind,
      'pg_catalog'::text as schema_name,
      '<current>'::text as object_name,
      ''::text as identity,
      pg_catalog.pg_get_userbyid(database.datdba)::text as owner_name,
      pg_catalog.jsonb_build_object(
        'acl', coalesce((
          select pg_catalog.jsonb_agg(item::text order by item::text)
            from pg_catalog.unnest(
              coalesce(database.datacl, '{}'::aclitem[])
            ) item
        ), '[]'::jsonb)
      ) as attributes
      from pg_catalog.pg_database database
     where database.datname = pg_catalog.current_database()

    union all

    select
      'role',
      'pg_catalog',
      role.rolname,
      '',
      '',
      pg_catalog.jsonb_build_object(
        'can_login', role.rolcanlogin,
        'create_database', role.rolcreatedb,
        'create_role', role.rolcreaterole,
        'inherit', role.rolinherit,
        'replication', role.rolreplication,
        'superuser', role.rolsuper,
        'memberships', coalesce((
          select pg_catalog.jsonb_agg(parent.rolname order by parent.rolname)
            from pg_catalog.pg_auth_members membership
            join pg_catalog.pg_roles parent
              on parent.oid = membership.roleid
           where membership.member = role.oid
        ), '[]'::jsonb)
      )
      from pg_catalog.pg_roles role
     where role.rolname in (
       'learncoding_owner',
       'learncoding_migrator',
       'learncoding_app',
       'learncoding_worker',
       'learncoding_ops'
     )

    union all

    select
      'schema',
      namespace.nspname,
      namespace.nspname,
      '',
      pg_catalog.pg_get_userbyid(namespace.nspowner),
      pg_catalog.jsonb_build_object(
        'acl', coalesce((
          select pg_catalog.jsonb_agg(item::text order by item::text)
            from pg_catalog.unnest(
              coalesce(namespace.nspacl, '{}'::aclitem[])
            ) item
        ), '[]'::jsonb)
      )
      from pg_catalog.pg_namespace namespace
     where namespace.nspname in ('public', 'drizzle')

    union all

    select
      'relation',
      namespace.nspname,
      relation.relname,
      relation.relkind::text,
      pg_catalog.pg_get_userbyid(relation.relowner),
      pg_catalog.jsonb_build_object(
        'acl', coalesce((
          select pg_catalog.jsonb_agg(item::text order by item::text)
            from pg_catalog.unnest(
              coalesce(relation.relacl, '{}'::aclitem[])
            ) item
        ), '[]'::jsonb)
      )
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace
        on namespace.oid = relation.relnamespace
     where namespace.nspname in ('public', 'drizzle')
       and relation.relkind in ('r', 'p', 'S', 'v', 'm', 'f', 'i', 'I', 'c')

    union all

    select
      'column',
      namespace.nspname,
      relation.relname || '.' || attribute.attname,
      attribute.attnum::text,
      pg_catalog.pg_get_userbyid(relation.relowner),
      pg_catalog.jsonb_build_object(
        'acl', coalesce((
          select pg_catalog.jsonb_agg(item::text order by item::text)
            from pg_catalog.unnest(
              coalesce(attribute.attacl, '{}'::aclitem[])
            ) item
        ), '[]'::jsonb),
        'default', pg_catalog.pg_get_expr(
          attribute_default.adbin,
          attribute_default.adrelid
        ),
        'generated', attribute.attgenerated,
        'identity', attribute.attidentity,
        'not_null', attribute.attnotnull,
        'type', pg_catalog.format_type(
          attribute.atttypid,
          attribute.atttypmod
        )
      )
      from pg_catalog.pg_attribute attribute
      join pg_catalog.pg_class relation
        on relation.oid = attribute.attrelid
      join pg_catalog.pg_namespace namespace
        on namespace.oid = relation.relnamespace
      left join pg_catalog.pg_attrdef attribute_default
        on attribute_default.adrelid = attribute.attrelid
       and attribute_default.adnum = attribute.attnum
     where namespace.nspname in ('public', 'drizzle')
       and relation.relkind in ('r', 'p', 'v', 'm', 'f')
       and attribute.attnum > 0
       and not attribute.attisdropped

    union all

    select
      'constraint',
      namespace.nspname,
      constraint_row.conname,
      relation.relname,
      pg_catalog.pg_get_userbyid(relation.relowner),
      pg_catalog.jsonb_build_object(
        'definition', pg_catalog.pg_get_constraintdef(
          constraint_row.oid,
          true
        ),
        'type', constraint_row.contype,
        'validated', constraint_row.convalidated
      )
      from pg_catalog.pg_constraint constraint_row
      join pg_catalog.pg_class relation
        on relation.oid = constraint_row.conrelid
      join pg_catalog.pg_namespace namespace
        on namespace.oid = relation.relnamespace
     where namespace.nspname in ('public', 'drizzle')

    union all

    select
      'routine',
      namespace.nspname,
      routine.proname,
      pg_catalog.pg_get_function_identity_arguments(routine.oid),
      pg_catalog.pg_get_userbyid(routine.proowner),
      pg_catalog.jsonb_build_object(
        'acl', coalesce((
          select pg_catalog.jsonb_agg(item::text order by item::text)
            from pg_catalog.unnest(
              coalesce(routine.proacl, '{}'::aclitem[])
            ) item
        ), '[]'::jsonb),
        'configuration', coalesce(
          pg_catalog.to_jsonb(routine.proconfig),
          '[]'::jsonb
        ),
        'language', language.lanname,
        'security_definer', routine.prosecdef
      )
      from pg_catalog.pg_proc routine
      join pg_catalog.pg_namespace namespace
        on namespace.oid = routine.pronamespace
      join pg_catalog.pg_language language
        on language.oid = routine.prolang
     where namespace.nspname in ('public', 'drizzle')

    union all

    select
      'trigger',
      namespace.nspname,
      trigger_row.tgname,
      relation.relname,
      pg_catalog.pg_get_userbyid(routine.proowner),
      pg_catalog.jsonb_build_object(
        'definition', pg_catalog.pg_get_triggerdef(trigger_row.oid, true),
        'enabled', trigger_row.tgenabled,
        'function', routine.oid::pg_catalog.regprocedure::text
      )
      from pg_catalog.pg_trigger trigger_row
      join pg_catalog.pg_class relation
        on relation.oid = trigger_row.tgrelid
      join pg_catalog.pg_namespace namespace
        on namespace.oid = relation.relnamespace
      join pg_catalog.pg_proc routine
        on routine.oid = trigger_row.tgfoid
     where namespace.nspname in ('public', 'drizzle')
       and not trigger_row.tgisinternal

    union all

    select
      'type',
      namespace.nspname,
      type_row.typname,
      type_row.typtype::text,
      pg_catalog.pg_get_userbyid(type_row.typowner),
      pg_catalog.jsonb_build_object(
        'acl', coalesce((
          select pg_catalog.jsonb_agg(item::text order by item::text)
            from pg_catalog.unnest(
              coalesce(type_row.typacl, '{}'::aclitem[])
            ) item
        ), '[]'::jsonb)
      )
      from pg_catalog.pg_type type_row
      join pg_catalog.pg_namespace namespace
        on namespace.oid = type_row.typnamespace
     where namespace.nspname in ('public', 'drizzle')
       and type_row.typtype in ('c', 'd', 'e', 'm', 'r')

    union all

    select
      'default_acl',
      coalesce(namespace.nspname, ''),
      default_acl.defaclobjtype::text,
      '',
      pg_catalog.pg_get_userbyid(default_acl.defaclrole),
      pg_catalog.jsonb_build_object(
        'acl', coalesce((
          select pg_catalog.jsonb_agg(item::text order by item::text)
            from pg_catalog.unnest(
              coalesce(default_acl.defaclacl, '{}'::aclitem[])
            ) item
        ), '[]'::jsonb)
      )
      from pg_catalog.pg_default_acl default_acl
      left join pg_catalog.pg_namespace namespace
        on namespace.oid = default_acl.defaclnamespace
     where (
       namespace.nspname in ('public', 'drizzle')
       or default_acl.defaclnamespace = 0
     )
  )
  select kind, schema_name, object_name, identity, owner_name, attributes
    from catalog_contract
   order by kind, schema_name, object_name, identity, owner_name
`;

const MAIL_ROWS_SQL = `
  select pg_catalog.to_jsonb(outbox) as payload
    from public.email_outbox outbox
   where outbox.idempotency_key like 'full-schema-restore:%'
   order by outbox.idempotency_key, outbox.id
`;

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export async function collectFullSchemaRestoreSnapshot(
  client: FullSchemaRestoreQueryClient,
): Promise<FullSchemaRestoreSnapshot> {
  const versionResult = await client.query(
    "select pg_catalog.current_setting('server_version_num') as server_version_num",
  );
  const journalResult = await client.query(JOURNAL_SQL);
  const objectResult = await client.query(OBJECT_CONTRACT_SQL);
  const mailResult = await client.query(MAIL_ROWS_SQL);

  const versionNumber = positiveInteger(
    versionResult.rows[0]?.server_version_num,
  );
  const journal = journalResult.rows[0];
  const journalEntryCount = positiveInteger(journal?.journal_entry_count);
  const journalTailWhen = positiveInteger(journal?.journal_tail_when);
  const journalTailSha256 = journal?.journal_tail_sha256;
  const mailRows = mailResult.rows.map((row) => row.payload);
  if (
    versionNumber === undefined
    || journalEntryCount === undefined
    || journalTailWhen === undefined
    || typeof journalTailSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(journalTailSha256)
    || objectResult.rows.length === 0
    || mailRows.length === 0
    || mailRows.some((row) => row === null || typeof row !== "object")
  ) {
    throw new Error("full-schema restore database snapshot failed");
  }

  return {
    postgresMajor: Math.floor(versionNumber / 10_000),
    journalEntryCount,
    journalTailSha256,
    journalTailWhen,
    objectContractSha256: stableSha256(objectResult.rows),
    mailRowsSha256: stableSha256(mailRows),
    mailRowCount: mailRows.length,
  };
}

const CLAIM_LOCK_SQL = `
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(outbox.delivery_scope_key, 0)
  )
    from public.email_outbox outbox
   where outbox.idempotency_key =
         'full-schema-restore:account-pending:v1'
     and outbox.status = 'pending'
   for update
`;

const CLAIM_SQL = `
  update public.email_outbox
     set status = 'sending',
         claim_token = '4f0b2860-a1d3-4f72-ae98-b2f591750001',
         claim_owner = 'full-schema-restore-smoke',
         claim_version = claim_version + 1,
         lease_expires_at = pg_catalog.statement_timestamp()
           + interval '60 seconds',
         updated_at = pg_catalog.statement_timestamp()
   where idempotency_key = 'full-schema-restore:account-pending:v1'
     and status = 'pending'
  returning id
`;

const REDACT_SQL = `
  select pg_catalog.count(*)::text as redacted_rows
    from public.redact_unresolved_email_outbox_authority(
      pg_catalog.statement_timestamp() - interval '30 days',
      100
    )
`;

const VERIFY_REDACTION_SQL = `
  select pg_catalog.count(*)::text as redacted_rows
    from public.email_outbox outbox
   where outbox.idempotency_key like
         'full-schema-restore:%quarantined:%'
     and outbox.to_email =
         'redacted+' || outbox.id::text || '@invalid.local'
     and (
       (
         outbox.user_id is not null
         and outbox.variables = '{}'::jsonb
       )
       or (
         outbox.user_id is null
         and pg_catalog.jsonb_object_length(outbox.variables) = 4
         and outbox.variables ->> '_mailRecipient' = outbox.to_email
         and outbox.variables ? '_mailOperationId'
         and outbox.variables ? '_mailProducer'
         and outbox.variables ? '_mailSourceId'
       )
     )
`;

async function probeWorkerClaim(
  worker: FullSchemaRestoreQueryClient,
): Promise<number> {
  await worker.query("begin");
  let primaryError: unknown;
  let claimedRows = 0;
  try {
    await worker.query(CLAIM_LOCK_SQL);
    const result = await worker.query(CLAIM_SQL);
    claimedRows = result.rows.length;
  } catch (error) {
    primaryError = error;
  }

  try {
    await worker.query("rollback");
  } catch (rollbackError) {
    if (primaryError !== undefined) {
      throw new AggregateError(
        [primaryError, rollbackError],
        "full-schema restore worker probe and rollback failed",
      );
    }
    throw rollbackError;
  }
  if (primaryError !== undefined) throw primaryError;
  return claimedRows;
}

export async function runFullSchemaRestoreDatabaseSmoke(input: Readonly<{
  worker: FullSchemaRestoreQueryClient;
  ops: FullSchemaRestoreQueryClient;
  verifier: FullSchemaRestoreQueryClient;
}>): Promise<FullSchemaRestoreSmoke> {
  const claimedRows = await probeWorkerClaim(input.worker);
  const redaction = await input.ops.query(REDACT_SQL);
  const verification = await input.verifier.query(VERIFY_REDACTION_SQL);
  const redactedRows = positiveInteger(redaction.rows[0]?.redacted_rows);
  const verifiedRows = positiveInteger(verification.rows[0]?.redacted_rows);
  if (
    redactedRows === undefined
    || verifiedRows === undefined
    || redactedRows !== 2
    || redactedRows !== verifiedRows
  ) {
    throw new Error("full-schema restore database smoke failed");
  }
  return {
    claimedRows,
    redactedRows,
    externalCalls: 0,
  };
}
