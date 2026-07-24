import process from "node:process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

export const DATABASE_ADMIN_LOCK_NAME = "codestead:database-administration:v1";
const OWNER_ROLE = "learncoding_owner";
const MIGRATOR_ROLE = "learncoding_migrator";
const APP_ROLE = "learncoding_app";
const WORKER_ROLE = "learncoding_worker";
const OPS_ROLE = "learncoding_ops";
const LOGIN_ROLES = [MIGRATOR_ROLE, APP_ROLE, WORKER_ROLE, OPS_ROLE];
// Fixed reviewed runtime-function allowlist. Empty for this release.
export const REVIEWED_APPLICATION_FUNCTIONS = Object.freeze([]);
const MAIL_WORKER_OUTBOX_COLUMNS = Object.freeze([
  "id",
  "user_id",
  "to_email",
  "template",
  "template_version",
  "variables",
  "idempotency_key",
  "operation_id",
  "delivery_scope_key",
  "status",
  "attempt_count",
  "claim_token",
  "claim_owner",
  "claim_version",
  "lease_expires_at",
  "provider_call_started",
  "adapter",
  "provider_message_id",
  "next_attempt_at",
  "sent_at",
  "quarantined_at",
  "last_error_code",
  "created_at",
  "updated_at",
]);
export const MAIL_WORKER_OUTBOX_INSERT_COLUMNS = Object.freeze([
  "operation_id",
  "user_id",
  "delivery_scope_key",
  "to_email",
  "template",
  "template_version",
  "variables",
  "idempotency_key",
  "status",
  "next_attempt_at",
]);
export const MAIL_WORKER_OUTBOX_UPDATE_COLUMNS = Object.freeze([
  "status",
  "attempt_count",
  "claim_token",
  "claim_owner",
  "claim_version",
  "lease_expires_at",
  "provider_call_started",
  "adapter",
  "provider_message_id",
  "next_attempt_at",
  "sent_at",
  "quarantined_at",
  "last_error_code",
  "updated_at",
]);

export function mailWorkerOutboxPrivilegesSql() {
  const allColumns = MAIL_WORKER_OUTBOX_COLUMNS.join(", ");
  const insertColumns = MAIL_WORKER_OUTBOX_INSERT_COLUMNS.join(", ");
  const updateColumns = MAIL_WORKER_OUTBOX_UPDATE_COLUMNS.join(", ");
  return `
    revoke all on table public.email_outbox from learncoding_worker;
    revoke all (${allColumns}) on table public.email_outbox from learncoding_worker;
    grant select on table public.email_outbox to learncoding_worker;
    grant insert (${insertColumns}) on table public.email_outbox to learncoding_worker;
    grant update (${updateColumns}) on table public.email_outbox to learncoding_worker;
  `;
}

const MAX_LOCK_TIMEOUT_MS = 120_000;
const LOCK_POLL_MS = 500;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const MAX_SESSION_DRAIN_MS = 5_000;
const SESSION_DRAIN_POLL_MS = 50;
const MIN_PASSWORD_BYTES = 32;
const MAX_PASSWORD_BYTES = 1024;

const ROLE_SPECS = [
  ["bootstrap", "databaseBootstrapUrl", null],
  ["app", "databaseAppUrl", APP_ROLE],
  ["migrator", "databaseMigratorUrl", MIGRATOR_ROLE],
  ["worker", "databaseWorkerUrl", WORKER_ROLE],
  ["ops", "databaseOpsUrl", OPS_ROLE],
];

function invalidCredentialConfiguration() {
  return new Error("database credential configuration is invalid");
}

function unsafeOwnershipInventory() {
  return new Error("unsafe legacy ownership inventory");
}

function decodeUrlComponent(value) {
  const decoded = decodeURIComponent(value);
  if (!decoded || /[\u0000-\u001f\u007f]/u.test(decoded)) {
    throw invalidCredentialConfiguration();
  }
  return decoded;
}

export function validateDatabaseRoleUrls(input) {
  const parsed = {};
  const usernames = new Set();
  const passwords = new Set();

  try {
    if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(input.postgresUser)) {
      throw invalidCredentialConfiguration();
    }
    if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(input.postgresDatabase)) {
      throw invalidCredentialConfiguration();
    }

    for (const [name, property, fixedUsername] of ROLE_SPECS) {
      const url = new URL(input[property]);
      const username = decodeUrlComponent(url.username);
      const password = decodeUrlComponent(url.password);
      const passwordBytes = Buffer.byteLength(password, "utf8");
      if (passwordBytes < MIN_PASSWORD_BYTES || passwordBytes > MAX_PASSWORD_BYTES) {
        throw invalidCredentialConfiguration();
      }
      const database = decodeUrlComponent(url.pathname.slice(1));
      const expectedUsername = fixedUsername ?? input.postgresUser;

      if (
        url.protocol !== "postgresql:" ||
        username !== expectedUsername ||
        url.hostname !== "postgres" ||
        (url.port !== "" && url.port !== "5432") ||
        database !== input.postgresDatabase ||
        url.pathname !== `/${encodeURIComponent(input.postgresDatabase)}` ||
        url.search !== "" ||
        url.hash !== "" ||
        usernames.has(username) ||
        passwords.has(password)
      ) {
        throw invalidCredentialConfiguration();
      }

      usernames.add(username);
      passwords.add(password);
      parsed[name] = {
        username,
        password,
        hostname: url.hostname,
        database,
        connectionString: url.href,
      };
    }
  } catch {
    throw invalidCredentialConfiguration();
  }

  return parsed;
}

