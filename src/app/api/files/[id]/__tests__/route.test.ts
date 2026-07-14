import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
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
    rm: vi.fn(async () => undefined),
    resolveStoredObjectPath: vi.fn(() => "C:/objects/owner/object"),
  };
});

vi.mock("@/lib/db/client", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/storage/object-root", () => ({ objectStorageRoot: vi.fn(() => "C:/objects") }));
vi.mock("@/lib/storage/upload-scanner", () => ({
  resolveStoredObjectPath: mocks.resolveStoredObjectPath,
  openVerifiedStoredObject: vi.fn(),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, default: { ...actual, rm: mocks.rm }, rm: mocks.rm };
});

import { DELETE } from "../route";

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

  it("atomically tombstones, releases quota once, and then removes the object", async () => {
    const response = await DELETE(new NextRequest("https://learn.test/api/files/id", { method: "DELETE" }), {
      params: Promise.resolve({ id: stored.id }),
    });
    expect(response.status).toBe(204);
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({ scanStatus: "deleted" }));
    expect(mocks.values).toHaveBeenCalledWith({
      userId: "learner-1",
      objectId: stored.id,
      operation: "release",
      bytes: -1200,
      idempotencyKey: `delete:${stored.id}`,
    });
    expect(mocks.onConflictDoNothing).toHaveBeenCalledTimes(1);
    expect(mocks.resolveStoredObjectPath).toHaveBeenCalledWith("C:/objects", "owner/object");
    expect(mocks.rm).toHaveBeenCalledWith("C:/objects/owner/object", { force: true });
  });

  it("does not release quota when the record is absent or loses a concurrent update", async () => {
    mocks.limit.mockResolvedValueOnce([]);
    const missing = await DELETE(new NextRequest("https://learn.test/api/files/id", { method: "DELETE" }), {
      params: Promise.resolve({ id: stored.id }),
    });
    expect(missing.status).toBe(404);
    expect(mocks.insert).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ session: { user: { id: "learner-1" } }, response: null });
    mocks.limit.mockResolvedValue([stored]);
    mocks.returning.mockResolvedValue([]);
    const raced = await DELETE(new NextRequest("https://learn.test/api/files/id", { method: "DELETE" }), {
      params: Promise.resolve({ id: stored.id }),
    });
    expect(raced.status).toBe(404);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.rm).not.toHaveBeenCalled();
  });

  it("keeps the authoritative deletion successful when best-effort physical cleanup fails", async () => {
    mocks.rm.mockRejectedValueOnce(new Error("filesystem unavailable"));
    const response = await DELETE(new NextRequest("https://learn.test/api/files/id", { method: "DELETE" }), {
      params: Promise.resolve({ id: stored.id }),
    });
    expect(response.status).toBe(204);
    expect(mocks.onConflictDoNothing).toHaveBeenCalledTimes(1);
  });
});
