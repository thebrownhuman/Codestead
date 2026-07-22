import process from "node:process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

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
]);
const RUNTIME_ROLES = new Set(["learncoding_app", "learncoding_worker", "learncoding_ops"]);

export class DatabaseRoleBoundaryError extends Error {
  constructor() {
    super("database role boundary verification failed");
    this.name = "DatabaseRoleBoundaryError";
  }
}

function fail() {
  throw new DatabaseRoleBoundaryError();
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
      ) fail();
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

function quoteIdentifier(value) {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) fail();
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
        timer = setTimeout(() => reject(new DatabaseRoleBoundaryError()), timeoutMs);
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
    await new Promise((resolve) => setTimeout(
      resolve,
      Math.min(LOCK_POLL_MS, Math.max(1, deadline - performance.now())),
    ));
  }
  fail();
}

async function releaseAdministrationLock(client) {
  const result = await bounded(() => client.query(
    "select pg_advisory_unlock(hashtextextended($1, 0)) released",
    [DATABASE_ADMIN_LOCK_NAME],
  ));
  if (result.rows[0]?.released !== true) fail();
}

async function expectInsufficientPrivilege(client, sql) {
  await client.query("begin");
  try {
    try {
      await client.query(sql);
      fail();
    } catch (error) {
      if (error instanceof DatabaseRoleBoundaryError || error?.code !== "42501") fail();
    }
  } finally {
    await bounded(() => client.query("rollback"));
  }
}

async function discoverApplicationObjects(client) {
  const table = await client.query(`
    select n.nspname schema_name, c.relname object_name, a.attname column_name
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
  return { table: table.rows[0], sequence: sequence.rows[0], type: type.rows[0] };
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
    await client.query(`select last_value from ${qualifiedName(objects.sequence)}`);
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
  const identity = await client.query("select current_user, session_user, current_database()");
  if (!exactRow(identity.rows[0], {
    current_user: role,
    session_user: role,
    current_database: database,
  })) fail();
  positiveChecks += 1;

  const flags = await client.query(`
    select rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolreplication, rolbypassrls
      from pg_roles
     where rolname = current_user`);
  if (!exactRow(flags.rows[0], {
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolcanlogin: true,
    rolreplication: false,
    rolbypassrls: false,
  })) fail();
  positiveChecks += 1;

  const privileges = await client.query(`
    select has_database_privilege(current_user, current_database(), 'CONNECT') connect_allowed,
           has_database_privilege(current_user, current_database(), 'TEMP') temp_allowed,
           has_database_privilege(current_user, current_database(), 'CREATE') create_allowed,
           has_schema_privilege(current_user, 'public', 'USAGE') schema_usage,
           has_schema_privilege(current_user, 'public', 'CREATE') schema_create`);
  if (!exactRow(privileges.rows[0], {
    connect_allowed: true,
    temp_allowed: false,
    create_allowed: false,
    schema_usage: role !== "learncoding_migrator",
    schema_create: false,
  })) fail();
  positiveChecks += 1;

  await expectInsufficientPrivilege(client, "create role codestead_forbidden_role_boundary");
  negativeChecks += 1;
  await expectInsufficientPrivilege(
    client,
    "create table public.codestead_forbidden_table_boundary (id integer)",
  );
  negativeChecks += 1;
  await expectInsufficientPrivilege(client, `grant learncoding_owner to ${quoteIdentifier(role)}`);
  negativeChecks += 1;

  if (RUNTIME_ROLES.has(role)) {
    await expectInsufficientPrivilege(client, "set role learncoding_owner");
    negativeChecks += 1;
    if (objects) positiveChecks += await verifyApplicationObjectAccess(client, objects);
  } else {
    await client.query("begin read only");
    try {
      await client.query("set local role learncoding_owner");
      const delegated = await client.query("select current_user, session_user");
      if (!exactRow(delegated.rows[0], {
        current_user: "learncoding_owner",
        session_user: "learncoding_migrator",
      })) fail();
      positiveChecks += 1;
    } finally {
      await bounded(() => client.query("rollback"));
    }
  }

  if (objects) {
    const table = qualifiedName(objects.table);
    await expectInsufficientPrivilege(client, `alter table ${table} owner to ${quoteIdentifier(role)}`);
    negativeChecks += 1;
    await expectInsufficientPrivilege(client, `grant select on table ${table} to ${quoteIdentifier(role)}`);
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
    const objects = requireApplicationObjects
      ? await discoverApplicationObjects(lockClient)
      : undefined;
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
      try { await releaseAdministrationLock(lockClient); } catch { cleanupFailed = true; }
    }
    for (const { client, pool } of [...resources.values()].reverse()) {
      try { client?.release(cleanupFailed || undefined); } catch { cleanupFailed = true; }
      try { await bounded(() => pool.end()); } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) fail();
  }
}

function parseArguments(argv) {
  if (argv.length === 0) return false;
  if (argv.length === 1 && argv[0] === "--require-application-objects") return true;
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
    requireApplicationObjects,
  });
  process.stdout.write(`${JSON.stringify({
    event: "database.role_boundaries_verified",
    mode: requireApplicationObjects ? "application-objects" : "pre-migration",
    ...result,
  })}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      event: "database.role_boundary_verification_failed",
      code: error instanceof Error ? error.name : "UNKNOWN",
    })}\n`);
    process.exitCode = 1;
  });
}
