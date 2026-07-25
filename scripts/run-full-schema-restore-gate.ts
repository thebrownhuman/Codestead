import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import pg from "pg";

import {
  collectFullSchemaRestoreSnapshot,
  runFullSchemaRestoreDatabaseSmoke,
  type FullSchemaRestoreQueryClient,
} from "./lib/full-schema-restore-database";
import {
  seedRepresentativeMailAuthorityRows,
} from "./lib/full-schema-restore-fixtures";
import {
  deriveMigrationTailContract,
  runFullSchemaRestoreVerification,
} from "./lib/full-schema-restore-gate";
import {
  buildPostgresArchiveCommands,
  parseFullSchemaRestorePostgresMajor,
  requireOwnedRestoreContainerId,
  runWithRestoreContainerPair,
  runWithRestoreTaskRoot,
} from "./lib/full-schema-restore-runtime";
import {
  installFullSchemaRestoreSignalHandlers,
} from "./lib/full-schema-restore-signal";
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
  createDisposablePostgresContainer: (input: Readonly<{
    dockerCommand: string;
    containerName: string;
    image: string;
    port: number;
    database: string;
    username: string;
    password: string;
    taskHomeDirectory: string;
    sourceEnvironment: NodeJS.ProcessEnv;
  }>) => SecurePostgresContainer;
}>;

type ToolEnvironmentModule = Readonly<{
  buildDisposableToolEnvironment: (
    sourceEnvironment: NodeJS.ProcessEnv,
    taskHomeDirectory: string,
  ) => NodeJS.ProcessEnv;
}>;

type BootstrapModule = Readonly<{
  runDatabaseRoleBootstrap: (input: Readonly<{
    postgresUser: string;
    postgresDatabase: string;
    databaseBootstrapUrl: string;
    databaseAppUrl: string;
    databaseMigratorUrl: string;
    databaseWorkerUrl: string;
    databaseOpsUrl: string;
    lockTimeoutMs: number;
    cleanupTimeoutMs: number;
    pool: InstanceType<typeof Pool>;
  }>) => Promise<unknown>;
}>;

type MigrationModule = Readonly<{
  runProductionMigration: (input: Readonly<{
    connectionString: string;
    migrationsFolder: string;
  }>) => Promise<void>;
}>;

type BoundaryModule = Readonly<{
  verifyDatabaseRoleBoundaries: (
    input: Record<string, unknown>,
  ) => Promise<unknown>;
}>;

