import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  listForUser: vi.fn(),
  findReplay: vi.fn(),
  create: vi.fn(),
  withRateLimit: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/learning-requests/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/learning-requests/repository")>();
  return {
    ...actual,
    learningRequestRepository: {
      listForUser: mocks.listForUser,
      findReplay: mocks.findReplay,
      create: mocks.create,
    },
  };
});
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));

import { LearningRequestRepositoryError } from "@/lib/learning-requests/repository";
import { GET, POST } from "../route";

const requestId = "10000000-0000-4000-8000-000000000001";
const record = {
  id: "20000000-0000-4000-8000-000000000001",
  kind: "new-subject" as const,
  subject: "Distributed systems",
  details: "Consensus, failure models, and evidence-driven projects.",
  status: "pending" as const,
  decisionReason: null,
  createdAt: new Date("2026-07-13T10:00:00.000Z"),
  decidedAt: null,
};

function post(body: unknown) {
  return new NextRequest("https://learn.example.test/api/learning-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = {
  requestId,
  kind: "new-subject",
  subject: "  Distributed systems  ",
  details: "  Consensus, failure models, and evidence-driven projects.  ",
};

describe("learner learning-request route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({
      session: { user: { id: "learner-user" }, session: { id: "session" } },
      response: null,
    });
    mocks.listForUser.mockResolvedValue([record]);
    mocks.findReplay.mockResolvedValue(null);
    mocks.create.mockResolvedValue({ request: record, replayed: false });
    mocks.withRateLimit.mockImplementation(async (_check, handler: () => Promise<Response>) => handler());
  });

  it("requires authentication before reading or consuming a create budget", async () => {
    mocks.requireAuth.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });
    expect((await GET()).status).toBe(401);
    expect(mocks.listForUser).not.toHaveBeenCalled();

    mocks.requireAuth.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });
    expect((await POST(post(validBody))).status).toBe(401);
    expect(mocks.withRateLimit).not.toHaveBeenCalled();
  });

  it("lists only the authenticated learner's requests without caching", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.listForUser).toHaveBeenCalledWith("learner-user");
    expect(await response.json()).toMatchObject({
      requests: [{ id: record.id, createdAt: record.createdAt.toISOString() }],
    });
  });

  it.each([
    [{ ...validBody, requestId: "retry-me" }],
    [{ ...validBody, userId: "forged-user" }],
    [{ requestId, kind: "new-subject", subject: "x", details: "short" }],
  ])("rejects malformed or extra input before replay and rate-limit access", async (body) => {
    const response = await POST(post(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "LEARNING_REQUEST_INVALID_INPUT" });
    expect(mocks.findReplay).not.toHaveBeenCalled();
    expect(mocks.withRateLimit).not.toHaveBeenCalled();
  });

  it.each([
    ["21st", ["21", "st_sk_", "A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r6"].join("")],
    ["AWS", ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("")],
    ["Slack", ["xox", "b-", "1234567890-abcdefghijklmnopqrstuvwxyz"].join("")],
    ["labelled custom", "access token=abcdefghijklmnop"],
  ])("rejects %s credential material before replay lookup or persistence", async (_label, candidate) => {
    const response = await POST(post({
      ...validBody,
      details: `Please add a safe lesson. Accidental value: ${candidate}`,
    }));
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload).toMatchObject({ code: "LEARNING_REQUEST_SENSITIVE_INPUT" });
    expect(JSON.stringify(payload)).not.toContain(candidate);
    expect(mocks.findReplay).not.toHaveBeenCalled();
    expect(mocks.withRateLimit).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("returns a committed response-loss replay before consuming an exhausted budget", async () => {
    mocks.findReplay.mockResolvedValueOnce(record);

    const response = await POST(post(validBody));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ request: { id: record.id }, replayed: true });
    expect(mocks.findReplay).toHaveBeenCalledWith({
      userId: "learner-user",
      requestId,
      kind: "new-subject",
      subject: "Distributed systems",
      details: "Consensus, failure models, and evidence-driven projects.",
    });
    expect(mocks.withRateLimit).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates a new request under the learner budget and reports a race replay", async () => {
    const created = await POST(post(validBody));
    expect(created.status).toBe(201);
    expect(mocks.withRateLimit).toHaveBeenCalledWith(
      { policy: "learning_request_user", identity: { kind: "user", value: "learner-user" } },
      expect.any(Function),
    );
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      userId: "learner-user",
      requestId,
      subject: "Distributed systems",
    }));

    mocks.create.mockResolvedValueOnce({ request: record, replayed: true });
    const raced = await POST(post(validBody));
    expect(raced.status).toBe(200);
    expect(await raced.json()).toMatchObject({ replayed: true });
  });

  it("returns a 429 response without touching storage after a replay miss", async () => {
    mocks.withRateLimit.mockResolvedValueOnce(
      NextResponse.json({ error: "Too many requests.", code: "RATE_LIMITED" }, { status: 429 }),
    );
    const response = await POST(post(validBody));
    expect(response.status).toBe(429);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects changed payload reuse and fails closed on unavailable storage", async () => {
    mocks.findReplay.mockRejectedValueOnce(new LearningRequestRepositoryError(
      "IDEMPOTENCY_MISMATCH",
      "different input",
    ));
    const mismatch = await POST(post(validBody));
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({ code: "LEARNING_REQUEST_IDEMPOTENCY_MISMATCH" });
    expect(mocks.withRateLimit).not.toHaveBeenCalled();

    mocks.findReplay.mockRejectedValueOnce(new Error("database password leaked"));
    const unavailable = await POST(post(validBody));
    expect(unavailable.status).toBe(503);
    expect(JSON.stringify(await unavailable.json())).not.toContain("password");
  });
});
