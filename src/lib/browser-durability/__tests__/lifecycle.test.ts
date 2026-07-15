import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DRAFT_CACHE_PREFIX,
  draftCacheKey,
  writeDraftCache,
} from "@/lib/drafts/browser-cache";
import type { DraftKey } from "@/lib/drafts/types";

import {
  EMERGENCY_EXAM_EVENT_PREFIX,
  writeEmergencyExamEvent,
} from "../emergency-events";
import {
  openBrowserOutbox,
  type BrowserOutboxRepository,
} from "../indexed-db";
import {
  createBrowserRecoveryBoundaryContext,
  prepareBrowserRecoveryNamespace,
  purgeBrowserRecoveryData,
  purgeDraftRecoveryData,
  purgeExamRecoveryData,
  subscribeBrowserRecoveryBoundary,
  type BrowserRecoveryBoundaryChannel,
} from "../lifecycle";
import {
  draftOutboxScope,
  draftOutboxStorageKey,
  examAnswerOutboxStorageKey,
  examEventOutboxStorageKey,
  type DraftOutboxRecord,
  type ExamAnswerOutboxRecord,
  type ExamEventOutboxRecord,
} from "../types";

const NAMESPACE_A = "namespace-alpha";
const NAMESPACE_B = "namespace-beta";
const SESSION_A = "session-alpha";
const SESSION_B = "session-beta";
const DRAFT_KEY = {
  kind: "code" as const,
  courseId: "python",
  skillId: "python.variables",
  language: "python",
};
const DRAFT_KEY_B = {
  kind: "lesson" as const,
  courseId: "python",
  skillId: "python.loops",
  language: null,
};

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  constructor(seed?: Iterable<readonly [string, string]>) {
    for (const [key, value] of seed ?? []) this.#values.set(key, value);
  }

  get length() {
    return this.#values.size;
  }

  clear() {
    this.#values.clear();
  }

  getItem(key: string) {
    return this.#values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.#values.delete(key);
  }

  setItem(key: string, value: string) {
    this.#values.set(key, String(value));
  }

  entries() {
    return [...this.#values.entries()] as Array<readonly [string, string]>;
  }
}

