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
  release(error?: Error | boolean): void;
}

export interface MigrationPool {
  connect(): Promise<MigrationClient>;
  end(): Promise<void>;
}

export interface ReviewedMigrationRepositorySummary {
  readonly entryCount: number;
  readonly ledgerSha256: string;
  readonly tailIndex: number;
  readonly tailTag: string;
}

export interface AppliedMigrationLedgerSummary {
  readonly appliedCount: number;
  readonly complete: boolean;
  readonly ledgerSha256: string;
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
  verifyReviewedMigrationRepository?: (options: {
    drizzleDirectory: string;
  }) => ReviewedMigrationRepositorySummary;
  verifyAppliedMigrationLedger?: (
    client: MigrationClient,
    options: { requireComplete: boolean },
  ) => Promise<AppliedMigrationLedgerSummary>;
  requiredPostgresMajor?: 17;
  lockOptions?: MigrationLockOptions;
  cleanupTimeoutMs?: number;
  unlockTimeoutMs?: number;
}

export function acquireMigrationLock(
  client: MigrationLockClient,
  options?: MigrationLockOptions,
): Promise<void>;

export function runProductionMigration(
  options: ProductionMigrationOptions,
): Promise<void>;
