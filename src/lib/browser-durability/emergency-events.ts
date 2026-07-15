import type { BrowserOutboxRepository } from "./indexed-db";
import {
  isBrowserOutboxNamespace,
  isExamEventOutboxRecord,
  isExamSessionId,
} from "./types";
import type { ExamEventOutboxRecord } from "./types";

export const EMERGENCY_EXAM_EVENT_PREFIX =
  "codestead:exam-event-emergency:v1:";

const EMERGENCY_EVENT_LIMIT = 64;

type EmergencySnapshot = {
  key: string;
  raw: string;
  record: ExamEventOutboxRecord;
};

type EmergencyKeyIdentity = {
  namespace: string;
  sessionId: string;
  clientEventId: string;
};

export type EmergencyExamEventClearFilter =
  | { kind: "all" }
  | { kind: "namespace"; namespace: string }
  | { kind: "foreign-namespaces"; currentNamespace: string }
  | { kind: "exam"; namespace: string; sessionId: string };

function emergencyStorageKey(record: ExamEventOutboxRecord) {
  return `${EMERGENCY_EXAM_EVENT_PREFIX}${encodeURIComponent(record.namespace)}:${encodeURIComponent(record.scope)}:${encodeURIComponent(record.clientEventId)}`;
}

function parseEmergencyStorageKey(key: string): EmergencyKeyIdentity | null {
  if (!key.startsWith(EMERGENCY_EXAM_EVENT_PREFIX)) return null;
  const encoded = key.slice(EMERGENCY_EXAM_EVENT_PREFIX.length).split(":");
  if (encoded.length !== 3) return null;
  try {
    const identity = {
      namespace: decodeURIComponent(encoded[0]!),
      sessionId: decodeURIComponent(encoded[1]!),
      clientEventId: decodeURIComponent(encoded[2]!),
    };
    const canonical = `${EMERGENCY_EXAM_EVENT_PREFIX}${encodeURIComponent(identity.namespace)}:${encodeURIComponent(identity.sessionId)}:${encodeURIComponent(identity.clientEventId)}`;
    return canonical === key ? identity : null;
  } catch {
    return null;
  }
}

function storageKeys(storage: Storage) {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) keys.push(key);
  }
  return keys;
}

function matchingSnapshots(
  storage: Storage,
  namespace: string,
  sessionId: string,
) {
  const snapshots: EmergencySnapshot[] = [];
  for (const key of storageKeys(storage)) {
    if (!key.startsWith(EMERGENCY_EXAM_EVENT_PREFIX)) continue;
    const raw = storage.getItem(key);
    if (raw === null) continue;
    try {
      const record = JSON.parse(raw) as unknown;
      if (!isExamEventOutboxRecord(record)
        || record.namespace !== namespace
        || record.scope !== sessionId
        || emergencyStorageKey(record) !== key) continue;
      snapshots.push({ key, raw, record });
    } catch {
      // Invalid emergency values are not trusted and are never removed as committed data.
    }
  }
  return snapshots;
}

function compareEmergencySnapshots(left: EmergencySnapshot, right: EmergencySnapshot) {
  const occurredDifference = Date.parse(left.record.payload.occurredAt)
    - Date.parse(right.record.payload.occurredAt);
  if (occurredDifference !== 0) return occurredDifference;
  const updatedDifference = Date.parse(left.record.updatedAt) - Date.parse(right.record.updatedAt);
  if (updatedDifference !== 0) return updatedDifference;
  if (left.key < right.key) return -1;
  if (left.key > right.key) return 1;
  return 0;
}

function removeIfUnchanged(storage: Storage, snapshot: EmergencySnapshot) {
  if (storage.getItem(snapshot.key) === snapshot.raw) storage.removeItem(snapshot.key);
}

