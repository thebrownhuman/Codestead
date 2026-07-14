import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ExamRunnerResult,
  ExamSessionView,
} from "@/lib/exams/contracts";

import { TimedExamClient } from "../timed-exam-client";

const sessionId = "10000000-0000-4000-8000-000000000001";

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function activeExam(overrides: Partial<ExamSessionView> = {}): ExamSessionView {
  const now = new Date();
  const deadline = new Date(now.getTime() + 10 * 60_000);
  return {
    sessionId,
    attemptId: "20000000-0000-4000-8000-000000000001",
    attemptNumber: 1,
    status: "active",
    serverNow: now.toISOString(),
    serverStartedAt: now.toISOString(),
    serverDeadlineAt: deadline.toISOString(),
    disconnectedSeconds: 0,
    integrityReviewState: "clear",
    form: {
      schemaVersion: 1,
      formId: "form-1",
      courseId: "python",
      courseTitle: "Python",
      moduleId: "loops",
      moduleTitle: "Loops",
      contentVersion: "v1",
      policyVersion: "p1",
      durationMinutes: 10,
      generatedAt: now.toISOString(),
      instructions: [],
      integrityDisclosure: {
        version: "1",
        summary: "Activity is recorded.",
        capturedEvents: [],
        notCaptured: [],
      },
      items: [
        {
          id: "written-1",
          skillId: "python.loops.trace",
          clusterId: "loops",
          title: "Explain the trace",
          prompt: "Explain why the loop stops.",
          kind: "short-answer",
          points: 4,
          critical: true,
          verificationAvailable: true,
        },
        {
          id: "code-1",
          skillId: "python.loops.code",
          clusterId: "loops",
          title: "Code challenge",
          prompt: "Print the values from one through three.",
          kind: "code",
          points: 6,
          critical: true,
          language: "python",
          starterCode: "",
          verificationAvailable: false,
        },
      ],
    },
    answers: {
      "written-1": {
        revision: 2,
        answer: { text: "The saved explanation." },
        savedAt: now.toISOString(),
      },
    },
    result: null,
    retake: null,
    appealSubmitted: false,
    appeal: null,
    ...overrides,
  };
}

function gradedExam(overrides: Partial<ExamSessionView> = {}): ExamSessionView {
  const base = activeExam();
  return {
    ...base,
    status: "graded",
    result: {
      schemaVersion: 1,
      gradingStatus: "graded",
      outcome: "MASTERED",
      officialScorePercent: 95,
      earnedPoints: 10,
      possiblePoints: 10,
      pendingReviewItemIds: [],
      failedCriticalClusters: [],
      masteryBlockingCodingItems: [],
      compilationGatePassed: true,
      infrastructureFailure: false,
      finalizedAt: base.serverNow,
      finalizedBy: "learner-submit",
      policyVersion: "p1",
      remediation: { required: false, targets: [] },
    },
    ...overrides,
  };
}

function runnerResult(withRun = false): ExamRunnerResult {
  const now = new Date().toISOString();
  return {
    status: withRun ? "ACCEPTED" : "COMPILE_ONLY",
    requestHash: "a".repeat(64),
    sourceHash: "b".repeat(64),
    runtimeVersion: "python-3.14",
    imageDigest: `sha256:${"c".repeat(64)}`,
    compile: {
      status: "OK",
      exitCode: 0,
      stdout: "",
      stderr: withRun ? "" : "compile stderr",
      wallTimeMs: 5,
    },
    run: withRun ? { exitCode: 0, stdout: "1\n2\n3", stderr: "", wallTimeMs: 7 } : undefined,
    tests: [],
    totals: { passed: 0, failed: 0, total: 0 },
    startedAt: now,
    finishedAt: now,
  };
}

