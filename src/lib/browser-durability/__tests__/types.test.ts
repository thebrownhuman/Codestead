import { describe, expect, it } from "vitest";

import {
  draftOutboxScope,
  draftOutboxStorageKey,
  examAnswerOutboxStorageKey,
  examEventOutboxStorageKey,
  isBrowserOutboxNamespace,
  isBrowserOutboxRecord,
  isClientEventId,
  isDraftKey,
  isDraftOutboxRecord,
  isExamAnswerOutboxRecord,
  isExamEventOutboxRecord,
  isExamItemId,
  isExamSessionId,
  isMutationId,
  type DraftOutboxRecord,
  type ExamAnswerOutboxRecord,
  type ExamEventOutboxRecord,
} from "../types";

const validMutationId = "11111111-1111-4111-8111-111111111111";
const codeKey = { kind: "code" as const, courseId: "python", skillId: "loops", language: "python" };
const lessonKey = { kind: "lesson" as const, courseId: "python", skillId: "loops", language: null };

function draftRecord(overrides: Partial<DraftOutboxRecord> = {}): DraftOutboxRecord {
  return {
    schemaVersion: 1,
    storageKey: draftOutboxStorageKey("ns", codeKey),
    namespace: "ns",
    kind: "draft",
    scope: draftOutboxScope(codeKey),
    requestId: validMutationId,
    updatedAt: "2026-07-12T00:00:00.000Z",
    payload: { key: codeKey, content: "print(1)", baseRevision: 0 },
    ...overrides,
  };
}

function examAnswerRecord(overrides: Partial<ExamAnswerOutboxRecord> = {}): ExamAnswerOutboxRecord {
  return {
    schemaVersion: 1,
    storageKey: examAnswerOutboxStorageKey("ns", "session-1", "item-1"),
    namespace: "ns",
    kind: "exam-answer",
    scope: "session-1",
    clientMutationId: validMutationId,
    updatedAt: "2026-07-12T00:00:00.000Z",
    payload: { itemId: "item-1", answer: "42", baseRevision: 0 },
    ...overrides,
  };
}

function examEventRecord(overrides: Partial<ExamEventOutboxRecord> = {}): ExamEventOutboxRecord {
  return {
    schemaVersion: 1,
    storageKey: examEventOutboxStorageKey("ns", "session-1", "event-0000000000000001"),
    namespace: "ns",
    kind: "exam-event",
    scope: "session-1",
    clientEventId: "event-0000000000000001",
    updatedAt: "2026-07-12T00:00:00.000Z",
    payload: { eventType: "window_focus", occurredAt: "2026-07-12T00:00:00.000Z", metadata: { target: "window" } },
    ...overrides,
  };
}

describe("browser outbox identity guards", () => {
  it("bounds namespace, session, item, and event identifiers", () => {
    expect(isBrowserOutboxNamespace("codestead.app")).toBe(true);
    expect(isBrowserOutboxNamespace("bad space")).toBe(false);
    expect(isBrowserOutboxNamespace("x".repeat(101))).toBe(false);
    expect(isExamSessionId("session-1")).toBe(true);
    expect(isExamSessionId("")).toBe(false);
    expect(isExamItemId("item-1")).toBe(true);
    expect(isExamItemId(42)).toBe(false);
    expect(isClientEventId("event-0000000000000001")).toBe(true);
    expect(isClientEventId("short")).toBe(false);
  });

  it("accepts only a well-formed mutation UUID", () => {
    expect(isMutationId(validMutationId)).toBe(true);
    expect(isMutationId("not-a-uuid")).toBe(false);
    expect(isMutationId(123)).toBe(false);
  });
});

