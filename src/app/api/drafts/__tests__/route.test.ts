import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  requireAuth: vi.fn(),
  withRateLimit: vi.fn(),
}));

vi.mock("@/lib/drafts/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/drafts/repository")>();
  return { ...actual, learnerDraftRepository: { load: mocks.load, save: mocks.save } };
});
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));

import {
  DraftIdempotencyMismatchError,
  DraftQuotaExceededError,
  DraftScopeUnavailableError,
  DraftVersionConflictError,
} from "@/lib/drafts/repository";
import { GET, PUT } from "../route";

const serverDraft = {
  id: "20000000-0000-4000-8000-000000000001",
  kind: "code" as const,
  courseId: "python",
  skillId: "python.variables",
  language: "python",
  content: "answer = 42\n",
  rowVersion: 2,
  createdAt: "2026-07-12T10:00:00.000Z",
  updatedAt: "2026-07-12T10:01:00.000Z",
};

function getRequest(query = "kind=code&courseId=python&skillId=python.variables&language=python") {
  return new NextRequest(`https://learn.test/api/drafts?${query}`);
}

function putRequest(overrides: Record<string, unknown> = {}) {
  return new NextRequest("https://learn.test/api/drafts", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "code",
      courseId: "python",
      skillId: "python.variables",
      language: "python",
      content: "answer = 42\n",
      expectedRowVersion: 1,
      requestId: "10000000-0000-4000-8000-000000000001",
      ...overrides,
    }),
  });
}

describe("authoritative learner draft route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({
      session: { user: { id: "learner-1" }, session: { id: "session-1" } },
      account: { role: "learner", status: "active" },
      response: null,
    });
    mocks.withRateLimit.mockImplementation(async (_check, handler: () => Promise<Response>) => handler());
    mocks.load.mockResolvedValue(serverDraft);
    mocks.save.mockResolvedValue({ draft: serverDraft, replayed: false, committedRowVersion: 2 });
  });

  it("stops revoked or closed-book sessions before parsing or data access", async () => {
    mocks.requireAuth.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ code: "EXAM_CLOSED_BOOK" }, { status: 423 }),
    });
    const response = await GET(getRequest());
    expect(response.status).toBe(423);
    expect(mocks.requireAuth).toHaveBeenCalledWith({ closedBookCapability: "learning_workspace" });
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("loads only the authenticated learner scope and returns an opaque session namespace", async () => {
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.load).toHaveBeenCalledWith("learner-1", {
      kind: "code",
      courseId: "python",
      skillId: "python.variables",
      language: "python",
    });
    const body = await response.json();
    expect(body.draft).toEqual(serverDraft);
    expect(body.cacheNamespace).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.cacheNamespace).not.toContain("learner-1");
    expect(body.cacheNamespace).not.toContain("session-1");
  });

  it("rejects missing or extra query fields without reading PostgreSQL", async () => {
    expect((await GET(getRequest("kind=code&courseId=python"))).status).toBe(400);
    expect((await GET(getRequest("kind=code&courseId=python&skillId=x&language=python&userId=other"))).status).toBe(400);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("strictly validates and binds writes to the session user", async () => {
    const response = await PUT(putRequest());
    expect(response.status).toBe(200);
    expect(mocks.withRateLimit).toHaveBeenCalledWith(
      { policy: "draft_sync_user", identity: { kind: "user", value: "learner-1" } },
      expect.any(Function),
    );
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      userId: "learner-1",
      expectedRowVersion: 1,
      requestId: "10000000-0000-4000-8000-000000000001",
    }));

    const forged = await PUT(putRequest({ userId: "other-learner" }));
    expect(forged.status).toBe(400);
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it("rejects UTF-8 payloads over the byte limit and malformed mutation identifiers", async () => {
    expect((await PUT(putRequest({ content: "😀".repeat(40_000) }))).status).toBe(400);
    expect((await PUT(putRequest({ requestId: "retry-me" }))).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("returns current server state on optimistic concurrency without overwriting", async () => {
    mocks.save.mockRejectedValueOnce(new DraftVersionConflictError(serverDraft));
    const response = await PUT(putRequest());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "DRAFT_VERSION_CONFLICT",
      current: serverDraft,
    });
  });

  it("rejects reuse of a request id with different input", async () => {
    mocks.save.mockRejectedValueOnce(new DraftIdempotencyMismatchError());
    const response = await PUT(putRequest());
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ code: "DRAFT_IDEMPOTENCY_MISMATCH" });
    expect(body).not.toHaveProperty("current");
    expect(body).not.toHaveProperty("cacheNamespace");
  });

  it("fails closed for inaccessible curriculum scope and reports aggregate quota", async () => {
    mocks.load.mockRejectedValueOnce(new DraftScopeUnavailableError());
    const unavailable = await GET(getRequest());
    expect(unavailable.status).toBe(404);
    expect(await unavailable.json()).toMatchObject({ code: "DRAFT_SCOPE_UNAVAILABLE" });

    mocks.save.mockRejectedValueOnce(new DraftQuotaExceededError("bytes"));
    const quota = await PUT(putRequest());
    expect(quota.status).toBe(409);
    const quotaBody = await quota.json();
    expect(quotaBody).toMatchObject({ code: "DRAFT_QUOTA_EXCEEDED", limit: "bytes" });
    expect(quotaBody).not.toHaveProperty("current");
    expect(quotaBody).not.toHaveProperty("cacheNamespace");
  });

  it("requires a language facet for code and forbids one for lesson notes", async () => {
    expect((await GET(getRequest("kind=code&courseId=python&skillId=python.variables&language="))).status).toBe(400);
    expect((await PUT(putRequest({ kind: "lesson", language: "python" }))).status).toBe(400);
    expect((await PUT(putRequest({ language: null }))).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("fails closed without leaking database details", async () => {
    mocks.load.mockRejectedValueOnce(new Error("password=secret"));
    const response = await GET(getRequest());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });
});
