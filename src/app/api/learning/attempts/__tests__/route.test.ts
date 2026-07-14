import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), createAttempt: vi.fn() }));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/learning-service/runtime", () => ({
  learningService: { createAttempt: mocks.createAttempt },
}));

import { POST } from "../route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({
    session: { user: { id: "learner-1" }, session: { id: "session-1" } },
    response: null,
  });
});

function request(body: unknown) {
  return new Request("https://learn.test/api/learning/attempts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function internalResult() {
  return {
    state: "ready" as const,
    attempt: {
      id: "50000000-0000-4000-8000-000000000001",
      userId: "learner-1",
      activityId: "20000000-0000-4000-8000-000000000001",
      enrollmentId: "40000000-0000-4000-8000-000000000001",
      kind: "practice" as const,
      attemptNumber: 1,
      status: "in_progress",
      policyVersion: "adaptive-learning-v1",
      contentVersion: "1.0.0",
      score: null,
      passed: null,
      masteryAwarded: false,
      infrastructureFailure: false,
      startedAt: new Date(),
      submittedAt: null,
      gradedAt: null,
    },
    activity: {
      activityId: "20000000-0000-4000-8000-000000000001",
      activitySlug: "practice-a",
      activityType: "practice-mcq",
      specification: {
        kind: "mcq",
        prompt: "Choose safely.",
        options: [{ id: "a", text: "A" }, { id: "b", text: "B" }],
        grading: { kind: "choice", acceptedAnswers: ["a"] },
        hiddenTests: [{ expected: "secret" }],
        solutionReveal: { answer: "A", explanation: "Private until reveal." },
      },
      skillId: "python.variables.assignment",
      conceptId: "30000000-0000-4000-8000-000000000001",
      enrollmentId: "40000000-0000-4000-8000-000000000001",
      courseVersion: "1.0.0",
      trackId: "python",
      implementationLanguage: null,
      languageContext: "conceptual",
    },
    idempotent: false,
  };
}

describe("practice attempt creation route", () => {
  it("requires authentication and keeps private response headers", async () => {
    mocks.requireAuth.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    const response = await POST(request({}));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("returns only the learner allowlist and binds the owner server-side", async () => {
    mocks.createAttempt.mockResolvedValue(internalResult());
    const response = await POST(request({
      idempotencyKey: "practice-request-0001",
      skillId: "python.variables.assignment",
      kind: "practice",
    }));
    expect(response.status).toBe(201);
    expect(mocks.createAttempt).toHaveBeenCalledWith({
      userId: "learner-1",
      idempotencyKey: "practice-request-0001",
      skillId: "python.variables.assignment",
      kind: "practice",
    });
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain("Choose safely.");
    expect(serialized).not.toMatch(/acceptedAnswers|grading|hiddenTests|expected|Private until reveal|enrollmentId|conceptId|userId/);
  });

  it("accepts the official checkpoint kind while deriving the learner owner from authentication", async () => {
    const base = internalResult();
    const result = { ...base, attempt: { ...base.attempt, kind: "quiz" as const } };
    mocks.createAttempt.mockResolvedValue(result);
    const response = await POST(request({
      idempotencyKey: "checkpoint-request-0001",
      skillId: "python.variables.assignment",
      kind: "quiz",
    }));
    expect(response.status).toBe(201);
    expect(mocks.createAttempt).toHaveBeenCalledWith({
      userId: "learner-1",
      idempotencyKey: "checkpoint-request-0001",
      skillId: "python.variables.assignment",
      kind: "quiz",
    });
    const body = await response.json();
    expect(body).toMatchObject({
      state: "ready",
      attempt: { kind: "quiz" },
      activity: { specification: { kind: "mcq" } },
    });
    expect(JSON.stringify(body)).not.toMatch(/acceptedAnswers|grading|hiddenTests|enrollmentId|userId/);
  });

  it("reports an unsupported published prompt without exposing its internal specification", async () => {
    const result = internalResult();
    result.activity.specification = {
      grading: { kind: "exact", acceptedAnswers: ["secret"] },
    } as typeof result.activity.specification;
    mocks.createAttempt.mockResolvedValue(result);
    const response = await POST(request({
      idempotencyKey: "practice-request-0002",
      skillId: "python.variables.assignment",
      kind: "practice",
    }));
    expect(await response.json()).toEqual({
      state: "degraded",
      attempt: null,
      activity: null,
      idempotent: false,
      reason: "activity_unsupported",
    });
  });
});