class BoundaryChannelHub {
  readonly #channels = new Set<{
    listeners: Set<(event: MessageEvent<unknown>) => void>;
    closed: boolean;
  }>();

  create(): BrowserRecoveryBoundaryChannel {
    const state = {
      listeners: new Set<(event: MessageEvent<unknown>) => void>(),
      closed: false,
    };
    this.#channels.add(state);
    return {
      postMessage: (message) => {
        for (const peer of this.#channels) {
          if (peer === state || peer.closed) continue;
          queueMicrotask(() => {
            if (peer.closed) return;
            const event = { data: message } as MessageEvent<unknown>;
            for (const listener of peer.listeners) listener(event);
          });
        }
      },
      addEventListener: (_type, listener) => {
        state.listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        state.listeners.delete(listener);
      },
      close: () => {
        state.closed = true;
        state.listeners.clear();
        this.#channels.delete(state);
      },
    };
  }

  inject(message: unknown) {
    for (const peer of this.#channels) {
      if (peer.closed) continue;
      const event = { data: message } as MessageEvent<unknown>;
      for (const listener of peer.listeners) listener(event);
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function draftRecord(
  namespace: string,
  key: DraftKey = DRAFT_KEY,
  requestId = "10000000-0000-4000-8000-000000000001",
): DraftOutboxRecord {
  return {
    schemaVersion: 1,
    storageKey: draftOutboxStorageKey(namespace, key),
    namespace,
    kind: "draft",
    scope: draftOutboxScope(key),
    requestId,
    updatedAt: "2026-07-15T01:00:00.000Z",
    payload: { key, content: `private draft for ${namespace}`, baseRevision: 0 },
  };
}

function answerRecord(
  namespace: string,
  sessionId: string,
  itemId: string,
  clientMutationId: string,
): ExamAnswerOutboxRecord {
  return {
    schemaVersion: 1,
    storageKey: examAnswerOutboxStorageKey(namespace, sessionId, itemId),
    namespace,
    kind: "exam-answer",
    scope: sessionId,
    clientMutationId,
    updatedAt: "2026-07-15T01:00:00.000Z",
    payload: { itemId, answer: `private answer for ${sessionId}`, baseRevision: 0 },
  };
}

function repository(overrides: Partial<BrowserOutboxRepository> = {}) {
  return {
    getDraft: vi.fn(async () => null),
    putDraft: vi.fn(async () => undefined),
    deleteDraftIfMutation: vi.fn(async () => false),
    listExamAnswers: vi.fn(async () => []),
    putExamAnswer: vi.fn(async () => undefined),
    deleteExamAnswerIfMutation: vi.fn(async () => false),
    listExamEvents: vi.fn(async () => []),
    putExamEvent: vi.fn(async () => undefined),
    deleteExamEvent: vi.fn(async () => undefined),
    clearExamSession: vi.fn(async () => undefined),
    clearDrafts: vi.fn(async () => undefined),
    clearNamespace: vi.fn(async () => undefined),
    clearForeignNamespaces: vi.fn(async () => undefined),
    clearAll: vi.fn(async () => undefined),
    close: vi.fn(),
    ...overrides,
  } satisfies BrowserOutboxRepository;
}

function eventRecord(
  namespace = NAMESPACE_A,
  sessionId = SESSION_A,
  clientEventId = "event-alpha-000001",
): ExamEventOutboxRecord {
  return {
    schemaVersion: 1,
    storageKey: examEventOutboxStorageKey(namespace, sessionId, clientEventId),
    namespace,
    kind: "exam-event",
    scope: sessionId,
    clientEventId,
    updatedAt: "2026-07-15T01:00:00.000Z",
    payload: {
      eventType: "window_blur",
      occurredAt: "2026-07-15T01:00:00.000Z",
      metadata: { sequence: 1 },
    },
  };
}

function emergencyKey(record: ExamEventOutboxRecord) {
  return `${EMERGENCY_EXAM_EVENT_PREFIX}${encodeURIComponent(record.namespace)}:${encodeURIComponent(record.scope)}:${encodeURIComponent(record.clientEventId)}`;
}

async function seedOutboxMatrix(repository: BrowserOutboxRepository) {
  const records = {
    draftA: draftRecord(NAMESPACE_A),
    draftB: draftRecord(
      NAMESPACE_B,
      DRAFT_KEY_B,
      "10000000-0000-4000-8000-000000000002",
    ),
    answerAA: answerRecord(
      NAMESPACE_A,
      SESSION_A,
      "item-alpha",
      "20000000-0000-4000-8000-000000000001",
    ),
    answerAB: answerRecord(
      NAMESPACE_A,
      SESSION_B,
      "item-beta",
      "20000000-0000-4000-8000-000000000002",
    ),
    answerBA: answerRecord(
      NAMESPACE_B,
      SESSION_A,
      "item-foreign",
      "20000000-0000-4000-8000-000000000003",
    ),
    eventAA: eventRecord(NAMESPACE_A, SESSION_A, "event-alpha-000001"),
    eventAB: eventRecord(NAMESPACE_A, SESSION_B, "event-beta-000001"),
    eventBA: eventRecord(NAMESPACE_B, SESSION_A, "event-foreign-0001"),
  };
  await repository.putDraft(records.draftA);
  await repository.putDraft(records.draftB);
  await repository.putExamAnswer(records.answerAA);
  await repository.putExamAnswer(records.answerAB);
  await repository.putExamAnswer(records.answerBA);
  await repository.putExamEvent(records.eventAA);
  await repository.putExamEvent(records.eventAB);
  await repository.putExamEvent(records.eventBA);
  return records;
}

function emergencyRecords() {
  return Object.keys(window.localStorage)
    .filter((key) => key.startsWith(EMERGENCY_EXAM_EVENT_PREFIX))
    .map((key) => window.localStorage.getItem(key))
    .filter((value): value is string => value !== null)
    .flatMap((value) => {
      try {
        return [JSON.parse(value) as ExamEventOutboxRecord];
      } catch {
        return [];
      }
    });
}

function seedWarmStorage() {
  const cached = {
    schemaVersion: 1 as const,
    content: "answer = 42\n",
    language: "python",
    baseRowVersion: 0,
    requestId: "10000000-0000-4000-8000-000000000001",
    locallyUpdatedAt: "2026-07-15T01:00:00.000Z",
    dirty: true,
  };
  writeDraftCache(window.sessionStorage, NAMESPACE_A, DRAFT_KEY, cached);
  writeDraftCache(window.sessionStorage, NAMESPACE_B, DRAFT_KEY, cached);
  window.sessionStorage.setItem(`${draftCacheKey(NAMESPACE_A, DRAFT_KEY)}:stdin`, "keep-a");
  window.sessionStorage.setItem(`${draftCacheKey(NAMESPACE_A, DRAFT_KEY)}:practice-run`, "retry-a");
  window.sessionStorage.setItem(`${draftCacheKey(NAMESPACE_B, DRAFT_KEY)}:stdin`, "keep-b");
  window.sessionStorage.setItem(`${DRAFT_CACHE_PREFIX}practice-run-session`, "obsolete");
  window.sessionStorage.setItem("unrelated-session", "keep");
}

describe("browser recovery lifecycle", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it("publishes an exact namespace boundary before purging every recovery layer", async () => {
    seedWarmStorage();
    writeEmergencyExamEvent(window.localStorage, eventRecord());
    writeEmergencyExamEvent(
      window.localStorage,
      eventRecord(NAMESPACE_B, SESSION_A, "event-foreign-0001"),
    );
    window.localStorage.setItem("unrelated-local", "keep");
    const order: string[] = [];
    const repo = repository({
      clearNamespace: vi.fn(async () => { order.push("indexed-db"); }),
    });
    const unsubscribe = subscribeBrowserRecoveryBoundary((boundary) => {
      order.push(`boundary:${boundary.kind}`);
    });

    try {
      await purgeBrowserRecoveryData({
        namespace: NAMESPACE_A,
        sessionStorage: window.sessionStorage,
        localStorage: window.localStorage,
        repository: repo,
      });
    } finally {
      unsubscribe();
    }

    expect(order[0]).toBe("boundary:namespace");
    expect(repo.clearNamespace).toHaveBeenCalledWith(NAMESPACE_A);
    expect(window.sessionStorage.getItem(draftCacheKey(NAMESPACE_A, DRAFT_KEY))).toBeNull();
    expect(window.sessionStorage.getItem(draftCacheKey(NAMESPACE_B, DRAFT_KEY))).not.toBeNull();
    expect(window.sessionStorage.getItem("unrelated-session")).toBe("keep");
    expect(emergencyRecords()).toHaveLength(1);
    expect(window.localStorage.getItem("unrelated-local")).toBe("keep");
  });

  it("globally purges only Codestead recovery records", async () => {
    seedWarmStorage();
    writeEmergencyExamEvent(window.localStorage, eventRecord());
    window.localStorage.setItem("unrelated-local", "keep");
    const boundaries: string[] = [];
    const unsubscribe = subscribeBrowserRecoveryBoundary((boundary) => {
      boundaries.push(boundary.kind);
    });
    const repo = repository();

    try {
      await purgeBrowserRecoveryData({
        sessionStorage: window.sessionStorage,
        localStorage: window.localStorage,
        repository: repo,
      });
    } finally {
      unsubscribe();
    }

    expect(boundaries).toEqual(["all"]);
    expect(repo.clearAll).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem("unrelated-session")).toBe("keep");
    expect(window.sessionStorage.length).toBe(1);
    expect(window.localStorage.getItem("unrelated-local")).toBe("keep");
    expect(emergencyRecords()).toHaveLength(0);
  });

  it("prepares a namespace by deleting foreign and malformed app recovery only", async () => {
    seedWarmStorage();
    writeEmergencyExamEvent(window.localStorage, eventRecord());
    writeEmergencyExamEvent(
      window.localStorage,
      eventRecord(NAMESPACE_B, SESSION_A, "event-foreign-0001"),
    );
    window.localStorage.setItem("codestead:exam-event-emergency:v1:malformed", "bad");
    const repo = repository();

    await prepareBrowserRecoveryNamespace({
      namespace: NAMESPACE_A,
      sessionStorage: window.sessionStorage,
      localStorage: window.localStorage,
      repository: repo,
    });

    expect(repo.clearForeignNamespaces).toHaveBeenCalledWith(NAMESPACE_A);
    expect(window.sessionStorage.getItem(draftCacheKey(NAMESPACE_A, DRAFT_KEY))).not.toBeNull();
    expect(window.sessionStorage.getItem(draftCacheKey(NAMESPACE_B, DRAFT_KEY))).toBeNull();
    expect(window.localStorage.length).toBe(1);
  });

  it("keeps exam recovery during draft-only purge and other exams during exact-exam purge", async () => {
    seedWarmStorage();
    writeEmergencyExamEvent(window.localStorage, eventRecord());
    writeEmergencyExamEvent(
      window.localStorage,
      eventRecord(NAMESPACE_A, SESSION_B, "event-other-exam-0001"),
    );
    const boundaries: string[] = [];
    const unsubscribe = subscribeBrowserRecoveryBoundary((boundary) => {
      boundaries.push(boundary.kind);
    });
    const repo = repository();

    try {
      await purgeDraftRecoveryData({
        namespace: NAMESPACE_A,
        sessionStorage: window.sessionStorage,
        repository: repo,
      });
      expect(repo.clearDrafts).toHaveBeenCalledWith(NAMESPACE_A);
      expect(emergencyRecords()).toHaveLength(2);

      await purgeExamRecoveryData({
        namespace: NAMESPACE_A,
        sessionId: SESSION_A,
        sessionStorage: window.sessionStorage,
        localStorage: window.localStorage,
        repository: repo,
      });
    } finally {
      unsubscribe();
    }

    expect(boundaries).toEqual(["drafts", "exam"]);
    expect(repo.clearExamSession).toHaveBeenCalledWith(NAMESPACE_A, SESSION_A);
    expect(emergencyRecords()).toHaveLength(1);
  });

  it("removes exactly one namespace across a real three-layer recovery matrix", async () => {
    const factory = new FakeIDBFactory();
    const repo = await openBrowserOutbox(factory);
    try {
      const records = await seedOutboxMatrix(repo);
      seedWarmStorage();
      writeEmergencyExamEvent(window.localStorage, records.eventAA);
      writeEmergencyExamEvent(window.localStorage, records.eventAB);
      writeEmergencyExamEvent(window.localStorage, records.eventBA);
      window.localStorage.setItem("unrelated-local", "keep");

      await purgeBrowserRecoveryData({
        namespace: NAMESPACE_A,
        sessionStorage: window.sessionStorage,
        localStorage: window.localStorage,
        repository: repo,
      });

      await expect(repo.getDraft(NAMESPACE_A, DRAFT_KEY)).resolves.toBeNull();
      await expect(repo.listExamAnswers(NAMESPACE_A, SESSION_A)).resolves.toEqual([]);
      await expect(repo.listExamAnswers(NAMESPACE_A, SESSION_B)).resolves.toEqual([]);
      await expect(repo.listExamEvents(NAMESPACE_A, SESSION_A)).resolves.toEqual([]);
      await expect(repo.getDraft(NAMESPACE_B, DRAFT_KEY_B)).resolves.toEqual(records.draftB);
      await expect(repo.listExamAnswers(NAMESPACE_B, SESSION_A)).resolves.toEqual([
        records.answerBA,
      ]);
      expect(window.sessionStorage.getItem(draftCacheKey(NAMESPACE_A, DRAFT_KEY))).toBeNull();
      expect(window.sessionStorage.getItem(draftCacheKey(NAMESPACE_B, DRAFT_KEY))).not.toBeNull();
      expect(emergencyRecords()).toEqual([records.eventBA]);
      expect(window.sessionStorage.getItem("unrelated-session")).toBe("keep");
      expect(window.localStorage.getItem("unrelated-local")).toBe("keep");
    } finally {
      repo.close();
    }
  });

  it("globally removes every real Codestead recovery record and keeps unrelated storage", async () => {
    const factory = new FakeIDBFactory();
    const repo = await openBrowserOutbox(factory);
    try {
      const records = await seedOutboxMatrix(repo);
      seedWarmStorage();
      writeEmergencyExamEvent(window.localStorage, records.eventAA);
      writeEmergencyExamEvent(window.localStorage, records.eventBA);
      window.localStorage.setItem("unrelated-local", "keep");

      await purgeBrowserRecoveryData({
        sessionStorage: window.sessionStorage,
        localStorage: window.localStorage,
        repository: repo,
      });

      await expect(repo.getDraft(NAMESPACE_A, DRAFT_KEY)).resolves.toBeNull();
      await expect(repo.getDraft(NAMESPACE_B, DRAFT_KEY_B)).resolves.toBeNull();
      await expect(repo.listExamAnswers(NAMESPACE_A, SESSION_A)).resolves.toEqual([]);
      await expect(repo.listExamEvents(NAMESPACE_B, SESSION_A)).resolves.toEqual([]);
      expect(window.sessionStorage.getItem("unrelated-session")).toBe("keep");
      expect(window.sessionStorage.length).toBe(1);
      expect(window.localStorage.getItem("unrelated-local")).toBe("keep");
      expect(emergencyRecords()).toHaveLength(0);
    } finally {
      repo.close();
    }
  });

  it("prepares a real namespace without orphaning its current recovery", async () => {
    const factory = new FakeIDBFactory();
    const repo = await openBrowserOutbox(factory);
    try {
      const records = await seedOutboxMatrix(repo);
      seedWarmStorage();
      writeEmergencyExamEvent(window.localStorage, records.eventAA);
      writeEmergencyExamEvent(window.localStorage, records.eventBA);
      window.localStorage.setItem("codestead:exam-event-emergency:v1:malformed", "bad");

      await prepareBrowserRecoveryNamespace({
        namespace: NAMESPACE_A,
        sessionStorage: window.sessionStorage,
        localStorage: window.localStorage,
        repository: repo,
      });

      await expect(repo.getDraft(NAMESPACE_A, DRAFT_KEY)).resolves.toEqual(records.draftA);
      await expect(repo.listExamAnswers(NAMESPACE_A, SESSION_A)).resolves.toEqual([
        records.answerAA,
      ]);
      await expect(repo.getDraft(NAMESPACE_B, DRAFT_KEY_B)).resolves.toBeNull();
      await expect(repo.listExamAnswers(NAMESPACE_B, SESSION_A)).resolves.toEqual([]);
      expect(window.sessionStorage.getItem(draftCacheKey(NAMESPACE_A, DRAFT_KEY))).not.toBeNull();
      expect(window.sessionStorage.getItem(draftCacheKey(NAMESPACE_B, DRAFT_KEY))).toBeNull();
      expect(emergencyRecords()).toEqual([records.eventAA]);
      expect(window.localStorage.getItem("codestead:exam-event-emergency:v1:malformed")).toBeNull();
    } finally {
      repo.close();
    }
  });

  it("keeps real exam recovery on draft purge and scopes terminal purge to one exam", async () => {
    const factory = new FakeIDBFactory();
    const repo = await openBrowserOutbox(factory);
    try {
      const records = await seedOutboxMatrix(repo);
      seedWarmStorage();
      writeEmergencyExamEvent(window.localStorage, records.eventAA);
      writeEmergencyExamEvent(window.localStorage, records.eventAB);
      writeEmergencyExamEvent(window.localStorage, records.eventBA);

      await purgeDraftRecoveryData({
        namespace: NAMESPACE_A,
        sessionStorage: window.sessionStorage,
        repository: repo,
      });

      await expect(repo.getDraft(NAMESPACE_A, DRAFT_KEY)).resolves.toBeNull();
      await expect(repo.listExamAnswers(NAMESPACE_A, SESSION_A)).resolves.toEqual([
        records.answerAA,
      ]);
      await expect(repo.listExamEvents(NAMESPACE_A, SESSION_A)).resolves.toEqual([
        records.eventAA,
      ]);
      expect(emergencyRecords()).toHaveLength(3);

      await repo.putDraft(records.draftA);
      await purgeExamRecoveryData({
        namespace: NAMESPACE_A,
        sessionId: SESSION_A,
        sessionStorage: window.sessionStorage,
        localStorage: window.localStorage,
        repository: repo,
      });

      await expect(repo.getDraft(NAMESPACE_A, DRAFT_KEY)).resolves.toEqual(records.draftA);
      await expect(repo.listExamAnswers(NAMESPACE_A, SESSION_A)).resolves.toEqual([]);
      await expect(repo.listExamEvents(NAMESPACE_A, SESSION_A)).resolves.toEqual([]);
      await expect(repo.listExamAnswers(NAMESPACE_A, SESSION_B)).resolves.toEqual([
        records.answerAB,
      ]);
      await expect(repo.listExamEvents(NAMESPACE_A, SESSION_B)).resolves.toEqual([
        records.eventAB,
      ]);
      await expect(repo.listExamAnswers(NAMESPACE_B, SESSION_A)).resolves.toEqual([
        records.answerBA,
      ]);
      expect(emergencyRecords()).toEqual(expect.arrayContaining([
        records.eventAB,
        records.eventBA,
      ]));
      expect(emergencyRecords()).toHaveLength(2);
    } finally {
      repo.close();
    }
  });

  it("purges malformed canonical emergency values by exact key identity", async () => {
    const target = eventRecord(NAMESPACE_A, SESSION_A, "event-target-0001");
    const sibling = eventRecord(NAMESPACE_A, SESSION_B, "event-sibling-0001");
    const foreign = eventRecord(NAMESPACE_B, SESSION_A, "event-foreign-0001");
    for (const record of [target, sibling, foreign]) {
      window.localStorage.setItem(emergencyKey(record), "{corrupted-json");
    }
    const repo = repository();

    await purgeExamRecoveryData({
      namespace: NAMESPACE_A,
      sessionId: SESSION_A,
      sessionStorage: window.sessionStorage,
      localStorage: window.localStorage,
      repository: repo,
    });

    expect(window.localStorage.getItem(emergencyKey(target))).toBeNull();
    expect(window.localStorage.getItem(emergencyKey(sibling))).toBe("{corrupted-json");
    expect(window.localStorage.getItem(emergencyKey(foreign))).toBe("{corrupted-json");

    await purgeBrowserRecoveryData({
      namespace: NAMESPACE_A,
      sessionStorage: window.sessionStorage,
      localStorage: window.localStorage,
      repository: repo,
    });

    expect(window.localStorage.getItem(emergencyKey(sibling))).toBeNull();
    expect(window.localStorage.getItem(emergencyKey(foreign))).toBe("{corrupted-json");
  });

  it("fences subscribers synchronously, prevents resurrection, unsubscribes, and is idempotent", async () => {
    const factory = new FakeIDBFactory();
    const repo = await openBrowserOutbox(factory);
    const draft = draftRecord(NAMESPACE_A);
    await repo.putDraft(draft);
    let retired = false;
    let releases = 0;
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const lateWriter = writerGate.then(async () => {
      if (!retired) await repo.putDraft(draft);
    });
    const unsubscribe = subscribeBrowserRecoveryBoundary((boundary) => {
      if (boundary.kind === "namespace" && boundary.namespace === NAMESPACE_A) {
        retired = true;
        releases += 1;
      }
    });
    try {
      const cleanup = purgeBrowserRecoveryData({
        namespace: NAMESPACE_A,
        sessionStorage: window.sessionStorage,
        localStorage: window.localStorage,
        repository: repo,
      });
      expect(retired).toBe(true);
      releaseWriter();
      await Promise.all([cleanup, lateWriter]);
      await expect(repo.getDraft(NAMESPACE_A, DRAFT_KEY)).resolves.toBeNull();

      unsubscribe();
      await expect(purgeBrowserRecoveryData({
        namespace: NAMESPACE_A,
        sessionStorage: window.sessionStorage,
        localStorage: window.localStorage,
        repository: repo,
      })).resolves.toBeUndefined();
      expect(releases).toBe(1);
      await expect(repo.getDraft(NAMESPACE_A, DRAFT_KEY)).resolves.toBeNull();
    } finally {
      unsubscribe();
      repo.close();
    }
  });

  it("attempts every layer, redacts failures, and succeeds when retried", async () => {
    seedWarmStorage();
    writeEmergencyExamEvent(window.localStorage, eventRecord());
    const clearNamespace = vi
      .fn<BrowserOutboxRepository["clearNamespace"]>()
      .mockRejectedValueOnce(new Error("database contains answer alpha"))
      .mockResolvedValueOnce(undefined);
    const repo = repository({ clearNamespace });
    const removeItem = window.sessionStorage.removeItem.bind(window.sessionStorage);
    let sessionFailure = true;
    const flakySessionStorage = new Proxy(window.sessionStorage, {
      get(target, property, receiver) {
        if (property === "removeItem") {
          return (key: string) => {
            if (sessionFailure) {
              sessionFailure = false;
              throw new Error("draft contains answer = 42");
            }
            return removeItem(key);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const first = purgeBrowserRecoveryData({
      namespace: NAMESPACE_A,
      sessionStorage: flakySessionStorage,
      localStorage: window.localStorage,
      repository: repo,
    });
    await expect(first).rejects.toThrow("session-storage, indexed-db");
    await expect(first).rejects.not.toThrow(/answer alpha|answer = 42|namespace-alpha/i);
    expect(emergencyRecords()).toHaveLength(0);
    expect(clearNamespace).toHaveBeenCalledOnce();

    await expect(purgeBrowserRecoveryData({
      namespace: NAMESPACE_A,
      sessionStorage: window.sessionStorage,
      localStorage: window.localStorage,
      repository: repo,
    })).resolves.toBeUndefined();
    expect(clearNamespace).toHaveBeenCalledTimes(2);
  });

  it("propagates an origin-scoped boundary to an independent tab and clears that tab's exact session recovery", async () => {
    const sharedLocalStorage = new MemoryStorage();
    const firstSessionStorage = new MemoryStorage();
    const secondSessionStorage = new MemoryStorage();
    const hub = new BoundaryChannelHub();
    const firstTab = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: firstSessionStorage,
      channel: hub.create(),
      sourceId: "tab-alpha",
    });
    const secondTab = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: secondSessionStorage,
      channel: hub.create(),
      sourceId: "tab-beta",
    });
    writeDraftCache(secondSessionStorage, NAMESPACE_A, DRAFT_KEY, {
      schemaVersion: 1,
      content: "stale tab answer",
      language: "python",
      baseRowVersion: 0,
      requestId: "10000000-0000-4000-8000-000000000001",
      locallyUpdatedAt: "2026-07-15T01:00:00.000Z",
      dirty: true,
    });
    writeDraftCache(secondSessionStorage, NAMESPACE_B, DRAFT_KEY, {
      schemaVersion: 1,
      content: "foreign learner answer",
      language: "python",
      baseRowVersion: 0,
      requestId: "10000000-0000-4000-8000-000000000002",
      locallyUpdatedAt: "2026-07-15T01:00:00.000Z",
      dirty: true,
    });
    const fence = secondTab.captureWriteFence({ kind: "drafts", namespace: NAMESPACE_A });
    const received: string[] = [];
    const unsubscribe = secondTab.subscribe((boundary) => received.push(boundary.kind));

    try {
      await purgeBrowserRecoveryData({
        namespace: NAMESPACE_A,
        sessionStorage: firstSessionStorage,
        localStorage: sharedLocalStorage,
        repository: repository(),
        boundaryContext: firstTab,
      });
      await Promise.resolve();

      expect(received).toEqual(["namespace"]);
      expect(secondTab.isWriteFenceCurrent(fence)).toBe(false);
      expect(secondSessionStorage.getItem(draftCacheKey(NAMESPACE_A, DRAFT_KEY))).toBeNull();
      expect(secondSessionStorage.getItem(draftCacheKey(NAMESPACE_B, DRAFT_KEY))).not.toBeNull();
    } finally {
      unsubscribe();
      firstTab.close();
      secondTab.close();
    }
  });

  it("keeps cross-tab draft, exam, namespace, and global generations exactly scoped", async () => {
    const sharedLocalStorage = new MemoryStorage();
    const firstSessionStorage = new MemoryStorage();
    const secondSessionStorage = new MemoryStorage();
    const hub = new BoundaryChannelHub();
    const firstTab = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: firstSessionStorage,
      channel: hub.create(),
      sourceId: "tab-scope-alpha",
    });
    const secondTab = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: secondSessionStorage,
      channel: hub.create(),
      sourceId: "tab-scope-beta",
    });
    const repo = repository();
    const draftA = secondTab.captureWriteFence({ kind: "drafts", namespace: NAMESPACE_A });
    const draftB = secondTab.captureWriteFence({ kind: "drafts", namespace: NAMESPACE_B });
    const examA = secondTab.captureWriteFence({
      kind: "exam",
      namespace: NAMESPACE_A,
      sessionId: SESSION_A,
    });
    const examB = secondTab.captureWriteFence({
      kind: "exam",
      namespace: NAMESPACE_A,
      sessionId: SESSION_B,
    });

    try {
      await purgeDraftRecoveryData({
        namespace: NAMESPACE_A,
        sessionStorage: firstSessionStorage,
        repository: repo,
        boundaryContext: firstTab,
      });
      await Promise.resolve();
      expect(secondTab.isWriteFenceCurrent(draftA)).toBe(false);
      expect(secondTab.isWriteFenceCurrent(draftB)).toBe(true);
      expect(secondTab.isWriteFenceCurrent(examA)).toBe(true);
      expect(secondTab.isWriteFenceCurrent(examB)).toBe(true);

      const currentExamA = secondTab.captureWriteFence({
        kind: "exam",
        namespace: NAMESPACE_A,
        sessionId: SESSION_A,
      });
      const currentExamB = secondTab.captureWriteFence({
        kind: "exam",
        namespace: NAMESPACE_A,
        sessionId: SESSION_B,
      });
      await purgeExamRecoveryData({
        namespace: NAMESPACE_A,
        sessionId: SESSION_A,
        sessionStorage: firstSessionStorage,
        localStorage: sharedLocalStorage,
        repository: repo,
        boundaryContext: firstTab,
      });
      await Promise.resolve();
      expect(secondTab.isWriteFenceCurrent(currentExamA)).toBe(false);
      expect(secondTab.isWriteFenceCurrent(currentExamB)).toBe(true);

      const currentDraftA = secondTab.captureWriteFence({ kind: "drafts", namespace: NAMESPACE_A });
      const currentDraftB = secondTab.captureWriteFence({ kind: "drafts", namespace: NAMESPACE_B });
      await purgeBrowserRecoveryData({
        namespace: NAMESPACE_A,
        sessionStorage: firstSessionStorage,
        localStorage: sharedLocalStorage,
        repository: repo,
        boundaryContext: firstTab,
      });
      await Promise.resolve();
      expect(secondTab.isWriteFenceCurrent(currentDraftA)).toBe(false);
      expect(secondTab.isWriteFenceCurrent(currentDraftB)).toBe(true);

      const currentGlobalB = secondTab.captureWriteFence({ kind: "drafts", namespace: NAMESPACE_B });
      await purgeBrowserRecoveryData({
        sessionStorage: firstSessionStorage,
        localStorage: sharedLocalStorage,
        repository: repo,
        boundaryContext: firstTab,
      });
      await Promise.resolve();
      expect(secondTab.isWriteFenceCurrent(currentGlobalB)).toBe(false);
    } finally {
      firstTab.close();
      secondTab.close();
    }
  });

  it("compacts scoped durable tombstones after a global boundary without reopening old fences", async () => {
    const sharedLocalStorage = new MemoryStorage();
    const firstSessionStorage = new MemoryStorage();
    const secondSessionStorage = new MemoryStorage();
    const hub = new BoundaryChannelHub();
    const firstTab = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: firstSessionStorage,
      channel: hub.create(),
      sourceId: "tab-compaction-alpha",
    });
    const secondTab = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: secondSessionStorage,
      channel: hub.create(),
      sourceId: "tab-compaction-beta",
    });
    const repo = repository();
    try {
      for (const sessionId of [SESSION_A, SESSION_B, "session-gamma", "session-delta"]) {
        await purgeExamRecoveryData({
          namespace: NAMESPACE_A,
          sessionId,
          sessionStorage: firstSessionStorage,
          localStorage: sharedLocalStorage,
          repository: repo,
          boundaryContext: firstTab,
        });
      }
      const boundaryKeys = () => sharedLocalStorage.entries()
        .map(([key]) => key)
        .filter((key) => key.startsWith("codestead:browser-recovery-boundary:v1:"));
      expect(boundaryKeys()).toHaveLength(4);
      const stale = secondTab.captureWriteFence({ kind: "drafts", namespace: NAMESPACE_B });

      await purgeBrowserRecoveryData({
        sessionStorage: firstSessionStorage,
        localStorage: sharedLocalStorage,
        repository: repo,
        boundaryContext: firstTab,
      });
      await Promise.resolve();

      expect(boundaryKeys()).toEqual(["codestead:browser-recovery-boundary:v1:all"]);
      expect(secondTab.isWriteFenceCurrent(stale)).toBe(false);
      expect(secondTab.isWriteFenceCurrent(
        secondTab.captureWriteFence({ kind: "drafts", namespace: NAMESPACE_B }),
      )).toBe(true);
    } finally {
      firstTab.close();
      secondTab.close();
    }
  });

  it("reports a durable-boundary quota failure while still attempting every cleanup layer", async () => {
    const sharedLocalStorage = new MemoryStorage();
    const flakyLocalStorage = new Proxy(sharedLocalStorage, {
      get(target, property, receiver) {
        if (property === "setItem") {
          return () => { throw new DOMException("quota", "QuotaExceededError"); };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const sessionStorage = new MemoryStorage();
    const clearNamespace = vi.fn(async () => undefined);
    const repo = repository({ clearNamespace });
    const context = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: flakyLocalStorage,
      sessionStorage,
      channel: null,
      sourceId: "tab-quota-failure",
    });
    try {
      await expect(purgeBrowserRecoveryData({
        namespace: NAMESPACE_A,
        sessionStorage,
        localStorage: flakyLocalStorage,
        repository: repo,
        boundaryContext: context,
      })).rejects.toThrow("local-storage");
      expect(clearNamespace).toHaveBeenCalledWith(NAMESPACE_A);
    } finally {
      context.close();
    }
  });

  it("rolls back a late independent-tab write that completes after the durable boundary", async () => {
    const factory = new FakeIDBFactory();
    const repo = await openBrowserOutbox(factory);
    const sharedLocalStorage = new MemoryStorage();
    const firstSessionStorage = new MemoryStorage();
    const secondSessionStorage = new MemoryStorage();
    const hub = new BoundaryChannelHub();
    const firstTab = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: firstSessionStorage,
      channel: hub.create(),
      sourceId: "tab-late-alpha",
    });
    const secondTab = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: secondSessionStorage,
      channel: hub.create(),
      sourceId: "tab-late-beta",
    });
    const fence = secondTab.captureWriteFence({ kind: "drafts", namespace: NAMESPACE_A });
    const gate = deferred<void>();
    const started = deferred<void>();
    const record = draftRecord(NAMESPACE_A);
    const lateWrite = secondTab.guardWrite(
      fence,
      async () => {
        started.resolve();
        await gate.promise;
        await repo.putDraft(record);
      },
      () => repo.deleteDraftIfMutation(NAMESPACE_A, DRAFT_KEY, record.requestId),
    );

    try {
      await started.promise;
      await purgeBrowserRecoveryData({
        namespace: NAMESPACE_A,
        sessionStorage: firstSessionStorage,
        localStorage: sharedLocalStorage,
        repository: repo,
        boundaryContext: firstTab,
      });
      gate.resolve();
      await expect(lateWrite).rejects.toMatchObject({ name: "AbortError" });
      await expect(repo.getDraft(NAMESPACE_A, DRAFT_KEY)).resolves.toBeNull();
    } finally {
      firstTab.close();
      secondTab.close();
      repo.close();
    }
  });

  it("clears cloned stale session recovery when a tab opens after the durable boundary", async () => {
    const sharedLocalStorage = new MemoryStorage();
    const staleSession = new MemoryStorage();
    writeDraftCache(staleSession, NAMESPACE_A, DRAFT_KEY, {
      schemaVersion: 1,
      content: "cloned before revocation",
      language: "python",
      baseRowVersion: 0,
      requestId: "10000000-0000-4000-8000-000000000001",
      locallyUpdatedAt: "2026-07-15T01:00:00.000Z",
      dirty: true,
    });
    writeDraftCache(staleSession, NAMESPACE_B, DRAFT_KEY, {
      schemaVersion: 1,
      content: "other namespace",
      language: "python",
      baseRowVersion: 0,
      requestId: "10000000-0000-4000-8000-000000000002",
      locallyUpdatedAt: "2026-07-15T01:00:00.000Z",
      dirty: true,
    });
    const hub = new BoundaryChannelHub();
    const firstTab = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: new MemoryStorage(),
      channel: hub.create(),
      sourceId: "tab-open-alpha",
    });
    await purgeBrowserRecoveryData({
      namespace: NAMESPACE_A,
      sessionStorage: new MemoryStorage(),
      localStorage: sharedLocalStorage,
      repository: repository(),
      boundaryContext: firstTab,
    });
    const openedLater = new MemoryStorage(staleSession.entries());
    const laterTab = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: openedLater,
      channel: hub.create(),
      sourceId: "tab-open-beta",
    });

    try {
      expect(() => laterTab.captureWriteFence({
        kind: "drafts",
        namespace: NAMESPACE_A,
      })).not.toThrow();
      expect(openedLater.getItem(draftCacheKey(NAMESPACE_A, DRAFT_KEY))).toBeNull();
      expect(openedLater.getItem(draftCacheKey(NAMESPACE_B, DRAFT_KEY))).not.toBeNull();
    } finally {
      firstTab.close();
      laterTab.close();
    }
  });

  it("ignores malformed, foreign-origin, and non-durable boundary messages", async () => {
    const sharedLocalStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    const hub = new BoundaryChannelHub();
    const tab = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage,
      channel: hub.create(),
      sourceId: "tab-validation",
    });
    writeDraftCache(sessionStorage, NAMESPACE_A, DRAFT_KEY, {
      schemaVersion: 1,
      content: "must survive forged messages",
      language: "python",
      baseRowVersion: 0,
      requestId: "10000000-0000-4000-8000-000000000001",
      locallyUpdatedAt: "2026-07-15T01:00:00.000Z",
      dirty: true,
    });
    const received = vi.fn();
    const unsubscribe = tab.subscribe(received);

    try {
      hub.inject("not-json");
      hub.inject(JSON.stringify({
        schemaVersion: 1,
        origin: "https://evil.example",
        generation: 1,
        nonce: "forged-message",
        sourceId: "foreign-tab",
        createdAt: "2026-07-15T01:00:00.000Z",
        boundary: { kind: "namespace", namespace: NAMESPACE_A },
      }));
      hub.inject(JSON.stringify({
        schemaVersion: 1,
        origin: "https://codestead.test",
        generation: 1,
        nonce: "unpersisted-message",
        sourceId: "same-origin-forgery",
        createdAt: "2026-07-15T01:00:00.000Z",
        boundary: { kind: "namespace", namespace: NAMESPACE_A },
      }));
      await Promise.resolve();

      expect(received).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(draftCacheKey(NAMESPACE_A, DRAFT_KEY))).not.toBeNull();
    } finally {
      unsubscribe();
      tab.close();
    }
  });
});
