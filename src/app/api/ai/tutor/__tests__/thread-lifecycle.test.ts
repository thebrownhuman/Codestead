import { readFileSync } from "node:fs";
import path from "node:path";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return {
    limit,
    where,
    from,
    select,
    transaction: vi.fn(),
    requireAuth: vi.fn(),
    gateClosedBookCapability: vi.fn(),
    withRateLimit: vi.fn(),
    executeProviderOperationIdempotently: vi.fn(),
    routeTutorRequest: vi.fn(),
    getCourse: vi.fn(),
    getSkillLocation: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({
  db: {
    select: mocks.select,
    transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/exams/capability-gate", () => ({ gateClosedBookCapability: mocks.gateClosedBookCapability }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));
vi.mock("@/lib/ai/provider-operation-idempotency", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/provider-operation-idempotency")>()),
  canonicalProviderOperationHash: () => "a".repeat(64),
  executeProviderOperationIdempotently: mocks.executeProviderOperationIdempotently,
}));
vi.mock("@/lib/ai/router", () => ({ routeTutorRequest: mocks.routeTutorRequest }));
vi.mock("@/lib/content", () => ({
  createContentRepository: () => ({
    getCourse: mocks.getCourse,
    getSkillLocation: mocks.getSkillLocation,
  }),
}));

import { POST } from "../route";
import { ProviderOperationIdempotencyError } from "@/lib/ai/provider-operation-idempotency";

const THREAD = "10000000-0000-4000-8000-000000000001";
const REQUEST = "20000000-0000-4000-8000-000000000001";
const request = (overrides: Record<string, unknown> = {}) => new NextRequest("https://learn.test/api/ai/tutor", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    requestId: REQUEST,
    courseId: "python",
    skillId: "python.values.scalars",
    message: "Explain scalar values.",
    threadId: THREAD,
    ...overrides,
  }),
});

