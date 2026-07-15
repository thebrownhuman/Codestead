import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  autosaveExamAnswer: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/app/api/exams/_lib/service", () => {
  class ExamServiceError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code: string,
      readonly details: Readonly<Record<string, unknown>> = {},
    ) {
      super(message);
      this.name = "ExamServiceError";
    }
  }
  return { ExamServiceError, autosaveExamAnswer: mocks.autosaveExamAnswer };
});

import { ExamServiceError } from "@/app/api/exams/_lib/service";

import { PUT } from "../route";

const SESSION_ID = "30000000-0000-4000-8000-000000000001";
const MUTATION_ID = "31000000-0000-4000-8000-000000000001";
const SAVED_AT = "2026-07-15T10:00:00.000Z";

const validBody = {
  clientMutationId: MUTATION_ID,
  itemId: "item-1",
  baseRevision: 0,
  answer: { text: "accepted value" },
};

function request(body: unknown) {
  return new NextRequest(`https://learn.example.test/api/exams/${SESSION_ID}/autosave`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function invoke(body: unknown) {
  return PUT(request(body), { params: Promise.resolve({ sessionId: SESSION_ID }) });
}

describe("exam autosave endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({
      session: { user: { id: "authenticated-learner" }, session: { id: "auth-session" } },
    });
    mocks.autosaveExamAnswer.mockResolvedValue({
      revision: 1,
      answer: validBody.answer,
      savedAt: SAVED_AT,
      clientMutationId: MUTATION_ID,
      replayed: false,
    });
  });

  it("returns the authentication response before parsing or calling the service", async () => {
    mocks.requireAuth.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });
    const malformed = new NextRequest(`https://learn.example.test/api/exams/${SESSION_ID}/autosave`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });

    const response = await PUT(malformed, { params: Promise.resolve({ sessionId: SESSION_ID }) });

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.autosaveExamAnswer).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", { ...validBody, clientMutationId: undefined }],
    ["malformed", { ...validBody, clientMutationId: "not-a-uuid" }],
    ["non-string", { ...validBody, clientMutationId: 42 }],
  ])("rejects a %s mutation identifier before the service boundary", async (_label, body) => {
    const response = await invoke(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Autosave payload is invalid.",
      code: "INVALID_AUTOSAVE",
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.autosaveExamAnswer).not.toHaveBeenCalled();
  });

  it.each([
    ["outer", { ...validBody, userId: "body-selected-owner" }],
    ["answer", { ...validBody, answer: { ...validBody.answer, hidden: "unbound" } }],
  ])("rejects an unknown %s property instead of silently stripping it", async (_label, body) => {
    const response = await invoke(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_AUTOSAVE" });
    expect(mocks.autosaveExamAnswer).not.toHaveBeenCalled();
  });

  it("binds the authenticated owner and path session to the exact parsed mutation", async () => {
    const response = await invoke(validBody);

    expect(response.status).toBe(200);
    expect(mocks.autosaveExamAnswer).toHaveBeenCalledWith({
      userId: "authenticated-learner",
      sessionId: SESSION_ID,
      ...validBody,
    });
  });

  it.each([
    [false, { ...validBody.answer }],
    [true, { text: "accepted value" }],
  ])("returns the original receipt result with replayed=%s and no-store", async (replayed, answer) => {
    mocks.autosaveExamAnswer.mockResolvedValue({
      revision: 1,
      answer,
      savedAt: SAVED_AT,
      clientMutationId: MUTATION_ID,
      replayed,
    });

    const response = await invoke(validBody);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      saved: {
        revision: 1,
        answer,
        savedAt: SAVED_AT,
        clientMutationId: MUTATION_ID,
        replayed,
      },
    });
  });

  it("preserves idempotency mismatch without leaking receipt internals", async () => {
    mocks.autosaveExamAnswer.mockRejectedValue(new ExamServiceError(
      "This autosave mutation identifier was already used for different input.",
      409,
      "AUTOSAVE_IDEMPOTENCY_MISMATCH",
    ));

    const response = await invoke(validBody);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body).toEqual({
      error: "This autosave mutation identifier was already used for different input.",
      code: "AUTOSAVE_IDEMPOTENCY_MISMATCH",
    });
    expect(JSON.stringify(body)).not.toMatch(/hash|stored|owner|database/i);
  });

  it.each([
    ["AUTOSAVE_REVISION_CONFLICT", 409, { currentRevision: 2, currentAnswer: { text: "new" }, currentSavedAt: SAVED_AT }],
    ["EXAM_NOT_FOUND", 404, {}],
    ["EXAM_NOT_ACTIVE", 409, {}],
    ["EXAM_EXPIRED", 409, {}],
  ])("preserves the %s service contract", async (code, status, details) => {
    mocks.autosaveExamAnswer.mockRejectedValue(new ExamServiceError("Stable error.", status, code, details));

    const response = await invoke(validBody);

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ error: "Stable error.", code, ...details });
  });

  it("redacts unexpected errors and secret-bearing database detail", async () => {
    mocks.autosaveExamAnswer.mockRejectedValue(new Error("postgres password=integration-secret"));

    const response = await invoke(validBody);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body).toEqual({
      error: "The exam service could not complete this request.",
      code: "EXAM_SERVICE_FAILURE",
    });
    expect(JSON.stringify(body)).not.toContain("integration-secret");
  });
});