type DatabaseContext = Readonly<{
  database: string;
  adminUrl: string;
  ownerUrl: string;
  roleUrls: DisposableRoleUrls;
  reconcileRoles: () => Promise<void>;
  verifyRoleBoundaries: (
    requireApplicationObjects: boolean,
  ) => Promise<void>;
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

function databaseUrl(input: Readonly<{
  username: string;
  password: string;
  host: string;
  port: number;
  database: string;
}>): string {
  return `postgresql://${encodeURIComponent(input.username)}:`
    + `${encodeURIComponent(input.password)}@${input.host}:`
    + `${input.port}/${input.database}`;
}

function roleUrls(
  port: number,
  database: string,
  credentials: RoleCredentials,
): DisposableRoleUrls {
  const url = (username: string, password: string) => databaseUrl({
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
  operation: (
    clients: readonly FullSchemaRestoreQueryClient[],
  ) => Promise<T>,
): Promise<T> {
  const pools = urls.map((connectionString) => new Pool({
    connectionString,
    application_name: "codestead_full_schema_restore_gate",
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 1_000,
    max: 1,
    statement_timeout: 30_000,
  }));
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
    throw new Error("full-schema restore database operation and cleanup failed");
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupFailed) {
    throw new Error("full-schema restore database cleanup failed");
  }
  return result as T;
}

async function createDatabaseContext(input: Readonly<{
  port: number;
  database: string;
  credentials: RoleCredentials;
}>): Promise<DatabaseContext> {
  const adminUrl = databaseUrl({
    username: POSTGRES_USER,
    password: input.credentials.bootstrap,
    host: "127.0.0.1",
    port: input.port,
    database: input.database,
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
    roleUrls: scopedRoleUrls,
    async reconcileRoles() {
      const bootstrapModule = await import(
        /* @vite-ignore */ bootstrapModulePath
      ) as BootstrapModule;
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
          lockTimeoutMs: 10_000,
          cleanupTimeoutMs: 5_000,
          pool,
        });
      } finally {
        await pool.end();
      }
    },
    async verifyRoleBoundaries(requireApplicationObjects) {
      const boundaryModule = await import(
        /* @vite-ignore */ boundaryModulePath
      ) as BoundaryModule;
      await verifyDisposableIntegrationRoleBoundaries({
        database: input.database,
        roleUrls: scopedRoleUrls,
        requireApplicationObjects,
        verifyDatabaseRoleBoundaries: boundaryModule.verifyDatabaseRoleBoundaries,
        createPool: (options) => new Pool(options),
      });
    },
    async migrate() {
      const migrationModule = await import(
        /* @vite-ignore */ migrationModulePath
      ) as MigrationModule;
      await migrationModule.runProductionMigration({
        connectionString: scopedRoleUrls.migrator,
        migrationsFolder: path.resolve(process.cwd(), "drizzle"),
      });
    },
    seedRepresentativeMailRows: () => withPools(
      [scopedOwnerUrl, scopedRoleUrls.worker],
      async ([owner, worker]) => {
        await seedRepresentativeMailAuthorityRows({ owner: owner!, worker: worker! });
      },
    ),
    snapshot: () => withPools(
      [scopedOwnerUrl],
      async ([owner]) => collectFullSchemaRestoreSnapshot(owner!),
    ),
    runNonNetworkSmoke: () => withPools(
      [scopedRoleUrls.worker, scopedRoleUrls.ops, scopedOwnerUrl],
      async ([worker, ops, verifier]) =>
        runFullSchemaRestoreDatabaseSmoke({
          worker: worker!,
          ops: ops!,
          verifier: verifier!,
        }),
    ),
  };
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

function runDockerCapture(input: Readonly<{
  command: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
}>): string {
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

function resolveContainerId(input: Readonly<{
  role: RestoreRole;
  name: string;
  container: SecurePostgresContainer;
  dockerCommand: string;
  environment: NodeJS.ProcessEnv;
  expectedPort: number;
  expectedDatabase: string;
}>): string {
  const identity = input.container.getIdentity();
  if (
    identity.port !== input.expectedPort
    || identity.database !== input.expectedDatabase
    || identity.username !== POSTGRES_USER
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
      `{{.Id}}|{{.Name}}|{{ index .Config.Labels "${PURPOSE_LABEL_KEY}" }}|`
        + `{{ index .Config.Labels "${RUN_LABEL_KEY}" }}`,
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

function runArchiveDump(input: Readonly<{
  command: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
}>): Buffer {
  const result = spawnSync(input.command, [...input.args], {
    encoding: null,
    env: input.environment,
    maxBuffer: ARCHIVE_MAX_BYTES,
    timeout: TOOL_TIMEOUT_MS,
    windowsHide: true,
  });
  if (
    result.status !== 0
    || !Buffer.isBuffer(result.stdout)
    || result.stdout.length === 0
  ) {
    throw new Error("full-schema restore dump failed");
  }
  return result.stdout;
}

function runArchiveRestore(input: Readonly<{
  command: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  archive: Buffer;
}>): void {
  const result = spawnSync(input.command, [...input.args], {
    encoding: null,
    env: input.environment,
    input: input.archive,
    maxBuffer: 1024 * 1024,
    timeout: TOOL_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error("full-schema restore archive restore failed");
  }
}

function safeTaskRoot(): Readonly<{
  root: string;
  sourceHome: string;
  targetHome: string;
  cleanup: () => void;
}> {
  const temporaryRoot = realpathSync(tmpdir());
  const root = mkdtempSync(path.join(temporaryRoot, "codestead-full-restore-"));
  chmodSync(root, 0o700);
  const sourceHome = path.join(root, "source-home");
  const targetHome = path.join(root, "target-home");
  mkdirSync(sourceHome, { mode: 0o700 });
  mkdirSync(targetHome, { mode: 0o700 });
  return {
    root,
    sourceHome,
    targetHome,
    cleanup() {
      const resolved = realpathSync(root);
      if (
        path.dirname(resolved) !== temporaryRoot
        || !path.basename(resolved).startsWith("codestead-full-restore-")
      ) {
        throw new Error("full-schema restore temporary root is invalid");
      }
      rmSync(resolved, { recursive: true, force: false });
    },
  };
}

async function expectedMigrationContract() {
  const journalPath = path.resolve(
    process.cwd(),
    "drizzle/meta/_journal.json",
  );
  const journalSource = await readFile(journalPath, "utf8");
  const journal = JSON.parse(journalSource) as unknown;
  if (
    typeof journal !== "object"
    || journal === null
    || !("entries" in journal)
    || !Array.isArray(journal.entries)
  ) {
    throw new Error("full-schema restore migration journal is invalid");
  }
  const tail = journal.entries.at(-1) as { tag?: unknown } | undefined;
  if (typeof tail?.tag !== "string") {
    throw new Error("full-schema restore migration journal is invalid");
  }
  const tailSql = await readFile(
    path.resolve(process.cwd(), "drizzle", `${tail.tag}.sql`),
    "utf8",
  );
  return deriveMigrationTailContract(journal, tailSql);
}

async function loadSecureRunner() {
  const containerModulePath = "./lib/disposable-postgres-container";
  const environmentModulePath = "./lib/disposable-tool-environment";
  const [containerModule, environmentModule] = await Promise.all([
    import(/* @vite-ignore */ containerModulePath) as Promise<
      SecureContainerModule
    >,
    import(/* @vite-ignore */ environmentModulePath) as Promise<
      ToolEnvironmentModule
    >,
  ]);
  return { containerModule, environmentModule };
}

function credentials(): RoleCredentials {
  return Object.freeze({
    bootstrap: generatedPassword(),
    app: generatedPassword(),
    migrator: generatedPassword(),
    worker: generatedPassword(),
    ops: generatedPassword(),
  });
}

async function main(): Promise<void> {
  const postgresMajor = parseFullSchemaRestorePostgresMajor(
    process.argv.slice(2),
  );
  const migration = await expectedMigrationContract();
  const { containerModule, environmentModule } = await loadSecureRunner();
  const dockerCommand = executable("docker");
  const taskRoot = safeTaskRoot();
  await runWithRestoreTaskRoot({
    cleanup: taskRoot.cleanup,
    operation: async () => {
      const suffix = randomBytes(8).toString("hex");
      const sourceName = `codestead-full-restore-source-${suffix}`;
      const targetName = `codestead-full-restore-target-${suffix}`;
      const sourcePort = await availablePort();
      let targetPort = await availablePort();
      while (targetPort === sourcePort) targetPort = await availablePort();
      const sourceCredentials = credentials();
      const targetCredentials = credentials();
      const image = postgresMajor === 17
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
      const toolEnvironment = environmentModule.buildDisposableToolEnvironment(
        process.env,
        taskRoot.root,
      );
      const uninstallSignalHandlers = installFullSchemaRestoreSignalHandlers({
        source,
        target,
        cleanupTaskRoot: taskRoot.cleanup,
        processTarget: process,
        writeError: (message) => {
          process.stderr.write(message);
        },
      });

      try {
        await runWithRestoreContainerPair({
          source,
          target,
          operation: async () => {
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
            });
            const targetContext = await createDatabaseContext({
              port: targetPort,
              database: TARGET_DATABASE,
              credentials: targetCredentials,
            });

            const evidence = await runFullSchemaRestoreVerification({
              expectedPostgresMajor: postgresMajor,
              migration,
              source: sourceContext,
              target: targetContext,
              dumpSource: async () => runArchiveDump({
                ...archiveCommands.dump,
                environment: toolEnvironment,
              }),
              restoreTarget: async (archive) => runArchiveRestore({
                ...archiveCommands.restore,
                environment: toolEnvironment,
                archive,
              }),
              disposeArchive: (archive) => {
                archive.fill(0);
              },
            });
            process.stdout.write(`${JSON.stringify({
              event: "full_schema_restore.verified",
              postgresMajor,
              migrationCount: evidence.migration.entryCount,
              migrationTail: evidence.migration.tailTag,
              mailRows: evidence.restored.mailRowCount,
              claimedRows: evidence.smoke.claimedRows,
              redactedRows: evidence.smoke.redactedRows,
              externalCalls: evidence.smoke.externalCalls,
            })}\n`);
          },
        });
      } finally {
        uninstallSignalHandlers();
      }
    },
  });
}

main().catch(() => {
  process.stderr.write("Full-schema restore gate failed: verification_failed\n");
  process.exitCode = 1;
});
