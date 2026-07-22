import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import { resolveStoredObjectPath } from "./upload-scanner";

export const OBJECT_STORAGE_MARKER_NAME = ".codestead-object-root-v1";
export const OBJECT_STORAGE_MARKER_CONTENT = "codestead-object-storage-v1\n";

const OWNER_SEGMENT_PATTERN = /^[0-9a-f]{64}$/;

export type UploadDurabilityCutpoint =
  | "after_owner_directory_sync_before_temp_create"
  | "before_temp_write"
  | "after_temp_write_before_file_sync"
  | "after_file_sync"
  | "after_rename_before_directory_sync"
  | "after_directory_sync_before_database";
export type ErasureDurabilityCutpoint = "after_unlink_before_directory_sync";
type IdentityStat = Pick<Stats, "dev" | "ino" | "uid" | "gid" | "mode" | "nlink">;
type ErasureEntry = Pick<Stats, "dev" | "ino" | "mode" | "nlink">;

type WritableHandle = Pick<FileHandle, "sync" | "close"> & {
  write(bytes: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>;
};

export type PinnedDirectoryHandle = Pick<FileHandle, "sync" | "close"> & {
  stat(): Promise<IdentityStat>;
  readonly reference: string;
  readonly dev: number;
  readonly ino: number;
};

export interface DurableObjectFilesystem {
  verifyRoot(root: string, flags: number): Promise<void>;
  prepareOwnerDirectory(root: string, ownerSegment: string, flags: number): Promise<{
    directory: PinnedDirectoryHandle;
    created: boolean;
  }>;
  openExistingOwnerDirectory(root: string, ownerSegment: string, flags: number): Promise<PinnedDirectoryHandle>;
  revalidateOwnerDirectory(root: string, ownerSegment: string, directory: PinnedDirectoryHandle): Promise<void>;
  inspectEntry(directory: PinnedDirectoryHandle, name: string): Promise<ErasureEntry>;
  openExclusiveFile(directory: PinnedDirectoryHandle, name: string, flags: number, mode: number): Promise<WritableHandle>;
  renameNoReplace(directory: PinnedDirectoryHandle, source: string, destination: string): Promise<void>;
  unlink(directory: PinnedDirectoryHandle, name: string): Promise<void>;
}

export interface DurableObjectStore {
  create(input: {
    ownerSegment: string;
    objectId: string;
    bytes: Buffer;
  }): Promise<{ storageKey: string }>;
  remove(storageKey: string): Promise<void>;
}

export class DurableObjectStoreSafetyError extends Error {
  constructor(message = "Object storage failed its pinned-root safety contract.", options?: ErrorOptions) {
    super(message, options);
    this.name = "DurableObjectStoreSafetyError";
  }
}

export class DurableObjectCleanupError extends Error {
  constructor(options?: ErrorOptions) {
    super("Object cleanup could not be durably confirmed.", options);
    this.name = "DurableObjectCleanupError";
  }
}

export class DurableObjectPublicationStateError extends Error {
  constructor(options?: ErrorOptions) {
    super("No-replace publication left source and destination state ambiguous.", options);
    this.name = "DurableObjectPublicationStateError";
  }
}

function isAlreadyExists(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isAbsent(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function assertSafeObjectRootIdentity(input: {
  pathEntry: IdentityStat;
  opened: IdentityStat;
  markerPathEntry: IdentityStat;
  markerOpened: IdentityStat;
  expectedWriterGid: number;
}) {
  const isDirectory = (value: IdentityStat) => (value.mode & 0o170000) === 0o040000;
  const isFile = (value: IdentityStat) => (value.mode & 0o170000) === 0o100000;
  if (
    !isDirectory(input.pathEntry)
    || !isDirectory(input.opened)
    || input.pathEntry.dev !== input.opened.dev
    || input.pathEntry.ino !== input.opened.ino
    || input.pathEntry.uid !== input.opened.uid
    || input.opened.uid !== 0
    || input.pathEntry.gid !== input.expectedWriterGid
    || input.opened.gid !== input.expectedWriterGid
    || (input.opened.mode & 0o7777) !== 0o1770
    || !isFile(input.markerPathEntry)
    || !isFile(input.markerOpened)
    || input.markerPathEntry.dev !== input.markerOpened.dev
    || input.markerPathEntry.ino !== input.markerOpened.ino
    || input.markerOpened.dev !== input.opened.dev
    || input.markerPathEntry.uid !== 0
    || input.markerOpened.uid !== 0
    || input.markerPathEntry.gid !== input.expectedWriterGid
    || input.markerOpened.gid !== input.expectedWriterGid
    || input.markerPathEntry.nlink !== 1
    || input.markerOpened.nlink !== 1
    || (input.markerPathEntry.mode & 0o777) !== 0o440
    || (input.markerOpened.mode & 0o777) !== 0o440
  ) {
    throw new DurableObjectStoreSafetyError();
  }
}

export function assertSafeOwnerDirectoryIdentity(input: {
  pathEntry: IdentityStat;
  opened: IdentityStat;
  rootDev: number;
  expectedOwnerUid: number;
  expectedOwnerGid: number;
}) {
  const isDirectory = (value: IdentityStat) => (value.mode & 0o170000) === 0o040000;
  if (
    !isDirectory(input.pathEntry)
    || !isDirectory(input.opened)
    || input.pathEntry.dev !== input.opened.dev
    || input.pathEntry.ino !== input.opened.ino
    || input.opened.dev !== input.rootDev
    || input.pathEntry.uid !== input.expectedOwnerUid
    || input.opened.uid !== input.expectedOwnerUid
    || input.pathEntry.gid !== input.expectedOwnerGid
    || input.opened.gid !== input.expectedOwnerGid
    || (input.pathEntry.mode & 0o7777) !== 0o700
    || (input.opened.mode & 0o7777) !== 0o700
  ) {
    throw new DurableObjectStoreSafetyError("Object owner directory failed its pinned identity contract.");
  }
}

type OpenedRoot = {
  canonical: string;
  handle: FileHandle;
  identity: { dev: number; ino: number; uid: number };
};

function procChild(directory: Pick<PinnedDirectoryHandle, "reference">, name: string) {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(name) || name === "." || name === "..") {
    throw new DurableObjectStoreSafetyError();
  }
  return path.join(directory.reference, name);
}

async function openVerifiedRoot(root: string, flags: number): Promise<OpenedRoot> {
  if (process.platform !== "linux") {
    throw new DurableObjectStoreSafetyError("Durable object storage requires Linux procfd semantics.");
  }
  if (!path.isAbsolute(root)) throw new DurableObjectStoreSafetyError();
  const resolved = path.resolve(root);
  let handle: FileHandle | null = null;
  try {
    const canonical = await realpath(resolved);
    const rootEntry = await lstat(resolved);
    if (canonical !== resolved || rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
      throw new DurableObjectStoreSafetyError();
    }
    handle = await open(canonical, flags);
    const openedRoot = await handle.stat();
    const reference = `/proc/self/fd/${handle.fd}`;
    const markerPath = path.join(reference, OBJECT_STORAGE_MARKER_NAME);
    const markerEntry = await lstat(markerPath);
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const writerGid = process.getgid?.();
    if (writerGid === undefined) throw new DurableObjectStoreSafetyError();
    const marker = await open(markerPath, fsConstants.O_RDONLY | noFollow);
    try {
      const opened = await marker.stat();
      assertSafeObjectRootIdentity({
        pathEntry: rootEntry,
        opened: openedRoot,
        markerPathEntry: markerEntry,
        markerOpened: opened,
        expectedWriterGid: writerGid,
      });
      const content = await readFile(marker);
      if (content.toString("utf8") !== OBJECT_STORAGE_MARKER_CONTENT) {
        throw new DurableObjectStoreSafetyError();
      }
    } finally {
      await marker.close();
    }
    return {
      canonical,
      handle,
      identity: { dev: openedRoot.dev, ino: openedRoot.ino, uid: openedRoot.uid },
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof DurableObjectStoreSafetyError) throw error;
    throw new DurableObjectStoreSafetyError(undefined, { cause: error });
  }
}

async function openPinnedOwner(root: string, ownerSegment: string, flags: number, create: boolean) {
  if (!OWNER_SEGMENT_PATTERN.test(ownerSegment)) throw new DurableObjectStoreSafetyError();
  const pinned = await openVerifiedRoot(root, flags);
  const rootReference: PinnedDirectoryHandle = Object.assign(pinned.handle, {
    reference: `/proc/self/fd/${pinned.handle.fd}`,
    dev: pinned.identity.dev,
    ino: pinned.identity.ino,
  });
  const parentReference = procChild(rootReference, ownerSegment);
  let created = false;
  try {
    if (create) {
      try {
        await mkdir(parentReference, { mode: 0o700 });
        created = true;
        await pinned.handle.sync();
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
    }
    const entry = await lstat(parentReference);
    const ownerHandle = await open(parentReference, flags);
    const opened = await ownerHandle.stat();
    const canonicalParent = await realpath(parentReference);
    const expectedParent = path.join(pinned.canonical, ownerSegment);
    const expectedOwnerUid = process.getuid?.();
    const expectedOwnerGid = process.getgid?.();
    if (
      canonicalParent !== expectedParent
      || entry.isSymbolicLink()
      || expectedOwnerUid === undefined
      || expectedOwnerGid === undefined
    ) {
      await ownerHandle.close();
      throw new DurableObjectStoreSafetyError();
    }
    try {
      assertSafeOwnerDirectoryIdentity({
        pathEntry: entry,
        opened,
        rootDev: pinned.identity.dev,
        expectedOwnerUid,
        expectedOwnerGid,
      });
    } catch (error) {
      await ownerHandle.close();
      throw error;
    }
    const directory: PinnedDirectoryHandle = Object.assign(ownerHandle, {
      reference: `/proc/self/fd/${ownerHandle.fd}`,
      dev: opened.dev,
      ino: opened.ino,
    });
    return { directory, created };
  } catch (error) {
    if (error instanceof DurableObjectStoreSafetyError) throw error;
    throw new DurableObjectStoreSafetyError(undefined, { cause: error });
  } finally {
    await pinned.handle.close().catch(() => undefined);
  }
}

async function revalidateOwnerDirectory(root: string, ownerSegment: string, directory: PinnedDirectoryHandle) {
  const pinned = await openVerifiedRoot(root, directoryFlags());
  try {
    if (!OWNER_SEGMENT_PATTERN.test(ownerSegment)) throw new DurableObjectStoreSafetyError();
    const entry = await lstat(path.join(`/proc/self/fd/${pinned.handle.fd}`, ownerSegment));
    const opened = await directory.stat();
    const expectedOwnerUid = process.getuid?.();
    const expectedOwnerGid = process.getgid?.();
    if (entry.isSymbolicLink() || expectedOwnerUid === undefined || expectedOwnerGid === undefined) {
      throw new DurableObjectStoreSafetyError();
    }
    assertSafeOwnerDirectoryIdentity({
      pathEntry: entry,
      opened,
      rootDev: pinned.identity.dev,
      expectedOwnerUid,
      expectedOwnerGid,
    });
    if (opened.dev !== directory.dev || opened.ino !== directory.ino) {
      throw new DurableObjectStoreSafetyError();
    }
  } finally {
    await pinned.handle.close();
  }
}

async function renameNoReplace(directory: PinnedDirectoryHandle, source: string, destination: string) {
  // Node does not expose Linux renameat2(RENAME_NOREPLACE). link(2) is the
  // same-filesystem, atomic no-replace publication primitive; removing the
  // temporary link completes the rename while preserving collision safety.
  const sourcePath = procChild(directory, source);
  const destinationPath = procChild(directory, destination);
  await link(sourcePath, destinationPath);
  try {
    await unlink(sourcePath);
  } catch (error) {
    try {
      await unlink(destinationPath);
    } catch (cleanupError) {
      throw new DurableObjectPublicationStateError({
        cause: new AggregateError([error, cleanupError], "Publication rollback failed."),
      });
    }
    throw error;
  }
}

const nodeFilesystem: DurableObjectFilesystem = {
  verifyRoot: async (root, flags) => {
    const pinned = await openVerifiedRoot(root, flags);
    await pinned.handle.close();
  },
  prepareOwnerDirectory: (root, owner, flags) => openPinnedOwner(root, owner, flags, true),
  openExistingOwnerDirectory: async (root, owner, flags) => (
    await openPinnedOwner(root, owner, flags, false)
  ).directory,
  revalidateOwnerDirectory,
  inspectEntry: (directory, name) => lstat(procChild(directory, name)),
  openExclusiveFile: (directory, name, flags, mode) => open(procChild(directory, name), flags, mode),
  renameNoReplace,
  unlink: (directory, name) => unlink(procChild(directory, name)),
};

function fileFlags() {
  return fsConstants.O_CREAT
    | fsConstants.O_EXCL
    | fsConstants.O_WRONLY
    | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
}

function directoryFlags() {
  return fsConstants.O_RDONLY
    | (typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0)
    | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
}

export class NodeDurableObjectStore implements DurableObjectStore {
  private readonly root: string;
  private readonly filesystem: DurableObjectFilesystem;
  private readonly temporarySuffix: () => string;
  private readonly checkpoint: (point: UploadDurabilityCutpoint) => Promise<void>;
  private readonly erasureCheckpoint: (point: ErasureDurabilityCutpoint) => Promise<void>;

  constructor(input: {
    root: string;
    filesystem?: DurableObjectFilesystem;
    temporarySuffix?: () => string;
    checkpoint?: (point: UploadDurabilityCutpoint) => Promise<void>;
    erasureCheckpoint?: (point: ErasureDurabilityCutpoint) => Promise<void>;
  }) {
    this.root = input.root;
    this.filesystem = input.filesystem ?? nodeFilesystem;
    this.temporarySuffix = input.temporarySuffix ?? randomUUID;
    this.checkpoint = input.checkpoint ?? (async () => undefined);
    this.erasureCheckpoint = input.erasureCheckpoint ?? (async () => undefined);
  }

  private async durableUnlinkNames(
    directory: PinnedDirectoryHandle,
    names: readonly string[],
    ownerSegment: string,
  ) {
    const failures: unknown[] = [];
    for (const name of names) {
      try {
        await this.filesystem.unlink(directory, name);
      } catch (error) {
        if (!isAbsent(error)) failures.push(error);
      }
    }
    try {
      await directory.sync();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.filesystem.revalidateOwnerDirectory(this.root, ownerSegment, directory);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new DurableObjectCleanupError({
        cause: new AggregateError(failures, "Durable object cleanup was incomplete."),
      });
    }
  }

  async assertReady() {
    await this.filesystem.verifyRoot(this.root, directoryFlags());
  }

  async create(input: { ownerSegment: string; objectId: string; bytes: Buffer }) {
    const storageKey = `${input.ownerSegment}/${input.objectId}`;
    resolveStoredObjectPath(this.root, storageKey);
    const prepared = await this.filesystem.prepareOwnerDirectory(
      this.root,
      input.ownerSegment,
      directoryFlags(),
    );
    const parent = prepared.directory;
    const temporary = `.${input.objectId}.${this.temporarySuffix()}.uploading`;
    const destination = input.objectId;
    let handle: WritableHandle | null = null;
    let temporaryCreated = false;
    let published = false;
    try {
      if (prepared.created) await this.checkpoint("after_owner_directory_sync_before_temp_create");
      handle = await this.filesystem.openExclusiveFile(parent, temporary, fileFlags(), 0o600);
      temporaryCreated = true;
      await this.checkpoint("before_temp_write");
      let offset = 0;
      while (offset < input.bytes.byteLength) {
        const result = await handle.write(input.bytes, offset, input.bytes.byteLength - offset);
        if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0 || result.bytesWritten > input.bytes.byteLength - offset) {
          throw new Error("Object storage write made no valid progress.");
        }
        offset += result.bytesWritten;
      }
      await this.checkpoint("after_temp_write_before_file_sync");
      await handle.sync();
      await this.checkpoint("after_file_sync");
      await handle.close();
      handle = null;
      await this.filesystem.renameNoReplace(parent, temporary, destination);
      published = true;
      await this.checkpoint("after_rename_before_directory_sync");
      await parent.sync();
      await this.filesystem.revalidateOwnerDirectory(this.root, input.ownerSegment, parent);
      await this.checkpoint("after_directory_sync_before_database");
      return { storageKey };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (temporaryCreated || published) {
        try {
          const names = error instanceof DurableObjectPublicationStateError
            ? [destination, temporary]
            : [published ? destination : temporary];
          await this.durableUnlinkNames(parent, names, input.ownerSegment);
        } catch (cleanupError) {
          throw new DurableObjectCleanupError({ cause: cleanupError });
        }
      }
      throw error;
    } finally {
      await parent.close().catch(() => undefined);
    }
  }

  async erase(storageKey: string): Promise<{ alreadyAbsent: boolean }> {
    resolveStoredObjectPath(this.root, storageKey);
    const [ownerSegment, objectId] = storageKey.split("/");
    const parent = await this.filesystem.openExistingOwnerDirectory(
      this.root,
      ownerSegment!,
      directoryFlags(),
    );
    try {
      let alreadyAbsent = false;
      let entry: ErasureEntry | null = null;
      try {
        entry = await this.filesystem.inspectEntry(parent, objectId!);
      } catch (error) {
        if (isAbsent(error)) alreadyAbsent = true;
        else throw error;
      }
      if (entry) {
        const regular = (entry.mode & 0o170000) === 0o100000;
        if (!regular || entry.nlink !== 1 || entry.dev !== parent.dev) {
          throw new DurableObjectStoreSafetyError("Object identity drifted before erasure.");
        }
        try {
          await this.filesystem.unlink(parent, objectId!);
          await this.erasureCheckpoint("after_unlink_before_directory_sync");
        } catch (error) {
          if (isAbsent(error)) alreadyAbsent = true;
          else throw error;
        }
      }
      await parent.sync();
      await this.filesystem.revalidateOwnerDirectory(this.root, ownerSegment!, parent);
      return { alreadyAbsent };
    } finally {
      await parent.close().catch(() => undefined);
    }
  }

  async remove(storageKey: string) {
    await this.erase(storageKey);
  }
}
