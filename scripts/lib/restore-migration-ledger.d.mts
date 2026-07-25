export type RestoreMigrationLedgerRow = Readonly<{
  migration_index: string;
  migration_sha256: string;
  migration_when: string;
}>;

export type RestoreMigrationLedgerClient = Readonly<{
  query: (
    sql: string,
    values?: readonly unknown[],
  ) => Promise<Readonly<{
    rows: readonly Record<string, unknown>[];
  }>>;
}>;

export function deriveCheckedInRestoreMigrationLedger(
  journal: unknown,
  sqlSources: readonly string[],
): readonly RestoreMigrationLedgerRow[];

export function readCheckedInRestoreMigrationLedger(
  applicationRoot: string,
): Promise<readonly RestoreMigrationLedgerRow[]>;

export function verifyRestoredMigrationLedger(
  client: RestoreMigrationLedgerClient,
  expected: readonly RestoreMigrationLedgerRow[],
): Promise<void>;