export function validateOwnershipInventory(input) {
  const allowedOwners = new Set([input.postgresUser, OWNER_ROLE]);
  const applicationSchemas = new Set(["public", "drizzle"]);
  const canonicalSystemDatabases = new Set(["postgres", "template0", "template1"]);
  const target = input.databases.find((database) => database.name === input.postgresDatabase);
  const canonicalSystemTablespaces = new Set(["pg_default", "pg_global"]);
  const unsafeDatabase = input.databases.some(
    (database) =>
      allowedOwners.has(database.owner) &&
      database.name !== input.postgresDatabase &&
      !canonicalSystemDatabases.has(database.name),
  );
  const unsafeTablespace = input.tablespaces.some(
    (tablespace) =>
      allowedOwners.has(tablespace.owner) &&
      !canonicalSystemTablespaces.has(tablespace.name),
  );
  const unsafeSchema = input.schemas.some((schema) => {
    if (schema.name === "public") {
      return !new Set([...allowedOwners, "pg_database_owner"]).has(schema.owner);
    }
    if (schema.name === "drizzle") return !allowedOwners.has(schema.owner);
    return allowedOwners.has(schema.owner);
  });
  const unsafeOwnedObject = [
    ...(input.objects ?? []),
    ...(input.routines ?? []),
    ...(input.types ?? []),
  ].some(
    (object) => !applicationSchemas.has(object.schema) || !allowedOwners.has(object.owner),
  );
  const allowedDefaultGrantees = new Set(["PUBLIC", ...allowedOwners, APP_ROLE, WORKER_ROLE, OPS_ROLE]);
  const allowedDirectGrantees = new Set([
    ...allowedDefaultGrantees, MIGRATOR_ROLE, "pg_database_owner",
  ]);
  const unsafeDefaultAcl = (input.defaultAcls ?? []).some(
    (entry) =>
      !applicationSchemas.has(entry.schema) ||
      !allowedOwners.has(entry.owner) ||
      !allowedDefaultGrantees.has(entry.grantee),
  );

  const unsafeOwnerDependency = (input.unexpectedOwnerDependencies ?? []).length !== 0;
  const unsafeDirectAcl = (input.directAcls ?? []).some(
    (entry) =>
      !allowedDirectGrantees.has(entry.grantee) ||
      entry.isGrantable === true ||
      entry.is_grantable === true,
  );
  if (
    !target ||
    !allowedOwners.has(target.owner) ||
    unsafeDatabase ||
    unsafeTablespace ||
    unsafeSchema ||
    unsafeOwnedObject ||
    unsafeDefaultAcl ||
    unsafeOwnerDependency ||
    unsafeDirectAcl
  ) {
    throw unsafeOwnershipInventory();
  }
}

async function acquireAdministrationLock(client, timeoutMs = MAX_LOCK_TIMEOUT_MS) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("database administration lock timeout must be positive and finite");
  }
  const deadline = performance.now() + Math.min(timeoutMs, MAX_LOCK_TIMEOUT_MS);
  while (performance.now() < deadline) {
    const remainingMs = deadline - performance.now();
    let timeoutHandle;
    const query = Promise.resolve().then(() => client.query(
        "select pg_try_advisory_lock(hashtextextended($1, 0)) acquired",
        [DATABASE_ADMIN_LOCK_NAME],
      ));
    const timeout = new Promise((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error("database administration lock timeout")),
        remainingMs,
      );
    });
    let result;
    try {
      result = await Promise.race([query, timeout]);
      if (performance.now() >= deadline) {
        throw new Error("database administration lock timeout");
      }
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
    if (result.rows[0]?.acquired === true) return;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(LOCK_POLL_MS, Math.max(1, deadline - performance.now()))),
    );
  }
  throw new Error("database administration lock timeout");
}

