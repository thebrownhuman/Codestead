export interface MigrationLockClient {
  query(
    statement: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface MigrationLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface MigrationClient extends MigrationLockClient {
  release(): void;
}

export interface MigrationPool {
  connect(): Promise<MigrationClient>;
  end(): Promise<void>;
}

export interface ProductionMigrationOptions {
  connectionString: string;
  pool?: MigrationPool;
  migrate?: (
    database: unknown,
    options: { migrationsFolder: string },
  ) => Promise<void>;
  drizzle?: (client: MigrationClient) => unknown;
  migrationsFolder?: string;
  lockOptions?: MigrationLockOptions;
}

export function acquireMigrationLock(
  client: MigrationLockClient,
  options?: MigrationLockOptions,
): Promise<void>;

export function runProductionMigration(
  options: ProductionMigrationOptions,
): Promise<void>;
