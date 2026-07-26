import process from "node:process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";
import {
  MAIL_WORKER_OUTBOX_INSERT_COLUMNS,
  MAIL_WORKER_OUTBOX_PRE_BINDING_UPDATE_COLUMNS,
  MAIL_WORKER_OUTBOX_PRE_EVIDENCE_UPDATE_COLUMNS,
  MAIL_WORKER_OUTBOX_PRE_REPLAY_INSERT_COLUMNS,
  MAIL_WORKER_OUTBOX_UPDATE_COLUMNS,
  REVIEWED_APPLICATION_CONSTRAINTS,
  REVIEWED_APPLICATION_FUNCTIONS,
  REVIEWED_APPLICATION_TRIGGERS,
  REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES,
  REVIEWED_REPLAY_AUTHORITY_RELATIONAL_CONTRACT,
  canonicalReviewedMailAuthorityCatalogPhase,
} from "./bootstrap-database-roles.mjs";
import {
  verifyBackupStatusMailAuthorityObjects,
} from "./verify-backup-status-mail-authority.mjs";

export const DATABASE_ADMIN_LOCK_NAME = "codestead:database-administration:v1";
const MIN_PASSWORD_BYTES = 32;
const MAX_PASSWORD_BYTES = 1024;
const MAX_LOCK_TIMEOUT_MS = 120_000;
const LOCK_POLL_MS = 250;
const CLEANUP_TIMEOUT_MS = 5_000;
const ROLE_SPECS = Object.freeze([
  ["app", "databaseAppUrl", "learncoding_app"],
  ["migrator", "databaseMigratorUrl", "learncoding_migrator"],
  ["worker", "databaseWorkerUrl", "learncoding_worker"],
  ["ops", "databaseOpsUrl", "learncoding_ops"],
  ["backupReporter", "databaseBackupReporterUrl", "learncoding_backup_reporter"],
]);
const RESTRICTED_ROLE_NAMES = Object.freeze(
  ROLE_SPECS.map(([, , role]) => role),
);
const RUNTIME_ROLES = new Set([
  "learncoding_app",
  "learncoding_worker",
  "learncoding_ops",
]);

export class DatabaseRoleBoundaryError extends Error {
  constructor(section = "unspecified") {
    super(`database role boundary verification failed: ${section}`);
    this.name = "DatabaseRoleBoundaryError";
  }
}

function fail(section) {
  throw new DatabaseRoleBoundaryError(section);
}

async function establishTrustedCatalogSearchPath(client) {
  const result = await client.query(
    "select pg_catalog.set_config('search_path', 'pg_catalog,pg_temp', false) trusted_search_path",
  );
  if (
    result.rows.length !== 1
    || result.rows[0]?.trusted_search_path !== "pg_catalog,pg_temp"
  ) {
    fail("trusted-search-path");
  }
}

function decodeComponent(value) {
  const decoded = decodeURIComponent(value);
  if (!decoded || /[\u0000-\u001f\u007f]/u.test(decoded)) fail();
  return decoded;
}

export function validateDatabaseRoleBoundaryUrls(input) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(input.postgresDatabase ?? "")) fail();
  const parsed = {};
  const passwords = new Set();
  try {
    for (const [name, property, expectedUsername] of ROLE_SPECS) {
      const url = new URL(input[property]);
      const username = decodeComponent(url.username);
      const password = decodeComponent(url.password);
      const database = decodeComponent(url.pathname.slice(1));
      const passwordBytes = Buffer.byteLength(password, "utf8");
      if (
        url.protocol !== "postgresql:" ||
        username !== expectedUsername ||
        url.hostname !== "postgres" ||
        (url.port !== "" && url.port !== "5432") ||
        database !== input.postgresDatabase ||
        url.pathname !== `/${encodeURIComponent(input.postgresDatabase)}` ||
        url.search !== "" ||
        url.hash !== "" ||
        passwordBytes < MIN_PASSWORD_BYTES ||
        passwordBytes > MAX_PASSWORD_BYTES ||
        passwords.has(password)
      )
        fail();
      passwords.add(password);
      parsed[name] = { username, database, connectionString: url.href };
    }
  } catch {
    fail();
  }
  return parsed;
}

function defaultPoolFactory({ connectionString, role }) {
  return new Pool({
    application_name: `codestead_role_boundary_${role}`,
    connectionString,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 1_000,
    max: 1,
    statement_timeout: 5_000,
  });
}

function exactRow(row, expected) {
  return Object.entries(expected).every(([key, value]) => row?.[key] === value);
}

function exactRowMismatchKeys(row, expected) {
  return Object.keys(expected).filter((key) => row?.[key] !== expected[key]);
}

function quoteIdentifier(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    fail();
  return `"${value.replaceAll('"', '""')}"`;
}

function qualifiedName(object) {
  return `${quoteIdentifier(object.schema_name)}.${quoteIdentifier(object.object_name)}`;
}

async function bounded(operation, timeoutMs = CLEANUP_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new DatabaseRoleBoundaryError()),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function acquireAdministrationLock(client, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail();
  const deadline = performance.now() + Math.min(timeoutMs, MAX_LOCK_TIMEOUT_MS);
  while (performance.now() < deadline) {
    const result = await client.query(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) acquired",
      [DATABASE_ADMIN_LOCK_NAME],
    );
    if (result.rows[0]?.acquired === true) return;
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(LOCK_POLL_MS, Math.max(1, deadline - performance.now())),
      ),
    );
  }
  fail();
}

async function releaseAdministrationLock(client) {
  const result = await bounded(() =>
    client.query(
      "select pg_advisory_unlock(hashtextextended($1, 0)) released",
      [DATABASE_ADMIN_LOCK_NAME],
    ),
  );
  if (result.rows[0]?.released !== true) fail();
}

async function expectInsufficientPrivilege(client, sql) {
  await client.query("begin");
  try {
    try {
      await client.query(sql);
      fail();
    } catch (error) {
      if (error instanceof DatabaseRoleBoundaryError || error?.code !== "42501")
        fail();
    }
  } finally {
    await bounded(() => client.query("rollback"));
  }
}

async function tablePrivilegeDelegationState(client, grantee, objectOid) {
  const result = await client.query(
    `
    select has_table_privilege($1::name, $2::oid, 'SELECT') delegated,
           has_table_privilege(
             current_user,
             $2::oid,
             'SELECT WITH GRANT OPTION'
           ) current_role_effective_grantable,
           coalesce(
             bool_or(acl.is_grantable) filter (
               where acl.grantee = active_role.oid
                 and acl.privilege_type = 'SELECT'
             ),
             false
           ) current_role_direct_grantable,
           coalesce(
             string_agg(
               pg_catalog.concat_ws(
                 ':',
                 acl.grantor::text,
                 acl.grantee::text,
                 acl.privilege_type,
                 acl.is_grantable::text
               ),
               ',' order by acl.grantor,
                            acl.grantee,
                            acl.privilege_type,
                            acl.is_grantable
             ),
             ''
           ) table_acl
      from pg_catalog.pg_class c
      join pg_catalog.pg_roles active_role
        on active_role.rolname = current_user
      cross join lateral pg_catalog.aclexplode(
        coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))
      ) acl
     where c.oid = $2::oid
     group by c.oid, active_role.oid`,
    [grantee, objectOid],
  );
  if (!result.rows[0]) fail();
  return result.rows[0];
}

async function expectTablePrivilegeNotDelegated(
  client,
  role,
  table,
  objectOid,
) {
  const grantee = "learncoding_migrator";
  await client.query("begin");
  try {
    const before = await tablePrivilegeDelegationState(
      client,
      grantee,
      objectOid,
    );
    if (
      before.delegated !== false ||
      before.current_role_effective_grantable !== false ||
      before.current_role_direct_grantable !== false
    )
      fail();
    if (RUNTIME_ROLES.has(role)) {
      await client.query(
        `grant select on table ${table} to ${quoteIdentifier(grantee)}`,
      );
      const after = await tablePrivilegeDelegationState(
        client,
        grantee,
        objectOid,
      );
      if (!exactRow(after, before)) fail();
    }
  } finally {
    await bounded(() => client.query("rollback"));
  }
}

async function discoverApplicationObjects(client) {
  const table = await client.query(`
    select n.nspname schema_name, c.relname object_name,
           c.oid object_oid, a.attname column_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join lateral (
        select attribute.attname
          from pg_attribute attribute
         where attribute.attrelid = c.oid
           and attribute.attnum > 0
           and not attribute.attisdropped
           and attribute.attgenerated = ''
           and attribute.attidentity <> 'a'
         order by attribute.attnum
         limit 1
      ) a on true
     where n.nspname = 'public' and c.relkind = 'r'
     order by c.relname
     limit 1`);
  const sequence = await client.query(`
    select n.nspname schema_name, c.relname object_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'S'
     order by c.relname
     limit 1`);
  const type = await client.query(`
    select n.nspname schema_name, t.typname object_name
      from pg_type t
      join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'public' and t.typtype in ('d', 'e', 'm', 'r')
     order by t.typname
     limit 1`);
  if (!table.rows[0]) fail();
  return {
    table: table.rows[0],
    sequence: sequence.rows[0],
    type: type.rows[0],
  };
}

