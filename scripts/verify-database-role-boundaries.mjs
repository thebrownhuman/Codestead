import process from "node:process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";
import {
  MAIL_WORKER_OUTBOX_INSERT_COLUMNS,
  MAIL_WORKER_OUTBOX_PRE_BINDING_UPDATE_COLUMNS,
  MAIL_WORKER_OUTBOX_UPDATE_COLUMNS,
  REVIEWED_APPLICATION_CONSTRAINTS,
  REVIEWED_APPLICATION_FUNCTIONS,
  REVIEWED_APPLICATION_TRIGGERS,
  REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES,
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

export async function verifyMailWorkerOutboxContract(
  client,
  {
    requiresDispatchBinding = true,
    requiresProviderEvidence = false,
  } = {},
) {
  if (
    typeof requiresDispatchBinding !== "boolean"
    || typeof requiresProviderEvidence !== "boolean"
    || (requiresProviderEvidence && !requiresDispatchBinding)
  ) fail();
  if (REVIEWED_APPLICATION_CONSTRAINTS.length !== 2) fail();
  const dispatchConstraint = REVIEWED_APPLICATION_CONSTRAINTS.find(
    ({ name }) => name === "email_outbox_dispatch_binding_valid",
  );
  const providerEvidenceConstraint = REVIEWED_APPLICATION_CONSTRAINTS.find(
    ({ name }) =>
      name === "email_outbox_provider_correlation_evidence_valid",
  );
  if (
    !dispatchConstraint
    || !providerEvidenceConstraint
    || !/^[0-9a-f]{64}$/u.test(
      providerEvidenceConstraint.normalizedExpressionSha256,
    )
  ) fail();
  const expectedUpdateColumns = requiresProviderEvidence
    ? MAIL_WORKER_OUTBOX_UPDATE_COLUMNS
    : requiresDispatchBinding
      ? MAIL_WORKER_OUTBOX_PRE_EVIDENCE_UPDATE_COLUMNS
      : MAIL_WORKER_OUTBOX_PRE_BINDING_UPDATE_COLUMNS;
  const expectedBindingColumnCount = requiresDispatchBinding ? 2 : 0;
  const expectedProviderEvidenceColumnCount =
    requiresProviderEvidence ? 3 : 0;

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
    ), expected_column_acl(attname, privilege_type) as (
      select column_name, 'INSERT'::text
        from pg_catalog.unnest($1::text[]) column_name
      union all
      select column_name, 'UPDATE'::text
        from pg_catalog.unnest($2::text[]) column_name
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
      MAIL_WORKER_OUTBOX_INSERT_COLUMNS,
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
    ],
  );
  if (
    result.rows.length !== 1 ||
    !exactRow(result.rows[0], {
      outbox_present_exact: true,
      outbox_owner_exact: true,
      binding_columns_exact: true,
      dispatch_constraint_exact: true,
      provider_evidence_constraint_exact: true,
      worker_table_direct_acl_exact: true,
      worker_column_direct_acl_exact: true,
      worker_effective_privileges_exact: true,
    })
  )
    fail("mail-worker-outbox-contract");
  return 1;
}

export async function verifyReviewedMailAuthorityObjectFootprint(
  client,
  phase = null,
) {
  const allRoutineSignatures = [
    ...new Set(
      REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.flatMap(({ routines }) =>
        routines.map(({ signature }) => signature),
      ),
    ),
  ];
  const expectedRoutineSignatures =
    phase?.routines?.map(({ signature }) => signature) ?? [];
  const allTriggers = [
    ...new Map(
      REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.flatMap(
        ({ triggers }) => triggers,
      ).map((trigger) => [`${trigger.relation}\u0000${trigger.name}`, trigger]),
    ).values(),
  ];
  const expectedTriggers = phase?.triggers ?? [];
  const requiresDispatchBinding = phase?.requiresWorkerContract === true;
  const requiresProviderEvidence =
    phase?.requiresProviderEvidence === true;

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
           ) reviewed_provider_evidence_constraint_presence_exact`,
    [
      allRoutineSignatures,
      expectedRoutineSignatures,
      allTriggers.map(({ relation }) => relation),
      allTriggers.map(({ name }) => name),
      expectedTriggers.map(({ relation }) => relation),
      expectedTriggers.map(({ name }) => name),
      requiresDispatchBinding,
      requiresProviderEvidence,
    ],
  );
  if (
    result.rows.length !== 1 ||
    !exactRow(result.rows[0], {
      reviewed_routine_presence_exact: true,
      reviewed_trigger_presence_exact: true,
      reviewed_constraint_presence_exact: true,
      reviewed_provider_evidence_constraint_presence_exact: true,
    })
  )
    fail("reviewed-mail-authority-footprint");
  return 1;
}

export async function verifyReviewedMailAuthorityCatalogContracts(client) {
  await verifyReviewedMailAuthorityObjectFootprint(
    client,
    REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.at(-1),
  );
  const routinesVerified = await verifyReviewedApplicationRoutines(client);
  const triggersVerified = await verifyReviewedApplicationTriggers(client);
  const workerContractsVerified = await verifyMailWorkerOutboxContract(client, {
    requiresDispatchBinding: true,
    requiresProviderEvidence: true,
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
      const catalog =
        await verifyReviewedMailAuthorityCatalogContracts(lockClient);
      positiveChecks += catalog.totalVerified;
      positiveChecks += await verifyBackupStatusMailAuthorityObjects(
        lockClient,
        RESTRICTED_ROLE_NAMES,
        { verifyGuardState: false },
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
  } catch {
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
