import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, opendir, realpath, statfs } from "node:fs/promises";
import path from "node:path";
import { OBJECT_STORAGE_MARKER_NAME } from "./durable-object-store";

import {
  StorageReconciliationError,
  type StorageFilesystemInspection,
  type StorageObjectIntegrityIssue,
  type StorageObjectSnapshot,
  type StorageReconciliationInspector,
} from "./reconciliation";
import {
  openVerifiedStoredObject,
  UploadScanError,
} from "./upload-scanner";

function safeBytes(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new StorageReconciliationError("CAPACITY_UNAVAILABLE");
  }
  return Number(value);
}

function addBytes(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new StorageReconciliationError("CAPACITY_UNAVAILABLE");
  }
  return result;
}

function digestMatches(actual: Buffer, expected: string) {
  if (!/^[0-9a-f]{64}$/i.test(expected)) return false;
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}

async function inspectActiveObject(
  root: string,
  object: StorageObjectSnapshot,
): Promise<StorageObjectIntegrityIssue | null> {
  let handle: Awaited<ReturnType<typeof openVerifiedStoredObject>> | null = null;
  try {
    handle = await openVerifiedStoredObject(root, object);
    const hash = createHash("sha256");
    let bytesRead = 0;
    const stream = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      bytesRead += bytes.byteLength;
      hash.update(bytes);
    }
    const actual = hash.digest();
    if (bytesRead !== object.sizeBytes || !digestMatches(actual, object.sha256)) {
      return { code: "INTEGRITY_MISMATCH", object };
    }
    return null;
  } catch (error) {
    if (error instanceof UploadScanError) {
      if (error.code === "file_missing") return { code: "MISSING_FILE", object };
      if (error.code === "file_changed") return { code: "INTEGRITY_MISMATCH", object };
      if (error.code === "path_invalid") return { code: "INVALID_STORAGE_KEY", object };
    }
    return { code: "INSPECTION_ERROR", object };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function inspectUnknownEntries(
  root: string,
  activeKeys: ReadonlySet<string>,
  deletedKeys: ReadonlySet<string>,
) {
  let orphanEntries = 0;
  let orphanBytes = 0;
  let retainedDeletedFiles = 0;
  let retainedDeletedBytes = 0;
  let inspectionErrors = 0;
  const rootDirectory = await opendir(root);
  for await (const ownerEntry of rootDirectory) {
    if (ownerEntry.name === OBJECT_STORAGE_MARKER_NAME) continue;
    const ownerPath = path.join(root, ownerEntry.name);
    if (!ownerEntry.isDirectory() || ownerEntry.isSymbolicLink()) {
      orphanEntries += 1;
      if (ownerEntry.isFile()) {
        try {
          orphanBytes = addBytes(orphanBytes, (await lstat(ownerPath)).size);
        } catch {
          inspectionErrors += 1;
        }
      }
      continue;
    }
    let ownerDirectory;
    try {
      ownerDirectory = await opendir(ownerPath);
    } catch {
      inspectionErrors += 1;
      continue;
    }
    for await (const objectEntry of ownerDirectory) {
      const key = ownerEntry.name + "/" + objectEntry.name;
      if (activeKeys.has(key)) continue;
      const objectPath = path.join(ownerPath, objectEntry.name);
      let size = 0;
      if (objectEntry.isFile() && !objectEntry.isSymbolicLink()) {
        try {
          size = (await lstat(objectPath)).size;
        } catch {
          inspectionErrors += 1;
          continue;
        }
      }
      if (deletedKeys.has(key) && objectEntry.isFile() && !objectEntry.isSymbolicLink()) {
        retainedDeletedFiles += 1;
        retainedDeletedBytes = addBytes(retainedDeletedBytes, size);
      } else {
        orphanEntries += 1;
        orphanBytes = addBytes(orphanBytes, size);
      }
    }
  }
  return {
    orphanEntries,
    orphanBytes,
    retainedDeletedFiles,
    retainedDeletedBytes,
    inspectionErrors,
  };
}

export class NodeStorageReconciliationInspector implements StorageReconciliationInspector {
  async inspect(
    root: string,
    objects: readonly StorageObjectSnapshot[],
  ): Promise<StorageFilesystemInspection> {
    if (!path.isAbsolute(root)) throw new StorageReconciliationError("ROOT_UNAVAILABLE");
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(root);
      const rootEntry = await lstat(canonicalRoot);
      if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
        throw new StorageReconciliationError("ROOT_UNAVAILABLE");
      }
    } catch (error) {
      if (error instanceof StorageReconciliationError) throw error;
      throw new StorageReconciliationError("ROOT_UNAVAILABLE");
    }
    let filesystem;
    try {
      filesystem = await statfs(canonicalRoot, { bigint: true });
    } catch {
      throw new StorageReconciliationError("CAPACITY_UNAVAILABLE");
    }
    const totalBytes = safeBytes(filesystem.blocks * filesystem.bsize);
    const availableBytes = safeBytes(filesystem.bavail * filesystem.bsize);
    const activeObjects = objects.filter((object) => object.deletedAt === null);
    const objectIssues: StorageObjectIntegrityIssue[] = [];
    let verifiedActiveObjects = 0;
    for (const object of [...activeObjects].sort((left, right) => left.id.localeCompare(right.id))) {
      const issue = await inspectActiveObject(canonicalRoot, object);
      if (issue) objectIssues.push(issue);
      else verifiedActiveObjects += 1;
    }
    const entryInspection = await inspectUnknownEntries(
      canonicalRoot,
      new Set(activeObjects.map((object) => object.storageKey)),
      new Set(objects.filter((object) => object.deletedAt !== null).map((object) => object.storageKey)),
    );
    return {
      verifiedActiveObjects,
      objectIssues,
      ...entryInspection,
      capacity: { totalBytes, availableBytes },
    };
  }
}