export async function verifyReviewedApplicationRoutines(
  client,
  routines = REVIEWED_APPLICATION_FUNCTIONS,
) {
  await establishTrustedCatalogSearchPath(client);
  let verified = 0;
  for (const routine of routines) {
    const result = await client.query(
      `
      select pg_catalog.encode(
               pg_catalog.sha256(
                 pg_catalog.convert_to(p.prosrc, 'UTF8')
               ),
               'hex'
             ) is not distinct from $7::text body_sha256_exact,
             pg_catalog.pg_get_userbyid(p.proowner) = $2 owner_exact,
             p.prosecdef is not distinct from $3::boolean security_definer_exact,
             p.proconfig is not distinct from $4::text[] configuration_exact,
             language.lanname is not distinct from $8::text language_exact,
             p.prokind::text is not distinct from $9::text kind_exact,
             p.provolatile::text is not distinct from $10::text volatility_exact,
             p.proisstrict is not distinct from $11::boolean strict_exact,
             p.proparallel::text is not distinct from $12::text parallel_exact,
             p.proleakproof is not distinct from $13::boolean leakproof_exact,
             coalesce(
               p.proargnames,
               '{}'::text[]
             ) is not distinct from $14::text[] argument_names_exact,
             coalesce(
               (
                 select pg_catalog.array_agg(
                          argument_mode::text order by argument_order
                        )
                   from pg_catalog.unnest(p.proargmodes)
                        with ordinality argument(argument_mode, argument_order)
               ),
               '{}'::text[]
             ) is not distinct from $15::text[] argument_modes_exact,
             (
               select coalesce(
                        pg_catalog.array_agg(
                          observed.argument_type
                          order by observed.argument_order
                        ),
                        '{}'::oid[]
                      )
                 from pg_catalog.unnest(
                        coalesce(p.proallargtypes, p.proargtypes::oid[])
                      ) with ordinality
                      observed(argument_type, argument_order)
             ) is not distinct from (
               select coalesce(
                        pg_catalog.array_agg(
                          pg_catalog.to_regtype(argument_type)::oid
                          order by argument_order
                        ),
                        '{}'::oid[]
                      )
                 from pg_catalog.unnest($16::text[])
                      with ordinality expected(argument_type, argument_order)
             ) argument_types_exact,
             p.pronargs::integer is not distinct from
               $17::integer input_argument_count_exact,
             (
               p.pronargdefaults::integer is not distinct from $18::integer
               and (p.proargdefaults is null) is not distinct from
                   ($18::integer = 0)
             ) argument_defaults_exact,
             p.prorettype is not distinct from
               pg_catalog.to_regtype($19::text)::oid return_type_exact,
             p.proretset is not distinct from $20::boolean returns_set_exact,
             (p.provariadic <> 0) is not distinct from
               $21::boolean variadic_exact,
             p.procost is not distinct from $22::real cost_exact,
             p.prorows is not distinct from $23::real rows_exact,
             (
               ($24::text is null and p.prosupport = 0)
               or p.prosupport =
                    pg_catalog.to_regprocedure($24::text)::oid
             ) support_exact,
             coalesce(
               p.protrftypes,
               '{}'::oid[]
             ) is not distinct from (
               select coalesce(
                        pg_catalog.array_agg(
                          pg_catalog.to_regtype(transform_type)::oid
                          order by transform_order
                        ),
                        '{}'::oid[]
                      )
                 from pg_catalog.unnest($25::text[])
                      with ordinality expected(
                        transform_type,
                        transform_order
                      )
             ) transform_types_exact,
             p.probin is not distinct from $26::text binary_exact,
             p.prosqlbody::text is not distinct from
               $27::text sql_body_exact,
             (
               $28::text is null
               or pg_catalog.encode(
                    pg_catalog.sha256(
                      pg_catalog.convert_to(
                        pg_catalog.pg_get_functiondef(p.oid),
                        'UTF8'
                      )
                    ),
                    'hex'
                  ) is not distinct from $28::text
             ) definition_sha256_exact,
             pg_catalog.has_function_privilege($2, p.oid, 'EXECUTE') owner_execute_exact,
             (
               not pg_catalog.has_function_privilege(0, p.oid, 'EXECUTE')
               and not exists (
                 select 1
                   from pg_catalog.unnest($5::text[]) restricted(role_name)
                  where pg_catalog.has_function_privilege(
                          restricted.role_name,
                          p.oid,
                          'EXECUTE'
                        ) is distinct from
                        (restricted.role_name = any($6::text[]))
               )
             ) effective_execute_exact,
             (
               with observed(
                 grantor, grantee, privilege_type, is_grantable
               ) as (
                 select acl.grantor,
                        acl.grantee,
                        acl.privilege_type,
                        acl.is_grantable
                   from pg_catalog.aclexplode(
                     coalesce(
                       p.proacl,
                       pg_catalog.acldefault('f', p.proowner)
                     )
                   ) acl
               ),
               expected(
                 grantor, grantee, privilege_type, is_grantable
               ) as (
                 select p.proowner,
                        grantee.oid,
                        'EXECUTE'::text,
                        false
                   from pg_catalog.pg_roles grantee
                  where grantee.oid = p.proowner
                 union all
                 select p.proowner,
                        grantee.oid,
                        'EXECUTE'::text,
                        false
                   from pg_catalog.unnest($6::text[]) allowed(role_name)
                   join pg_catalog.pg_roles grantee
                     on grantee.rolname = allowed.role_name
               )
               select not exists (
                 select 1
                   from (
                     (
                       select * from observed
                       except all
                       select * from expected
                     )
                     union all
                     (
                       select * from expected
                       except all
                       select * from observed
                     )
                   ) difference
               )
             ) routine_direct_acl_exact
        from pg_catalog.pg_proc p
        join pg_catalog.pg_language language
          on language.oid = p.prolang
       where p.oid = pg_catalog.to_regprocedure($1::text)::oid`,
      [
        routine.signature,
        routine.owner,
        routine.securityDefiner,
        routine.configuration,
        RESTRICTED_ROLE_NAMES,
        routine.allowedRoles,
        routine.bodySha256,
        routine.language,
        routine.kind,
        routine.volatility,
        routine.strict,
        routine.parallel,
        routine.leakproof,
        routine.argumentNames,
        routine.argumentModes,
        routine.argumentTypes,
        routine.inputArgumentCount,
        routine.argumentDefaultCount,
        routine.returnType,
        routine.returnsSet,
        routine.variadic,
        routine.cost,
        routine.rows,
        routine.supportFunction,
        routine.transformTypes,
        routine.binary,
        routine.sqlBody,
        routine.definitionSha256,
      ],
    );
    const expected = {
      owner_exact: true,
      security_definer_exact: true,
      configuration_exact: true,
      owner_execute_exact: true,
      body_sha256_exact: true,
      language_exact: true,
      kind_exact: true,
      volatility_exact: true,
      strict_exact: true,
      parallel_exact: true,
      leakproof_exact: true,
      argument_names_exact: true,
      argument_modes_exact: true,
      argument_types_exact: true,
      input_argument_count_exact: true,
      argument_defaults_exact: true,
      return_type_exact: true,
      returns_set_exact: true,
      variadic_exact: true,
      cost_exact: true,
      rows_exact: true,
      support_exact: true,
      transform_types_exact: true,
      binary_exact: true,
      sql_body_exact: true,
      definition_sha256_exact: true,
      effective_execute_exact: true,
      routine_direct_acl_exact: true,
    };
    const row = result.rows[0];
    if (result.rows.length !== 1 || !exactRow(row, expected)) {
      const mismatches =
        result.rows.length === 1
          ? exactRowMismatchKeys(row, expected).join(",")
          : "missing-or-duplicate";
      fail(`reviewed-routine:${routine.signature}:${mismatches}`);
    }
    verified += 1;
  }
  return verified;
}
export async function verifyReviewedApplicationTriggers(
  client,
  triggers = REVIEWED_APPLICATION_TRIGGERS,
) {
  let verified = 0;
  for (const trigger of triggers) {
    const result = await client.query(
      `
      select t.tgrelid = pg_catalog.to_regclass($1::text)::oid relation_exact,
             t.tgfoid = pg_catalog.to_regprocedure($3::text)::oid function_exact,
             t.tgenabled::text is not distinct from $4::text enabled_exact,
             t.tgtype::integer is not distinct from $5::integer type_exact,
             pg_catalog.pg_get_expr(t.tgqual, t.tgrelid)
               is not distinct from $6::text predicate_exact,
             (
               t.tgnargs::integer = pg_catalog.cardinality($7::text[])
               and (
                 pg_catalog.cardinality($7::text[]) <> 0
                 or pg_catalog.octet_length(t.tgargs) = 0
               )
             ) arguments_exact,
             (
               select coalesce(
                        pg_catalog.array_agg(
                          attribute.attname::text order by watched.ordinality
                        ),
                        '{}'::text[]
                      )
                 from pg_catalog.unnest(t.tgattr::smallint[])
                      with ordinality watched(attnum, ordinality)
                 join pg_catalog.pg_attribute attribute
                   on attribute.attrelid = t.tgrelid
                  and attribute.attnum = watched.attnum
             ) is not distinct from $8::text[] watched_columns_exact,
             not t.tgisinternal reviewed_trigger_catalog_exact
        from pg_catalog.pg_trigger t
       where t.tgrelid = pg_catalog.to_regclass($1::text)::oid
         and t.tgname = $2::text`,
      [
        trigger.relation,
        trigger.name,
        trigger.functionSignature,
        trigger.enabled,
        trigger.type,
        trigger.predicate,
        trigger.arguments,
        trigger.watchedColumns,
      ],
    );
    if (
      result.rows.length !== 1 ||
      !exactRow(result.rows[0], {
        relation_exact: true,
        function_exact: true,
        enabled_exact: true,
        type_exact: true,
        predicate_exact: true,
        arguments_exact: true,
        watched_columns_exact: true,
        reviewed_trigger_catalog_exact: true,
      })
    )
      fail(`reviewed-trigger:${trigger.name}`);
    verified += 1;
  }
  return verified;
}

