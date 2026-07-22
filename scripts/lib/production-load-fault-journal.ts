import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  readdir,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { PRODUCTION_LOAD_FAULT_MATRIX } from "../../src/lib/performance/load-report";
import type { ProductionFault } from "./production-load-faults";

export const PRODUCTION_LOAD_FAULT_JOURNAL_FILENAME = "production-load-fault-journal.json";
export const PRODUCTION_LOAD_FAULT_JOURNAL_TEMP_FILENAME = ".production-load-fault-journal.tmp";
export const PRODUCTION_LOAD_FAULT_JOURNAL_MAX_BYTES = 4 * 1024;

export type ProductionLoadFaultJournalRecord = {
  readonly schemaVersion: 1;
  readonly faultId: ProductionFault["id"];
  readonly project: "learncoding";
  readonly runnerVmId: string;
  readonly candidateRunIdentitySha256: string;
  readonly recordedAt: string;
  readonly state: "active";
};

export type ProductionLoadFaultJournalAccess = {
  readonly journalRoot: string;
  readonly project: "learncoding";
  readonly runnerVmId: string;
  readonly candidateRunIdentitySha256: string;
  readonly requiredOwnerUid?: number;
  readonly requiredRootMode?: number;
  readonly requiredJournalMode?: number;
};

export type ProductionLoadFaultJournalOperations = {
  readonly writeFile: (handle: FileHandle, bytes: Uint8Array) => Promise<void>;
  readonly syncFile: (handle: FileHandle) => Promise<void>;
  readonly rename: (source: string, destination: string) => Promise<void>;
  readonly unlink: (target: string) => Promise<void>;
  readonly syncDirectory: (directory: string) => Promise<void>;
};

type ProductionLoadFaultJournalFileIdentity = {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly changedAtMs: number;
  readonly createdAtMs: number;
  readonly linkCount: number;
};

export type ProductionLoadFaultJournalArtifact = {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly record: ProductionLoadFaultJournalRecord;
  readonly fileIdentity: ProductionLoadFaultJournalFileIdentity;
};

export type LoadedProductionLoadFaultJournal =
  | { readonly status: "empty"; readonly path: string }
  | { readonly status: "active"; readonly artifact: ProductionLoadFaultJournalArtifact };

export type PublishProductionLoadFaultIntentInput = ProductionLoadFaultJournalAccess & {
  readonly faultId: ProductionFault["id"];
  readonly recordedAt: string;
  readonly operations?: Partial<ProductionLoadFaultJournalOperations>;
};

