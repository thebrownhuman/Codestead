import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  IDBFactory as FakeIDBFactory,
  IDBObjectStore as FakeIDBObjectStore,
} from "fake-indexeddb";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EMERGENCY_EXAM_EVENT_PREFIX, writeEmergencyExamEvent } from "@/lib/browser-durability/emergency-events";
import { openBrowserOutbox } from "@/lib/browser-durability/indexed-db";
import {
  draftOutboxScope,
  draftOutboxStorageKey,
  examAnswerOutboxStorageKey,
  examEventOutboxStorageKey,
  type DraftOutboxRecord,
  type ExamAnswerOutboxRecord,
  type ExamEventOutboxRecord,
} from "@/lib/browser-durability/types";
import { DraftCacheNamespaceProvider } from "@/lib/drafts/browser-cache-context";
import type {
  ExamRunnerResult,
  ExamSessionView,
} from "@/lib/exams/contracts";

import { TimedExamClient } from "../timed-exam-client";

const sessionId = "10000000-0000-4000-8000-000000000001";
const namespace = "learner-session-exam-workflow";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderWithNamespace(ui: React.ReactNode) {
  return render(
    <DraftCacheNamespaceProvider namespace={namespace}>
      {ui}
    </DraftCacheNamespaceProvider>,
  );
}

function autosaveAck(body: Record<string, unknown>, replayed = false) {
  return json({
    saved: {
      clientMutationId: body.clientMutationId,
      replayed,
      revision: Number(body.baseRevision) + 1,
      answer: body.answer,
      savedAt: new Date().toISOString(),
    },
  });
}

function answerRecord(input: {
  answer?: string;
  itemId?: string;
  recordSessionId?: string;
  mutationId?: string;
  baseRevision?: number;
} = {}): ExamAnswerOutboxRecord {
  const itemId = input.itemId ?? "written-1";
  const scope = input.recordSessionId ?? sessionId;
  return {
    schemaVersion: 1,
    storageKey: examAnswerOutboxStorageKey(namespace, scope, itemId),
    namespace,
    kind: "exam-answer",
    scope,
    clientMutationId: input.mutationId ?? "30000000-0000-4000-8000-000000000001",
    updatedAt: new Date().toISOString(),
    payload: {
      itemId,
      answer: input.answer ?? "recovered browser answer",
      baseRevision: input.baseRevision ?? 2,
    },
  };
}