async function loadOwnershipInventory(client, postgresUser, postgresDatabase) {
  const [
    databases,
    tablespaces,
    schemas,
    objects,
    routines,
    types,
    defaultAcls,
    unexpectedOwnerDependencies,
    directAcls,
  ] = [
    await client.query(
      `select d.datname name, pg_get_userbyid(d.datdba) owner
         from pg_database d
        where d.datname = current_database()
           or pg_get_userbyid(d.datdba) in ($1, 'learncoding_owner')
        order by d.datname`,
      [postgresUser],
    ),
    await client.query(
      `select t.spcname name, pg_get_userbyid(t.spcowner) owner
         from pg_tablespace t
        where pg_get_userbyid(t.spcowner) in ($1, 'learncoding_owner')
        order by t.spcname`,
      [postgresUser],
    ),
    await client.query(
      `select n.nspname name, pg_get_userbyid(n.nspowner) owner
         from pg_namespace n
        where n.nspname in ('public', 'drizzle')
           or (
             pg_get_userbyid(n.nspowner) in ($1, 'learncoding_owner')
             and n.nspname !~ '^pg_'
             and n.nspname <> 'information_schema'
           )
        order by n.nspname`,
      [postgresUser],
    ),
    await client.query(
      `select n.nspname schema, c.relname name, c.relkind::text kind,
              pg_get_userbyid(c.relowner) owner
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p', 'S', 'v', 'm', 'f', 'c', 'i', 'I')
          and n.nspname !~ '^pg_'
          and n.nspname <> 'information_schema'
          and (
            n.nspname in ('public', 'drizzle')
            or pg_get_userbyid(c.relowner) in ($1, 'learncoding_owner')
          )
        order by n.nspname, c.relname`,
      [postgresUser],
    ),
    await client.query(
      `select n.nspname schema, p.proname name, p.prokind::text kind,
              pg_get_userbyid(p.proowner) owner
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname !~ '^pg_'
          and n.nspname <> 'information_schema'
          and (
            n.nspname in ('public', 'drizzle')
            or pg_get_userbyid(p.proowner) in ($1, 'learncoding_owner')
          )
        order by n.nspname, p.proname, p.oid`,
      [postgresUser],
    ),
    await client.query(
      `select n.nspname schema, t.typname name, t.typtype::text kind,
              pg_get_userbyid(t.typowner) owner
         from pg_type t
         join pg_namespace n on n.oid = t.typnamespace
        where t.typtype in ('c', 'd', 'e', 'm', 'r')
          and n.nspname !~ '^pg_'
          and n.nspname <> 'information_schema'
          and (
            n.nspname in ('public', 'drizzle')
            or pg_get_userbyid(t.typowner) in ($1, 'learncoding_owner')
          )
        order by n.nspname, t.typname`,
      [postgresUser],
    ),
    await client.query(
      `select coalesce(n.nspname, '*') schema,
              pg_get_userbyid(a.defaclrole) owner,
              case when privilege.grantee = 0 then 'PUBLIC'
                   else pg_get_userbyid(privilege.grantee) end grantee,
              a.defaclobjtype::text kind,
              privilege.privilege_type,
              privilege.is_grantable
         from pg_default_acl a
         left join pg_namespace n on n.oid = a.defaclnamespace
         cross join lateral aclexplode(a.defaclacl) privilege
        where pg_get_userbyid(a.defaclrole) in ($1, 'learncoding_owner')
        order by 1, 2, 3, 4, 5, 6`,
      [postgresUser],
    ),
    await client.query(
      `select catalog, object_id
         from (
           select 'pg_collation' catalog, oid::text object_id
             from pg_collation where oid >= 16384 and pg_get_userbyid(collowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_conversion', oid::text
             from pg_conversion where oid >= 16384 and pg_get_userbyid(conowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_event_trigger', oid::text
             from pg_event_trigger where oid >= 16384 and pg_get_userbyid(evtowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_extension', oid::text
             from pg_extension where oid >= 16384 and pg_get_userbyid(extowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_foreign_data_wrapper', oid::text
             from pg_foreign_data_wrapper where oid >= 16384 and pg_get_userbyid(fdwowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_foreign_server', oid::text
             from pg_foreign_server where oid >= 16384 and pg_get_userbyid(srvowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_language', oid::text
             from pg_language where oid >= 16384 and pg_get_userbyid(lanowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_largeobject_metadata', oid::text
             from pg_largeobject_metadata where oid >= 16384 and pg_get_userbyid(lomowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_opclass', oid::text
             from pg_opclass where oid >= 16384 and pg_get_userbyid(opcowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_operator', oid::text
             from pg_operator where oid >= 16384 and pg_get_userbyid(oprowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_opfamily', oid::text
             from pg_opfamily where oid >= 16384 and pg_get_userbyid(opfowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_publication', oid::text
             from pg_publication where oid >= 16384 and pg_get_userbyid(pubowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_statistic_ext', oid::text
             from pg_statistic_ext where oid >= 16384 and pg_get_userbyid(stxowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_subscription', oid::text
             from pg_subscription where oid >= 16384 and pg_get_userbyid(subowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_ts_config', oid::text
             from pg_ts_config where oid >= 16384 and pg_get_userbyid(cfgowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_ts_dict', oid::text
             from pg_ts_dict where oid >= 16384 and pg_get_userbyid(dictowner) in ($1, 'learncoding_owner')
         ) unsupported
        order by catalog, object_id`,
      [postgresUser],
    ),
    await client.query(
      `select scope, grantee, privilege, is_grantable
         from (
           select 'database ' || d.datname scope,
                  case when acl.grantee = 0 then 'PUBLIC'
                       else pg_get_userbyid(acl.grantee) end grantee,
                   acl.privilege_type privilege,
                   acl.is_grantable
             from pg_database d
              cross join lateral aclexplode(d.datacl) acl
            where d.datname = $1
           union all
           select 'schema ' || n.nspname,
                  case when acl.grantee = 0 then 'PUBLIC'
                       else pg_get_userbyid(acl.grantee) end,
                   acl.privilege_type,
                   acl.is_grantable
             from pg_namespace n
              cross join lateral aclexplode(n.nspacl) acl
            where n.nspname in ('public', 'drizzle')
           union all
           select case when c.relkind = 'S' then 'sequence ' else 'relation ' end ||
                    n.nspname || '.' || c.relname,
                  case when acl.grantee = 0 then 'PUBLIC'
                       else pg_get_userbyid(acl.grantee) end,
                   acl.privilege_type,
                   acl.is_grantable
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
              cross join lateral aclexplode(c.relacl) acl
            where n.nspname in ('public', 'drizzle')
           union all
           select 'routine ' || n.nspname || '.' || p.proname || '(' ||
                    pg_get_function_identity_arguments(p.oid) || ')',
                  case when acl.grantee = 0 then 'PUBLIC'
                       else pg_get_userbyid(acl.grantee) end,
                   acl.privilege_type,
                   acl.is_grantable
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
              cross join lateral aclexplode(p.proacl) acl
            where n.nspname in ('public', 'drizzle')
           union all
           select 'type ' || n.nspname || '.' || t.typname,
                  case when acl.grantee = 0 then 'PUBLIC'
                       else pg_get_userbyid(acl.grantee) end,
                   acl.privilege_type,
                   acl.is_grantable
             from pg_type t
             join pg_namespace n on n.oid = t.typnamespace
              cross join lateral aclexplode(t.typacl) acl
            where n.nspname in ('public', 'drizzle')
         ) direct_acl
        order by scope, grantee, privilege, is_grantable`,
      [postgresDatabase],
    ),
  ];
  return {
    postgresUser,
    postgresDatabase,
    databases: databases.rows,
    tablespaces: tablespaces.rows,
    schemas: schemas.rows,
    objects: objects.rows,
    routines: routines.rows,
    types: types.rows,
    defaultAcls: defaultAcls.rows,
    unexpectedOwnerDependencies: unexpectedOwnerDependencies.rows,
    directAcls: directAcls.rows,
  };
}

async function createAndResetRoles(client) {
  await client.query(`
    do $codestead$
    begin
      if not exists (select 1 from pg_roles where rolname = 'learncoding_owner') then
        create role learncoding_owner;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'learncoding_migrator') then
        create role learncoding_migrator login;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'learncoding_app') then
        create role learncoding_app login;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'learncoding_worker') then
        create role learncoding_worker login;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'learncoding_ops') then
        create role learncoding_ops login;
      end if;
    end
    $codestead$`);

  await client.query(`
    alter role learncoding_owner nologin nosuperuser nocreatedb nocreaterole
      noinherit noreplication nobypassrls connection limit -1 password null valid until 'infinity';
    alter role learncoding_migrator login nosuperuser nocreatedb nocreaterole
      noinherit noreplication nobypassrls connection limit -1 valid until 'infinity';
    alter role learncoding_app login nosuperuser nocreatedb nocreaterole
      noinherit noreplication nobypassrls connection limit -1 valid until 'infinity';
    alter role learncoding_worker login nosuperuser nocreatedb nocreaterole
      noinherit noreplication nobypassrls connection limit -1 valid until 'infinity';
    alter role learncoding_ops login nosuperuser nocreatedb nocreaterole
      noinherit noreplication nobypassrls connection limit -1 valid until 'infinity';
    alter role learncoding_owner reset all;
    alter role learncoding_migrator reset all;
    alter role learncoding_app reset all;
    alter role learncoding_worker reset all;
    alter role learncoding_ops reset all`);

  await client.query(`
    do $codestead$
    declare setting record;
    begin
      for setting in
        select roles.rolname, databases.datname
          from pg_db_role_setting configured
          join pg_roles roles on roles.oid = configured.setrole
          join pg_database databases on databases.oid = configured.setdatabase
         where roles.rolname in (
           'learncoding_owner', 'learncoding_migrator', 'learncoding_app',
           'learncoding_worker', 'learncoding_ops'
         )
      loop
        execute format(
          'alter role %I in database %I reset all',
          setting.rolname,
          setting.datname
        );
      end loop;
    end
    $codestead$`);

  await client.query(`
    do $codestead$
    declare membership record;
    begin
      for membership in
        select granted.rolname granted_role, member.rolname member_role
          from pg_auth_members memberships
          join pg_roles granted on granted.oid = memberships.roleid
          join pg_roles member on member.oid = memberships.member
         where member.rolname in (
           'learncoding_owner', 'learncoding_migrator', 'learncoding_app',
           'learncoding_worker', 'learncoding_ops'
         )
            or granted.rolname in (
              'learncoding_owner', 'learncoding_migrator', 'learncoding_app',
              'learncoding_worker', 'learncoding_ops'
            )
      loop
        execute format('revoke %I from %I', membership.granted_role, membership.member_role);
      end loop;
    end
    $codestead$`);
  await client.query(
    "grant learncoding_owner to learncoding_migrator with admin false, inherit false, set true",
  );
}

