import { createHash } from "node:crypto";

import type {
  FullSchemaAclSuppressionControl,
  FullSchemaRestoreSmoke,
  FullSchemaRestoreSnapshot,
} from "./full-schema-restore-gate";

export type FullSchemaRestoreQueryClient = Readonly<{
  query: (
    sql: string,
    values?: readonly unknown[],
  ) => Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

export async function requireExactFullSchemaRestoreOwnerRole(
  client: FullSchemaRestoreQueryClient,
): Promise<void> {
  const result = await client.query(`
    select role.rolname,
           role.rolcanlogin,
           role.rolsuper,
           role.rolcreatedb,
           role.rolcreaterole,
           role.rolinherit,
           role.rolreplication,
           role.rolbypassrls,
           role.rolconnlimit,
           role.rolvaliduntil = 'infinity'::pg_catalog.timestamptz
             as valid_until_infinity,
           role.rolpassword is null as password_is_null,
           not exists (
             select 1
               from pg_catalog.pg_db_role_setting setting
              where setting.setrole = role.oid
           ) as role_settings_empty,
           (
             select pg_catalog.count(*) = 1
                    and pg_catalog.count(*) filter (
                      where granted.rolname = 'learncoding_owner'
                        and member.rolname = 'learncoding_migrator'
                        and not membership.admin_option
                        and not membership.inherit_option
                        and membership.set_option
                    ) = 1
               from pg_catalog.pg_auth_members membership
               join pg_catalog.pg_roles granted
                 on granted.oid = membership.roleid
               join pg_catalog.pg_roles member
                 on member.oid = membership.member
              where granted.rolname in (
                'learncoding_owner', 'learncoding_migrator',
                'learncoding_app', 'learncoding_worker', 'learncoding_ops',
                'learncoding_backup_reporter'
              )
                 or member.rolname in (
                   'learncoding_owner', 'learncoding_migrator',
                   'learncoding_app', 'learncoding_worker', 'learncoding_ops',
                   'learncoding_backup_reporter'
                 )
           ) as membership_contract_exact
      from pg_catalog.pg_authid role
     where role.rolname = 'learncoding_owner'
  `);
  const row = result.rows[0];
  if (
    result.rows.length !== 1
    || row?.rolname !== "learncoding_owner"
    || row.rolcanlogin !== false
    || row.rolsuper !== false
    || row.rolcreatedb !== false
    || row.rolcreaterole !== false
    || row.rolinherit !== false
    || row.rolreplication !== false
    || row.rolbypassrls !== false
    || row.rolconnlimit !== -1
    || row.valid_until_infinity !== true
    || row.password_is_null !== true
    || row.role_settings_empty !== true
    || row.membership_contract_exact !== true
  ) {
    throw new Error("full-schema restore owner role is invalid");
  }
}

export async function prepareFullSchemaAclSuppressionControl(
  client: FullSchemaRestoreQueryClient,
): Promise<void> {
  await client.query(`
    alter default privileges for role learncoding_owner
      in schema public
      grant execute on routines to public
  `);
}

const ACL_SUPPRESSION_CONTROL_ROUTINE =
  "public.redact_unresolved_email_outbox_authority(timestamp with time zone,integer)";

export async function requireFullSchemaAclSuppressionControl(
  client: FullSchemaRestoreQueryClient,
): Promise<FullSchemaAclSuppressionControl> {
  const result = await client.query(`
    select routine.proacl is null as proacl_is_null,
           exists (
             select 1
               from pg_catalog.aclexplode(
                 coalesce(
                   routine.proacl,
                   pg_catalog.acldefault('f', routine.proowner)
                 )
               ) acl
              where acl.grantee = 0
                and acl.privilege_type = 'EXECUTE'
           ) as public_execute
      from pg_catalog.pg_proc routine
     where routine.oid = pg_catalog.to_regprocedure($1)::oid
  `, [ACL_SUPPRESSION_CONTROL_ROUTINE]);
  const row = result.rows[0];
  if (
    result.rows.length !== 1
    || row?.proacl_is_null !== true
    || row.public_execute !== true
  ) {
    throw new Error(
      "full-schema restore ACL suppression control failed",
    );
  }
  return {
    proaclIsNull: true,
    publicExecute: true,
    routine: ACL_SUPPRESSION_CONTROL_ROUTINE,
  };
}

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
    (
      pg_catalog.row_number() over (order by migration.id) - 1
    )::text as migration_index,
    migration.hash as migration_sha256,
    migration.created_at::text as migration_when
    from drizzle.__drizzle_migrations migration
   order by migration.id
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
        ), '[]'::jsonb),
        'acl_is_null', database.datacl is null,
        'effective_acl', coalesce((
          select pg_catalog.jsonb_agg(item::text order by item::text)
            from pg_catalog.unnest(
              coalesce(
                database.datacl,
                pg_catalog.acldefault('d', database.datdba)
              )
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
       'learncoding_ops',
       'learncoding_backup_reporter'
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
        ), '[]'::jsonb),
        'acl_is_null', namespace.nspacl is null,
        'effective_acl', coalesce((
          select pg_catalog.jsonb_agg(item::text order by item::text)
            from pg_catalog.unnest(
              coalesce(
                namespace.nspacl,
                pg_catalog.acldefault('n', namespace.nspowner)
              )
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
        ), '[]'::jsonb),
        'acl_is_null', relation.relacl is null,
        'effective_acl', coalesce((
          select pg_catalog.jsonb_agg(item::text order by item::text)
            from pg_catalog.unnest(
              coalesce(
                relation.relacl,
                case
                  when relation.relkind = 'S'
                    then pg_catalog.acldefault('S', relation.relowner)
                  when relation.relkind in ('r', 'p', 'v', 'm', 'f')
                    then pg_catalog.acldefault('r', relation.relowner)
                  else '{}'::aclitem[]
                end
              )
            ) item
        ), '[]'::jsonb),
        'definition', case relation.relkind
          when 'i' then pg_catalog.pg_get_indexdef(
            relation.oid, 0, true
          )
          when 'I' then pg_catalog.pg_get_indexdef(
            relation.oid, 0, true
          )
          when 'v' then pg_catalog.pg_get_viewdef(
            relation.oid, true
          )
          when 'm' then pg_catalog.pg_get_viewdef(
            relation.oid, true
          )
          else null
        end,
        'force_row_security', relation.relforcerowsecurity,
        'policies', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'command', policy.polcmd,
              'name', policy.polname,
              'permissive', policy.polpermissive,
              'roles', coalesce((
                select pg_catalog.jsonb_agg(
                  case role_oid
                    when 0 then 'PUBLIC'
                    else pg_catalog.pg_get_userbyid(role_oid)
                  end
                  order by case role_oid
                    when 0 then 'PUBLIC'
                    else pg_catalog.pg_get_userbyid(role_oid)
                  end
                )
                  from pg_catalog.unnest(policy.polroles)
                       role_oid
              ), '[]'::jsonb),
              'using', pg_catalog.pg_get_expr(
                policy.polqual,
                policy.polrelid
              ),
              'with_check', pg_catalog.pg_get_expr(
                policy.polwithcheck,
                policy.polrelid
              )
            )
            order by policy.polname, policy.oid
          )
            from pg_catalog.pg_policy policy
           where policy.polrelid = relation.oid
        ), '[]'::jsonb),
        'row_security', relation.relrowsecurity,
        'sequence', case when relation.relkind = 'S' then (
          select pg_catalog.jsonb_build_object(
            'cache', sequence.seqcache::text,
            'cycle', sequence.seqcycle,
            'data_type', pg_catalog.format_type(
              sequence.seqtypid, -1
            ),
            'increment', sequence.seqincrement::text,
            'maximum', sequence.seqmax::text,
            'minimum', sequence.seqmin::text,
            'start', sequence.seqstart::text
          )
            from pg_catalog.pg_sequence sequence
           where sequence.seqrelid = relation.oid
        ) else null end
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
        'acl_is_null', attribute.attacl is null,
        'effective_acl', coalesce((
          select pg_catalog.jsonb_agg(item::text order by item::text)
            from pg_catalog.unnest(
              coalesce(
                attribute.attacl,
                pg_catalog.acldefault('c', relation.relowner)
              )
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
       and relation.relkind in ('r', 'p', 'v', 'm', 'f', 'c')
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
        'acl_is_null', routine.proacl is null,
        'effective_acl', coalesce((
          select pg_catalog.jsonb_agg(item::text order by item::text)
            from pg_catalog.unnest(
              coalesce(
                routine.proacl,
                pg_catalog.acldefault('f', routine.proowner)
              )
            ) item
        ), '[]'::jsonb),
        'configuration', coalesce(
          pg_catalog.to_jsonb(routine.proconfig),
          '[]'::jsonb
        ),
        'definition', pg_catalog.pg_get_functiondef(routine.oid),
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
        ), '[]'::jsonb),
        'acl_is_null', type_row.typacl is null,
        'effective_acl', coalesce((
          select pg_catalog.jsonb_agg(item::text order by item::text)
            from pg_catalog.unnest(
              coalesce(
                type_row.typacl,
                pg_catalog.acldefault('T', type_row.typowner)
              )
            ) item
        ), '[]'::jsonb),
        'domain', case when type_row.typtype = 'd' then
          pg_catalog.jsonb_build_object(
            'base_type', pg_catalog.format_type(
              type_row.typbasetype,
              type_row.typtypmod
            ),
            'constraints', coalesce((
              select pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                  'definition', pg_catalog.pg_get_constraintdef(
                    domain_constraint.oid,
                    true
                  ),
                  'name', domain_constraint.conname,
                  'validated', domain_constraint.convalidated
                )
                order by domain_constraint.conname,
                         domain_constraint.oid
              )
                from pg_catalog.pg_constraint domain_constraint
               where domain_constraint.contypid = type_row.oid
            ), '[]'::jsonb),
            'default', pg_catalog.pg_get_expr(
              type_row.typdefaultbin,
              0
            ),
            'not_null', type_row.typnotnull
          )
          else null
        end,
        'enum_labels', case when type_row.typtype = 'e' then
          coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'label', enum_label.enumlabel,
                'sort_order', enum_label.enumsortorder::text
              )
              order by enum_label.enumsortorder,
                       enum_label.enumlabel
            )
              from pg_catalog.pg_enum enum_label
             where enum_label.enumtypid = type_row.oid
          ), '[]'::jsonb)
          else null
        end,
        'range', (
          select pg_catalog.jsonb_build_object(
            'canonical', case range_row.rngcanonical
              when 0 then null
              else range_row.rngcanonical::pg_catalog.regprocedure::text
            end,
            'collation', case range_row.rngcollation
              when 0 then null
              else range_row.rngcollation::pg_catalog.regcollation::text
            end,
            'kind', case
              when range_row.rngtypid = type_row.oid then 'range'
              else 'multirange'
            end,
            'opclass', (
              select pg_catalog.quote_ident(opclass_namespace.nspname)
                     || '.'
                     || pg_catalog.quote_ident(opclass.opcname)
                from pg_catalog.pg_opclass opclass
                join pg_catalog.pg_namespace opclass_namespace
                  on opclass_namespace.oid = opclass.opcnamespace
               where opclass.oid = range_row.rngsubopc
            ),
            'subdiff', case range_row.rngsubdiff
              when 0 then null
              else range_row.rngsubdiff::pg_catalog.regprocedure::text
            end,
            'subtype', pg_catalog.format_type(
              range_row.rngsubtype,
              -1
            )
          )
            from pg_catalog.pg_range range_row
           where range_row.rngtypid = type_row.oid
              or range_row.rngmultitypid = type_row.oid
           order by range_row.rngtypid
           limit 1
        )
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
        ), '[]'::jsonb),
        'acl_is_null', default_acl.defaclacl is null,
        'effective_acl', coalesce((
          select pg_catalog.jsonb_agg(item::text order by item::text)
            from pg_catalog.unnest(
              coalesce(
                default_acl.defaclacl,
                pg_catalog.acldefault(default_acl.defaclobjtype, default_acl.defaclrole)
              )
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
      or outbox.idempotency_key =
         'backup-status:v1:20260725T000000Z'
   order by outbox.idempotency_key, outbox.id
`;

const BACKUP_AUTHORITY_CATALOG_SQL = `
  select pg_catalog.to_regclass(
    'public.backup_status_mail_authority'
  ) is not null as authority_table_present
`;

const BACKUP_AUTHORITY_ROWS_SQL = `
  select pg_catalog.to_jsonb(authority) as payload
    from public.backup_status_mail_authority authority
   where authority.run_key = '20260725T000000Z'
   order by authority.run_key, authority.id
`;

const MIGRATION_LEDGER_VERSION = "drizzle-migration-ledger-v1";
const OBJECT_CONTRACT_VERSION = "postgres-object-contract-v3";
const MAIL_AUTHORITY_VERSION = "mail-authority-rows-v2";

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parsedMigrationLedger(
  rows: readonly Record<string, unknown>[],
): Readonly<{
  entryCount: number;
  tailSha256: string;
  tailWhen: number;
  sha256: string;
}> | undefined {
  if (rows.length === 0) return undefined;
  let priorWhen = 0;
  for (const [index, row] of rows.entries()) {
    const keys = Object.keys(row).sort();
    const when = positiveInteger(row.migration_when);
    if (
      keys.join(",") !==
        "migration_index,migration_sha256,migration_when"
      || row.migration_index !== String(index)
      || typeof row.migration_sha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(row.migration_sha256)
      || when === undefined
      || when <= priorWhen
    ) {
      return undefined;
    }
    priorWhen = when;
  }
  const tail = rows.at(-1)!;
  return {
    entryCount: rows.length,
    tailSha256: tail.migration_sha256 as string,
    tailWhen: positiveInteger(tail.migration_when)!,
    sha256: stableSha256({
      entries: rows,
      version: MIGRATION_LEDGER_VERSION,
    }),
  };
}

function objectContractSortKey(
  row: Record<string, unknown>,
): string | undefined {
  const fields = [
    row.kind,
    row.schema_name,
    row.object_name,
    row.identity,
    row.owner_name,
  ];
  if (
    fields.some((field) => typeof field !== "string")
    || row.attributes === null
    || typeof row.attributes !== "object"
    || Array.isArray(row.attributes)
  ) {
    return undefined;
  }
  return (fields as string[]).join("\u0000");
}

export function hashFullSchemaObjectContract(
  rows: readonly Record<string, unknown>[],
): string {
  if (rows.length === 0) {
    throw new Error("full-schema restore object contract is invalid");
  }
  let prior: string | undefined;
  for (const row of rows) {
    const key = objectContractSortKey(row);
    if (key === undefined || (prior !== undefined && key <= prior)) {
      throw new Error("full-schema restore object contract is invalid");
    }
    prior = key;
  }
  return stableSha256({
    objects: rows,
    version: OBJECT_CONTRACT_VERSION,
  });
}

function quotedIdentifier(value: unknown): string | undefined {
  if (
    typeof value !== "string"
    || value.length === 0
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return undefined;
  }
  return `"${value.replaceAll('"', '""')}"`;
}

async function withExactSequenceState(
  client: FullSchemaRestoreQueryClient,
  rows: readonly Record<string, unknown>[],
): Promise<readonly Record<string, unknown>[]> {
  const enriched: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (row.kind !== "relation" || row.identity !== "S") {
      enriched.push(row);
      continue;
    }
    const schemaName = quotedIdentifier(row.schema_name);
    const objectName = quotedIdentifier(row.object_name);
    const attributes = row.attributes;
    if (
      schemaName === undefined
      || objectName === undefined
      || attributes === null
      || typeof attributes !== "object"
      || Array.isArray(attributes)
    ) {
      throw new Error("full-schema restore sequence contract is invalid");
    }
    const sequence = (attributes as Record<string, unknown>).sequence;
    if (
      sequence === null
      || typeof sequence !== "object"
      || Array.isArray(sequence)
    ) {
      throw new Error("full-schema restore sequence contract is invalid");
    }
    const stateResult = await client.query(`
      select sequence_state.last_value::text as last_value,
             sequence_state.is_called
        from ${schemaName}.${objectName} sequence_state
    `);
    const state = stateResult.rows[0];
    if (
      stateResult.rows.length !== 1
      || Object.keys(state ?? {}).sort().join(",") !==
        "is_called,last_value"
      || typeof state?.last_value !== "string"
      || !/^-?[0-9]+$/u.test(state.last_value)
      || typeof state.is_called !== "boolean"
    ) {
      throw new Error("full-schema restore sequence contract is invalid");
    }
    enriched.push({
      ...row,
      attributes: {
        ...(attributes as Record<string, unknown>),
        sequence: {
          ...(sequence as Record<string, unknown>),
          is_called: state.is_called,
          last_value: state.last_value,
        },
      },
    });
  }
  return enriched;
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
  const objectRows = await withExactSequenceState(
    client,
    objectResult.rows,
  );

  const versionNumber = positiveInteger(
    versionResult.rows[0]?.server_version_num,
  );
  const migrationLedger = parsedMigrationLedger(journalResult.rows);
  const mailRows = mailResult.rows.map((row) => row.payload);
  let objectContractSha256: string | undefined;
  try {
    objectContractSha256 = hashFullSchemaObjectContract(
      objectRows,
    );
  } catch {
    objectContractSha256 = undefined;
  }
  if (
    versionNumber === undefined
    || migrationLedger === undefined
    || objectContractSha256 === undefined
    || mailRows.length === 0
    || mailRows.some((row) => row === null || typeof row !== "object")
  ) {
    throw new Error("full-schema restore database snapshot failed");
  }

  const authorityCatalog = await client.query(
    BACKUP_AUTHORITY_CATALOG_SQL,
  );
  if (
    authorityCatalog.rows.length !== 1
    || typeof authorityCatalog.rows[0]?.authority_table_present !==
      "boolean"
  ) {
    throw new Error("full-schema restore database snapshot failed");
  }
  const authorityRows = authorityCatalog.rows[0].authority_table_present
    ? (await client.query(BACKUP_AUTHORITY_ROWS_SQL)).rows.map(
      (row) => row.payload,
    )
    : [];
  if (
    authorityCatalog.rows[0].authority_table_present === true
    && (
      authorityRows.length !== 1
      || authorityRows.some((row) =>
        row === null || typeof row !== "object")
    )
  ) {
    throw new Error("full-schema restore database snapshot failed");
  }

  return {
    postgresMajor: Math.floor(versionNumber / 10_000),
    journalEntryCount: migrationLedger.entryCount,
    journalTailSha256: migrationLedger.tailSha256,
    journalTailWhen: migrationLedger.tailWhen,
    migrationLedgerSha256: migrationLedger.sha256,
    objectContractSha256,
    mailRowsSha256: stableSha256({
      backupStatusAuthority: authorityRows,
      outbox: mailRows,
      version: MAIL_AUTHORITY_VERSION,
    }),
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
  select summary.disposition,
         summary.eligible::text as eligible,
         summary.transitioned::text as transitioned
    from public.redact_unresolved_email_outbox_authority(
      pg_catalog.statement_timestamp() - interval '30 days',
      100
    ) summary
   order by case summary.disposition
     when 'eligible' then 1
     when 'blocked' then 2
     when 'malformed' then 3
     else 4
   end
`;

const VERIFY_REDACTION_SQL = `
  select outbox.id::text as id,
         outbox.idempotency_key,
         outbox.user_id,
         outbox.to_email,
         outbox.variables
    from public.email_outbox outbox
   where outbox.idempotency_key in (
     'full-schema-restore:account-quarantined:v1',
     'full-schema-restore:system-quarantined:v1'
     )
   order by outbox.idempotency_key
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

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function transitionedRedactionRows(
  rows: readonly Record<string, unknown>[],
): number | undefined {
  const expected = [
    { disposition: "eligible", eligible: 2, transitioned: 2 },
    { disposition: "blocked", eligible: 0, transitioned: 0 },
    { disposition: "malformed", eligible: 0, transitioned: 0 },
  ] as const;
  if (rows.length !== expected.length) return undefined;

  let transitioned = 0;
  for (const [index, contract] of expected.entries()) {
    const row = rows[index];
    const eligible = nonNegativeInteger(row?.eligible);
    const rowTransitioned = nonNegativeInteger(row?.transitioned);
    if (
      row?.disposition !== contract.disposition
      || eligible !== contract.eligible
      || rowTransitioned !== contract.transitioned
    ) {
      return undefined;
    }
    transitioned += rowTransitioned;
  }
  return transitioned;
}

function verifiedRedactedRows(
  rows: readonly Record<string, unknown>[],
): number | undefined {
  const expected = [
    {
      id: "20000000-0000-4000-8000-000000000002",
      idempotencyKey: "full-schema-restore:account-quarantined:v1",
      userId: "full-schema-restore-learner",
      toEmail:
        "redacted+20000000-0000-4000-8000-000000000002@invalid.local",
      variables: {},
    },
    {
      id: "20000000-0000-4000-8000-000000000004",
      idempotencyKey: "full-schema-restore:system-quarantined:v1",
      userId: null,
      toEmail:
        "redacted+20000000-0000-4000-8000-000000000004@invalid.local",
      variables: {
        _mailOperationId: "30000000-0000-4000-8000-000000000004",
        _mailRecipient:
          "redacted+20000000-0000-4000-8000-000000000004@invalid.local",
        _mailProducer: "access-request-admin",
        _mailSourceId: "10000000-0000-4000-8000-000000000001",
      },
    },
  ] as const;
  if (rows.length !== expected.length) return undefined;

  try {
    for (const [index, contract] of expected.entries()) {
      const row = rows[index];
      if (
        row?.id !== contract.id
        || row.idempotency_key !== contract.idempotencyKey
        || row.user_id !== contract.userId
        || row.to_email !== contract.toEmail
        || row.variables === null
        || typeof row.variables !== "object"
        || Array.isArray(row.variables)
        || stableSha256(row.variables) !== stableSha256(contract.variables)
      ) {
        return undefined;
      }
    }
  } catch {
    return undefined;
  }
  return rows.length;
}

export async function runFullSchemaRestoreDatabaseSmoke(input: Readonly<{
  worker: FullSchemaRestoreQueryClient;
  ops: FullSchemaRestoreQueryClient;
  verifier: FullSchemaRestoreQueryClient;
}>): Promise<FullSchemaRestoreSmoke> {
  const claimedRows = await probeWorkerClaim(input.worker);
  const redaction = await input.ops.query(REDACT_SQL);
  const verification = await input.verifier.query(VERIFY_REDACTION_SQL);
  const redactedRows = transitionedRedactionRows(redaction.rows);
  const verifiedRows = verifiedRedactedRows(verification.rows);
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
