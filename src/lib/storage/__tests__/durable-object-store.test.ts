import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  assertSafeOwnerDirectoryIdentity,
  assertSafeObjectRootIdentity,
  DurableObjectPublicationStateError,
  NodeDurableObjectStore,
  type DurableObjectFilesystem,
  type UploadDurabilityCutpoint,
} from "../durable-object-store";

const OBJECT_ID = "a2000000-0000-4000-8000-000000000001";
const OWNER_SEGMENT = "a".repeat(64);
const ROOT = path.resolve("objects");

function harness(failAt?: UploadDurabilityCutpoint) {
  const events: string[] = [];
  const write = vi.fn(async (_bytes: Uint8Array, _offset: number, length: number) => ({ bytesWritten: length }));
  const directory = {
    reference: path.join(ROOT, OWNER_SEGMENT),
    dev: 8,
    ino: 10,
    sync: vi.fn(async () => { events.push("dir-sync"); }),
    close: vi.fn(async () => { events.push("dir-close"); }),
    stat: vi.fn(async () => ({ dev: 8, ino: 10, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000, mode: 0o40700, nlink: 2 })),
  };
  const filesystem: DurableObjectFilesystem = {
    verifyRoot: vi.fn(async () => { events.push("verify-root"); }),
    prepareOwnerDirectory: vi.fn(async (_root, _owner, flags) => {
      events.push("prepare-parent");
      events.push("root-dir-sync");
      events.push(`open-owner-dir:${flags}`);
      return { directory, created: true };
    }),
    openExistingOwnerDirectory: vi.fn(async (_root, _owner, flags) => {
      events.push(`open-existing-owner-dir:${flags}`);
      return directory;
    }),
    revalidateOwnerDirectory: vi.fn(async () => { events.push("revalidate-parent"); }),
    inspectEntry: vi.fn(async () => ({ dev: 8, ino: 99, mode: 0o100600, nlink: 1 })),
    openExclusiveFile: vi.fn(async (_directory, name, flags, mode) => {
      events.push(`open-file:${name}:${flags}:${mode}`);
      return {
        write: async (bytes: Uint8Array, offset: number, length: number) => { events.push(`write:${offset}:${length}`); return write(bytes, offset, length); },
        sync: async () => { events.push("file-sync"); },
        close: async () => { events.push("file-close"); },
      };
    }),
    renameNoReplace: vi.fn(async (_directory, source, destination) => { events.push(`rename:${source}:${destination}`); }),
    unlink: vi.fn(async (_directory, name) => { events.push(`unlink:${name}`); }),
  };
  const checkpoint = vi.fn(async (point: UploadDurabilityCutpoint) => {
    events.push(`checkpoint:${point}`);
    if (point === failAt) throw new Error(`cut:${point}`);
  });
  const store = new NodeDurableObjectStore({
    root: ROOT,
    filesystem,
    temporarySuffix: () => "fixed",
    checkpoint,
  });
  return { store, filesystem, events, write };
}

