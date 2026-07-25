import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";

import {
  deriveFullSchemaArchiveEvidence,
  runFullSchemaArchiveDump,
  runFullSchemaArchiveList,
  runFullSchemaArchiveRestore,
  type FullSchemaRestoreBuildChildLaunch,
  type FullSchemaRestoreChildController,
} from "./lib/full-schema-restore-archive";
import { createFullSchemaRestoreLifecycle } from "./lib/full-schema-restore-lifecycle";
import {
  collectFullSchemaRestoreSnapshot,
  prepareFullSchemaAclSuppressionControl,
  requireFullSchemaAclSuppressionControl,
  requireExactFullSchemaRestoreOwnerRole,
  runFullSchemaRestoreDatabaseSmoke,
  type FullSchemaRestoreQueryClient,
} from "./lib/full-schema-restore-database";
import {
  seedRepresentativeMailAuthorityRows,
  verifyRestoredBackupAuthorityRows,
} from "./lib/full-schema-restore-fixtures";
import {
  deriveMigrationLedgerContract,
  requireFullSchemaRestoreMigrationContract,
  runFullSchemaRestoreVerification,
} from "./lib/full-schema-restore-gate";
import {
  buildPostgresArchiveCommands,
  createSafeFullSchemaRestoreTaskRoot,
  parseFullSchemaRestorePostgresMajor,
  requireOwnedRestoreContainerId,
} from "./lib/full-schema-restore-runtime";
import {
  type DisposableRoleUrls,
  verifyDisposableIntegrationRoleBoundaries,
} from "./lib/disposable-role-boundary-adapter";

const { Client, Pool } = pg;
const POSTGRES_USER = "learncoding_restore_it";
const SOURCE_DATABASE = "learncoding_restore_source";
const TARGET_DATABASE = "learncoding_restore_target";
const ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
const TOOL_TIMEOUT_MS = 180_000;
const RUN_LABEL_KEY = "com.learncoding.integration-run";
const PURPOSE_LABEL_KEY = "com.learncoding.purpose";

type RestoreRole = "source" | "target";

type RoleCredentials = Readonly<{
  bootstrap: string;
  app: string;
  migrator: string;
  worker: string;
  ops: string;
  backupReporter: string;
}>;

type ContainerIdentity = Readonly<{
  containerId: string;
  port: number;
  database: string;
  username: string;
}>;

type SecurePostgresContainer = Readonly<{
  start: () => void;
  cleanup: () => void;
  getIdentity: () => ContainerIdentity;
}>;

type SecureContainerModule = Readonly<{
  POSTGRES_17_INTEGRATION_IMAGE: string;
  POSTGRES_18_INTEGRATION_IMAGE: string;
  createDisposablePostgresContainer: (
    input: Readonly<{
      dockerCommand: string;
      containerName: string;
      image: string;
      port: number;
      database: string;
      username: string;
      password: string;
      taskHomeDirectory: string;
      sourceEnvironment: NodeJS.ProcessEnv;
    }>,
  ) => SecurePostgresContainer;
}>;

type ToolEnvironmentModule = Readonly<{
  buildDisposableToolEnvironment: (
    sourceEnvironment: NodeJS.ProcessEnv,
    taskHomeDirectory: string,
  ) => NodeJS.ProcessEnv;
}>;

type ChildControllerModule = Readonly<{
  createDisposableIntegrationChildController: () => FullSchemaRestoreChildController;
}>;

type ChildLaunchModule = Readonly<{
  buildDisposableIntegrationChildLaunch: FullSchemaRestoreBuildChildLaunch;
}>;

type BootstrapModule = Readonly<{
  runDatabaseRoleBootstrap: (
    input: Readonly<{
      postgresUser: string;
      postgresDatabase: string;
      databaseBootstrapUrl: string;
      databaseAppUrl: string;
      databaseMigratorUrl: string;
      databaseWorkerUrl: string;
      databaseOpsUrl: string;
      databaseBackupReporterUrl: string;
      lockTimeoutMs: number;
      cleanupTimeoutMs: number;
      pool: InstanceType<typeof Pool>;
    }>,
  ) => Promise<unknown>;
  verifyPostMigrationReviewedContractsBeforeReconciliation?: (
    client: FullSchemaRestoreQueryClient,
  ) => Promise<unknown>;
  verifyDatabaseRoleBootstrapState: (
    client: FullSchemaRestoreQueryClient,
    postgresDatabase: string,
    postgresUser: string,
  ) => Promise<unknown>;
}>;