async function rotatePasswords(client, roles) {
  await client.query("set local password_encryption = 'scram-sha-256'");
  for (const role of LOGIN_ROLES) {
    await client.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where usename = $1 and pid <> pg_backend_pid()",
      [role],
    );
    await client.query("select set_config('codestead.role_password', $1, true)", [
      roles[role].password,
    ]);
    await client.query(`
      do $codestead$
      begin
        execute format(
          'alter role ${role} password %L',
          current_setting('codestead.role_password')
        );
      end
      $codestead$`);
  }
  const deadline = performance.now() + MAX_SESSION_DRAIN_MS;
  while (true) {
    await client.query("select pg_stat_clear_snapshot()");
    const remaining = await client.query(
      `select count(*)::integer remaining
         from pg_stat_activity
        where usename = any($1::text[])
          and pid <> pg_backend_pid()`,
      [LOGIN_ROLES],
    );
    if (remaining.rows[0]?.remaining === 0) break;
    if (performance.now() >= deadline) {
      throw new Error("database role sessions remain active");
    }
    await new Promise((resolve) => setTimeout(resolve, SESSION_DRAIN_POLL_MS));
  }
}

async function transferApplicationOwnership(client) {
  await client.query(`
    do $codestead$
    declare object record;
    begin
      execute format('alter database %I owner to learncoding_owner', current_database());
      alter schema public owner to learncoding_owner;
      if exists (select 1 from pg_namespace where nspname = 'drizzle') then
        alter schema drizzle owner to learncoding_owner;
      end if;

      for object in
        select n.nspname, c.relname, c.relkind
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname in ('public', 'drizzle')
           and c.relkind in ('r', 'p', 'S', 'v', 'm', 'f', 'c')
         order by n.nspname, c.relname
      loop
        execute format(
          case object.relkind
            when 'S' then 'alter sequence %I.%I owner to learncoding_owner'
            when 'v' then 'alter view %I.%I owner to learncoding_owner'
            when 'm' then 'alter materialized view %I.%I owner to learncoding_owner'
            when 'f' then 'alter foreign table %I.%I owner to learncoding_owner'
            when 'c' then 'alter type %I.%I owner to learncoding_owner'
            else 'alter table %I.%I owner to learncoding_owner'
          end,
          object.nspname,
          object.relname
        );
      end loop;

      for object in
        select n.nspname, p.proname, p.prokind,
               pg_get_function_identity_arguments(p.oid) identity_arguments
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('public', 'drizzle')
         order by n.nspname, p.proname, p.oid
      loop
        execute format(
          case object.prokind
            when 'p' then 'alter procedure %I.%I(%s) owner to learncoding_owner'
            when 'a' then 'alter aggregate %I.%I(%s) owner to learncoding_owner'
            else 'alter function %I.%I(%s) owner to learncoding_owner'
          end,
          object.nspname,
          object.proname,
          object.identity_arguments
        );
      end loop;

      for object in
        select n.nspname, t.typname
          from pg_type t
          join pg_namespace n on n.oid = t.typnamespace
         where n.nspname in ('public', 'drizzle')
           and t.typtype in ('d', 'e', 'm', 'r')
         order by n.nspname, t.typname
      loop
        execute format(
          'alter type %I.%I owner to learncoding_owner',
          object.nspname,
          object.typname
        );
      end loop;
    end
    $codestead$`);
}

