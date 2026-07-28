import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import pg, { type PoolClient } from "pg";

import { buildDisposableIntegrationChildLaunch } from
  "./lib/disposable-integration-child-launch";
import {
  createDisposableIntegrationChildController,
  type DisposableIntegrationChildController,
} from "./lib/disposable-integration-child-controller";
import { runWithDisposableIntegrationHarness } from
  "./lib/disposable-integration-harness";
import {
  buildDisposableIntegrationRuntimeEnvironment,
  createIntegrationFailureReporter,
  createIntegrationOutputSanitizer,
} from "./lib/disposable-integration-runtime";
import { allocateDisposableLoopbackPort } from
  "./lib/disposable-loopback-port.mjs";
import { withDisposableIntegrationReset } from
  "./lib/disposable-integration-reset";
import { buildDisposableToolEnvironment } from
  "./lib/disposable-tool-environment";
import {
  migrationJournalEntryCount,
  runDisposableIntegrationReleaseCycles,
} from "./lib/disposable-integration-topology";
import {
  type DisposableRoleUrls,
  verifyDisposableIntegrationRoleBoundaries as verifyDisposableRoleBoundaryAdapter,
} from "./lib/disposable-role-boundary-adapter";

const { Client, Pool } = pg;
const failureReporter = createIntegrationFailureReporter({
  write: (value) => process.stderr.write(value),
});

type RoleBootstrapRunner = (options: {
  readonly postgresUser: string;
  readonly postgresDatabase: string;
  readonly databaseBootstrapUrl: string;
  readonly databaseAppUrl: string;
  readonly databaseMigratorUrl: string;
  readonly databaseWorkerUrl: string;
  readonly databaseOpsUrl: string;
  readonly databaseBackupReporterUrl: string;
  readonly lockTimeoutMs: number;
  readonly cleanupTimeoutMs: number;
  readonly pool: InstanceType<typeof Pool>;
}) => Promise<unknown>;

type ReviewedCatalogPhaseResolver = (
  client: PoolClient,
) => Promise<unknown>;

type RoleBootstrapStateVerifier = (
  client: PoolClient,
  postgresDatabase: string,
  postgresUser: string,
  phase: unknown,
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
  backupReporter: string;
}>;

function executable(name: "docker" | "npm") {
  if (process.platform !== "win32") return name;
  return name === "npm" ? "npm.cmd" : "docker.exe";
}

function run(
  command: string,
  args: readonly string[],
  options: {
    readonly childController: DisposableIntegrationChildController;
    readonly env: NodeJS.ProcessEnv;
    readonly quiet?: boolean;
    readonly secrets: readonly string[];
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stdoutSanitizer = options.quiet
      ? undefined
      : createIntegrationOutputSanitizer({
        secrets: options.secrets,
        write: (value) => process.stdout.write(value),
      });
    const stderrSanitizer = options.quiet
      ? undefined
      : createIntegrationOutputSanitizer({
        secrets: options.secrets,
        write: (value) => process.stderr.write(value),
      });
    const launch = buildDisposableIntegrationChildLaunch({
      command,
      args,
      environment: options.env,
    });
    const tracked = options.childController.spawnAndTrack(() => spawn(
      launch.command,
      [...launch.args],
      {
        cwd: process.cwd(),
        detached: launch.detached,
        env: launch.environment,
        stdio: options.quiet ? "ignore" : ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    ));
    const { child, completeAndWait } = tracked;
    child.stdout?.on("data", (value: Uint8Array) => {
      stdoutSanitizer?.write(value);
    });
    child.stderr?.on("data", (value: Uint8Array) => {
      stderrSanitizer?.write(value);
    });
    let spawnFailed = false;
    child.once("error", () => {
      spawnFailed = true;
    });
    child.once("close", (code, signal) => {
      void (async () => {
        stdoutSanitizer?.end();
        stderrSanitizer?.end();
        const childSignal = signal === "SIGINT" ? "SIGINT" : "SIGTERM";
        try {
          await completeAndWait(childSignal);
        } catch {
          reject(new Error(
            "Disposable integration child tree cleanup failed.",
          ));
          return;
        }
        if (!spawnFailed && code === 0 && signal === null) {
          resolve();
          return;
        }
        reject(new Error("Disposable integration child process failed."));
      })();
    });
  });
}

