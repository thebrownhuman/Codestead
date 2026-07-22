import { describe, expect, it, vi } from "vitest";

import {
  createDurableUpload,
  UploadCommitAmbiguousError,
  UploadIdempotencyConflictError,
  UploadIdempotencyTombstonedError,
  uploadRequestHash,
  type DurableUploadObject,
  type UploadReceiptRepository,
} from "../upload-service";

const KEY = "b1000000-0000-4000-8000-000000000001";
const OBJECT_ID = "b2000000-0000-4000-8000-000000000001";
const OWNER = "learner-1";
const STORAGE_KEY = `${"b".repeat(64)}/${OBJECT_ID}`;
const object: DurableUploadObject = {
  id: OBJECT_ID,
  name: "main.py",
  mediaType: "text/plain",
  sizeBytes: 5,
  storageKey: STORAGE_KEY,
  sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  scanStatus: "pending",
};

function harness() {
  const store = {
    create: vi.fn(async () => ({ storageKey: STORAGE_KEY })),
    remove: vi.fn(async () => undefined),
  };
  const repository: UploadReceiptRepository = {
    find: vi.fn(async () => null),
    commit: vi.fn(async () => ({ disposition: "created" as const, object })),
  };
  return { store, repository };
}

function request(bytes = Buffer.from("hello")) {
  return {
    ownerUserId: OWNER,
    idempotencyKey: KEY,
    originalName: "main.py",
    mediaType: "text/plain",
    scanStatus: "pending",
    bytes,
  };
}

describe("durable idempotent upload service", () => {
  it("binds a UUID key to a versioned payload hash and publishes metadata only after durable bytes", async () => {
    const { store, repository } = harness();
    const bytes = Buffer.from("hello");
    await expect(createDurableUpload(request(bytes), {
      store,
      repository,
      objectId: () => OBJECT_ID,
    })).resolves.toEqual({ ...object, replayed: false });
    expect(store.create).toHaveBeenCalledBefore(vi.mocked(repository.commit));
    expect(repository.commit).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: OWNER,
      idempotencyKey: KEY,
      requestHash: expect.stringMatching(/^v1:[0-9a-f]{64}$/),
      object: expect.objectContaining({
        id: OBJECT_ID,
        storageKey: STORAGE_KEY,
        sha256: object.sha256,
      }),
    }));
    expect(bytes.equals(Buffer.alloc(5))).toBe(true);
  });

  it("canonicalizes uppercase UUID text before every receipt and ledger boundary", async () => {
    const { store, repository } = harness();
    await createDurableUpload({ ...request(), idempotencyKey: KEY.toUpperCase() }, {
      store,
      repository,
      objectId: () => OBJECT_ID,
    });
    expect(repository.find).toHaveBeenCalledWith(OWNER, KEY);
    expect(repository.commit).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: KEY }));
  });

  it("returns the exact prior object without touching storage", async () => {
    const { store, repository } = harness();
    const probe = Buffer.from("hello");
    const exactHash = uploadRequestHash({
      originalName: object.name,
      mediaType: object.mediaType,
      sizeBytes: object.sizeBytes,
      sha256: object.sha256,
      scanStatus: object.scanStatus,
    });
    vi.mocked(repository.find).mockResolvedValueOnce({ requestHash: exactHash, object, tombstoned: false });
    await expect(createDurableUpload(request(probe), { store, repository, objectId: () => OBJECT_ID }))
      .resolves.toEqual({ ...object, replayed: true });
    expect(store.create).not.toHaveBeenCalled();
    expect(repository.commit).not.toHaveBeenCalled();
    expect(probe.equals(Buffer.alloc(5))).toBe(true);
  });

  it("rejects a reused key with a different payload before writing bytes", async () => {
    const { store, repository } = harness();
    vi.mocked(repository.find).mockResolvedValueOnce({ requestHash: `v1:${"f".repeat(64)}`, object, tombstoned: false });
    await expect(createDurableUpload(request(), { store, repository, objectId: () => OBJECT_ID }))
      .rejects.toBeInstanceOf(UploadIdempotencyConflictError);
    expect(store.create).not.toHaveBeenCalled();
  });

  it("rejects an exact replay after deletion without releasing the reserved key", async () => {
    const { store, repository } = harness();
    const exactHash = uploadRequestHash({
      originalName: object.name,
      mediaType: object.mediaType,
      sizeBytes: object.sizeBytes,
      sha256: object.sha256,
      scanStatus: object.scanStatus,
    });
    vi.mocked(repository.find).mockResolvedValueOnce({
      requestHash: exactHash,
      object,
      tombstoned: true,
    });
    await expect(createDurableUpload(request(), { store, repository, objectId: () => OBJECT_ID }))
      .rejects.toBeInstanceOf(UploadIdempotencyTombstonedError);
    expect(store.create).not.toHaveBeenCalled();
    expect(repository.commit).not.toHaveBeenCalled();
  });

  it("durably removes bytes after a deterministic database rollback", async () => {
    const { store, repository } = harness();
    vi.mocked(repository.commit).mockRejectedValueOnce(new Error("transaction rolled back"));
    await expect(createDurableUpload(request(), { store, repository, objectId: () => OBJECT_ID }))
      .rejects.toThrow("transaction rolled back");
    expect(store.remove).toHaveBeenCalledWith(STORAGE_KEY);
  });

  it("never removes possibly committed bytes after an ambiguous commit", async () => {
    const { store, repository } = harness();
    vi.mocked(repository.commit).mockRejectedValueOnce(new UploadCommitAmbiguousError());
    await expect(createDurableUpload(request(), { store, repository, objectId: () => OBJECT_ID }))
      .rejects.toBeInstanceOf(UploadCommitAmbiguousError);
    expect(store.remove).not.toHaveBeenCalled();
  });

  it("does not roll back bytes when the response is lost after a confirmed commit", async () => {
    const { store, repository } = harness();
    await expect(createDurableUpload(request(), {
      store,
      repository,
      objectId: () => OBJECT_ID,
      checkpoint: async (point) => {
        if (point === "after_database_commit_before_response") throw new Error("lost response");
      },
    })).rejects.toThrow("lost response");
    expect(store.remove).not.toHaveBeenCalled();
  });

  it("removes a losing concurrent publication and returns the winner", async () => {
    const { store, repository } = harness();
    const winner = { ...object, id: "b2000000-0000-4000-8000-000000000002", storageKey: `${"b".repeat(64)}/b2000000-0000-4000-8000-000000000002` };
    vi.mocked(repository.commit).mockResolvedValueOnce({ disposition: "replay", object: winner });
    await expect(createDurableUpload(request(), { store, repository, objectId: () => OBJECT_ID }))
      .resolves.toEqual({ ...winner, replayed: true });
    expect(store.remove).toHaveBeenCalledWith(STORAGE_KEY);
  });

  it("removes losing bytes when a concurrent replay has already been tombstoned", async () => {
    const { store, repository } = harness();
    vi.mocked(repository.commit).mockResolvedValueOnce({ disposition: "tombstoned", object });
    await expect(createDurableUpload(request(), { store, repository, objectId: () => OBJECT_ID }))
      .rejects.toBeInstanceOf(UploadIdempotencyTombstonedError);
    expect(store.remove).toHaveBeenCalledWith(STORAGE_KEY);
  });
});