async function reconcilePrivileges(client) {
  await client.query(`
    do $codestead$
    begin
      execute format('revoke all on database %I from public', current_database());
      execute format('revoke all on database %I from learncoding_app', current_database());
      execute format('revoke all on database %I from learncoding_worker', current_database());
      execute format('revoke all on database %I from learncoding_ops', current_database());
      execute format('revoke all on database %I from learncoding_migrator', current_database());
      execute format('revoke all on database %I from current_user', current_database());
      execute format(
        'grant connect on database %I to learncoding_app, learncoding_worker, learncoding_ops, learncoding_migrator',
        current_database()
      );
    end
    $codestead$;

    revoke all on schema public from public, pg_database_owner, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops;
    grant usage on schema public to learncoding_app, learncoding_worker, learncoding_ops;
    revoke all on all tables in schema public from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops;
    grant select, insert, update, delete on all tables in schema public
      to learncoding_app, learncoding_worker, learncoding_ops;
    revoke all on all sequences in schema public from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops;
    grant usage, select, update on all sequences in schema public
      to learncoding_app, learncoding_worker, learncoding_ops;
    revoke execute on all routines in schema public from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops;
    do $codestead_types$
    declare object record;
    begin
      for object in
        select n.nspname, t.typname
          from pg_type t
          join pg_namespace n on n.oid = t.typnamespace
         where n.nspname = 'public'
           and t.typtype in ('c', 'd', 'e', 'm', 'r')
         order by t.oid
      loop
        execute format(
          'revoke usage on type %I.%I from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops',
          object.nspname,
          object.typname
        );
        execute format(
          'grant usage on type %I.%I to learncoding_app, learncoding_worker, learncoding_ops',
          object.nspname,
          object.typname
        );
      end loop;
    end
    $codestead_types$;

    alter default privileges for role learncoding_owner in schema public
      revoke all on tables from public, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops;
    alter default privileges for role learncoding_owner in schema public
      revoke all on sequences from public, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops;
    alter default privileges for role learncoding_owner in schema public
      revoke all on routines from public, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops;
    alter default privileges for role current_user in schema public revoke all on tables from public, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops;
    alter default privileges for role current_user in schema public revoke all on sequences from public, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops;
    alter default privileges for role current_user in schema public revoke execute on routines from public, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops;
    alter default privileges for role current_user in schema public revoke usage on types from public, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops;
    alter default privileges for role learncoding_owner in schema public
      revoke all on types from public, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops;
    alter default privileges for role learncoding_owner in schema public
      grant select, insert, update, delete on tables to learncoding_app, learncoding_worker, learncoding_ops;
    alter default privileges for role learncoding_owner in schema public
      grant usage, select, update on sequences to learncoding_app, learncoding_worker, learncoding_ops;
    alter default privileges for role learncoding_owner in schema public
      grant usage on types to learncoding_app, learncoding_worker, learncoding_ops`);

  const emailOutbox = await client.query(
    "select to_regclass('public.email_outbox') is not null present",
  );
  if (emailOutbox.rows[0]?.present === true) {
    await client.query(mailWorkerOutboxPrivilegesSql());
  }

  const drizzleExists = await client.query(
    "select exists(select 1 from pg_namespace where nspname = 'drizzle') present",
  );
  if (drizzleExists.rows[0]?.present === true) {
    await client.query(`
      revoke all on schema drizzle from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops;
      revoke all on all tables in schema drizzle from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops;
      revoke all on all sequences in schema drizzle from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops;
      revoke execute on all routines in schema drizzle from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops;
      do $codestead_types$
      declare object record;
      begin
        for object in
          select n.nspname, t.typname
            from pg_type t
            join pg_namespace n on n.oid = t.typnamespace
           where n.nspname = 'drizzle'
             and t.typtype in ('c', 'd', 'e', 'm', 'r')
           order by t.oid
        loop
          execute format(
            'revoke usage on type %I.%I from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops',
            object.nspname,
            object.typname
          );
        end loop;
      end
      $codestead_types$;
      alter default privileges for role learncoding_owner in schema drizzle
        revoke all on tables from public, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops;
      alter default privileges for role learncoding_owner in schema drizzle
        revoke all on sequences from public, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops;
      alter default privileges for role learncoding_owner in schema drizzle
        revoke all on routines from public, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops;
      alter default privileges for role learncoding_owner in schema drizzle
        revoke all on types from public, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops;
      alter default privileges for role current_user in schema drizzle revoke all on tables from public, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops;
      alter default privileges for role current_user in schema drizzle revoke all on sequences from public, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops;
      alter default privileges for role current_user in schema drizzle revoke execute on routines from public, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops;
      alter default privileges for role current_user in schema drizzle revoke usage on types from public, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops`);
  }
}

