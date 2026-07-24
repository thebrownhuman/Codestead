import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import pg, { type PoolClient } from "pg";

import { minimalNodeTestEnvironment } from "./lib/disposable-integration-environment";
import {
  migrationJournalEntryCount,
  runDisposableIntegrationReleaseCycles,
} from "./lib/disposable-integration-topology";
import {
  type DisposableRoleUrls,
  verifyDisposableIntegrationRoleBoundaries as verifyDisposableRoleBoundaryAdapter,
} from "./lib/disposable-role-boundary-adapter";

const { Client, Pool } = pg;

type RoleBootstrapRunner = (options: {
  readonly postgresUser: string;
  readonly postgresDatabase: string;
  readonly databaseBootstrapUrl: string;
  readonly databaseAppUrl: string;
  readonly databaseMigratorUrl: string;
  readonly databaseWorkerUrl: string;
  readonly databaseOpsUrl: string;
  readonly lockTimeoutMs: number;
  readonly cleanupTimeoutMs: number;
  readonly pool: InstanceType<typeof Pool>;
}) => Promise<unknown>;

type RoleBootstrapStateVerifier = (
  client: PoolClient,
  postgresDatabase: string,
  postgresUser: string,
) => Promise<unknown>;

type ProductionMigrationRunner = (options: {
  readonly connectionString: string;
  readonly migrationsFolder: string;
}) => Promise<void>;

type RoleBoundaryVerifier = (options: {
  readonly postgresDatabase: string;
  readonly databaseAppUrl: string;
  readonly databaseMigratorUrl: string;
  readonly databaseWorkerUrl: string;
  readonly databaseOpsUrl: string;
  readonly requireApplicationObjects: boolean;
  readonly lockTimeoutMs: number;
  readonly poolFactory: (input: Readonly<{
    connectionString: string;
    database: string;
    role: string;
  }>) => InstanceType<typeof Pool>;
}) => Promise<unknown>;

type DisposableRoleCredentials = Readonly<{
  bootstrap: string;
  app: string;
  migrator: string;
  worker: string;
  ops: string;
}>;

function executable(name: "docker" | "npm") {
  if (process.platform !== "win32") return name;
  return name === "npm" ? "npm.cmd" : "docker.exe";
}

function run(
  command: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly quiet?: boolean } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: process.cwd(),
      env: options.env ?? process.env,
      stdio: options.quiet ? "ignore" : "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal ?? "unknown"}.`));
    });
  });
}

function runNpm(args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  const npmCli = process.env.npm_execpath;
  if (npmCli) return run(process.execPath, [npmCli, ...args], { env });
  return run(executable("npm"), args, { env });
}

function sanitizedIntegrationEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => {
      const normalized = name.toUpperCase();
      return !normalized.startsWith("PG")
        && !normalized.includes("PASSWORD")
        && !(
          normalized.startsWith("DATABASE_")
          && (normalized.endsWith("_URL") || normalized.endsWith("_FILE"))
        );
    }),
  ) as NodeJS.ProcessEnv;
}

function generatedPassword() {
  return randomBytes(32).toString("base64url");
}

function databaseRoleUrl(input: {
  username: string;
  password: string;
  hostname: string;
  port: number;
  database: string;
}) {
  return `postgresql://${encodeURIComponent(input.username)}:`
    + `${encodeURIComponent(input.password)}@${input.hostname}:`
    + `${input.port}/${encodeURIComponent(input.database)}`;
}

function disposableRoleUrls(
  port: number,
  database: string,
  credentials: DisposableRoleCredentials,
): DisposableRoleUrls {
  const loopback = (username: string, password: string) =>
    databaseRoleUrl({
      username,
      password,
      hostname: "127.0.0.1",
      port,
      database,
    });
  return {
    app: loopback("learncoding_app", credentials.app),
    migrator: loopback("learncoding_migrator", credentials.migrator),
    worker: loopback("learncoding_worker", credentials.worker),
    ops: loopback("learncoding_ops", credentials.ops),
  };
}

async function verifyDisposableIntegrationRoleBoundaries(input: {
  database: string;
  roleUrls: DisposableRoleUrls;
  requireApplicationObjects: boolean;
}) {
  const modulePath = "./verify-database-role-boundaries.mjs";
  const { verifyDatabaseRoleBoundaries } = await import(
    /* @vite-ignore */ modulePath
  ) as { verifyDatabaseRoleBoundaries: RoleBoundaryVerifier };
  await verifyDisposableRoleBoundaryAdapter({
    ...input,
    verifyDatabaseRoleBoundaries,
    createPool: (options) => new Pool(options),
  });
}