export async function verifyMailReplayAuthorityTableContract(client) {
  const {
    authority,
    deliveryScope,
    triggerRelations,
    triggers,
    routines,
    unique,
    foreignKey,
    lookupIndex,
  } = REVIEWED_REPLAY_AUTHORITY_RELATIONAL_CONTRACT;
  const persistTrigger = triggers.find(
    ({ name }) => name === foreignKey.persistTriggerName,
  );
  if (
    authority.relation !== unique.relation
    || authority.owner !== "learncoding_owner"
    || authority.columns.length !== 2
    || authority.primaryKey.columns.length !== 1
    || authority.checks.length !== 2
    || deliveryScope.relation !== foreignKey.relation
    || deliveryScope.columns.length !== 8
    || triggerRelations.length !== 2
    || triggers.length !== 8
    || routines.length !== 7
    || new Set(triggers.map(({ name }) => name)).size !== triggers.length
    || new Set(routines.map(({ signature }) => signature)).size !== routines.length
    || persistTrigger === undefined
    || persistTrigger.relation !== foreignKey.relation
    || persistTrigger.functionSignature !==
      "public.persist_email_outbox_idempotency_authority()"
    || persistTrigger.enabled !== "A"
    || persistTrigger.type !== 5
    || unique.relation !== foreignKey.referencedRelation
    || unique.columns.length !== 2
    || foreignKey.columns.length !== 2
    || foreignKey.referencedColumns.length !== 2
    || typeof unique.noInherit !== "boolean"
    || typeof foreignKey.noInherit !== "boolean"
    || lookupIndex.relation !== foreignKey.relation
    || lookupIndex.columns.length !== 2
    || lookupIndex.columns[0] !== "idempotency_authority_sha256"
    || lookupIndex.columns[1] !== "id"
    || unique.columns.some(
      (column, index) => column !== foreignKey.referencedColumns[index],
    )
  ) fail("mail-replay-authority-relational-contract");
  const result = await client.query(
    `
    with target as (
      select relation.oid, relation.relowner, relation.relkind,
             relation.relpersistence, relation.relispartition,
             relation.relrowsecurity, relation.relforcerowsecurity,
             relation.relhasrules
        from pg_catalog.pg_class relation
       where relation.oid = pg_catalog.to_regclass(
               'public.email_outbox_idempotency_authority'
             )
         and relation.relkind = 'r'
    ), observed_acl(
      grantor, grantee, privilege_type, is_grantable
    ) as (
      select access.grantor, access.grantee,
             access.privilege_type, access.is_grantable
        from target
        join pg_catalog.pg_class relation on relation.oid = target.oid
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            relation.relacl,
            pg_catalog.acldefault('r', relation.relowner)
          )
        ) access
    ), expected_acl(
      grantor, grantee, privilege_type, is_grantable
    ) as (
      select target.relowner, owner_role.oid, privilege_type, false
        from target
        join pg_catalog.pg_roles owner_role
          on owner_role.rolname = 'learncoding_owner'
        cross join pg_catalog.unnest(ARRAY[
          'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
          'REFERENCES', 'TRIGGER', 'MAINTAIN'
        ]::text[]) privilege(privilege_type)
    )
    select pg_catalog.count(*) = 1 authority_relation_exact,
           pg_catalog.count(*) = 1
             and pg_catalog.bool_and(
               target.relkind = 'r'
               and target.relpersistence = 'p'
               and not target.relispartition
             ) authority_relation_storage_exact,
           pg_catalog.count(*) = 1
             and pg_catalog.bool_and(
               not target.relrowsecurity
               and not target.relforcerowsecurity
               and not target.relhasrules
               and not exists (
                 select 1
                   from pg_catalog.pg_policy policy
                  where policy.polrelid = target.oid
               )
               and not exists (
                 select 1
                   from pg_catalog.pg_inherits inheritance
                  where inheritance.inhrelid = target.oid
                     or inheritance.inhparent = target.oid
               )
             ) authority_relation_rls_exact,
           (
             select pg_catalog.count(*) =
                      2 + pg_catalog.jsonb_array_length($58::jsonb)
               from pg_catalog.pg_constraint authority_constraint
              where authority_constraint.conrelid =
                      pg_catalog.to_regclass($39::text)
                and authority_constraint.contype <> 'n'
           )
           and (
             select pg_catalog.count(*) = 1
               from pg_catalog.pg_constraint inbound_constraint
              where inbound_constraint.confrelid =
                      pg_catalog.to_regclass($39::text)
                and inbound_constraint.contype = 'f'
           ) authority_constraint_set_exact,
           (
             select pg_catalog.count(*) = 2
               from pg_catalog.pg_index authority_index
              where authority_index.indrelid =
                      pg_catalog.to_regclass($39::text)
           ) authority_index_set_exact,
           (
             with owner_role as (
               select role.oid
                 from pg_catalog.pg_roles role
                where role.rolname = 'learncoding_owner'
             ), public_namespace as (
               select namespace.oid, namespace.nspname
                 from pg_catalog.pg_namespace namespace
                where namespace.nspname = 'public'
             ), managed_grantee_roles as (
               select role.oid, role.rolname
                 from pg_catalog.pg_roles role
                where role.rolname = any(ARRAY[
                  'learncoding_app',
                  'learncoding_worker',
                  'learncoding_ops'
                ]::text[])
             ), default_acl_rows_raw(
               owner_oid,
               owner_name,
               namespace_oid,
               namespace_name,
               object_type,
               acl
             ) as (
               select default_acl.defaclrole,
                      default_owner.rolname,
                      default_acl.defaclnamespace,
                      default_namespace.nspname,
                      default_acl.defaclobjtype::text,
                      default_acl.defaclacl
                 from pg_catalog.pg_default_acl default_acl
                 left join pg_catalog.pg_namespace default_namespace
                   on default_namespace.oid = default_acl.defaclnamespace
                 left join pg_catalog.pg_roles default_owner
                   on default_owner.oid = default_acl.defaclrole
             ), managed_default_acl_creators(owner_oid) as (
               select distinct raw_row.owner_oid
                 from default_acl_rows_raw raw_row
                where raw_row.namespace_oid = 0
                   or raw_row.namespace_name in ('public', 'drizzle')
                   or raw_row.owner_name = 'learncoding_owner'
             ), managed_default_acl_rows(
               owner_oid,
               owner_name,
               namespace_oid,
               object_type,
               acl
             ) as (
               select raw_row.owner_oid,
                      raw_row.owner_name,
                      raw_row.namespace_oid,
                      raw_row.object_type,
                      raw_row.acl
                 from default_acl_rows_raw raw_row
                 join managed_default_acl_creators managed_creator
                   on managed_creator.owner_oid = raw_row.owner_oid
             ), managed_default_acl_entries(
               owner_oid,
               owner_name,
               namespace_oid,
               grantor_oid,
               grantee_oid,
               is_public,
               object_type,
               privilege_type,
               is_grantable
             ) as (
               select managed_row.owner_oid,
                      managed_row.owner_name,
                      managed_row.namespace_oid,
                      access.grantor,
                      access.grantee,
                      access.grantee = 0 is_public,
                      managed_row.object_type,
                      access.privilege_type,
                      access.is_grantable
                 from managed_default_acl_rows managed_row
                 cross join lateral pg_catalog.aclexplode(
                   managed_row.acl
                 ) access
             ), expected_owner_default_acl_rows(
               owner_oid,
               namespace_oid,
               object_type
             ) as (
               select owner_role.oid, 0::oid, global_row.object_type
                 from owner_role
                 cross join (
                   values
                     ('f'::text),
                     ('T'::text)
                 ) global_row(object_type)
               union all
               select owner_role.oid,
                      required_namespace.oid,
                      required_row.object_type
                 from owner_role
                 cross join public_namespace required_namespace
                 cross join (
                   values
                     ('public'::text, 'r'::text),
                     ('public'::text, 'S'::text),
                     ('public'::text, 'T'::text)
                 ) required_row(schema_name, object_type)
                where required_namespace.nspname = required_row.schema_name
             ), expected_owner_default_acl_entries(
               owner_oid,
               namespace_oid,
               grantor_oid,
               grantee_oid,
               is_public,
               object_type,
               privilege_type,
               is_grantable
             ) as (
               select owner_role.oid, 0::oid,
                      owner_role.oid,
                      owner_role.oid,
                      false,
                      global_entry.object_type,
                      global_entry.privilege_type,
                      false
                 from pg_catalog.pg_roles owner_role
                 cross join (
                   values
                     ('f'::text, 'EXECUTE'::text),
                     ('T'::text, 'USAGE'::text)
                 ) global_entry(object_type, privilege_type)
                where owner_role.rolname = 'learncoding_owner'
               union all
               select owner_role.oid,
                      public_namespace.oid,
                      owner_role.oid,
                      grantee_role.oid,
                      false,
                      privilege.object_type,
                      privilege.privilege_type,
                      false
                 from pg_catalog.pg_roles owner_role
                 cross join public_namespace
                 cross join managed_grantee_roles grantee_role
                 cross join (
                   values
                     ('r'::text, 'DELETE'::text),
                     ('r'::text, 'INSERT'::text),
                     ('r'::text, 'SELECT'::text),
                     ('r'::text, 'UPDATE'::text),
                     ('S'::text, 'SELECT'::text),
                     ('S'::text, 'UPDATE'::text),
                     ('S'::text, 'USAGE'::text),
                     ('T'::text, 'USAGE'::text)
                 ) privilege(object_type, privilege_type)
                where owner_role.rolname = 'learncoding_owner'
             ), additional_creator_default_acl_rows(
               owner_oid,
               owner_name,
               namespace_oid,
               object_type,
               acl
             ) as (
               select managed_row.owner_oid,
                      managed_row.owner_name,
                      managed_row.namespace_oid,
                      managed_row.object_type,
                      managed_row.acl
                 from managed_default_acl_rows managed_row
                where not exists (
                  select 1
                    from owner_role
                   where owner_role.oid = managed_row.owner_oid
                )
             ), additional_creator_default_acl_exact(
               owner_oid,
               owner_name_exact,
               rows_exact,
               entries_exact
             ) as (
               select additional_row.owner_oid,
                      pg_catalog.bool_and(
                        additional_row.owner_name is not null
                        and additional_row.owner_name <> 'PUBLIC'
                      ),
                      pg_catalog.count(*) = 2
                        and pg_catalog.count(*) filter (
                          where additional_row.namespace_oid = 0
                            and additional_row.object_type = 'f'
                        ) = 1
                        and pg_catalog.count(*) filter (
                          where additional_row.namespace_oid = 0
                            and additional_row.object_type = 'T'
                        ) = 1,
                      (
                        select pg_catalog.count(*) = 2
                               and pg_catalog.count(*) filter (
                                 where entry.namespace_oid = 0
                                   and entry.object_type in ('f', 'T')
                                   and entry.grantor_oid =
                                         additional_row.owner_oid
                                   and entry.grantee_oid =
                                         additional_row.owner_oid
                                   and entry.privilege_type =
                                         case entry.object_type
                                           when 'f' then 'EXECUTE'
                                           when 'T' then 'USAGE'
                                         end
                                   and not entry.is_public
                                   and not entry.is_grantable
                               ) = 2
                          from managed_default_acl_entries entry
                         where entry.owner_oid = additional_row.owner_oid
                      )
                 from additional_creator_default_acl_rows additional_row
                group by additional_row.owner_oid
             ), default_acl_catalog_prerequisites(
               owner_role_count,
               public_namespace_count,
               managed_grantee_role_count,
               managed_owner_references_exact
             ) as (
               select (
                        select pg_catalog.count(*)
                          from owner_role
                      ),
                      (
                        select pg_catalog.count(*)
                          from public_namespace
                      ),
                      (
                        select pg_catalog.count(*)
                          from managed_grantee_roles
                      ),
                      not exists (
                        select 1
                          from managed_default_acl_rows managed_row
                         where managed_row.owner_name is null
                      )
             )
             select
               (
                 select owner_role_count = 1
                        and public_namespace_count = 1
                        and managed_grantee_role_count = 3
                        and managed_owner_references_exact
                   from default_acl_catalog_prerequisites
               )
               and not exists (
                 (
                   select managed_row.owner_oid,
                          managed_row.namespace_oid,
                          managed_row.object_type
                     from managed_default_acl_rows managed_row
                     join owner_role
                       on owner_role.oid = managed_row.owner_oid
                   except all
                   select * from expected_owner_default_acl_rows
                 )
                 union all
                 (
                   select * from expected_owner_default_acl_rows
                   except all
                   select managed_row.owner_oid,
                          managed_row.namespace_oid,
                          managed_row.object_type
                     from managed_default_acl_rows managed_row
                     join owner_role
                       on owner_role.oid = managed_row.owner_oid
                 )
               )
               and not exists (
                 (
                   select managed_entry.owner_oid,
                          managed_entry.namespace_oid,
                          managed_entry.grantor_oid,
                          managed_entry.grantee_oid,
                          managed_entry.is_public,
                          managed_entry.object_type,
                          managed_entry.privilege_type,
                          managed_entry.is_grantable
                     from managed_default_acl_entries managed_entry
                     join owner_role
                       on owner_role.oid = managed_entry.owner_oid
                   except all
                   select * from expected_owner_default_acl_entries
                 )
                 union all
                 (
                   select * from expected_owner_default_acl_entries
                   except all
                   select managed_entry.owner_oid,
                          managed_entry.namespace_oid,
                          managed_entry.grantor_oid,
                          managed_entry.grantee_oid,
                          managed_entry.is_public,
                          managed_entry.object_type,
                          managed_entry.privilege_type,
                          managed_entry.is_grantable
                     from managed_default_acl_entries managed_entry
                     join owner_role
                       on owner_role.oid = managed_entry.owner_oid
                 )
               )
               and not exists (
                 select 1
                   from additional_creator_default_acl_exact additional
                  where not additional.owner_name_exact
                     or not additional.rows_exact
                     or not additional.entries_exact
               )
           ) persistent_default_acl_exact,
           not exists (
             select 1
               from pg_catalog.pg_class relation
               join pg_catalog.pg_namespace namespace
                 on namespace.oid = relation.relnamespace
               cross join lateral pg_catalog.aclexplode(
                 relation.relacl
               ) access
              where namespace.nspname in ('public', 'drizzle')
                and relation.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
                and access.grantee <> relation.relowner
                and access.is_grantable
           ) persistent_relation_grant_options_exact,
           not exists (
             with observed_column_acl(
               relation_oid,
               column_name,
               grantor_oid,
               grantee_oid,
               privilege_type,
               is_grantable
             ) as (
               select relation.oid,
                      attribute.attname::text,
                      access.grantor,
                      access.grantee,
                      access.privilege_type,
                      access.is_grantable
                 from pg_catalog.pg_class relation
                 join pg_catalog.pg_namespace namespace
                   on namespace.oid = relation.relnamespace
                 join pg_catalog.pg_attribute attribute
                   on attribute.attrelid = relation.oid
                  and attribute.attnum > 0
                  and not attribute.attisdropped
                 cross join lateral pg_catalog.aclexplode(
                   attribute.attacl
                 ) access
                where namespace.nspname in ('public', 'drizzle')
                  and relation.relkind in ('r', 'p', 'v', 'm', 'f')
             ), expected_entry(
               column_name,
               privilege_type,
               grantee_name
             ) as (
               select reviewed.column_name, 'INSERT'::text,
                      'learncoding_worker'::text
                 from pg_catalog.unnest($71::text[])
                      reviewed(column_name)
               union all
               select reviewed.column_name, 'UPDATE'::text,
                      'learncoding_worker'::text
                 from pg_catalog.unnest($72::text[])
                      reviewed(column_name)
               union all
               select 'idempotency_authority_version'::text,
                      'INSERT'::text,
                      'learncoding_app'::text
             ), expected_column_acl(
               relation_oid,
               column_name,
               grantor_oid,
               grantee_oid,
               privilege_type,
               is_grantable
             ) as (
               select outbox_relation.oid,
                      expected_entry.column_name,
                      owner_role.oid,
                      grantee_role.oid,
                      expected_entry.privilege_type,
                      false
                 from expected_entry
                 join pg_catalog.pg_class outbox_relation
                   on outbox_relation.oid = pg_catalog.to_regclass(
                        'public.email_outbox'
                      )
                 join pg_catalog.pg_roles owner_role
                   on owner_role.rolname = 'learncoding_owner'
                 join pg_catalog.pg_roles grantee_role
                   on grantee_role.rolname =
                        expected_entry.grantee_name
             )
             (
               select * from observed_column_acl
               except all
               select * from expected_column_acl
             )
             union all
             (
               select * from expected_column_acl
               except all
               select * from observed_column_acl
             )
           ) persistent_column_acl_exact,
           (
             select pg_catalog.count(*) = 1
                    and pg_catalog.bool_and(
                      index_relation.relkind = 'i'
                      and index_relation.relpersistence = 'p'
                      and index_relation.relnamespace =
                            base_relation.relnamespace
                      and index_relation.reloptions is null
                      and index_relation.reltablespace = 0
                      and access_method.amname = $29::text
                      and primary_index.indisunique = $51::boolean
                      and primary_index.indisvalid = $52::boolean
                      and primary_index.indisready = $53::boolean
                      and primary_index.indislive = $54::boolean
                      and primary_index.indimmediate = $55::boolean
                      and not primary_index.indisexclusion
                      and not primary_index.indisclustered
                      and not primary_index.indisreplident
                      and coalesce(
                            (
                              pg_catalog.to_jsonb(primary_index)
                                ->> 'indnullsnotdistinct'
                            )::boolean,
                            false
                          ) = false
                      and (primary_index.indpred is not null) =
                            $56::boolean
                      and (primary_index.indexprs is not null) =
                            $57::boolean
                      and primary_index.indrelid = primary_key.conrelid
                      and primary_index.indexrelid = primary_key.conindid
                      and primary_index.indnkeyatts =
                            pg_catalog.cardinality($50::text[])
                      and primary_index.indnatts =
                            pg_catalog.cardinality($50::text[])
                      and (
                        select pg_catalog.array_agg(
                                 attribute.attname::text
                                 order by indexed.position
                               )
                          from pg_catalog.unnest(
                                 primary_index.indkey::smallint[]
                               ) with ordinality indexed(attnum, position)
                          join pg_catalog.pg_attribute attribute
                            on attribute.attrelid = primary_index.indrelid
                           and attribute.attnum = indexed.attnum
                         where indexed.position <=
                               primary_index.indnkeyatts
                      ) is not distinct from $50::text[]
                      and (
                        select pg_catalog.count(*) =
                                 pg_catalog.cardinality($50::text[])
                               and pg_catalog.bool_and(
                                 opclass_namespace.nspname = 'pg_catalog'
                                 and opclass.opcname = 'text_ops'
                               )
                          from pg_catalog.unnest(
                                 primary_index.indclass::oid[]
                               ) with ordinality indexed(opclass_oid, position)
                          join pg_catalog.pg_opclass opclass
                            on opclass.oid = indexed.opclass_oid
                          join pg_catalog.pg_namespace opclass_namespace
                            on opclass_namespace.oid =
                                 opclass.opcnamespace
                      )
                      and (
                        select pg_catalog.count(*) =
                                 pg_catalog.cardinality($50::text[])
                               and pg_catalog.bool_and(
                                 indexed.collation_oid =
                                   attribute.attcollation
                               )
                          from pg_catalog.unnest(
                                 primary_index.indcollation::oid[]
                               ) with ordinality
                                 indexed(collation_oid, position)
                          join pg_catalog.unnest(
                                 primary_index.indkey::smallint[]
                               ) with ordinality keyed(attnum, position)
                            using (position)
                          join pg_catalog.pg_attribute attribute
                            on attribute.attrelid = primary_index.indrelid
                           and attribute.attnum = keyed.attnum
                      )
                      and (
                        select pg_catalog.count(*) =
                                 pg_catalog.cardinality($50::text[])
                               and pg_catalog.bool_and(
                                 indexed.option_value = 0
                               )
                          from pg_catalog.unnest(
                                 primary_index.indoption::smallint[]
                               ) indexed(option_value)
                      )
                    )
               from pg_catalog.pg_constraint primary_key
               join pg_catalog.pg_index primary_index
                 on primary_index.indexrelid = primary_key.conindid
               join pg_catalog.pg_class base_relation
                 on base_relation.oid = primary_key.conrelid
               join pg_catalog.pg_class index_relation
                 on index_relation.oid = primary_index.indexrelid
               join pg_catalog.pg_am access_method
                 on access_method.oid = index_relation.relam
              where primary_key.conrelid =
                      pg_catalog.to_regclass($39::text)
                and primary_key.conname = $44::text
           ) authority_primary_index_catalog_exact,
           (
             select pg_catalog.count(*) = 1
                    and pg_catalog.bool_and(
                      index_relation.relkind = 'i'
                      and index_relation.relpersistence = 'p'
                      and index_relation.relnamespace =
                            base_relation.relnamespace
                      and index_relation.reloptions is null
                      and index_relation.reltablespace = 0
                      and access_method.amname = $29::text
                      and parent_index.indisunique = $8::boolean
                      and parent_index.indisvalid = $9::boolean
                      and parent_index.indisready = $10::boolean
                      and parent_index.indislive
                      and parent_index.indimmediate
                      and not parent_index.indisexclusion
                      and not parent_index.indisclustered
                      and not parent_index.indisreplident
                      and coalesce(
                            (
                              pg_catalog.to_jsonb(parent_index)
                                ->> 'indnullsnotdistinct'
                            )::boolean,
                            false
                          ) = false
                      and (parent_index.indpred is not null) =
                            $11::boolean
                      and (parent_index.indexprs is not null) =
                            $12::boolean
                      and parent_index.indrelid =
                            unique_constraint.conrelid
                      and parent_index.indexrelid =
                            unique_constraint.conindid
                      and parent_index.indnkeyatts =
                            pg_catalog.cardinality($7::text[])
                      and parent_index.indnatts =
                            pg_catalog.cardinality($7::text[])
                      and (
                        select pg_catalog.array_agg(
                                 attribute.attname::text
                                 order by indexed.position
                               )
                          from pg_catalog.unnest(
                                 parent_index.indkey::smallint[]
                               ) with ordinality indexed(attnum, position)
                          join pg_catalog.pg_attribute attribute
                            on attribute.attrelid = parent_index.indrelid
                           and attribute.attnum = indexed.attnum
                         where indexed.position <=
                               parent_index.indnkeyatts
                      ) is not distinct from $7::text[]
                      and (
                        select pg_catalog.count(*) =
                                 pg_catalog.cardinality($7::text[])
                               and pg_catalog.bool_and(
                                 opclass_namespace.nspname = 'pg_catalog'
                                 and opclass.opcname = 'text_ops'
                               )
                          from pg_catalog.unnest(
                                 parent_index.indclass::oid[]
                               ) with ordinality indexed(opclass_oid, position)
                          join pg_catalog.pg_opclass opclass
                            on opclass.oid = indexed.opclass_oid
                          join pg_catalog.pg_namespace opclass_namespace
                            on opclass_namespace.oid =
                                 opclass.opcnamespace
                      )
                      and (
                        select pg_catalog.count(*) =
                                 pg_catalog.cardinality($7::text[])
                               and pg_catalog.bool_and(
                                 indexed.collation_oid =
                                   attribute.attcollation
                               )
                          from pg_catalog.unnest(
                                 parent_index.indcollation::oid[]
                               ) with ordinality
                                 indexed(collation_oid, position)
                          join pg_catalog.unnest(
                                 parent_index.indkey::smallint[]
                               ) with ordinality keyed(attnum, position)
                            using (position)
                          join pg_catalog.pg_attribute attribute
                            on attribute.attrelid = parent_index.indrelid
                           and attribute.attnum = keyed.attnum
                      )
                      and (
                        select pg_catalog.count(*) =
                                 pg_catalog.cardinality($7::text[])
                               and pg_catalog.bool_and(
                                 indexed.option_value = 0
                               )
                          from pg_catalog.unnest(
                                 parent_index.indoption::smallint[]
                               ) indexed(option_value)
                      )
                    )
               from pg_catalog.pg_constraint unique_constraint
               join pg_catalog.pg_index parent_index
                 on parent_index.indexrelid =
                      unique_constraint.conindid
               join pg_catalog.pg_class base_relation
                 on base_relation.oid = unique_constraint.conrelid
               join pg_catalog.pg_class index_relation
                 on index_relation.oid = parent_index.indexrelid
               join pg_catalog.pg_am access_method
                 on access_method.oid = index_relation.relam
              where unique_constraint.conrelid =
                      pg_catalog.to_regclass($1::text)
                and unique_constraint.conname = $2::text
           ) authority_composite_index_catalog_exact,
           (
             select pg_catalog.count(*) = 1
                    and pg_catalog.bool_and(
                      index_relation.relkind = 'i'
                      and index_relation.relpersistence = 'p'
                      and index_relation.relnamespace =
                            base_relation.relnamespace
                      and index_relation.reloptions is null
                      and index_relation.reltablespace = 0
                      and access_method.amname = $29::text
                      and lookup_index.indisunique = $30::boolean
                      and lookup_index.indisvalid = $31::boolean
                      and lookup_index.indisready = $32::boolean
                      and lookup_index.indislive = $33::boolean
                      and lookup_index.indimmediate = $34::boolean
                      and not lookup_index.indisexclusion
                      and not lookup_index.indisclustered
                      and not lookup_index.indisreplident
                      and coalesce(
                            (
                              pg_catalog.to_jsonb(lookup_index)
                                ->> 'indnullsnotdistinct'
                            )::boolean,
                            false
                          ) = false
                      and (lookup_index.indpred is not null) =
                            $35::boolean
                      and (lookup_index.indexprs is not null) =
                            $36::boolean
                      and lookup_index.indrelid = base_relation.oid
                      and lookup_index.indexrelid = index_relation.oid
                      and lookup_index.indnkeyatts =
                            pg_catalog.cardinality($37::text[])
                      and lookup_index.indnatts =
                            pg_catalog.cardinality($37::text[])
                      and (
                        select pg_catalog.array_agg(
                                 attribute.attname::text
                                 order by indexed.position
                               )
                          from pg_catalog.unnest(
                                 lookup_index.indkey::smallint[]
                               ) with ordinality indexed(attnum, position)
                          join pg_catalog.pg_attribute attribute
                            on attribute.attrelid = lookup_index.indrelid
                           and attribute.attnum = indexed.attnum
                         where indexed.position <=
                               lookup_index.indnkeyatts
                      ) is not distinct from $37::text[]
                      and (
                        select pg_catalog.array_agg(
                                 opclass_namespace.nspname
                                   || '.' || opclass.opcname
                                 order by indexed.position
                               )
                          from pg_catalog.unnest(
                                 lookup_index.indclass::oid[]
                               ) with ordinality indexed(opclass_oid, position)
                          join pg_catalog.pg_opclass opclass
                            on opclass.oid = indexed.opclass_oid
                          join pg_catalog.pg_namespace opclass_namespace
                            on opclass_namespace.oid =
                                 opclass.opcnamespace
                      ) is not distinct from ARRAY[
                        'pg_catalog.text_ops',
                        'pg_catalog.uuid_ops'
                      ]::text[]
                      and (
                        select pg_catalog.count(*) =
                                 pg_catalog.cardinality($37::text[])
                               and pg_catalog.bool_and(
                                 indexed.collation_oid =
                                   attribute.attcollation
                               )
                          from pg_catalog.unnest(
                                 lookup_index.indcollation::oid[]
                               ) with ordinality
                                 indexed(collation_oid, position)
                          join pg_catalog.unnest(
                                 lookup_index.indkey::smallint[]
                               ) with ordinality keyed(attnum, position)
                            using (position)
                          join pg_catalog.pg_attribute attribute
                            on attribute.attrelid = lookup_index.indrelid
                           and attribute.attnum = keyed.attnum
                      )
                      and (
                        select pg_catalog.count(*) =
                                 pg_catalog.cardinality($37::text[])
                               and pg_catalog.bool_and(
                                 indexed.option_value = 0
                               )
                          from pg_catalog.unnest(
                                 lookup_index.indoption::smallint[]
                               ) indexed(option_value)
                      )
                      and pg_catalog.regexp_replace(
                            pg_catalog.lower(
                              pg_catalog.pg_get_expr(
                                lookup_index.indpred,
                                lookup_index.indrelid
                              )
                            ),
                            '[[:space:]()]',
                            '',
                            'g'
                          ) = $38::text
                      and not exists (
                        select 1
                          from pg_catalog.pg_constraint linked_constraint
                         where linked_constraint.conindid =
                                 lookup_index.indexrelid
                      )
                    )
               from pg_catalog.pg_class base_relation
               join pg_catalog.pg_index lookup_index
                 on lookup_index.indrelid = base_relation.oid
               join pg_catalog.pg_class index_relation
                 on index_relation.oid = lookup_index.indexrelid
               join pg_catalog.pg_am access_method
                 on access_method.oid = index_relation.relam
              where base_relation.oid =
                      pg_catalog.to_regclass($27::text)
                and index_relation.relname = $28::text
           ) outbox_replay_lookup_index_catalog_exact,
           pg_catalog.bool_and(
             pg_catalog.pg_get_userbyid(target.relowner) = $40::text
           ) authority_owner_exact,
           (
             select pg_catalog.count(*) = pg_catalog.cardinality($41::text[])
                    and pg_catalog.count(*) filter (
                      where attribute.attname = any($41::text[])
                        and attribute.attnum =
                              pg_catalog.array_position(
                                $41::text[], attribute.attname::text
                              )
                        and attribute.atttypid = pg_catalog.to_regtype(
                              ($42::text[])[
                                pg_catalog.array_position(
                                  $41::text[], attribute.attname::text
                                )
                              ]
                            )::oid
                        and attribute.atttypmod = -1
                        and attribute.attnotnull = ($43::boolean[])[
                              pg_catalog.array_position(
                                $41::text[], attribute.attname::text
                              )
                            ]
                        and not attribute.atthasdef
                        and attribute.attgenerated = ''
                        and attribute.attidentity = ''
                        and not attribute.attisdropped
                    ) = pg_catalog.cardinality($41::text[])
               from target
               join pg_catalog.pg_attribute attribute
                 on attribute.attrelid = target.oid
                and attribute.attnum > 0
                and not attribute.attisdropped
           ) authority_columns_exact,
           (
             select pg_catalog.count(*) = 1
                    and pg_catalog.bool_and(
                      primary_key.contype::text = $45::text
                      and primary_key.convalidated = $46::boolean
                      and primary_key.condeferrable = $47::boolean
                      and primary_key.condeferred = $48::boolean
                      and primary_key.connoinherit = $49::boolean
                      and (
                        select pg_catalog.array_agg(
                                 attribute.attname::text
                                 order by constrained.position
                               )
                          from pg_catalog.unnest(primary_key.conkey)
                               with ordinality constrained(attnum, position)
                          join pg_catalog.pg_attribute attribute
                            on attribute.attrelid = primary_key.conrelid
                           and attribute.attnum = constrained.attnum
                      ) is not distinct from $50::text[]
                      and primary_index.indisunique = $51::boolean
                      and primary_index.indisvalid = $52::boolean
                      and primary_index.indisready = $53::boolean
                      and primary_index.indislive = $54::boolean
                      and primary_index.indimmediate = $55::boolean
                      and (primary_index.indpred is not null) = $56::boolean
                      and (primary_index.indexprs is not null) = $57::boolean
                      and primary_index.indrelid = primary_key.conrelid
                      and primary_index.indexrelid = primary_key.conindid
                      and primary_index.indnkeyatts =
                            pg_catalog.cardinality($50::text[])
                      and primary_index.indnatts =
                            pg_catalog.cardinality($50::text[])
                    )
               from pg_catalog.pg_constraint primary_key
               join pg_catalog.pg_index primary_index
                 on primary_index.indexrelid = primary_key.conindid
              where primary_key.conrelid = pg_catalog.to_regclass($39::text)
                and primary_key.conname = $44::text
           ) authority_primary_key_exact,
           (
             select (
                      select pg_catalog.count(*)
                        from pg_catalog.pg_constraint authority_check
                       where authority_check.conrelid =
                               pg_catalog.to_regclass($39::text)
                         and authority_check.contype = 'c'
                    ) = pg_catalog.jsonb_array_length($58::jsonb)
                    and not exists (
                      select 1
                        from pg_catalog.jsonb_to_recordset($58::jsonb)
                             expected(
                               name text,
                               type text,
                               validated boolean,
                               no_inherit boolean,
                               columns jsonb,
                               normalized_expression_sha256 text
                             )
                       where not exists (
                         select 1
                           from pg_catalog.pg_constraint authority_check
                          where authority_check.conrelid =
                                  pg_catalog.to_regclass($39::text)
                            and authority_check.conname = expected.name
                            and authority_check.contype::text = expected.type
                            and authority_check.convalidated = expected.validated
                            and authority_check.connoinherit = expected.no_inherit
                            and (
                              select pg_catalog.array_agg(
                                       attribute.attname::text
                                       order by attribute.attname
                                     )
                                from pg_catalog.unnest(authority_check.conkey)
                                     constrained(attnum)
                                join pg_catalog.pg_attribute attribute
                                  on attribute.attrelid =
                                       authority_check.conrelid
                                 and attribute.attnum = constrained.attnum
                            ) is not distinct from ARRAY(
                              select pg_catalog.jsonb_array_elements_text(
                                       expected.columns
                                     )
                            )
                            and pg_catalog.encode(
                                  pg_catalog.sha256(
                                    pg_catalog.convert_to(
                                      pg_catalog.regexp_replace(
                                        pg_catalog.regexp_replace(
                                          pg_catalog.pg_get_expr(
                                            authority_check.conbin,
                                            authority_check.conrelid,
                                            true
                                          ),
                                          '"?email_outbox_idempotency_authority"?[.]',
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
                                ) = expected.normalized_expression_sha256
                       )
                    )
           ) authority_checks_exact,
           (
             select pg_catalog.count(*) = 1
                    and pg_catalog.bool_and(
                      delivery_scope.contype::text = $61::text
                      and delivery_scope.convalidated = $62::boolean
                      and delivery_scope.connoinherit = $63::boolean
                      and (
                        select pg_catalog.array_agg(
                                 attribute.attname::text
                                 order by attribute.attname
                               )
                          from pg_catalog.unnest(delivery_scope.conkey)
                               constrained(attnum)
                          join pg_catalog.pg_attribute attribute
                            on attribute.attrelid = delivery_scope.conrelid
                           and attribute.attnum = constrained.attnum
                      ) is not distinct from $64::text[]
                      and pg_catalog.encode(
                            pg_catalog.sha256(
                              pg_catalog.convert_to(
                                pg_catalog.regexp_replace(
                                  pg_catalog.regexp_replace(
                                    pg_catalog.pg_get_expr(
                                      delivery_scope.conbin,
                                      delivery_scope.conrelid,
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
                          ) = $65::text
                    )
               from pg_catalog.pg_constraint delivery_scope
              where delivery_scope.conrelid =
                      pg_catalog.to_regclass($59::text)
                and delivery_scope.conname = $60::text
           ) outbox_delivery_scope_exact,
           not exists (
             (
               select namespace.nspname || '.' || relation.relname,
                      trigger.tgname
                 from pg_catalog.pg_trigger trigger
                 join pg_catalog.pg_class relation
                   on relation.oid = trigger.tgrelid
                 join pg_catalog.pg_namespace namespace
                   on namespace.oid = relation.relnamespace
                where not trigger.tgisinternal
                  and trigger.tgrelid = any(
                    select pg_catalog.to_regclass(reviewed_relation)::oid
                      from pg_catalog.unnest($66::text[])
                           reviewed(reviewed_relation)
                  )
               except all
               select expected.relation, expected.name
                 from pg_catalog.jsonb_to_recordset($67::jsonb)
                      expected(relation text, name text)
             )
             union all
             (
               select expected.relation, expected.name
                 from pg_catalog.jsonb_to_recordset($67::jsonb)
                      expected(relation text, name text)
               except all
               select namespace.nspname || '.' || relation.relname,
                      trigger.tgname
                 from pg_catalog.pg_trigger trigger
                 join pg_catalog.pg_class relation
                   on relation.oid = trigger.tgrelid
                 join pg_catalog.pg_namespace namespace
                   on namespace.oid = relation.relnamespace
                where not trigger.tgisinternal
                  and trigger.tgrelid = any(
                    select pg_catalog.to_regclass(reviewed_relation)::oid
                      from pg_catalog.unnest($66::text[])
                           reviewed(reviewed_relation)
                  )
             )
           ) reviewed_trigger_set_exact,
           (
             not exists (
               select 1
                 from pg_catalog.unnest($69::text[]) expected(signature)
                where pg_catalog.to_regprocedure(expected.signature) is null
             )
             and (
               select pg_catalog.count(*)
                 from pg_catalog.pg_proc routine
                 join pg_catalog.pg_namespace namespace
                   on namespace.oid = routine.pronamespace
                where namespace.nspname = 'public'
                  and routine.proname = any($68::text[])
             ) = pg_catalog.cardinality($69::text[])
             and not exists (
               select 1
                 from pg_catalog.pg_proc routine
                 join pg_catalog.pg_namespace namespace
                   on namespace.oid = routine.pronamespace
                where namespace.nspname = 'public'
                  and routine.proname = any($68::text[])
                  and routine.oid <> all(
                    ARRAY(
                      select pg_catalog.to_regprocedure(
                               expected.signature
                             )::oid
                        from pg_catalog.unnest($69::text[])
                             expected(signature)
                    )
                  )
             )
           ) reviewed_routine_overloads_exact,
           not exists (
             (select * from observed_acl except all select * from expected_acl)
             union all
             (select * from expected_acl except all select * from observed_acl)
           ) authority_direct_acl_exact,
           not exists (
             select 1
               from target
               cross join pg_catalog.unnest(ARRAY[
                 'learncoding_migrator',
                 'learncoding_app',
                 'learncoding_worker',
                 'learncoding_ops',
                 'learncoding_backup_reporter'
               ]::text[]) restricted(role_name)
              where pg_catalog.has_table_privilege(
                      restricted.role_name,
                      target.oid,
                      'SELECT'
                    )
                 or pg_catalog.has_table_privilege(
                      restricted.role_name,
                      target.oid,
                      'INSERT'
                    )
                 or pg_catalog.has_table_privilege(
                      restricted.role_name,
                      target.oid,
                      'UPDATE'
                    )
                 or pg_catalog.has_table_privilege(
                      restricted.role_name,
                      target.oid,
                      'DELETE'
                    )
                 or pg_catalog.has_table_privilege(
                      restricted.role_name,
                      target.oid,
                      'TRUNCATE'
                    )
                 or pg_catalog.has_table_privilege(
                      restricted.role_name,
                      target.oid,
                      'REFERENCES'
                    )
                 or pg_catalog.has_table_privilege(
                      restricted.role_name,
                      target.oid,
                      'TRIGGER'
                    )
                 or pg_catalog.has_table_privilege(
                      restricted.role_name,
                      target.oid,
                      'MAINTAIN'
                    )
           ) authority_effective_acl_exact,
           not exists (
             select 1
               from target
               join pg_catalog.pg_attribute attribute
                 on attribute.attrelid = target.oid
                and attribute.attnum > 0
               cross join lateral pg_catalog.aclexplode(attribute.attacl) access
           ) authority_column_acl_exact,
           (
             select pg_catalog.count(*) = 1
                    and pg_catalog.bool_and(
                      index_relation.relkind = 'i'
                      and index_relation.relpersistence = 'p'
                      and index_relation.relnamespace = outbox_relation.relnamespace
                      and access_method.amname = $29::text
                      and lookup_index.indisunique = $30::boolean
                      and lookup_index.indisvalid = $31::boolean
                      and lookup_index.indisready = $32::boolean
                      and lookup_index.indislive = $33::boolean
                      and lookup_index.indimmediate = $34::boolean
                      and (lookup_index.indpred is not null) = $35::boolean
                      and (lookup_index.indexprs is not null) = $36::boolean
                      and lookup_index.indnkeyatts =
                            pg_catalog.cardinality($37::text[])
                      and lookup_index.indnatts =
                            pg_catalog.cardinality($37::text[])
                      and (
                        select pg_catalog.array_agg(
                                 attribute.attname::text
                                 order by indexed.position
                               )
                          from pg_catalog.unnest(
                                 lookup_index.indkey::smallint[]
                               ) with ordinality indexed(attnum, position)
                          join pg_catalog.pg_attribute attribute
                            on attribute.attrelid = lookup_index.indrelid
                           and attribute.attnum = indexed.attnum
                         where indexed.position <= lookup_index.indnkeyatts
                      ) is not distinct from $37::text[]
                      and pg_catalog.regexp_replace(
                            pg_catalog.lower(
                              pg_catalog.pg_get_expr(
                                lookup_index.indpred,
                                lookup_index.indrelid
                              )
                            ),
                            '[[:space:]()]',
                            '',
                            'g'
                          ) = $38::text
                    )
               from pg_catalog.pg_index lookup_index
               join pg_catalog.pg_class outbox_relation
                 on outbox_relation.oid = lookup_index.indrelid
               join pg_catalog.pg_class index_relation
                 on index_relation.oid = lookup_index.indexrelid
               join pg_catalog.pg_am access_method
                 on access_method.oid = index_relation.relam
              where lookup_index.indrelid = pg_catalog.to_regclass($27::text)
                and index_relation.relname = $28::text
           ) outbox_replay_lookup_index_exact,
           (
             select pg_catalog.count(*) = 1
                    and pg_catalog.bool_and(
                      unique_constraint.contype::text = $3::text
                      and unique_constraint.convalidated = $4::boolean
                      and unique_constraint.condeferrable = $5::boolean
                      and unique_constraint.condeferred = $6::boolean
                      and unique_constraint.connoinherit = $25::boolean
                      and (
                        select pg_catalog.array_agg(
                                 attribute.attname::text
                                 order by constrained.position
                               )
                          from pg_catalog.unnest(unique_constraint.conkey)
                               with ordinality constrained(attnum, position)
                          join pg_catalog.pg_attribute attribute
                            on attribute.attrelid = unique_constraint.conrelid
                           and attribute.attnum = constrained.attnum
                      ) is not distinct from $7::text[]
                      and parent_index.indisunique = $8::boolean
                      and parent_index.indisvalid = $9::boolean
                      and parent_index.indisready = $10::boolean
                      and (parent_index.indpred is not null) = $11::boolean
                      and (parent_index.indexprs is not null) = $12::boolean
                      and parent_index.indrelid = unique_constraint.conrelid
                      and parent_index.indexrelid = unique_constraint.conindid
                      and parent_index.indnkeyatts =
                            pg_catalog.array_length(unique_constraint.conkey, 1)
                      and parent_index.indnatts =
                            pg_catalog.array_length(unique_constraint.conkey, 1)
                    )
               from pg_catalog.pg_constraint unique_constraint
               join pg_catalog.pg_index parent_index
                 on parent_index.indexrelid = unique_constraint.conindid
              where unique_constraint.conrelid =
                      pg_catalog.to_regclass($1::text)
                and unique_constraint.conname = $2::text
           ) authority_composite_unique_exact,
           (
             select pg_catalog.count(*) = 1
                    and pg_catalog.bool_and(
                      foreign_key.contype::text = $15::text
                      and foreign_key.convalidated = $16::boolean
                      and foreign_key.condeferrable = $20::boolean
                      and foreign_key.condeferred = $21::boolean
                      and foreign_key.connoinherit = $26::boolean
                      and foreign_key.conparentid = 0
                      and foreign_key.confrelid =
                            pg_catalog.to_regclass($18::text)
                      and foreign_key.confmatchtype::text = $22::text
                      and foreign_key.confupdtype::text = $23::text
                      and foreign_key.confdeltype::text = $24::text
                      and (
                        select pg_catalog.array_agg(
                                 attribute.attname::text
                                 order by constrained.position
                               )
                          from pg_catalog.unnest(foreign_key.conkey)
                               with ordinality constrained(attnum, position)
                          join pg_catalog.pg_attribute attribute
                            on attribute.attrelid = foreign_key.conrelid
                           and attribute.attnum = constrained.attnum
                      ) is not distinct from $17::text[]
                      and (
                        select pg_catalog.array_agg(
                                 attribute.attname::text
                                 order by referenced.position
                               )
                          from pg_catalog.unnest(foreign_key.confkey)
                               with ordinality referenced(attnum, position)
                          join pg_catalog.pg_attribute attribute
                            on attribute.attrelid = foreign_key.confrelid
                           and attribute.attnum = referenced.attnum
                      ) is not distinct from $19::text[]
                      and foreign_key.conindid = unique_constraint.conindid
                    )
               from pg_catalog.pg_constraint foreign_key
               join pg_catalog.pg_constraint unique_constraint
                 on unique_constraint.conrelid = foreign_key.confrelid
                and unique_constraint.conindid = foreign_key.conindid
                and unique_constraint.conname = $2::text
                and unique_constraint.contype::text = $3::text
              where foreign_key.conrelid = pg_catalog.to_regclass($13::text)
                and foreign_key.conname = $14::text
           ) outbox_authority_foreign_key_exact,
           (
             select pg_catalog.count(*) = 1
                    and pg_catalog.bool_and(
                      not reviewed_persist_trigger.tgisinternal
                      and reviewed_persist_trigger.tgconstraint = 0
                      and reviewed_persist_trigger.tgconstrrelid = 0
                      and reviewed_persist_trigger.tgrelid =
                            reviewed_foreign_key.conrelid
                      and reviewed_persist_trigger.tgtype = 5
                      and reviewed_persist_trigger.tgenabled = 'A'
                      and reviewed_persist_trigger.tgfoid =
                            pg_catalog.to_regprocedure(
                              'public.persist_email_outbox_idempotency_authority()'
                            )
                      and reviewed_fk_trigger.tgisinternal
                      and reviewed_fk_trigger.tgconstraint =
                            reviewed_foreign_key.oid
                      and reviewed_fk_trigger.tgrelid =
                            reviewed_foreign_key.conrelid
                      and reviewed_fk_trigger.tgconstrrelid =
                            reviewed_foreign_key.confrelid
                      and reviewed_fk_trigger.tgtype = 5
                      and reviewed_fk_trigger.tgenabled in ('O', 'A')
                      and reviewed_fk_trigger.tgdeferrable =
                            reviewed_foreign_key.condeferrable
                      and reviewed_fk_trigger.tginitdeferred =
                            reviewed_foreign_key.condeferred
                      and reviewed_fk_trigger.tgfoid =
                            pg_catalog.to_regprocedure(
                              'pg_catalog."RI_FKey_check_ins"()'
                            )
                      and pg_catalog.convert_to(
                            reviewed_persist_trigger.tgname::text,
                            'UTF8'
                          ) < pg_catalog.convert_to(
                            reviewed_fk_trigger.tgname::text,
                            'UTF8'
                          )
                    )
               from pg_catalog.pg_constraint reviewed_foreign_key
               join pg_catalog.pg_trigger reviewed_fk_trigger
                 on reviewed_fk_trigger.tgconstraint =
                      reviewed_foreign_key.oid
                and reviewed_fk_trigger.tgrelid =
                      reviewed_foreign_key.conrelid
                and reviewed_fk_trigger.tgisinternal
                and reviewed_fk_trigger.tgtype = 5
                and reviewed_fk_trigger.tgfoid =
                      pg_catalog.to_regprocedure(
                        'pg_catalog."RI_FKey_check_ins"()'
                      )
               join pg_catalog.pg_trigger reviewed_persist_trigger
                 on reviewed_persist_trigger.tgrelid =
                      reviewed_foreign_key.conrelid
                and reviewed_persist_trigger.tgname = $70::name
              where reviewed_foreign_key.conrelid =
                      pg_catalog.to_regclass($13::text)
                and reviewed_foreign_key.conname = $14::text
                and reviewed_foreign_key.contype::text = $15::text
           ) outbox_authority_trigger_order_exact
      from target`,
    [
      unique.relation,
      unique.name,
      unique.type,
      unique.validated,
      unique.deferrable,
      unique.initiallyDeferred,
      unique.columns,
      unique.index.unique,
      unique.index.valid,
      unique.index.ready,
      unique.index.partial,
      unique.index.expression,
      foreignKey.relation,
      foreignKey.name,
      foreignKey.type,
      foreignKey.validated,
      foreignKey.columns,
      foreignKey.referencedRelation,
      foreignKey.referencedColumns,
      foreignKey.deferrable,
      foreignKey.initiallyDeferred,
      foreignKey.matchType,
      foreignKey.updateAction,
      foreignKey.deleteAction,
      unique.noInherit,
      foreignKey.noInherit,
      lookupIndex.relation,
      lookupIndex.name,
      lookupIndex.accessMethod,
      lookupIndex.unique,
      lookupIndex.valid,
      lookupIndex.ready,
      lookupIndex.live,
      lookupIndex.immediate,
      lookupIndex.partial,
      lookupIndex.expression,
      lookupIndex.columns,
      lookupIndex.normalizedPredicate,
      authority.relation,
      authority.owner,
      authority.columns.map(({ name }) => name),
      authority.columns.map(({ type }) => type),
      authority.columns.map(({ notNull }) => notNull),
      authority.primaryKey.name,
      authority.primaryKey.type,
      authority.primaryKey.validated,
      authority.primaryKey.deferrable,
      authority.primaryKey.initiallyDeferred,
      authority.primaryKey.noInherit,
      authority.primaryKey.columns,
      authority.primaryKey.index.unique,
      authority.primaryKey.index.valid,
      authority.primaryKey.index.ready,
      authority.primaryKey.index.live,
      authority.primaryKey.index.immediate,
      authority.primaryKey.index.partial,
      authority.primaryKey.index.expression,
      JSON.stringify(
        authority.checks.map(
          ({ noInherit, normalizedExpressionSha256, ...check }) => ({
            ...check,
            no_inherit: noInherit,
            normalized_expression_sha256: normalizedExpressionSha256,
          }),
        ),
      ),
      deliveryScope.relation,
      deliveryScope.name,
      deliveryScope.type,
      deliveryScope.validated,
      deliveryScope.noInherit,
      deliveryScope.columns,
      deliveryScope.normalizedExpressionSha256,
      triggerRelations,
      JSON.stringify(
        triggers.map(({ relation, name }) => ({ relation, name })),
      ),
      routines.map(({ signature }) =>
        signature.slice(signature.indexOf(".") + 1, signature.indexOf("(")),
      ),
      routines.map(({ signature }) => signature),
      foreignKey.persistTriggerName,
      MAIL_WORKER_OUTBOX_INSERT_COLUMNS,
      MAIL_WORKER_OUTBOX_UPDATE_COLUMNS,
    ],
  );

  const expected = {
    authority_relation_exact: true,
    authority_relation_storage_exact: true,
    authority_relation_rls_exact: true,
    authority_constraint_set_exact: true,
    authority_index_set_exact: true,
    persistent_default_acl_exact: true,
    persistent_relation_grant_options_exact: true,
    persistent_column_acl_exact: true,
    authority_primary_index_catalog_exact: true,
    authority_composite_index_catalog_exact: true,
    outbox_replay_lookup_index_catalog_exact: true,
    authority_owner_exact: true,
    authority_columns_exact: true,
    authority_primary_key_exact: true,
    authority_checks_exact: true,
    outbox_delivery_scope_exact: true,
    reviewed_trigger_set_exact: true,
    reviewed_routine_overloads_exact: true,
    authority_direct_acl_exact: true,
    authority_effective_acl_exact: true,
    authority_column_acl_exact: true,
    outbox_replay_lookup_index_exact: true,
    authority_composite_unique_exact: true,
    outbox_authority_foreign_key_exact: true,
    outbox_authority_trigger_order_exact: true,
  };
  const row = result.rows[0];
  if (result.rows.length !== 1 || !exactRow(row, expected)) {
    const mismatches =
      result.rows.length === 1
        ? exactRowMismatchKeys(row, expected).join(",")
        : "missing-or-duplicate";
    fail(`mail-replay-authority-table-contract:${mismatches}`);
  }
  return 1;
}
export async function verifyMailWorkerOutboxContract(
  client,
  {
    requiresDispatchBinding = true,
    requiresProviderEvidence = false,
    requiresReplayAuthority = false,
  } = {},
) {
  if (
    typeof requiresDispatchBinding !== "boolean"
    || typeof requiresProviderEvidence !== "boolean"
    || typeof requiresReplayAuthority !== "boolean"
    || (requiresProviderEvidence && !requiresDispatchBinding)
    || (requiresReplayAuthority && !requiresProviderEvidence)
  ) fail();
  await establishTrustedCatalogSearchPath(client);
  if (REVIEWED_APPLICATION_CONSTRAINTS.length !== 5) fail();
  const variablesObjectConstraint = REVIEWED_APPLICATION_CONSTRAINTS.find(
    ({ name }) => name === "email_outbox_variables_object_valid",
  );
  const recipientCanonicalConstraint = REVIEWED_APPLICATION_CONSTRAINTS.find(
    ({ name }) => name === "email_outbox_recipient_canonical_valid",
  );
  const dispatchConstraint = REVIEWED_APPLICATION_CONSTRAINTS.find(
    ({ name }) => name === "email_outbox_dispatch_binding_valid",
  );
  const providerEvidenceConstraint = REVIEWED_APPLICATION_CONSTRAINTS.find(
    ({ name }) =>
      name === "email_outbox_provider_correlation_evidence_valid",
  );
  const replayAuthorityConstraint = REVIEWED_APPLICATION_CONSTRAINTS.find(
    ({ name }) => name === "email_outbox_idempotency_authority_valid",
  );
  if (
    !variablesObjectConstraint
    || !recipientCanonicalConstraint
    || !dispatchConstraint
    || !providerEvidenceConstraint
    || !replayAuthorityConstraint
    || variablesObjectConstraint.noInherit !== false
    || recipientCanonicalConstraint.noInherit !== false
    || !/^[0-9a-f]{64}$/u.test(
      variablesObjectConstraint.reviewedSqlExpressionSha256,
    )
    || !/^[0-9a-f]{64}$/u.test(
      variablesObjectConstraint.normalizedExpressionSha256,
    )
    || !/^[0-9a-f]{64}$/u.test(
      recipientCanonicalConstraint.reviewedSqlExpressionSha256,
    )
    || !/^[0-9a-f]{64}$/u.test(
      recipientCanonicalConstraint.normalizedExpressionSha256,
    )
    || !/^[0-9a-f]{64}$/u.test(
      providerEvidenceConstraint.normalizedExpressionSha256,
    )
    || !/^[0-9a-f]{64}$/u.test(
      replayAuthorityConstraint.normalizedExpressionSha256,
    )
  ) fail();
  const expectedInsertColumns = requiresReplayAuthority
    ? MAIL_WORKER_OUTBOX_INSERT_COLUMNS
    : MAIL_WORKER_OUTBOX_PRE_REPLAY_INSERT_COLUMNS;
  const expectedUpdateColumns = requiresProviderEvidence
    ? MAIL_WORKER_OUTBOX_UPDATE_COLUMNS
    : requiresDispatchBinding
      ? MAIL_WORKER_OUTBOX_PRE_EVIDENCE_UPDATE_COLUMNS
      : MAIL_WORKER_OUTBOX_PRE_BINDING_UPDATE_COLUMNS;
  const expectedBindingColumnCount = requiresDispatchBinding ? 2 : 0;
  const expectedProviderEvidenceColumnCount =
    requiresProviderEvidence ? 3 : 0;
  const expectedReplayAuthorityColumnCount = requiresReplayAuthority ? 3 : 0;
  const reviewed0067CheckConstraints = requiresReplayAuthority
    ? [variablesObjectConstraint, recipientCanonicalConstraint].map(
      (constraint) => ({
        relation_name: constraint.relation,
        relation_owner: constraint.relationOwner,
        constraint_name: constraint.name,
        constraint_type: constraint.type,
        validated: constraint.validated,
        no_inherit: constraint.noInherit,
        normalized_expression_sha256: constraint.normalizedExpressionSha256,
        columns: constraint.columns,
      }),
    )
    : [];
  const result = await client.query(
    `
    with target as (
      select c.oid, c.relowner
        from pg_catalog.pg_class c
       where c.oid = pg_catalog.to_regclass('public.email_outbox')
         and c.relkind in ('r', 'p')
    ), binding_columns as (
      select pg_catalog.count(*)::integer present_count,
             pg_catalog.count(*) filter (
               where attribute.atttypid =
                       'pg_catalog.text'::pg_catalog.regtype
                 and attribute.atttypmod = -1
                 and not attribute.attnotnull
                 and not attribute.atthasdef
                 and attribute.attgenerated = ''
                 and attribute.attidentity = ''
                 and not attribute.attisdropped
             )::integer exact_count
        from target
        join pg_catalog.pg_attribute attribute
          on attribute.attrelid = target.oid
         and attribute.attnum > 0
         and attribute.attname = any($3::text[])
    ), provider_evidence_columns as (
      select pg_catalog.count(*)::integer present_count,
             pg_catalog.count(*) filter (
               where attribute.atttypid =
                       'pg_catalog.text'::pg_catalog.regtype
                 and attribute.atttypmod = -1
                 and not attribute.attnotnull
                 and not attribute.atthasdef
                 and attribute.attgenerated = ''
                 and attribute.attidentity = ''
                 and not attribute.attisdropped
             )::integer exact_count
        from target
        join pg_catalog.pg_attribute attribute
          on attribute.attrelid = target.oid
         and attribute.attnum > 0
         and attribute.attname = any($13::text[])
    ), idempotency_authority_columns as (
      select pg_catalog.count(*)::integer present_count,
             pg_catalog.count(*) filter (
               where attribute.atttypid =
                       'pg_catalog.text'::pg_catalog.regtype
                 and attribute.atttypmod = -1
                 and (
                   (
                     attribute.attname = 'idempotency_authority_sha256'
                     and not attribute.attnotnull
                   )
                   or (
                     attribute.attname in (
                       'idempotency_authority_version',
                       'idempotency_original_payload_sha256'
                     )
                     and attribute.attnotnull
                   )
                 )
                 and not attribute.atthasdef
                 and attribute.attgenerated = ''
                 and attribute.attidentity = ''
                 and not attribute.attisdropped
             )::integer exact_count
        from target
        join pg_catalog.pg_attribute attribute
          on attribute.attrelid = target.oid
         and attribute.attnum > 0
         and attribute.attname = any($22::text[])
    ), expected_column_acl(attname, privilege_type) as (
      select column_name, 'INSERT'::text
        from pg_catalog.unnest($1::text[]) column_name
      union all
      select column_name, 'UPDATE'::text
        from pg_catalog.unnest($2::text[]) column_name
    ), reviewed_0067_check_constraints_expected as (
      select expected.relation_name,
             expected.relation_owner,
             expected.constraint_name,
             expected.constraint_type,
             expected.validated,
             expected.no_inherit,
             expected.normalized_expression_sha256,
             expected.columns
        from pg_catalog.jsonb_to_recordset($31::jsonb) expected(
          relation_name text,
          relation_owner text,
          constraint_name text,
          constraint_type text,
          validated boolean,
          no_inherit boolean,
          normalized_expression_sha256 text,
          columns jsonb
        )
    ), reviewed_0067_check_constraints_observed as (
      select namespace.nspname || '.' || relation.relname relation_name,
             pg_catalog.pg_get_userbyid(relation.relowner) relation_owner,
             constraint_row.conname constraint_name,
             constraint_row.contype::text constraint_type,
             constraint_row.convalidated validated,
             constraint_row.connoinherit no_inherit,
             pg_catalog.encode(
               pg_catalog.sha256(
                 pg_catalog.convert_to(
                   pg_catalog.regexp_replace(
                     pg_catalog.regexp_replace(
                       pg_catalog.pg_get_expr(
                         constraint_row.conbin,
                         constraint_row.conrelid,
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
             ) normalized_expression_sha256,
             pg_catalog.to_jsonb(
               coalesce(
                 (
                   select pg_catalog.array_agg(
                            attribute.attname::text order by attribute.attname
                          )
                     from pg_catalog.unnest(constraint_row.conkey)
                          constrained(attnum)
                     join pg_catalog.pg_attribute attribute
                       on attribute.attrelid = constraint_row.conrelid
                      and attribute.attnum = constrained.attnum
                 ),
                 '{}'::text[]
               )
             ) columns
        from pg_catalog.pg_constraint constraint_row
        join pg_catalog.pg_class relation
          on relation.oid = constraint_row.conrelid
        join pg_catalog.pg_namespace namespace
          on namespace.oid = relation.relnamespace
       where constraint_row.conrelid =
               pg_catalog.to_regclass('public.email_outbox')
         and constraint_row.conname in (
           'email_outbox_variables_object_valid',
           'email_outbox_recipient_canonical_valid'
         )
    )
    select
      (select pg_catalog.count(*) = 1 from target) outbox_present_exact,
      (
        select pg_catalog.count(*) = 1
               and pg_catalog.bool_and(
                 pg_catalog.pg_get_userbyid(target.relowner) = $10::text
               )
          from target
      ) outbox_owner_exact,
      (
        select present_count = $11::integer
               and exact_count = $11::integer
          from binding_columns
      ) binding_columns_exact,
      (
        select present_count = $14::integer
               and exact_count = $14::integer
          from provider_evidence_columns
      ) provider_evidence_columns_exact,
      (
        select present_count = $23::integer
               and exact_count = $23::integer
          from idempotency_authority_columns
      ) idempotency_authority_columns_exact,
      (
        select not exists (
          (
            select * from reviewed_0067_check_constraints_observed
            except all
            select * from reviewed_0067_check_constraints_expected
          )
          union all
          (
            select * from reviewed_0067_check_constraints_expected
            except all
            select * from reviewed_0067_check_constraints_observed
          )
        )
      ) reviewed_0067_check_constraints_exact,
      (
        select case when $12::boolean then pg_catalog.count(*) = 1
               and pg_catalog.bool_and(
                 constraint_row.contype::text
                   is not distinct from $6::text
                 and constraint_row.convalidated
                   is not distinct from $7::boolean
                 and not constraint_row.connoinherit
                 and pg_catalog.regexp_replace(
                       pg_catalog.regexp_replace(
                         pg_catalog.pg_get_expr(
                           constraint_row.conbin,
                           constraint_row.conrelid,
                           true
                         ),
                         '"?email_outbox"?[.]', '', 'g'
                       ),
                       '[[:space:]"]', '', 'g'
                     ) is not distinct from $8::text
                 and (
                   select pg_catalog.array_agg(
                            attribute.attname::text order by attribute.attname
                          )
                     from pg_catalog.unnest(constraint_row.conkey)
                          constrained(attnum)
                     join pg_catalog.pg_attribute attribute
                       on attribute.attrelid = constraint_row.conrelid
                      and attribute.attnum = constrained.attnum
                 ) is not distinct from $9::text[]
               )
               else pg_catalog.count(*) = 0
               end
          from pg_catalog.pg_constraint constraint_row
         where constraint_row.conrelid =
                 pg_catalog.to_regclass($4::text)
           and constraint_row.conname =
                 $5::text
      ) dispatch_constraint_exact,
      (
        select case when $21::boolean then pg_catalog.count(*) = 1
               and pg_catalog.bool_and(
                 constraint_row.contype::text
                   is not distinct from $17::text
                 and constraint_row.convalidated
                   is not distinct from $18::boolean
                 and not constraint_row.connoinherit
                 and pg_catalog.encode(
                       pg_catalog.sha256(
                         pg_catalog.convert_to(
                           pg_catalog.regexp_replace(
                             pg_catalog.regexp_replace(
                               pg_catalog.pg_get_expr(
                                 constraint_row.conbin,
                                 constraint_row.conrelid,
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
                     ) is not distinct from $19::text
                 and (
                   select pg_catalog.array_agg(
                            attribute.attname::text order by attribute.attname
                          )
                     from pg_catalog.unnest(constraint_row.conkey)
                          constrained(attnum)
                     join pg_catalog.pg_attribute attribute
                       on attribute.attrelid = constraint_row.conrelid
                      and attribute.attnum = constrained.attnum
                 ) is not distinct from $20::text[]
               )
               else pg_catalog.count(*) = 0
               end
          from pg_catalog.pg_constraint constraint_row
         where constraint_row.conrelid =
                 pg_catalog.to_regclass($15::text)
           and constraint_row.conname =
                 $16::text
      ) provider_evidence_constraint_exact,
      (
        select case when $30::boolean then pg_catalog.count(*) = 1
               and pg_catalog.bool_and(
                 constraint_row.contype::text
                   is not distinct from $26::text
                 and constraint_row.convalidated
                   is not distinct from $27::boolean
                 and not constraint_row.connoinherit
                 and pg_catalog.encode(
                       pg_catalog.sha256(
                         pg_catalog.convert_to(
                           pg_catalog.regexp_replace(
                             pg_catalog.regexp_replace(
                               pg_catalog.pg_get_expr(
                                 constraint_row.conbin,
                                 constraint_row.conrelid,
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
                     ) is not distinct from $28::text
                 and (
                   select pg_catalog.array_agg(
                            attribute.attname::text order by attribute.attname
                          )
                     from pg_catalog.unnest(constraint_row.conkey)
                          constrained(attnum)
                     join pg_catalog.pg_attribute attribute
                       on attribute.attrelid = constraint_row.conrelid
                      and attribute.attnum = constrained.attnum
                 ) is not distinct from $29::text[]
               )
               else pg_catalog.count(*) = 0
               end
          from pg_catalog.pg_constraint constraint_row
         where constraint_row.conrelid =
                 pg_catalog.to_regclass($24::text)
           and constraint_row.conname =
                 $25::text
      ) replay_authority_constraint_exact,
      (
        with observed(
          grantor, grantee, privilege_type, is_grantable
        ) as (
          select acl.grantor, acl.grantee, acl.privilege_type,
                 acl.is_grantable
            from target
            cross join lateral pg_catalog.aclexplode(
              coalesce(
                (select c.relacl from pg_catalog.pg_class c where c.oid = target.oid),
                pg_catalog.acldefault('r', target.relowner)
              )
            ) acl
            join pg_catalog.pg_roles worker
              on worker.rolname = 'learncoding_worker'
           where acl.grantee = worker.oid
        ), expected(
          grantor, grantee, privilege_type, is_grantable
        ) as (
          select target.relowner, worker.oid, 'SELECT'::text, false
            from target
            join pg_catalog.pg_roles worker
              on worker.rolname = 'learncoding_worker'
        )
        select not exists (
          (select * from observed except all select * from expected)
          union all
          (select * from expected except all select * from observed)
        )
      ) worker_table_direct_acl_exact,
      (
        with observed(
          attname, grantor, grantee, privilege_type, is_grantable
        ) as (
          select attribute.attname, acl.grantor, acl.grantee,
                 acl.privilege_type, acl.is_grantable
            from target
            join pg_catalog.pg_attribute attribute
              on attribute.attrelid = target.oid
             and attribute.attnum > 0
             and not attribute.attisdropped
            cross join lateral pg_catalog.aclexplode(attribute.attacl) acl
            join pg_catalog.pg_roles worker
              on worker.rolname = 'learncoding_worker'
           where acl.grantee = worker.oid
        ), expected(
          attname, grantor, grantee, privilege_type, is_grantable
        ) as (
          select expected_column_acl.attname, target.relowner, worker.oid,
                 expected_column_acl.privilege_type, false
            from expected_column_acl
            cross join target
            join pg_catalog.pg_roles worker
              on worker.rolname = 'learncoding_worker'
        )
        select not exists (
          (select * from observed except all select * from expected)
          union all
          (select * from expected except all select * from observed)
        )
      ) worker_column_direct_acl_exact,
      (
        select pg_catalog.count(*) = 1
               and pg_catalog.bool_and(
                 pg_catalog.has_table_privilege(
                   'learncoding_worker',
                   target.oid,
                   'SELECT'
                 )
                 and not pg_catalog.has_table_privilege(
                   'learncoding_worker',
                   target.oid,
                   'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'
                 )
                 and not exists (
                   select 1
                     from pg_catalog.pg_attribute attribute
                    where attribute.attrelid = target.oid
                      and attribute.attnum > 0
                      and not attribute.attisdropped
                      and (
                        not pg_catalog.has_column_privilege(
                          'learncoding_worker',
                          target.oid,
                          attribute.attnum,
                          'SELECT'
                        )
                        or pg_catalog.has_column_privilege(
                             'learncoding_worker',
                             target.oid,
                             attribute.attnum,
                             'INSERT'
                           ) is distinct from
                           (attribute.attname = any($1::text[]))
                        or pg_catalog.has_column_privilege(
                             'learncoding_worker',
                             target.oid,
                             attribute.attnum,
                             'UPDATE'
                           ) is distinct from
                           (attribute.attname = any($2::text[]))
                        or pg_catalog.has_column_privilege(
                             'learncoding_worker',
                             target.oid,
                             attribute.attnum,
                             'REFERENCES'
                           )
                      )
                 )
               )
          from target
      ) worker_effective_privileges_exact`,
    [
      expectedInsertColumns,
      expectedUpdateColumns,
      ["dispatch_binding_version", "dispatch_binding_sha256"],
      dispatchConstraint.relation,
      dispatchConstraint.name,
      dispatchConstraint.type,
      dispatchConstraint.validated,
      dispatchConstraint.normalizedExpression,
      dispatchConstraint.columns,
      dispatchConstraint.relationOwner,
      expectedBindingColumnCount,
      requiresDispatchBinding,
      [
        "provider_correlation_version",
        "provider_evidence_version",
        "provider_evidence_sha256",
      ],
      expectedProviderEvidenceColumnCount,
      providerEvidenceConstraint.relation,
      providerEvidenceConstraint.name,
      providerEvidenceConstraint.type,
      providerEvidenceConstraint.validated,
      providerEvidenceConstraint.normalizedExpressionSha256,
      providerEvidenceConstraint.columns,
      requiresProviderEvidence,
      [
        "idempotency_authority_version",
        "idempotency_authority_sha256",
        "idempotency_original_payload_sha256",
      ],
      expectedReplayAuthorityColumnCount,
      replayAuthorityConstraint.relation,
      replayAuthorityConstraint.name,
      replayAuthorityConstraint.type,
      replayAuthorityConstraint.validated,
      replayAuthorityConstraint.normalizedExpressionSha256,
      replayAuthorityConstraint.columns,
      requiresReplayAuthority,
      JSON.stringify(reviewed0067CheckConstraints),
    ],
  );
  const expected = {
    outbox_present_exact: true,
    outbox_owner_exact: true,
    binding_columns_exact: true,
    provider_evidence_columns_exact: true,
    idempotency_authority_columns_exact: true,
    reviewed_0067_check_constraints_exact: true,
    dispatch_constraint_exact: true,
    provider_evidence_constraint_exact: true,
    replay_authority_constraint_exact: true,
    worker_table_direct_acl_exact: true,
    worker_column_direct_acl_exact: true,
    worker_effective_privileges_exact: true,
  };
  const row = result.rows[0];
  if (result.rows.length !== 1 || !exactRow(row, expected)) {
    const mismatches = result.rows.length === 1
      ? exactRowMismatchKeys(row, expected).join(",")
      : "missing-or-duplicate";
    fail(`mail-worker-outbox-contract:${mismatches}`);
  }
  if (requiresReplayAuthority) {
    await verifyMailReplayAuthorityTableContract(client);
  }
  return 1;
}

