import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ClientExamEventType } from "@/lib/exams/contracts";

import {
  drainEmergencyExamEvents,
  EMERGENCY_EXAM_EVENT_PREFIX,
  writeEmergencyExamEvent,
} from "../emergency-events";
import {
  type BrowserOutboxRepository,
  openBrowserOutbox,
} from "../indexed-db";
import {
  examEventOutboxStorageKey,
  type ExamEventOutboxRecord,
} from "../types";

const NAMESPACE_A = "namespace-alpha";
const NAMESPACE_B = "namespace-beta";
const SESSION_A = "session-alpha";
const SESSION_B = "session-beta";
const TIME_1 = "2026-07-15T01:00:00.000Z";
const TIME_2 = "2026-07-15T02:00:00.000Z";

function emergencyStorageKey(record: ExamEventOutboxRecord) {
  return `${EMERGENCY_EXAM_EVENT_PREFIX}${encodeURIComponent(record.namespace)}:${encodeURIComponent(record.scope)}:${encodeURIComponent(record.clientEventId)}`;
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
    storageKey: examEventOutboxStorageKey(namespace, sessionId, clientEventId),
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

function snapshotStorage(storage: Storage) {
  const entries = new Map<string, string>();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === null) continue;
    const value = storage.getItem(key);
    if (value !== null) entries.set(key, value);
  }
  return entries;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function replacePutExamEvent(
  repository: BrowserOutboxRepository,
  putExamEvent: (record: ExamEventOutboxRecord) => Promise<void>,
): BrowserOutboxRepository {
  return new Proxy(repository, {
    get(target, property, receiver) {
      if (property === "putExamEvent") return putExamEvent;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("emergency exam event bridge", () => {
  let factory: IDBFactory;
  let repository: BrowserOutboxRepository | null;

  beforeEach(async () => {
    window.localStorage.clear();
    factory = new FakeIDBFactory();
    repository = await openBrowserOutbox(factory);
  });

  afterEach(() => {
    repository?.close();
    repository = null;
    window.localStorage.clear();
  });

  it("synchronously writes an event from a dispatched beforeunload handler", () => {
    const record = makeEventRecord();
    const handler = () => writeEmergencyExamEvent(window.localStorage, record);
    window.addEventListener("beforeunload", handler);
    try {
      window.dispatchEvent(new Event("beforeunload"));
    } finally {
      window.removeEventListener("beforeunload", handler);
    }

    const key = emergencyStorageKey(record);
    expect(window.localStorage.getItem(key)).toBe(JSON.stringify(record));
    expect(snapshotStorage(window.localStorage)).toEqual(new Map([
      [key, JSON.stringify(record)],
    ]));
  });

  it("reopens, commits the exact event to IndexedDB, and only then removes localStorage", async () => {
    const record = makeEventRecord();
    const key = emergencyStorageKey(record);
    writeEmergencyExamEvent(window.localStorage, record);
    repository!.close();
    repository = await openBrowserOutbox(factory);

    await drainEmergencyExamEvents(
      window.localStorage,
      repository,
      NAMESPACE_A,
      SESSION_A,
    );

    await expect(repository.listExamEvents(NAMESPACE_A, SESSION_A)).resolves.toEqual([record]);
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it("leaves the local copy intact while an IndexedDB write is pending and after rejection", async () => {
    const record = makeEventRecord();
    const key = emergencyStorageKey(record);
    writeEmergencyExamEvent(window.localStorage, record);
    const commit = deferred<void>();
    const started = deferred<void>();
    const delayedRepository = replacePutExamEvent(repository!, async () => {
      started.resolve();
      await commit.promise;
    });

    const drain = drainEmergencyExamEvents(
      window.localStorage,
      delayedRepository,
      NAMESPACE_A,
      SESSION_A,
    );
    await started.promise;
    expect(window.localStorage.getItem(key)).toBe(JSON.stringify(record));

    commit.reject(new Error("IndexedDB commit failed."));
    await expect(drain).rejects.toThrow("IndexedDB commit failed.");
    expect(window.localStorage.getItem(key)).toBe(JSON.stringify(record));
  });

  it("compare-and-deletes localStorage so a rewrite during drain survives", async () => {
    const original = makeEventRecord();
    const rewritten = makeEventRecord({
      updatedAt: TIME_2,
      occurredAt: TIME_2,
      metadata: { sequence: 2 },
    });
    const key = emergencyStorageKey(original);
    writeEmergencyExamEvent(window.localStorage, original);
    const commit = deferred<void>();
    const started = deferred<void>();
    const delayedRepository = replacePutExamEvent(repository!, async () => {
      started.resolve();
      await commit.promise;
    });

    const drain = drainEmergencyExamEvents(
      window.localStorage,
      delayedRepository,
      NAMESPACE_A,
      SESSION_A,
    );
    await started.promise;
    writeEmergencyExamEvent(window.localStorage, rewritten);
    commit.resolve();
    await drain;

    expect(window.localStorage.getItem(key)).toBe(JSON.stringify(rewritten));
  });

  it("deduplicates the same client event ID into one IndexedDB record", async () => {
    const original = makeEventRecord();
    const replacement = makeEventRecord({
      updatedAt: TIME_2,
      occurredAt: TIME_2,
      metadata: { sequence: 2 },
    });
    writeEmergencyExamEvent(window.localStorage, original);
    writeEmergencyExamEvent(window.localStorage, replacement);

    await drainEmergencyExamEvents(
      window.localStorage,
      repository!,
      NAMESPACE_A,
      SESSION_A,
    );

    await expect(repository!.listExamEvents(NAMESPACE_A, SESSION_A)).resolves.toEqual([
      replacement,
    ]);
    expect(window.localStorage.length).toBe(0);
  });

  it("caps only the exact namespace and session at the newest 64 records", () => {
    const foreignNamespace = makeEventRecord({
      namespace: NAMESPACE_B,
      clientEventId: "event-foreign-0001",
    });
    const foreignSession = makeEventRecord({
      sessionId: SESSION_B,
      clientEventId: "event-session-0001",
    });
    writeEmergencyExamEvent(window.localStorage, foreignNamespace);
    writeEmergencyExamEvent(window.localStorage, foreignSession);
    window.localStorage.setItem("unrelated-key", "keep-me");

    const targetRecords = Array.from({ length: 66 }, (_, index) => {
      const timestamp = new Date(Date.parse(TIME_1) + index * 1_000).toISOString();
      return makeEventRecord({
        clientEventId: `event-cap-${String(index).padStart(8, "0")}`,
        updatedAt: timestamp,
        occurredAt: timestamp,
        metadata: { sequence: index },
      });
    });
    for (const record of targetRecords) {
      writeEmergencyExamEvent(window.localStorage, record);
    }

    const records = [...snapshotStorage(window.localStorage).entries()]
      .filter(([key]) => key.startsWith(EMERGENCY_EXAM_EVENT_PREFIX))
      .map(([, raw]) => JSON.parse(raw) as ExamEventOutboxRecord);
    const targetIds = records
      .filter((record) => record.namespace === NAMESPACE_A && record.scope === SESSION_A)
      .map((record) => record.clientEventId)
      .sort();

    expect(targetIds).toHaveLength(64);
    expect(targetIds).toEqual(targetRecords.slice(2).map((record) => record.clientEventId));
    expect(window.localStorage.getItem(emergencyStorageKey(foreignNamespace))).toBe(
      JSON.stringify(foreignNamespace),
    );
    expect(window.localStorage.getItem(emergencyStorageKey(foreignSession))).toBe(
      JSON.stringify(foreignSession),
    );
    expect(window.localStorage.getItem("unrelated-key")).toBe("keep-me");
  });
});
