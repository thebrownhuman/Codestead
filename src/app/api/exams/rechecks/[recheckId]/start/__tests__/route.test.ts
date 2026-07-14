import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  startMasteryRecheck: vi.fn(),
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
    ) { super(message); }
  }
  return { ExamServiceError, startMasteryRecheck: mocks.startMasteryRecheck };
});

import { ExamServiceError } from "@/app/api/exams/_lib/service";
import { POST } from "../route";

const recheckId = "51000000-0000-4000-8000-000000000001";
const validBody = {
  moduleId: "pf.computing",
  integrityDisclosureAccepted: true,
  readinessAcknowledged: true,
  device: { viewportWidth: 1280, viewportHeight: 800, userAgent: "untrusted" },
};

function request(body: unknown) {
  return new NextRequest(`https://learn.example.test/api/exams/rechecks/${recheckId}/start`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "trusted-agent" },
    body: JSON.stringify(body),
  });
}

const context = (id = recheckId) => ({ params: Promise.resolve({ recheckId: id }) });

describe("targeted mastery recheck start endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ session: { user: { id: "learner-1" } } });
    mocks.withRateLimit.mockImplementation(async (_input, work: () => Promise<Response>) => work());
    mocks.startMasteryRecheck.mockResolvedValue({ sessionId: "52000000-0000-4000-8000-000000000001" });
  });

  it("rejects before parsing or resolving a recheck when unauthenticated", async () => {
    mocks.requireAuth.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });
    expect((await POST(request(validBody), context())).status).toBe(401);
    expect(mocks.startMasteryRecheck).not.toHaveBeenCalled();
  });

  it("binds the path identifier and form admission to the authenticated learner", async () => {
    const response = await POST(request(validBody), context());
    expect(response.status).toBe(201);
    expect(mocks.startMasteryRecheck).toHaveBeenCalledWith("learner-1", recheckId, {
      ...validBody,
      device: { ...validBody.device, userAgent: "trusted-agent" },
    });
  });

  it("preserves the ownership-safe not-found response returned for another learner's id", async () => {
    mocks.startMasteryRecheck.mockRejectedValue(new ExamServiceError(
      "Mastery recheck was not found.", 404, "MASTERY_RECHECK_NOT_FOUND",
    ));
    const response = await POST(request(validBody), context());
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "MASTERY_RECHECK_NOT_FOUND" });
  });

  it("rejects a malformed path id without entering the ownership service", async () => {
    const response = await POST(request(validBody), context("not-a-uuid"));
    expect(response.status).toBe(404);
    expect(mocks.startMasteryRecheck).not.toHaveBeenCalled();
  });
});
