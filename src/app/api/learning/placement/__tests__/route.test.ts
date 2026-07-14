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

function request() {
  return new Request("https://learn.test/api/learning/placement", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: "placement-request-0001",
      skillId: "python.variables.assignment",
    }),
  });
}

describe("diagnostic placement attempt privacy", () => {
  it("projects the same strict learner activity allowlist before adding placement metadata", async () => {
    mocks.createAttempt.mockResolvedValue({
      state: "ready",
      attempt: {
        id: "50000000-0000-4000-8000-000000000001",
        userId: "learner-1",
        activityId: "20000000-0000-4000-8000-000000000001",
        enrollmentId: "40000000-0000-4000-8000-000000000001",
        kind: "diagnostic",
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
        activitySlug: "diagnostic-a",
        activityType: "diagnostic-mcq",
        specification: {
          kind: "mcq",
          prompt: "Choose the valid assignment.",
          options: [{ id: "a", text: "x = 4" }, { id: "b", text: "4 = x" }],
          grading: { kind: "choice", acceptedAnswers: ["a"] },
          hiddenTests: [{ expected: "secret" }],
          referenceSolution: "x = 4",
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
    });
    const response = await POST(request());
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.placement).toEqual({ selfReportUsedAsEvidence: false, officialEvidencePending: true });
    expect(body.activity.specification.prompt).toBe("Choose the valid assignment.");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/acceptedAnswers|grading|hiddenTests|expected|referenceSolution|enrollmentId|conceptId|userId/);
  });
});