async function verifyInvariants(client, postgresDatabase, postgresUser) {
  const roles = await client.query(`
    select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
           rolinherit, rolreplication, rolbypassrls, rolconnlimit,
           rolvaliduntil = 'infinity'::timestamptz valid_until_infinity,
           rolpassword is null password_is_null,
           coalesce(auth.rolpassword like 'SCRAM-SHA-256$%', false) password_is_scram,
           not exists (
             select 1 from pg_db_role_setting setting where setting.setrole = auth.oid
           ) role_settings_empty
      from pg_authid auth
     where rolname in (
       'learncoding_owner', 'learncoding_migrator', 'learncoding_app',
       'learncoding_worker', 'learncoding_ops'
     )
     order by rolname`);
  if (roles.rows.length !== 5) {
    throw new Error("database role bootstrap invariant verification failed");
  }
  for (const role of roles.rows) {
    const isOwner = role.rolname === OWNER_ROLE;
    if (
      role.rolcanlogin !== !isOwner ||
      role.rolsuper !== false ||
      role.rolcreatedb !== false ||
      role.rolcreaterole !== false ||
      role.rolinherit !== false ||
      role.rolreplication !== false ||
      role.rolbypassrls !== false ||
      role.rolconnlimit !== -1 ||
      role.valid_until_infinity !== true ||
      role.role_settings_empty !== true ||
      (isOwner ? role.password_is_null !== true : role.password_is_scram !== true)
    ) {
      throw new Error("database role bootstrap invariant verification failed");
    }
  }

  const memberships = await client.query(`
    select granted.rolname granted_role, member.rolname member_role,
           membership.admin_option, membership.inherit_option, membership.set_option
      from pg_auth_members membership
      join pg_roles granted on granted.oid = membership.roleid
      join pg_roles member on member.oid = membership.member
     where granted.rolname in (
       'learncoding_owner', 'learncoding_migrator', 'learncoding_app',
       'learncoding_worker', 'learncoding_ops'
     )
        or member.rolname in (
          'learncoding_owner', 'learncoding_migrator', 'learncoding_app',
          'learncoding_worker', 'learncoding_ops'
        )
     order by granted.rolname, member.rolname`);
  const membership = memberships.rows[0];
  if (
    memberships.rows.length !== 1 ||
    membership?.granted_role !== OWNER_ROLE ||
    membership?.member_role !== MIGRATOR_ROLE ||
    membership?.admin_option !== false ||
    membership?.inherit_option !== false ||
    membership?.set_option !== true
  ) {
    throw new Error("database role bootstrap invariant verification failed");
  }

  const databaseSettings = await client.query(`
    select count(*)::integer count
      from pg_db_role_setting configured
      join pg_roles roles on roles.oid = configured.setrole
     where roles.rolname in (
       'learncoding_owner', 'learncoding_migrator', 'learncoding_app',
       'learncoding_worker', 'learncoding_ops'
     )`);
  if (databaseSettings.rows[0]?.count !== 0) {
    throw new Error("database role bootstrap invariant verification failed");
  }

  const ownership = await client.query(
    `select
       (select pg_get_userbyid(datdba) = 'learncoding_owner'
          from pg_database where datname = $1) database_owned,
       (select count(*) = 3 and bool_and(pg_get_userbyid(datdba) = $2)
          from pg_database
         where datname in ('postgres', 'template0', 'template1')) canonical_databases_unchanged,
       not exists (
         select 1 from pg_database
          where pg_get_userbyid(datdba) in ($2, 'learncoding_owner')
            and datname not in ($1, 'postgres', 'template0', 'template1')
       ) no_unexpected_owned_database,
       (select count(*) = 2 and bool_and(pg_get_userbyid(spcowner) = $2)
          from pg_tablespace
         where spcname in ('pg_default', 'pg_global')) canonical_tablespaces_unchanged,
       not exists (
         select 1 from pg_tablespace
          where pg_get_userbyid(spcowner) in ($2, 'learncoding_owner')
            and spcname not in ('pg_default', 'pg_global')
       ) no_unexpected_owned_tablespace,
       (select pg_get_userbyid(nspowner) = 'learncoding_owner'
          from pg_namespace where nspname = 'public') public_schema_owned,
       case when exists(select 1 from pg_namespace where nspname = 'drizzle')
         then (select pg_get_userbyid(nspowner) = 'learncoding_owner'
                 from pg_namespace where nspname = 'drizzle')
         else true
       end drizzle_schema_owned,
       not exists (
         select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname in ('public', 'drizzle')
            and c.relkind in ('r', 'p', 'S', 'v', 'm', 'f', 'c', 'i', 'I')
            and pg_get_userbyid(c.relowner) <> 'learncoding_owner'
       ) relations_owned,
       not exists (
         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'drizzle')
            and pg_get_userbyid(p.proowner) <> 'learncoding_owner'
       ) routines_owned,
       not exists (
         select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
          where n.nspname in ('public', 'drizzle')
            and t.typtype in ('c', 'd', 'e', 'm', 'r')
            and pg_get_userbyid(t.typowner) <> 'learncoding_owner'
       ) types_owned`,
    [postgresDatabase, postgresUser],
  );
  if (Object.values(ownership.rows[0] ?? {}).some((value) => value !== true)) {
    throw new Error("database role bootstrap invariant verification failed");
  }

  const privileges = await client.query(
    `select
       not has_database_privilege(0, $1, 'CONNECT') public_connect_revoked,
       not has_database_privilege(0, $1, 'TEMP') public_temp_revoked,
       not has_database_privilege(0, $1, 'CREATE') public_create_revoked,
       has_database_privilege('learncoding_migrator', $1, 'CONNECT') migrator_connect,
       not has_database_privilege('learncoding_migrator', $1, 'TEMP') migrator_no_temp,
       not has_database_privilege('learncoding_migrator', $1, 'CREATE') migrator_no_create,
       not has_schema_privilege('learncoding_migrator', 'public', 'USAGE') migrator_no_schema_usage,
       not has_schema_privilege('learncoding_migrator', 'public', 'CREATE') migrator_no_schema_create,
       not has_schema_privilege(0, 'public', 'USAGE') public_schema_usage_revoked,
       not has_schema_privilege(0, 'public', 'CREATE') public_schema_create_revoked,
       not exists (
         select 1 from unnest(array['learncoding_app','learncoding_worker','learncoding_ops']) role_name
          where not has_database_privilege(role_name, $1, 'CONNECT')
             or has_database_privilege(role_name, $1, 'TEMP')
             or not has_schema_privilege(role_name, 'public', 'USAGE')
             or has_database_privilege(role_name, $1, 'CREATE')
             or has_schema_privilege(role_name, 'public', 'CREATE')
       ) runtime_database_schema_exact,
       case when exists(select 1 from pg_namespace where nspname = 'drizzle')
         then not exists (
           select 1 from unnest(array['learncoding_migrator','learncoding_app','learncoding_worker','learncoding_ops']) role_name
            where has_schema_privilege(role_name, 'drizzle', 'USAGE')
               or has_schema_privilege(role_name, 'drizzle', 'CREATE')
         )
         else true
       end drizzle_restricted,
       not exists (
         select 1
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           cross join unnest(array['learncoding_app','learncoding_ops']) role_name
          where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
            and (
              not has_table_privilege(role_name, c.oid, 'SELECT')
              or not has_table_privilege(role_name, c.oid, 'INSERT')
              or not has_table_privilege(role_name, c.oid, 'UPDATE')
              or not has_table_privilege(role_name, c.oid, 'DELETE')
              or has_table_privilege(role_name, c.oid, 'TRUNCATE')
              or has_table_privilege(role_name, c.oid, 'REFERENCES')
              or has_table_privilege(role_name, c.oid, 'TRIGGER')
              or has_table_privilege(role_name, c.oid, 'MAINTAIN')
            )
       ) table_privileges_exact,
       not exists (
         select 1
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
            and c.relname <> 'email_outbox'
            and (
              not has_table_privilege('learncoding_worker', c.oid, 'SELECT')
              or not has_table_privilege('learncoding_worker', c.oid, 'INSERT')
              or not has_table_privilege('learncoding_worker', c.oid, 'UPDATE')
              or not has_table_privilege('learncoding_worker', c.oid, 'DELETE')
              or has_table_privilege('learncoding_worker', c.oid, 'TRUNCATE')
              or has_table_privilege('learncoding_worker', c.oid, 'REFERENCES')
              or has_table_privilege('learncoding_worker', c.oid, 'TRIGGER')
              or has_table_privilege('learncoding_worker', c.oid, 'MAINTAIN')
            )
       ) worker_other_table_privileges_exact,
       case when to_regclass('public.email_outbox') is null then true
         else
           has_table_privilege(
             'learncoding_worker', 'public.email_outbox', 'SELECT'
           )
           and not has_table_privilege(
             'learncoding_worker', 'public.email_outbox', 'DELETE'
           )
           and not has_table_privilege(
             'learncoding_worker', 'public.email_outbox', 'TRUNCATE'
           )
           and not has_column_privilege(
             'learncoding_worker', 'public.email_outbox', 'variables', 'UPDATE'
           )
           and not has_column_privilege(
             'learncoding_worker', 'public.email_outbox', 'to_email', 'UPDATE'
           )
           and not has_column_privilege(
             'learncoding_worker', 'public.email_outbox', 'template', 'UPDATE'
           )
           and has_column_privilege(
             'learncoding_worker', 'public.email_outbox', 'variables', 'INSERT'
           )
           and has_column_privilege(
             'learncoding_worker', 'public.email_outbox', 'status', 'UPDATE'
           )
           and has_column_privilege(
             'learncoding_worker', 'public.email_outbox', 'updated_at', 'UPDATE'
           )
       end worker_outbox_privileges_exact,
       not exists (
         select 1
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           cross join unnest(array['learncoding_app','learncoding_worker','learncoding_ops']) role_name
          where n.nspname = 'public' and c.relkind = 'S'
            and (
              not has_sequence_privilege(role_name, c.oid, 'USAGE')
              or not has_sequence_privilege(role_name, c.oid, 'SELECT')
              or not has_sequence_privilege(role_name, c.oid, 'UPDATE')
            )
       ) sequence_privileges_exact,
       not exists (
         select 1
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname in ('public', 'drizzle')
            and c.relkind in ('r','p','v','m','f')
            and (
              has_table_privilege('learncoding_migrator', c.oid, 'SELECT')
              or has_table_privilege('learncoding_migrator', c.oid, 'INSERT')
              or has_table_privilege('learncoding_migrator', c.oid, 'UPDATE')
              or has_table_privilege('learncoding_migrator', c.oid, 'DELETE')
              or has_table_privilege('learncoding_migrator', c.oid, 'TRUNCATE')
              or has_table_privilege('learncoding_migrator', c.oid, 'REFERENCES')
              or has_table_privilege('learncoding_migrator', c.oid, 'TRIGGER')
              or has_table_privilege('learncoding_migrator', c.oid, 'MAINTAIN')
            )
       ) migrator_table_restricted,
       not exists (
         select 1
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname in ('public', 'drizzle') and c.relkind = 'S'
            and (
              has_sequence_privilege('learncoding_migrator', c.oid, 'USAGE')
              or has_sequence_privilege('learncoding_migrator', c.oid, 'SELECT')
              or has_sequence_privilege('learncoding_migrator', c.oid, 'UPDATE')
            )
       ) migrator_sequence_restricted,
       not exists (
         select 1
           from pg_type t
           join pg_namespace n on n.oid = t.typnamespace
           cross join unnest(array['learncoding_app','learncoding_worker','learncoding_ops']) role_name
          where n.nspname = 'public'
            and not has_type_privilege(role_name, t.oid, 'USAGE')
       ) runtime_type_usage,
       not exists (
         select 1
           from pg_type t
           join pg_namespace n on n.oid = t.typnamespace
          where n.nspname in ('public', 'drizzle')
            and has_type_privilege('learncoding_migrator', t.oid, 'USAGE')
       ) migrator_type_restricted,
       not exists (
         select 1
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'drizzle')
            and (
              has_function_privilege(0, p.oid, 'EXECUTE')
              or exists (
                select 1
                  from unnest(array['learncoding_migrator','learncoding_app','learncoding_worker','learncoding_ops']) role_name
                 where has_function_privilege(role_name, p.oid, 'EXECUTE')
              )
            )
       ) routine_execute_restricted`,
    [postgresDatabase],
  );
  if (Object.values(privileges.rows[0] ?? {}).some((value) => value !== true)) {
    throw new Error("database role bootstrap invariant verification failed");
  }

  const unexpectedDirectAcls = await client.query(
    `select count(*)::integer count
       from (
         select case when acl.grantee = 0 then 'PUBLIC'
                     else pg_get_userbyid(acl.grantee) end grantee,
                acl.is_grantable = false grant_not_delegable
           from pg_database d
           cross join lateral aclexplode(d.datacl) acl
          where d.datname = $1
         union all
         select case when acl.grantee = 0 then 'PUBLIC'
                     else pg_get_userbyid(acl.grantee) end,
                acl.is_grantable = false
           from pg_namespace n
           cross join lateral aclexplode(n.nspacl) acl
          where n.nspname in ('public', 'drizzle')
         union all
         select case when acl.grantee = 0 then 'PUBLIC'
                     else pg_get_userbyid(acl.grantee) end,
                acl.is_grantable = false
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           cross join lateral aclexplode(c.relacl) acl
          where n.nspname in ('public', 'drizzle')
         union all
         select case when acl.grantee = 0 then 'PUBLIC'
                     else pg_get_userbyid(acl.grantee) end,
                acl.is_grantable = false
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           cross join lateral aclexplode(p.proacl) acl
          where n.nspname in ('public', 'drizzle')
         union all
         select case when acl.grantee = 0 then 'PUBLIC'
                     else pg_get_userbyid(acl.grantee) end,
                acl.is_grantable = false
           from pg_type t
           join pg_namespace n on n.oid = t.typnamespace
           cross join lateral aclexplode(t.typacl) acl
          where n.nspname in ('public', 'drizzle')
       ) direct_acl
      where grantee not in (
        'learncoding_owner', 'learncoding_migrator', 'learncoding_app',
        'learncoding_worker', 'learncoding_ops'
      )
         or not grant_not_delegable`,
    [postgresDatabase],
  );
  if (unexpectedDirectAcls.rows[0]?.count !== 0) {
    throw new Error("database role bootstrap invariant verification failed");
  }

  const defaultAcls = await client.query(`
    select coalesce(n.nspname, '*') schema,
           pg_get_userbyid(a.defaclrole) owner,
           case when privilege.grantee = 0 then 'PUBLIC'
                else pg_get_userbyid(privilege.grantee) end grantee,
           a.defaclobjtype::text kind,
           privilege.privilege_type,
           privilege.is_grantable
      from pg_default_acl a
      left join pg_namespace n on n.oid = a.defaclnamespace
      cross join lateral aclexplode(a.defaclacl) privilege
     where pg_get_userbyid(a.defaclrole) in ($1, 'learncoding_owner')
     order by 1, 2, 3, 4, 5, 6`, [postgresUser]);
  const expectedPrivileges = {
    r: new Set(["DELETE", "INSERT", "SELECT", "UPDATE"]),
    S: new Set(["SELECT", "UPDATE", "USAGE"]),
    T: new Set(["USAGE"]),
  };
  const expectedDefaultPrivilegeKeys = new Set(
    [APP_ROLE, WORKER_ROLE, OPS_ROLE].flatMap((grantee) =>
      Object.entries(expectedPrivileges).flatMap(([kind, privilegesForKind]) =>
        [...privilegesForKind].map(
          (privilege) => `${OWNER_ROLE}|public|${grantee}|${kind}|${privilege}|false`,
        ),
      ),
    ),
  );
  const observedDefaultPrivilegeKeys = new Set();
  let nonOwnerDefaultPrivilegeCount = 0;
  for (const entry of defaultAcls.rows) {
    if (entry.grantee === entry.owner) continue;
    nonOwnerDefaultPrivilegeCount += 1;
    const key = `${entry.owner}|${entry.schema}|${entry.grantee}|${entry.kind}|${entry.privilege_type}|${entry.is_grantable}`;
    if (
      !expectedDefaultPrivilegeKeys.has(key) ||
      observedDefaultPrivilegeKeys.has(key)
    ) {
      throw new Error("database role bootstrap invariant verification failed");
    }
    observedDefaultPrivilegeKeys.add(key);
  }
  if (
    nonOwnerDefaultPrivilegeCount !== expectedDefaultPrivilegeKeys.size ||
    observedDefaultPrivilegeKeys.size !== expectedDefaultPrivilegeKeys.size
  ) {
    throw new Error("database role bootstrap invariant verification failed");
  }

  const remainingSessions = await client.query(
    `select count(*)::integer count from pg_stat_activity
      where usename = any($1::text[]) and pid <> pg_backend_pid()`,
    [LOGIN_ROLES],
  );
  if (remainingSessions.rows[0]?.count !== 0) {
    throw new Error("database role bootstrap invariant verification failed");
  }

  const checks = {
    rolesExact: true,
    membershipsExact: true,
    ownershipExact: true,
    privilegesExact: true,
    defaultPrivilegesExact: true,
    sessionsTerminated: true,
  };
  if (Object.values(checks).some((value) => value !== true)) {
    throw new Error("database role bootstrap invariant verification failed");
  }
  return checks;
}

