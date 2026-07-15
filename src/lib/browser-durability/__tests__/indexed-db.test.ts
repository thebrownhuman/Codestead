import {
  IDBDatabase as FakeIDBDatabase,
  IDBFactory as FakeIDBFactory,
  IDBObjectStore as FakeIDBObjectStore,
} from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DraftKey } from "@/lib/drafts/types";
import { DRAFT_CONTENT_MAX_BYTES } from "@/lib/drafts/types";
import type { ClientExamEventType } from "@/lib/exams/contracts";

import {
  type BrowserOutboxRepository,
  openBrowserOutbox,
} from "../indexed-db";

type DraftOutboxRecord = {
  schemaVersion: 1;
  storageKey: string;
  namespace: string;
  kind: "draft";
  scope: string;
  requestId: string;
  updatedAt: string;
  payload: { key: DraftKey; content: string; baseRevision: number };
};

type ExamAnswerOutboxRecord = {
  schemaVersion: 1;
  storageKey: string;
  namespace: string;
  kind: "exam-answer";
  scope: string;
  clientMutationId: string;
  updatedAt: string;
  payload: { itemId: string; answer: string; baseRevision: number };
};

type ExamEventOutboxRecord = {
  schemaVersion: 1;
  storageKey: string;
  namespace: string;
  kind: "exam-event";
  scope: string;
  clientEventId: string;
  updatedAt: string;
  payload: {
    eventType: ClientExamEventType;
    occurredAt: string;
    metadata: Record<string, unknown>;
  };
};

const DATABASE_NAME = "codestead-browser-outbox-v1";
const DATABASE_VERSION = 1;
const STORE_NAME = "entries";

const NAMESPACE_A = "namespace-alpha";
const NAMESPACE_B = "namespace-beta";
const SESSION_A = "session-alpha";
const SESSION_B = "session-beta";

const REQUEST_1 = "00000000-0000-4000-8000-000000000001";
const REQUEST_2 = "00000000-0000-4000-8000-000000000002";
const MUTATION_1 = "10000000-0000-4000-8000-000000000001";
const MUTATION_2 = "10000000-0000-4000-8000-000000000002";
const MUTATION_3 = "10000000-0000-4000-8000-000000000003";
const INVALID_UUID_VERSION = "00000000-0000-f000-8000-000000000000";
const INVALID_UUID_VARIANT = "00000000-0000-4000-0000-000000000000";
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const MAX_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const UPPERCASE_MAX_UUID = "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF";
const MIXED_CASE_MAX_UUID = "fFffffff-ffff-ffff-ffff-ffffffffffff";
const UPPERCASE_UUID = "ABCDEF12-3456-7000-BABC-DEF012345678";

const TIME_1 = "2026-07-15T01:00:00.000Z";
const TIME_2 = "2026-07-15T02:00:00.000Z";

const CODE_DRAFT_KEY: DraftKey = {
  kind: "code",
  courseId: "course-alpha",
  skillId: "skill-alpha",
  language: "typescript",
};

const LESSON_DRAFT_KEY: DraftKey = {
  kind: "lesson",
  courseId: "course-beta",
  skillId: "skill-beta",
  language: null,
};

function draftScope(key: DraftKey) {
  return JSON.stringify([key.kind, key.courseId, key.skillId, key.language]);
}

function draftStorageKey(namespace: string, key: DraftKey) {
  return JSON.stringify([
    1,
    namespace,
    "draft",
    key.kind,
    key.courseId,
    key.skillId,
    key.language,
  ]);
}

function examAnswerStorageKey(namespace: string, sessionId: string, itemId: string) {
  return JSON.stringify([1, namespace, "exam-answer", sessionId, itemId]);
}

function examEventStorageKey(namespace: string, sessionId: string, clientEventId: string) {
  return JSON.stringify([1, namespace, "exam-event", sessionId, clientEventId]);
}

function makeDraftRecord(overrides: Partial<{
  namespace: string;
  key: DraftKey;
  requestId: string;
  updatedAt: string;
  content: string;
  baseRevision: number;
}> = {}): DraftOutboxRecord {
  const namespace = overrides.namespace ?? NAMESPACE_A;
  const key = overrides.key ?? CODE_DRAFT_KEY;
  return {
    schemaVersion: 1,
    storageKey: draftStorageKey(namespace, key),
    namespace,
    kind: "draft",
    scope: draftScope(key),
    requestId: overrides.requestId ?? REQUEST_1,
    updatedAt: overrides.updatedAt ?? TIME_1,
    payload: {
      key,
      content: overrides.content ?? "const durable = true;",
      baseRevision: overrides.baseRevision ?? 0,
    },
  };
}

