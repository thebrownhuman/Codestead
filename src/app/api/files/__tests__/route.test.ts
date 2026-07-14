import { NextRequest } from "next/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  select: vi.fn(),
  reserve: vi.fn(),
  root: "",
}));

vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/security/rate-limit", () => ({
  withRateLimit: vi.fn(async (_input, handler: () => Promise<Response>) => handler()),
}));
vi.mock("@/lib/storage/object-root", () => ({ objectStorageRoot: () => mocks.root }));
vi.mock("@/lib/storage/quota-store", () => ({
  reserveStoredObject: mocks.reserve,
  StorageQuotaExceededError: class StorageQuotaExceededError extends Error {},
}));

import { GET, POST } from "../route";

describe("learner file API integrity metadata boundary", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.root = await mkdtemp(path.join(tmpdir(), "learncoding-file-route-test-"));
    mocks.requireAuth.mockResolvedValue({
      session: { user: { id: "learner-1" } },
      response: null,
    });
    mocks.reserve.mockResolvedValue(undefined);
  });

  afterEach(async () => {
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
    expect(JSON.stringify(body)).not.toContain("sha256");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("keeps the digest in the server reservation while omitting it from the upload response", async () => {
    const form = new FormData();
    form.set("file", new File(["hello"], "main.py", { type: "text/plain" }));
    const request = {
      formData: async () => form,
    } as unknown as NextRequest;
    const response = await POST(request);
    expect(response.status).toBe(201);
    expect(mocks.reserve).toHaveBeenCalledWith(expect.objectContaining({
      originalName: "main.py",
      sizeBytes: 5,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    const body = await response.json();
    expect(body.file).toMatchObject({ name: "main.py", sizeBytes: 5 });
    expect(body.file).not.toHaveProperty("sha256");
    expect(JSON.stringify(body)).not.toContain("sha256");
  });
});
