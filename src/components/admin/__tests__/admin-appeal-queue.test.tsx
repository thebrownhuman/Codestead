import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminAppealQueue } from "../admin-appeal-queue";

const appealId = "10000000-0000-4000-8000-000000000001";

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

const summary = {
  id: appealId,
  learnerName: "Asha Learner",
  learnerPublicId: "20000000-0000-4000-8000-000000000001",
  category: "scoring",
  reason: "The displayed score does not match my submitted answer.",
  status: "open",
  decision: null,
  target: "exam_attempt",
  rowVersion: 1,
  createdAt: "2026-07-12T00:00:00.000Z",
};

function detail(status = "open") {
  return {
    appeal: {
      ...summary,
      status,
      userId: "learner-user",
      learnerEmail: "asha@example.test",
      decision: status === "overturned" ? "overturned" : null,
      decisionReason: status === "overturned" ? "The evidence confirms a grading defect." : null,
      evidenceHash: "a".repeat(64),
      evidenceHashValid: true,
      evidence: { schemaVersion: 1 },
      updatedAt: "2026-07-12T00:00:00.000Z",
      decidedAt: status === "overturned" ? "2026-07-12T00:01:00.000Z" : null,
    },
    target: {
      attemptId: "30000000-0000-4000-8000-000000000001",
      attemptKind: "exam",
      attemptStatus: "graded",
      score: 70,
      passed: false,
      policyVersion: "policy-v1",
      contentVersion: "content-v1",
      examSessionId: "40000000-0000-4000-8000-000000000001",
      examStatus: status === "overturned" ? "under_review" : "appeal_pending",
      integrityReviewState: status === "overturned" ? "appeal_overturned_correction_pending" : "appeal_pending",
    },
    publicForm: null,
    originalResult: null,
    answers: [],
    codeSubmissions: [],
    integrityEvents: [],
    timeline: [{
      id: "50000000-0000-4000-8000-000000000001",
      actorRole: "learner",
      event: "submitted",
      reason: summary.reason,
      evidence: {},
      occurredAt: "2026-07-12T00:00:00.000Z",
    }],
  };
}