describe("crash-consistent durable object creation", () => {
  it("orders exclusive no-follow creation, file sync, no-replace rename, and directory sync", async () => {
    const { store, filesystem, events } = harness();
    const result = await store.create({
      ownerSegment: OWNER_SEGMENT,
      objectId: OBJECT_ID,
      bytes: Buffer.from("durable"),
    });
    expect(result).toEqual({ storageKey: `${OWNER_SEGMENT}/${OBJECT_ID}` });
    const requiredFileFlags = fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | fsConstants.O_WRONLY
      | (fsConstants.O_NOFOLLOW ?? 0);
    expect(filesystem.openExclusiveFile).toHaveBeenCalledWith(
      expect.objectContaining({ reference: path.join(ROOT, OWNER_SEGMENT), dev: 8, ino: 10 }),
      `.${OBJECT_ID}.fixed.uploading`,
      requiredFileFlags,
      0o600,
    );
    expect(filesystem.prepareOwnerDirectory).toHaveBeenCalledWith(
      ROOT,
      OWNER_SEGMENT,
      fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
    );
    expect(events).toEqual([
      "prepare-parent",
      "root-dir-sync",
      `open-owner-dir:${fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0)}`,
      "checkpoint:after_owner_directory_sync_before_temp_create",
      `open-file:.${OBJECT_ID}.fixed.uploading:${requiredFileFlags}:384`,
      "checkpoint:before_temp_write",
      "write:0:7",
      "checkpoint:after_temp_write_before_file_sync",
      "file-sync",
      "checkpoint:after_file_sync",
      "file-close",
      `rename:.${OBJECT_ID}.fixed.uploading:${OBJECT_ID}`,
      "checkpoint:after_rename_before_directory_sync",
      "dir-sync",
      "revalidate-parent",
      "checkpoint:after_directory_sync_before_database",
      "dir-close",
    ]);
  });


  it("exposes a fail-closed root readiness check for long-running workers", async () => {
    const { store, filesystem, events } = harness();
    await expect(store.assertReady()).resolves.toBeUndefined();
    expect(filesystem.verifyRoot).toHaveBeenCalledWith(ROOT, expect.any(Number));
    expect(events).toEqual(["verify-root"]);
  });
  it("loops until every byte is written before file fsync", async () => {
    const { store, write, events } = harness();
    write
      .mockResolvedValueOnce({ bytesWritten: 2 })
      .mockResolvedValueOnce({ bytesWritten: 5 });
    await store.create({ ownerSegment: OWNER_SEGMENT, objectId: OBJECT_ID, bytes: Buffer.from("durable") });
    expect(write.mock.calls.map((call) => [call[1], call[2]])).toEqual([[0, 7], [2, 5]]);
    expect(events.indexOf("write:2:5")).toBeLessThan(events.indexOf("file-sync"));
  });

  it("has a cutpoint only after a newly-created owner directory is synced in the pinned root", async () => {
    const { store, filesystem } = harness("after_owner_directory_sync_before_temp_create" as UploadDurabilityCutpoint);
    await expect(store.create({ ownerSegment: OWNER_SEGMENT, objectId: OBJECT_ID, bytes: Buffer.from("durable") }))
      .rejects.toThrow("cut:after_owner_directory_sync_before_temp_create");
    expect(filesystem.openExclusiveFile).not.toHaveBeenCalled();
  });

  it("requires a root-owned sticky group-writable mount and a root-owned immutable marker", () => {
    const directory = { dev: 8, ino: 10, uid: 0, gid: 1001, mode: 0o41770, nlink: 2 };
    const marker = { dev: 8, ino: 11, uid: 0, gid: 1001, mode: 0o100440, nlink: 1 };
    const valid = { pathEntry: directory, opened: directory, markerPathEntry: marker, markerOpened: marker, expectedWriterGid: 1001 };
    expect(() => assertSafeObjectRootIdentity(valid))
      .not.toThrow();
    expect(() => assertSafeObjectRootIdentity({ ...valid, markerPathEntry: { ...marker, dev: 9 }, markerOpened: { ...marker, dev: 9 } }))
      .toThrow();
    expect(() => assertSafeObjectRootIdentity({ ...valid, markerPathEntry: { ...marker, uid: 1001 }, markerOpened: { ...marker, uid: 1001 } }))
      .toThrow();
    expect(() => assertSafeObjectRootIdentity({ ...valid, markerPathEntry: { ...marker, gid: 0 }, markerOpened: { ...marker, gid: 0 } }))
      .toThrow();
    expect(() => assertSafeObjectRootIdentity({ ...valid, markerPathEntry: { ...marker, mode: 0o100400 }, markerOpened: { ...marker, mode: 0o100400 } }))
      .toThrow();
    expect(() => assertSafeObjectRootIdentity({ ...valid, markerPathEntry: { ...marker, mode: 0o100622 }, markerOpened: { ...marker, mode: 0o100622 } }))
      .toThrow();
    expect(() => assertSafeObjectRootIdentity({ ...valid, pathEntry: { ...directory, uid: 1001 }, opened: { ...directory, uid: 1001 } }))
      .toThrow();
    expect(() => assertSafeObjectRootIdentity({ ...valid, pathEntry: { ...directory, mode: 0o40770 }, opened: { ...directory, mode: 0o40770 } }))
      .toThrow();
    expect(() => assertSafeObjectRootIdentity({ ...valid, expectedWriterGid: 2000 }))
      .toThrow();
  });

  it("requires owner directories to remain writer-owned mode 0700 on the pinned root device", () => {
    const owner = { dev: 8, ino: 10, uid: 1000, gid: 1000, mode: 0o40700, nlink: 2 };
    const valid = { pathEntry: owner, opened: owner, rootDev: 8, expectedOwnerUid: 1000, expectedOwnerGid: 1000 };
    expect(() => assertSafeOwnerDirectoryIdentity(valid)).not.toThrow();
    expect(() => assertSafeOwnerDirectoryIdentity({ ...valid, opened: { ...owner, mode: 0o40770 } })).toThrow();
    expect(() => assertSafeOwnerDirectoryIdentity({ ...valid, opened: { ...owner, uid: 2000 } })).toThrow();
    expect(() => assertSafeOwnerDirectoryIdentity({ ...valid, opened: { ...owner, gid: 2000 } })).toThrow();
  });

  it("retries and syncs cleanup of both names after ambiguous link publication", async () => {
    const { store, filesystem, events } = harness();
    vi.mocked(filesystem.renameNoReplace).mockRejectedValueOnce(new DurableObjectPublicationStateError());
    vi.mocked(filesystem.unlink).mockImplementation(async (_directory, name) => {
      events.push(`unlink:${name}`);
      if (name === OBJECT_ID) throw Object.assign(new Error("destination busy"), { code: "EBUSY" });
    });
    await expect(store.create({ ownerSegment: OWNER_SEGMENT, objectId: OBJECT_ID, bytes: Buffer.from("durable") }))
      .rejects.toThrow("Object cleanup could not be durably confirmed.");
    expect(filesystem.unlink).toHaveBeenNthCalledWith(1, expect.anything(), OBJECT_ID);
    expect(filesystem.unlink).toHaveBeenNthCalledWith(2, expect.anything(), `.${OBJECT_ID}.fixed.uploading`);
    expect(events.indexOf(`unlink:.${OBJECT_ID}.fixed.uploading`)).toBeLessThan(events.indexOf("dir-sync"));
    expect(events.indexOf("dir-sync")).toBeLessThan(events.indexOf("revalidate-parent"));
  });

  it.each<UploadDurabilityCutpoint>([
    "before_temp_write",
    "after_temp_write_before_file_sync",
    "after_file_sync",
    "after_rename_before_directory_sync",
    "after_directory_sync_before_database",
  ])("durably removes deterministic partial state at %s", async (cutpoint) => {
    const { store, filesystem, events } = harness(cutpoint);
    await expect(store.create({
      ownerSegment: OWNER_SEGMENT,
      objectId: OBJECT_ID,
      bytes: Buffer.from("durable"),
    })).rejects.toThrow(`cut:${cutpoint}`);
    expect(filesystem.unlink).toHaveBeenCalledWith(
      expect.objectContaining({ reference: path.join(ROOT, OWNER_SEGMENT) }),
      cutpoint === "after_rename_before_directory_sync" || cutpoint === "after_directory_sync_before_database"
        ? OBJECT_ID
        : `.${OBJECT_ID}.fixed.uploading`,
    );
    expect(events.filter((event) => event === "dir-sync").length).toBeGreaterThanOrEqual(1);
  });

  it("removes a published object and syncs its verified parent even when the file is already absent", async () => {
    const { store, filesystem, events } = harness();
    vi.mocked(filesystem.unlink).mockRejectedValueOnce(Object.assign(new Error("absent"), { code: "ENOENT" }));
    await expect(store.remove(`${OWNER_SEGMENT}/${OBJECT_ID}`)).resolves.toBeUndefined();
    expect(events).toContain("dir-sync");
  });

  it("never recreates a missing parent while removing bytes", async () => {
    const { store, filesystem } = harness();
    vi.mocked(filesystem.openExistingOwnerDirectory).mockImplementationOnce(async () => {
      throw Object.assign(new Error("missing parent"), { code: "ENOENT" });
    });
    await expect(store.remove(`${OWNER_SEGMENT}/${OBJECT_ID}`)).rejects.toThrow("missing parent");
    expect(filesystem.openExistingOwnerDirectory).toHaveBeenCalled();
    expect(filesystem.prepareOwnerDirectory).not.toHaveBeenCalled();
    expect(filesystem.unlink).not.toHaveBeenCalled();
  });

  it("verifies a one-link regular file on the pinned parent device before unlink and sync", async () => {
    const { store, filesystem, events } = harness();
    const inspectEntry = vi.fn(async () => ({ dev: 8, ino: 99, mode: 0o100600, nlink: 1 }));
    Object.assign(filesystem, { inspectEntry });
    await expect(store.erase(`${OWNER_SEGMENT}/${OBJECT_ID}`)).resolves.toEqual({ alreadyAbsent: false });
    expect(inspectEntry).toHaveBeenCalledWith(expect.objectContaining({ dev: 8, ino: 10 }), OBJECT_ID);
    expect(events.indexOf(`unlink:${OBJECT_ID}`)).toBeLessThan(events.indexOf("dir-sync"));
    expect(events.indexOf("dir-sync")).toBeLessThan(events.indexOf("revalidate-parent"));
  });

  it.each([
    { dev: 9, ino: 99, mode: 0o100600, nlink: 1 },
    { dev: 8, ino: 99, mode: 0o120777, nlink: 1 },
    { dev: 8, ino: 99, mode: 0o100600, nlink: 2 },
    { dev: 8, ino: 99, mode: 0o060600, nlink: 1 },
  ])("rejects device, symlink, hardlink, or non-regular drift before erasure %#", async (entry) => {
    const { store, filesystem } = harness();
    Object.assign(filesystem, { inspectEntry: vi.fn(async () => entry) });
    await expect(store.erase(`${OWNER_SEGMENT}/${OBJECT_ID}`)).rejects.toThrow();
    expect(filesystem.unlink).not.toHaveBeenCalled();
  });

  it("accepts final-file ENOENT only after the existing parent is pinned, then still syncs it", async () => {
    const { store, filesystem, events } = harness();
    Object.assign(filesystem, {
      inspectEntry: vi.fn(async () => { throw Object.assign(new Error("absent file"), { code: "ENOENT" }); }),
    });
    await expect(store.erase(`${OWNER_SEGMENT}/${OBJECT_ID}`)).resolves.toEqual({ alreadyAbsent: true });
    expect(filesystem.openExistingOwnerDirectory).toHaveBeenCalled();
    expect(filesystem.unlink).not.toHaveBeenCalled();
    expect(events).toContain("dir-sync");
  });

  it("does not report erasure success when parent directory sync fails after unlink", async () => {
    const { store, filesystem } = harness();
    Object.assign(filesystem, { inspectEntry: vi.fn(async () => ({ dev: 8, ino: 99, mode: 0o100600, nlink: 1 })) });
    const directory = await filesystem.openExistingOwnerDirectory(ROOT, OWNER_SEGMENT, 0);
    vi.mocked(directory.sync).mockRejectedValueOnce(new Error("directory sync failed"));
    await expect(store.erase(`${OWNER_SEGMENT}/${OBJECT_ID}`)).rejects.toThrow("directory sync failed");
  });
});