async function reconcileDisposableIntegrationRoles(input: {
  databaseUrl: string;
  integrationUser: string;
  database: string;
  credentials: DisposableRoleCredentials;
}) {
  const modulePath = "./bootstrap-database-roles.mjs";
  const { runDatabaseRoleBootstrap } = await import(
    /* @vite-ignore */ modulePath
  ) as { runDatabaseRoleBootstrap: RoleBootstrapRunner };
  const canonical = (username: string, password: string) =>
    databaseRoleUrl({
      username,
      password,
      hostname: "postgres",
      port: 5432,
      database: input.database,
    });
  const pool = new Pool({ connectionString: input.databaseUrl, max: 1 });
  await runDatabaseRoleBootstrap({
    postgresUser: input.integrationUser,
    postgresDatabase: input.database,
    databaseBootstrapUrl: canonical(
      input.integrationUser,
      input.credentials.bootstrap,
    ),
    databaseAppUrl: canonical("learncoding_app", input.credentials.app),
    databaseMigratorUrl: canonical(
      "learncoding_migrator",
      input.credentials.migrator,
    ),
    databaseWorkerUrl: canonical(
      "learncoding_worker",
      input.credentials.worker,
    ),
    databaseOpsUrl: canonical("learncoding_ops", input.credentials.ops),
    lockTimeoutMs: 10_000,
    cleanupTimeoutMs: 5_000,
    pool,
  });
}

function ownerAssumingDatabaseUrl(migratorUrl: string) {
  const url = new URL(migratorUrl);
  url.searchParams.set("options", "-c role=learncoding_owner");
  return url.href;
}