function runNpm(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  secrets: readonly string[],
  childController: DisposableIntegrationChildController,
): Promise<void> {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    return run(process.execPath, [npmCli, ...args], {
      childController,
      env,
      secrets,
    });
  }
  return run(executable("npm"), args, {
    childController,
    env,
    secrets,
  });
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
    backupReporter: loopback(
      "learncoding_backup_reporter",
      credentials.backupReporter,
    ),
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
    databaseBackupReporterUrl: canonical(
      "learncoding_backup_reporter",
      input.credentials.backupReporter,
    ),
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
  const {
    resolveReviewedMailAuthorityCatalogPhase,
    verifyDatabaseRoleBootstrapState,
  } = await import(
    /* @vite-ignore */ modulePath
  ) as {
    resolveReviewedMailAuthorityCatalogPhase: ReviewedCatalogPhaseResolver;
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
    const reviewedPhase =
      await resolveReviewedMailAuthorityCatalogPhase(client);
    await verifyDatabaseRoleBootstrapState(
      client,
      input.database,
      input.integrationUser,
      reviewedPhase,
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

async function waitForPostgres(
  connectionString: string,
  expectedMajor: number,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  const mismatchMessage = "Disposable integration PostgreSQL major mismatch.";
  while (Date.now() < deadline) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
    try {
      await client.connect();
      const version = await client.query<{ server_version_num: string }>(
        "show server_version_num",
      );
      const versionNumber = Number.parseInt(
        version.rows[0]?.server_version_num ?? "",
        10,
      );
      await client.end();
      if (
        !Number.isSafeInteger(versionNumber)
        || Math.floor(versionNumber / 10_000) !== expectedMajor
      ) {
        throw new Error(mismatchMessage);
      }
      return;
    } catch (error) {
      await client.end().catch(() => undefined);
      if (error instanceof Error && error.message === mismatchMessage) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("Disposable integration PostgreSQL readiness failed.");
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
    const normalized = requested.replaceAll("\\", "/");
    if (
      !/^integration\/[a-z0-9-]+\.integration\.test\.ts$/u.test(
        normalized,
      )
    ) {
      throw new Error("Integration test path is not allowlisted.");
    }
  }

  failureReporter.enter("migration-journal");
  const expectedJournalCount = await expectedMigrationJournalCount();
  const suffix = randomBytes(6).toString("hex");
  const containerName = `learncoding-postgres-it-${suffix}`;
  const password = generatedPassword();
  const betterAuthSecret = generatedPassword();
  const integrationUser = "learncoding_it";
  const database = "learncoding_integration";
  const roleCredentials: DisposableRoleCredentials = Object.freeze({
    bootstrap: password,
    app: generatedPassword(),
    migrator: generatedPassword(),
    worker: generatedPassword(),
    ops: generatedPassword(),
    backupReporter: generatedPassword(),
  });
  failureReporter.enter("loopback-port");
  const port = await allocateDisposableLoopbackPort();
  const databaseUrl = databaseRoleUrl({
    username: integrationUser,
    password,
    hostname: "127.0.0.1",
    port,
    database,
  });
  const roleUrls = disposableRoleUrls(port, database, roleCredentials);
  const ownerDatabaseUrl = ownerAssumingDatabaseUrl(roleUrls.migrator);
  const secrets = [
    password,
    betterAuthSecret,
    databaseUrl,
    ownerDatabaseUrl,
    roleCredentials.bootstrap,
    roleCredentials.app,
    roleCredentials.migrator,
    roleCredentials.worker,
    roleCredentials.ops,
    roleCredentials.backupReporter,
    roleUrls.app,
    roleUrls.migrator,
    roleUrls.worker,
    roleUrls.ops,
    roleUrls.backupReporter,
  ];
  const childController = createDisposableIntegrationChildController();
  const requestedImage = process.env.INTEGRATION_POSTGRES_IMAGE;

  failureReporter.enter("harness-start");
  await runWithDisposableIntegrationHarness({
    dockerCommand: executable("docker"),
    containerName,
    port,
    database,
    username: integrationUser,
    password,
    sourceEnvironment: process.env,
    terminateActiveChildren: childController.terminateAndWait,
    processTarget: {
      on: (signal, listener) => process.on(signal, listener),
      exit: (code) => process.exit(code),
    },
    writeError: (message) => process.stderr.write(`${message}\n`),
    ...(requestedImage === undefined ? {} : { requestedImage }),
  }, async ({ taskHomeDirectory, postgresMajor }) => {
    const toolEnvironment = buildDisposableToolEnvironment(
      process.env,
      taskHomeDirectory,
    );
    failureReporter.enter("role-boundary-self-test");
    await run(process.execPath, [
      "--test",
      path.resolve(
        process.cwd(),
        "scripts/database-role-boundaries.test.mjs",
      ),
    ], {
      childController,
      env: toolEnvironment,
      secrets,
    });
    failureReporter.enter("postgres-readiness");
    await waitForPostgres(databaseUrl, postgresMajor);

    const testEnvironment =
      buildDisposableIntegrationRuntimeEnvironment(process.env, {
        taskHomeDirectory,
        databaseAppUrl: roleUrls.app,
        databaseMigratorUrl: roleUrls.migrator,
        databaseWorkerUrl: roleUrls.worker,
        databaseOpsUrl: roleUrls.ops,
        databaseBackupReporterUrl: roleUrls.backupReporter,
        databaseOwnerUrl: ownerDatabaseUrl,
        betterAuthSecret,
      });
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
        failureReporter.enter(phase);
        console.info(JSON.stringify({
          event: "integration.topology",
          phase,
        }));
      },
    });

    const resetInstallerPool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 5_000,
      max: 1,
      query_timeout: 30_000,
      statement_timeout: 30_000,
      lock_timeout: 5_000,
      idle_in_transaction_session_timeout: 30_000,
      allowExitOnIdle: true,
    });
    failureReporter.enter("reset-capability-install");
    await withDisposableIntegrationReset(
      resetInstallerPool,
      async () => {
        failureReporter.enter("application-tests");
        await runNpm([
          "run",
          "test:integration:vitest",
          ...(requestedTests.length > 0 ? ["--", ...requestedTests] : []),
        ], testEnvironment, secrets, childController);
      },
      (primaryState) => {
        if (primaryState.status === "fulfilled") {
          failureReporter.enter("reset-capability-teardown");
        }
      },
    );
    failureReporter.enter("harness-cleanup");
  });
}

main().catch(() => {
  failureReporter.report();
  process.exitCode = 1;
});
