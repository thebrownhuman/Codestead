import assert from "node:assert/strict";

import { Client, Pool } from "pg";

import {
  DATABASE_ADMIN_LOCK_NAME,
  runDatabaseRoleBootstrap,
} from "../../scripts/bootstrap-database-roles.mjs";

const bootstrapUser = process.env.POSTGRES_USER ?? "legacy_bootstrap";
const bootstrapPassword = process.env.POSTGRES_PASSWORD ?? "bootstrap-Fake-A-0000000000000000";
const host = process.env.POSTGRES_HOST ?? "postgres";

function secret(role, generation) {
  return `${role}-${generation}-${"x".repeat(40)}`;
}

function url(username, password, database) {
  return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:5432/${database}`;
}

function options(database, generation) {
  return {
    postgresUser: bootstrapUser,
    postgresDatabase: database,
    databaseBootstrapUrl: url(bootstrapUser, bootstrapPassword, database),
    databaseAppUrl: url("learncoding_app", secret("app", generation), database),
    databaseMigratorUrl: url("learncoding_migrator", secret("migrator", generation), database),
    databaseWorkerUrl: url("learncoding_worker", secret("worker", generation), database),
    databaseOpsUrl: url("learncoding_ops", secret("ops", generation), database),
    lockTimeoutMs: 10_000,
    cleanupTimeoutMs: 5_000,
  };
}

async function withClient(connectionString, operation) {
  const client = new Client({ connectionString });
  client.on("error", () => undefined);
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

const controlUrl = url(bootstrapUser, bootstrapPassword, "learncoding");
const control = new Pool({ connectionString: controlUrl, max: 1 });

function quoteIdentifier(value) {
  assert.match(value, /^[a-z][a-z0-9_]{0,62}$/u);
  return `"${value}"`;
}

async function databaseSnapshot(database) {
  return withClient(url(bootstrapUser, bootstrapPassword, database), async (client) => {
    const databaseOwner = await client.query(
      "select datname, pg_get_userbyid(datdba) owner, datacl::text from pg_database where datname = current_database()",
    );
    const schemas = await client.query(
      "select nspname, pg_get_userbyid(nspowner) owner, nspacl::text from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema' order by nspname",
    );
    const relations = await client.query(
      "select n.nspname, c.relname, c.relkind::text, pg_get_userbyid(c.relowner) owner, c.relacl::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' order by 1,2,3",
    );
    const routines = await client.query(
      "select n.nspname, p.proname, p.prokind::text, pg_get_userbyid(p.proowner) owner, p.proacl::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' order by 1,2,3",
    );
    const roles = await client.query(
      "select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls, rolconnlimit from pg_roles where rolname like 'learncoding_%' order by rolname",
    );
    const memberships = await client.query(
      "select granted.rolname granted_role, member.rolname member_role, membership.admin_option, membership.inherit_option, membership.set_option from pg_auth_members membership join pg_roles granted on granted.oid=membership.roleid join pg_roles member on member.oid=membership.member where granted.rolname like 'learncoding_%' or member.rolname like 'learncoding_%' order by 1,2",
    );
    return JSON.stringify([
      databaseOwner.rows,
      schemas.rows,
      relations.rows,
      routines.rows,
      roles.rows,
      memberships.rows,
    ]);
  });
}

async function scenario(name, operation) {
  await operation();
  process.stdout.write(`database_acceptance=${name}:pass\n`);
}

try {
  const freshV1 = options("learncoding", "fresh-v1");
  await scenario("fresh", async () => {
    const checks = await runDatabaseRoleBootstrap(freshV1);
    assert.deepEqual(Object.values(checks), [true, true, true, true, true, true]);
  });

  await scenario("idempotent", async () => {
    await runDatabaseRoleBootstrap(freshV1);
  });

  await withClient(url(bootstrapUser, bootstrapPassword, "learncoding"), async (client) => {
    await client.query(`
      create schema drizzle authorization ${quoteIdentifier(bootstrapUser)};
      create type public.lesson_state as enum ('draft', 'published');
      create table public.lesson (
        id bigint generated always as identity primary key,
        state public.lesson_state not null default 'draft'
      );
      create sequence public.audit_sequence;
      create function public.identity_int(value integer) returns integer
        language sql immutable as 'select value';
      create aggregate public.total_int(integer) (
        sfunc = pg_catalog.int4pl,
        stype = integer,
        initcond = '0'
      );
      create table public.tenant_record (tenant text not null, value text not null);
      alter table public.tenant_record enable row level security;
      create policy tenant_isolation on public.tenant_record
        using (tenant = current_user)
        with check (tenant = current_user);
      insert into public.tenant_record values
        ('learncoding_app', 'app-visible'),
        ('learncoding_worker', 'worker-visible');
      alter default privileges for role learncoding_owner in schema public
        grant select on tables to learncoding_app with grant option;
    `);
  });

  const legacyV1 = options("learncoding", "legacy-v1");
  await scenario("legacy-data-rich", async () => {
    await runDatabaseRoleBootstrap(legacyV1);
    await withClient(url(bootstrapUser, bootstrapPassword, "learncoding"), async (client) => {
      const ownership = await client.query(`
        select
          (select pg_get_userbyid(proowner) from pg_proc where proname='total_int' and prokind='a') aggregate_owner,
          (select pg_get_userbyid(relowner) from pg_class where relname='lesson' and relkind='r') table_owner,
          (select pg_get_userbyid(typowner) from pg_type where typname='lesson_state') type_owner
      `);
      assert.deepEqual(ownership.rows[0], {
        aggregate_owner: "learncoding_owner",
        table_owner: "learncoding_owner",
        type_owner: "learncoding_owner",
      });
    });
  });

  await scenario("restricted-roles-rls-and-future-grants", async () => {
    await withClient(legacyV1.databaseAppUrl, async (app) => {
      assert.deepEqual(
        (await app.query("select value from public.tenant_record order by value")).rows,
        [{ value: "app-visible" }],
      );
      await app.query("insert into public.tenant_record values ('learncoding_app', 'app-created')");
      await assert.rejects(
        app.query("insert into public.tenant_record values ('learncoding_worker', 'forbidden')"),
      );
      await assert.rejects(app.query("create table public.forbidden(id integer)"));
      await assert.rejects(app.query("create role forbidden_role"));
      await assert.rejects(app.query("select public.identity_int(1)"));
    });
    await withClient(legacyV1.databaseMigratorUrl, async (migrator) => {
      await assert.rejects(migrator.query("select * from public.lesson"));
      await migrator.query("set role learncoding_owner");
      await migrator.query(`
        create table public.future_table(id bigint generated always as identity primary key);
        create type public.future_state as enum ('ready');
      `);
      await migrator.query("reset role");
    });
    await withClient(legacyV1.databaseAppUrl, async (app) => {
      await app.query("insert into public.future_table default values returning id");
      await app.query("select 'ready'::public.future_state");
    });
  });

  await scenario("password-rotation-and-session-termination", async () => {
    const oldSession = new Client({ connectionString: legacyV1.databaseAppUrl });
    oldSession.on("error", () => undefined);
    await oldSession.connect();
    await oldSession.query("select 1");
    const legacyV2 = options("learncoding", "legacy-v2");
    await runDatabaseRoleBootstrap(legacyV2);
    await assert.rejects(oldSession.query("select 1"));
    await oldSession.end().catch(() => undefined);
    await withClient(legacyV2.databaseAppUrl, (client) => client.query("select 1"));
    const stale = new Client({ connectionString: legacyV1.databaseAppUrl });
    stale.on("error", () => undefined);
    await assert.rejects(stale.connect());
    await stale.end().catch(() => undefined);
  });

  await control.query(`
    alter role learncoding_app createdb inherit;
    alter role learncoding_app set search_path = public;
    grant learncoding_app to learncoding_worker with admin option;
  `);
  await scenario("partial-rollout-reconciliation", async () => {
    await runDatabaseRoleBootstrap(options("learncoding", "partial-v1"));
  });

  await scenario("shared-lock-timeout-and-concurrency", async () => {
    await withClient(url(bootstrapUser, bootstrapPassword, "learncoding"), async (lockHolder) => {
      const ownerBefore = await lockHolder.query(
        "select pg_get_userbyid(datdba) owner from pg_database where datname=current_database()",
      );
      await lockHolder.query(
        "select pg_advisory_lock(hashtextextended($1, 0))",
        [DATABASE_ADMIN_LOCK_NAME],
      );
      await assert.rejects(
        runDatabaseRoleBootstrap({
          ...options("learncoding", "lock-v1"),
          lockTimeoutMs: 100,
        }),
        /database administration lock timeout/u,
      );
      const ownerAfter = await lockHolder.query(
        "select pg_get_userbyid(datdba) owner from pg_database where datname=current_database()",
      );
      assert.equal(ownerAfter.rows[0]?.owner, ownerBefore.rows[0]?.owner);
      await lockHolder.query(
        "select pg_advisory_unlock(hashtextextended($1, 0))",
        [DATABASE_ADMIN_LOCK_NAME],
      );
    });
    const concurrent = options("learncoding", "lock-v2");
    await Promise.all([
      runDatabaseRoleBootstrap(concurrent),
      runDatabaseRoleBootstrap(concurrent),
    ]);
  });

  await withClient(url(bootstrapUser, bootstrapPassword, "learncoding"), (client) =>
    client.query("create table public.rollback_probe(id integer)"));
  await scenario("rollback-injection", async () => {
    const before = await databaseSnapshot("learncoding");
    await assert.rejects(
      runDatabaseRoleBootstrap({
        ...options("learncoding", "rollback-v1"),
        beforeCommit: async () => {
          throw new Error("injected rollback");
        },
      }),
      /injected rollback/u,
    );
    assert.equal(await databaseSnapshot("learncoding"), before);
    await runDatabaseRoleBootstrap(options("learncoding", "rollback-v2"));
  });

  await control.query("create role legacy_reader nologin");
  await withClient(url(bootstrapUser, bootstrapPassword, "learncoding"), async (client) => {
    await client.query(`
      create schema decoy authorization ${quoteIdentifier(bootstrapUser)};
      create table public.protected_table(id integer);
      grant select on public.protected_table to legacy_reader;
    `);
  });
  await scenario("decoy-fails-before-mutation", async () => {
    const before = await databaseSnapshot("learncoding");
    await assert.rejects(
      runDatabaseRoleBootstrap(options("learncoding", "decoy-v1")),
      /^Error: unsafe legacy ownership inventory$/u,
    );
    assert.equal(await databaseSnapshot("learncoding"), before);
  });
} finally {
  await control.end();
}
