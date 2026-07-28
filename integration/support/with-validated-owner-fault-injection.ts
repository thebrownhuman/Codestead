import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient } from "pg";

import {
  verifyAppliedMigrationLedger,
  verifyReviewedMigrationRepository,
} from "../../scripts/lib/reviewed-migration-ledger.mjs";

type OwnerDatabaseIdentity = {
  current_database: string;
  current_user: string;
  session_user: string;
};

type ParsedOwnerDatabaseUrl = Readonly<{
  connectionString: string;
}>;

type DisposableOwnerDatabaseTarget = Readonly<{
  databaseApplicationUrl: string;
  databaseOwnerUrl: string;
}>;

type FaultInjectionInput<T> = Readonly<{
  cleanupSql: readonly string[];
  context: string;
  databaseTarget: DisposableOwnerDatabaseTarget;
  installSql: readonly string[];
  run: () => Promise<T>;
}>;

type OwnerSessionInput<T> = Readonly<{
  cleanupSql?: readonly string[];
  context: string;
  databaseTarget: DisposableOwnerDatabaseTarget;
  run: (client: PoolClient) => Promise<T>;
}>;

type ValidatedIntegrationMigrationsInput = Readonly<{
  databaseTarget: DisposableOwnerDatabaseTarget;
  migrationsFolder: string;
}>;

type OwnerFaultSqlContract = Readonly<{
  cleanupSqlSha256: readonly string[];
  installSqlSha256: readonly string[];
}>;

const WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const WORKSPACE_MIGRATIONS_FOLDER = path.resolve(WORKSPACE_ROOT, "drizzle");
const OWNER_POOL_SHUTDOWN_TIMEOUT_MS = 5_000;

