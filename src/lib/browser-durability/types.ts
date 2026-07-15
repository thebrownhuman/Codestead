import { CLIENT_EXAM_EVENT_TYPES } from "@/lib/exams/contracts";
import type { ClientExamEventType } from "@/lib/exams/contracts";
import { DRAFT_CONTENT_MAX_BYTES as MAX_DRAFT_BYTES } from "@/lib/drafts/types";
import type { DraftKey } from "@/lib/drafts/types";

export type DraftOutboxRecord = {
  schemaVersion: 1;
  storageKey: string;
  namespace: string;
  kind: "draft";
  scope: string;
  requestId: string;
  updatedAt: string;
  payload: { key: DraftKey; content: string; baseRevision: number };
};

export type ExamAnswerOutboxRecord = {
  schemaVersion: 1;
  storageKey: string;
  namespace: string;
  kind: "exam-answer";
  scope: string;
  clientMutationId: string;
  updatedAt: string;
  payload: { itemId: string; answer: string; baseRevision: number };
};

export type ExamEventOutboxRecord = {
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

export type BrowserOutboxRecord =
  | DraftOutboxRecord
  | ExamAnswerOutboxRecord
  | ExamEventOutboxRecord;

const SAFE_NAMESPACE = /^[A-Za-z0-9._:-]+$/;
const SAFE_IDENTITY = /^[A-Za-z0-9._:-]+$/;
const SAFE_LANGUAGE = /^[A-Za-z0-9_+.-]+$/;
const UUID = /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
const CLIENT_EXAM_EVENT_TYPE_SET = new Set<string>(CLIENT_EXAM_EVENT_TYPES);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isBoundedSafeString(
  value: unknown,
  maximumLength: number,
  pattern: RegExp,
  minimumLength = 1,
): value is string {
  return typeof value === "string"
    && value.length >= minimumLength
    && value.length <= maximumLength
    && pattern.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 64
    && Number.isFinite(Date.parse(value));
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function utf8Bytes(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function isJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((item) => isJsonValue(item, ancestors));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(value as Record<string, unknown>)
      .every((item) => isJsonValue(item, ancestors));
  } finally {
    ancestors.delete(value);
  }
}

function isMetadata(value: unknown): value is Record<string, unknown> {
  if (!isObject(value) || !isJsonValue(value, new Set())) return false;
  try {
    return JSON.stringify(value).length <= 4_096;
  } catch {
    return false;
  }
}

export function isBrowserOutboxNamespace(value: unknown): value is string {
  return isBoundedSafeString(value, 100, SAFE_NAMESPACE);
}

export function isExamSessionId(value: unknown): value is string {
  return isBoundedSafeString(value, 200, SAFE_IDENTITY);
}

export function isExamItemId(value: unknown): value is string {
  return isBoundedSafeString(value, 200, SAFE_IDENTITY);
}

export function isClientEventId(value: unknown): value is string {
  return isBoundedSafeString(value, 200, SAFE_IDENTITY, 16);
}

export function isMutationId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function isDraftKey(value: unknown): value is DraftKey {
  if (!isObject(value) || !hasExactKeys(value, ["kind", "courseId", "skillId", "language"])) {
    return false;
  }
  if (value.kind !== "code" && value.kind !== "lesson") return false;
  if (!isBoundedSafeString(value.courseId, 100, SAFE_IDENTITY)) return false;
  if (!isBoundedSafeString(value.skillId, 180, SAFE_IDENTITY)) return false;
  if (value.kind === "lesson") return value.language === null;
  return isBoundedSafeString(value.language, 40, SAFE_LANGUAGE);
}

export function draftOutboxScope(key: DraftKey) {
  return JSON.stringify([key.kind, key.courseId, key.skillId, key.language]);
}

export function draftOutboxStorageKey(namespace: string, key: DraftKey) {
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

export function examAnswerOutboxStorageKey(
  namespace: string,
  sessionId: string,
  itemId: string,
) {
  return JSON.stringify([1, namespace, "exam-answer", sessionId, itemId]);
}

export function examEventOutboxStorageKey(
  namespace: string,
  sessionId: string,
  clientEventId: string,
) {
  return JSON.stringify([1, namespace, "exam-event", sessionId, clientEventId]);
}

export function isDraftOutboxRecord(value: unknown): value is DraftOutboxRecord {
  try {
    if (!isObject(value) || !hasExactKeys(value, [
      "schemaVersion",
      "storageKey",
      "namespace",
      "kind",
      "scope",
      "requestId",
      "updatedAt",
      "payload",
    ])) return false;
    if (value.schemaVersion !== 1 || value.kind !== "draft") return false;
    if (!isBrowserOutboxNamespace(value.namespace) || !isTimestamp(value.updatedAt)) return false;
    if (!isMutationId(value.requestId)) return false;
    if (!isObject(value.payload) || !hasExactKeys(value.payload, [
      "key",
      "content",
      "baseRevision",
    ])) return false;
    if (!isDraftKey(value.payload.key)) return false;
    if (typeof value.payload.content !== "string"
      || utf8Bytes(value.payload.content) > MAX_DRAFT_BYTES) return false;
    if (!isRevision(value.payload.baseRevision)) return false;
    return value.scope === draftOutboxScope(value.payload.key)
      && value.storageKey === draftOutboxStorageKey(value.namespace, value.payload.key);
  } catch {
    return false;
  }
}

export function isExamAnswerOutboxRecord(value: unknown): value is ExamAnswerOutboxRecord {
  try {
    if (!isObject(value) || !hasExactKeys(value, [
      "schemaVersion",
      "storageKey",
      "namespace",
      "kind",
      "scope",
      "clientMutationId",
      "updatedAt",
      "payload",
    ])) return false;
    if (value.schemaVersion !== 1 || value.kind !== "exam-answer") return false;
    if (!isBrowserOutboxNamespace(value.namespace)
      || !isExamSessionId(value.scope)
      || !isTimestamp(value.updatedAt)) return false;
    if (!isMutationId(value.clientMutationId)) return false;
    if (!isObject(value.payload) || !hasExactKeys(value.payload, [
      "itemId",
      "answer",
      "baseRevision",
    ])) return false;
    if (!isExamItemId(value.payload.itemId)
      || typeof value.payload.answer !== "string"
      || !isRevision(value.payload.baseRevision)) return false;
    return value.storageKey === examAnswerOutboxStorageKey(
      value.namespace,
      value.scope,
      value.payload.itemId,
    );
  } catch {
    return false;
  }
}

export function isExamEventOutboxRecord(value: unknown): value is ExamEventOutboxRecord {
  try {
    if (!isObject(value) || !hasExactKeys(value, [
      "schemaVersion",
      "storageKey",
      "namespace",
      "kind",
      "scope",
      "clientEventId",
      "updatedAt",
      "payload",
    ])) return false;
    if (value.schemaVersion !== 1 || value.kind !== "exam-event") return false;
    if (!isBrowserOutboxNamespace(value.namespace)
      || !isExamSessionId(value.scope)
      || !isClientEventId(value.clientEventId)
      || !isTimestamp(value.updatedAt)) return false;
    if (!isObject(value.payload) || !hasExactKeys(value.payload, [
      "eventType",
      "occurredAt",
      "metadata",
    ])) return false;
    if (typeof value.payload.eventType !== "string"
      || !CLIENT_EXAM_EVENT_TYPE_SET.has(value.payload.eventType)
      || !isTimestamp(value.payload.occurredAt)
      || !isMetadata(value.payload.metadata)) return false;
    return value.storageKey === examEventOutboxStorageKey(
      value.namespace,
      value.scope,
      value.clientEventId,
    );
  } catch {
    return false;
  }
}

export function isBrowserOutboxRecord(value: unknown): value is BrowserOutboxRecord {
  return isDraftOutboxRecord(value)
    || isExamAnswerOutboxRecord(value)
    || isExamEventOutboxRecord(value);
}
