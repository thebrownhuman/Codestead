import { createHash } from "node:crypto";

type MigrationJournalEntry = Readonly<{
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}>;

const MINIMUM_RESTORE_MIGRATION_INDEX = 63;
const MIGRATION_LEDGER_VERSION = "drizzle-migration-ledger-v1";

export type MigrationLedgerEntryContract = Readonly<{
  idx: number;
  tag: string;
  when: number;
  sqlSha256: string;
}>;

export type MigrationTailContract = Readonly<{
  entries: readonly MigrationLedgerEntryContract[];
  entryCount: number;
  tailIndex: number;
  tailTag: string;
  tailWhen: number;
  tailSha256: string;
  databaseLedgerSha256: string;
}>;

export type FullSchemaRestoreSnapshot = Readonly<{
  postgresMajor: number;
  journalEntryCount: number;
  journalTailSha256: string;
  journalTailWhen: number;
  migrationLedgerSha256: string;
  objectContractSha256: string;
  mailRowsSha256: string;
  mailRowCount: number;
}>;

export type FullSchemaRestoreArchiveEvidence = Readonly<{
  archiveSha256: string;
  tocSha256: string;
  sourceObjectContractSha256: string;
  sourceBindingSha256: string;
  aclEntryCount: number;
  routineAclEntryCount: number;
}>;

export type FullSchemaAclSuppressionControl = Readonly<{
  proaclIsNull: true;
  publicExecute: true;
  routine: string;
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
  verifyPreRepairMailAuthorityCatalog: () => Promise<void>;
  verifyMailAuthorityCatalog: () => Promise<void>;
  seedRepresentativeMailRows: () => Promise<void>;
  snapshot: () => Promise<FullSchemaRestoreSnapshot>;
}>;

type TargetDatabase = Readonly<{
  reconcileRoles: () => Promise<void>;
  verifyRoleBoundaries: (
    requireApplicationObjects: boolean,
  ) => Promise<void>;
  verifyMailAuthorityCatalog: () => Promise<void>;
  verifyPreRepairMailAuthorityCatalog: () => Promise<void>;
  requireRestoreOwnerRole: () => Promise<void>;
  prepareAclSuppressionControl: () => Promise<void>;
  verifyAclSuppressionControl: () => Promise<FullSchemaAclSuppressionControl>;
  snapshot: () => Promise<FullSchemaRestoreSnapshot>;
  runNonNetworkSmoke: () => Promise<FullSchemaRestoreSmoke>;
}>;

type FullSchemaRestoreDependencies<Archive> = Readonly<{
  expectedPostgresMajor: 17 | 18;
  migration: MigrationTailContract;
  source: SourceDatabase;
  target: TargetDatabase;
  dumpSource: () => Promise<Archive>;
  inspectArchive: (
    archive: Archive,
    source: FullSchemaRestoreSnapshot,
  ) => Promise<FullSchemaRestoreArchiveEvidence>;
  restoreTargetWithoutAcl: (archive: Archive) => Promise<void>;
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

function databaseLedgerRows(
  entries: readonly MigrationLedgerEntryContract[],
): readonly Record<string, string>[] {
  return entries.map((entry) => ({
    migration_index: String(entry.idx),
    migration_sha256: entry.sqlSha256,
    migration_when: String(entry.when),
  }));
}

function databaseLedgerSha256(
  entries: readonly MigrationLedgerEntryContract[],
): string {
  return createHash("sha256").update(JSON.stringify({
    entries: databaseLedgerRows(entries),
    version: MIGRATION_LEDGER_VERSION,
  }), "utf8").digest("hex");
}

export function deriveMigrationLedgerContract(
  journal: unknown,
  sqlSources: readonly string[],
): MigrationTailContract {
  const journalEntries = validatedJournalEntries(journal);
  if (
    !Array.isArray(sqlSources)
    || sqlSources.length !== journalEntries.length
  ) {
    return invalidJournal();
  }
  const entries = journalEntries.map((entry, index) => {
    const sql = sqlSources[index];
    if (typeof sql !== "string" || sql.length === 0 || sql.includes("\0")) {
      return invalidJournal();
    }
    return {
      idx: entry.idx,
      tag: entry.tag,
      when: entry.when,
      sqlSha256: createHash("sha256").update(sql, "utf8").digest("hex"),
    };
  });
  const tail = entries.at(-1);
  if (tail === undefined) return invalidJournal();
  return {
    entries,
    entryCount: entries.length,
    tailIndex: tail.idx,
    tailTag: tail.tag,
    tailWhen: tail.when,
    tailSha256: tail.sqlSha256,
    databaseLedgerSha256: databaseLedgerSha256(entries),
  };
}

export function requireFullSchemaRestoreMigrationContract(
  migration: MigrationTailContract,
): MigrationTailContract {
  const entries = Array.isArray(migration.entries)
    ? migration.entries
    : [];
  const tail = entries.at(-1);
  if (
    migration.tailIndex < MINIMUM_RESTORE_MIGRATION_INDEX
    || migration.entryCount !== migration.tailIndex + 1
    || entries.length !== migration.entryCount
    || tail === undefined
    || tail.idx !== migration.tailIndex
    || tail.tag !== migration.tailTag
    || tail.when !== migration.tailWhen
    || tail.sqlSha256 !== migration.tailSha256
    || migration.databaseLedgerSha256 !==
      databaseLedgerSha256(entries)
    || entries.some((entry, index) =>
      entry.idx !== index
      || !Number.isSafeInteger(entry.when)
      || entry.when <= 0
      || typeof entry.tag !== "string"
      || !new RegExp(`^${String(index).padStart(4, "0")}_`, "u")
        .test(entry.tag)
      || !/^[0-9a-f]{64}$/u.test(entry.sqlSha256)
      || (
        index > 0
        && entry.when <= entries[index - 1]!.when
      ))
  ) {
    throw new Error("full-schema restore requires migration 0063 or later");
  }
  return migration;
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
    && validSha256(value.migrationLedgerSha256)
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
    && left.migrationLedgerSha256 === right.migrationLedgerSha256
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
    && snapshot.migrationLedgerSha256 === migration.databaseLedgerSha256
  );
}

