import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminAssessmentCorrections } from "../admin-assessment-corrections";

const correctionId = "30000000-0000-4000-8000-000000000001";

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

const summary = {
  id: correctionId,
  sourceAppealId: "10000000-0000-4000-8000-000000000001",
  status: "reviewed",
  defectKind: "faulty_test",
  courseId: "python",
  moduleId: "python.loops",
  itemId: "python.loops.code-1",
  contentVersion: "2026.07",
  faultyBundleVersion: "faulty-v1",
  replacementBundleVersion: "reviewed-v2",
  affectedCount: 2,
  rowVersion: 1,
  jobs: { succeeded: 0, failed: 0, pending: 0 },
  createdAt: "2026-07-12T00:00:00.000Z",
  completedAt: null,
};

function detail(status = "reviewed") {
  return {
    correction: {
      id: correctionId,
      status,
      rowVersion: status === "reviewed" ? 1 : 2,
      affectedCount: 2,
      target: {
        courseId: "python",
        moduleId: "python.loops",
        itemId: "python.loops.code-1",
        skillId: "python.loops.for",
        contentVersion: "2026.07",
        faultyBundleVersion: "faulty-v1",
        faultyEvidenceHash: "a".repeat(64),
      },
      replacement: {
        bundleVersion: "reviewed-v2",
        evidenceHash: "b".repeat(64),
        reviewHash: "c".repeat(64),
      },
    },
    events: [{
      id: "40000000-0000-4000-8000-000000000001",
      actorRole: "admin",
      event: "reviewed",
      reason: "The replacement oracle was manually reviewed against the exact specification.",
      evidenceHash: "d".repeat(64),
      occurredAt: "2026-07-12T00:00:00.000Z",
    }],
    impacts: [{
      id: "50000000-0000-4000-8000-000000000001",
      attemptId: "60000000-0000-4000-8000-000000000001",
      learnerName: "Asha Learner",
      formId: "form-1",
      jobStatus: status === "reviewed" ? "not_queued" : "queued",
      attemptCount: 0,
      hashes: {
        form: "e".repeat(64),
        answers: "f".repeat(64),
        originalResult: "1".repeat(64),
        snapshot: "2".repeat(64),
        correctedResult: null,
      },
      correctedResult: null,
    }],
  };
}

describe("administrator assessment corrections", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads a redacted impact preview and never renders hidden test bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/assessment-corrections?")) return json({ corrections: [summary] });
      if (url === `/api/admin/assessment-corrections/${correctionId}`) return json({ detail: detail() });
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<AdminAssessmentCorrections />);
    expect(await screen.findByText("Asha Learner · not queued")).toBeInTheDocument();
    expect(screen.getByText(/Faulty evidence/i)).toBeInTheDocument();
    expect(screen.getByText(/hidden tests never appear/i)).toBeInTheDocument();
    expect(within(screen.getByLabelText("Correction impact and evidence")).queryByText(/expectedStdout/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Correction authenticator code")).toHaveAttribute("type", "password");
  });

  it("performs fresh MFA before queueing the exact version and reports automatic processing", async () => {
    let queued = false;
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url.startsWith("/api/admin/assessment-corrections?")) return json({ corrections: [{ ...summary, status: queued ? "queued" : "reviewed", rowVersion: queued ? 2 : 1 }] });
      if (url === `/api/admin/assessment-corrections/${correctionId}/queue`) {
        queued = true;
        return json({ report: { ...summary, status: "queued", rowVersion: 2 }, completionAuditRecorded: true });
      }
      if (url === `/api/admin/assessment-corrections/${correctionId}`) return json({ detail: detail(queued ? "queued" : "reviewed") });
      if (url === "/api/security/fresh-mfa") return json({ ok: true });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    render(<AdminAssessmentCorrections />);
    await screen.findByText("Asha Learner · not queued");
    await user.type(screen.getByLabelText("Correction queue reason"), "Queue every exact impact after completing the reviewed replacement evidence.");
    await user.type(screen.getByLabelText("Queue correction authenticator code"), "123456");
    await user.click(screen.getByRole("button", { name: /Queue all exact impacts/i }));
    expect(await screen.findByText(/Automatic deterministic regrading is queued/i)).toBeInTheDocument();
    const mfaIndex = calls.findIndex((call) => call.url === "/api/security/fresh-mfa");
    const queueIndex = calls.findIndex((call) => call.url.endsWith("/queue"));
    expect(mfaIndex).toBeGreaterThan(-1);
    expect(queueIndex).toBeGreaterThan(mfaIndex);
    expect(calls[queueIndex]?.body).toMatchObject({ expectedVersion: 1 });
    expect(calls[queueIndex]?.body?.requestId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("validates replacement JSON locally before requesting fresh MFA", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/assessment-corrections?")) return json({ corrections: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminAssessmentCorrections />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Reviewed replacement test evidence JSON"), { target: { value: "{" } });
    const baseline = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /Preview impact and record correction/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("valid JSON");
    expect(fetchMock).toHaveBeenCalledTimes(baseline);
  });
});