export async function verifyReviewedMailAuthorityObjectFootprint(
  client,
  phase,
) {
  const canonicalPhase = canonicalReviewedMailAuthorityCatalogPhase(phase);
  const allRoutineSignatures = [
    ...new Set(
      REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.flatMap(({ routines }) =>
        routines.map(({ signature }) => signature),
      ),
    ),
  ];
  const expectedRoutineSignatures =
    canonicalPhase?.routines.map(({ signature }) => signature) ?? [];
  const allTriggers = [
    ...new Map(
      REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.flatMap(
        ({ triggers }) => triggers,
      ).map((trigger) => [`${trigger.relation}\u0000${trigger.name}`, trigger]),
    ).values(),
  ];
  const expectedTriggers = canonicalPhase?.triggers ?? [];
  const requiresDispatchBinding =
    canonicalPhase?.requiresWorkerContract === true;
  const requiresProviderEvidence =
    canonicalPhase?.requiresProviderEvidence === true;
  const requiresReplayAuthority =
    canonicalPhase?.requiresReplayAuthority === true;

  const result = await client.query(
    `
    with reviewed_routines(signature) as (
      select * from pg_catalog.unnest($1::text[])
    ), reviewed_triggers(relation_name, trigger_name) as (
      select ($3::text[])[position], ($4::text[])[position]
        from pg_catalog.generate_subscripts($3::text[], 1) position
    ), expected_triggers(relation_name, trigger_name) as (
      select ($5::text[])[position], ($6::text[])[position]
        from pg_catalog.generate_subscripts($5::text[], 1) position
    )
    select not exists (
             select 1
               from reviewed_routines
              where (
                      pg_catalog.to_regprocedure(signature) is not null
                    ) is distinct from (
                      signature = any($2::text[])
                    )
           ) reviewed_routine_presence_exact,
           not exists (
             select 1
               from reviewed_triggers
              where exists (
                      select 1
                        from pg_catalog.pg_trigger trigger_row
                       where trigger_row.tgrelid =
                               pg_catalog.to_regclass(relation_name)
                         and trigger_row.tgname = trigger_name
                         and not trigger_row.tgisinternal
                    ) is distinct from (
                      exists (
                        select 1
                          from expected_triggers expected
                         where expected.relation_name =
                                 reviewed_triggers.relation_name
                           and expected.trigger_name =
                                 reviewed_triggers.trigger_name
                      )
                    )
           ) reviewed_trigger_presence_exact,
           (
             select pg_catalog.count(*) = (
                      case when $7::boolean then 1 else 0 end
                    )
               from pg_catalog.pg_constraint constraint_row
              where constraint_row.conrelid =
                      pg_catalog.to_regclass('public.email_outbox')
                and constraint_row.conname =
                      'email_outbox_dispatch_binding_valid'
           ) reviewed_constraint_presence_exact,
           (
             select pg_catalog.count(*) = (
                      case when $8::boolean then 1 else 0 end
                    )
               from pg_catalog.pg_constraint constraint_row
              where constraint_row.conrelid =
                      pg_catalog.to_regclass('public.email_outbox')
                and constraint_row.conname =
                      'email_outbox_provider_correlation_evidence_valid'
           ) reviewed_provider_evidence_constraint_presence_exact,
           (
             select pg_catalog.count(*) = (
                      case when $9::boolean then 1 else 0 end
                    )
               from pg_catalog.pg_constraint constraint_row
              where constraint_row.conrelid =
                      pg_catalog.to_regclass('public.email_outbox')
                and constraint_row.conname =
                      'email_outbox_idempotency_authority_valid'
           ) reviewed_replay_authority_constraint_presence_exact,
           (
             pg_catalog.to_regclass(
               'public.email_outbox_idempotency_authority'
             ) is not null
           ) is not distinct from $9::boolean
             reviewed_replay_authority_relation_presence_exact`,
    [
      allRoutineSignatures,
      expectedRoutineSignatures,
      allTriggers.map(({ relation }) => relation),
      allTriggers.map(({ name }) => name),
      expectedTriggers.map(({ relation }) => relation),
      expectedTriggers.map(({ name }) => name),
      requiresDispatchBinding,
      requiresProviderEvidence,
      requiresReplayAuthority,

    ],
  );
  if (
    result.rows.length !== 1 ||
    !exactRow(result.rows[0], {
      reviewed_routine_presence_exact: true,
      reviewed_trigger_presence_exact: true,
      reviewed_constraint_presence_exact: true,
      reviewed_provider_evidence_constraint_presence_exact: true,
      reviewed_replay_authority_constraint_presence_exact: true,
      reviewed_replay_authority_relation_presence_exact: true,
    })
  )
    fail("reviewed-mail-authority-footprint");
  return 1;
}