function validatedArchiveEvidence(
  value: FullSchemaRestoreArchiveEvidence,
  source: FullSchemaRestoreSnapshot,
): FullSchemaRestoreArchiveEvidence {
  if (
    !validSha256(value.archiveSha256)
    || !validSha256(value.tocSha256)
    || !validSha256(value.sourceObjectContractSha256)
    || !validSha256(value.sourceBindingSha256)
    || value.sourceObjectContractSha256 !==
      source.objectContractSha256
    || !Number.isSafeInteger(value.aclEntryCount)
    || value.aclEntryCount < 1
    || !Number.isSafeInteger(value.routineAclEntryCount)
    || value.routineAclEntryCount < 1
    || value.routineAclEntryCount > value.aclEntryCount
  ) {
    throw new Error("full-schema restore archive ACL evidence failed");
  }
  return value;
}

function validatedAclSuppressionControl(
  value: FullSchemaAclSuppressionControl,
): FullSchemaAclSuppressionControl {
  if (
    value.proaclIsNull !== true
    || value.publicExecute !== true
    || value.routine !==
      "public.redact_unresolved_email_outbox_authority(timestamp with time zone,integer)"
  ) {
    throw new Error(
      "full-schema restore ACL suppression control failed",
    );
  }
  return value;
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
  requireFullSchemaRestoreMigrationContract(
    dependencies.migration,
  );
  const { source, target } = dependencies;

  // The first bootstrap creates the role topology on a blank disposable
  // database. Every snapshot below is taken before the next reconciliation.
  await source.reconcileRoles();
  await source.verifyRoleBoundaries(false);
  await source.migrate();
  await source.verifyPreRepairMailAuthorityCatalog();
  await source.seedRepresentativeMailRows();
  const rawSourceSnapshot = await source.snapshot();
  if (
    !validSnapshot(rawSourceSnapshot)
    || !snapshotMatchesMigration(
      rawSourceSnapshot,
      dependencies.migration,
      dependencies.expectedPostgresMajor,
    )
  ) {
    return failVerification();
  }

  await source.reconcileRoles();
  await source.verifyRoleBoundaries(true);
  await source.verifyMailAuthorityCatalog();
  const sourceSnapshot = await source.snapshot();
  if (
    !validSnapshot(sourceSnapshot)
    || !sameSnapshot(rawSourceSnapshot, sourceSnapshot)
    || !snapshotMatchesMigration(
      sourceSnapshot,
      dependencies.migration,
      dependencies.expectedPostgresMajor,
    )
  ) {
    return failVerification();
  }

  const archive = await dependencies.dumpSource();
  let archiveEvidence: FullSchemaRestoreArchiveEvidence | undefined;
  let aclSuppressionControl: FullSchemaAclSuppressionControl | undefined;
  try {
    archiveEvidence = validatedArchiveEvidence(
      await dependencies.inspectArchive(archive, sourceSnapshot),
      sourceSnapshot,
    );
    await target.reconcileRoles();
    await target.verifyRoleBoundaries(false);
    await target.requireRestoreOwnerRole();
    await target.prepareAclSuppressionControl();
    // This disposable negative control proves the historical suppression
    // flag recreates PostgreSQL's implicit PUBLIC EXECUTE default. The
    // immediately following clean restore must replace that state before
    // any release-success evidence is collected.
    await dependencies.restoreTargetWithoutAcl(archive);
    aclSuppressionControl = validatedAclSuppressionControl(
      await target.verifyAclSuppressionControl(),
    );
    await target.reconcileRoles();
    await target.verifyRoleBoundaries(false);
    await target.requireRestoreOwnerRole();
    await dependencies.restoreTarget(archive);
  } finally {
    dependencies.disposeArchive(archive);
  }
  if (archiveEvidence === undefined) {
    throw new Error("full-schema restore archive ACL evidence failed");
  }
  if (aclSuppressionControl === undefined) {
    throw new Error(
      "full-schema restore ACL suppression control failed",
    );
  }

  // No post-restore bootstrap or ACL repair is allowed before these checks.
  await target.verifyPreRepairMailAuthorityCatalog();
  const rawRestoredSnapshot = await target.snapshot();
  if (
    !validSnapshot(rawRestoredSnapshot)
    || !sameSnapshot(sourceSnapshot, rawRestoredSnapshot)
  ) {
    return failVerification();
  }

  await target.reconcileRoles();
  await target.verifyRoleBoundaries(true);
  await target.verifyMailAuthorityCatalog();
  const restoredSnapshot = await target.snapshot();
  if (
    !validSnapshot(restoredSnapshot)
    || !sameSnapshot(sourceSnapshot, restoredSnapshot)
    || !sameSnapshot(rawRestoredSnapshot, restoredSnapshot)
  ) {
    return failVerification();
  }

  const smoke = validatedSmoke(await target.runNonNetworkSmoke());
  return {
    aclSuppressionControl,
    archive: archiveEvidence,
    migration: dependencies.migration,
    rawSource: rawSourceSnapshot,
    rawRestored: rawRestoredSnapshot,
    source: sourceSnapshot,
    restored: restoredSnapshot,
    smoke,
  } as const;
}