const APPROVED_OWNER_FAULT_SQL = {
  "0064-dispatch-identity-probe": {
    cleanupSqlSha256: [
      "6606345e39ba4493832a3074b4c1448f71aa8accae1279a54c06673a553b16b6",
      "0db8cefcc23a276e561ca0b2d34852db00bc03103fa8fab4fefc191754870695",
    ],
    installSqlSha256: [
      "bca90b54b7e120b3941462920314c313a5c248aeab972c8d0277b9b8fca011b4",
      "8ee7b66cd92d88552e96617ba6f333779e4b26bf196fe60d76e6d4d22695cc0c",
      "1a54de019f9eb952d8c070e51c6772c30f044c45dd42da78c9c24015b4042f85",
    ],
  },
  "Admin-plan": {
    cleanupSqlSha256: [
      "a74cdefb18c96d959ff3e0ce536a50132cd2a74df81790e044de657b9271d3c6",
      "9f13de2f9af225cfafcc3068613f2e770a3cb92da1e3918cb08ef35934ddab7e",
    ],
    installSqlSha256: [
      "20a3668f2158a28e4666c8fa8df5a3978ff0487d6810cbb1b8342c261386b320",
      "5f3488554619ba5a8fd0414e3bd446c8f1c23561da87ba4f23fdcf96f417949e",
    ],
  },
  "Auth-recovery": {
    cleanupSqlSha256: [
      "3152ef911817ce85470420e1711e8f56584638c43047ded3287397a2085d7518",
      "642941a1823a98083356b58518c48bacbd9ec5f2fc94dac2d089d1ac182f96d1",
    ],
    installSqlSha256: [
      "32b0eac2b98f998f425df3a2ed1b6423ecb2c15f801bf514874b05295bc93860",
      "de7d6470d1aae7e562812e2fef3095fb7692f5864dc566bfddcbfa23cd5557e8",
    ],
  },
  "Exam-autosave": {
    cleanupSqlSha256: [
      "bb97e85a41954eaa9e35125c80d9fec384c2836a8a0ac770b67f571d51dae2e2",
      "bb83b1ae8465e68fbacfe9ecde44d52a47170e0f9535694cd1710da766dff9b7",
    ],
    installSqlSha256: [
      "a8c805553a4882e72843d7f6228959132066eda2e29d2530e4f5af71cd980196",
      "c3cad100605a14afcd3469884b7307ebf93e8cca0852542f72a43f1d52ab49df",
    ],
  },
  "Practice-learning": {
    cleanupSqlSha256: [
      "c8d2ee0b524d4b81c45f35e7791574e831fcbe8dafb78933fa085a873829e5c9",
      "8884bf3812d7dfaf45da5527eb95735c0dce98ef328dc1f26f82fe0ce0e59d7d",
    ],
    installSqlSha256: [
      "42fe6b7255a91af9988d2333ec95187857b65df26abc265abda1b7a00b9f7545",
      "18c4132dbc9dc06fdfb464071eea1ae6c6fb5f46cfde6985162144f9f4dadce8",
    ],
  },
  "Power-rehearsal": {
    cleanupSqlSha256: [
      "b8535892a1405805b8e1d57b846f4bc3e78a77bc130b7006122f2af6a74a76bf",
      "1f7972cbe5c88763ce4d164e0547a4c1be424715d226d50697fe83ec1d9a6f98",
    ],
    installSqlSha256: [
      "f364667f6d3a9babe1b652271897cba7118d70d61121f00acc1cc20d46c3804c",
      "bf3dcb8028a0ad6e42c33f592cc97d10689ae4769178f95878b16cb9db12a4eb",
    ],
  },
  "Retention-redaction": {
    cleanupSqlSha256: [
      "a4c72bb7e0f208eafb96eabf5c83a54e404f032822869c283ea0f3d443c284b3",
      "3dc146f10ca90991d9b75ed689f03f1aafe5430edbb62f48c9a28b7f0a459018",
    ],
    installSqlSha256: [
      "fad5357193d5646cfdd4a95cf2262cf10555a51fdf0632117607acf7737b369a",
      "bba840e99406106c43b5e0699fd8525ceaa1e9293f756980c5b81f1d8cffcc27",
    ],
  },
"disposable reset truncate rollback": {
    cleanupSqlSha256: [
      "97503c307b27a258d7e273e54668bc5b33762cc338e0ae96a4b9e379ed8d0e26",
      "d3b5066b013e43975d215fc00e98dcc148637c9a3f1b9bb52c5d019b635281a9",
    ],
    installSqlSha256: [
      "13cf3531eea8d17804865bd767a0867ff9a4c8fc7cc11811ce0b33f252658076",
      "f3227be9927f3480a6e1b453e303823e2f45d9ad847a30730d541233433b6af2",
    ],
  },
  "disposable reset namespace closed world": {
    cleanupSqlSha256: [
      "46e9a4f45c54ac3213397112da35938be0d512867c19b880399e297d4f9bbdd5",
    ],
    installSqlSha256: [
      "95bd01fa99d7caf841420196721e6e2b9c6a64c9e42369e3ad90e8c569ef303f",
    ],
  },
  "disposable reset outgoing dependency closed world": {
    cleanupSqlSha256: [
      "561e3ddefb2864cb11f5e43d843bb84ae6fb9d68fedc332a88e0cb7a88f53922",
    ],
    installSqlSha256: [
      "40605d4a67eed10e8bc229756b07cedfc1a07567c92e05c76cd6594f871be19a",
    ],
  },
} as const satisfies Readonly<Record<string, OwnerFaultSqlContract>>;

function requirementError(context: string, requirement: string) {
  return new Error(`${context} requires ${requirement}.`);
}

function ownerSqlSha256(sql: string) {
  return createHash("sha256")
    .update(sql.replace(/\r\n?/g, "\n"), "utf8")
    .digest("hex");
}

function validateApprovedOwnerFaultSql(input: FaultInjectionInput<unknown>) {
  const contract = (
    APPROVED_OWNER_FAULT_SQL as Readonly<Record<string, OwnerFaultSqlContract>>
  )[input.context];
  const matches = (
    actual: readonly string[],
    expected: readonly string[],
  ) => (
    actual.length === expected.length
    && actual.every((sql, index) => ownerSqlSha256(sql) === expected[index])
  );
  if (
    !contract
    || !matches(input.installSql, contract.installSqlSha256)
    || !matches(input.cleanupSql, contract.cleanupSqlSha256)
  ) {
    throw requirementError(
      `${input.context} fault injection`,
      "an exact closed-world owner fault contract",
    );
  }
}

