import { createHash } from "node:crypto";

type MigrationJournalEntry = Readonly<{
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}>;

export type MigrationTailContract = Readonly<{
  entryCount: number;
  tailIndex: number;
  tailTag: string;
  tailWhen: number;
  tailSha256: string;
}>;

export type FullSchemaRestoreSnapshot = Readonly<{
  postgresMajor: number;
  journalEntryCount: number;
  journalTailSha256: string;
  journalTailWhen: number;
  objectContractSha256: string;
  mailRowsSha256: string;
  mailRowCount: number;
}>;

export type FullSchemaRestoreSmoke = Readonly<{
  claimedRows: number;
  redactedRows: number;
  externalCalls: number;
}>;

type SourceDatabase = Readonly<{
  reconcileRoles: () => Promise<void>;
  verifyRoleBoundaries: (
    requireApplicationObjects: boolean,
  ) => Promise<void>;
  migrate: () => Promise<void>;
  seedRepresentativeMailRows: () => Promise<void>;
  snapshot: () => Promise<FullSchemaRestoreSnapshot>;
}>;

type TargetDatabase = Readonly<{
  reconcileRoles: () => Promise<void>;
  verifyRoleBoundaries: (
    requireApplicationObjects: boolean,
  ) => Promise<void>;
  snapshot: () => Promise<FullSchemaRestoreSnapshot>;
  runNonNetworkSmoke: () => Promise<FullSchemaRestoreSmoke>;
}>;

type FullSchemaRestoreDependencies<Archive> = Readonly<{
  expectedPostgresMajor: 17 | 18;
  migration: MigrationTailContract;
  source: SourceDatabase;
  target: TargetDatabase;
  dumpSource: () => Promise<Archive>;
  restoreTarget: (archive: Archive) => Promise<void>;
  disposeArchive: (archive: Archive) => void;
}>;

function invalidJournal(): never {
  throw new Error("full-schema restore migration journal is invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validatedJournalEntries(value: unknown): readonly MigrationJournalEntry[] {
  if (
    !isRecord(value)
    || value.version !== "7"
    || value.dialect !== "postgresql"
    || !Array.isArray(value.entries)
    || value.entries.length === 0
  ) {
    return invalidJournal();
  }

  let priorWhen = -1;
  const entries: MigrationJournalEntry[] = [];
  for (const [index, candidate] of value.entries.entries()) {
    if (!isRecord(candidate)) return invalidJournal();
    const tagMatch = typeof candidate.tag === "string"
      ? /^([0-9]{4})_[a-z0-9_]+$/u.exec(candidate.tag)
      : null;
    if (
      candidate.idx !== index
      || candidate.version !== value.version
      || !Number.isSafeInteger(candidate.when)
      || (candidate.when as number) <= priorWhen
      || tagMatch === null
      || Number.parseInt(tagMatch[1]!, 10) !== index
      || candidate.breakpoints !== true
    ) {
      return invalidJournal();
    }
    priorWhen = candidate.when as number;
    entries.push({
      idx: index,
      version: candidate.version as string,
      when: candidate.when as number,
      tag: candidate.tag as string,
      breakpoints: true,
    });
  }
  return entries;
}

export function deriveMigrationTailContract(
  journal: unknown,
  tailSql: string,
): MigrationTailContract {
  const entries = validatedJournalEntries(journal);
  if (
    typeof tailSql !== "string"
    || tailSql.length === 0
    || tailSql.includes("\0")
  ) {
    return invalidJournal();
  }
  const tail = entries.at(-1);
  if (tail === undefined) return invalidJournal();
  return {
    entryCount: entries.length,
    tailIndex: tail.idx,
    tailTag: tail.tag,
    tailWhen: tail.when,
    tailSha256: createHash("sha256").update(tailSql, "utf8").digest("hex"),
  };
}

function validSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function validSnapshot(
  value: FullSchemaRestoreSnapshot,
): value is FullSchemaRestoreSnapshot {
  return (
    (value.postgresMajor === 17 || value.postgresMajor === 18)
    && Number.isSafeInteger(value.journalEntryCount)
    && value.journalEntryCount > 0
    && validSha256(value.journalTailSha256)
    && Number.isSafeInteger(value.journalTailWhen)
    && value.journalTailWhen > 0
    && validSha256(value.objectContractSha256)
    && validSha256(value.mailRowsSha256)
    && Number.isSafeInteger(value.mailRowCount)
    && value.mailRowCount > 0
  );
}

function sameSnapshot(
  left: FullSchemaRestoreSnapshot,
  right: FullSchemaRestoreSnapshot,
): boolean {
  return (
    left.postgresMajor === right.postgresMajor
    && left.journalEntryCount === right.journalEntryCount
    && left.journalTailSha256 === right.journalTailSha256
    && left.journalTailWhen === right.journalTailWhen
    && left.objectContractSha256 === right.objectContractSha256
    && left.mailRowsSha256 === right.mailRowsSha256
    && left.mailRowCount === right.mailRowCount
  );
}

function snapshotMatchesMigration(
  snapshot: FullSchemaRestoreSnapshot,
  migration: MigrationTailContract,
  expectedPostgresMajor: 17 | 18,
): boolean {
  return (
    snapshot.postgresMajor === expectedPostgresMajor
    && snapshot.journalEntryCount === migration.entryCount
    && snapshot.journalTailSha256 === migration.tailSha256
    && snapshot.journalTailWhen === migration.tailWhen
  );
}

function failVerification(): never {
  throw new Error("full-schema restore verification failed");
}

function validatedSmoke(
  value: FullSchemaRestoreSmoke,
): FullSchemaRestoreSmoke {
  if (
    !Number.isSafeInteger(value.claimedRows)
    || value.claimedRows < 1
    || !Number.isSafeInteger(value.redactedRows)
    || value.redactedRows !== 2
    || value.externalCalls !== 0
  ) {
    throw new Error("full-schema restore smoke verification failed");
  }
  return value;
}

export async function runFullSchemaRestoreVerification<Archive>(
  dependencies: FullSchemaRestoreDependencies<Archive>,
) {
  const { source, target } = dependencies;

  await source.reconcileRoles();
  await source.verifyRoleBoundaries(false);
  await source.migrate();
  await source.reconcileRoles();
  await source.verifyRoleBoundaries(true);
  await source.seedRepresentativeMailRows();
  const sourceSnapshot = await source.snapshot();
  if (
    !validSnapshot(sourceSnapshot)
    || !snapshotMatchesMigration(
      sourceSnapshot,
      dependencies.migration,
      dependencies.expectedPostgresMajor,
    )
  ) {
    return failVerification();
  }

  const archive = await dependencies.dumpSource();
  try {
    await target.reconcileRoles();
    await target.verifyRoleBoundaries(false);
    await dependencies.restoreTarget(archive);
  } finally {
    dependencies.disposeArchive(archive);
  }
  await target.reconcileRoles();
  await target.verifyRoleBoundaries(true);
  const restoredSnapshot = await target.snapshot();
  if (
    !validSnapshot(restoredSnapshot)
    || !sameSnapshot(sourceSnapshot, restoredSnapshot)
  ) {
    return failVerification();
  }

  const smoke = validatedSmoke(await target.runNonNetworkSmoke());
  return {
    migration: dependencies.migration,
    source: sourceSnapshot,
    restored: restoredSnapshot,
    smoke,
  } as const;
}
