export type ReviewedMigrationRepositoryReport = Readonly<{
  entryCount: number;
  ledgerSha256: string;
  tailIndex: number;
  tailTag: string;
}>;

export type AppliedMigrationLedgerReport = Readonly<{
  appliedCount: number;
  complete: boolean;
  ledgerSha256: string;
}>;

export class ReviewedMigrationLedgerError extends Error {
  readonly code: string;
}

export const REVIEWED_MIGRATION_LEDGER: readonly Readonly<{
  breakpoints: boolean;
  idx: number;
  sqlSha256: string;
  tag: string;
  version: string;
  when: number;
}>[];

export const REVIEWED_MIGRATION_LEDGER_SHA256: string;

export function verifyReviewedMigrationRepository(input?: Readonly<{
  drizzleDirectory?: string | URL;
}>): ReviewedMigrationRepositoryReport;

export function verifyAppliedMigrationLedger(
  client: Readonly<{
    query(sql: string): PromiseLike<Readonly<{
      rows: readonly Record<string, unknown>[];
    }>>;
  }>,
  input?: Readonly<{ requireComplete?: boolean }>,
): Promise<AppliedMigrationLedgerReport>;