class DatabaseBootstrapCleanupTimeoutError extends Error {
  constructor(phase) {
    super(`database bootstrap cleanup timed out during ${phase}`);
    this.name = "DatabaseBootstrapCleanupTimeoutError";
  }
}

class DatabaseBootstrapUnlockError extends Error {
  constructor() {
    super("PostgreSQL did not release the database administration lock");
    this.name = "DatabaseBootstrapUnlockError";
  }
}

function normalizeCleanupTimeoutMs(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("database bootstrap cleanup timeout must be positive and finite");
  }
  return Math.min(timeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS);
}

async function boundedCleanupOperation(operation, timeoutMs, phase) {
  const deadline = performance.now() + timeoutMs;
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new DatabaseBootstrapCleanupTimeoutError(phase)),
      timeoutMs,
    );
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(operation),
      timeout,
    ]);
    if (performance.now() >= deadline) {
      throw new DatabaseBootstrapCleanupTimeoutError(phase);
    }
    return result;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

export async function cleanupDatabaseBootstrapResources({
  client,
  pool,
  transactionOpen,
  lockAcquired,
  destroyClient = false,
  timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
}) {
  const boundedTimeoutMs = normalizeCleanupTimeoutMs(timeoutMs);
  let cleanupError;
  let cleanupUnsafe = false;
  let destroy = destroyClient;

  if (client && transactionOpen) {
    try {
      await boundedCleanupOperation(
        () => client.query("rollback"),
        boundedTimeoutMs,
        "rollback",
      );
    } catch (error) {
      cleanupError = error;
      cleanupUnsafe = true;
      destroy = true;
    }
  }

  if (client && lockAcquired && !cleanupUnsafe) {
    try {
      const unlock = await boundedCleanupOperation(
        () => client.query(
          "select pg_advisory_unlock(hashtextextended($1, 0)) released",
          [DATABASE_ADMIN_LOCK_NAME],
        ),
        boundedTimeoutMs,
        "advisory unlock",
      );
      if (unlock.rows[0]?.released !== true) throw new DatabaseBootstrapUnlockError();
    } catch (error) {
      cleanupError ??= error;
      destroy = true;
    }
  }

  if (client) {
    try {
      client.release(destroy || undefined);
    } catch (error) {
      cleanupError ??= error;
    }
  }

  try {
    await boundedCleanupOperation(
      () => pool.end(),
      boundedTimeoutMs,
      "pool shutdown",
    );
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError) throw cleanupError;
}

