import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MARKER_NAME = ".codestead-object-root-v1";
const MARKER_CONTENT = "codestead-object-storage-v1\n";
const WRITER_UID = 1000;
const WRITER_GID = 1000;
const APP_DATA_MODE = 0o750;
const DATA_ROOT_MODE = 0o750;
const OBJECT_ROOT_MODE = 0o1770;
const MARKER_MODE = 0o440;

function fail() {
  throw new Error("OBJECT_STORAGE_ROOT_UNSAFE");
}

function isAbsent(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isExists(error) {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function exactDirectory(entry, uid, gid, mode) {
  return entry.isDirectory()
    && !entry.isSymbolicLink()
    && entry.uid === uid
    && entry.gid === gid
    && (entry.mode & 0o7777) === mode;
}

function procChild(parentHandle, name) {
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name)) fail();
  const parentReference = `/proc/self/fd/${parentHandle.fd}`;
  return path.join(parentReference, name);
}

function directoryFlags() {
  return constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
}

async function openDataRoot(target) {
  const canonical = await realpath(target);
  if (canonical !== target) fail();
  const entry = await lstat(target);
  if (!exactDirectory(entry, 0, 0, DATA_ROOT_MODE)) fail();
  const handle = await open(target, directoryFlags());
  try {
    const opened = await handle.stat();
    if (
      entry.dev !== opened.dev
      || entry.ino !== opened.ino
      || !exactDirectory(opened, 0, 0, DATA_ROOT_MODE)
    ) fail();
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function ensureDirectory(parentHandle, name, uid, gid, mode) {
  const target = procChild(parentHandle, name);
  let entry;
  let created = false;
  try {
    entry = await lstat(target);
  } catch (error) {
    if (!isAbsent(error)) throw error;
    await mkdir(target, { mode });
    created = true;
    entry = await lstat(target);
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) fail();
  const handle = await open(target, directoryFlags());
  try {
    const opened = await handle.stat();
    if (
      !opened.isDirectory()
      || entry.dev !== opened.dev
      || entry.ino !== opened.ino
    ) fail();
    await handle.chown(uid, gid);
    await handle.chmod(mode);
    await handle.sync();
    if (created) await parentHandle.sync();
    const [pathEntry, finalOpened] = await Promise.all([lstat(target), handle.stat()]);
    if (
      pathEntry.dev !== finalOpened.dev
      || pathEntry.ino !== finalOpened.ino
      || !exactDirectory(pathEntry, uid, gid, mode)
      || !exactDirectory(finalOpened, uid, gid, mode)
    ) fail();
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) fail();
    offset += bytesWritten;
  }
}

async function createMarker(rootHandle) {
  const markerPath = path.join(`/proc/self/fd/${rootHandle.fd}`, MARKER_NAME);
  let markerHandle;
  try {
    markerHandle = await open(
      markerPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o400,
    );
  } catch (error) {
    if (!isExists(error)) throw error;
    return false;
  }
  try {
    await writeAll(markerHandle, Buffer.from(MARKER_CONTENT, "utf8"));
    await markerHandle.chown(0, WRITER_GID);
    await markerHandle.chmod(MARKER_MODE);
    await markerHandle.sync();
  } catch (error) {
    await markerHandle.close().catch(() => undefined);
    try {
      await unlink(markerPath);
      await rootHandle.sync();
    } catch (cleanupError) {
      throw new Error("OBJECT_STORAGE_MARKER_CLEANUP_FAILED", { cause: cleanupError });
    }
    throw error;
  }
  await markerHandle.close();
  return true;
}

async function verifyContract(configuredRoot, dataRootHandle, appDataHandle, objectRootHandle) {
  const appDataPath = procChild(dataRootHandle, "app-data");
  const objectRootPath = procChild(appDataHandle, "objects");
  const markerPath = path.join(`/proc/self/fd/${objectRootHandle.fd}`, MARKER_NAME);
  let markerHandle;
  try {
    const [
      dataRootEntry,
      dataRootOpened,
      appDataEntry,
      appDataOpened,
      rootEntry,
      rootOpened,
      markerEntry,
    ] = await Promise.all([
      lstat(configuredRoot),
      dataRootHandle.stat(),
      lstat(appDataPath),
      appDataHandle.stat(),
      lstat(objectRootPath),
      objectRootHandle.stat(),
      lstat(markerPath),
    ]);
    markerHandle = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const markerOpened = await markerHandle.stat();
    if (
      dataRootEntry.dev !== dataRootOpened.dev
      || dataRootEntry.ino !== dataRootOpened.ino
      || !exactDirectory(dataRootEntry, 0, 0, DATA_ROOT_MODE)
      || !exactDirectory(dataRootOpened, 0, 0, DATA_ROOT_MODE)
      || appDataEntry.dev !== appDataOpened.dev
      || appDataEntry.ino !== appDataOpened.ino
      || !exactDirectory(appDataEntry, 0, 0, APP_DATA_MODE)
      || !exactDirectory(appDataOpened, 0, 0, APP_DATA_MODE)
      || !exactDirectory(rootEntry, 0, WRITER_GID, OBJECT_ROOT_MODE)
      || !exactDirectory(rootOpened, 0, WRITER_GID, OBJECT_ROOT_MODE)
      || rootEntry.dev !== rootOpened.dev
      || rootEntry.ino !== rootOpened.ino
      || appDataEntry.dev !== rootEntry.dev
      || !markerEntry.isFile()
      || markerEntry.isSymbolicLink()
      || !markerOpened.isFile()
      || markerEntry.dev !== markerOpened.dev
      || markerEntry.ino !== markerOpened.ino
      || rootEntry.dev !== markerEntry.dev
      || markerEntry.uid !== 0
      || markerOpened.uid !== 0
      || markerEntry.gid !== WRITER_GID
      || markerOpened.gid !== WRITER_GID
      || markerEntry.nlink !== 1
      || markerOpened.nlink !== 1
      || (markerEntry.mode & 0o777) !== MARKER_MODE
      || (markerOpened.mode & 0o777) !== MARKER_MODE
    ) fail();
    const markerContent = await markerHandle.readFile({ encoding: "utf8" });
    if (markerContent !== MARKER_CONTENT) fail();
    await objectRootHandle.sync();
  } finally {
    await markerHandle?.close().catch(() => undefined);
  }
}

export async function prepareObjectStorage(environment = process.env) {
  if (process.platform !== "linux" || process.getuid?.() !== 0) fail();
  if (environment.UPLOADS_ENABLED !== "true" && environment.UPLOADS_ENABLED !== "false") fail();
  if (WRITER_UID !== 1000 || WRITER_GID !== 1000) fail();
  if (
    typeof constants.O_DIRECTORY !== "number"
    || typeof constants.O_NOFOLLOW !== "number"
  ) fail();

  const configuredRoot = environment.LEARN_DATA_ROOT ?? "/srv/learncoding";
  if (!path.isAbsolute(configuredRoot) || path.resolve(configuredRoot) !== configuredRoot) fail();
  const dataRootHandle = await openDataRoot(configuredRoot);
  let appDataHandle;
  let objectRootHandle;
  try {
    appDataHandle = await ensureDirectory(dataRootHandle, "app-data", 0, 0, APP_DATA_MODE);
    objectRootHandle = await ensureDirectory(appDataHandle, "objects", 0, WRITER_GID, OBJECT_ROOT_MODE);
    const createdMarker = await createMarker(objectRootHandle);
    if (createdMarker) await objectRootHandle.sync();
    await verifyContract(configuredRoot, dataRootHandle, appDataHandle, objectRootHandle);
  } finally {
    await objectRootHandle?.close().catch(() => undefined);
    await appDataHandle?.close().catch(() => undefined);
    await dataRootHandle.close();
  }
}

async function main() {
  await prepareObjectStorage();
  console.info("object storage root prepared");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("object storage root preparation failed");
    process.exitCode = 1;
  });
}
