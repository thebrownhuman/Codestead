import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExamSessionView } from "@/lib/exams/contracts";

import { TimedExamClient } from "../timed-exam-client";

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function exam(status: "needs_learner_input" | "under_review"): ExamSessionView {
  const now = "2026-07-12T00:00:00.000Z";
  return {
    sessionId: "10000000-0000-4000-8000-000000000001",
    attemptId: "20000000-0000-4000-8000-000000000001",
    attemptNumber: 1,
    status: "under_review",
    serverNow: now,
    serverStartedAt: now,
    serverDeadlineAt: now,
    disconnectedSeconds: 0,
    integrityReviewState: status === "needs_learner_input" ? "appeal_needs_learner_input" : "appeal_pending_after_learner_response",
    form: {
      schemaVersion: 1,
      formId: "form-1",
      courseId: "python",
      courseTitle: "Python",
      moduleId: "variables",
      moduleTitle: "Variables",
      contentVersion: "v1",
      policyVersion: "p1",
      durationMinutes: 10,
      generatedAt: now,
      instructions: [],
      integrityDisclosure: { version: "1", summary: "Test", capturedEvents: [], notCaptured: [] },
      items: [{
        id: "item-1",
        skillId: "skill-1",
        clusterId: "cluster-1",
        title: "Question",
        prompt: "Prompt",
        kind: "short-answer",
        points: 10,
        critical: true,
        verificationAvailable: true,
      }],
    },
    answers: {},
    result: {
      schemaVersion: 1,
      gradingStatus: "graded",
      outcome: "NOT_PASSED",
      officialScorePercent: 50,
      earnedPoints: 5,
      possiblePoints: 10,
      pendingReviewItemIds: [],
      failedCriticalClusters: ["cluster-1"],
      masteryBlockingCodingItems: [],
      compilationGatePassed: true,
      infrastructureFailure: false,
      finalizedAt: now,
      finalizedBy: "learner-submit",
      policyVersion: "p1",
      remediation: { required: true, targets: ["cluster-1"] },
    },
    retake: null,
    appealSubmitted: true,
    appeal: {
      id: "30000000-0000-4000-8000-000000000001",
      status,
      decision: "needs_learner_input",
      decisionReason: "Please explain which saved answer should be reviewed.",
      updatedAt: now,
    },
  };
}

describe("learner appeal clarification UI", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the administrator request and submits a bounded idempotent response", async () => {
    let replied = false;
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body && typeof init.body === "string"
        ? JSON.parse(init.body) as Record<string, unknown>
        : undefined;
      calls.push({ url, body });
      if (url.endsWith("/appeal/reply")) {
        replied = true;
        return json({ accepted: true, duplicate: false, appealId: exam("needs_learner_input").appeal?.id, rowVersion: 3 }, { status: 202 });
      }
      if (url.endsWith("/events")) return json({ accepted: true });
      if (url === "/api/exams/10000000-0000-4000-8000-000000000001") {
        return json({ exam: exam(replied ? "under_review" : "needs_learner_input") });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<TimedExamClient sessionId="10000000-0000-4000-8000-000000000001" />);

    expect(await screen.findByText("The reviewer needs more information")).toBeInTheDocument();
    expect(screen.getByText("Please explain which saved answer should be reviewed.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Your response to the reviewer"), "Please review item one, revision two, saved before submission.");
    await user.click(screen.getByRole("button", { name: "Send response" }));

    expect(await screen.findByText("Your reply was sent; human review has resumed")).toBeInTheDocument();
    const replyCall = calls.find((call) => call.url.endsWith("/appeal/reply"));
    expect(replyCall?.body).toMatchObject({
      message: "Please review item one, revision two, saved before submission.",
    });
    expect(replyCall?.body?.clientRequestId).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
