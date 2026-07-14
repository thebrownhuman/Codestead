import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminProjectReviewCorrections } from "../admin-project-review-corrections";

const correctionId = "10000000-0000-4000-8000-000000000001";

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

describe("administrator project-review corrections", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows immutable provenance, verified evidence, projection outcome, and append-only timeline", async () => {
    const summary = {
      id: correctionId,
      projectId: "20000000-0000-4000-8000-000000000001",
      projectTitle: "Portfolio API",
      userId: "learner-user",
      learnerName: "Asha Learner",
      sourceReviewId: "20000000-0000-4000-8000-000000000002",
      sourceAppealId: "20000000-0000-4000-8000-000000000003",
      revision: 1,
      sourceCommitSha: "a".repeat(40),
      status: "succeeded",
      attemptCount: 1,
      lastErrorCode: null,
      deadLettered: false,
      deadLetteredAt: null,
      projectionApplied: true,
      createdAt: "2026-07-12T00:00:00.000Z",
      completedAt: "2026-07-12T00:01:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/project-review-corrections?")) {
        return json({ corrections: [summary] });
      }
      if (url === `/api/admin/project-review-corrections/${correctionId}`) {
        return json({
          detail: {
            correction: {
              ...summary,
              requestedBy: "admin-user",
              reason: "The original deterministic rule was defective and required correction.",
              sourceAnalyzerVersion: "static-review-v1",
              sourceRubricVersion: "static-project-review-rubric-v1",
              sourceProvenance: { analysisMode: "deterministic_static", aiUsed: false, repositoryExecution: "none" },
              sourceFindingsHash: "a".repeat(64),
              targetAnalyzerVersion: "static-review-v1",
              targetRubricVersion: "static-project-review-rubric-v1",
              resultFindings: [],
              resultFindingsHash: "b".repeat(64),
              resultProvenance: { analysisMode: "deterministic_static", aiUsed: false, repositoryExecution: "none" },
              evidence: { execution: { aiRole: "none", repositoryExecution: "none" } },
              evidenceHash: "c".repeat(64),
              evidenceHashValid: true,
              startedAt: "2026-07-12T00:00:30.000Z",
            },
            timeline: [{
              id: "30000000-0000-4000-8000-000000000001",
              actorRole: "system",
              event: "projection_applied",
              reason: "The corrected static analysis became effective.",
              evidenceHash: "d".repeat(64),
              evidenceHashValid: true,
              occurredAt: "2026-07-12T00:01:00.000Z",
            }],
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<AdminProjectReviewCorrections />);
    expect(await screen.findByText("Portfolio API")).toBeInTheDocument();
    expect(screen.getByText(/no AI or repository execution is permitted/i)).toBeInTheDocument();
    expect(await screen.findByText(/Evidence hash verified/i)).toBeInTheDocument();
    expect(screen.getByText(/Projection applied/i)).toBeInTheDocument();
    expect(screen.getByText(/Every event carries a verified evidence hash/i)).toBeInTheDocument();
  });

  it("shows exhausted work as dead-lettered and does not offer a silent retry", async () => {
    const summary = {
      id: correctionId,
      projectId: "20000000-0000-4000-8000-000000000001",
      projectTitle: "Portfolio API",
      userId: "learner-user",
      learnerName: "Asha Learner",
      sourceReviewId: "20000000-0000-4000-8000-000000000002",
      sourceAppealId: null,
      revision: 2,
      sourceCommitSha: "a".repeat(40),
      status: "failed",
      attemptCount: 3,
      lastErrorCode: "WORKER_LEASE_EXPIRED",
      deadLettered: true,
      deadLetteredAt: "2026-07-12T00:03:00.000Z",
      projectionApplied: null,
      createdAt: "2026-07-12T00:00:00.000Z",
      completedAt: null,
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/project-review-corrections?")) {
        return json({ corrections: [summary] });
      }
      if (url === `/api/admin/project-review-corrections/${correctionId}`) {
        return json({
          detail: {
            correction: {
              ...summary,
              requestedBy: "admin-user",
              reason: "The original deterministic rule was defective and required correction.",
              sourceAnalyzerVersion: "static-review-v1",
              sourceRubricVersion: "static-project-review-rubric-v1",
              sourceProvenance: { analysisMode: "deterministic_static", aiUsed: false, repositoryExecution: "none" },
              sourceFindingsHash: "a".repeat(64),
              targetAnalyzerVersion: "static-review-v1",
              targetRubricVersion: "static-project-review-rubric-v1",
              resultFindings: null,
              resultFindingsHash: null,
              resultProvenance: null,
              evidence: null,
              evidenceHash: null,
              evidenceHashValid: false,
              startedAt: "2026-07-12T00:02:00.000Z",
            },
            timeline: [{
              id: "30000000-0000-4000-8000-000000000001",
              actorRole: "system",
              event: "analysis_failed",
              reason: "The worker lease expired after its final bounded attempt.",
              evidenceHash: "d".repeat(64),
              evidenceHashValid: true,
              occurredAt: "2026-07-12T00:03:00.000Z",
            }],
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<AdminProjectReviewCorrections />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Dead-lettered after 3 attempts/i);
    expect(screen.queryByRole("button", { name: /Queue retry/i })).not.toBeInTheDocument();
    expect(screen.getByText(/create a newly reviewed correction version/i)).toBeInTheDocument();
  });
});
