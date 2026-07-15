import { act, renderHook, waitFor } from "@testing-library/react";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  openBrowserOutbox,
  type BrowserOutboxRepository,
} from "@/lib/browser-durability/indexed-db";
import {
  examAnswerOutboxStorageKey,
  examEventOutboxStorageKey,
  type ExamAnswerOutboxRecord,
  type ExamEventOutboxRecord,
} from "@/lib/browser-durability/types";
import type { ExamSessionView } from "@/lib/exams/contracts";

import { useDurableExamOutbox } from "../use-durable-exam-outbox";

const namespace = "learner-session-browser-outbox";
const sessionId = "10000000-0000-4000-8000-000000000001";
const firstMutationId = "30000000-0000-4000-8000-000000000001";
const eventId = "40000000-0000-4000-8000-000000000001";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function activeSession(overrides: Partial<ExamSessionView> = {}): ExamSessionView {
  const now = new Date();
  return {
    sessionId,
    attemptId: "20000000-0000-4000-8000-000000000001",
    attemptNumber: 1,
    status: "active",
    serverNow: now.toISOString(),
    serverStartedAt: now.toISOString(),
    serverDeadlineAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
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
      durationMinutes: 60,
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
          title: "Explain",
          prompt: "Explain the loop.",
          kind: "short-answer",
          points: 4,
          critical: true,
          verificationAvailable: true,
        },
        {
          id: "code-1",
          skillId: "python.loops.code",
          clusterId: "loops",
          title: "Code",
          prompt: "Write the loop.",
          kind: "code",
          language: "python",
          starterCode: "print('starter')",
          points: 6,
          critical: true,
          verificationAvailable: true,
        },
      ],
    },
    answers: {
      "written-1": {
        revision: 2,
        answer: { text: "server answer" },
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

function answerRecord(input: {
  itemId?: string;
  answer?: string;
  baseRevision?: number;
  clientMutationId?: string;
  recordSessionId?: string;
} = {}): ExamAnswerOutboxRecord {
  const itemId = input.itemId ?? "written-1";
  const scope = input.recordSessionId ?? sessionId;
  return {
    schemaVersion: 1,
    storageKey: examAnswerOutboxStorageKey(namespace, scope, itemId),
    namespace,
    kind: "exam-answer",
    scope,
    clientMutationId: input.clientMutationId ?? firstMutationId,
    updatedAt: new Date().toISOString(),
    payload: {
      itemId,
      answer: input.answer ?? "recovered answer",
      baseRevision: input.baseRevision ?? 2,
    },
  };
}

function eventRecord(input: {
  clientEventId?: string;
  recordSessionId?: string;
} = {}): ExamEventOutboxRecord {
  const scope = input.recordSessionId ?? sessionId;
  const clientEventId = input.clientEventId ?? eventId;
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
      eventType: "window_blur",
      occurredAt: now,
      metadata: { target: "window" },
    },
  };
}

type RepositoryHarness = {
  repository: BrowserOutboxRepository;
  answers: Map<string, ExamAnswerOutboxRecord>;
  events: Map<string, ExamEventOutboxRecord>;
  putAnswers: ExamAnswerOutboxRecord[];
  putEvents: ExamEventOutboxRecord[];
  deletedEvents: string[];
  cleared: Array<[string, string]>;
};

function repositoryHarness(overrides: Partial<BrowserOutboxRepository> = {}): RepositoryHarness {
  const answers = new Map<string, ExamAnswerOutboxRecord>();
  const events = new Map<string, ExamEventOutboxRecord>();
  const putAnswers: ExamAnswerOutboxRecord[] = [];
  const putEvents: ExamEventOutboxRecord[] = [];
  const deletedEvents: string[] = [];
  const cleared: Array<[string, string]> = [];
  const repository: BrowserOutboxRepository = {
    async getDraft() { return null; },
    async putDraft() {},
    async deleteDraftIfMutation() { return false; },
    async listExamAnswers(recordNamespace, recordSessionId) {
      return [...answers.values()].filter((record) =>
        record.namespace === recordNamespace && record.scope === recordSessionId
      );
    },
    async putExamAnswer(record) {
      putAnswers.push(record);
      answers.set(record.storageKey, record);
    },
    async deleteExamAnswerIfMutation(recordNamespace, recordSessionId, itemId, mutationId) {
      const key = examAnswerOutboxStorageKey(recordNamespace, recordSessionId, itemId);
      const current = answers.get(key);
      if (!current || current.clientMutationId !== mutationId) return false;
      answers.delete(key);
      return true;
    },
    async listExamEvents(recordNamespace, recordSessionId) {
      return [...events.values()].filter((record) =>
        record.namespace === recordNamespace && record.scope === recordSessionId
      );
    },
    async putExamEvent(record) {
      putEvents.push(record);
      events.set(record.storageKey, record);
    },
    async deleteExamEvent(recordNamespace, recordSessionId, clientEventId) {
      deletedEvents.push(clientEventId);
      events.delete(examEventOutboxStorageKey(recordNamespace, recordSessionId, clientEventId));
    },
    async clearExamSession(recordNamespace, recordSessionId) {
      cleared.push([recordNamespace, recordSessionId]);
      for (const [key, record] of answers) {
        if (record.namespace === recordNamespace && record.scope === recordSessionId) answers.delete(key);
      }
      for (const [key, record] of events) {
        if (record.namespace === recordNamespace && record.scope === recordSessionId) events.delete(key);
      }
    },
    async clearNamespace() {},
    async clearForeignNamespaces() {},
    async clearAll() {},
    close() {},
    ...overrides,
  };
  return { repository, answers, events, putAnswers, putEvents, deletedEvents, cleared };
}