export async function verifyReviewedMailAuthorityCatalogContracts(
  client,
  phase,
) {
  const canonicalPhase = canonicalReviewedMailAuthorityCatalogPhase(phase);
  if (canonicalPhase === null) {
    fail("reviewed-mail-authority-phase");
  }
  await verifyReviewedMailAuthorityObjectFootprint(client, canonicalPhase);
  const routinesVerified = await verifyReviewedApplicationRoutines(
    client,
    canonicalPhase.routines,
  );
  const triggersVerified = await verifyReviewedApplicationTriggers(
    client,
    canonicalPhase.triggers,
  );
  const workerContractsVerified = await verifyMailWorkerOutboxContract(client, {
    requiresDispatchBinding: canonicalPhase.requiresWorkerContract,
    requiresProviderEvidence: canonicalPhase.requiresProviderEvidence,
    requiresReplayAuthority: canonicalPhase.requiresReplayAuthority,
  });
  return {
    routinesVerified,
    triggersVerified,
    workerContractsVerified,
    totalVerified:
      routinesVerified + triggersVerified + workerContractsVerified,
  };
}

async function verifyApplicationObjectAccess(client, objects) {
  let positiveChecks = 0;
  const table = qualifiedName(objects.table);
  const column = quoteIdentifier(objects.table.column_name);
  for (const sql of [
    `select * from ${table} limit 0`,
    `explain (format json) insert into ${table} (${column}) select ${column} from ${table} where false`,
    `explain (format json) update ${table} set ${column} = ${column} where false`,
    `explain (format json) delete from ${table} where false`,
  ]) {
    await client.query(sql);
    positiveChecks += 1;
  }
  if (objects.sequence) {
    await client.query(
      `select last_value from ${qualifiedName(objects.sequence)}`,
    );
    positiveChecks += 1;
  }
  if (objects.type) {
    await client.query(`select null::${qualifiedName(objects.type)}`);
    positiveChecks += 1;
  }
  return positiveChecks;
}