describe("tutor append thread lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ session: { user: { id: "learner-1", name: "Asha" } }, response: null });
    mocks.gateClosedBookCapability.mockResolvedValue({ allowed: true });
    mocks.withRateLimit.mockImplementation(async (_input, callback) => callback());
    mocks.executeProviderOperationIdempotently.mockImplementation(async (input) => ({
      ...(await input.execute()),
      replayed: false,
    }));
    mocks.getCourse.mockResolvedValue({ id: "python" });
    mocks.getSkillLocation.mockResolvedValue({ course: { id: "python" } });
  });

  it("returns the authentication boundary response without checking exam state", async () => {
    mocks.requireAuth.mockResolvedValueOnce({
      session: null,
      response: new Response(JSON.stringify({ error: "Authentication required." }), { status: 401 }),
    });

    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(mocks.gateClosedBookCapability).not.toHaveBeenCalled();
  });

  it("returns the closed-book capability denial before parsing the body", async () => {
    mocks.gateClosedBookCapability.mockResolvedValueOnce({
      allowed: false,
      message: "Codestead is unavailable during a closed-book exam.",
      code: "EXAM_CAPABILITY_DENIED",
      status: 423,
    });

    const response = await POST(request());
    expect(response.status).toBe(423);
    expect(await response.json()).toEqual({
      error: "Codestead is unavailable during a closed-book exam.",
      code: "EXAM_CAPABILITY_DENIED",
    });
    expect(mocks.executeProviderOperationIdempotently).not.toHaveBeenCalled();
  });

  it("maps malformed JSON to the same no-store invalid-request response", async () => {
    const malformed = new NextRequest("https://learn.test/api/ai/tutor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });

    const response = await POST(malformed);
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects an archived owned thread before decrypting credentials or calling a provider", async () => {
    mocks.limit.mockResolvedValueOnce([{ id: THREAD, status: "archived" }]);
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "THREAD_ARCHIVED" });
    expect(mocks.routeTutorRequest).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("uses the same not-found response for a missing or another owner's supplied thread", async () => {
    mocks.limit.mockResolvedValueOnce([]);
    const response = await POST(request());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Tutor thread not found.", code: "THREAD_NOT_FOUND" });
    expect(mocks.routeTutorRequest).not.toHaveBeenCalled();
  });

  it("requires a client UUID before any receipt, curriculum, credential, or provider work", async () => {
    const response = await POST(request({ requestId: undefined }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    expect(mocks.executeProviderOperationIdempotently).not.toHaveBeenCalled();
    expect(mocks.getCourse).not.toHaveBeenCalled();
    expect(mocks.routeTutorRequest).not.toHaveBeenCalled();
  });

  it("returns 409 for UUID payload reuse and returns a completed lost-response replay without provider work", async () => {
    mocks.executeProviderOperationIdempotently.mockRejectedValueOnce(
      new ProviderOperationIdempotencyError("IDEMPOTENCY_KEY_REUSED", "Request ID payload mismatch."),
    );
    const mismatch = await POST(request());
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({
      error: "Request ID payload mismatch.",
      code: "IDEMPOTENCY_KEY_REUSED",
    });

    mocks.executeProviderOperationIdempotently.mockResolvedValueOnce({
      status: 200,
      body: { content: "Original safe answer", threadId: THREAD, callId: "call-original" },
      replayed: true,
    });
    const replay = await POST(request());
    expect(replay.status).toBe(200);
    expect(replay.headers.get("x-idempotent-replay")).toBe("true");
    expect(await replay.json()).toMatchObject({ content: "Original safe answer", callId: "call-original" });
    expect(mocks.routeTutorRequest).not.toHaveBeenCalled();
  });

  it("marks an idempotency wait timeout retryable and keeps receipt failures non-retryable", async () => {
    mocks.executeProviderOperationIdempotently.mockRejectedValueOnce(
      new ProviderOperationIdempotencyError("IDEMPOTENCY_WAIT_TIMEOUT", "The first request is still running."),
    );
    const timeout = await POST(request());
    expect(timeout.status).toBe(503);
    expect(await timeout.json()).toEqual({
      error: "The first request is still running.",
      code: "IDEMPOTENCY_WAIT_TIMEOUT",
      retryable: true,
    });

    mocks.executeProviderOperationIdempotently.mockRejectedValueOnce(
      new ProviderOperationIdempotencyError("IDEMPOTENCY_RECEIPT_UNAVAILABLE", "Receipt storage is unavailable."),
    );
    const unavailable = await POST(request());
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      error: "Receipt storage is unavailable.",
      code: "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
    });
  });

  it("returns the authored fallback for an unexpected idempotency-layer failure", async () => {
    mocks.executeProviderOperationIdempotently.mockRejectedValueOnce(new Error("database detail must not escape"));
    const response = await POST(request());
    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload).toMatchObject({ degraded: true });
    expect(JSON.stringify(payload)).not.toContain("database detail");
  });

  it("durably snapshots thrown and non-JSON rate-limit responses as safe fallback objects", async () => {
    mocks.withRateLimit.mockRejectedValueOnce(new Error("internal limiter detail"));
    const thrown = await POST(request());
    expect(thrown.status).toBe(503);
    expect(thrown.headers.get("x-idempotent-replay")).toBe("false");
    expect(await thrown.json()).toMatchObject({ degraded: true });

    mocks.withRateLimit.mockResolvedValueOnce(new Response("not-json", { status: 429 }));
    const nonJson = await POST(request());
    expect(nonJson.status).toBe(429);
    expect(await nonJson.json()).toMatchObject({ degraded: true });
  });

  it("keeps a second active-status owner predicate inside the persistence transaction", () => {
    const source = readFileSync(path.join(process.cwd(), "src/app/api/ai/tutor/route.ts"), "utf8");
    const transactionStart = source.indexOf("await db.transaction");
    const activeGate = source.indexOf('eq(chatThread.status, "active")', transactionStart);
    const messageInsert = source.indexOf("tx.insert(chatMessage)", transactionStart);
    expect(transactionStart).toBeGreaterThan(0);
    expect(activeGate).toBeGreaterThan(transactionStart);
    expect(messageInsert).toBeGreaterThan(activeGate);
    expect(source.slice(activeGate, messageInsert)).toContain("appendRejected");
  });

  it("loads structured owner memory for both new and explicitly selected resumed threads", () => {
    const source = readFileSync(path.join(process.cwd(), "src/app/api/ai/tutor/route.ts"), "utf8");
    expect(source).toContain("loadTutorStructuredMemory({");
    expect(source).toContain("userId: authz.session.user.id");
    expect(source).toContain("skillId: location.skill.id");
    expect(source).toContain("selectedThreadId: requestedThreadId");
    expect(source).toContain("structuredMemory.currentConcept");
    expect(source).toContain("structuredMemory.activeMisconceptionTags");
    expect(source).toContain("structuredMemory.recentRelevantSummary");
    expect(source).toContain("structuredMemory.selectedThreadTail");
  });

  it("redacts the learner message once before provider transmission, hashing, and chat persistence", () => {
    const source = readFileSync(path.join(process.cwd(), "src/app/api/ai/tutor/route.ts"), "utf8");
    expect(source).toContain("const learnerMessage = sanitizeTutorMemoryText(body.data.message, 8_000)");
    expect(source).toContain("buildTutorMessages(tutorContext, learnerMessage.text)");
    expect(source).toContain('update(learnerMessage.text).digest("hex")');
    expect(source).toContain("content: learnerMessage.text");
    expect(source).toContain("acceptedMessage: learnerMessage.text");
    expect(source.match(/body\.data\.message/g)).toHaveLength(1);
  });

  it("uses active/status/key-version/update-time CAS outcome recording instead of re-enabling credentials", () => {
    const routeSource = readFileSync(path.join(process.cwd(), "src/app/api/ai/tutor/route.ts"), "utf8");
    const outcomeSource = readFileSync(path.join(process.cwd(), "src/lib/ai/provider-credential-outcome.ts"), "utf8");
    expect(routeSource).toContain("recordProviderCredentialOutcome({");
    expect(routeSource).not.toContain('set({ lastUsedAt: new Date(), failureCode: null, status: "active" })');
    for (const anchor of [
      'eq(providerCredential.status, "active")',
      "eq(providerCredential.keyVersion, input.snapshot.keyVersion)",
      "eq(providerCredentialUpdatedAtToken, input.snapshot.updatedAtToken)",
      "eq(providerCredential.userId, input.snapshot.userId)",
    ]) expect(outcomeSource).toContain(anchor);
    expect(outcomeSource).not.toContain('status: "active"');
  });
});
