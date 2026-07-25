import type { Pool } from "pg";

export const PROTECTED_INTEGRATION_TABLES = Object.freeze([
  "backup_status_mail_authority",
  "backup_status_mail_admin_guard",
] as const);

type Environment = Readonly<Record<string, string | undefined>>;
type Queryable = Pick<Pool, "query">;

interface PublicTableRow {
  readonly table_name: string;
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function assertDisposableIntegrationDatabase(environment: Environment) {
  const connectionString = environment.DATABASE_URL ?? "";
  let databaseName = "";
  let protocol = "";
  try {
    const url = new URL(connectionString);
    protocol = url.protocol;
    databaseName = decodeURIComponent(url.pathname)
      .split("/")
      .filter(Boolean)
      .at(-1) ?? "";
  } catch {
    // The shared failure below intentionally avoids reflecting credentials.
  }

  if (
    environment.INTEGRATION_TEST !== "1"
    || !["postgres:", "postgresql:"].includes(protocol)
    || databaseName !== "learncoding_integration"
  ) {
    throw new Error(
      "Integration cleanup requires the disposable "
      + "learncoding_integration database.",
    );
  }
}

export function planIntegrationDatabaseCleanup(
  discoveredTableNames: readonly string[],
) {
  if (
    discoveredTableNames.some(
      (tableName) => typeof tableName !== "string" || tableName.length === 0,
    )
  ) {
    throw new Error(
      "Integration cleanup catalog returned an invalid public table name.",
    );
  }

  const uniqueNames = new Set(discoveredTableNames);
  if (uniqueNames.size !== discoveredTableNames.length) {
    throw new Error(
      "Integration cleanup catalog returned duplicate public table names.",
    );
  }

  const missingProtectedTables = PROTECTED_INTEGRATION_TABLES.filter(
    (tableName) => !uniqueNames.has(tableName),
  );
  if (missingProtectedTables.length > 0) {
    throw new Error(
      "Protected integration table manifest mismatch: missing "
      + missingProtectedTables.join(", "),
    );
  }

  const protectedNames = new Set<string>(PROTECTED_INTEGRATION_TABLES);
  const ordinaryTables = discoveredTableNames
    .filter((tableName) => !protectedNames.has(tableName))
    .sort((left, right) => left.localeCompare(right));
  if (ordinaryTables.length === 0) return null;

  const identifiers = ordinaryTables
    .map((tableName) => `public.${quoteIdentifier(tableName)}`)
    .join(", ");
  return `TRUNCATE TABLE ${identifiers} RESTART IDENTITY`;
}

export function createIntegrationDatabaseCleaner(
  queryable: Queryable,
  environment: Environment = process.env,
) {
  return async function cleanIntegrationDatabase() {
    assertDisposableIntegrationDatabase(environment);
    const catalog = await queryable.query<PublicTableRow>(`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_type = 'BASE TABLE'
       ORDER BY table_name
    `);
    const cleanupSql = planIntegrationDatabaseCleanup(
      catalog.rows.map(({ table_name: tableName }) => tableName),
    );
    if (cleanupSql) await queryable.query(cleanupSql);
  };
}

function formatBackupStatusRunKey(epochMilliseconds: number) {
  const value = new Date(epochMilliseconds);
  const iso = value.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(iso)) {
    throw new Error("Backup status integration run-key range is exhausted.");
  }
  return `${iso.slice(0, 10).replaceAll("-", "")}T`
    + `${iso.slice(11, 19).replaceAll(":", "")}Z`;
}

export function createUniqueBackupStatusRunKeyFactory(
  seed = new Date(),
) {
  let nextEpochMilliseconds =
    Math.floor(seed.getTime() / 1_000) * 1_000;
  if (!Number.isFinite(nextEpochMilliseconds)) {
    throw new Error("Backup status integration run-key seed is invalid.");
  }

  return function nextBackupStatusRunKey() {
    const runKey = formatBackupStatusRunKey(nextEpochMilliseconds);
    nextEpochMilliseconds += 1_000;
    return runKey;
  };
}