async function verifyRole({ client, role, database, objects }) {
  let positiveChecks = 0;
  let negativeChecks = 0;
  const identity = await client.query(
    "select current_user, session_user, current_database()",
  );
  if (
    !exactRow(identity.rows[0], {
      current_user: role,
      session_user: role,
      current_database: database,
    })
  )
    fail();
  positiveChecks += 1;

  const flags = await client.query(`
    select rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolreplication, rolbypassrls
      from pg_roles
     where rolname = current_user`);
  if (
    !exactRow(flags.rows[0], {
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolcanlogin: true,
      rolreplication: false,
      rolbypassrls: false,
    })
  )
    fail();
  positiveChecks += 1;

  const privileges = await client.query(`
    select has_database_privilege(current_user, current_database(), 'CONNECT') connect_allowed,
           has_database_privilege(current_user, current_database(), 'TEMP') temp_allowed,
           has_database_privilege(current_user, current_database(), 'CREATE') create_allowed,
           has_schema_privilege(current_user, 'public', 'USAGE') schema_usage,
           has_schema_privilege(current_user, 'public', 'CREATE') schema_create`);
  if (
    !exactRow(privileges.rows[0], {
      connect_allowed: true,
      temp_allowed: false,
      create_allowed: false,
      schema_usage: role !== "learncoding_migrator",
      schema_create: false,
    })
  )
    fail();
  positiveChecks += 1;

  await expectInsufficientPrivilege(
    client,
    "create role codestead_forbidden_role_boundary",
  );
  negativeChecks += 1;
  await expectInsufficientPrivilege(
    client,
    "create table public.codestead_forbidden_table_boundary (id integer)",
  );
  negativeChecks += 1;
  await expectInsufficientPrivilege(
    client,
    `grant learncoding_owner to ${quoteIdentifier(role)}`,
  );
  negativeChecks += 1;

  if (RUNTIME_ROLES.has(role)) {
    await expectInsufficientPrivilege(client, "set role learncoding_owner");
    negativeChecks += 1;
    if (objects)
      positiveChecks += await verifyApplicationObjectAccess(client, objects);
  } else if (role === "learncoding_migrator") {
    await client.query("begin read only");
    try {
      await client.query("set local role learncoding_owner");
      const delegated = await client.query("select current_user, session_user");
      if (
        !exactRow(delegated.rows[0], {
          current_user: "learncoding_owner",
          session_user: "learncoding_migrator",
        })
      )
        fail();
      positiveChecks += 1;
    } finally {
      await bounded(() => client.query("rollback"));
    }
  } else {
    await expectInsufficientPrivilege(client, "set role learncoding_owner");
    negativeChecks += 1;
  }

  if (objects) {
    const table = qualifiedName(objects.table);
    await expectInsufficientPrivilege(
      client,
      `alter table ${table} owner to ${quoteIdentifier(role)}`,
    );
    negativeChecks += 1;
    await expectTablePrivilegeNotDelegated(
      client,
      role,
      table,
      objects.table.object_oid,
    );
    negativeChecks += 1;
  }
  return { positiveChecks, negativeChecks };
}