type MigrationModule = Readonly<{
  runProductionMigration: (
    input: Readonly<{
      connectionString: string;
      migrationsFolder: string;
    }>,
  ) => Promise<void>;
}>;

type BoundaryModule = Readonly<{
  verifyDatabaseRoleBoundaries: (
    input: Record<string, unknown>,
  ) => Promise<unknown>;
  verifyReviewedMailAuthorityCatalogContracts?: (
    client: FullSchemaRestoreQueryClient,
  ) => Promise<unknown>;
}>;

type DatabaseContext = Readonly<{
  database: string;
  requireRestoreOwnerRole: () => Promise<void>;
  prepareAclSuppressionControl: () => Promise<void>;
  verifyAclSuppressionControl: () => Promise<
    Awaited<ReturnType<typeof requireFullSchemaAclSuppressionControl>>
  >;
  resetAfterAclSuppressionControl: () => Promise<void>;
  adminUrl: string;
  ownerUrl: string;
  roleUrls: DisposableRoleUrls;
  reconcileRoles: () => Promise<void>;
  verifyRoleBoundaries: (requireApplicationObjects: boolean) => Promise<void>;
  verifyMailAuthorityCatalog: () => Promise<void>;
  verifyPreRepairMailAuthorityCatalog: () => Promise<void>;
  migrate: () => Promise<void>;
  seedRepresentativeMailRows: () => Promise<void>;
  snapshot: () => ReturnType<typeof collectFullSchemaRestoreSnapshot>;
  runNonNetworkSmoke: () => ReturnType<
    typeof runFullSchemaRestoreDatabaseSmoke
  >;
}>;

function executable(name: "docker"): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function generatedPassword(): string {
  return randomBytes(32).toString("base64url");
}

function databaseUrl(
  input: Readonly<{
    username: string;
    password: string;
    host: string;
    port: number;
    database: string;
  }>,
): string {
  return (
    `postgresql://${encodeURIComponent(input.username)}:` +
    `${encodeURIComponent(input.password)}@${input.host}:` +
    `${input.port}/${input.database}`
  );
}

function roleUrls(
  port: number,
  database: string,
  credentials: RoleCredentials,
): DisposableRoleUrls {
  const url = (username: string, password: string) =>
    databaseUrl({
      username,
      password,
      host: "127.0.0.1",
      port,
      database,
    });
  return {
    app: url("learncoding_app", credentials.app),
    migrator: url("learncoding_migrator", credentials.migrator),
    worker: url("learncoding_worker", credentials.worker),
    ops: url("learncoding_ops", credentials.ops),
    backupReporter: url(
      "learncoding_backup_reporter",
      credentials.backupReporter,
    ),
  };
}

function canonicalRoleUrl(
  username: string,
  password: string,
  database: string,
): string {
  return databaseUrl({
    username,
    password,
    host: "postgres",
    port: 5432,
    database,
  });
}

function ownerUrl(migratorUrl: string): string {
  const url = new URL(migratorUrl);
  url.searchParams.set("options", "-c role=learncoding_owner");
  return url.href;
}

function queryClient(
  pool: InstanceType<typeof Pool>,
): FullSchemaRestoreQueryClient {
  return {
    async query(sql, values) {
      const result = await pool.query(
        sql,
        values === undefined ? undefined : [...values],
      );
      const normalized = Array.isArray(result) ? result.at(-1) : result;
      return {
        rows: (normalized?.rows ?? []) as readonly Record<string, unknown>[],
      };
    },
  };
}