function makeAnswerRecord(overrides: Partial<{
  namespace: string;
  sessionId: string;
  itemId: string;
  clientMutationId: string;
  updatedAt: string;
  answer: string;
  baseRevision: number;
}> = {}): ExamAnswerOutboxRecord {
  const namespace = overrides.namespace ?? NAMESPACE_A;
  const sessionId = overrides.sessionId ?? SESSION_A;
  const itemId = overrides.itemId ?? "item-alpha";
  return {
    schemaVersion: 1,
    storageKey: examAnswerStorageKey(namespace, sessionId, itemId),
    namespace,
    kind: "exam-answer",
    scope: sessionId,
    clientMutationId: overrides.clientMutationId ?? MUTATION_1,
    updatedAt: overrides.updatedAt ?? TIME_1,
    payload: {
      itemId,
      answer: overrides.answer ?? "answer alpha",
      baseRevision: overrides.baseRevision ?? 0,
    },
  };
}

function makeEventRecord(overrides: Partial<{
  namespace: string;
  sessionId: string;
  clientEventId: string;
  updatedAt: string;
  eventType: ClientExamEventType;
  occurredAt: string;
  metadata: Record<string, unknown>;
}> = {}): ExamEventOutboxRecord {
  const namespace = overrides.namespace ?? NAMESPACE_A;
  const sessionId = overrides.sessionId ?? SESSION_A;
  const clientEventId = overrides.clientEventId ?? "event-alpha-000001";
  return {
    schemaVersion: 1,
    storageKey: examEventStorageKey(namespace, sessionId, clientEventId),
    namespace,
    kind: "exam-event",
    scope: sessionId,
    clientEventId,
    updatedAt: overrides.updatedAt ?? TIME_1,
    payload: {
      eventType: overrides.eventType ?? "window_blur",
      occurredAt: overrides.occurredAt ?? TIME_1,
      metadata: overrides.metadata ?? { sequence: 1 },
    },
  };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("IndexedDB request failed.")),
      { once: true },
    );
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("IndexedDB transaction failed.")),
      { once: true },
    );
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new DOMException("Transaction aborted.", "AbortError")),
      { once: true },
    );
  });
}

function openRawDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("IndexedDB open failed.")),
      { once: true },
    );
  });
}

async function rawPut(factory: IDBFactory, value: unknown) {
  const database = await openRawDatabase(factory);
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const completed = transactionComplete(transaction);
    transaction.objectStore(STORE_NAME).put(value);
    await completed;
  } finally {
    database.close();
  }
}

async function rawGet(factory: IDBFactory, storageKey: string) {
  const database = await openRawDatabase(factory);
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const completed = transactionComplete(transaction);
    const value = await requestResult(transaction.objectStore(STORE_NAME).get(storageKey));
    await completed;
    return value as unknown;
  } finally {
    database.close();
  }
}

async function seedMatrix(repository: BrowserOutboxRepository) {
  const records = {
    draftA: makeDraftRecord(),
    draftB: makeDraftRecord({ namespace: NAMESPACE_B, key: LESSON_DRAFT_KEY }),
    answerASessionA: makeAnswerRecord(),
    answerASessionB: makeAnswerRecord({
      sessionId: SESSION_B,
      itemId: "item-beta",
      clientMutationId: MUTATION_2,
    }),
    answerBSessionA: makeAnswerRecord({
      namespace: NAMESPACE_B,
      itemId: "item-gamma",
      clientMutationId: MUTATION_3,
    }),
    eventASessionA: makeEventRecord(),
    eventASessionB: makeEventRecord({
      sessionId: SESSION_B,
      clientEventId: "event-beta-000001",
    }),
    eventBSessionA: makeEventRecord({
      namespace: NAMESPACE_B,
      clientEventId: "event-gamma-00001",
    }),
  };

  await repository.putDraft(records.draftA);
  await repository.putDraft(records.draftB);
  await repository.putExamAnswer(records.answerASessionA);
  await repository.putExamAnswer(records.answerASessionB);
  await repository.putExamAnswer(records.answerBSessionA);
  await repository.putExamEvent(records.eventASessionA);
  await repository.putExamEvent(records.eventASessionB);
  await repository.putExamEvent(records.eventBSessionA);
  return records;
}