describe("timed exam client workflows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("autosaves conflict-safely, runs code, records integrity events, and submits", async () => {
    let currentExam = activeExam();
    let online = true;
    let autosaves = 0;
    let codeConflictReturned = false;
    let runCalls = 0;
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(window.navigator, "sendBeacon", { configurable: true, value: sendBeacon });
    const requestFullscreen = vi.fn(async () => undefined);
    Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: requestFullscreen });
    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string"
        ? JSON.parse(init.body) as Record<string, unknown>
        : undefined;
      calls.push({ url, body });
      if (url === `/api/exams/${sessionId}`) return json({ exam: currentExam });
      if (url.endsWith("/events")) return json({ accepted: true });
      if (url.endsWith("/autosave")) {
        autosaves += 1;
        if (body?.itemId === "code-1" && !codeConflictReturned) {
          codeConflictReturned = true;
          return json({ code: "AUTOSAVE_REVISION_CONFLICT", currentRevision: 4 }, { status: 409 });
        }
        return json({ saved: { revision: 5 } });
      }
      if (url.endsWith("/run")) {
        runCalls += 1;
        if (runCalls === 3) return json({ error: "Runner maintenance" }, { status: 503 });
        return json({ result: runnerResult(runCalls === 2) });
      }
      if (url.endsWith("/submit")) {
        currentExam = gradedExam();
        return json({ exam: currentExam });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const user = userEvent.setup();
    render(<TimedExamClient sessionId={sessionId} />);

    expect(await screen.findByText("Question 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
    const written = screen.getByLabelText("Your response");
    await user.clear(written);
    await user.type(written, "A boundary condition ends it.");
    fireEvent.paste(written, { clipboardData: { getData: () => "pasted" } });

    await user.click(screen.getByRole("button", { name: /Code challenge/i }));
    expect(screen.getByText("Review required")).toBeInTheDocument();
    const source = screen.getByLabelText("Source code");
    await user.type(source, "for n in range(1, 4): print(n)");
    await user.type(screen.getByLabelText("Standard input (optional)"), "fixture input");
    fireEvent.paste(source, { clipboardData: { getData: () => "print" } });

    await user.click(screen.getByRole("button", { name: "Compile" }));
    expect(await screen.findByText("compile stderr")).toBeInTheDocument();
    expect(autosaves).toBeGreaterThanOrEqual(2);
    const codeAutosaves = calls.filter((call) => call.url.endsWith("/autosave") && call.body?.itemId === "code-1");
    expect(codeAutosaves.at(-1)?.body).toMatchObject({
      itemId: "code-1",
      baseRevision: 4,
    });

    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText(/1\s+2\s+3/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("Runner maintenance")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Fullscreen" }));
    expect(requestFullscreen).toHaveBeenCalledOnce();

    online = false;
    fireEvent(window, new Event("offline"));
    expect(await screen.findByText("Offline")).toBeInTheDocument();
    fireEvent(window, new Event("blur"));
    fireEvent(window, new Event("focus"));
    fireEvent(document, new Event("visibilitychange"));
    fireEvent(document, new Event("fullscreenchange"));
    fireEvent(window, new Event("beforeunload"));
    expect(sendBeacon).toHaveBeenCalledOnce();
    online = true;
    fireEvent(window, new Event("online"));
    expect(await screen.findByText("Connected")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Submit final" }));
    expect(calls.some((call) => call.url.endsWith("/submit"))).toBe(false);
    await user.click(screen.getByRole("button", { name: "Submit final" }));
    expect(await screen.findByRole("heading", { name: "mastered" })).toBeInTheDocument();
    expect(screen.getByText("95%")).toBeInTheDocument();
  });

  it("auto-finalizes at the server deadline and explains an offline failure", async () => {
    const expired = activeExam({ serverDeadlineAt: new Date(Date.now() - 1_000).toISOString() });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) return json({ exam: expired });
      if (url.endsWith("/submit")) return json({ error: "offline" }, { status: 503 });
      if (url.endsWith("/events")) return json({ accepted: true });
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<TimedExamClient sessionId={sessionId} />);
    expect(await screen.findByText("00:00")).toBeInTheDocument();
    expect(await screen.findByText(/server deadline still applies/i, {}, { timeout: 2_000 })).toBeInTheDocument();
  });

  it("shows pending deterministic review details and submits an appeal", async () => {
    const base = gradedExam();
    let currentExam: ExamSessionView = {
      ...base,
      status: "under_review",
      result: {
        ...base.result!,
        gradingStatus: "pending-review",
        outcome: "PENDING_REVIEW",
        officialScorePercent: null,
        earnedPoints: null,
        pendingReviewItemIds: ["written-1"],
        infrastructureFailure: true,
        finalizedBy: "deadline",
        remediation: { required: true, targets: ["python.loops.trace"] },
      },
      retake: {
        eligible: false,
        reason: "cooldown",
        nextEligibleAt: new Date(Date.now() + 86_400_000).toISOString(),
        requiresRemediation: true,
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) return json({ exam: currentExam });
      if (url.endsWith("/appeal") && init?.method === "POST") {
        currentExam = {
          ...currentExam,
          appealSubmitted: true,
          appeal: {
            id: "30000000-0000-4000-8000-000000000001",
            status: "under_review",
            decision: null,
            decisionReason: null,
            updatedAt: new Date().toISOString(),
          },
        };
        return json({ accepted: true }, { status: 202 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();

    render(<TimedExamClient sessionId={sessionId} />);
    expect(await screen.findByRole("heading", { name: "Submitted for review" })).toBeInTheDocument();
    expect(screen.getByText(/one question|1 question/i)).toBeInTheDocument();
    expect(screen.getByText("Technical incident flagged")).toBeInTheDocument();
    expect(screen.getByText(/Remediation required before retake/i)).toBeInTheDocument();
    expect(screen.getByText(/Retake opens/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Request a review" }));
    await user.selectOptions(screen.getByLabelText("Review category"), "technical");
    await user.type(screen.getByLabelText("What should the reviewer inspect?"), "too short");
    await user.click(screen.getByRole("button", { name: "Submit appeal" }));
    expect(screen.getByRole("status")).toHaveTextContent(/at least 20 characters/i);
    await user.clear(screen.getByLabelText("What should the reviewer inspect?"));
    await user.type(screen.getByLabelText("What should the reviewer inspect?"), "Please inspect the recorded infrastructure failure.");
    await user.click(screen.getByRole("button", { name: "Submit appeal" }));
    expect(await screen.findByText("Appeal pending human review")).toBeInTheDocument();
  });

  it("refreshes a session that is still finalizing", async () => {
    const finalizing = { ...activeExam(), status: "submitted" as const, result: null };
    let loads = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      loads += 1;
      return json({ exam: finalizing });
    }));
    const user = userEvent.setup();

    render(<TimedExamClient sessionId={sessionId} />);
    expect(await screen.findByRole("heading", { name: "Finalization is in progress" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(loads).toBeGreaterThan(1));
  });

  it("shows a safe load error when the session cannot be restored", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Session expired." }, { status: 404 })));
    render(<TimedExamClient sessionId={sessionId} />);
    expect(await screen.findByRole("heading", { name: "Exam unavailable" })).toBeInTheDocument();
    expect(screen.getByText("Session expired.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Return to exams" })).toHaveAttribute("href", "/exams");
  });

  it.each([
    ["overturned", "Appeal granted; corrective review is pending"],
    ["upheld", "Review complete; the original result was upheld"],
    [null, "Appeal pending human review"],
  ])("renders the %s appeal outcome", async (decision, copy) => {
    const base = gradedExam();
    const withAppeal: ExamSessionView = {
      ...base,
      appealSubmitted: true,
      appeal: {
        id: "30000000-0000-4000-8000-000000000001",
        status: "closed",
        decision,
        decisionReason: null,
        updatedAt: base.serverNow,
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => json({ exam: withAppeal })));
    render(<TimedExamClient sessionId={sessionId} />);
    expect(await screen.findByText(copy)).toBeInTheDocument();
  });
});