async function withPools<T>(
  urls: readonly string[],
  operation: (clients: readonly FullSchemaRestoreQueryClient[]) => Promise<T>,
): Promise<T> {
  const pools = urls.map(
    (connectionString) =>
      new Pool({
        connectionString,
        application_name: "codestead_full_schema_restore_gate",
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 1_000,
        max: 1,
        statement_timeout: 30_000,
      }),
  );
  let primaryError: unknown;
  let result: T | undefined;
  try {
    result = await operation(pools.map(queryClient));
  } catch (error) {
    primaryError = error;
  }
  let cleanupFailed = false;
  for (const pool of pools) {
    try {
      await pool.end();
    } catch {
      cleanupFailed = true;
    }
  }
  if (primaryError !== undefined && cleanupFailed) {
    throw new Error(
      "full-schema restore database operation and cleanup failed",
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupFailed) {
    throw new Error("full-schema restore database cleanup failed");
  }
  return result as T;
}

async function createDatabaseContext(
  input: Readonly<{
    port: number;
    database: string;
    credentials: RoleCredentials;
    migrationTailIndex: number;
  }>,
): Promise<DatabaseContext> {
  const adminUrl = databaseUrl({
    username: POSTGRES_USER,
    password: input.credentials.bootstrap,
    host: "127.0.0.1",
    port: input.port,
    database: input.database,
  });
  const maintenanceAdminUrl = databaseUrl({
    username: POSTGRES_USER,
    password: input.credentials.bootstrap,
    host: "127.0.0.1",
    port: input.port,
    database: "postgres",
  });
  const scopedRoleUrls = roleUrls(
    input.port,
    input.database,
    input.credentials,
  );
  const scopedOwnerUrl = ownerUrl(scopedRoleUrls.migrator);
  const bootstrapModulePath = "./bootstrap-database-roles.mjs";
  const migrationModulePath = "./migrate-production.mjs";
  const boundaryModulePath = "./verify-database-role-boundaries.mjs";

  return {
    database: input.database,
    adminUrl,
    ownerUrl: scopedOwnerUrl,
    requireRestoreOwnerRole: () =>
      withPools([adminUrl], async ([admin]) =>
        requireExactFullSchemaRestoreOwnerRole(admin!),
      ),
    prepareAclSuppressionControl: () =>
      withPools([adminUrl], async ([admin]) =>
        prepareFullSchemaAclSuppressionControl(admin!),
      ),
    verifyAclSuppressionControl: () =>
      withPools([scopedOwnerUrl], async ([owner]) =>
        requireFullSchemaAclSuppressionControl(owner!),
      ),
    resetAfterAclSuppressionControl: () =>
      withPools([maintenanceAdminUrl], async ([admin]) => {
        const database = requireRestoreDatabaseIdentifier(input.database);
        await admin!.query(`drop database "${database}" with (force)`);
        await admin!.query(
          `create database "${database}" owner learncoding_owner`,
        );
      }),
    roleUrls: scopedRoleUrls,
    async reconcileRoles() {
      const bootstrapModule = (await import(
        /* @vite-ignore */ bootstrapModulePath
      )) as BootstrapModule;
      const pool = new Pool({
        connectionString: adminUrl,
        application_name: "codestead_full_schema_restore_bootstrap",
        max: 1,
      });
      try {
        await bootstrapModule.runDatabaseRoleBootstrap({
          postgresUser: POSTGRES_USER,
          postgresDatabase: input.database,
          databaseBootstrapUrl: canonicalRoleUrl(
            POSTGRES_USER,
            input.credentials.bootstrap,
            input.database,
          ),
          databaseAppUrl: canonicalRoleUrl(
            "learncoding_app",
            input.credentials.app,
            input.database,
          ),
          databaseMigratorUrl: canonicalRoleUrl(
            "learncoding_migrator",
            input.credentials.migrator,
            input.database,
          ),
          databaseWorkerUrl: canonicalRoleUrl(
            "learncoding_worker",
            input.credentials.worker,
            input.database,
          ),
          databaseOpsUrl: canonicalRoleUrl(
            "learncoding_ops",
            input.credentials.ops,
            input.database,
          ),
          databaseBackupReporterUrl: canonicalRoleUrl(
            "learncoding_backup_reporter",
            input.credentials.backupReporter,
            input.database,
          ),
          lockTimeoutMs: 10_000,
          cleanupTimeoutMs: 5_000,
          pool,
        });
      } finally {
        await pool.end();
      }
    },
    async verifyRoleBoundaries(requireApplicationObjects) {
      const boundaryModule = (await import(
        /* @vite-ignore */ boundaryModulePath
      )) as BoundaryModule;
      await verifyDisposableIntegrationRoleBoundaries({
        database: input.database,
        roleUrls: scopedRoleUrls,
        requireApplicationObjects,
        verifyDatabaseRoleBoundaries:
          boundaryModule.verifyDatabaseRoleBoundaries,
        createPool: (options) => new Pool(options),
      });
    },
    async verifyMailAuthorityCatalog() {
      const boundaryModule = (await import(
        /* @vite-ignore */ boundaryModulePath
      )) as BoundaryModule;
      const verifier =
        boundaryModule.verifyReviewedMailAuthorityCatalogContracts;
      if (typeof verifier !== "function") {
        if (input.migrationTailIndex >= 64) {
          throw new Error(
            "full-schema restore reviewed catalog verifier is unavailable",
          );
        }
        const bootstrapModule = (await import(
          /* @vite-ignore */ bootstrapModulePath
        )) as BootstrapModule;
        return withPools([adminUrl], async ([admin]) => {
          await bootstrapModule.verifyDatabaseRoleBootstrapState(
            admin!,
            input.database,
            POSTGRES_USER,
          );
        });
      }
      const pool = new Pool({
        connectionString: scopedOwnerUrl,
        application_name: "codestead_full_schema_restore_catalog",
        max: 1,
      });
      try {
        await verifier(pool);
      } finally {
        await pool.end();
      }
    },
    async verifyPreRepairMailAuthorityCatalog() {
      const bootstrapModule = (await import(
        /* @vite-ignore */ bootstrapModulePath
      )) as BootstrapModule;
      const rawVerifier =
        bootstrapModule.verifyPostMigrationReviewedContractsBeforeReconciliation;
      if (input.migrationTailIndex < 64) {
        return withPools([adminUrl], async ([admin]) => {
          await bootstrapModule.verifyDatabaseRoleBootstrapState(
            admin!,
            input.database,
            POSTGRES_USER,
          );
        });
      }
      const boundaryModule = (await import(
        /* @vite-ignore */ boundaryModulePath
      )) as BoundaryModule;
      const aggregateVerifier =
        boundaryModule.verifyReviewedMailAuthorityCatalogContracts;
      if (
        typeof rawVerifier !== "function" ||
        typeof aggregateVerifier !== "function"
      ) {
        throw new Error(
          "full-schema restore pre-repair catalog verifier is unavailable",
        );
      }
      const pool = new Pool({
        connectionString: scopedOwnerUrl,
        application_name: "codestead_full_schema_restore_raw_catalog",
        max: 1,
      });
      try {
        await rawVerifier(pool);
        await aggregateVerifier(pool);
      } finally {
        await pool.end();
      }
    },
    async migrate() {
      const migrationModule = (await import(
        /* @vite-ignore */ migrationModulePath
      )) as MigrationModule;
      await migrationModule.runProductionMigration({
        connectionString: scopedRoleUrls.migrator,
        migrationsFolder: path.resolve(process.cwd(), "drizzle"),
      });
    },
    seedRepresentativeMailRows: () =>
      withPools(
        [scopedOwnerUrl, scopedRoleUrls.worker, scopedRoleUrls.backupReporter],
        async ([owner, worker, backupReporter]) => {
          await seedRepresentativeMailAuthorityRows({
            owner: owner!,
            worker: worker!,
            backupReporter: backupReporter!,
          });
        },
      ),
    snapshot: () =>
      withPools([scopedOwnerUrl], async ([owner]) =>
        collectFullSchemaRestoreSnapshot(owner!),
      ),
    runNonNetworkSmoke: () =>
      withPools(
        [
          scopedRoleUrls.worker,
          scopedRoleUrls.ops,
          scopedOwnerUrl,
          scopedRoleUrls.backupReporter,
        ],
        async ([worker, ops, verifier, backupReporter]) => {
          const smoke = await runFullSchemaRestoreDatabaseSmoke({
            worker: worker!,
            ops: ops!,
            verifier: verifier!,
            redactionAuthority: input.migrationTailIndex >= 68 ? "v2" : "v1",
          });
          await verifyRestoredBackupAuthorityRows({
            owner: verifier!,
            worker: worker!,
            backupReporter: backupReporter!,
          });
          return smoke;
        },
      ),
  };
}

function requireRestoreDatabaseIdentifier(value: string): string {
  if (value !== SOURCE_DATABASE && value !== TARGET_DATABASE) {
    throw new Error("full-schema restore database identifier is invalid");
  }
  return value;
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string" || address.port === 5432) {
        server.close();
        reject(new Error("full-schema restore loopback allocation failed"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForPostgres(connectionString: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const client = new Client({
      connectionString,
      connectionTimeoutMillis: 1_000,
    });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      return;
    } catch {
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("full-schema restore PostgreSQL readiness failed");
}

function runDockerCapture(
  input: Readonly<{
    command: string;
    args: readonly string[];
    environment: NodeJS.ProcessEnv;
  }>,
): string {
  const result = spawnSync(input.command, [...input.args], {
    encoding: "utf8",
    env: input.environment,
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error("full-schema restore Docker identity probe failed");
  }
  return result.stdout ?? "";
}

function resolveContainerId(
  input: Readonly<{
    role: RestoreRole;
    name: string;
    container: SecurePostgresContainer;
    dockerCommand: string;
    environment: NodeJS.ProcessEnv;
    expectedPort: number;
    expectedDatabase: string;
  }>,
): string {
  const identity = input.container.getIdentity();
  if (
    identity.port !== input.expectedPort ||
    identity.database !== input.expectedDatabase ||
    identity.username !== POSTGRES_USER
  ) {
    throw new Error("full-schema restore secure-runner identity mismatch");
  }
  const listedIds = runDockerCapture({
    command: input.dockerCommand,
    args: [
      "container",
      "ls",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `name=^/${input.name}$`,
    ],
    environment: input.environment,
  });
  const inspectionOutput = runDockerCapture({
    command: input.dockerCommand,
    args: [
      "container",
      "inspect",
      "--format",
      `{{.Id}}|{{.Name}}|{{ index .Config.Labels "${PURPOSE_LABEL_KEY}" }}|` +
        `{{ index .Config.Labels "${RUN_LABEL_KEY}" }}`,
      identity.containerId,
    ],
    environment: input.environment,
  });
  const [id, name, purpose, run, extra] = inspectionOutput.trim().split("|");
  if (extra !== undefined) {
    throw new Error("full-schema restore Docker inspection is invalid");
  }
  return requireOwnedRestoreContainerId({
    expectedName: input.name,
    expectedRole: input.role,
    listedIds,
    inspection: {
      id: id ?? "",
      name: name ?? "",
      purpose: purpose ?? "",
      run: run ?? "",
      restoreRole: input.role,
    },
  });
}

async function expectedMigrationContract() {
  const journalPath = path.resolve(process.cwd(), "drizzle/meta/_journal.json");
  const journalSource = await readFile(journalPath, "utf8");
  const journal = JSON.parse(journalSource) as unknown;
  if (
    typeof journal !== "object" ||
    journal === null ||
    !("entries" in journal) ||
    !Array.isArray(journal.entries)
  ) {
    throw new Error("full-schema restore migration journal is invalid");
  }
  if (
    journal.entries.some(
      (entry) =>
        typeof entry !== "object" ||
        entry === null ||
        !("tag" in entry) ||
        typeof entry.tag !== "string",
    )
  ) {
    throw new Error("full-schema restore migration journal is invalid");
  }
  const sqlSources = await Promise.all(
    journal.entries.map((entry) =>
      readFile(
        path.resolve(process.cwd(), "drizzle", `${entry.tag}.sql`),
        "utf8",
      ),
    ),
  );
  return requireFullSchemaRestoreMigrationContract(
    deriveMigrationLedgerContract(journal, sqlSources),
  );
}

async function loadSecureRunner() {
  const containerModulePath = "./lib/disposable-postgres-container";
  const environmentModulePath = "./lib/disposable-tool-environment";
  const childControllerModulePath =
    "./lib/disposable-integration-child-controller";
  const childLaunchModulePath = "./lib/disposable-integration-child-launch";
  const [
    containerModule,
    environmentModule,
    childControllerModule,
    childLaunchModule,
  ] = await Promise.all([
    import(
      /* @vite-ignore */ containerModulePath
    ) as Promise<SecureContainerModule>,
    import(
      /* @vite-ignore */ environmentModulePath
    ) as Promise<ToolEnvironmentModule>,
    import(
      /* @vite-ignore */ childControllerModulePath
    ) as Promise<ChildControllerModule>,
    import(
      /* @vite-ignore */ childLaunchModulePath
    ) as Promise<ChildLaunchModule>,
  ]);
  return {
    containerModule,
    environmentModule,
    childControllerModule,
    childLaunchModule,
  };
}

function credentials(): RoleCredentials {
  return Object.freeze({
    bootstrap: generatedPassword(),
    app: generatedPassword(),
    migrator: generatedPassword(),
    worker: generatedPassword(),
    ops: generatedPassword(),
    backupReporter: generatedPassword(),
  });
}

async function main(): Promise<void> {
  const postgresMajor = parseFullSchemaRestorePostgresMajor(
    process.argv.slice(2),
  );
  const migration = await expectedMigrationContract();
  const {
    containerModule,
    environmentModule,
    childControllerModule,
    childLaunchModule,
  } = await loadSecureRunner();
  const childController =
    childControllerModule.createDisposableIntegrationChildController();
  const lifecycle = createFullSchemaRestoreLifecycle({
    childController,
    processTarget: process,
    writeError: (message) => {
      process.stderr.write(message);
    },
  });
  const dockerCommand = executable("docker");
  try {
    const taskRoot = createSafeFullSchemaRestoreTaskRoot({
      temporaryDirectory: tmpdir(),
      ownTaskRoot: lifecycle.ownTaskRoot,
    });
    const suffix = randomBytes(8).toString("hex");
    const sourceName = `codestead-full-restore-source-${suffix}`;
    const targetName = `codestead-full-restore-target-${suffix}`;
    const sourcePort = await availablePort();
    let targetPort = await availablePort();
    while (targetPort === sourcePort) targetPort = await availablePort();
    const sourceCredentials = credentials();
    const targetCredentials = credentials();
    const image =
      postgresMajor === 17
        ? containerModule.POSTGRES_17_INTEGRATION_IMAGE
        : containerModule.POSTGRES_18_INTEGRATION_IMAGE;
    const source = containerModule.createDisposablePostgresContainer({
      dockerCommand,
      containerName: sourceName,
      image,
      port: sourcePort,
      database: SOURCE_DATABASE,
      username: POSTGRES_USER,
      password: sourceCredentials.bootstrap,
      taskHomeDirectory: taskRoot.sourceHome,
      sourceEnvironment: process.env,
    });
    lifecycle.ownContainer("source", source);
    const target = containerModule.createDisposablePostgresContainer({
      dockerCommand,
      containerName: targetName,
      image,
      port: targetPort,
      database: TARGET_DATABASE,
      username: POSTGRES_USER,
      password: targetCredentials.bootstrap,
      taskHomeDirectory: taskRoot.targetHome,
      sourceEnvironment: process.env,
    });
    lifecycle.ownContainer("target", target);
    const toolEnvironment = environmentModule.buildDisposableToolEnvironment(
      process.env,
      taskRoot.root,
    );
    source.start();
    target.start();

    const sourceAdminUrl = databaseUrl({
      username: POSTGRES_USER,
      password: sourceCredentials.bootstrap,
      host: "127.0.0.1",
      port: sourcePort,
      database: SOURCE_DATABASE,
    });
    const targetAdminUrl = databaseUrl({
      username: POSTGRES_USER,
      password: targetCredentials.bootstrap,
      host: "127.0.0.1",
      port: targetPort,
      database: TARGET_DATABASE,
    });
    await Promise.all([
      waitForPostgres(sourceAdminUrl),
      waitForPostgres(targetAdminUrl),
    ]);
    const sourceId = resolveContainerId({
      role: "source",
      name: sourceName,
      container: source,
      dockerCommand,
      environment: toolEnvironment,
      expectedPort: sourcePort,
      expectedDatabase: SOURCE_DATABASE,
    });
    const targetId = resolveContainerId({
      role: "target",
      name: targetName,
      container: target,
      dockerCommand,
      environment: toolEnvironment,
      expectedPort: targetPort,
      expectedDatabase: TARGET_DATABASE,
    });
    const archiveCommands = buildPostgresArchiveCommands({
      dockerCommand,
      sourceContainerId: sourceId,
      targetContainerId: targetId,
      sourceDatabase: SOURCE_DATABASE,
      targetDatabase: TARGET_DATABASE,
      postgresUser: POSTGRES_USER,
    });
    const sourceContext = await createDatabaseContext({
      port: sourcePort,
      database: SOURCE_DATABASE,
      credentials: sourceCredentials,
      migrationTailIndex: migration.tailIndex,
    });
    const targetContext = await createDatabaseContext({
      port: targetPort,
      database: TARGET_DATABASE,
      credentials: targetCredentials,
      migrationTailIndex: migration.tailIndex,
    });
    const buildChildLaunch =
      childLaunchModule.buildDisposableIntegrationChildLaunch;

    const evidence = await runFullSchemaRestoreVerification({
      expectedPostgresMajor: postgresMajor,
      migration,
      source: sourceContext,
      target: targetContext,
      dumpSource: () =>
        runFullSchemaArchiveDump({
          ...archiveCommands.dump,
          environment: toolEnvironment,
          maxStdoutBytes: ARCHIVE_MAX_BYTES,
          timeoutMs: TOOL_TIMEOUT_MS,
          controller: childController,
          buildChildLaunch,
        }),
      inspectArchive: async (archive, sourceSnapshot) => {
        const toc = await runFullSchemaArchiveList({
          ...archiveCommands.list,
          environment: toolEnvironment,
          archive,
          maxStdoutBytes: 4 * 1024 * 1024,
          timeoutMs: TOOL_TIMEOUT_MS,
          controller: childController,
          buildChildLaunch,
        });
        try {
          return deriveFullSchemaArchiveEvidence({
            archive,
            toc,
            sourceObjectContractSha256: sourceSnapshot.objectContractSha256,
          });
        } finally {
          toc.fill(0);
        }
      },
      restoreTargetWithoutAcl: (archive) =>
        runFullSchemaArchiveRestore({
          ...archiveCommands.restoreWithoutAcl,
          environment: toolEnvironment,
          archive,
          maxStdoutBytes: 1024 * 1024,
          timeoutMs: TOOL_TIMEOUT_MS,
          controller: childController,
          buildChildLaunch,
        }),
      restoreTarget: (archive) =>
        runFullSchemaArchiveRestore({
          ...archiveCommands.restore,
          environment: toolEnvironment,
          archive,
          maxStdoutBytes: 1024 * 1024,
          timeoutMs: TOOL_TIMEOUT_MS,
          controller: childController,
          buildChildLaunch,
        }),
      disposeArchive: (archive) => {
        archive.fill(0);
      },
    });
    process.stdout.write(
      `${JSON.stringify({
        event: "full_schema_restore.verified",
        postgresMajor,
        migrationCount: evidence.migration.entryCount,
        migrationTail: evidence.migration.tailTag,
        aclSuppressionControlProaclNull:
          evidence.aclSuppressionControl.proaclIsNull,
        aclSuppressionControlPublicExecute:
          evidence.aclSuppressionControl.publicExecute,
        archiveAclEntries: evidence.archive.aclEntryCount,
        archiveRoutineAclEntries: evidence.archive.routineAclEntryCount,
        mailRows: evidence.restored.mailRowCount,
        claimedRows: evidence.smoke.claimedRows,
        redactedRows: evidence.smoke.redactedRows,
        externalCalls: evidence.smoke.externalCalls,
      })}\n`,
    );
  } finally {
    try {
      await lifecycle.cleanup();
    } finally {
      lifecycle.uninstallSignalHandlers();
    }
  }
}

main().catch(() => {
  process.stderr.write(
    "Full-schema restore gate failed: verification_failed\n",
  );
  process.exitCode = 1;
});