describe("browser outbox IndexedDB repository", () => {
  let factory: IDBFactory;
  let repository: BrowserOutboxRepository | null;

  beforeEach(async () => {
    factory = new FakeIDBFactory();
    repository = await openBrowserOutbox(factory);
  });

  afterEach(() => {
    repository?.close();
    repository = null;
    vi.restoreAllMocks();
  });

  it("creates the exact version-1 schema", async () => {
    const database = await openRawDatabase(factory);
    try {
      expect(Array.from(database.objectStoreNames)).toEqual([STORE_NAME]);
      const transaction = database.transaction(STORE_NAME, "readonly");
      const completed = transactionComplete(transaction);
      const store = transaction.objectStore(STORE_NAME);
      expect(store.keyPath).toBe("storageKey");
      expect(Array.from(store.indexNames).sort()).toEqual([
        "namespace",
        "namespaceKindScope",
      ]);
      expect(store.index("namespace").keyPath).toBe("namespace");
      expect(store.index("namespace").unique).toBe(false);
      expect(store.index("namespaceKindScope").keyPath).toEqual([
        "namespace",
        "kind",
        "scope",
      ]);
      expect(store.index("namespaceKindScope").unique).toBe(false);
      await completed;
    } finally {
      database.close();
    }
  });

  it("survives repository close and reopen with the same factory", async () => {
    const draft = makeDraftRecord();
    const answer = makeAnswerRecord();
    const event = makeEventRecord();
    await repository!.putDraft(draft);
    await repository!.putExamAnswer(answer);
    await repository!.putExamEvent(event);

    repository!.close();
    repository = await openBrowserOutbox(factory);

    await expect(repository.getDraft(NAMESPACE_A, CODE_DRAFT_KEY)).resolves.toEqual(draft);
    await expect(repository.listExamAnswers(NAMESPACE_A, SESSION_A)).resolves.toEqual([answer]);
    await expect(repository.listExamEvents(NAMESPACE_A, SESSION_A)).resolves.toEqual([event]);
  });

  it("rejects malformed records before every put", async () => {
    const draft = makeDraftRecord();
    const answer = makeAnswerRecord({ baseRevision: -1 });
    const event = makeEventRecord();

    await expect(repository!.putDraft({
      ...draft,
      storageKey: "caller-invented-key",
    })).rejects.toThrow("Draft outbox record is invalid.");
    await expect(repository!.putExamAnswer(answer)).rejects.toThrow(
      "Exam answer outbox record is invalid.",
    );
    await expect(repository!.putExamEvent({
      ...event,
      payload: {
        ...event.payload,
        metadata: { invalid: undefined },
      },
    })).rejects.toThrow("Exam event outbox record is invalid.");
  });

  it("matches Zod UUID semantics for draft and answer mutation IDs", async () => {
    for (const invalidId of [
      INVALID_UUID_VERSION,
      INVALID_UUID_VARIANT,
      UPPERCASE_MAX_UUID,
      MIXED_CASE_MAX_UUID,
    ]) {
      await expect.soft(repository!.putDraft(makeDraftRecord({ requestId: invalidId })))
        .rejects.toThrow("Draft outbox record is invalid.");
      await expect.soft(repository!.putExamAnswer(makeAnswerRecord({ clientMutationId: invalidId })))
        .rejects.toThrow("Exam answer outbox record is invalid.");
    }

    for (const validId of [REQUEST_1, NIL_UUID, MAX_UUID, UPPERCASE_UUID]) {
      await expect(repository!.putDraft(makeDraftRecord({ requestId: validId })))
        .resolves.toBeUndefined();
      await expect(repository!.putExamAnswer(makeAnswerRecord({ clientMutationId: validId })))
        .resolves.toBeUndefined();
    }
  });

  it("compare-and-deletes drafts only for the exact request ID", async () => {
    const draft = makeDraftRecord();
    await repository!.putDraft(draft);

    await expect(repository!.deleteDraftIfMutation(
      NAMESPACE_A,
      CODE_DRAFT_KEY,
      REQUEST_2,
    )).resolves.toBe(false);
    await expect(repository!.getDraft(NAMESPACE_A, CODE_DRAFT_KEY)).resolves.toEqual(draft);
    await expect(repository!.deleteDraftIfMutation(
      NAMESPACE_A,
      CODE_DRAFT_KEY,
      REQUEST_1,
    )).resolves.toBe(true);
    await expect(repository!.getDraft(NAMESPACE_A, CODE_DRAFT_KEY)).resolves.toBeNull();
  });

  it("compare-and-deletes answers only for the exact mutation ID", async () => {
    const answer = makeAnswerRecord();
    await repository!.putExamAnswer(answer);

    await expect(repository!.deleteExamAnswerIfMutation(
      NAMESPACE_A,
      SESSION_A,
      answer.payload.itemId,
      MUTATION_2,
    )).resolves.toBe(false);
    await expect(repository!.listExamAnswers(NAMESPACE_A, SESSION_A)).resolves.toEqual([answer]);
    await expect(repository!.deleteExamAnswerIfMutation(
      NAMESPACE_A,
      SESSION_A,
      answer.payload.itemId,
      MUTATION_1,
    )).resolves.toBe(true);
    await expect(repository!.listExamAnswers(NAMESPACE_A, SESSION_A)).resolves.toEqual([]);
  });

  it("keeps newer draft and answer mutations when an older acknowledgement arrives", async () => {
    const olderDraft = makeDraftRecord();
    const newerDraft = makeDraftRecord({
      requestId: REQUEST_2,
      updatedAt: TIME_2,
      content: "const durable = 'newer';",
      baseRevision: 1,
    });
    const olderAnswer = makeAnswerRecord();
    const newerAnswer = makeAnswerRecord({
      clientMutationId: MUTATION_2,
      updatedAt: TIME_2,
      answer: "newer answer",
      baseRevision: 1,
    });

    await repository!.putDraft(olderDraft);
    await repository!.putDraft(newerDraft);
    await repository!.putExamAnswer(olderAnswer);
    await repository!.putExamAnswer(newerAnswer);

    await expect(repository!.deleteDraftIfMutation(
      NAMESPACE_A,
      CODE_DRAFT_KEY,
      REQUEST_1,
    )).resolves.toBe(false);
    await expect(repository!.deleteExamAnswerIfMutation(
      NAMESPACE_A,
      SESSION_A,
      newerAnswer.payload.itemId,
      MUTATION_1,
    )).resolves.toBe(false);
    await expect(repository!.getDraft(NAMESPACE_A, CODE_DRAFT_KEY)).resolves.toEqual(newerDraft);
    await expect(repository!.listExamAnswers(NAMESPACE_A, SESSION_A)).resolves.toEqual([
      newerAnswer,
    ]);
  });

  it("isolates and deterministically orders lists by namespace, kind, and scope", async () => {
    const answerLater = makeAnswerRecord({
      itemId: "item-zeta",
      clientMutationId: MUTATION_2,
      updatedAt: TIME_2,
    });
    const answerEarlier = makeAnswerRecord({
      itemId: "item-alpha",
      clientMutationId: MUTATION_1,
      updatedAt: TIME_1,
    });
    const eventLater = makeEventRecord({
      clientEventId: "event-zeta-000001",
      updatedAt: TIME_2,
      occurredAt: TIME_2,
    });
    const eventEarlier = makeEventRecord({
      clientEventId: "event-alpha-000001",
      updatedAt: TIME_1,
      occurredAt: TIME_1,
    });

    await repository!.putExamAnswer(answerLater);
    await repository!.putExamAnswer(answerEarlier);
    await repository!.putExamAnswer(makeAnswerRecord({
      namespace: NAMESPACE_B,
      itemId: "item-foreign",
      clientMutationId: MUTATION_3,
    }));
    await repository!.putExamAnswer(makeAnswerRecord({
      sessionId: SESSION_B,
      itemId: "item-other-session",
      clientMutationId: MUTATION_3,
    }));
    await repository!.putExamEvent(eventLater);
    await repository!.putExamEvent(eventEarlier);
    await repository!.putExamEvent(makeEventRecord({
      namespace: NAMESPACE_B,
      clientEventId: "event-foreign-0001",
    }));
    await repository!.putExamEvent(makeEventRecord({
      sessionId: SESSION_B,
      clientEventId: "event-session-0001",
    }));

    await expect(repository!.listExamAnswers(NAMESPACE_A, SESSION_A)).resolves.toEqual([
      answerEarlier,
      answerLater,
    ]);
    await expect(repository!.listExamEvents(NAMESPACE_A, SESSION_A)).resolves.toEqual([
      eventEarlier,
      eventLater,
    ]);
  });

  it("deletes only the exact exam event identity", async () => {
    const target = makeEventRecord();
    const preserved = makeEventRecord({ clientEventId: "event-alpha-000002" });
    await repository!.putExamEvent(target);
    await repository!.putExamEvent(preserved);

    await repository!.deleteExamEvent(NAMESPACE_A, SESSION_A, target.clientEventId);

    await expect(repository!.listExamEvents(NAMESPACE_A, SESSION_A)).resolves.toEqual([
      preserved,
    ]);
  });

  it("clearExamSession removes only answers and events in the exact session", async () => {
    const records = await seedMatrix(repository!);

    await repository!.clearExamSession(NAMESPACE_A, SESSION_A);

    await expect(repository!.getDraft(NAMESPACE_A, CODE_DRAFT_KEY)).resolves.toEqual(
      records.draftA,
    );
    await expect(repository!.listExamAnswers(NAMESPACE_A, SESSION_A)).resolves.toEqual([]);
    await expect(repository!.listExamEvents(NAMESPACE_A, SESSION_A)).resolves.toEqual([]);
    await expect(repository!.listExamAnswers(NAMESPACE_A, SESSION_B)).resolves.toEqual([
      records.answerASessionB,
    ]);
    await expect(repository!.listExamEvents(NAMESPACE_A, SESSION_B)).resolves.toEqual([
      records.eventASessionB,
    ]);
    await expect(repository!.listExamAnswers(NAMESPACE_B, SESSION_A)).resolves.toEqual([
      records.answerBSessionA,
    ]);
    await expect(repository!.listExamEvents(NAMESPACE_B, SESSION_A)).resolves.toEqual([
      records.eventBSessionA,
    ]);
  });

  it("clearNamespace removes only the exact namespace", async () => {
    const records = await seedMatrix(repository!);

    await repository!.clearNamespace(NAMESPACE_A);

    await expect(repository!.getDraft(NAMESPACE_A, CODE_DRAFT_KEY)).resolves.toBeNull();
    await expect(repository!.listExamAnswers(NAMESPACE_A, SESSION_A)).resolves.toEqual([]);
    await expect(repository!.listExamAnswers(NAMESPACE_A, SESSION_B)).resolves.toEqual([]);
    await expect(repository!.listExamEvents(NAMESPACE_A, SESSION_A)).resolves.toEqual([]);
    await expect(repository!.listExamEvents(NAMESPACE_A, SESSION_B)).resolves.toEqual([]);
    await expect(repository!.getDraft(NAMESPACE_B, LESSON_DRAFT_KEY)).resolves.toEqual(
      records.draftB,
    );
    await expect(repository!.listExamAnswers(NAMESPACE_B, SESSION_A)).resolves.toEqual([
      records.answerBSessionA,
    ]);
    await expect(repository!.listExamEvents(NAMESPACE_B, SESSION_A)).resolves.toEqual([
      records.eventBSessionA,
    ]);
  });

  it("clearForeignNamespaces preserves only valid records in the current namespace", async () => {
    const records = await seedMatrix(repository!);
    const malformedStorageKey = "malformed-current-namespace-record";
    await rawPut(factory, {
      schemaVersion: 1,
      storageKey: malformedStorageKey,
      namespace: NAMESPACE_A,
      kind: "draft",
    });

    await repository!.clearForeignNamespaces(NAMESPACE_A);

    await expect(repository!.getDraft(NAMESPACE_A, CODE_DRAFT_KEY)).resolves.toEqual(
      records.draftA,
    );
    await expect(repository!.listExamAnswers(NAMESPACE_A, SESSION_A)).resolves.toEqual([
      records.answerASessionA,
    ]);
    await expect(repository!.listExamAnswers(NAMESPACE_A, SESSION_B)).resolves.toEqual([
      records.answerASessionB,
    ]);
    await expect(repository!.listExamEvents(NAMESPACE_A, SESSION_A)).resolves.toEqual([
      records.eventASessionA,
    ]);
    await expect(repository!.listExamEvents(NAMESPACE_A, SESSION_B)).resolves.toEqual([
      records.eventASessionB,
    ]);
    await expect(repository!.getDraft(NAMESPACE_B, LESSON_DRAFT_KEY)).resolves.toBeNull();
    await expect(repository!.listExamAnswers(NAMESPACE_B, SESSION_A)).resolves.toEqual([]);
    await expect(repository!.listExamEvents(NAMESPACE_B, SESSION_A)).resolves.toEqual([]);
    await expect(rawGet(factory, malformedStorageKey)).resolves.toBeUndefined();
  });

  it("clearAll removes every record", async () => {
    await seedMatrix(repository!);

    await repository!.clearAll();

    await expect(repository!.getDraft(NAMESPACE_A, CODE_DRAFT_KEY)).resolves.toBeNull();
    await expect(repository!.getDraft(NAMESPACE_B, LESSON_DRAFT_KEY)).resolves.toBeNull();
    await expect(repository!.listExamAnswers(NAMESPACE_A, SESSION_A)).resolves.toEqual([]);
    await expect(repository!.listExamAnswers(NAMESPACE_A, SESSION_B)).resolves.toEqual([]);
    await expect(repository!.listExamAnswers(NAMESPACE_B, SESSION_A)).resolves.toEqual([]);
    await expect(repository!.listExamEvents(NAMESPACE_A, SESSION_A)).resolves.toEqual([]);
    await expect(repository!.listExamEvents(NAMESPACE_A, SESSION_B)).resolves.toEqual([]);
    await expect(repository!.listExamEvents(NAMESPACE_B, SESSION_A)).resolves.toEqual([]);
  });

  it("purges invalid schema versions and oversized UTF-8 drafts on read", async () => {
    const invalidVersion = makeDraftRecord();
    const oversized = makeDraftRecord({
      key: LESSON_DRAFT_KEY,
      requestId: REQUEST_2,
      content: "🙂".repeat(Math.floor(DRAFT_CONTENT_MAX_BYTES / 4) + 1),
    });
    await rawPut(factory, { ...invalidVersion, schemaVersion: 2 });
    await rawPut(factory, oversized);

    await expect(repository!.getDraft(NAMESPACE_A, CODE_DRAFT_KEY)).resolves.toBeNull();
    await expect(repository!.getDraft(NAMESPACE_A, LESSON_DRAFT_KEY)).resolves.toBeNull();
    await expect(rawGet(factory, invalidVersion.storageKey)).resolves.toBeUndefined();
    await expect(rawGet(factory, oversized.storageKey)).resolves.toBeUndefined();
  });

  it("purges malformed answers and events encountered by list reads", async () => {
    const malformedAnswer = makeAnswerRecord();
    const malformedEvent = makeEventRecord();
    await rawPut(factory, {
      ...malformedAnswer,
      payload: { ...malformedAnswer.payload, itemId: "different-item" },
    });
    await rawPut(factory, {
      ...malformedEvent,
      payload: {
        ...malformedEvent.payload,
        metadata: { oversized: "x".repeat(4_097) },
      },
    });

    await expect(repository!.listExamAnswers(NAMESPACE_A, SESSION_A)).resolves.toEqual([]);
    await expect(repository!.listExamEvents(NAMESPACE_A, SESSION_A)).resolves.toEqual([]);
    await expect(rawGet(factory, malformedAnswer.storageKey)).resolves.toBeUndefined();
    await expect(rawGet(factory, malformedEvent.storageKey)).resolves.toBeUndefined();
  });

  it("keeps a write pending after request success and resolves only after transaction complete", async () => {
    const transactionSpy = vi.spyOn(FakeIDBDatabase.prototype, "transaction");
    const putSpy = vi.spyOn(FakeIDBObjectStore.prototype, "put");

    const write = repository!.putDraft(makeDraftRecord());
    const transaction = transactionSpy.mock.results.at(-1)?.value as IDBTransaction;
    const request = putSpy.mock.results.at(-1)?.value as IDBRequest<IDBValidKey>;
    let completed = false;
    let settled = false;
    transaction.addEventListener("complete", () => {
      completed = true;
    });
    void write.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await new Promise<void>((resolve, reject) => {
      request.addEventListener("success", () => resolve(), { once: true });
      request.addEventListener(
        "error",
        () => reject(request.error ?? new Error("IndexedDB put failed.")),
        { once: true },
      );
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(completed).toBe(false);
    await write;
    expect(completed).toBe(true);
  });
});
