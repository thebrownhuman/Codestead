import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  startExam: vi.fn(),
  withRateLimit: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));
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
  return { ExamServiceError, startExam: mocks.startExam };
});

import { ExamServiceError } from "@/app/api/exams/_lib/service";

import { POST } from "../route";

const validBody = {
  moduleId: "pf.computing",
  integrityDisclosureAccepted: true,
  readinessAcknowledged: true,
  device: {
    viewportWidth: 1280,
    viewportHeight: 800,
    userAgent: "Untrusted body user agent",
  },
};

function request(body: unknown) {
  return new NextRequest("https://learn.example.test/api/exams/start", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Trusted request user agent",
    },
    body: JSON.stringify(body),
  });
}

describe("formal exam start endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({
      session: { user: { id: "learner-user" }, session: { id: "auth-session" } },
    });
    mocks.withRateLimit.mockImplementation(async (_input, work: () => Promise<Response>) => work());
    mocks.startExam.mockResolvedValue({ sessionId: "10000000-0000-4000-8000-000000000001" });
  });

  it("does not parse or admit an unauthenticated exam request", async () => {
    mocks.requireAuth.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });
    const response = await POST(request(validBody));
    expect(response.status).toBe(401);
    expect(mocks.withRateLimit).not.toHaveBeenCalled();
    expect(mocks.startExam).not.toHaveBeenCalled();
  });

  it("preserves the persisted readiness denial and missing-skill detail", async () => {
    mocks.startExam.mockRejectedValue(new ExamServiceError(
      "Complete the required independent and delayed evidence before starting this formal exam.",
      409,
      "EXAM_NOT_READY",
      { missingSkillIds: ["pf.computing.program"] },
    ));
    const response = await POST(request(validBody));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Complete the required independent and delayed evidence before starting this formal exam.",
      code: "EXAM_NOT_READY",
      missingSkillIds: ["pf.computing.program"],
    });
  });

  it("binds the authenticated learner and request user agent to admission", async () => {
    const response = await POST(request(validBody));
    expect(response.status).toBe(201);
    expect(mocks.withRateLimit).toHaveBeenCalledWith(
      { policy: "exam_start_user", identity: { kind: "user", value: "learner-user" } },
      expect.any(Function),
    );
    expect(mocks.startExam).toHaveBeenCalledWith("learner-user", {
      ...validBody,
      device: { ...validBody.device, userAgent: "Trusted request user agent" },
    });
  });
});