export async function runDatabaseRoleBootstrap(options) {
  const parsed = validateDatabaseRoleUrls(options);
  const cleanupTimeoutMs = normalizeCleanupTimeoutMs(
    options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
  );
  const pool = options.pool ?? new Pool({ connectionString: parsed.bootstrap.connectionString, max: 1 });
  let client;
  let lockAcquired = false;
  let transactionOpen = false;
  let destroyClient = false;

  try {
    client = await pool.connect();
    const identity = await client.query(
      `select current_user, current_database(), rolsuper
         from pg_roles
        where rolname = current_user`,
    );
    const identityRow = identity.rows[0];
    if (
      identityRow?.current_user !== options.postgresUser ||
      identityRow?.current_database !== options.postgresDatabase ||
      identityRow?.rolsuper !== true
    ) {
      throw new Error("database bootstrap authority verification failed");
    }

    await acquireAdministrationLock(client, options.lockTimeoutMs);
    lockAcquired = true;
    await client.query("begin");
    transactionOpen = true;
    const inventory = await loadOwnershipInventory(
      client,
      options.postgresUser,
      options.postgresDatabase,
    );
    validateOwnershipInventory(inventory);
    await createAndResetRoles(client);
    const rolePasswords = {
      [MIGRATOR_ROLE]: parsed.migrator,
      [APP_ROLE]: parsed.app,
      [WORKER_ROLE]: parsed.worker,
      [OPS_ROLE]: parsed.ops,
    };
    await rotatePasswords(client, rolePasswords);
    await transferApplicationOwnership(client);
    await reconcilePrivileges(client);
    await verifyInvariants(client, options.postgresDatabase, options.postgresUser);
    if (options.beforeCommit) await options.beforeCommit(client);
    await client.query("commit");
    transactionOpen = false;

    return await verifyInvariants(client, options.postgresDatabase, options.postgresUser);
  } catch (error) {
    destroyClient = true;
    throw error;
  } finally {
    await cleanupDatabaseBootstrapResources({
      client,
      pool,
      transactionOpen,
      lockAcquired,
      destroyClient,
      timeoutMs: cleanupTimeoutMs,
    });
  }
}

async function main() {
  const checks = await runDatabaseRoleBootstrap({
    postgresUser: process.env.POSTGRES_USER ?? "",
    postgresDatabase: process.env.POSTGRES_DB ?? "",
    databaseBootstrapUrl: process.env.DATABASE_BOOTSTRAP_URL ?? "",
    databaseAppUrl: process.env.DATABASE_APP_URL ?? "",
    databaseMigratorUrl: process.env.DATABASE_MIGRATOR_URL ?? "",
    databaseWorkerUrl: process.env.DATABASE_WORKER_URL ?? "",
    databaseOpsUrl: process.env.DATABASE_OPS_URL ?? "",
  });
  console.info(
    JSON.stringify({
      event: "database.roles_bootstrapped",
      roles: [OWNER_ROLE, MIGRATOR_ROLE, APP_ROLE, WORKER_ROLE, OPS_ROLE],
      checks,
    }),
  );
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        event: "database.role_bootstrap_failed",
        code: error instanceof Error ? error.name : "UNKNOWN",
      }),
    );
    process.exitCode = 1;
  });
}
