import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class FileDeletionCommitAmbiguousError extends Error {}
  const limit = vi.fn();
  const whereSelect = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where: whereSelect }));
  const select = vi.fn(() => ({ from }));
  const returning = vi.fn();
  const whereUpdate = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: whereUpdate }));
  const update = vi.fn(() => ({ set }));
  const onConflictDoNothing = vi.fn();
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  const tx = { select, update, insert };
  return {
    limit,
    returning,
    select,
    set,
    update,
    values,
    insert,
    onConflictDoNothing,
    transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    requireAuth: vi.fn(),
    FileDeletionCommitAmbiguousError,
    deleteUserFile: vi.fn(),
    rm: vi.fn(async () => undefined),
    openVerifiedStoredObject: vi.fn(),
    resolveStoredObjectPath: vi.fn(() => "C:/objects/owner/object"),
  };
});

vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select, transaction: mocks.transaction } }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/storage/object-root", () => ({ objectStorageRoot: vi.fn(() => "C:/objects") }));
vi.mock("@/lib/storage/upload-scanner", () => ({
  resolveStoredObjectPath: mocks.resolveStoredObjectPath,
  openVerifiedStoredObject: mocks.openVerifiedStoredObject,
}));
vi.mock("@/lib/storage/file-deletion", () => ({
  deleteUserFile: mocks.deleteUserFile,
  FileDeletionCommitAmbiguousError: mocks.FileDeletionCommitAmbiguousError,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, default: { ...actual, rm: mocks.rm }, rm: mocks.rm };
});

import { DELETE, GET } from "../route";

const stored = {
  id: "e1000000-0000-4000-8000-000000000001",
  ownerUserId: "learner-1",
  storageKey: "owner/object",
  originalName: "answer.py",
  mediaType: "text/plain",
  sizeBytes: 1200,
  sha256: "a".repeat(64),
  scanStatus: "safe",
  deletedAt: null,
};

describe("learner file deletion route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({
      session: { user: { id: "learner-1" } },
      response: null,
    });
    mocks.limit.mockResolvedValue([stored]);
    mocks.returning.mockResolvedValue([{ id: stored.id }]);
    mocks.onConflictDoNothing.mockResolvedValue(undefined);
    mocks.deleteUserFile.mockResolvedValue({ id: stored.id, replayed: false });
  });

  it("requires authentication before reading file metadata", async () => {
    mocks.requireAuth.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });
    const response = await DELETE(new NextRequest("https://learn.test/api/files/id", { method: "DELETE" }), {
      params: Promise.resolve({ id: stored.id }),
    });
    expect(response.status).toBe(401);
    expect(mocks.transaction).not.toHaveBeenCalled();

  });
  it("returns not found for a non-canonical GET id before querying PostgreSQL", async () => {
    const response = await GET(
      new NextRequest("https://learn.test/api/files/not-a-uuid"),
      { params: Promise.resolve({ id: "not-a-uuid" }) },
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "File not found." });
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.deleteUserFile).not.toHaveBeenCalled();
  });

  it("returns not found for a non-canonical DELETE id before its transaction", async () => {
    const response = await DELETE(
      new NextRequest("https://learn.test/api/files/E1000000-0000-4000-8000-000000000001", { method: "DELETE" }),
      { params: Promise.resolve({ id: "E1000000-0000-4000-8000-000000000001" }) },
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "File not found." });
    expect(mocks.deleteUserFile).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });


  it("marks pending scan state private and no-store", async () => {
    mocks.limit.mockResolvedValueOnce([{ ...stored, scanStatus: "pending" }]);
    const response = await GET(
      new NextRequest(`https://learn.test/api/files/${stored.id}`),
      { params: Promise.resolve({ id: stored.id }) },
    );
    expect(response.status).toBe(423);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.openVerifiedStoredObject).not.toHaveBeenCalled();
  });

  it("marks integrity-failure state private and no-store", async () => {
    mocks.openVerifiedStoredObject.mockRejectedValueOnce(new Error("storage mismatch"));
    const response = await GET(
      new NextRequest(`https://learn.test/api/files/${stored.id}`),
      { params: Promise.resolve({ id: stored.id }) },
    );
    expect(response.status).toBe(423);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("atomically tombstones, releases quota once, and durably enqueues erasure", async () => {
    const response = await DELETE(new NextRequest("https://learn.test/api/files/id", { method: "DELETE" }), {
      params: Promise.resolve({ id: stored.id }),
    });
    expect(response.status).toBe(202);
    expect(mocks.deleteUserFile).toHaveBeenCalledWith({
      ownerUserId: "learner-1",
      objectId: stored.id,
    });
    expect(mocks.resolveStoredObjectPath).not.toHaveBeenCalled();
    expect(mocks.rm).not.toHaveBeenCalled();
  });

  it("returns not found when no owner-bound object can be locked", async () => {
    mocks.deleteUserFile.mockResolvedValueOnce(null);
    const missing = await DELETE(new NextRequest("https://learn.test/api/files/id", { method: "DELETE" }), {
      params: Promise.resolve({ id: stored.id }),
    });
    expect(missing.status).toBe(404);
    expect(mocks.rm).not.toHaveBeenCalled();
  });

  it("returns the same accepted outcome when a lost response is replayed", async () => {
    mocks.deleteUserFile.mockResolvedValueOnce({ id: stored.id, replayed: true });
    const response = await DELETE(new NextRequest("https://learn.test/api/files/id", { method: "DELETE" }), {
      params: Promise.resolve({ id: stored.id }),
    });
    expect(response.status).toBe(202);
    expect(mocks.deleteUserFile).toHaveBeenCalledTimes(1);
    expect(mocks.rm).not.toHaveBeenCalled();
  });

  it("returns a stable retry-same-object response when commit outcome is ambiguous", async () => {
    mocks.deleteUserFile.mockRejectedValueOnce(new mocks.FileDeletionCommitAmbiguousError());
    const response = await DELETE(new NextRequest("https://learn.test/api/files/id", { method: "DELETE" }), {
      params: Promise.resolve({ id: stored.id }),
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      code: "FILE_DELETE_COMMIT_AMBIGUOUS",
      error: "Deletion outcome is uncertain. Retry deleting this same file.",
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.rm).not.toHaveBeenCalled();
  });
});
