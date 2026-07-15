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
  type BrowserRecoveryBoundary,
  type BrowserRecoveryBoundaryChannel,
  type BrowserRecoveryWriteFence,
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
  readonly #pending: Array<() => void> = [];
  #paused = false;

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
          const deliver = () => {
            if (peer.closed) return;
            const event = { data: message } as MessageEvent<unknown>;
            for (const listener of peer.listeners) listener(event);
          };
          if (this.#paused) this.#pending.push(deliver);
          else queueMicrotask(deliver);
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

  pause() {
    this.#paused = true;
  }

  flush() {
    this.#paused = false;
    for (const deliver of this.#pending.splice(0)) deliver();
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

type InvalidCompactionState = "active" | "malformed" | "nonce-mismatched";

function seedValidCompactionState(
  storage: Storage,
  origin = "https://codestead.test",
) {
  const nonce = "current-valid-generation-nonce-0001";
  storage.setItem("codestead:browser-recovery-boundary:v1:all", JSON.stringify({
    schemaVersion: 1,
    origin,
    generation: 1,
    nonce,
    sourceId: "tab-valid-generation",
    createdAt: "2026-07-15T01:00:00.000Z",
    boundary: { kind: "all" },
  }));
  storage.setItem("codestead:browser-recovery-compaction:v1", JSON.stringify({
    schemaVersion: 1,
    origin,
    phase: "complete",
    globalNonce: nonce,
    sourceId: "tab-valid-generation",
  }));
}

function forceInvalidCompactionState(
  storage: Storage,
  state: InvalidCompactionState,
  origin = "https://codestead.test",
) {
  const compactionKey = "codestead:browser-recovery-compaction:v1";
  if (state === "malformed") {
    storage.setItem(compactionKey, "{malformed");
    return;
  }
  const globalRaw = storage.getItem("codestead:browser-recovery-boundary:v1:all");
  if (globalRaw === null) throw new Error("A global boundary is required by this fixture.");
  const globalEnvelope = JSON.parse(globalRaw) as { nonce: string };
  storage.setItem(compactionKey, JSON.stringify({
    schemaVersion: 1,
    origin,
    phase: state === "active" ? "active" : "complete",
    globalNonce: state === "active"
      ? globalEnvelope.nonce
      : "different-invalid-generation-nonce-0001",
    sourceId: `tab-invalid-${state}`,
  }));
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

  it.each(["active", "malformed", "nonce-mismatched"] as const)(
    "rejects namespace preparation when global compaction is %s",
    async (state) => {
      const localStorage = new MemoryStorage();
      const origin = window.location.origin;
      if (state === "malformed") {
        localStorage.setItem("codestead:browser-recovery-compaction:v1", "{malformed");
      } else if (state === "active") {
        localStorage.setItem("codestead:browser-recovery-compaction:v1", JSON.stringify({
          schemaVersion: 1,
          origin,
          phase: "active",
          globalNonce: "active-global-nonce-0001",
          sourceId: "tab-preparation-active",
        }));
      } else {
        localStorage.setItem("codestead:browser-recovery-boundary:v1:all", JSON.stringify({
          schemaVersion: 1,
          origin,
          generation: 1,
          nonce: "current-global-nonce-0001",
          sourceId: "tab-preparation-global",
          createdAt: "2026-07-15T01:00:00.000Z",
          boundary: { kind: "all" },
        }));
        localStorage.setItem("codestead:browser-recovery-compaction:v1", JSON.stringify({
          schemaVersion: 1,
          origin,
          phase: "complete",
          globalNonce: "different-global-nonce-0001",
          sourceId: "tab-preparation-complete",
        }));
      }
      const clearForeignNamespaces = vi.fn(async () => undefined);
      const repo = repository({ clearForeignNamespaces });

      await expect(prepareBrowserRecoveryNamespace({
        namespace: NAMESPACE_A,
        sessionStorage: new MemoryStorage(),
        localStorage,
        repository: repo,
      })).rejects.toThrow("Browser recovery cleanup failed: local-storage.");
      expect(clearForeignNamespaces).toHaveBeenCalledWith(NAMESPACE_A);
    },
  );

  it.each(["active", "malformed", "nonce-mismatched"] as const)(
    "rechecks %s compaction only after every namespace cleanup layer settles",
    async (state) => {
      const localStorage = new MemoryStorage();
      const sessionStorage = new MemoryStorage();
      const origin = window.location.origin;
      seedValidCompactionState(localStorage, origin);
      writeDraftCache(sessionStorage, NAMESPACE_B, DRAFT_KEY, {
        schemaVersion: 1,
        content: "foreign warm recovery",
        language: "python",
        baseRowVersion: 0,
        requestId: "10000000-0000-4000-8000-000000000088",
        locallyUpdatedAt: "2026-07-15T01:00:00.000Z",
        dirty: true,
      });
      const foreignEmergency = eventRecord(
        NAMESPACE_B,
        SESSION_A,
        "event-preparation-race-0001",
      );
      writeEmergencyExamEvent(localStorage, foreignEmergency);
      const started = deferred<void>();
      const release = deferred<void>();
      const clearForeignNamespaces = vi.fn(async () => {
        started.resolve();
        await release.promise;
      });
      const preparation = prepareBrowserRecoveryNamespace({
        namespace: NAMESPACE_A,
        sessionStorage,
        localStorage,
        repository: repository({ clearForeignNamespaces }),
      });

      await started.promise;
      await Promise.resolve();
      forceInvalidCompactionState(localStorage, state, origin);
      release.resolve();

      await expect(preparation).rejects.toThrow(
        "Browser recovery cleanup failed: local-storage.",
      );
      expect(clearForeignNamespaces).toHaveBeenCalledWith(NAMESPACE_A);
      expect(sessionStorage.getItem(draftCacheKey(NAMESPACE_B, DRAFT_KEY))).toBeNull();
      expect(localStorage.getItem(emergencyKey(foreignEmergency))).toBeNull();
    },
  );

  it("aggregates a final preparation-fence failure with prior cleanup failures", async () => {
    const localStorage = new MemoryStorage();
    const origin = window.location.origin;
    seedValidCompactionState(localStorage, origin);
    const started = deferred<void>();
    const release = deferred<void>();
    const preparation = prepareBrowserRecoveryNamespace({
      namespace: NAMESPACE_A,
      sessionStorage: new MemoryStorage(),
      localStorage,
      repository: repository({
        clearForeignNamespaces: vi.fn(async () => {
          started.resolve();
          await release.promise;
          throw new Error("private indexed db detail");
        }),
      }),
    });

    await started.promise;
    await Promise.resolve();
    forceInvalidCompactionState(localStorage, "active", origin);
    release.resolve();

    await expect(preparation).rejects.toThrow(
      "Browser recovery cleanup failed: indexed-db, local-storage.",
    );
    await expect(preparation).rejects.not.toThrow("private indexed db detail");
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
      get(target, property) {
        if (property === "removeItem") {
          return (key: string) => {
            if (sessionFailure) {
              sessionFailure = false;
              throw new Error("draft contains answer = 42");
            }
            return removeItem(key);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
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

  it("preserves post-boundary draft and practice recovery when a durable notice is delayed", async () => {
    const sharedLocalStorage = new MemoryStorage();
    const writerSessionStorage = new MemoryStorage();
    const practiceKey = `${DRAFT_CACHE_PREFIX}${encodeURIComponent(NAMESPACE_A)}:practice-run:${"a".repeat(64)}`;
    writeDraftCache(writerSessionStorage, NAMESPACE_A, DRAFT_KEY, {
      schemaVersion: 1,
      content: "stale before boundary",
      language: "python",
      baseRowVersion: 0,
      requestId: "10000000-0000-4000-8000-000000000001",
      locallyUpdatedAt: "2026-07-15T01:00:00.000Z",
      dirty: true,
    });
    writerSessionStorage.setItem(
      practiceKey,
      "20000000-0000-4000-8000-000000000001",
    );
    const hub = new BoundaryChannelHub();
    hub.pause();
    const publisher = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: new MemoryStorage(),
      channel: hub.create(),
      sourceId: "tab-delayed-publisher",
    });
    const writer = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: writerSessionStorage,
      channel: hub.create(),
      sourceId: "tab-delayed-writer",
    });

    try {
      await purgeBrowserRecoveryData({
        namespace: NAMESPACE_A,
        sessionStorage: new MemoryStorage(),
        localStorage: sharedLocalStorage,
        repository: repository(),
        boundaryContext: publisher,
      });
      const fence = writer.captureWriteFence({ kind: "drafts", namespace: NAMESPACE_A });
      expect(writerSessionStorage.getItem(draftCacheKey(NAMESPACE_A, DRAFT_KEY))).toBeNull();
      expect(writerSessionStorage.getItem(practiceKey)).toBeNull();
      writeDraftCache(writerSessionStorage, NAMESPACE_A, DRAFT_KEY, {
        schemaVersion: 1,
        content: "created after observing boundary",
        language: "python",
        baseRowVersion: 0,
        requestId: "10000000-0000-4000-8000-000000000002",
        locallyUpdatedAt: "2026-07-15T02:00:00.000Z",
        dirty: true,
      });
      writerSessionStorage.setItem(
        practiceKey,
        "20000000-0000-4000-8000-000000000002",
      );
      let retired = false;
      const subscribeAfterFence = (writer as unknown as {
        subscribeAfterFence?: (
          capturedFence: BrowserRecoveryWriteFence,
          listener: (boundary: BrowserRecoveryBoundary) => void,
        ) => () => void;
      }).subscribeAfterFence;
      expect(subscribeAfterFence).toBeTypeOf("function");
      const unsubscribe = subscribeAfterFence!.call(writer, fence, () => { retired = true; });

      hub.flush();

      expect(retired).toBe(false);
      expect(writer.isWriteFenceCurrent(fence)).toBe(true);
      expect(writerSessionStorage.getItem(draftCacheKey(NAMESPACE_A, DRAFT_KEY)))
        .not.toBeNull();
      expect(writerSessionStorage.getItem(practiceKey))
        .toBe("20000000-0000-4000-8000-000000000002");
      unsubscribe();
    } finally {
      publisher.close();
      writer.close();
    }
  });

  it("preserves post-boundary warm recovery across a fresh context with reset memory epochs", () => {
    const sharedLocalStorage = new MemoryStorage();
    const sharedSessionStorage = new MemoryStorage();
    const firstContext = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: sharedSessionStorage,
      channel: null,
      sourceId: "tab-reload-generation-before",
    });

    expect(firstContext.publish({
      kind: "drafts",
      namespace: NAMESPACE_A,
    })).toEqual([]);
    const firstFence = firstContext.captureWriteFence({
      kind: "drafts",
      namespace: NAMESPACE_A,
    });
    expect(firstContext.isWriteFenceCurrent(firstFence)).toBe(true);
    writeDraftCache(sharedSessionStorage, NAMESPACE_A, DRAFT_KEY, {
      schemaVersion: 1,
      content: "legitimate post-boundary reload recovery",
      language: "python",
      baseRowVersion: 0,
      requestId: "10000000-0000-4000-8000-000000000077",
      locallyUpdatedAt: "2026-07-15T03:30:00.000Z",
      dirty: true,
    });
    firstContext.close();

    const reloadedContext = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: sharedSessionStorage,
      channel: null,
      sourceId: "tab-reload-generation-after",
    });
    try {
      const reloadedFence = reloadedContext.captureWriteFence({
        kind: "drafts",
        namespace: NAMESPACE_A,
      });

      expect(reloadedContext.isWriteFenceCurrent(reloadedFence)).toBe(true);
      expect(sharedSessionStorage.getItem(draftCacheKey(NAMESPACE_A, DRAFT_KEY)))
        .toContain("legitimate post-boundary reload recovery");
    } finally {
      reloadedContext.close();
    }
  });

  it.each([
    ["all", "active"],
    ["all", "malformed"],
    ["all", "nonce-mismatched"],
    ["namespace", "active"],
    ["namespace", "malformed"],
    ["namespace", "nonce-mismatched"],
  ] as const)(
    "clears post-marker warm recovery after a delayed %s notice under %s compaction",
    async (boundaryKind, state) => {
      const sharedLocalStorage = new MemoryStorage();
      const writerSessionStorage = new MemoryStorage();
      const hub = new BoundaryChannelHub();
      const publisher = createBrowserRecoveryBoundaryContext({
        origin: "https://codestead.test",
        localStorage: sharedLocalStorage,
        sessionStorage: new MemoryStorage(),
        channel: hub.create(),
        sourceId: `tab-invalid-${boundaryKind}-${state}-publisher`,
      });
      const writer = createBrowserRecoveryBoundaryContext({
        origin: "https://codestead.test",
        localStorage: sharedLocalStorage,
        sessionStorage: writerSessionStorage,
        channel: hub.create(),
        sourceId: `tab-invalid-${boundaryKind}-${state}-writer`,
      });
      const draftKey = draftCacheKey(NAMESPACE_A, DRAFT_KEY);
      const stdinKey = `${draftKey}:stdin`;
      const practiceKey = `${DRAFT_CACHE_PREFIX}${encodeURIComponent(NAMESPACE_A)}:practice-run:${"b".repeat(64)}`;
      const sessionMarkerKey = `codestead:browser-recovery-session:v1:${encodeURIComponent(NAMESPACE_A)}`;

      try {
        if (boundaryKind === "namespace") {
          expect(publisher.publish({ kind: "all" })).toEqual([]);
          await Promise.resolve();
        }
        hub.pause();
        expect(publisher.publish(boundaryKind === "all"
          ? { kind: "all" }
          : { kind: "namespace", namespace: NAMESPACE_A })).toEqual([]);
        forceInvalidCompactionState(sharedLocalStorage, state);

        const invalidFence = writer.captureWriteFence({
          kind: "drafts",
          namespace: NAMESPACE_A,
        });
        expect(writer.isWriteFenceCurrent(invalidFence)).toBe(false);
        writeDraftCache(writerSessionStorage, NAMESPACE_A, DRAFT_KEY, {
          schemaVersion: 1,
          content: "written after invalid generation capture",
          language: "python",
          baseRowVersion: 0,
          requestId: "10000000-0000-4000-8000-000000000099",
          locallyUpdatedAt: "2026-07-15T03:00:00.000Z",
          dirty: true,
        });
        writerSessionStorage.setItem(stdinKey, "post-marker stdin");
        writerSessionStorage.setItem(
          practiceKey,
          "20000000-0000-4000-8000-000000000099",
        );

        hub.flush();

        expect(writerSessionStorage.getItem(draftKey)).toBeNull();
        expect(writerSessionStorage.getItem(stdinKey)).toBeNull();
        expect(writerSessionStorage.getItem(practiceKey)).toBeNull();
        expect(writerSessionStorage.getItem(sessionMarkerKey)).toBeNull();
      } finally {
        publisher.close();
        writer.close();
      }
    },
  );

  it("cannot return a current fence when a boundary lands after reconciliation", () => {
    const sharedLocalStorage = new MemoryStorage();
    const backingSessionStorage = new MemoryStorage();
    writeDraftCache(backingSessionStorage, NAMESPACE_A, DRAFT_KEY, {
      schemaVersion: 1,
      content: "stale warm recovery",
      language: "python",
      baseRowVersion: 0,
      requestId: "10000000-0000-4000-8000-000000000001",
      locallyUpdatedAt: "2026-07-15T01:00:00.000Z",
      dirty: true,
    });
    let interleaved = false;
    const writerSessionStorage = new Proxy(backingSessionStorage, {
      get(target, property) {
        if (property === "setItem") {
          return (key: string, value: string) => {
            target.setItem(key, value);
            if (!interleaved
              && key.startsWith("codestead:browser-recovery-session:v1:")) {
              interleaved = true;
              publisher.publish({ kind: "namespace", namespace: NAMESPACE_A });
            }
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const publisher = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: new MemoryStorage(),
      channel: null,
      sourceId: "tab-capture-interleaving-publisher",
    });
    const writer = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: writerSessionStorage,
      channel: null,
      sourceId: "tab-capture-interleaving-writer",
    });

    try {
      const racedFence = writer.captureWriteFence({
        kind: "drafts",
        namespace: NAMESPACE_A,
      });
      expect(interleaved).toBe(true);
      expect(writer.isWriteFenceCurrent(racedFence)).toBe(false);

      const reconciledFence = writer.captureWriteFence({
        kind: "drafts",
        namespace: NAMESPACE_A,
      });
      expect(writer.isWriteFenceCurrent(reconciledFence)).toBe(true);
      expect(backingSessionStorage.getItem(draftCacheKey(NAMESPACE_A, DRAFT_KEY)))
        .toBeNull();
    } finally {
      publisher.close();
      writer.close();
    }
  });

  it("retires a matching captured writer when local boundary publication fails", () => {
    const backingStorage = new MemoryStorage();
    const unavailableLocalStorage = new Proxy(backingStorage, {
      get(target, property) {
        if (property === "setItem") {
          return () => { throw new DOMException("quota", "QuotaExceededError"); };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const context = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: unavailableLocalStorage,
      sessionStorage: new MemoryStorage(),
      channel: null,
      sourceId: "tab-local-publication-failure",
    });

    try {
      const fence = context.captureWriteFence({ kind: "drafts", namespace: NAMESPACE_A });
      let retired = false;
      const subscribeAfterFence = (context as unknown as {
        subscribeAfterFence?: (
          capturedFence: BrowserRecoveryWriteFence,
          listener: (boundary: BrowserRecoveryBoundary) => void,
        ) => () => void;
      }).subscribeAfterFence;
      expect(subscribeAfterFence).toBeTypeOf("function");
      const unsubscribe = subscribeAfterFence!.call(context, fence, () => { retired = true; });

      expect(context.publish({ kind: "drafts", namespace: NAMESPACE_A }))
        .toEqual(["local-storage"]);
      expect(retired).toBe(true);
      expect(context.isWriteFenceCurrent(fence)).toBe(false);
      unsubscribe();
    } finally {
      context.close();
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

  it("preserves a scoped boundary published after the global compaction snapshot", async () => {
    const backingStorage = new MemoryStorage();
    const hub = new BoundaryChannelHub();
    hub.pause();
    let capturedBeforeScopedPublish: BrowserRecoveryWriteFence | null = null;
    let interleaved = false;
    const sharedLocalStorage = new Proxy(backingStorage, {
      get(target, property) {
        if (property === "setItem") {
          return (key: string, value: string) => {
            target.setItem(key, value);
            if (!interleaved
              && key === "codestead:browser-recovery-boundary:v1:all") {
              interleaved = true;
              capturedBeforeScopedPublish = writerTab.captureWriteFence({
                kind: "drafts",
                namespace: NAMESPACE_B,
              });
              scopedTab.publish({ kind: "namespace", namespace: NAMESPACE_B });
            }
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const globalTab = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: new MemoryStorage(),
      channel: hub.create(),
      sourceId: "tab-global-compactor",
    });
    const scopedTab = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: new MemoryStorage(),
      channel: hub.create(),
      sourceId: "tab-new-scoped-boundary",
    });
    const writerTab = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: new MemoryStorage(),
      channel: hub.create(),
      sourceId: "tab-captured-writer",
    });

    try {
      scopedTab.publish({ kind: "drafts", namespace: NAMESPACE_A });
      await purgeBrowserRecoveryData({
        sessionStorage: new MemoryStorage(),
        localStorage: sharedLocalStorage,
        repository: repository(),
        boundaryContext: globalTab,
      });

      const durableScopedBoundary = backingStorage.entries().find(([, raw]) => {
        try {
          const parsed = JSON.parse(raw) as { boundary?: BrowserRecoveryBoundary };
          return parsed.boundary?.kind === "namespace"
            && parsed.boundary.namespace === NAMESPACE_B;
        } catch {
          return false;
        }
      });
      expect(interleaved).toBe(true);
      expect(durableScopedBoundary).toBeDefined();
      expect(capturedBeforeScopedPublish).not.toBeNull();
      expect(writerTab.isWriteFenceCurrent(capturedBeforeScopedPublish!)).toBe(false);

      hub.flush();
      expect(writerTab.isWriteFenceCurrent(capturedBeforeScopedPublish!)).toBe(false);
    } finally {
      globalTab.close();
      scopedTab.close();
      writerTab.close();
    }
  });

  it("stays fail-closed when a scoped overwrite lands between compaction compare and remove", async () => {
    const backingStorage = new MemoryStorage();
    const hub = new BoundaryChannelHub();
    hub.pause();
    let scopedKey = "";
    let interleaved = false;
    let operationRan = false;
    let capturedDuringCompaction: BrowserRecoveryWriteFence | null = null;
    const sharedLocalStorage = new Proxy(backingStorage, {
      get(target, property) {
        if (property === "removeItem") {
          return (key: string) => {
            if (!interleaved && key === scopedKey) {
              interleaved = true;
              capturedDuringCompaction = writerTab.captureWriteFence({
                kind: "drafts",
                namespace: NAMESPACE_B,
              });
              try {
                writerTab.guardSynchronousWrite(
                  capturedDuringCompaction,
                  () => { operationRan = true; },
                  () => undefined,
                );
              } catch {
                // A visible compaction phase must reject this write.
              }
              scopedTab.publish({ kind: "namespace", namespace: NAMESPACE_B });
            }
            target.removeItem(key);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const globalTab = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: new MemoryStorage(),
      channel: hub.create(),
      sourceId: "tab-overwrite-compactor",
    });
    const scopedTab = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: new MemoryStorage(),
      channel: hub.create(),
      sourceId: "tab-overwrite-publisher",
    });
    const writerTab = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: new MemoryStorage(),
      channel: hub.create(),
      sourceId: "tab-overwrite-writer",
    });

    try {
      scopedTab.publish({ kind: "namespace", namespace: NAMESPACE_B });
      scopedKey = backingStorage.entries()
        .map(([key]) => key)
        .find((key) => key.includes(encodeURIComponent(NAMESPACE_B)))!;

      await purgeBrowserRecoveryData({
        sessionStorage: new MemoryStorage(),
        localStorage: sharedLocalStorage,
        repository: repository(),
        boundaryContext: globalTab,
      });

      expect(interleaved).toBe(true);
      expect(operationRan).toBe(false);
      expect(capturedDuringCompaction).not.toBeNull();
      expect(writerTab.isWriteFenceCurrent(capturedDuringCompaction!)).toBe(false);
      hub.flush();
      expect(writerTab.isWriteFenceCurrent(capturedDuringCompaction!)).toBe(false);
      expect(writerTab.isWriteFenceCurrent(writerTab.captureWriteFence({
        kind: "drafts",
        namespace: NAMESPACE_B,
      }))).toBe(true);
    } finally {
      globalTab.close();
      scopedTab.close();
      writerTab.close();
    }
  });

  it("leaves compaction fail-closed after removal failure and bounds metadata after retry", async () => {
    const backingStorage = new MemoryStorage();
    let failRemoval = true;
    const sharedLocalStorage = new Proxy(backingStorage, {
      get(target, property) {
        if (property === "removeItem") {
          return (key: string) => {
            if (failRemoval && key.startsWith("codestead:browser-recovery-boundary:v1:")
              && !key.endsWith(":all")) {
              throw new DOMException("blocked", "InvalidStateError");
            }
            target.removeItem(key);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const context = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: new MemoryStorage(),
      channel: null,
      sourceId: "tab-crashed-compactor",
    });

    try {
      context.publish({ kind: "drafts", namespace: NAMESPACE_A });
      await expect(purgeBrowserRecoveryData({
        sessionStorage: new MemoryStorage(),
        localStorage: sharedLocalStorage,
        repository: repository(),
        boundaryContext: context,
      })).rejects.toThrow("local-storage");
      expect(backingStorage.entries()).toContainEqual([
        "codestead:browser-recovery-compaction:v1",
        expect.stringContaining('"phase":"active"'),
      ]);

      const blockedFence = context.captureWriteFence({
        kind: "drafts",
        namespace: NAMESPACE_B,
      });
      expect(context.isWriteFenceCurrent(blockedFence)).toBe(false);
      expect(() => context.guardSynchronousWrite(
        blockedFence,
        () => undefined,
        () => undefined,
      )).toThrow(expect.objectContaining({ name: "AbortError" }));

      failRemoval = false;
      await purgeBrowserRecoveryData({
        sessionStorage: new MemoryStorage(),
        localStorage: sharedLocalStorage,
        repository: repository(),
        boundaryContext: context,
      });
      const boundaryKeys = backingStorage.entries()
        .map(([key]) => key)
        .filter((key) => key.startsWith("codestead:browser-recovery-boundary:v1:"));
      expect(boundaryKeys).toEqual(["codestead:browser-recovery-boundary:v1:all"]);
      expect(context.isWriteFenceCurrent(context.captureWriteFence({
        kind: "drafts",
        namespace: NAMESPACE_B,
      }))).toBe(true);
    } finally {
      context.close();
    }
  });

  it("does not let a stale global finalizer overwrite a newer completed publisher", () => {
    const backingStorage = new MemoryStorage();
    let interleaved = false;
    let newerFailures: string[] | null = null;
    const sharedLocalStorage = new Proxy(backingStorage, {
      get(target, property) {
        if (property === "removeItem") {
          return (key: string) => {
            if (!interleaved
              && key.startsWith("codestead:browser-recovery-boundary:v1:")
              && !key.endsWith(":all")) {
              interleaved = true;
              newerFailures = newerPublisher.publish({ kind: "all" });
            }
            target.removeItem(key);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const stalePublisher = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: new MemoryStorage(),
      channel: null,
      sourceId: "tab-overlap-stale-publisher",
    });
    const newerPublisher = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: new MemoryStorage(),
      channel: null,
      sourceId: "tab-overlap-newer-publisher",
    });
    const futureWriter = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: new MemoryStorage(),
      channel: null,
      sourceId: "tab-overlap-future-writer",
    });

    try {
      stalePublisher.publish({ kind: "drafts", namespace: NAMESPACE_A });
      const staleFailures = stalePublisher.publish({ kind: "all" });

      expect(interleaved).toBe(true);
      expect(newerFailures).toEqual([]);
      expect(staleFailures).toEqual(["local-storage"]);
      const currentFence = futureWriter.captureWriteFence({
        kind: "drafts",
        namespace: NAMESPACE_B,
      });
      expect(futureWriter.isWriteFenceCurrent(currentFence)).toBe(true);
    } finally {
      stalePublisher.close();
      newerPublisher.close();
      futureWriter.close();
    }
  });

  it("fails visibly when a stale complete write lands after its ownership check and repairs on retry", () => {
    const backingStorage = new MemoryStorage();
    let interleaved = false;
    let newerFailures: string[] | null = null;
    const sharedLocalStorage = new Proxy(backingStorage, {
      get(target, property) {
        if (property === "setItem") {
          return (key: string, value: string) => {
            let isStaleCompleteWrite = false;
            if (key === "codestead:browser-recovery-compaction:v1") {
              try {
                const parsed = JSON.parse(value) as {
                  phase?: string;
                  sourceId?: string;
                };
                isStaleCompleteWrite = parsed.phase === "complete"
                  && parsed.sourceId === "tab-complete-window-stale";
              } catch {
                // Non-JSON writes are handled by the production parser.
              }
            }
            if (!interleaved && isStaleCompleteWrite) {
              interleaved = true;
              newerFailures = newerPublisher.publish({ kind: "all" });
            }
            target.setItem(key, value);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const stalePublisher = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: new MemoryStorage(),
      channel: null,
      sourceId: "tab-complete-window-stale",
    });
    const newerPublisher = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: new MemoryStorage(),
      channel: null,
      sourceId: "tab-complete-window-newer",
    });
    const futureWriter = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: sharedLocalStorage,
      sessionStorage: new MemoryStorage(),
      channel: null,
      sourceId: "tab-complete-window-writer",
    });

    try {
      const retiredFence = stalePublisher.captureWriteFence({
        kind: "drafts",
        namespace: NAMESPACE_A,
      });
      const staleFailures = stalePublisher.publish({ kind: "all" });

      expect(interleaved).toBe(true);
      expect(newerFailures).toEqual([]);
      expect(staleFailures).toEqual(["local-storage"]);
      const globalBeforeRetry = JSON.parse(backingStorage.getItem(
        "codestead:browser-recovery-boundary:v1:all",
      )!) as { nonce: string; sourceId: string };
      const compactionBeforeRetry = JSON.parse(backingStorage.getItem(
        "codestead:browser-recovery-compaction:v1",
      )!) as { globalNonce: string; phase: string; sourceId: string };
      expect(globalBeforeRetry.sourceId).toBe("tab-complete-window-newer");
      expect(compactionBeforeRetry).toMatchObject({
        phase: "complete",
        sourceId: "tab-complete-window-stale",
      });
      expect(compactionBeforeRetry.globalNonce).not.toBe(globalBeforeRetry.nonce);
      const blockedFence = futureWriter.captureWriteFence({
        kind: "drafts",
        namespace: NAMESPACE_B,
      });
      expect(futureWriter.isWriteFenceCurrent(blockedFence)).toBe(false);
      expect(stalePublisher.isWriteFenceCurrent(retiredFence)).toBe(false);

      expect(newerPublisher.publish({ kind: "all" })).toEqual([]);

      const repairedGlobal = JSON.parse(backingStorage.getItem(
        "codestead:browser-recovery-boundary:v1:all",
      )!) as { nonce: string };
      const repairedCompaction = JSON.parse(backingStorage.getItem(
        "codestead:browser-recovery-compaction:v1",
      )!) as { globalNonce: string; phase: string };
      expect(repairedCompaction).toMatchObject({
        phase: "complete",
        globalNonce: repairedGlobal.nonce,
      });
      expect(futureWriter.isWriteFenceCurrent(blockedFence)).toBe(false);
      expect(stalePublisher.isWriteFenceCurrent(retiredFence)).toBe(false);
      expect(futureWriter.isWriteFenceCurrent(futureWriter.captureWriteFence({
        kind: "drafts",
        namespace: NAMESPACE_B,
      }))).toBe(true);
    } finally {
      stalePublisher.close();
      newerPublisher.close();
      futureWriter.close();
    }
  });

  it("reports a durable-boundary quota failure while still attempting every cleanup layer", async () => {
    const sharedLocalStorage = new MemoryStorage();
    const flakyLocalStorage = new Proxy(sharedLocalStorage, {
      get(target, property) {
        if (property === "setItem") {
          return () => { throw new DOMException("quota", "QuotaExceededError"); };
        }
        const value = Reflect.get(target, property, target) as unknown;
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

  it.each(["resolves", "rejects"] as const)(
    "rolls back an async late write when the operation %s and final fence reads fail",
    async (outcome) => {
      const factory = new FakeIDBFactory();
      const repo = await openBrowserOutbox(factory);
      const backingStorage = new MemoryStorage();
      let failReads = false;
      const writerLocalStorage = new Proxy(backingStorage, {
        get(target, property) {
          if (property === "getItem") {
            return (key: string) => {
              if (failReads) throw new DOMException("blocked", "InvalidStateError");
              return target.getItem(key);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const publisher = createBrowserRecoveryBoundaryContext({
        origin: "https://codestead.test",
        localStorage: backingStorage,
        sessionStorage: new MemoryStorage(),
        channel: null,
        sourceId: `tab-read-failure-publisher-${outcome}`,
      });
      const writer = createBrowserRecoveryBoundaryContext({
        origin: "https://codestead.test",
        localStorage: writerLocalStorage,
        sessionStorage: new MemoryStorage(),
        channel: null,
        sourceId: `tab-read-failure-writer-${outcome}`,
      });
      const fence = writer.captureWriteFence({ kind: "drafts", namespace: NAMESPACE_A });
      const started = deferred<void>();
      const release = deferred<void>();
      const record = draftRecord(NAMESPACE_A);
      const guardedWrite = writer.guardWrite(
        fence,
        async () => {
          started.resolve();
          await release.promise;
          await repo.putDraft(record);
          failReads = true;
          if (outcome === "rejects") throw new Error("operation failed after writing");
          return record.requestId;
        },
        () => repo.deleteDraftIfMutation(NAMESPACE_A, DRAFT_KEY, record.requestId),
      );

      try {
        await started.promise;
        await purgeBrowserRecoveryData({
          namespace: NAMESPACE_A,
          sessionStorage: new MemoryStorage(),
          localStorage: backingStorage,
          repository: repo,
          boundaryContext: publisher,
        });
        release.resolve();
        const error = await guardedWrite.then(
          () => null,
          (reason: unknown) => reason,
        );
        failReads = false;

        await expect(repo.getDraft(NAMESPACE_A, DRAFT_KEY)).resolves.toBeNull();
        expect(error).toMatchObject({ name: "AbortError" });
      } finally {
        failReads = false;
        release.resolve();
        await guardedWrite.catch(() => undefined);
        publisher.close();
        writer.close();
        repo.close();
      }
    },
  );

  it("rolls back a synchronous late write when final fence reads fail", () => {
    const backingStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    let failReads = false;
    const writerLocalStorage = new Proxy(backingStorage, {
      get(target, property) {
        if (property === "getItem") {
          return (key: string) => {
            if (failReads) throw new DOMException("blocked", "InvalidStateError");
            return target.getItem(key);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const publisher = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: backingStorage,
      sessionStorage: new MemoryStorage(),
      channel: null,
      sourceId: "tab-sync-read-failure-publisher",
    });
    const writer = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage: writerLocalStorage,
      sessionStorage,
      channel: null,
      sourceId: "tab-sync-read-failure-writer",
    });
    const fence = writer.captureWriteFence({ kind: "drafts", namespace: NAMESPACE_A });
    const lateKey = draftCacheKey(NAMESPACE_A, DRAFT_KEY);

    try {
      let error: unknown;
      try {
        writer.guardSynchronousWrite(
          fence,
          () => {
            publisher.publish({ kind: "namespace", namespace: NAMESPACE_A });
            sessionStorage.removeItem(lateKey);
            sessionStorage.setItem(lateKey, "late warm recovery");
            failReads = true;
          },
          () => sessionStorage.removeItem(lateKey),
        );
      } catch (reason) {
        error = reason;
      }
      failReads = false;

      expect(sessionStorage.getItem(lateKey)).toBeNull();
      expect(error).toMatchObject({ name: "AbortError" });
    } finally {
      failReads = false;
      publisher.close();
      writer.close();
    }
  });

  it("does not admit an unchanged malformed tombstone as a current fence", () => {
    const localStorage = new MemoryStorage();
    localStorage.setItem(
      `codestead:browser-recovery-boundary:v1:namespace:${encodeURIComponent(NAMESPACE_A)}`,
      "{malformed",
    );
    const context = createBrowserRecoveryBoundaryContext({
      origin: "https://codestead.test",
      localStorage,
      sessionStorage: new MemoryStorage(),
      channel: null,
      sourceId: "tab-malformed-tombstone-writer",
    });

    try {
      const fence = context.captureWriteFence({ kind: "drafts", namespace: NAMESPACE_A });
      let operationRan = false;
      expect(() => context.guardSynchronousWrite(
        fence,
        () => { operationRan = true; },
        () => undefined,
      )).toThrow(expect.objectContaining({ name: "AbortError" }));
      expect(operationRan).toBe(false);
    } finally {
      context.close();
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