const recordFields = [
  "schemaVersion",
  "faultId",
  "project",
  "runnerVmId",
  "candidateRunIdentitySha256",
  "recordedAt",
  "state",
] as const;
const faultIds = new Set<string>(PRODUCTION_LOAD_FAULT_MATRIX.map((fault) => fault.id));
const runnerVmIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256Pattern = /^sha256:[0-9a-f]{64}$/;
const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const defaultOperations: ProductionLoadFaultJournalOperations = {
  async writeFile(handle, bytes) {
    await handle.writeFile(bytes);
  },
  async syncFile(handle) {
    await handle.sync();
  },
  rename,
  unlink,
  async syncDirectory(directory) {
    if (process.platform === "win32") return;
    const handle = await open(directory, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

function resolveOperations(
  overrides?: Partial<ProductionLoadFaultJournalOperations>,
): ProductionLoadFaultJournalOperations {
  return {
    writeFile: overrides?.writeFile ?? defaultOperations.writeFile,
    syncFile: overrides?.syncFile ?? defaultOperations.syncFile,
    rename: overrides?.rename ?? defaultOperations.rename,
    unlink: overrides?.unlink ?? defaultOperations.unlink,
    syncDirectory: overrides?.syncDirectory ?? defaultOperations.syncDirectory,
  };
}

function nodeErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return String(error.code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !utcTimestampPattern.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validateMode(mode: number | undefined, fallback: number, label: string): number {
  const expected = mode ?? fallback;
  if (!Number.isSafeInteger(expected) || expected < 0 || expected > 0o777) {
    throw new Error("Production load fault journal " + label + " is invalid.");
  }
  return expected;
}

function validateAccess(access: ProductionLoadFaultJournalAccess): void {
  if (access.project !== "learncoding") {
    throw new Error("Production load fault journal project identity is invalid.");
  }
  if (!runnerVmIdPattern.test(access.runnerVmId)) {
    throw new Error("Production load fault journal runner VM identity is invalid.");
  }
  if (!sha256Pattern.test(access.candidateRunIdentitySha256)) {
    throw new Error("Production load fault journal candidate/run identity digest is invalid.");
  }
  if (access.requiredOwnerUid !== undefined
    && (!Number.isSafeInteger(access.requiredOwnerUid) || access.requiredOwnerUid < 0)) {
    throw new Error("Production load fault journal required owner is invalid.");
  }
  const rootMode = validateMode(access.requiredRootMode, 0o700, "required root mode");
  const journalMode = validateMode(
    access.requiredJournalMode,
    0o600,
    "required journal mode",
  );
  if ((rootMode & 0o077) !== 0 || (rootMode & 0o700) !== 0o700) {
    throw new Error("Production load fault journal required root mode is not private.");
  }
  if ((journalMode & 0o077) !== 0
    || (journalMode & 0o111) !== 0
    || (journalMode & 0o400) === 0) {
    throw new Error("Production load fault journal required journal mode is not private.");
  }
}

function normalizedAbsolutePrivateRoot(journalRoot: string): string {
  if (typeof journalRoot !== "string"
    || journalRoot.includes("\0")
    || !path.isAbsolute(journalRoot)) {
    throw new Error("Production load fault journal root must be an absolute path.");
  }
  if (path.normalize(journalRoot) !== journalRoot) {
    throw new Error("Production load fault journal root must be normalized.");
  }
  const parsed = path.parse(journalRoot);
  if (journalRoot === parsed.root) {
    throw new Error("Production load fault journal root must be a private subdirectory.");
  }
  if (process.platform === "win32"
    && (journalRoot.startsWith("\\\\") || journalRoot.startsWith("\\\\?\\"))) {
    throw new Error("Production load fault journal root must be a local absolute path.");
  }
  return journalRoot;
}

function expectedOwnerUid(access: ProductionLoadFaultJournalAccess): number | null {
  if (process.platform === "win32" || typeof process.getuid !== "function") return null;
  return access.requiredOwnerUid ?? process.getuid();
}

async function validatePrivateRoot(
  access: ProductionLoadFaultJournalAccess,
): Promise<string> {
  validateAccess(access);
  const journalRoot = normalizedAbsolutePrivateRoot(access.journalRoot);
  const parsed = path.parse(journalRoot);
  const relative = path.relative(parsed.root, journalRoot);
  const components = relative.split(path.sep).filter((component) => component.length > 0);
  let current = parsed.root;
  let rootMetadata: Stats | null = null;
  for (const component of components) {
    current = path.join(current, component);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new Error("Production load fault journal root must not traverse a symbolic link.");
    }
    if (!metadata.isDirectory()) {
      throw new Error("Production load fault journal root components must be directories.");
    }
    rootMetadata = metadata;
  }
  if (rootMetadata === null) {
    throw new Error("Production load fault journal root is invalid.");
  }
  if (process.platform !== "win32") {
    const requiredMode = validateMode(access.requiredRootMode, 0o700, "required root mode");
    if ((rootMetadata.mode & 0o777) !== requiredMode) {
      throw new Error(
        "Production load fault journal root mode must be " + requiredMode.toString(8) + ".",
      );
    }
    const ownerUid = expectedOwnerUid(access);
    if (ownerUid !== null && rootMetadata.uid !== ownerUid) {
      throw new Error("Production load fault journal root owner is invalid.");
    }
  }
  return journalRoot;
}

async function lstatIfPresent(target: string): Promise<Stats | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function assertNoPartialEvidence(journalRoot: string): Promise<void> {
  const entries = await readdir(journalRoot);
  if (entries.includes(PRODUCTION_LOAD_FAULT_JOURNAL_TEMP_FILENAME)) {
    throw new Error("Production load fault journal contains partial journal evidence.");
  }
}

function toFileIdentity(metadata: Stats): ProductionLoadFaultJournalFileIdentity {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    modifiedAtMs: metadata.mtimeMs,
    changedAtMs: metadata.ctimeMs,
    createdAtMs: metadata.birthtimeMs,
    linkCount: metadata.nlink,
  };
}

function sameFile(
  left: Pick<ProductionLoadFaultJournalFileIdentity, "device" | "inode">,
  right: Pick<ProductionLoadFaultJournalFileIdentity, "device" | "inode">,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sameSnapshot(
  left: ProductionLoadFaultJournalFileIdentity,
  right: ProductionLoadFaultJournalFileIdentity,
): boolean {
  return sameFile(left, right)
    && left.size === right.size
    && left.modifiedAtMs === right.modifiedAtMs
    && left.changedAtMs === right.changedAtMs
    && left.createdAtMs === right.createdAtMs
    && left.linkCount === right.linkCount;
}

function parseJournal(bytes: Uint8Array): ProductionLoadFaultJournalRecord {
  if (bytes.byteLength <= 0 || bytes.byteLength > PRODUCTION_LOAD_FAULT_JOURNAL_MAX_BYTES) {
    throw new Error("Production load fault journal size is invalid.");
  }
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    throw new Error("Production load fault journal must not contain a UTF-8 BOM.");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Production load fault journal must be valid UTF-8.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Production load fault journal must be valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new Error("Production load fault journal must be an object.");
  }
  const actualFields = Object.keys(parsed);
  if (actualFields.length !== recordFields.length
    || actualFields.some((field, index) => field !== recordFields[index])) {
    throw new Error(
      "Production load fault journal contains unexpected, missing, or reordered fields.",
    );
  }
  if (parsed.schemaVersion !== 1
    || typeof parsed.faultId !== "string"
    || !faultIds.has(parsed.faultId)
    || parsed.project !== "learncoding"
    || typeof parsed.runnerVmId !== "string"
    || !runnerVmIdPattern.test(parsed.runnerVmId)
    || typeof parsed.candidateRunIdentitySha256 !== "string"
    || !sha256Pattern.test(parsed.candidateRunIdentitySha256)
    || !isCanonicalUtcTimestamp(parsed.recordedAt)
    || parsed.state !== "active") {
    throw new Error("Production load fault journal contains an invalid field.");
  }
  const record: ProductionLoadFaultJournalRecord = {
    schemaVersion: 1,
    faultId: parsed.faultId as ProductionFault["id"],
    project: "learncoding",
    runnerVmId: parsed.runnerVmId,
    candidateRunIdentitySha256: parsed.candidateRunIdentitySha256,
    recordedAt: parsed.recordedAt,
    state: "active",
  };
  if (JSON.stringify(record, null, 2) + "\n" !== text) {
    throw new Error(
      "Production load fault journal must be canonical two-space JSON with one LF.",
    );
  }
  return record;
}

function assertExpectedIdentity(
  record: ProductionLoadFaultJournalRecord,
  access: ProductionLoadFaultJournalAccess,
): void {
  if (record.project !== access.project
    || record.runnerVmId !== access.runnerVmId
    || record.candidateRunIdentitySha256 !== access.candidateRunIdentitySha256) {
    throw new Error("Production load fault journal identity mismatch.");
  }
}

async function readActiveJournal(
  access: ProductionLoadFaultJournalAccess,
  journalRoot: string,
  journalPath: string,
  pathMetadata: Stats,
): Promise<ProductionLoadFaultJournalArtifact> {
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) {
    throw new Error(
      "Production load fault journal must be a regular file, not a symbolic link.",
    );
  }
  if (pathMetadata.nlink !== 1) {
    throw new Error("Production load fault journal must have exactly one link.");
  }
  if (process.platform !== "win32") {
    const requiredMode = validateMode(
      access.requiredJournalMode,
      0o600,
      "required journal mode",
    );
    if ((pathMetadata.mode & 0o777) !== requiredMode) {
      throw new Error(
        "Production load fault journal mode must be " + requiredMode.toString(8) + ".",
      );
    }
    const ownerUid = expectedOwnerUid(access);
    if (ownerUid !== null && pathMetadata.uid !== ownerUid) {
      throw new Error("Production load fault journal owner is invalid.");
    }
  }
  if (pathMetadata.size <= 0 || pathMetadata.size > PRODUCTION_LOAD_FAULT_JOURNAL_MAX_BYTES) {
    throw new Error("Production load fault journal size is invalid.");
  }

  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const handle = await open(journalPath, constants.O_RDONLY | noFollow);
  let bytes: Buffer;
  let stableIdentity: ProductionLoadFaultJournalFileIdentity;
  try {
    const beforeMetadata = await handle.stat();
    if (!beforeMetadata.isFile() || beforeMetadata.nlink !== 1) {
      throw new Error(
        "Production load fault journal opened object must be a single-link regular file.",
      );
    }
    const pathIdentity = toFileIdentity(pathMetadata);
    const beforeIdentity = toFileIdentity(beforeMetadata);
    if (!sameFile(pathIdentity, beforeIdentity)) {
      throw new Error("Production load fault journal changed while it was opened.");
    }
    bytes = await handle.readFile();
    const afterIdentity = toFileIdentity(await handle.stat());
    if (!sameSnapshot(beforeIdentity, afterIdentity) || bytes.byteLength !== afterIdentity.size) {
      throw new Error("Production load fault journal changed while it was read.");
    }
    stableIdentity = afterIdentity;
  } finally {
    await handle.close();
  }

  const record = parseJournal(bytes);
  assertExpectedIdentity(record, access);
  return {
    path: path.join(journalRoot, PRODUCTION_LOAD_FAULT_JOURNAL_FILENAME),
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    record,
    fileIdentity: stableIdentity,
  };
}

function sameRecord(
  left: ProductionLoadFaultJournalRecord,
  right: ProductionLoadFaultJournalRecord,
): boolean {
  return recordFields.every((field) => left[field] === right[field]);
}

function sameArtifact(
  left: ProductionLoadFaultJournalArtifact,
  right: ProductionLoadFaultJournalArtifact,
): boolean {
  return left.path === right.path
    && left.byteLength === right.byteLength
    && left.sha256 === right.sha256
    && sameRecord(left.record, right.record)
    && sameSnapshot(left.fileIdentity, right.fileIdentity);
}
export async function publishProductionLoadFaultIntent(
  input: PublishProductionLoadFaultIntentInput,
): Promise<ProductionLoadFaultJournalArtifact> {
  validateAccess(input);
  if (!faultIds.has(input.faultId)) {
    throw new Error("Production load fault journal fault id is invalid.");
  }
  if (!isCanonicalUtcTimestamp(input.recordedAt)) {
    throw new Error("Production load fault journal timestamp is invalid.");
  }
  const record: ProductionLoadFaultJournalRecord = {
    schemaVersion: 1,
    faultId: input.faultId,
    project: "learncoding",
    runnerVmId: input.runnerVmId,
    candidateRunIdentitySha256: input.candidateRunIdentitySha256,
    recordedAt: input.recordedAt,
    state: "active",
  };
  const bytes = Buffer.from(JSON.stringify(record, null, 2) + "\n", "utf8");
  if (bytes.byteLength > PRODUCTION_LOAD_FAULT_JOURNAL_MAX_BYTES) {
    throw new Error("Production load fault journal size is invalid.");
  }

  const journalRoot = await validatePrivateRoot(input);
  await assertNoPartialEvidence(journalRoot);
  const journalPath = path.join(journalRoot, PRODUCTION_LOAD_FAULT_JOURNAL_FILENAME);
  const temporaryPath = path.join(
    journalRoot,
    PRODUCTION_LOAD_FAULT_JOURNAL_TEMP_FILENAME,
  );
  if (await lstatIfPresent(journalPath) !== null) {
    throw new Error("Production load fault journal has existing journal evidence.");
  }

  const fileOperations = resolveOperations(input.operations);
  const requiredJournalMode = validateMode(
    input.requiredJournalMode,
    0o600,
    "required journal mode",
  );
  const temporaryHandle = await open(temporaryPath, "wx", requiredJournalMode);
  try {
    await fileOperations.writeFile(temporaryHandle, bytes);
    if (process.platform !== "win32") await temporaryHandle.chmod(requiredJournalMode);
    await fileOperations.syncFile(temporaryHandle);
  } finally {
    await temporaryHandle.close();
  }

  let reservationHandle: FileHandle;
  try {
    reservationHandle = await open(journalPath, "wx", requiredJournalMode);
  } catch (error) {
    if (nodeErrorCode(error) !== "EEXIST") throw error;
    await fileOperations.unlink(temporaryPath);
    await fileOperations.syncDirectory(journalRoot);
    throw new Error("Production load fault journal has existing journal evidence.", {
      cause: error,
    });
  }

  let reservationIdentity: ProductionLoadFaultJournalFileIdentity;
  try {
    if (process.platform !== "win32") await reservationHandle.chmod(requiredJournalMode);
    const reservationMetadata = await reservationHandle.stat();
    if (!reservationMetadata.isFile()
      || reservationMetadata.size !== 0
      || reservationMetadata.nlink !== 1) {
      throw new Error("Production load fault journal publication reservation is invalid.");
    }
    reservationIdentity = toFileIdentity(reservationMetadata);
  } finally {
    await reservationHandle.close();
  }
  const reservedPathMetadata = await lstat(journalPath);
  if (!reservedPathMetadata.isFile()
    || reservedPathMetadata.nlink !== 1
    || !sameFile(reservationIdentity, toFileIdentity(reservedPathMetadata))) {
    throw new Error("Production load fault journal publication reservation changed.");
  }

  await fileOperations.rename(temporaryPath, journalPath);
  await fileOperations.syncDirectory(journalRoot);
  const loaded = await loadProductionLoadFaultJournal(input);
  if (loaded.status !== "active") {
    throw new Error(
      "Production load fault journal publication did not produce an active record.",
    );
  }
  return loaded.artifact;
}

export async function loadProductionLoadFaultJournal(
  access: ProductionLoadFaultJournalAccess,
): Promise<LoadedProductionLoadFaultJournal> {
  const journalRoot = await validatePrivateRoot(access);
  await assertNoPartialEvidence(journalRoot);
  const journalPath = path.join(journalRoot, PRODUCTION_LOAD_FAULT_JOURNAL_FILENAME);
  const pathMetadata = await lstatIfPresent(journalPath);
  if (pathMetadata === null) return { status: "empty", path: journalPath };
  return {
    status: "active",
    artifact: await readActiveJournal(access, journalRoot, journalPath, pathMetadata),
  };
}

export async function clearProductionLoadFaultJournal(
  input: ProductionLoadFaultJournalAccess & {
    readonly expected: ProductionLoadFaultJournalArtifact;
    readonly operations?: Partial<ProductionLoadFaultJournalOperations>;
  },
): Promise<{ readonly status: "cleared"; readonly record: ProductionLoadFaultJournalRecord }> {
  const loaded = await loadProductionLoadFaultJournal(input);
  if (loaded.status === "empty") {
    throw new Error("Production load fault journal expected journal is missing.");
  }
  if (!sameArtifact(loaded.artifact, input.expected)) {
    throw new Error("Production load fault journal changed after it was opened.");
  }
  const currentMetadata = await lstat(loaded.artifact.path);
  if (!currentMetadata.isFile()
    || currentMetadata.nlink !== 1
    || !sameSnapshot(toFileIdentity(currentMetadata), loaded.artifact.fileIdentity)) {
    throw new Error("Production load fault journal changed before it could be cleared.");
  }
  const fileOperations = resolveOperations(input.operations);
  await fileOperations.unlink(loaded.artifact.path);
  await fileOperations.syncDirectory(input.journalRoot);
  return { status: "cleared", record: loaded.artifact.record };
}

export async function recoverProductionLoadFaultJournal(
  input: ProductionLoadFaultJournalAccess & {
    readonly resetAndVerify: (record: ProductionLoadFaultJournalRecord) => Promise<void>;
    readonly operations?: Partial<ProductionLoadFaultJournalOperations>;
  },
): Promise<
  | { readonly status: "empty"; readonly path: string }
  | { readonly status: "recovered"; readonly record: ProductionLoadFaultJournalRecord }
> {
  const loaded = await loadProductionLoadFaultJournal(input);
  if (loaded.status === "empty") return loaded;
  await input.resetAndVerify(loaded.artifact.record);
  await clearProductionLoadFaultJournal({
    ...input,
    expected: loaded.artifact,
  });
  return { status: "recovered", record: loaded.artifact.record };
}