function parseDisposableOwnerDatabaseUrl(
  context: string,
  target: DisposableOwnerDatabaseTarget,
): ParsedOwnerDatabaseUrl {
  const applicationConnectionString = target?.databaseApplicationUrl;
  const connectionString = target?.databaseOwnerUrl;
  if (
    typeof applicationConnectionString !== "string"
    || typeof connectionString !== "string"
  ) {
    throw requirementError(context, "a frozen disposable database target");
  }
  let application: URL;
  let owner: URL;
  try {
    application = new URL(applicationConnectionString);
    owner = new URL(connectionString);
  } catch {
    throw requirementError(context, "a valid frozen disposable database target");
  }

  const applicationPort = Number(application.port);
  const ownerPort = Number(owner.port);
  if (
    application.protocol !== "postgresql:"
    || application.username !== "learncoding_app"
    || application.password.length === 0
    || application.hostname !== "127.0.0.1"
    || !Number.isSafeInteger(applicationPort)
    || applicationPort <= 0
    || applicationPort > 65_535
    || applicationPort === 5_432
    || application.pathname !== "/learncoding_integration"
    || application.search !== ""
    || application.hash !== ""
    || owner.protocol !== "postgresql:"
    || owner.username !== "learncoding_migrator"
    || owner.password.length === 0
    || owner.hostname !== application.hostname
    || !Number.isSafeInteger(ownerPort)
    || ownerPort !== applicationPort
    || owner.pathname !== application.pathname
    || owner.search !== "?options=-c+role%3Dlearncoding_owner"
    || owner.hash !== ""
  ) {
    throw requirementError(
      context,
      "the exact frozen non-5432 disposable owner/app target",
    );
  }

  return { connectionString };
}

function throwPreservingFailures(
  context: string,
  primaryFailure: { error: unknown } | undefined,
  cleanupFailures: readonly unknown[],
): void {
  if (primaryFailure && cleanupFailures.length > 0) {
    throw new AggregateError(
      [primaryFailure.error, ...cleanupFailures],
      `${context} failed and cleanup also failed.`,
      { cause: primaryFailure.error },
    );
  }
  if (primaryFailure) throw primaryFailure.error;
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1) {
    throw new AggregateError(
      cleanupFailures,
      `${context} cleanup failed.`,
    );
  }
}

class ValidatedOwnerPoolShutdownTimeoutError extends Error {
  constructor() {
    super("Validated owner pool shutdown timed out.");
    this.name = "ValidatedOwnerPoolShutdownTimeoutError";
  }
}