describe("administrator appeal queue", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads an audited evidence view and exposes the version-bound decision controls", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/appeals?")) return json({ appeals: [summary] });
      if (url === `/api/admin/appeals/${appealId}`) return json({ detail: detail() });
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<AdminAppealQueue initialAppealId={null} />);

    expect((await screen.findAllByText("Asha Learner")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(summary.reason)).length).toBeGreaterThan(0);
    expect(await screen.findByText(/Evidence hash verified/i)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "upheld" })).toBeChecked();
    expect(screen.getByLabelText(/Current six-digit authenticator code/i)).toHaveAttribute("type", "password");
    expect(screen.getByText(/hidden grading evidence is withheld/i)).toBeInTheDocument();
  });

  it("performs fresh MFA before an overturn and sends the required corrective action with a stable request id", async () => {
    let decided = false;
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url.startsWith("/api/admin/appeals?")) return json({ appeals: [summary] });
      if (url === `/api/admin/appeals/${appealId}` && init?.method === "POST") {
        decided = true;
        return json({
          report: { decision: "overturned", replayed: false, correctionPending: true },
          completionAuditRecorded: true,
        });
      }
      if (url === `/api/admin/appeals/${appealId}`) return json({ detail: detail(decided ? "overturned" : "open") });
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      if (url === `/api/admin/appeals/${appealId}/decision`) {
        decided = true;
        return json({
          report: { decision: "overturned", replayed: false, correctionPending: true },
          completionAuditRecorded: true,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminAppealQueue initialAppealId={appealId} />);

    await screen.findByText(/Evidence hash verified/i);
    await user.click(screen.getByRole("radio", { name: "overturned" }));
    await user.type(screen.getByLabelText("Recorded decision reason"), "The immutable evidence confirms an incorrect grade.");
    await user.type(screen.getByLabelText(/Required corrective action/i), "Regrade the pinned form and append a superseding result.");
    await user.type(screen.getByLabelText(/Current six-digit authenticator code/i), "123456");
    await user.click(screen.getByRole("button", { name: /Record decision and notify learner/i }));

    expect(await screen.findByText(/Corrective review remains pending/i)).toBeInTheDocument();
    const mfaIndex = calls.findIndex((call) => call.url === "/api/security/fresh-mfa");
    const decisionIndex = calls.findIndex((call) => call.url.endsWith("/decision"));
    expect(mfaIndex).toBeGreaterThan(-1);
    expect(decisionIndex).toBeGreaterThan(mfaIndex);
    expect(calls[mfaIndex]?.body).toEqual({ code: "123456" });
    expect(calls[decisionIndex]?.body).toMatchObject({
      expectedVersion: 1,
      decision: "overturned",
      correctiveAction: "Regrade the pinned form and append a superseding result.",
    });
    expect(calls[decisionIndex]?.body?.requestId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("blocks locally when MFA or rationale is incomplete", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/appeals?")) return json({ appeals: [summary] });
      if (url === `/api/admin/appeals/${appealId}`) return json({ detail: detail() });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminAppealQueue initialAppealId={appealId} />);
    await screen.findByText(/Evidence hash verified/i);
    const baseline = fetchMock.mock.calls.length;
    await user.type(screen.getByLabelText(/Current six-digit authenticator code/i), "123");
    await user.click(screen.getByRole("button", { name: /Record decision and notify learner/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("six-digit"));
    expect(fetchMock).toHaveBeenCalledTimes(baseline);
  });

  it("blocks locally when the reason is too short, and again when overturning without corrective action", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/appeals?")) return json({ appeals: [summary] });
      if (url === `/api/admin/appeals/${appealId}`) return json({ detail: detail() });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<AdminAppealQueue initialAppealId={appealId} />);
    await screen.findByText(/Evidence hash verified/i);

    await user.type(screen.getByLabelText(/Current six-digit authenticator code/i), "123456");
    await user.type(screen.getByLabelText("Recorded decision reason"), "too short");
    await user.click(screen.getByRole("button", { name: /Record decision and notify learner/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("at least 20 characters");

    await user.click(screen.getByRole("radio", { name: "overturned" }));
    await user.clear(screen.getByLabelText("Recorded decision reason"));
    await user.type(screen.getByLabelText("Recorded decision reason"), "The immutable evidence confirms an incorrect grade.");
    await user.click(screen.getByRole("button", { name: /Record decision and notify learner/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("corrective action before overturning");
  });

  it("disables the decision control and explains why when the evidence hash is invalid", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/appeals?")) return json({ appeals: [summary] });
      if (url === `/api/admin/appeals/${appealId}`) {
        return json({ detail: { ...detail(), appeal: { ...detail().appeal, evidenceHashValid: false } } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<AdminAppealQueue initialAppealId={appealId} />);

    expect(await screen.findByText(/Evidence hash does not match/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Record decision and notify learner/i })).toBeDisabled();
    expect(screen.getByText(/failed verification/i)).toBeInTheDocument();
  });

  it("shows project-review specific evidence, a correction panel, and code submissions", async () => {
    const projectDetail = {
      ...detail(),
      target: {
        ...detail().target,
        attemptId: null,
        projectReviewId: "60000000-0000-4000-8000-000000000001",
        projectId: "70000000-0000-4000-8000-000000000001",
        projectTitle: "Weather dashboard",
        reviewCommitSha: "a".repeat(40),
        reviewAnalyzerVersion: "analyzer-v1",
        reviewRubricVersion: "rubric-v1",
        reviewProvenance: {},
        reviewFindingsHash: "b".repeat(64),
        reviewStatus: "completed",
      },
      projectCorrection: {
        id: "80000000-0000-4000-8000-000000000001",
        status: "completed",
        revision: 1,
        reason: "Deterministic re-analysis",
        sourceFindingsHash: "c".repeat(64),
        resultFindingsHash: "d".repeat(64),
        evidence: {},
        evidenceHash: "e".repeat(64),
        evidenceHashValid: true,
        projectionApplied: true,
        attemptCount: 1,
        lastErrorCode: null,
        completedAt: "2026-07-12T00:05:00.000Z",
        timeline: [],
      },
      codeSubmissions: [{
        id: "90000000-0000-4000-8000-000000000001",
        language: "python",
        sourceCode: "print('hi')",
        sourceTruncated: false,
        sourceHash: "f".repeat(64),
        runtimeImageDigest: "sha256:abc",
        status: "accepted",
        createdAt: "2026-07-12T00:00:00.000Z",
      }],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/appeals?")) return json({ appeals: [summary] });
      if (url === `/api/admin/appeals/${appealId}`) return json({ detail: projectDetail });
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<AdminAppealQueue initialAppealId={appealId} />);

    expect(await screen.findByText("Weather dashboard")).toBeInTheDocument();
    expect(screen.getByText("Corrective static re-analysis")).toBeInTheDocument();
    expect(screen.getByText(/effective projection updated/i)).toBeInTheDocument();
    expect(screen.getByText(/Source hash/i)).toBeInTheDocument();
  });

  it("shows a replay confirmation and a warning when the server returns one", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/admin/appeals?")) return json({ appeals: [summary] });
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      if (url === `/api/admin/appeals/${appealId}/decision`) {
        return json({
          report: { decision: "upheld", replayed: true, correctionPending: false },
          completionAuditRecorded: true,
          warning: "A secondary notification channel is degraded.",
        });
      }
      if (url === `/api/admin/appeals/${appealId}`) return json({ detail: detail() });
      throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
    }));
    const user = userEvent.setup();
    render(<AdminAppealQueue initialAppealId={appealId} />);
    await screen.findByText(/Evidence hash verified/i);

    await user.type(screen.getByLabelText(/Current six-digit authenticator code/i), "123456");
    await user.type(screen.getByLabelText("Recorded decision reason"), "The evidence supports upholding this score.");
    await user.click(screen.getByRole("button", { name: /Record decision and notify learner/i }));

    expect(await screen.findByRole("status")).toHaveTextContent("safe replay");
    expect(screen.getByRole("status")).toHaveTextContent("A secondary notification channel is degraded.");
  });

  it("shows the queue empty state, then loads a second appeal on click", async () => {
    const secondId = "10000000-0000-4000-8000-000000000002";
    const secondSummary = { ...summary, id: secondId, learnerName: "Beto Learner" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/appeals?")) return json({ appeals: [summary, secondSummary] });
      if (url === `/api/admin/appeals/${appealId}`) return json({ detail: detail() });
      if (url === `/api/admin/appeals/${secondId}`) return json({ detail: { ...detail(), appeal: { ...detail().appeal, id: secondId, learnerName: "Beto Learner" } } });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<AdminAppealQueue initialAppealId={null} />);

    await screen.findByText("Asha Learner");
    await user.click(screen.getByText("Beto Learner"));

    await waitFor(() => expect(screen.getAllByText("Beto Learner").length).toBeGreaterThan(0));
  });

  it("shows an empty queue message when no appeals match", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/appeals?")) return json({ appeals: [] });
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<AdminAppealQueue initialAppealId={null} />);

    expect(await screen.findByText("No appeals match this queue.")).toBeInTheDocument();
    expect(screen.getByText("Select an appeal")).toBeInTheDocument();
  });

  it("surfaces a load failure for the appeal queue", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/appeals?")) return json({ error: "Queue unavailable" }, { status: 503 });
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<AdminAppealQueue initialAppealId={null} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Queue unavailable");
  });

  it("surfaces a load failure for the appeal detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/appeals?")) return json({ appeals: [summary] });
      if (url === `/api/admin/appeals/${appealId}`) return json({ error: "Evidence read failed" }, { status: 503 });
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<AdminAppealQueue initialAppealId={appealId} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Evidence read failed");
  });

  it("hides the decision panel and shows a bare message once an appeal is already decided", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/appeals?")) return json({ appeals: [summary] });
      if (url === `/api/admin/appeals/${appealId}`) return json({ detail: detail("overturned") });
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<AdminAppealQueue initialAppealId={appealId} />);

    await screen.findByText(/Evidence hash verified/i);
    expect(screen.queryByRole("button", { name: /Record decision and notify learner/i })).not.toBeInTheDocument();
  });
});