function eventRecord(input: {
  recordSessionId?: string;
  clientEventId?: string;
} = {}): ExamEventOutboxRecord {
  const scope = input.recordSessionId ?? sessionId;
  const clientEventId = input.clientEventId ?? "40000000-0000-4000-8000-000000000001";
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    storageKey: examEventOutboxStorageKey(namespace, scope, clientEventId),
    namespace,
    kind: "exam-event",
    scope,
    clientEventId,
    updatedAt: now,
    payload: {
      eventType: "navigation_attempt",
      occurredAt: now,
      metadata: { reason: "beforeunload" },
    },
  };
}

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
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("autosaves conflict-safely, runs code, records integrity events, and submits", async () => {
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    let currentExam = activeExam();
    let online = true;
    let autosaves = 0;
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
      if (url.endsWith("/events")) return json({ accepted: true, duplicate: false });
      if (url.endsWith("/autosave")) {
        autosaves += 1;
        return autosaveAck(body ?? {});
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
    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);

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
      baseRevision: 0,
      answer: { sourceCode: "for n in range(1, 4): print(n)", language: "python" },
    });
    expect(codeAutosaves.at(-1)?.body?.clientMutationId).toEqual(expect.any(String));

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

  it("gates editors during hydration and restores durable written and code values before replay", async () => {
    const factory = new FakeIDBFactory();
    vi.stubGlobal("indexedDB", factory);
    const seed = await openBrowserOutbox(factory);
    await seed.putExamAnswer(answerRecord({ answer: "recovered written value" }));
    await seed.putExamAnswer(answerRecord({
      itemId: "code-1",
      answer: "print('recovered code')",
      baseRevision: 0,
      mutationId: "30000000-0000-4000-8000-000000000002",
    }));
    seed.close();
    const autosaves: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) return json({ exam: activeExam() });
      if (url.endsWith("/autosave")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        autosaves.push(body);
        return autosaveAck(body, true);
      }
      if (url.endsWith("/events")) return json({ accepted: true, duplicate: false });
      throw new Error(`Unexpected request: ${url}`);
    }));

    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    expect(screen.queryByLabelText("Your response")).not.toBeInTheDocument();
    expect(await screen.findByDisplayValue("recovered written value")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Code challenge/i }));
    expect(screen.getByDisplayValue("print('recovered code')")).toBeInTheDocument();
    await waitFor(() => expect(autosaves).toHaveLength(2));
    expect(autosaves).toEqual(expect.arrayContaining([
      expect.objectContaining({
        itemId: "written-1",
        answer: { text: "recovered written value" },
      }),
      expect.objectContaining({
        itemId: "code-1",
        answer: { sourceCode: "print('recovered code')", language: "python" },
      }),
    ]));
  });

  it("shows truthful local/sync/server states and does not submit across a pending acknowledgement", async () => {
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    const autosave = deferred<Response>();
    const calls: string[] = [];
    let currentExam = activeExam();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === `/api/exams/${sessionId}`) return json({ exam: currentExam });
      if (url.endsWith("/events")) return json({ accepted: true, duplicate: false });
      if (url.endsWith("/autosave")) return autosave.promise;
      if (url.endsWith("/submit")) {
        currentExam = gradedExam();
        return json({ exam: currentExam });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    const written = await screen.findByLabelText("Your response");
    fireEvent.change(written, { target: { value: "locally durable submission" } });
    expect(await screen.findByText("Saved locally on this browser.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save & next" }));
    await user.click(screen.getByRole("button", { name: "Submit final" }));
    expect(await screen.findByText("Syncing to Codestead...")).toBeInTheDocument();
    expect(calls.some((url) => url.endsWith("/submit"))).toBe(false);
    const fetchMock = vi.mocked(fetch);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/autosave"))).toBe(true));
    const autosaveCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/autosave"))!;
    const body = JSON.parse(String(autosaveCall[1]?.body)) as Record<string, unknown>;
    autosave.resolve(autosaveAck(body));
    expect(await screen.findByRole("heading", { name: "mastered" })).toBeInTheDocument();
    expect(calls.some((url) => url.endsWith("/submit"))).toBe(true);
  });

  it.each(["response headers", "response body"] as const)(
    "bounds stalled final-submit %s and recovers authoritative status without resubmitting",
    async (stalledPart) => {
      vi.stubGlobal("indexedDB", new FakeIDBFactory());
      vi.spyOn(window, "confirm").mockReturnValue(true);
      let getCalls = 0;
      let submitCalls = 0;
      let submitSignal: AbortSignal | undefined;
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === `/api/exams/${sessionId}`) {
          getCalls += 1;
          return Promise.resolve(json({ exam: activeExam() }));
        }
        if (url.endsWith("/events")) {
          return Promise.resolve(json({ accepted: true, duplicate: false }));
        }
        if (url.endsWith("/submit")) {
          submitCalls += 1;
          submitSignal = init?.signal ?? undefined;
          if (stalledPart === "response headers") return new Promise<Response>(() => undefined);
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => new Promise<unknown>(() => undefined),
          } as Response);
        }
        throw new Error(`Unexpected request: ${url}`);
      }));
      const user = userEvent.setup();
      renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
      await screen.findByLabelText("Your response");
      await user.click(screen.getByRole("button", { name: "Save & next" }));

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      fireEvent.click(screen.getByRole("button", { name: "Submit final" }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(submitCalls).toBe(1);
      expect(getCalls).toBe(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
      expect(getCalls).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(submitSignal?.aborted).toBe(true);
      expect(submitCalls).toBe(1);
      expect(getCalls).toBe(2);
      expect(screen.queryByRole("heading", { name: "mastered" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Submit final" })).toBeEnabled();
    },
  );

  it("releases editing but fences resubmission while authoritative recovery GET stalls", async () => {
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let getCalls = 0;
    let submitCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) {
        getCalls += 1;
        if (getCalls === 1) return Promise.resolve(json({ exam: activeExam() }));
        return new Promise<Response>(() => undefined);
      }
      if (url.endsWith("/events")) return Promise.resolve(json({ accepted: true, duplicate: false }));
      if (url.endsWith("/submit")) {
        submitCalls += 1;
        return new Promise<Response>(() => undefined);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    await screen.findByLabelText("Your response");
    await user.click(screen.getByRole("button", { name: "Save & next" }));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Submit final" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getCalls).toBe(2);
    expect(submitCalls).toBe(1);
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
    expect(screen.getByLabelText("Source code")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Submit final" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Submit final" }));
    expect(submitCalls).toBe(1);
  });

  it("keeps resubmission fenced when authoritative recovery GET fails", async () => {
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let getCalls = 0;
    let submitCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) {
        getCalls += 1;
        return Promise.resolve(getCalls === 1
          ? json({ exam: activeExam() })
          : json({ error: "Authoritative status is unavailable." }, { status: 503 }));
      }
      if (url.endsWith("/events")) return Promise.resolve(json({ accepted: true, duplicate: false }));
      if (url.endsWith("/submit")) {
        submitCalls += 1;
        return new Promise<Response>(() => undefined);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    await screen.findByLabelText("Your response");
    await user.click(screen.getByRole("button", { name: "Save & next" }));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Submit final" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getCalls).toBe(2);
    expect(submitCalls).toBe(1);
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
    expect(screen.getByLabelText("Source code")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Submit final" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Submit final" }));
    expect(submitCalls).toBe(1);
  });

  it("aborts owned final-submit work when the active exam unmounts", async () => {
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let submitSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) return Promise.resolve(json({ exam: activeExam() }));
      if (url.endsWith("/events")) return Promise.resolve(json({ accepted: true, duplicate: false }));
      if (url.endsWith("/submit")) {
        submitSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    const rendered = renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    await screen.findByLabelText("Your response");
    await user.click(screen.getByRole("button", { name: "Save & next" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit final" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(submitSignal?.aborted).toBe(false);
    rendered.unmount();
    expect(submitSignal?.aborted).toBe(true);
  });

  it("does not start final-submit work after unmount wins the flush continuation", async () => {
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let submitCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) return Promise.resolve(json({ exam: activeExam() }));
      if (url.endsWith("/events")) return Promise.resolve(json({ accepted: true, duplicate: false }));
      if (url.endsWith("/submit")) {
        submitCalls += 1;
        return new Promise<Response>(() => undefined);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const rendered = renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    await screen.findByLabelText("Your response");
    fireEvent.click(screen.getByRole("button", { name: "Save & next" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit final" }));
    rendered.unmount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(submitCalls).toBe(0);
  });

  it.each([768, 1_100])("keeps durability copy in a live body status at the supported %ipx viewport", async (width) => {
    vi.stubGlobal("innerWidth", width);
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) return json({ exam: activeExam() });
      if (url.endsWith("/events")) return json({ accepted: true, duplicate: false });
      throw new Error(`Unexpected request: ${url}`);
    }));

    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    await screen.findByLabelText("Your response");
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");
    expect(status).toHaveTextContent("Saved to Codestead.");
    expect(status.closest("main")).not.toBeNull();
  });

  it("contains and clears only its owned local-persistence failure notice after a replacement commits", async () => {
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    const originalPut = FakeIDBObjectStore.prototype.put;
    let rejectedAnswerPut = false;
    vi.spyOn(FakeIDBObjectStore.prototype, "put").mockImplementation(function put(
      this: IDBObjectStore,
      value,
      key,
    ) {
      if (!rejectedAnswerPut && (value as { kind?: string }).kind === "exam-answer") {
        rejectedAnswerPut = true;
        throw new Error("private-indexeddb-detail: exam answer transaction aborted");
      }
      return Reflect.apply(originalPut, this, key === undefined ? [value] : [value, key]);
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) return json({ exam: activeExam() });
      if (url.endsWith("/events")) return json({ accepted: true, duplicate: false });
      if (url.endsWith("/autosave")) {
        return autosaveAck(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    const written = await screen.findByLabelText("Your response");
    fireEvent.change(written, { target: { value: "first local attempt" } });
    expect(await screen.findByText("This edit did not reach browser recovery. Try again or copy it before leaving.")).toBeInTheDocument();
    expect(screen.queryByText(/private-indexeddb-detail/i)).not.toBeInTheDocument();

    fireEvent.change(written, { target: { value: "replacement crossed local storage" } });
    expect(await screen.findByText("Saved locally on this browser.")).toBeInTheDocument();
    expect(screen.queryByText(/This edit did not reach browser recovery/i)).not.toBeInTheDocument();
  });

  it("clears its owned local-persistence notice after Retry now commits and synchronizes", async () => {
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    const originalPut = FakeIDBObjectStore.prototype.put;
    let rejectedAnswerPut = false;
    vi.spyOn(FakeIDBObjectStore.prototype, "put").mockImplementation(function put(
      this: IDBObjectStore,
      value,
      key,
    ) {
      if (!rejectedAnswerPut && (value as { kind?: string }).kind === "exam-answer") {
        rejectedAnswerPut = true;
        throw new Error("private-indexeddb-detail: exam answer transaction aborted");
      }
      return Reflect.apply(originalPut, this, key === undefined ? [value] : [value, key]);
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) return json({ exam: activeExam() });
      if (url.endsWith("/events")) return json({ accepted: true, duplicate: false });
      if (url.endsWith("/autosave")) {
        return autosaveAck(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const user = userEvent.setup();
    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    const written = await screen.findByLabelText("Your response");
    fireEvent.change(written, { target: { value: "retry this local write" } });
    expect(await screen.findByText("This edit did not reach browser recovery. Try again or copy it before leaving.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry now" }));
    expect(await screen.findByText("Saved to Codestead.")).toBeInTheDocument();
    expect(screen.queryByText(/This edit did not reach browser recovery/i)).not.toBeInTheDocument();
  });

  it.each([
    ["accepted beacon", true],
    ["declined beacon", false],
    ["throwing beacon", "throw"],
  ])("keeps a stable emergency unload event through reopen with a %s", async (_label, beaconResult) => {
    const factory = new FakeIDBFactory();
    vi.stubGlobal("indexedDB", factory);
    const postedEvents: Array<Record<string, unknown>> = [];
    const sendBeacon = vi.fn(() => {
      if (beaconResult === "throw") throw new Error("beacon unavailable");
      return beaconResult;
    });
    Object.defineProperty(window.navigator, "sendBeacon", {
      configurable: true,
      value: sendBeacon,
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) return json({ exam: activeExam() });
      if (url.endsWith("/events")) {
        postedEvents.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ accepted: true, duplicate: true });
      }
      if (url.endsWith("/autosave")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return autosaveAck(body);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const first = renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    await screen.findByLabelText("Your response");
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent(window, new Event("beforeunload"));
    expect(sendBeacon).toHaveBeenCalledOnce();
    const emergencyKey = Object.keys(window.localStorage)
      .find((key) => key.startsWith(EMERGENCY_EXAM_EVENT_PREFIX));
    expect(emergencyKey).toBeDefined();
    const emergency = JSON.parse(window.localStorage.getItem(emergencyKey!)!) as ExamEventOutboxRecord;
    first.unmount();

    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    await screen.findByLabelText("Your response");
    await waitFor(() => expect(postedEvents.some((event) =>
      event.clientEventId === emergency.clientEventId
      && event.type === "navigation_attempt"
    )).toBe(true));
    expect(postedEvents.find((event) => event.clientEventId === emergency.clientEventId)).toEqual({
      clientEventId: emergency.clientEventId,
      type: "navigation_attempt",
      metadata: { reason: "beforeunload" },
    });
    expect(window.localStorage.getItem(emergencyKey!)).toBeNull();
  });

  it("renders a genuine answer conflict and blocks final submission until the learner chooses", async () => {
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    const calls: string[] = [];
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === `/api/exams/${sessionId}`) return json({ exam: activeExam() });
      if (url.endsWith("/events")) return json({ accepted: true, duplicate: false });
      if (url.endsWith("/autosave")) return json({
        code: "AUTOSAVE_REVISION_CONFLICT",
        currentRevision: 5,
        currentAnswer: { text: "server conflict value" },
        currentSavedAt: new Date().toISOString(),
      }, { status: 409 });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    fireEvent.change(await screen.findByLabelText("Your response"), {
      target: { value: "recovered conflict value" },
    });
    await user.click(screen.getByRole("button", { name: "Save & next" }));
    await user.click(screen.getByRole("button", { name: "Submit final" }));
    expect(await screen.findByText("Needs attention: choose which answer to keep.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Explain the trace/i }));
    expect(screen.getByDisplayValue("recovered conflict value")).toBeInTheDocument();
    expect(screen.getByDisplayValue("server conflict value")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep recovered answer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use server answer" })).toBeInTheDocument();
    expect(calls.some((url) => url.endsWith("/submit"))).toBe(false);
  });

  it("disables both conflict choices while the admitted choice is pending", async () => {
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const replacementGate = deferred<void>();
    let autosaves = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) return json({ exam: activeExam() });
      if (url.endsWith("/events")) return json({ accepted: true, duplicate: false });
      if (url.endsWith("/autosave")) {
        autosaves += 1;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (autosaves === 1) {
          return json({
            code: "AUTOSAVE_REVISION_CONFLICT",
            currentRevision: 5,
            currentAnswer: { text: "server conflict value" },
            currentSavedAt: new Date().toISOString(),
          }, { status: 409 });
        }
        await replacementGate.promise;
        return autosaveAck(body);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    fireEvent.change(await screen.findByLabelText("Your response"), {
      target: { value: "the admitted local choice" },
    });
    await user.click(screen.getByRole("button", { name: "Save & next" }));
    await user.click(screen.getByRole("button", { name: "Submit final" }));
    await user.click(screen.getByRole("button", { name: "Previous" }));
    const keepRecovered = await screen.findByRole("button", { name: "Keep recovered answer" });
    const useServer = screen.getByRole("button", { name: "Use server answer" });

    fireEvent.click(keepRecovered);
    const keepWasDisabled = keepRecovered.hasAttribute("disabled");
    const serverWasDisabled = useServer.hasAttribute("disabled");
    fireEvent.click(useServer);
    replacementGate.resolve(undefined);
    await waitFor(() => expect(autosaves).toBe(2));
    expect(await screen.findByDisplayValue("the admitted local choice")).toBeInTheDocument();
    expect(keepWasDisabled).toBe(true);
    expect(serverWasDisabled).toBe(true);
  });

  it("disables conflict choices when the estimated server deadline closes work", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const now = new Date("2026-07-15T10:00:00.000Z");
    vi.setSystemTime(now);
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const expiring = activeExam({
      serverNow: now.toISOString(),
      serverDeadlineAt: new Date(now.getTime() + 1_000).toISOString(),
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) return Promise.resolve(json({ exam: expiring }));
      if (url.endsWith("/events")) return Promise.resolve(json({ accepted: true, duplicate: false }));
      if (url.endsWith("/autosave")) return Promise.resolve(json({
        code: "AUTOSAVE_REVISION_CONFLICT",
        currentRevision: 5,
        currentAnswer: { text: "server conflict value" },
        currentSavedAt: new Date().toISOString(),
      }, { status: 409 }));
      if (url.endsWith("/submit")) return new Promise<Response>(() => undefined);
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    fireEvent.change(await screen.findByLabelText("Your response"), {
      target: { value: "recovered conflict value" },
    });
    await user.click(screen.getByRole("button", { name: "Save & next" }));
    await user.click(screen.getByRole("button", { name: "Submit final" }));
    await user.click(screen.getByRole("button", { name: "Previous" }));
    const keepRecovered = await screen.findByRole("button", { name: "Keep recovered answer" });
    const useServer = screen.getByRole("button", { name: "Use server answer" });
    expect(keepRecovered).toBeEnabled();
    expect(useServer).toBeEnabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(keepRecovered).toBeDisabled();
    expect(useServer).toBeDisabled();
  });

  it("does not write or beacon an unload event after the estimated deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const now = new Date("2026-07-15T10:00:00.000Z");
    vi.setSystemTime(now);
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    const expiring = activeExam({
      serverNow: now.toISOString(),
      serverDeadlineAt: new Date(now.getTime() + 1_000).toISOString(),
    });
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(window.navigator, "sendBeacon", {
      configurable: true,
      value: sendBeacon,
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) return Promise.resolve(json({ exam: expiring }));
      if (url.endsWith("/events")) return Promise.resolve(json({ accepted: true, duplicate: false }));
      if (url.endsWith("/submit")) return new Promise<Response>(() => undefined);
      throw new Error(`Unexpected request: ${url}`);
    }));
    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    await screen.findByLabelText("Your response");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    window.localStorage.clear();
    sendBeacon.mockClear();

    fireEvent(window, new Event("beforeunload"));
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(Object.keys(window.localStorage).filter((key) =>
      key.startsWith(EMERGENCY_EXAM_EVENT_PREFIX)
    )).toEqual([]);
  });

  it("does not recreate or beacon unload recovery while successful terminal purge is still mounted", async () => {
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(window.navigator, "sendBeacon", {
      configurable: true,
      value: sendBeacon,
    });
    let currentExam = activeExam();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) return json({ exam: currentExam });
      if (url.endsWith("/events")) return json({ accepted: true, duplicate: false });
      if (url.endsWith("/submit")) {
        currentExam = gradedExam();
        return json({ exam: currentExam });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    await screen.findByLabelText("Your response");

    const purgeSnapshot = eventRecord({
      clientEventId: "40000000-0000-4000-8000-000000000077",
    });
    writeEmergencyExamEvent(window.localStorage, purgeSnapshot);
    const snapshotKey = Object.keys(window.localStorage)
      .find((key) => key.includes(purgeSnapshot.clientEventId))!;
    const removeItem = Storage.prototype.removeItem;
    let firedDuringPurge = false;
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function removeAndUnload(
      this: Storage,
      key: string,
    ) {
      removeItem.call(this, key);
      if (key === snapshotKey && !firedDuringPurge) {
        firedDuringPurge = true;
        fireEvent(window, new Event("beforeunload"));
      }
    });

    await user.click(screen.getByRole("button", { name: "Save & next" }));
    await user.click(screen.getByRole("button", { name: "Submit final" }));
    expect(await screen.findByRole("heading", { name: "mastered" })).toBeInTheDocument();
    expect(firedDuringPurge).toBe(true);
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(Object.keys(window.localStorage).filter((key) =>
      key.startsWith(EMERGENCY_EXAM_EVENT_PREFIX)
    )).toEqual([]);
  });

  it("does not run code when the durable answer cannot be synchronized", async () => {
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === `/api/exams/${sessionId}`) return json({ exam: activeExam() });
      if (url.endsWith("/events")) return json({ accepted: true, duplicate: false });
      if (url.endsWith("/autosave")) return json({ error: "unavailable" }, { status: 503 });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    await screen.findByLabelText("Your response");
    await user.click(screen.getByRole("button", { name: /Code challenge/i }));
    fireEvent.change(screen.getByLabelText("Source code"), { target: { value: "print(42)" } });
    await user.click(screen.getByRole("button", { name: "Compile" }));
    expect(await screen.findByText(/could not synchronize the answer/i)).toBeInTheDocument();
    expect(calls.some((url) => url.endsWith("/run"))).toBe(false);
  });

  it("runs only the source snapshot covered by the completed synchronization barrier", async () => {
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    const firstAutosave = deferred<Response>();
    const autosaves: Array<Record<string, unknown>> = [];
    const runs: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) return json({ exam: activeExam() });
      if (url.endsWith("/events")) return json({ accepted: true, duplicate: false });
      if (url.endsWith("/autosave")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        autosaves.push(body);
        if (autosaves.length === 1) return firstAutosave.promise;
        return autosaveAck(body);
      }
      if (url.endsWith("/run")) {
        runs.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ result: runnerResult() });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    await screen.findByLabelText("Your response");
    await user.click(screen.getByRole("button", { name: /Code challenge/i }));
    const source = screen.getByLabelText("Source code");
    fireEvent.change(source, { target: { value: "print('synchronized A')" } });
    fireEvent.click(screen.getByRole("button", { name: "Compile" }));
    await waitFor(() => expect(autosaves).toHaveLength(1));

    expect.soft(source).toBeDisabled();
    expect.soft(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
    expect.soft(screen.getByLabelText("Standard input (optional)")).toBeDisabled();
    expect.soft(screen.getByRole("button", { name: /Explain the trace/i })).toBeDisabled();
    await user.type(source, "print('unsynchronized B')");
    expect.soft(source).toHaveValue("print('synchronized A')");

    await act(async () => {
      firstAutosave.resolve(autosaveAck(autosaves[0]!));
    });
    await waitFor(() => expect(runs).toHaveLength(1));
    const synchronizedSource = (autosaves.at(-1)?.answer as { sourceCode?: string }).sourceCode;
    expect(runs[0]?.sourceCode).toBe(synchronizedSource);
  });

  it("reopens exam controls after synchronization while runner response headers are stalled", async () => {
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    let runCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) return json({ exam: activeExam() });
      if (url.endsWith("/events")) return json({ accepted: true, duplicate: false });
      if (url.endsWith("/run")) {
        runCalls += 1;
        return new Promise<Response>(() => undefined);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    await screen.findByLabelText("Your response");
    await user.click(screen.getByRole("button", { name: /Code challenge/i }));
    fireEvent.click(screen.getByRole("button", { name: "Compile" }));
    await waitFor(() => expect(runCalls).toBe(1));

    expect(screen.getByLabelText("Source code")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reset" })).toBeEnabled();
    expect(screen.getByLabelText("Standard input (optional)")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Submit final" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Compile" })).toBeDisabled();
  });

  it("does not start a runner request when the deadline wins the post-sync continuation", async () => {
    const now = new Date("2026-07-15T10:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    let runCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) {
        return json({
          exam: activeExam({
            serverNow: now.toISOString(),
            serverDeadlineAt: new Date(now.getTime() + 1_000).toISOString(),
          }),
        });
      }
      if (url.endsWith("/events")) return json({ accepted: true, duplicate: false });
      if (url.endsWith("/run")) {
        runCalls += 1;
        return json({ result: runnerResult() });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();
    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    await screen.findByLabelText("Your response");
    await user.click(screen.getByRole("button", { name: /Code challenge/i }));

    fireEvent.click(screen.getByRole("button", { name: "Compile" }));
    vi.setSystemTime(new Date(now.getTime() + 1_000));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(runCalls).toBe(0);
  });

  it("purges only exact terminal recovery before rendering the result", async () => {
    const factory = new FakeIDBFactory();
    vi.stubGlobal("indexedDB", factory);
    const otherSessionId = "10000000-0000-4000-8000-000000000099";
    const seed = await openBrowserOutbox(factory);
    await seed.putExamAnswer(answerRecord());
    await seed.putExamAnswer(answerRecord({
      recordSessionId: otherSessionId,
      mutationId: "30000000-0000-4000-8000-000000000099",
    }));
    await seed.putExamEvent(eventRecord());
    await seed.putExamEvent(eventRecord({
      recordSessionId: otherSessionId,
      clientEventId: "40000000-0000-4000-8000-000000000099",
    }));
    const draftKey = { kind: "code", courseId: "python", skillId: "loops", language: "python" } as const;
    const draft: DraftOutboxRecord = {
      schemaVersion: 1,
      storageKey: draftOutboxStorageKey(namespace, draftKey),
      namespace,
      kind: "draft",
      scope: draftOutboxScope(draftKey),
      requestId: "50000000-0000-4000-8000-000000000001",
      updatedAt: new Date().toISOString(),
      payload: { key: draftKey, content: "draft survives", baseRevision: 0 },
    };
    await seed.putDraft(draft);
    seed.close();
    const thisEmergency = eventRecord({ clientEventId: "40000000-0000-4000-8000-000000000002" });
    const otherEmergency = eventRecord({
      recordSessionId: otherSessionId,
      clientEventId: "40000000-0000-4000-8000-000000000098",
    });
    writeEmergencyExamEvent(window.localStorage, thisEmergency);
    writeEmergencyExamEvent(window.localStorage, otherEmergency);
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === `/api/exams/${sessionId}`) return json({ exam: gradedExam() });
      throw new Error(`Unexpected request: ${url}`);
    }));

    const rendered = renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    expect(screen.queryByRole("heading", { name: "mastered" })).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "mastered" })).toBeInTheDocument();
    rendered.unmount();
    const inspect = await openBrowserOutbox(factory);
    expect(await inspect.listExamAnswers(namespace, sessionId)).toEqual([]);
    expect(await inspect.listExamEvents(namespace, sessionId)).toEqual([]);
    expect(await inspect.listExamAnswers(namespace, otherSessionId)).toHaveLength(1);
    expect(await inspect.listExamEvents(namespace, otherSessionId)).toHaveLength(1);
    expect(await inspect.getDraft(namespace, draftKey)).toEqual(draft);
    inspect.close();
    const emergencyValues = Object.keys(window.localStorage)
      .map((key) => window.localStorage.getItem(key))
      .filter((value): value is string => value !== null)
      .map((value) => JSON.parse(value) as ExamEventOutboxRecord);
    expect(emergencyValues.some((record) => record.clientEventId === thisEmergency.clientEventId)).toBe(false);
    expect(emergencyValues.some((record) => record.clientEventId === otherEmergency.clientEventId)).toBe(true);
    expect(calls.filter((url) => url.includes("/autosave") || url.includes("/events"))).toEqual([]);
  });

  it("rejects a complete foreign GET before opening recovery or using foreign endpoints", async () => {
    const factory = new FakeIDBFactory();
    const open = vi.spyOn(factory, "open");
    vi.stubGlobal("indexedDB", factory);
    const foreignSessionId = "10000000-0000-4000-8000-000000000099";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return json({ exam: activeExam({ sessionId: foreignSessionId }) });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    expect(await screen.findByRole("heading", { name: "Exam unavailable" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Your response")).not.toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([`/api/exams/${sessionId}`]);
  });

  it.each([
    [401, "empty", () => new Response(null, { status: 401 })],
    [403, "non-JSON", () => new Response("<html>Forbidden</html>", {
      status: 403,
      headers: { "content-type": "text/html" },
    })],
  ] as const)(
    "purges only the captured namespace after an initial %i authenticated exam denial with an %s body",
    async (_status, _bodyKind, denialResponse) => {
      const factory = new FakeIDBFactory();
      vi.stubGlobal("indexedDB", factory);
      const seed = await openBrowserOutbox(factory);
      await seed.putExamAnswer(answerRecord());
      seed.close();
      const warmKey = `learncoding:draft-cache:v1:${namespace}:code:python:loops:language-python`;
      window.sessionStorage.setItem(warmKey, "private lesson draft");
      vi.stubGlobal("fetch", vi.fn(async () => denialResponse()));
      const navigate = vi.fn();

      renderWithNamespace(<TimedExamClient navigate={navigate} sessionId={sessionId} />);

      expect(await screen.findByText(/Redirecting to sign in/i)).toBeInTheDocument();
      const inspect = await openBrowserOutbox(factory);
      expect(await inspect.listExamAnswers(namespace, sessionId)).toEqual([]);
      inspect.close();
      expect(window.sessionStorage.getItem(warmKey)).toBeNull();
      expect(navigate).toHaveBeenCalledWith("/login");
    },
  );

  it("publishes and attempts browser cleanup when initial denial cannot open IndexedDB", async () => {
    vi.stubGlobal("indexedDB", {
      open: vi.fn(() => { throw new Error("IndexedDB open failed"); }),
    } as unknown as IDBFactory);
    const warmKey = `learncoding:draft-cache:v1:${namespace}:code:python:loops:language-python`;
    window.sessionStorage.setItem(warmKey, "private lesson draft");
    const emergency = eventRecord();
    writeEmergencyExamEvent(window.localStorage, emergency);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    const navigate = vi.fn();

    renderWithNamespace(<TimedExamClient navigate={navigate} sessionId={sessionId} />);

    expect(await screen.findByText(/Redirecting to sign in/i)).toBeInTheDocument();
    expect(navigate).toHaveBeenCalledWith("/login");
    expect(window.sessionStorage.getItem(warmKey)).toBeNull();
    expect(window.localStorage.getItem(
      `${EMERGENCY_EXAM_EVENT_PREFIX}${encodeURIComponent(namespace)}:${encodeURIComponent(sessionId)}:${encodeURIComponent(emergency.clientEventId)}`,
    )).toBeNull();
    expect(Object.keys(window.localStorage).some((key) => (
      key.startsWith("codestead:browser-recovery-boundary:v1:")
    ))).toBe(true);
  });

  it("treats a malformed final-submit 401 as the same exact auth boundary", async () => {
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const navigate = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) return json({ exam: activeExam() });
      if (url.endsWith("/submit")) return new Response(null, { status: 401 });
      throw new Error(`Unexpected request: ${url}`);
    }));

    renderWithNamespace(<TimedExamClient navigate={navigate} sessionId={sessionId} />);
    await screen.findByLabelText("Your response");
    fireEvent.click(screen.getByRole("button", { name: "Save & next" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit final" }));

    expect(await screen.findByText(/Redirecting to sign in/i)).toBeInTheDocument();
    expect(navigate).toHaveBeenCalledWith("/login");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("treats a non-JSON runner 403 as the same exact auth boundary", async () => {
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    const navigate = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) return json({ exam: activeExam() });
      if (url.endsWith("/run")) {
        return new Response("<html>Forbidden</html>", { status: 403 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();

    renderWithNamespace(<TimedExamClient navigate={navigate} sessionId={sessionId} />);
    await screen.findByLabelText("Your response");
    await user.click(screen.getByRole("button", { name: /Code challenge/i }));
    fireEvent.click(screen.getByRole("button", { name: "Compile" }));

    expect(await screen.findByText(/Redirecting to sign in/i)).toBeInTheDocument();
    expect(navigate).toHaveBeenCalledWith("/login");
  });

  it("treats an empty heartbeat 401 as the same exact auth boundary", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    const navigate = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) return json({ exam: activeExam() });
      if (url.endsWith("/heartbeat")) return new Response(null, { status: 401 });
      throw new Error(`Unexpected request: ${url}`);
    }));

    renderWithNamespace(<TimedExamClient navigate={navigate} sessionId={sessionId} />);
    await screen.findByLabelText("Your response");
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });

    expect(await screen.findByText(/Redirecting to sign in/i)).toBeInTheDocument();
    expect(navigate).toHaveBeenCalledWith("/login");
  });

  it.each([
    ["empty items", (exam: ExamSessionView) => ({
      ...exam,
      form: { ...exam.form, items: [] },
    })],
    ["duplicate item IDs", (exam: ExamSessionView) => ({
      ...exam,
      form: { ...exam.form, items: [exam.form.items[0], { ...exam.form.items[1], id: exam.form.items[0]!.id }] },
    })],
    ["empty item ID", (exam: ExamSessionView) => ({
      ...exam,
      form: { ...exam.form, items: [{ ...exam.form.items[0], id: "" }, exam.form.items[1]] },
    })],
    ["missing code language", (exam: ExamSessionView) => {
      const codeItem: { language?: string } & Record<string, unknown> = {
        ...exam.form.items[1]!,
      };
      delete codeItem.language;
      return { ...exam, form: { ...exam.form, items: [exam.form.items[0], codeItem] } };
    }],
    ["unsupported code language", (exam: ExamSessionView) => ({
      ...exam,
      form: { ...exam.form, items: [exam.form.items[0], { ...exam.form.items[1], language: "ruby" }] },
    })],
  ])("rejects an active GET with %s before rendering editable controls", async (_label, mutate) => {
    const factory = new FakeIDBFactory();
    const open = vi.spyOn(factory, "open");
    vi.stubGlobal("indexedDB", factory);
    const fetchMock = vi.fn(async () => json({ exam: mutate(activeExam()) }));
    vi.stubGlobal("fetch", fetchMock);

    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    expect(await screen.findByRole("heading", { name: "Exam unavailable" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Your response")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Source code")).not.toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not purge recovery for a partial terminal submit response", async () => {
    const factory = new FakeIDBFactory();
    vi.stubGlobal("indexedDB", factory);
    const seed = await openBrowserOutbox(factory);
    const retainedEvent = eventRecord();
    await seed.putExamEvent(retainedEvent);
    seed.close();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === `/api/exams/${sessionId}`) return json({ exam: activeExam() });
      if (url.endsWith("/events")) {
        return new Response("{not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/submit")) return json({ exam: { sessionId, status: "graded" } });
      throw new Error(`Unexpected request: ${url}`);
    }));

    const rendered = renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    await screen.findByLabelText("Your response");
    await waitFor(() => expect(calls.some((url) => url.endsWith("/events"))).toBe(true));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save & next" }));
    await user.click(screen.getByRole("button", { name: "Submit final" }));
    expect(await screen.findByText("Finalization is still pending.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "mastered" })).not.toBeInTheDocument();
    rendered.unmount();

    const inspect = await openBrowserOutbox(factory);
    expect(await inspect.listExamEvents(namespace, sessionId)).toEqual([retainedEvent]);
    inspect.close();
  });

  it("fails closed for an active exam without the opaque cache namespace", async () => {
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return json({ exam: activeExam() });
    }));
    render(<TimedExamClient sessionId={sessionId} />);
    expect(await screen.findByRole("heading", { name: /Exam recovery unavailable/i })).toBeInTheDocument();
    expect(screen.queryByLabelText("Your response")).not.toBeInTheDocument();
    expect(calls).toEqual([`/api/exams/${sessionId}`]);
  });

  it("keeps active controls gated and retries failed closed-book draft cleanup", async () => {
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    const warmKey = `learncoding:draft-cache:v1:${namespace}:code:python:loops:language-python`;
    window.sessionStorage.setItem(warmKey, "private lesson draft");
    const originalRemoveItem = Storage.prototype.removeItem;
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    removeItem.mockImplementationOnce(function (this: Storage) {
      throw new Error("private storage detail");
    });
    removeItem.mockImplementation(function (this: Storage, key: string) {
      return originalRemoveItem.call(this, key);
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) return json({ exam: activeExam() });
      if (url.endsWith("/events")) return json({ accepted: true, duplicate: false });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();

    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);

    expect(await screen.findByRole("heading", { name: /Exam recovery unavailable/i }))
      .toBeInTheDocument();
    expect(screen.queryByLabelText("Your response")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("private storage detail");
    await user.click(screen.getByRole("button", { name: /Retry browser storage cleanup/i }));

    expect(await screen.findByLabelText("Your response")).toBeInTheDocument();
    expect(window.sessionStorage.getItem(warmKey)).toBeNull();
  });

  it("retries repository acquisition before exposing an active exam", async () => {
    vi.stubGlobal("indexedDB", {
      open: vi.fn(() => { throw new Error("IndexedDB open failed"); }),
    } as unknown as IDBFactory);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) return json({ exam: activeExam() });
      if (url.endsWith("/events")) return json({ accepted: true, duplicate: false });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();

    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);

    expect(await screen.findByRole("heading", { name: /Exam recovery unavailable/i }))
      .toBeInTheDocument();
    expect(screen.queryByLabelText("Your response")).not.toBeInTheDocument();
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    await user.click(screen.getByRole("button", { name: /Retry browser storage cleanup/i }));

    expect(await screen.findByLabelText("Your response")).toBeInTheDocument();
  });

  it("retries repository acquisition before exposing a terminal exam result", async () => {
    vi.stubGlobal("indexedDB", {
      open: vi.fn(() => { throw new Error("IndexedDB open failed"); }),
    } as unknown as IDBFactory);
    vi.stubGlobal("fetch", vi.fn(async () => json({ exam: gradedExam() })));
    const user = userEvent.setup();

    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);

    expect(await screen.findByRole("heading", { name: /Exam recovery unavailable/i }))
      .toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "mastered" })).not.toBeInTheDocument();
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    await user.click(screen.getByRole("button", { name: /Retry browser storage cleanup/i }));

    expect(await screen.findByRole("heading", { name: "mastered" })).toBeInTheDocument();
  });

  it("auto-finalizes at the server deadline and explains an offline failure", async () => {
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    const expired = activeExam({ serverDeadlineAt: new Date(Date.now() - 1_000).toISOString() });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) return json({ exam: expired });
      if (url.endsWith("/submit")) return json({ error: "offline" }, { status: 503 });
      if (url.endsWith("/events")) return json({ accepted: true, duplicate: false });
      throw new Error(`Unexpected request: ${url}`);
    }));

    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    expect(await screen.findByText("00:00")).toBeInTheDocument();
    expect(await screen.findByText(/server deadline still applies/i, {}, { timeout: 2_000 })).toBeInTheDocument();
  });

  it("retries deadline finalization after a pending manual flush loses the deadline race", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const now = new Date("2026-07-15T10:00:00.000Z");
    vi.setSystemTime(now);
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const autosave = deferred<Response>();
    let autosaveCalls = 0;
    let submitCalls = 0;
    const expiring = activeExam({
      serverNow: now.toISOString(),
      serverDeadlineAt: new Date(now.getTime() + 1_000).toISOString(),
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) return Promise.resolve(json({ exam: expiring }));
      if (url.endsWith("/events")) return Promise.resolve(json({ accepted: true, duplicate: false }));
      if (url.endsWith("/autosave")) {
        autosaveCalls += 1;
        return autosave.promise;
      }
      if (url.endsWith("/submit")) {
        submitCalls += 1;
        return new Promise<Response>(() => undefined);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    renderWithNamespace(<TimedExamClient sessionId={sessionId} />);
    fireEvent.change(await screen.findByLabelText("Your response"), {
      target: { value: "manual flush still pending" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save & next" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit final" }));
    await waitFor(() => expect(autosaveCalls).toBe(1));

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await act(async () => {
      autosave.resolve(json({ error: "deadline" }, { status: 503 }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(submitCalls).toBe(0);

    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(submitCalls).toBe(1);
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

  it("treats a malformed appeal 403 as the same exact auth boundary", async () => {
    vi.stubGlobal("indexedDB", new FakeIDBFactory());
    const navigate = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/exams/${sessionId}`) return json({ exam: gradedExam() });
      if (url.endsWith("/appeal") && init?.method === "POST") {
        return new Response("<html>Forbidden</html>", { status: 403 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const user = userEvent.setup();

    renderWithNamespace(<TimedExamClient navigate={navigate} sessionId={sessionId} />);
    expect(await screen.findByRole("heading", { name: "mastered" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Request a review" }));
    await user.type(
      screen.getByLabelText("What should the reviewer inspect?"),
      "Please inspect the authenticated session boundary.",
    );
    await user.click(screen.getByRole("button", { name: "Submit appeal" }));

    expect(await screen.findByText(/Redirecting to sign in/i)).toBeInTheDocument();
    expect(navigate).toHaveBeenCalledWith("/login");
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