function autosaveAcknowledgement(body: Record<string, unknown>, replayed = false) {
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

async function waitForHydration(result: { current: { hydrated: boolean } }) {
  await waitFor(() => expect(result.current.hydrated).toBe(true));
}

describe("useDurableExamOutbox", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("does not start autosave until the answer transaction completes", async () => {
    const put = deferred<void>();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const harness = repositoryHarness({ putExamAnswer: () => put.promise });
    const { result } = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: harness.repository,
    }));
    await waitForHydration(result);

    let update!: Promise<void>;
    act(() => { update = result.current.updateAnswer("written-1", "local answer"); });
    expect(result.current.answers["written-1"]).toBe("local answer");
    expect(result.current.saveState).toBe("saving-local");
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => { put.resolve(undefined); await update; });
    expect(result.current.saveState).toBe("saved-local");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a committed record on unmount and reopens with its original UUID and body", async () => {
    const factory = new FakeIDBFactory();
    const firstRepository = await openBrowserOutbox(factory);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return autosaveAcknowledgement(body, true);
    });
    vi.stubGlobal("fetch", fetchMock);
    const first = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: firstRepository,
    }));
    await waitForHydration(first.result);
    await act(() => first.result.current.updateAnswer("written-1", "survives reopen"));
    const persisted = await firstRepository.listExamAnswers(namespace, sessionId);
    expect(persisted).toHaveLength(1);
    first.unmount();
    firstRepository.close();
    expect(fetchMock).not.toHaveBeenCalled();

    const secondRepository = await openBrowserOutbox(factory);
    const second = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: secondRepository,
    }));
    await waitForHydration(second.result);
    expect(second.result.current.answers["written-1"]).toBe("survives reopen");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(sent).toEqual({
      clientMutationId: persisted[0]?.clientMutationId,
      itemId: "written-1",
      baseRevision: 2,
      answer: { text: "survives reopen" },
    });
    await waitFor(async () => expect(await secondRepository.listExamAnswers(namespace, sessionId)).toEqual([]));
    second.unmount();
    secondRepository.close();
  });

  it("retries response loss with a byte-equivalent body and compare-deletes the replay", async () => {
    vi.useFakeTimers();
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) throw new TypeError("response lost");
      return autosaveAcknowledgement(JSON.parse(bodies[0]!) as Record<string, unknown>, true);
    });
    vi.stubGlobal("fetch", fetchMock);
    const harness = repositoryHarness();
    const { result } = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: harness.repository,
    }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.hydrated).toBe(true);
    await act(() => result.current.updateAnswer("written-1", "ambiguous answer"));

    let flushError: unknown;
    await act(async () => {
      try {
        await result.current.flush();
      } catch (error) {
        flushError = error;
      }
    });
    expect(flushError).toBeInstanceOf(Error);
    expect(bodies).toHaveLength(1);
    expect(result.current.saveState).toBe("offline-saved-local");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(harness.answers.size).toBe(0);
    expect(result.current.saveState).toBe("server-saved");
  });

  it("treats a malformed successful acknowledgement as a hard protocol issue without retry", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("{not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const harness = repositoryHarness();
    const { result } = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: harness.repository,
    }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(() => result.current.updateAnswer("written-1", "preserve malformed ack"));

    let flushError: unknown;
    await act(async () => {
      try {
        await result.current.flush();
      } catch (error) {
        flushError = error;
      }
    });
    expect(flushError).toBeInstanceOf(Error);
    expect(result.current.issue?.kind).toBe("protocol");
    expect(result.current.saveState).toBe("saved-local");
    expect(harness.answers.size).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.current.saveState).not.toBe("server-saved");
  });

  it("keeps a hard answer issue prominent when an independent event write fails", async () => {
    const fetchMock = vi.fn(async () => new Response("{not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const harness = repositoryHarness({
      async putExamEvent() {
        throw new Error("event transaction aborted");
      },
    });
    const { result } = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: harness.repository,
    }));
    await waitForHydration(result);
    await act(() => result.current.updateAnswer("written-1", "answer needing attention"));
    await act(async () => {
      await result.current.flush().catch(() => undefined);
    });
    expect(result.current.issue).toMatchObject({ kind: "protocol", itemId: "written-1" });

    await act(async () => {
      await result.current.recordEvent("window_blur", {}).catch(() => undefined);
    });
    expect(result.current.issue).toMatchObject({ kind: "protocol", itemId: "written-1" });
  });

  it("clears only a superseded answer issue while preserving an independent event issue", async () => {
    let answerRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      answerRequests += 1;
      if (answerRequests === 1) {
        return new Response("{not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return autosaveAcknowledgement(JSON.parse(String(init?.body)) as Record<string, unknown>);
    }));
    const harness = repositoryHarness({
      async putExamEvent() {
        throw new Error("event transaction aborted");
      },
    });
    const { result } = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: harness.repository,
    }));
    await waitForHydration(result);
    await act(async () => {
      await result.current.recordEvent("window_blur", {}).catch(() => undefined);
    });
    expect(result.current.issue?.kind).toBe("event-recovery");

    await act(() => result.current.updateAnswer("written-1", "first answer"));
    await act(async () => {
      await result.current.flush().catch(() => undefined);
    });
    expect(result.current.issue).toMatchObject({ kind: "protocol", itemId: "written-1" });

    await act(() => result.current.updateAnswer("written-1", "replacement answer"));
    await act(() => result.current.flush());
    expect(result.current.saveState).toBe("server-saved");
    expect(result.current.issue?.kind).toBe("event-recovery");
  });

  it("preserves and rebases B when A is acknowledged after B commits", async () => {
    const firstResponse = deferred<Response>();
    const sent: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      if (sent.length === 1) return firstResponse.promise;
      return autosaveAcknowledgement(body);
    });
    vi.stubGlobal("fetch", fetchMock);
    const harness = repositoryHarness();
    const { result } = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: harness.repository,
    }));
    await waitForHydration(result);
    await act(() => result.current.updateAnswer("written-1", "A"));
    let flush!: Promise<void>;
    act(() => { flush = result.current.flush(); });
    await waitFor(() => expect(sent).toHaveLength(1));
    await act(() => result.current.updateAnswer("written-1", "B"));
    const bBeforeAck = [...harness.answers.values()][0]!;
    expect(bBeforeAck.payload.baseRevision).toBe(2);
    expect(sent).toHaveLength(1);

    await act(async () => {
      firstResponse.resolve(autosaveAcknowledgement(sent[0]!));
      await flush;
    });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      clientMutationId: bBeforeAck.clientMutationId,
      baseRevision: 3,
      answer: { text: "B" },
    });
    expect(harness.putAnswers.at(-1)).toMatchObject({
      clientMutationId: bBeforeAck.clientMutationId,
      payload: { answer: "B", baseRevision: 3 },
    });
    expect(harness.answers.size).toBe(0);
  });

  it("reports lost local durability without blind replay when compare-delete is false and reread is null", async () => {
    vi.useFakeTimers();
    let missingAfterCompare = false;
    const harness = repositoryHarness({
      async deleteExamAnswerIfMutation() {
        missingAfterCompare = true;
        harness.answers.clear();
        return false;
      },
      async listExamAnswers(recordNamespace, recordSessionId) {
        if (missingAfterCompare) return [];
        return [...harness.answers.values()].filter((record) =>
          record.namespace === recordNamespace && record.scope === recordSessionId
        );
      },
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      autosaveAcknowledgement(JSON.parse(String(init?.body)) as Record<string, unknown>));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: harness.repository,
    }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(() => result.current.updateAnswer("written-1", "no longer durable"));
    let flushError: unknown;
    await act(async () => {
      try {
        await result.current.flush();
      } catch (error) {
        flushError = error;
      }
    });
    expect(flushError).toBeInstanceOf(Error);
    expect(result.current.saveState).toBe("local-save-error");
    expect(result.current.issue?.kind).toBe("protocol");
    expect(harness.answers.size).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retries compare-delete reread rejection as distinct storage ambiguity", async () => {
    vi.useFakeTimers();
    let rejectReread = false;
    const harness = repositoryHarness({
      async deleteExamAnswerIfMutation() {
        rejectReread = true;
        return false;
      },
      async listExamAnswers() {
        if (rejectReread) throw new Error("reread transaction aborted");
        return [];
      },
    });
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return autosaveAcknowledgement(JSON.parse(bodies.at(-1)!) as Record<string, unknown>, bodies.length > 1);
    }));
    const { result } = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: harness.repository,
    }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(() => result.current.updateAnswer("written-1", "reread ambiguity"));
    let flushError: unknown;
    await act(async () => {
      try {
        await result.current.flush();
      } catch (error) {
        flushError = error;
      }
    });
    expect(flushError).toBeInstanceOf(Error);
    expect(result.current.saveState).toBe("offline-saved-local");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it("exposes a validated conflict and keeps the recovered value under a new persisted identity", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      if (sent.length === 1) {
        return json({
          code: "AUTOSAVE_REVISION_CONFLICT",
          currentRevision: 7,
          currentAnswer: { text: "server winner" },
          currentSavedAt: new Date().toISOString(),
        }, { status: 409 });
      }
      return autosaveAcknowledgement(body);
    });
    vi.stubGlobal("fetch", fetchMock);
    const harness = repositoryHarness();
    const { result } = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: harness.repository,
    }));
    await waitForHydration(result);
    await act(() => result.current.updateAnswer("written-1", "recovered winner"));
    let flushError: unknown;
    await act(async () => {
      try {
        await result.current.flush();
      } catch (error) {
        flushError = error;
      }
    });
    expect(flushError).toBeInstanceOf(Error);
    const conflict = result.current.conflicts["written-1"]!;
    expect(result.current.saveState).toBe("conflict");
    expect(conflict).toMatchObject({
      localAnswer: "recovered winner",
      serverAnswer: "server winner",
      serverRevision: 7,
    });

    await act(() => result.current.resolveConflict("written-1", "keep-local"));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ baseRevision: 7, answer: { text: "recovered winner" } });
    expect(sent[1]?.clientMutationId).not.toBe(conflict.clientMutationId);
    expect(harness.putAnswers.at(-1)?.clientMutationId).toBe(sent[1]?.clientMutationId);
    await waitFor(() => expect(result.current.saveState).toBe("server-saved"));
  });

  it("uses conditional cleanup before applying the server conflict value", async () => {
    const fetchMock = vi.fn(async () => json({
      code: "AUTOSAVE_REVISION_CONFLICT",
      currentRevision: 9,
      currentAnswer: { text: "server selected" },
      currentSavedAt: null,
    }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const harness = repositoryHarness();
    const { result } = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: harness.repository,
    }));
    await waitForHydration(result);
    await act(() => result.current.updateAnswer("written-1", "local selected"));
    await expect(act(() => result.current.flush())).rejects.toThrow();
    await act(() => result.current.resolveConflict("written-1", "use-server"));
    expect(result.current.answers["written-1"]).toBe("server selected");
    expect(result.current.conflicts["written-1"]).toBeUndefined();
    expect(result.current.saveState).toBe("server-saved");
  });

  it.each(["keep-local", "use-server"] as const)(
    "admits only the first %s conflict action while its storage transaction is pending",
    async (firstChoice) => {
      const gate = deferred<void>();
      const operationStarted = deferred<void>();
      let deferConflictOperations = false;
      const conflictState: { mutationId?: string } = {};
      let postConflictReads = 0;
      let postConflictDeletes = 0;
      const harness = repositoryHarness();
      const repository = {
        ...harness.repository,
        async listExamAnswers(recordNamespace: string, recordSessionId: string) {
          if (deferConflictOperations) {
            postConflictReads += 1;
            if (firstChoice === "keep-local" && postConflictReads === 1) {
              operationStarted.resolve(undefined);
              await gate.promise;
            }
          }
          return harness.repository.listExamAnswers(recordNamespace, recordSessionId);
        },
        async deleteExamAnswerIfMutation(
          recordNamespace: string,
          recordSessionId: string,
          itemId: string,
          mutationId: string,
        ) {
          if (deferConflictOperations && mutationId === conflictState.mutationId) {
            postConflictDeletes += 1;
            if (firstChoice === "use-server" && postConflictDeletes === 1) {
              operationStarted.resolve(undefined);
              await gate.promise;
            }
          }
          return harness.repository.deleteExamAnswerIfMutation(
            recordNamespace,
            recordSessionId,
            itemId,
            mutationId,
          );
        },
      } satisfies BrowserOutboxRepository;
      const sent: Array<Record<string, unknown>> = [];
      vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sent.push(body);
        if (sent.length === 1) {
          return json({
            code: "AUTOSAVE_REVISION_CONFLICT",
            currentRevision: 7,
            currentAnswer: { text: "server choice" },
            currentSavedAt: new Date().toISOString(),
          }, { status: 409 });
        }
        return autosaveAcknowledgement(body);
      }));
      const { result } = renderHook(() => useDurableExamOutbox({
        namespace,
        session: activeSession(),
        repository,
      }));
      await waitForHydration(result);
      await act(() => result.current.updateAnswer("written-1", "local choice"));
      await act(async () => { await result.current.flush().catch(() => undefined); });
      conflictState.mutationId = result.current.conflicts["written-1"]?.clientMutationId;
      deferConflictOperations = true;

      let firstSettled!: Promise<void>;
      let firstError: unknown;
      act(() => {
        firstSettled = result.current.resolveConflict("written-1", firstChoice)
          .catch((error: unknown) => { firstError = error; });
      });
      await act(async () => { await operationStarted.promise; });
      const resolving = result.current as typeof result.current & {
        resolvingConflicts?: Readonly<Record<string, boolean>>;
      };
      expect(resolving.resolvingConflicts?.["written-1"]).toBe(true);

      const opposite = firstChoice === "keep-local" ? "use-server" : "keep-local";
      let secondError: unknown;
      await act(async () => {
        await result.current.resolveConflict("written-1", opposite).catch((error: unknown) => {
          secondError = error;
        });
      });
      await act(async () => {
        gate.resolve(undefined);
        await firstSettled;
      });

      expect(firstError).toBeUndefined();
      expect(secondError).toBeInstanceOf(Error);
      expect(result.current.conflicts["written-1"]).toBeUndefined();
      if (firstChoice === "keep-local") {
        expect(postConflictDeletes).toBe(0);
        expect(result.current.answers["written-1"]).toBe("local choice");
        expect(sent).toHaveLength(2);
      } else {
        expect(postConflictReads).toBe(0);
        expect(result.current.answers["written-1"]).toBe("server choice");
        expect(sent).toHaveLength(1);
      }
    },
  );

  it.each([401, 403, 404])(
    "gives a %i answer authority boundary precedence over a conflict-shaped body",
    async (status) => {
      vi.stubGlobal("fetch", vi.fn(async () => json({
        code: "AUTOSAVE_REVISION_CONFLICT",
        currentRevision: 9,
        currentAnswer: { text: "must not be exposed" },
        currentSavedAt: new Date().toISOString(),
      }, { status })));
      const harness = repositoryHarness();
      const { result } = renderHook(() => useDurableExamOutbox({
        namespace,
        session: activeSession(),
        repository: harness.repository,
      }));
      await waitForHydration(result);
      await act(() => result.current.updateAnswer("written-1", "preserve local authority"));
      let flushError: unknown;
      await act(async () => {
        try {
          await result.current.flush();
        } catch (error) {
          flushError = error;
        }
      });
      expect(flushError).toBeInstanceOf(Error);
      expect(result.current.conflicts).toEqual({});
      expect(result.current.issue?.kind).toBe("server-rejected");
      expect(harness.answers.size).toBe(1);
      await expect(result.current.updateAnswer("written-1", "fenced")).rejects.toThrow();
      await expect(result.current.recordEvent("window_focus", {})).rejects.toThrow();
      await expect(result.current.flush()).rejects.toThrow();
    },
  );

  it("reloads and preserves a newer durable edit when stale conflict cleanup loses", async () => {
    const fetchMock = vi.fn(async () => json({
      code: "AUTOSAVE_REVISION_CONFLICT",
      currentRevision: 9,
      currentAnswer: { text: "server selected" },
      currentSavedAt: null,
    }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const newer = answerRecord({
      answer: "newer durable edit",
      baseRevision: 2,
      clientMutationId: "30000000-0000-4000-8000-000000000003",
    });
    const harness = repositoryHarness({
      async deleteExamAnswerIfMutation() {
        harness.answers.set(newer.storageKey, newer);
        return false;
      },
    });
    const { result } = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: harness.repository,
    }));
    await waitForHydration(result);
    await act(() => result.current.updateAnswer("written-1", "stale conflict edit"));
    await expect(act(() => result.current.flush())).rejects.toThrow();

    let resolutionError: unknown;
    await act(async () => {
      try {
        await result.current.resolveConflict("written-1", "use-server");
      } catch (error) {
        resolutionError = error;
      }
    });
    expect(resolutionError).toBeInstanceOf(Error);
    expect(result.current.answers["written-1"]).toBe("newer durable edit");
    expect(result.current.conflicts["written-1"]).toMatchObject({
      clientMutationId: newer.clientMutationId,
      localAnswer: "newer durable edit",
      serverAnswer: "server selected",
    });
    expect([...harness.answers.values()]).toEqual([newer]);
  });

  it("removes a stale conflict durability claim when conditional cleanup rereads null", async () => {
    vi.useFakeTimers();
    const harness = repositoryHarness({
      async deleteExamAnswerIfMutation() {
        harness.answers.clear();
        return false;
      },
    });
    const fetchMock = vi.fn(async () => json({
      code: "AUTOSAVE_REVISION_CONFLICT",
      currentRevision: 9,
      currentAnswer: { text: "server selected" },
      currentSavedAt: null,
    }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: harness.repository,
    }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(() => result.current.updateAnswer("written-1", "lost conflict record"));
    await expect(act(() => result.current.flush())).rejects.toThrow();
    let resolutionError: unknown;
    await act(async () => {
      try {
        await result.current.resolveConflict("written-1", "use-server");
      } catch (error) {
        resolutionError = error;
      }
    });
    expect(resolutionError).toBeInstanceOf(Error);
    expect(result.current.conflicts).toEqual({});
    expect(result.current.saveState).toBe("local-save-error");
    expect(result.current.issue?.kind).toBe("protocol");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fences every lane after a server-closure signal while retaining recovery", async () => {
    let eventAborted = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/events")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            eventAborted = true;
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      }
      if (url.endsWith("/autosave")) {
        return Promise.resolve(json({ code: "EXAM_NOT_ACTIVE" }, { status: 409 }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const harness = repositoryHarness();
    const { result } = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: harness.repository,
    }));
    await waitForHydration(result);
    await act(() => result.current.recordEvent("window_blur", { target: "window" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/events"))).toBe(true));
    await act(() => result.current.updateAnswer("written-1", "retain one"));
    await act(() => result.current.updateAnswer("code-1", "print('retain two')"));

    let flushError: unknown;
    await act(async () => {
      try {
        await result.current.flush();
      } catch (error) {
        flushError = error;
      }
    });
    expect(flushError).toBeInstanceOf(Error);
    await waitFor(() => expect(eventAborted).toBe(true));
    expect(result.current.issue?.kind).toBe("server-closure");
    expect(harness.answers.size).toBe(2);
    expect(harness.events.size).toBe(1);
    expect(harness.cleared).toEqual([]);
    const callCount = fetchMock.mock.calls.length;
    fireEventOnline();
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(callCount);
    await expect(result.current.updateAnswer("written-1", "must stay fenced")).rejects.toThrow();
    await expect(result.current.recordEvent("window_focus", {})).rejects.toThrow();
    await expect(result.current.flush()).rejects.toThrow();
  });

  it("maps code through the immutable language and refuses unknown or oversized records", async () => {
    const harness = repositoryHarness();
    harness.answers.set(answerRecord({ itemId: "code-1", answer: "print(42)", baseRevision: 0 }).storageKey,
      answerRecord({ itemId: "code-1", answer: "print(42)", baseRevision: 0 }));
    const unknownRecord = answerRecord({
      itemId: "unknown-1",
      answer: "untrusted",
      clientMutationId: "30000000-0000-4000-8000-000000000002",
    });
    harness.answers.set(unknownRecord.storageKey, unknownRecord);
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return autosaveAcknowledgement(body);
    }));
    const { result } = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: harness.repository,
    }));
    await waitForHydration(result);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      itemId: "code-1",
      answer: { sourceCode: "print(42)", language: "python" },
    });
    expect(result.current.issue?.kind).toBe("protocol");
    expect([...harness.answers.values()].some((record) => record.payload.itemId === "unknown-1")).toBe(true);

    await expect(act(() => result.current.updateAnswer("written-1", "x".repeat(32_001)))).rejects.toThrow();
    expect(harness.putAnswers.some((record) => record.payload.answer.length === 32_001)).toBe(false);
  });

  it("persists events before posting and retries response loss with the same event ID", async () => {
    const eventPut = deferred<void>();
    const posted: string[] = [];
    const base = repositoryHarness();
    const repository = {
      ...base.repository,
      async putExamEvent(record: ExamEventOutboxRecord) {
        await eventPut.promise;
        base.putEvents.push(record);
        base.events.set(record.storageKey, record);
      },
    } satisfies BrowserOutboxRepository;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith("/events")) throw new Error("unexpected request");
      posted.push(String(init?.body));
      if (posted.length === 1) throw new TypeError("response lost");
      return json({ accepted: true, duplicate: true });
    }));
    const { result } = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository,
    }));
    await waitForHydration(result);
    let record!: Promise<void>;
    act(() => { record = result.current.recordEvent("window_blur", { target: "window" }); });
    expect(posted).toHaveLength(0);
    await act(async () => { eventPut.resolve(undefined); await record; });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(JSON.parse(posted[0]!)).toEqual({
      clientEventId: base.putEvents[0]?.clientEventId,
      type: "window_blur",
      metadata: { target: "window" },
    });
    expect(JSON.parse(posted[0]!)).not.toHaveProperty("occurredAt");
    fireEventOnline();
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toBe(posted[0]);
    await waitFor(() => expect(base.deletedEvents).toEqual([base.putEvents[0]?.clientEventId]));
  });

  it("retries the identical event when acknowledged cleanup cannot commit", async () => {
    vi.useFakeTimers();
    const posted: string[] = [];
    const base = repositoryHarness();
    let deleteAttempts = 0;
    const repository = {
      ...base.repository,
      async deleteExamEvent(
        recordNamespace: string,
        recordSessionId: string,
        clientEventId: string,
      ) {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new Error("cleanup transaction aborted");
        await base.repository.deleteExamEvent(recordNamespace, recordSessionId, clientEventId);
      },
    } satisfies BrowserOutboxRepository;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      posted.push(String(init?.body));
      return json({ accepted: true, duplicate: deleteAttempts > 0 });
    }));
    const { result } = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository,
    }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => {
      await result.current.recordEvent("window_focus", { target: "window" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(posted).toHaveLength(1);
    expect(base.events.size).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(posted).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(posted).toHaveLength(2);
    expect(posted[1]).toBe(posted[0]);
    expect(base.events.size).toBe(0);
    expect(result.current.issue).toBeNull();
  });

  it.each([
    [401, { code: "AUTHENTICATION_REQUIRED" }],
    [403, { code: "FORBIDDEN" }],
    [404, { code: "EXAM_NOT_FOUND" }],
    [400, { code: "EXAM_NOT_FOUND" }],
  ])("fences the captured generation when an event response crosses a %i authority boundary", async (
    status,
    responseBody,
  ) => {
    const sent: string[] = [];
    const harness = repositoryHarness();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      sent.push(url);
      if (url.endsWith("/events")) return json(responseBody, { status });
      if (url.endsWith("/autosave")) {
        return autosaveAcknowledgement(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const { result } = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: harness.repository,
    }));
    await waitForHydration(result);
    await act(() => result.current.updateAnswer("written-1", "retain after authority boundary"));
    await act(() => result.current.recordEvent("window_blur", { target: "window" }));
    await waitFor(() => expect(result.current.issue).not.toBeNull());

    let flushError: unknown;
    await act(async () => {
      try {
        await result.current.flush();
      } catch (error) {
        flushError = error;
      }
    });
    expect(flushError).toBeInstanceOf(Error);
    expect(sent.filter((url) => url.endsWith("/autosave"))).toEqual([]);
    expect(harness.answers.size).toBe(1);
    expect(harness.events.size).toBe(1);
    expect(harness.deletedEvents).toEqual([]);
    expect(harness.cleared).toEqual([]);
    const callCount = sent.length;
    fireEventOnline();
    await act(async () => { await Promise.resolve(); });
    expect(sent).toHaveLength(callCount);
    await expect(result.current.updateAnswer("written-1", "still fenced")).rejects.toThrow();
    await expect(result.current.recordEvent("window_focus", {})).rejects.toThrow();
  });

  it("retains a malformed successful event acknowledgement without retry or deletion", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("{not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const harness = repositoryHarness();
    const { result } = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: harness.repository,
    }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => {
      await result.current.recordEvent("window_focus", { target: "window" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.issue?.kind).toBe("event-recovery");
    expect(harness.events.size).toBe(1);
    expect(harness.deletedEvents).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(harness.events.size).toBe(1);
  });

  it("does not let a retired deferred event body delete durable recovery", async () => {
    const body = deferred<unknown>();
    const bodyStarted = deferred<void>();
    const harness = repositoryHarness();
    const recoveredEvent = eventRecord();
    harness.events.set(recoveredEvent.storageKey, recoveredEvent);
    let requests = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      requests += 1;
      if (requests === 1) {
        return {
          ok: true,
          status: 200,
          json() {
            bodyStarted.resolve(undefined);
            return body.promise;
          },
        } as Response;
      }
      return json({ accepted: true, duplicate: true });
    }));

    const first = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: harness.repository,
    }));
    await waitForHydration(first.result);
    await act(async () => { await bodyStarted.promise; });
    first.unmount();
    await act(async () => {
      body.resolve({ accepted: true, duplicate: false });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(harness.deletedEvents).toEqual([]);
    expect([...harness.events.values()]).toEqual([recoveredEvent]);

    const second = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: harness.repository,
    }));
    await waitForHydration(second.result);
    await waitFor(() => expect(harness.deletedEvents).toEqual([recoveredEvent.clientEventId]));
  });

  it("uses 1/2/5/10/30 second answer retry boundaries without overlap", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => json({ error: "retry" }, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const harness = repositoryHarness();
    const { result } = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: harness.repository,
    }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(() => result.current.updateAnswer("written-1", "retry me"));
    await expect(act(() => result.current.flush())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const [before, boundary] of [[999, 1], [1_999, 2], [4_999, 3], [9_999, 4], [29_999, 5]] as const) {
      await act(async () => { await vi.advanceTimersByTimeAsync(before); });
      expect(fetchMock).toHaveBeenCalledTimes(boundary);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(fetchMock).toHaveBeenCalledTimes(boundary + 1);
    }
  });

  it("uses 1/2/5/10/30 second event retry boundaries without overlap", async () => {
    vi.useFakeTimers();
    let activeRequests = 0;
    let maximumActive = 0;
    const fetchMock = vi.fn(async () => {
      activeRequests += 1;
      maximumActive = Math.max(maximumActive, activeRequests);
      await Promise.resolve();
      activeRequests -= 1;
      return json({ error: "retry" }, { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const harness = repositoryHarness();
    const { result } = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: harness.repository,
    }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => {
      await result.current.recordEvent("window_focus", {});
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const [before, boundary] of [[999, 1], [1_999, 2], [4_999, 3], [9_999, 4], [29_999, 5]] as const) {
      await act(async () => { await vi.advanceTimersByTimeAsync(before); });
      expect(fetchMock).toHaveBeenCalledTimes(boundary);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(fetchMock).toHaveBeenCalledTimes(boundary + 1);
    }
    expect(maximumActive).toBe(1);
    expect(result.current.issue?.kind).toBe("event-recovery");
    expect(harness.events.size).toBe(1);
  });

  it("aborts an ambiguous request at 10 seconds and never overlaps the answer lane", async () => {
    vi.useFakeTimers();
    let activeRequests = 0;
    let maximumActive = 0;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      activeRequests += 1;
      maximumActive = Math.max(maximumActive, activeRequests);
      init?.signal?.addEventListener("abort", () => {
        activeRequests -= 1;
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const harness = repositoryHarness();
    const { result } = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: harness.repository,
    }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(() => result.current.updateAnswer("written-1", "timeout"));
    let flushError: unknown;
    let flush!: Promise<void>;
    act(() => {
      flush = result.current.flush().catch((error: unknown) => {
        flushError = error;
      });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await act(async () => { await flush; });
    expect(flushError).toBeInstanceOf(Error);
    expect(maximumActive).toBe(1);
    expect(harness.answers.size).toBe(1);
  });

  it("retries a stalled 2xx response body as stream ambiguity with the exact answer body", async () => {
    vi.useFakeTimers();
    const bodies: string[] = [];
    let activeBodies = 0;
    let maximumActiveBodies = 0;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      activeBodies += 1;
      maximumActiveBodies = Math.max(maximumActiveBodies, activeBodies);
      const body = new Promise<unknown>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          activeBodies -= 1;
          reject(new DOMException("stream aborted", "AbortError"));
        }, { once: true });
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => body,
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    const harness = repositoryHarness();
    const view = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: harness.repository,
    }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(() => view.result.current.updateAnswer("written-1", "stream ambiguity"));
    let flushError: unknown;
    let flush!: Promise<void>;
    act(() => {
      flush = view.result.current.flush().catch((error: unknown) => {
        flushError = error;
      });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); await flush; });
    expect(flushError).toBeInstanceOf(Error);
    expect(view.result.current.saveState).toBe("offline-saved-local");
    expect(view.result.current.issue).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(maximumActiveBodies).toBe(1);
    view.unmount();
    await act(async () => { await Promise.resolve(); });
  });

  it("fails closed when local storage initialization or the latest put fails", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const hydrationFailure = repositoryHarness({
      listExamAnswers: async () => { throw new Error("database unavailable"); },
    });
    const first = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: hydrationFailure.repository,
    }));
    await waitForHydration(first.result);
    expect(first.result.current.issue?.kind).toBe("event-recovery");
    await expect(first.result.current.updateAnswer("written-1", "blocked")).rejects.toThrow();

    const putFailure = repositoryHarness({
      putExamAnswer: async () => { throw new Error("transaction aborted"); },
    });
    const second = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession(),
      repository: putFailure.repository,
    }));
    await waitForHydration(second.result);
    let putError: unknown;
    await act(async () => {
      try {
        await second.result.current.updateAnswer("written-1", "copy-safe");
      } catch (error) {
        putError = error;
      }
    });
    expect(putError).toBeInstanceOf(Error);
    expect(second.result.current.answers["written-1"]).toBe("copy-safe");
    expect(second.result.current.saveState).toBe("local-save-error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("settles started answer writes and fences queued writes before terminal clear", async () => {
    const firstPut = deferred<void>();
    const base = repositoryHarness();
    const putIds: string[] = [];
    const repository = {
      ...base.repository,
      async putExamAnswer(record: ExamAnswerOutboxRecord) {
        putIds.push(record.clientMutationId);
        if (putIds.length === 1) await firstPut.promise;
        base.answers.set(record.storageKey, record);
      },
    } satisfies BrowserOutboxRepository;
    vi.stubGlobal("fetch", vi.fn());
    const view = renderHook(
      ({ status }: { status: ExamSessionView["status"] }) => useDurableExamOutbox({
        namespace,
        session: activeSession({ status }),
        repository,
      }),
      { initialProps: { status: "active" as ExamSessionView["status"] } },
    );
    await waitForHydration(view.result);

    let updateA!: Promise<void>;
    act(() => {
      updateA = view.result.current.updateAnswer("written-1", "A").catch(() => undefined);
    });
    await waitFor(() => expect(putIds).toHaveLength(1));
    let updateB!: Promise<void>;
    act(() => {
      updateB = view.result.current.updateAnswer("written-1", "B").catch(() => undefined);
    });
    expect(putIds).toHaveLength(1);

    view.rerender({ status: "graded" });
    await waitForHydration(view.result);
    let purgeSettled = false;
    let purge!: Promise<void>;
    act(() => {
      purge = view.result.current.purge().then(() => {
        purgeSettled = true;
      });
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const settledBeforeRelease = purgeSettled;

    await act(async () => {
      firstPut.resolve(undefined);
      await Promise.all([updateA, updateB, purge]);
    });
    expect(settledBeforeRelease).toBe(false);
    expect(putIds).toHaveLength(1);
    expect(base.answers.size).toBe(0);
    await act(() => view.result.current.purge());
    expect(putIds).toHaveLength(1);
    expect(base.answers.size).toBe(0);
  });

  it("retries failed terminal cleanup after an in-flight write rejects without deadlocking", async () => {
    const firstPut = deferred<void>();
    const base = repositoryHarness();
    const putIds: string[] = [];
    let clearAttempts = 0;
    const repository = {
      ...base.repository,
      async putExamAnswer(record: ExamAnswerOutboxRecord) {
        putIds.push(record.clientMutationId);
        if (putIds.length === 1) await firstPut.promise;
        base.answers.set(record.storageKey, record);
      },
      async clearExamSession(recordNamespace: string, recordSessionId: string) {
        clearAttempts += 1;
        if (clearAttempts === 1) throw new Error("cleanup transaction aborted");
        await base.repository.clearExamSession(recordNamespace, recordSessionId);
      },
    } satisfies BrowserOutboxRepository;
    vi.stubGlobal("fetch", vi.fn());
    const view = renderHook(
      ({ status }: { status: ExamSessionView["status"] }) => useDurableExamOutbox({
        namespace,
        session: activeSession({ status }),
        repository,
      }),
      { initialProps: { status: "active" as ExamSessionView["status"] } },
    );
    await waitForHydration(view.result);

    let updateA!: Promise<void>;
    let updateB!: Promise<void>;
    act(() => {
      updateA = view.result.current.updateAnswer("written-1", "A").catch(() => undefined);
    });
    await waitFor(() => expect(putIds).toHaveLength(1));
    act(() => {
      updateB = view.result.current.updateAnswer("written-1", "B").catch(() => undefined);
    });
    view.rerender({ status: "graded" });
    await waitForHydration(view.result);
    let firstPurgeError: unknown;
    let firstPurgeSettled = false;
    let firstPurge!: Promise<void>;
    act(() => {
      firstPurge = view.result.current.purge().catch((error: unknown) => {
        firstPurgeError = error;
      }).finally(() => {
        firstPurgeSettled = true;
      });
    });
    await act(async () => { await Promise.resolve(); });
    expect(firstPurgeSettled).toBe(false);

    await act(async () => {
      firstPut.reject(new Error("answer transaction aborted"));
      await Promise.all([updateA, updateB, firstPurge]);
    });
    expect(firstPurgeError).toBeInstanceOf(Error);
    expect(clearAttempts).toBe(1);
    expect(putIds).toHaveLength(1);

    await act(() => view.result.current.purge());
    expect(clearAttempts).toBe(2);
    expect(putIds).toHaveLength(1);
    expect(base.answers.size).toBe(0);
  });

  it("settles an in-flight event write before terminal cleanup clears the exact session", async () => {
    const eventPut = deferred<void>();
    const base = repositoryHarness();
    const repository = {
      ...base.repository,
      async putExamEvent(record: ExamEventOutboxRecord) {
        await eventPut.promise;
        base.events.set(record.storageKey, record);
      },
    } satisfies BrowserOutboxRepository;
    vi.stubGlobal("fetch", vi.fn());
    const view = renderHook(
      ({ status }: { status: ExamSessionView["status"] }) => useDurableExamOutbox({
        namespace,
        session: activeSession({ status }),
        repository,
      }),
      { initialProps: { status: "active" as ExamSessionView["status"] } },
    );
    await waitForHydration(view.result);
    let recordEvent!: Promise<void>;
    act(() => {
      recordEvent = view.result.current.recordEvent("window_blur", {}).catch(() => undefined);
    });
    await act(async () => { await Promise.resolve(); });

    view.rerender({ status: "graded" });
    await waitForHydration(view.result);
    let purgeSettled = false;
    let purge!: Promise<void>;
    act(() => {
      purge = view.result.current.purge().then(() => { purgeSettled = true; });
    });
    await act(async () => { await Promise.resolve(); });
    const settledBeforeEventWrite = purgeSettled;

    await act(async () => {
      eventPut.resolve(undefined);
      await Promise.all([recordEvent, purge]);
    });
    expect(settledBeforeEventWrite).toBe(false);
    expect(base.events.size).toBe(0);
    expect(base.cleared).toEqual([[namespace, sessionId]]);
  });

  it("refuses synchronous unload recovery after the deadline or terminal purge", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-07-15T10:00:00.000Z");
    vi.setSystemTime(now);
    const deadlineHarness = repositoryHarness();
    const deadline = renderHook(() => useDurableExamOutbox({
      namespace: `${namespace}-deadline-unload`,
      session: activeSession({
        serverNow: now.toISOString(),
        serverDeadlineAt: new Date(now.getTime() + 1_000).toISOString(),
      }),
      repository: deadlineHarness.repository,
    }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(deadline.result.current.prepareUnloadEvent({ reason: "beforeunload" })).toBeNull();
    expect(Object.keys(window.localStorage)).toEqual([]);

    const purgeHarness = repositoryHarness();
    const purged = renderHook(() => useDurableExamOutbox({
      namespace: `${namespace}-purged-unload`,
      session: activeSession(),
      repository: purgeHarness.repository,
    }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(() => purged.result.current.purge());
    expect(purged.result.current.prepareUnloadEvent({ reason: "beforeunload" })).toBeNull();
    expect(Object.keys(window.localStorage)).toEqual([]);
  });

  it("hydrates durable recovery after the estimated deadline without replaying it", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-07-15T10:00:00.000Z");
    vi.setSystemTime(now);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const harness = repositoryHarness();
    const recoveredAnswer = answerRecord({ answer: "copy this recovered answer" });
    const recoveredEvent = eventRecord();
    harness.answers.set(recoveredAnswer.storageKey, recoveredAnswer);
    harness.events.set(recoveredEvent.storageKey, recoveredEvent);

    const view = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession({
        serverNow: now.toISOString(),
        serverDeadlineAt: new Date(now.getTime() - 1).toISOString(),
      }),
      repository: harness.repository,
    }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(view.result.current.hydrated).toBe(true);
    expect(view.result.current.answers["written-1"]).toBe("copy this recovered answer");
    expect(view.result.current.saveState).toBe("saved-local");
    expect(fetchMock).not.toHaveBeenCalled();
    expect([...harness.answers.values()]).toEqual([recoveredAnswer]);
    expect([...harness.events.values()]).toEqual([recoveredEvent]);
    await expect(view.result.current.updateAnswer("written-1", "too late")).rejects.toThrow();
    await expect(view.result.current.flush()).rejects.toThrow();
  });

  it("fences at the estimated deadline and purges only an authoritative terminal session", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-07-15T10:00:00.000Z");
    vi.setSystemTime(now);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const activeHarness = repositoryHarness();
    const active = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession({
        serverNow: now.toISOString(),
        serverDeadlineAt: new Date(now.getTime() + 1_000).toISOString(),
      }),
      repository: activeHarness.repository,
    }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(() => active.result.current.updateAnswer("written-1", "too late to send"));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await expect(active.result.current.flush()).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(activeHarness.answers.size).toBe(1);

    const terminalHarness = repositoryHarness();
    const thisAnswer = answerRecord();
    const otherAnswer = answerRecord({
      recordSessionId: "10000000-0000-4000-8000-000000000099",
      clientMutationId: "30000000-0000-4000-8000-000000000099",
    });
    terminalHarness.answers.set(thisAnswer.storageKey, thisAnswer);
    terminalHarness.answers.set(otherAnswer.storageKey, otherAnswer);
    const thisEvent = eventRecord();
    const otherEvent = eventRecord({
      recordSessionId: "10000000-0000-4000-8000-000000000099",
      clientEventId: "40000000-0000-4000-8000-000000000099",
    });
    terminalHarness.events.set(thisEvent.storageKey, thisEvent);
    terminalHarness.events.set(otherEvent.storageKey, otherEvent);
    const terminal = renderHook(() => useDurableExamOutbox({
      namespace,
      session: activeSession({ status: "graded" }),
      repository: terminalHarness.repository,
    }));
    await act(async () => { await Promise.resolve(); });
    await act(() => terminal.result.current.purge());
    await act(() => terminal.result.current.purge());
    expect(terminalHarness.cleared).toEqual([[namespace, sessionId], [namespace, sessionId]]);
    expect([...terminalHarness.answers.values()]).toEqual([otherAnswer]);
    expect([...terminalHarness.events.values()]).toEqual([otherEvent]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function fireEventOnline() {
  window.dispatchEvent(new Event("online"));
}