export async function verifyDatabaseRoleBoundaries(options) {
  const parsed = validateDatabaseRoleBoundaryUrls(options);
  const poolFactory = options.poolFactory ?? defaultPoolFactory;
  const lockTimeoutMs = options.lockTimeoutMs ?? MAX_LOCK_TIMEOUT_MS;
  const requireApplicationObjects = options.requireApplicationObjects === true;
  const resources = new Map();
  let lockClient;
  let lockAcquired = false;
  let rolesAuthenticated = 0;
  let positiveChecks = 0;
  let negativeChecks = 0;
  try {
    for (const [name] of ROLE_SPECS) {
      const role = parsed[name];
      const pool = poolFactory({
        connectionString: role.connectionString,
        database: role.database,
        role: role.username,
      });
      const resource = { client: undefined, pool };
      resources.set(name, resource);
      resource.client = await pool.connect();
    }
    lockClient = resources.get("ops").client;
    await acquireAdministrationLock(lockClient, lockTimeoutMs);
    lockAcquired = true;
    let objects;
    if (requireApplicationObjects) {
      objects = await discoverApplicationObjects(lockClient);
      const reviewedPhase = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.at(-1);
      if (reviewedPhase?.backupStatusAuthority == null) {
        fail("backup-status-authority-phase");
      }
      const catalog =
        await verifyReviewedMailAuthorityCatalogContracts(
          lockClient,
          reviewedPhase,
        );
      positiveChecks += catalog.totalVerified;
      positiveChecks += await verifyBackupStatusMailAuthorityObjects(
        lockClient,
        RESTRICTED_ROLE_NAMES,
        reviewedPhase.backupStatusAuthority,
      );
    }
    for (const [name] of ROLE_SPECS) {
      const role = parsed[name];
      const result = await verifyRole({
        client: resources.get(name).client,
        role: role.username,
        database: role.database,
        objects,
      });
      rolesAuthenticated += 1;
      positiveChecks += result.positiveChecks;
      negativeChecks += result.negativeChecks;
    }
    return { rolesAuthenticated, positiveChecks, negativeChecks };
  } catch (error) {
    if (error instanceof DatabaseRoleBoundaryError) {
      throw error;
    }
    fail();
  } finally {
    let cleanupFailed = false;
    if (lockAcquired) {
      try {
        await releaseAdministrationLock(lockClient);
      } catch {
        cleanupFailed = true;
      }
    }
    for (const { client, pool } of [...resources.values()].reverse()) {
      try {
        client?.release(cleanupFailed || undefined);
      } catch {
        cleanupFailed = true;
      }
      try {
        await bounded(() => pool.end());
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) fail();
  }
}

function parseArguments(argv) {
  if (argv.length === 0) return false;
  if (argv.length === 1 && argv[0] === "--require-application-objects")
    return true;
  fail();
}

async function main() {
  const requireApplicationObjects = parseArguments(process.argv.slice(2));
  const result = await verifyDatabaseRoleBoundaries({
    postgresDatabase: process.env.POSTGRES_DB ?? "",
    databaseAppUrl: process.env.DATABASE_URL ?? "",
    databaseMigratorUrl: process.env.DATABASE_MIGRATOR_URL ?? "",
    databaseWorkerUrl: process.env.DATABASE_WORKER_URL ?? "",
    databaseOpsUrl: process.env.DATABASE_OPS_URL ?? "",
    databaseBackupReporterUrl: process.env.DATABASE_BACKUP_REPORTER_URL ?? "",
    requireApplicationObjects,
  });
  process.stdout.write(
    `${JSON.stringify({
      event: "database.role_boundaries_verified",
      mode: requireApplicationObjects ? "application-objects" : "pre-migration",
      ...result,
    })}\n`,
  );
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        event: "database.role_boundary_verification_failed",
        code: error instanceof Error ? error.name : "UNKNOWN",
      })}\n`,
    );
    process.exitCode = 1;
  });
}