async function verifyDisposableIntegrationTopology(input: {
  databaseUrl: string;
  integrationUser: string;
  database: string;
}) {
  const modulePath = "./bootstrap-database-roles.mjs";
  const { verifyDatabaseRoleBootstrapState } = await import(
    /* @vite-ignore */ modulePath
  ) as {
    verifyDatabaseRoleBootstrapState: RoleBootstrapStateVerifier;
  };
  const pool = new Pool({ connectionString: input.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    const identity = await client.query<{
      current_user: string;
      current_database: string;
      rolsuper: boolean;
    }>(`
      select current_user, current_database(), roles.rolsuper
        from pg_catalog.pg_roles roles
       where roles.rolname = current_user
    `);
    const identityRow = identity.rows[0];
    if (
      identityRow?.current_user !== input.integrationUser
      || identityRow.current_database !== input.database
      || identityRow.rolsuper !== true
    ) {
      throw new Error("disposable integration verifier authority mismatch");
    }
    await verifyDatabaseRoleBootstrapState(
      client,
      input.database,
      input.integrationUser,
    );
    const result = await client.query<{
      fingerprint: string;
      journal_count: number;
    }>(`
      select pg_catalog.md5(
        coalesce((
          select pg_catalog.string_agg(
            journal.id::text || ':' || journal.hash || ':' ||
              journal.created_at::text,
            '|' order by journal.id
          )
            from drizzle.__drizzle_migrations journal
        ), '') || E'\\n' ||
        coalesce((
          select pg_catalog.string_agg(
            routine.oid::text || ':' ||
              pg_catalog.pg_get_userbyid(routine.proowner) || ':' ||
              coalesce(routine.proacl::text, '') || ':' ||
              pg_catalog.md5(routine.prosrc),
            '|' order by routine.oid
          )
            from pg_catalog.pg_proc routine
           where routine.pronamespace = 'public'::pg_catalog.regnamespace
             and routine.proname in (
               'enforce_email_outbox_payload_immutable',
               'redact_unresolved_email_outbox_authority'
             )
        ), '') || E'\\n' ||
        coalesce((
          select pg_catalog.string_agg(
            attribute.attname || ':' || coalesce(attribute.attacl::text, ''),
            '|' order by attribute.attnum
          )
            from pg_catalog.pg_attribute attribute
           where attribute.attrelid = 'public.email_outbox'::pg_catalog.regclass
             and attribute.attnum > 0
             and not attribute.attisdropped
        ), '')
      ) fingerprint,
      (select pg_catalog.count(*)::integer
         from drizzle.__drizzle_migrations) journal_count
    `);
    return result.rows[0];
  } finally {
    client.release();
    await pool.end();
  }
}

async function runDisposableIntegrationMigration(connectionString: string) {
  const modulePath = "./migrate-production.mjs";
  const { runProductionMigration } = await import(
    /* @vite-ignore */ modulePath
  ) as { runProductionMigration: ProductionMigrationRunner };
  await runProductionMigration({
    connectionString,
    migrationsFolder: path.resolve(process.cwd(), "drizzle"),
  });
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port."));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForPostgres(connectionString: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`PostgreSQL did not become ready: ${String(lastError)}`);
}

async function expectedMigrationJournalCount(): Promise<number> {
  const source = await readFile(
    path.resolve(process.cwd(), "drizzle/meta/_journal.json"),
    "utf8",
  );
  let journal: unknown;
  try {
    journal = JSON.parse(source) as unknown;
  } catch {
    throw new Error("disposable integration migration journal validation failed");
  }
  return migrationJournalEntryCount(journal);
}

async function main() {
  const requestedTests = process.argv.slice(2);
  for (const requested of requestedTests) {
    if (!/^integration\/[a-z0-9-]+\.integration\.test\.ts$/.test(requested.replaceAll("\\", "/"))) {
      throw new Error(`Integration test path is not allowlisted: ${requested}`);
    }
  }
  const expectedJournalCount = await expectedMigrationJournalCount();
  await run(process.execPath, [
    "--test",
    path.resolve(process.cwd(), "scripts/database-role-boundaries.test.mjs"),
  ], {
    env: minimalNodeTestEnvironment(process.env),
  });

  const docker = executable("docker");
  const dockerCheck = spawnSync(docker, ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (dockerCheck.status !== 0) {
    throw new Error(
      "Docker is required for test:integration. Start Docker and grant this process access to its daemon. " +
      (dockerCheck.stderr || dockerCheck.error?.message || "Docker server was unavailable."),
    );
  }

  const suffix = randomBytes(6).toString("hex");
  const containerName = `learncoding-postgres-it-${suffix}`;
  const password = randomBytes(24).toString("base64url");
  const integrationUser = "learncoding_it";
  const database = "learncoding_integration";
  const roleCredentials: DisposableRoleCredentials = Object.freeze({
    bootstrap: password,
    app: generatedPassword(),
    migrator: generatedPassword(),
    worker: generatedPassword(),
    ops: generatedPassword(),
  });
  const port = await availablePort();
  const image = process.env.INTEGRATION_POSTGRES_IMAGE ??
    "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";
  const databaseUrl = databaseRoleUrl({
    username: integrationUser, password, hostname: "127.0.0.1", port, database,
  });
  const roleUrls = disposableRoleUrls(port, database, roleCredentials);
  let started = false;

  const cleanup = () => {
    if (!started) return;
    spawnSync(docker, ["rm", "--force", containerName], {
      stdio: "ignore",
      windowsHide: true,
    });
    started = false;
  };

  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  try {
    await run(docker, [
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--label",
      "com.learncoding.purpose=disposable-integration-test",
      "--publish",
      `127.0.0.1:${port}:5432`,
      "--tmpfs",
      "/var/lib/postgresql/data:rw,nosuid,nodev,size=512m",
      "--env",
      `POSTGRES_DB=${database}`,
      "--env",
      `POSTGRES_USER=${integrationUser}`,
      "--env",
      "POSTGRES_PASSWORD",
      image,
    ], {
      env: {
        ...sanitizedIntegrationEnvironment(process.env),
        POSTGRES_PASSWORD: password,
      },
    });
    started = true;
    await waitForPostgres(databaseUrl);

    const testEnv = {
      ...sanitizedIntegrationEnvironment(process.env),
      DATABASE_APP_URL: roleUrls.app,
      DATABASE_MIGRATOR_URL: roleUrls.migrator,
      DATABASE_WORKER_URL: roleUrls.worker,
      DATABASE_OPS_URL: roleUrls.ops,
      DATABASE_URL: ownerAssumingDatabaseUrl(roleUrls.migrator),
      DATABASE_POOL_SIZE: "8",
      NODE_ENV: "test" as const,
      BETTER_AUTH_SECRET: "integration-only-secret-never-for-production",
      INTEGRATION_TEST: "1",
    };
    const topology = {
      databaseUrl,
      integrationUser,
      database,
      credentials: roleCredentials,
    };
    // Mirror two complete releases, including negative probes before each
    // migration and application-object boundary verification after reconciliation.
    await runDisposableIntegrationReleaseCycles({
      expectedJournalCount,
      reconcileRoles: () => reconcileDisposableIntegrationRoles(topology),
      verifyRoleBoundaries: (requireApplicationObjects) => (
        verifyDisposableIntegrationRoleBoundaries({
          database,
          roleUrls,
          requireApplicationObjects,
        })
      ),
      migrate: () => runDisposableIntegrationMigration(roleUrls.migrator),
      verifyTopology: () => verifyDisposableIntegrationTopology(topology),
      onPhase: (phase) => {
        console.info(JSON.stringify({
          event: "integration.topology",
          phase,
        }));
      },
    });

    await runNpm([
      "run",
      "test:integration:vitest",
      ...(requestedTests.length > 0 ? ["--", ...requestedTests] : []),
    ], testEnv);
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