async function endOwnerPoolWithinDeadline(ownerPool: Pick<Pool, "end">) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const close = Promise.resolve()
    .then(() => ownerPool.end())
    .then(
      () => ({ kind: "closed" as const }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
  const expired = new Promise<{ kind: "timeout" }>((resolve) => {
    timeout = setTimeout(
      () => resolve({ kind: "timeout" }),
      OWNER_POOL_SHUTDOWN_TIMEOUT_MS,
    );
  });
  try {
    const outcome = await Promise.race([close, expired]);
    if (outcome.kind === "timeout") {
      throw new ValidatedOwnerPoolShutdownTimeoutError();
    }
    if (outcome.kind === "failed") throw outcome.error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function withValidatedOwnerSession<T>(
  input: OwnerSessionInput<T>,
): Promise<T> {
  const owner = parseDisposableOwnerDatabaseUrl(
    input.context,
    input.databaseTarget,
  );
  const ownerPool = new Pool({
    application_name: "codestead.integration-validated-owner",
    connectionString: owner.connectionString,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    idle_in_transaction_session_timeout: 5_000,
    lock_timeout: 5_000,
    max: 1,
    query_timeout: 5_000,
    statement_timeout: 5_000,
  });
  let client: PoolClient | undefined;
  let identityValidated = false;
  let result!: T;
  let primaryFailure: { error: unknown } | undefined;
  const cleanupFailures: unknown[] = [];

  try {
    client = await ownerPool.connect();
    const identity = await client.query<OwnerDatabaseIdentity>(`
      select current_database()::text current_database,
             current_user::text current_user,
             session_user::text session_user
    `);
    if (
      identity.rows[0]?.current_database !== "learncoding_integration"
      || identity.rows[0]?.session_user !== "learncoding_migrator"
      || identity.rows[0]?.current_user !== "learncoding_owner"
    ) {
      throw new Error(`${input.context} owner identity mismatch.`);
    }
    identityValidated = true;
    result = await input.run(client);
  } catch (error) {
    primaryFailure = { error };
  } finally {
    if (client) {
      if (identityValidated) {
        for (const sql of input.cleanupSql ?? []) {
          try {
            await client.query(sql);
          } catch (error) {
            cleanupFailures.push(error);
          }
        }
      }
      try {
        client.release(true);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      await endOwnerPoolWithinDeadline(ownerPool);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  throwPreservingFailures(input.context, primaryFailure, cleanupFailures);
  return result;
}

function requireWorkspaceMigrationsFolder(
  context: string,
  input: ValidatedIntegrationMigrationsInput,
) {
  if (
    !path.isAbsolute(input.migrationsFolder)
    || input.migrationsFolder !== WORKSPACE_MIGRATIONS_FOLDER
  ) {
    throw requirementError(context, "the exact workspace drizzle folder");
  }
}

async function verifyExactAppliedMigrationJournal(
  client: PoolClient,
  context: string,
  reviewedMigrations: readonly Readonly<{
    folderMillis: number;
    hash: string;
  }>[],
) {
  const migrationRows = await client.query<{
    created_at: string;
    hash: string;
  }>(
    `SELECT hash::text AS hash, created_at::text AS created_at
       FROM drizzle.__drizzle_migrations
      ORDER BY id ASC`,
  );
  const journalMatches = (
    migrationRows.rows.length === reviewedMigrations.length
    && reviewedMigrations.every((migration, index) => {
      const applied = migrationRows.rows[index];
      return (
        applied?.hash === migration.hash
        && applied.created_at === String(migration.folderMillis)
      );
    })
  );
  if (!journalMatches) {
    throw new Error(`${context} ordered migration journal mismatch.`);
  }
  return reviewedMigrations.length;
}

export async function readValidatedIntegrationMigrationJournal(
  input: ValidatedIntegrationMigrationsInput,
): Promise<number> {
  const context = "PostgreSQL migration journal contract";
  requireWorkspaceMigrationsFolder(context, input);
  verifyReviewedMigrationRepository({
    drizzleDirectory: WORKSPACE_MIGRATIONS_FOLDER,
  });
  const reviewedMigrations = readMigrationFiles({
    migrationsFolder: WORKSPACE_MIGRATIONS_FOLDER,
  });
  return withValidatedOwnerSession({
    context,
    databaseTarget: input.databaseTarget,
    run: async (client) => {
      await verifyAppliedMigrationLedger(client, { requireComplete: true });
      return verifyExactAppliedMigrationJournal(
        client,
        context,
        reviewedMigrations,
      );
    },
  });
}

export async function runValidatedIntegrationMigrations(
  input: ValidatedIntegrationMigrationsInput,
): Promise<number> {
  const context = "PostgreSQL migration contract";
  requireWorkspaceMigrationsFolder(context, input);
  verifyReviewedMigrationRepository({
    drizzleDirectory: WORKSPACE_MIGRATIONS_FOLDER,
  });
  const reviewedMigrations = readMigrationFiles({
    migrationsFolder: WORKSPACE_MIGRATIONS_FOLDER,
  });

  return withValidatedOwnerSession({
    context,
    databaseTarget: input.databaseTarget,
    run: async (client) => {
      await verifyAppliedMigrationLedger(client, { requireComplete: false });
      await migrate(drizzle(client), {
        migrationsFolder: WORKSPACE_MIGRATIONS_FOLDER,
      });
      await verifyAppliedMigrationLedger(client, { requireComplete: true });
      return verifyExactAppliedMigrationJournal(
        client,
        context,
        reviewedMigrations,
      );
    },
  });
}

export async function withValidatedOwnerFaultInjection<T>(
  input: FaultInjectionInput<T>,
): Promise<T> {
  const suppliedTarget = input.databaseTarget as
    | DisposableOwnerDatabaseTarget
    | undefined;
  const snapshot = Object.freeze({
    cleanupSql: Object.freeze([...input.cleanupSql]),
    context: input.context,
    databaseTarget: Object.freeze({
      databaseApplicationUrl: suppliedTarget?.databaseApplicationUrl ?? "",
      databaseOwnerUrl: suppliedTarget?.databaseOwnerUrl ?? "",
    }),
    installSql: Object.freeze([...input.installSql]),
    run: input.run,
  });
  validateApprovedOwnerFaultSql(snapshot);
  return withValidatedOwnerSession({
    context: `${snapshot.context} fault injection`,
    cleanupSql: snapshot.cleanupSql,
    databaseTarget: snapshot.databaseTarget,
    run: async (client) => {
      for (const sql of snapshot.installSql) await client.query(sql);
      return snapshot.run();
    },
  });
}