describe("draft key identity", () => {
  it("accepts a code key with a language and a lesson key without one", () => {
    expect(isDraftKey(codeKey)).toBe(true);
    expect(isDraftKey(lessonKey)).toBe(true);
  });

  it("rejects extra fields, wrong kinds, and a lesson key carrying a language", () => {
    expect(isDraftKey({ ...codeKey, extra: true })).toBe(false);
    expect(isDraftKey({ ...codeKey, kind: "essay" })).toBe(false);
    expect(isDraftKey({ ...lessonKey, language: "python" })).toBe(false);
    expect(isDraftKey(null)).toBe(false);
    expect(isDraftKey("draft-key")).toBe(false);
  });
});

describe("draft outbox record validation", () => {
  it("accepts a well-formed draft record", () => {
    expect(isDraftOutboxRecord(draftRecord())).toBe(true);
  });

  it("rejects a mismatched scope or storage key, an oversized payload, and a bad revision", () => {
    expect(isDraftOutboxRecord(draftRecord({ scope: "wrong-scope" }))).toBe(false);
    expect(isDraftOutboxRecord(draftRecord({ storageKey: "wrong-key" }))).toBe(false);
    expect(isDraftOutboxRecord(draftRecord({
      payload: { key: codeKey, content: "x".repeat(2_000_000), baseRevision: 0 },
    }))).toBe(false);
    expect(isDraftOutboxRecord(draftRecord({
      payload: { key: codeKey, content: "ok", baseRevision: -1 },
    }))).toBe(false);
    expect(isDraftOutboxRecord({ ...draftRecord(), kind: "exam-answer" })).toBe(false);
    expect(isDraftOutboxRecord(null)).toBe(false);
  });
});

describe("exam answer outbox record validation", () => {
  it("accepts a well-formed exam answer record", () => {
    expect(isExamAnswerOutboxRecord(examAnswerRecord())).toBe(true);
  });

  it("rejects a bad session scope, item id, or a storage key that does not match the payload", () => {
    expect(isExamAnswerOutboxRecord(examAnswerRecord({ scope: "" }))).toBe(false);
    expect(isExamAnswerOutboxRecord(examAnswerRecord({
      payload: { itemId: "item-1", answer: "42", baseRevision: 0 },
      storageKey: examAnswerOutboxStorageKey("ns", "session-1", "item-other"),
    }))).toBe(false);
    expect(isExamAnswerOutboxRecord(examAnswerRecord({ clientMutationId: "not-a-uuid" }))).toBe(false);
  });
});

describe("exam event outbox record validation", () => {
  it("accepts a well-formed exam event record with bounded JSON metadata", () => {
    expect(isExamEventOutboxRecord(examEventRecord())).toBe(true);
  });

  it("rejects an unknown event type, non-timestamp occurredAt, and unsafe metadata", () => {
    expect(isExamEventOutboxRecord(examEventRecord({
      payload: { eventType: "not_a_real_event" as never, occurredAt: "2026-07-12T00:00:00.000Z", metadata: {} },
    }))).toBe(false);
    expect(isExamEventOutboxRecord(examEventRecord({
      payload: { eventType: "window_focus", occurredAt: "not-a-date", metadata: {} },
    }))).toBe(false);
    expect(isExamEventOutboxRecord(examEventRecord({
      payload: { eventType: "window_focus", occurredAt: "2026-07-12T00:00:00.000Z", metadata: { big: "x".repeat(5_000) } },
    }))).toBe(false);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(isExamEventOutboxRecord(examEventRecord({
      payload: { eventType: "window_focus", occurredAt: "2026-07-12T00:00:00.000Z", metadata: circular },
    }))).toBe(false);
  });
});

describe("union discriminator", () => {
  it("recognizes each outbox record kind and rejects unrelated values", () => {
    expect(isBrowserOutboxRecord(draftRecord())).toBe(true);
    expect(isBrowserOutboxRecord(examAnswerRecord())).toBe(true);
    expect(isBrowserOutboxRecord(examEventRecord())).toBe(true);
    expect(isBrowserOutboxRecord({ kind: "unknown" })).toBe(false);
    expect(isBrowserOutboxRecord(null)).toBe(false);
  });
});