function isMatchingClearSnapshot(
  key: string,
  raw: string,
  filter: EmergencyExamEventClearFilter,
) {
  if (filter.kind === "all") return true;
  const identity = parseEmergencyStorageKey(key);
  if (!identity) return filter.kind === "foreign-namespaces";
  // Exact security boundaries are keyed by the canonical storage identity.
  // Corrupted JSON must not make sensitive recovery data survive logout or a
  // terminal exam cleanup, but a neighbouring namespace must remain intact.
  if (filter.kind === "namespace") return identity.namespace === filter.namespace;
  if (filter.kind === "exam") {
    return identity.namespace === filter.namespace && identity.sessionId === filter.sessionId;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return filter.kind === "foreign-namespaces";
  }
  if (!isExamEventOutboxRecord(parsed)
    || parsed.namespace !== identity.namespace
    || parsed.scope !== identity.sessionId
    || parsed.clientEventId !== identity.clientEventId
    || emergencyStorageKey(parsed) !== key) {
    return filter.kind === "foreign-namespaces";
  }
  return identity.namespace !== filter.currentNamespace;
}

function requireValidClearFilter(filter: EmergencyExamEventClearFilter) {
  if (filter.kind === "all") return;
  const namespace = filter.kind === "foreign-namespaces"
    ? filter.currentNamespace
    : filter.namespace;
  if (!isBrowserOutboxNamespace(namespace)) {
    throw new Error("Emergency event namespace is invalid.");
  }
  if (filter.kind === "exam" && !isExamSessionId(filter.sessionId)) {
    throw new Error("Emergency event session ID is invalid.");
  }
}

export function clearEmergencyExamEvents(
  storage: Storage,
  filter: EmergencyExamEventClearFilter,
) {
  requireValidClearFilter(filter);
  const snapshots = storageKeys(storage)
    .filter((key) => key.startsWith(EMERGENCY_EXAM_EVENT_PREFIX))
    .map((key) => ({ key, raw: storage.getItem(key) }))
    .filter((snapshot): snapshot is { key: string; raw: string } => snapshot.raw !== null)
    .filter(({ key, raw }) => isMatchingClearSnapshot(key, raw, filter));
  let removed = 0;
  for (const snapshot of snapshots) {
    if (storage.getItem(snapshot.key) !== snapshot.raw) continue;
    storage.removeItem(snapshot.key);
    removed += 1;
  }
  return removed;
}

export function writeEmergencyExamEvent(
  storage: Storage,
  record: ExamEventOutboxRecord,
): void {
  if (!isExamEventOutboxRecord(record)) {
    throw new Error("Emergency exam event record is invalid.");
  }

  const key = emergencyStorageKey(record);
  const raw = JSON.stringify(record);
  const previous = storage.getItem(key);
  storage.setItem(key, raw);

  const removed: EmergencySnapshot[] = [];
  try {
    const snapshots = matchingSnapshots(storage, record.namespace, record.scope)
      .sort(compareEmergencySnapshots);
    const overflow = Math.max(0, snapshots.length - EMERGENCY_EVENT_LIMIT);
    for (const snapshot of snapshots.slice(0, overflow)) {
      if (storage.getItem(snapshot.key) !== snapshot.raw) continue;
      storage.removeItem(snapshot.key);
      removed.push(snapshot);
    }
  } catch (error) {
    for (const snapshot of removed) {
      try {
        storage.setItem(snapshot.key, snapshot.raw);
      } catch {
        // Best effort only: preserve the original storage failure for the caller.
      }
    }
    try {
      if (previous === null) storage.removeItem(key);
      else storage.setItem(key, previous);
    } catch {
      // Best effort only: preserve the original storage failure for the caller.
    }
    throw error;
  }
}

export async function drainEmergencyExamEvents(
  storage: Storage,
  repository: BrowserOutboxRepository,
  namespace: string,
  sessionId: string,
  guardedWrite?: (record: ExamEventOutboxRecord) => Promise<void>,
): Promise<void> {
  if (!isBrowserOutboxNamespace(namespace)) {
    throw new Error("Emergency event namespace is invalid.");
  }
  if (!isExamSessionId(sessionId)) {
    throw new Error("Emergency event session ID is invalid.");
  }

  const snapshots = matchingSnapshots(storage, namespace, sessionId)
    .sort(compareEmergencySnapshots);
  for (const snapshot of snapshots) {
    if (guardedWrite) await guardedWrite(snapshot.record);
    else await repository.putExamEvent(snapshot.record);
    removeIfUnchanged(storage, snapshot);
  }
}
