import { NextRequest } from "next/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const errors = vi.hoisted(() => ({
  conflict: class UploadIdempotencyConflictError extends Error {},
  ambiguous: class UploadCommitAmbiguousError extends Error {},
  tombstoned: class UploadIdempotencyTombstonedError extends Error {},
}));

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  select: vi.fn(),
  createUpload: vi.fn(),
  store: {},
  repository: {},
  root: "",
}));

vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/security/rate-limit", () => ({
  withRateLimit: vi.fn(async (_input, handler: () => Promise<Response>) => handler()),
}));
vi.mock("@/lib/storage/object-root", () => ({ objectStorageRoot: () => mocks.root }));
vi.mock("@/lib/storage/durable-object-store", () => ({
  NodeDurableObjectStore: class NodeDurableObjectStore {
    constructor() {
      return mocks.store;
    }
  },
}));
vi.mock("@/lib/storage/upload-repository", () => ({
  PostgresUploadReceiptRepository: class PostgresUploadReceiptRepository {
    constructor() {
      return mocks.repository;
    }
  },
}));
vi.mock("@/lib/storage/upload-service", () => ({
  createDurableUpload: mocks.createUpload,
  UploadIdempotencyConflictError: errors.conflict,
  UploadCommitAmbiguousError: errors.ambiguous,
  UploadIdempotencyTombstonedError: errors.tombstoned,
}));
vi.mock("@/lib/storage/quota-store", () => ({
  StorageQuotaExceededError: class StorageQuotaExceededError extends Error {},
}));

import { GET, POST } from "../route";

const originalUploadsEnabled = process.env.UPLOADS_ENABLED;

describe("learner file API integrity metadata boundary", () => {
  beforeEach(async () => {
    process.env.UPLOADS_ENABLED = "true";
    vi.clearAllMocks();
    mocks.root = await mkdtemp(path.join(tmpdir(), "learncoding-file-route-test-"));
    mocks.requireAuth.mockResolvedValue({
      session: { user: { id: "learner-1" } },
      response: null,
    });
    mocks.createUpload.mockResolvedValue({
      id: "a2000000-0000-4000-8000-000000000001",
      name: "main.py",
      mediaType: "text/plain",
      sizeBytes: 5,
      storageKey: `${"a".repeat(64)}/a2000000-0000-4000-8000-000000000001`,
      sha256: "b".repeat(64),
      scanStatus: "pending",
      replayed: false,
    });
  });

  afterEach(async () => {
    if (originalUploadsEnabled === undefined) delete process.env.UPLOADS_ENABLED;
    else process.env.UPLOADS_ENABLED = originalUploadsEnabled;
    await rm(mocks.root, { recursive: true, force: true });
  });

  it("does not select or return server-side content hashes in the learner listing", async () => {
    mocks.select.mockImplementation(() => {
      const call = mocks.select.mock.calls.length;
      return {
        from: () => ({
          where: () => call === 1
            ? Promise.resolve([{
                id: "file-1",
                name: "main.py",
                mediaType: "text/plain",
                sizeBytes: 5,
                scanStatus: "safe",
                createdAt: new Date("2026-07-12T00:00:00.000Z"),
              }])
            : { limit: async () => [{ quota: 2 * 1024 ** 3 }] },
        }),
      };
    });
    const response = await GET();
    expect(response.status).toBe(200);
    const firstProjection = mocks.select.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstProjection).not.toHaveProperty("sha256");
    const body = await response.json();
    expect(body.files[0]).toMatchObject({ id: "file-1", name: "main.py", sizeBytes: 5 });
    expect(body.uploadsEnabled).toBe(true);
    expect(JSON.stringify(body)).not.toContain("sha256");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("keeps the digest in the server reservation while omitting it from the upload response", async () => {
    const form = new FormData();
    form.set("file", new File(["hello"], "main.py", { type: "text/plain" }));
    const request = {
      headers: new Headers({ "Idempotency-Key": "a1000000-0000-4000-8000-000000000001" }),
      formData: async () => form,
    } as unknown as NextRequest;
    const response = await POST(request);
    expect(response.status).toBe(201);
    expect(mocks.createUpload).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: "learner-1",
      idempotencyKey: "a1000000-0000-4000-8000-000000000001",
      originalName: "main.py",
      mediaType: "text/plain",
      scanStatus: "pending",
      bytes: expect.any(Buffer),
    }), expect.objectContaining({
      store: mocks.store,
      repository: mocks.repository,
    }));
    const body = await response.json();
    expect(body.file).toMatchObject({ name: "main.py", sizeBytes: 5 });
    expect(body.file).not.toHaveProperty("sha256");
    expect(JSON.stringify(body)).not.toContain("sha256");
  });

  it("requires a UUID idempotency key before reading an enabled upload body", async () => {
    const formData = vi.fn(async () => {
      const form = new FormData();
      form.set("file", new File(["hello"], "main.py", { type: "text/plain" }));
      return form;
    });
    const response = await POST({
      headers: new Headers({ "Idempotency-Key": "not-a-uuid" }),
      formData,
    } as unknown as NextRequest);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "INVALID_IDEMPOTENCY_KEY",
      error: "Idempotency-Key must be a UUID.",
    });
    expect(formData).not.toHaveBeenCalled();
    expect(mocks.createUpload).not.toHaveBeenCalled();
  });

  it("returns 409 when a UUID is replayed with a different payload", async () => {
    mocks.createUpload.mockRejectedValueOnce(new errors.conflict());
    const form = new FormData();
    form.set("file", new File(["changed"], "main.py", { type: "text/plain" }));
    const response = await POST({
      headers: new Headers({ "Idempotency-Key": "a1000000-0000-4000-8000-000000000001" }),
      formData: async () => form,
    } as unknown as NextRequest);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
  });

  it("returns a stable no-store 410 when an exact replay belongs to a deleted upload", async () => {
    mocks.createUpload.mockRejectedValueOnce(new errors.tombstoned());
    const form = new FormData();
    form.set("file", new File(["hello"], "main.py", { type: "text/plain" }));
    const response = await POST({
      headers: new Headers({ "Idempotency-Key": "a1000000-0000-4000-8000-000000000001" }),
      formData: async () => form,
    } as unknown as NextRequest);
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      code: "UPLOAD_IDEMPOTENCY_TOMBSTONED",
      error: "This Idempotency-Key belongs to a deleted upload and cannot be reused.",
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects disabled uploads before reading the request body", async () => {
    process.env.UPLOADS_ENABLED = "false";
    const formData = vi.fn(async () => {
      throw new Error("body was parsed");
    });
    const response = await POST({ formData } as unknown as NextRequest);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "UPLOADS_DISABLED",
      error: "Project file uploads are disabled during the private pilot.",
    });
    expect(formData).not.toHaveBeenCalled();
    expect(mocks.createUpload).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
