"use client";

import { useCallback, useEffect, useMemo, useReducer } from "react";

import {
  EMERGENCY_EXAM_EVENT_PREFIX,
  drainEmergencyExamEvents,
  writeEmergencyExamEvent,
} from "@/lib/browser-durability/emergency-events";
import type { BrowserOutboxRepository } from "@/lib/browser-durability/indexed-db";
import {
  examAnswerOutboxStorageKey,
  examEventOutboxStorageKey,
  isExamAnswerOutboxRecord,
  isExamEventOutboxRecord,
  type ExamAnswerOutboxRecord,
  type ExamEventOutboxRecord,
} from "@/lib/browser-durability/types";
import {
  SUPPORTED_EXAM_LANGUAGES,
  type ClientExamEventType,
  type ExamAnswer,
  type ExamSessionStatus,
  type ExamSessionView,
  type PublicExamItem,
} from "@/lib/exams/contracts";

export const EXAM_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
export const EXAM_REQUEST_TIMEOUT_MS = 10_000;

const EXAM_ANSWER_DEBOUNCE_MS = 1_000;
const WRITTEN_ANSWER_MAX_CHARACTERS = 32_000;
const SOURCE_CODE_MAX_CHARACTERS = 131_072;
const TERMINAL_EXAM_RECOVERY_STATUSES = new Set<ExamSessionStatus>([
  "submitted",
  "expired",
  "graded",
  "under_review",
  "invalidated",
]);
const NON_EDITABLE_EXAM_STATUSES = new Set<ExamSessionStatus>([
  "scheduled",
  "paused_by_system",
]);
const SUPPORTED_LANGUAGE_SET = new Set<string>(SUPPORTED_EXAM_LANGUAGES);

export type ExamAnswerSaveState =
  | "server-saved"
  | "saving-local"
  | "saved-local"
  | "syncing"
  | "offline-saved-local"
  | "local-save-error"
  | "conflict";

export type ExamAnswerConflict = Readonly<{
  itemId: string;
  clientMutationId: string;
  localAnswer: string;
  serverAnswer: string;
  serverRevision: number;
  serverSavedAt: string | null;
}>;

export type ExamOutboxIssue = Readonly<{
  kind: "server-closure" | "server-rejected" | "protocol" | "event-recovery";
  message: string;
  itemId?: string;
}>;

type SessionWriteBarrier = {
  terminalClosed: boolean;
  owners: number;
  writes: Set<Promise<unknown>>;
};

type ConflictAction = {
  readonly clientMutationId: string;
  readonly token: object;
};

const SESSION_WRITE_BARRIERS = new Map<string, SessionWriteBarrier>();

function sessionWriteBarrier(namespace: string, sessionId: string) {
  const key = `${namespace}\0${sessionId}`;
  const current = SESSION_WRITE_BARRIERS.get(key);
  if (
    current
    && !(current.terminalClosed && current.owners === 0 && current.writes.size === 0)
  ) return current;
  const barrier: SessionWriteBarrier = {
    terminalClosed: false,
    owners: 0,
    writes: new Set(),
  };
  SESSION_WRITE_BARRIERS.set(key, barrier);
  return barrier;
}

type Controller = {
  readonly namespace: string;
  readonly session: ExamSessionView;
  readonly repository: BrowserOutboxRepository;
  readonly items: Map<string, PublicExamItem>;
  readonly writeBarrier: SessionWriteBarrier;
  readonly publish: () => void;
  generation: number;
  retired: boolean;
  closed: boolean;
  deadlineFenced: boolean;
  hydrationFailed: boolean;
  hydrated: boolean;
  estimatedDeadlineAt: number;
  answers: Record<string, string>;
  revisions: Map<string, number>;
  records: Map<string, ExamAnswerOutboxRecord>;
  pendingWrites: Map<string, ExamAnswerOutboxRecord>;
  failedWrites: Map<string, ExamAnswerOutboxRecord>;
  writeChains: Map<string, Promise<unknown>>;
  conflicts: Map<string, ExamAnswerConflict>;
  conflictActions: Map<string, ConflictAction>;
  answerIssues: Map<string, {
    clientMutationId: string | null;
    issue: ExamOutboxIssue;
  }>;
  eventIssue: ExamOutboxIssue | null;
  systemIssue: ExamOutboxIssue | null;
  hardAnswerMutations: Set<string>;
  sentAnswerBodies: Map<string, string>;
  inFlightAnswer: ExamAnswerOutboxRecord | null;
  answerDrain: Promise<void> | null;
  answerRetryable: boolean;
  answerRetryIndex: number;
  answerRetryTimer: ReturnType<typeof setTimeout> | null;
  answerDebounceTimer: ReturnType<typeof setTimeout> | null;
  events: Map<string, ExamEventOutboxRecord>;
  failedEventWrites: Map<string, ExamEventOutboxRecord>;
  hardEventIds: Set<string>;
  sentEventBodies: Map<string, string>;
  eventDrain: Promise<void> | null;
  eventRetryIndex: number;
  eventRetryTimer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  abortControllers: Set<AbortController>;
};

type AnswerAcknowledgement = {
  kind: "ack";
  revision: number;
};

type AnswerConflictOutcome = {
  kind: "conflict";
  conflict: ExamAnswerConflict;
};

type AnswerHardOutcome = {
  kind: "hard";
  issue: ExamOutboxIssue;
  closeGeneration?: boolean;
};

type AnswerClosureOutcome = {
  kind: "closure";
  issue: ExamOutboxIssue;
};

type AnswerOutcome =
  | AnswerAcknowledgement
  | AnswerConflictOutcome
  | AnswerHardOutcome
  | AnswerClosureOutcome;

class RetryableOutboxError extends Error {}
class ClosedOutboxError extends Error {}
class HardOutboxError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeRevision(value: unknown, positive = false): value is number {
  return Number.isSafeInteger(value) && Number(value) >= (positive ? 1 : 0);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

const EXAM_SESSION_STATUSES = new Set<ExamSessionStatus>([
  "scheduled",
  "active",
  "paused_by_system",
  "submitted",
  "expired",
  "graded",
  "under_review",
  "invalidated",
]);

function isPublicExamItem(value: unknown): value is PublicExamItem {
  if (!isPlainObject(value)) return false;
  if (
    !isNonEmptyString(value.id)
    || !isNonEmptyString(value.skillId)
    || !isNonEmptyString(value.clusterId)
    || !isNonEmptyString(value.title)
    || !isNonEmptyString(value.prompt)
    || (value.kind !== "short-answer" && value.kind !== "code")
    || typeof value.points !== "number"
    || !Number.isFinite(value.points)
    || value.points < 0
    || typeof value.critical !== "boolean"
    || typeof value.verificationAvailable !== "boolean"
    || (value.starterCode !== undefined && typeof value.starterCode !== "string")
  ) return false;
  if (
    value.runtime !== undefined
    && (!isPlainObject(value.runtime)
      || !isNonEmptyString(value.runtime.version)
      || !isNonEmptyString(value.runtime.imageDigest))
  ) return false;
  if (value.kind === "code") {
    return typeof value.language === "string" && SUPPORTED_LANGUAGE_SET.has(value.language);
  }
  return value.language === undefined;
}

function isExamResult(value: unknown): boolean {
  if (!isPlainObject(value) || !isPlainObject(value.remediation)) return false;
  if (
    value.schemaVersion !== 1
    || (value.gradingStatus !== "graded" && value.gradingStatus !== "pending-review")
    || !["NOT_PASSED", "PASSED", "MASTERED", "PENDING_REVIEW"].includes(String(value.outcome))
    || !isNullableFiniteNumber(value.officialScorePercent)
    || !isNullableFiniteNumber(value.earnedPoints)
    || typeof value.possiblePoints !== "number"
    || !Number.isFinite(value.possiblePoints)
    || value.possiblePoints < 0
    || !isStringArray(value.pendingReviewItemIds)
    || !isStringArray(value.failedCriticalClusters)
    || !isStringArray(value.masteryBlockingCodingItems)
    || (value.compilationGatePassed !== null && typeof value.compilationGatePassed !== "boolean")
    || typeof value.infrastructureFailure !== "boolean"
    || !isTimestamp(value.finalizedAt)
    || (value.finalizedBy !== "learner-submit" && value.finalizedBy !== "deadline")
    || !isNonEmptyString(value.policyVersion)
    || typeof value.remediation.required !== "boolean"
    || !isStringArray(value.remediation.targets)
  ) return false;
  if (value.masteryRecheck === undefined) return true;
  return isPlainObject(value.masteryRecheck)
    && typeof value.masteryRecheck.required === "boolean"
    && isStringArray(value.masteryRecheck.clusterIds)
    && isStringArray(value.masteryRecheck.codingItemIds);
}

function isRetakeEligibility(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return typeof value.eligible === "boolean"
    && [
      "first-attempt",
      "technical-incident",
      "admin-reexam-grant",
      "cooldown",
      "remediation-required",
      "pending-review",
      "already-mastered",
      "eligible",
    ].includes(String(value.reason))
    && (value.nextEligibleAt === null || isTimestamp(value.nextEligibleAt))
    && typeof value.requiresRemediation === "boolean";
}

export function isExamSessionView(
  value: unknown,
  expectedSessionId: string,
): value is ExamSessionView {
  if (!isPlainObject(value) || !isPlainObject(value.form) || !isPlainObject(value.answers)) {
    return false;
  }
  if (
    value.sessionId !== expectedSessionId
    || !isNonEmptyString(value.sessionId)
    || !isNonEmptyString(value.attemptId)
    || !isSafeRevision(value.attemptNumber, true)
    || typeof value.status !== "string"
    || !EXAM_SESSION_STATUSES.has(value.status as ExamSessionStatus)
    || !isTimestamp(value.serverNow)
    || !isTimestamp(value.serverStartedAt)
    || !isTimestamp(value.serverDeadlineAt)
    || !isSafeRevision(value.disconnectedSeconds)
    || !isNonEmptyString(value.integrityReviewState)
    || value.form.schemaVersion !== 1
    || (value.form.purpose !== undefined
      && value.form.purpose !== "formal-exam"
      && value.form.purpose !== "mastery-recheck")
    || !isNonEmptyString(value.form.formId)
    || !isNonEmptyString(value.form.courseId)
    || !isNonEmptyString(value.form.courseTitle)
    || !isNonEmptyString(value.form.moduleId)
    || !isNonEmptyString(value.form.moduleTitle)
    || !isNonEmptyString(value.form.contentVersion)
    || !isNonEmptyString(value.form.policyVersion)
    || !isSafeRevision(value.form.durationMinutes, true)
    || !isTimestamp(value.form.generatedAt)
    || !isStringArray(value.form.instructions)
    || !isPlainObject(value.form.integrityDisclosure)
    || !isNonEmptyString(value.form.integrityDisclosure.version)
    || !isNonEmptyString(value.form.integrityDisclosure.summary)
    || !isStringArray(value.form.integrityDisclosure.capturedEvents)
    || !isStringArray(value.form.integrityDisclosure.notCaptured)
    || !Array.isArray(value.form.items)
    || value.form.items.length === 0
    || !value.form.items.every(isPublicExamItem)
  ) return false;

  const items = new Map<string, PublicExamItem>();
  for (const item of value.form.items) {
    if (items.has(item.id)) return false;
    items.set(item.id, item);
  }
  for (const [itemId, savedValue] of Object.entries(value.answers)) {
    const item = items.get(itemId);
    if (!item || !isPlainObject(savedValue) || !isPlainObject(savedValue.answer)) return false;
    if (!isSafeRevision(savedValue.revision) || !isTimestamp(savedValue.savedAt)) return false;
    if (item.kind === "code") {
      if (
        typeof savedValue.answer.sourceCode !== "string"
        || savedValue.answer.language !== item.language
        || savedValue.answer.text !== undefined
      ) return false;
    } else if (
      typeof savedValue.answer.text !== "string"
      || savedValue.answer.sourceCode !== undefined
      || savedValue.answer.language !== undefined
    ) return false;
  }

  if (value.result !== null && !isExamResult(value.result)) return false;
  if (value.retake !== null && !isRetakeEligibility(value.retake)) return false;
  if (typeof value.appealSubmitted !== "boolean") return false;
  if (value.appeal !== null) {
    if (
      !isPlainObject(value.appeal)
      || !isNonEmptyString(value.appeal.id)
      || !isNonEmptyString(value.appeal.status)
      || (value.appeal.decision !== null && typeof value.appeal.decision !== "string")
      || (value.appeal.decisionReason !== null && typeof value.appeal.decisionReason !== "string")
      || !isTimestamp(value.appeal.updatedAt)
    ) return false;
  }
  return true;
}

function isRetryableHttpStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function responseCode(body: unknown) {
  return isPlainObject(body) && typeof body.code === "string" ? body.code : null;
}

function isExamAuthorityBoundary(status: number, body: unknown) {
  return status === 401
    || status === 403
    || status === 404
    || responseCode(body) === "EXAM_NOT_FOUND";
}

function editorValue(item: PublicExamItem, answer: ExamAnswer | undefined): string {
  return item.kind === "code"
    ? answer?.sourceCode ?? item.starterCode ?? ""
    : answer?.text ?? "";
}

function validItem(item: PublicExamItem | undefined): item is PublicExamItem {
  if (!item || (item.kind !== "short-answer" && item.kind !== "code")) return false;
  return item.kind !== "code"
    || (typeof item.language === "string" && SUPPORTED_LANGUAGE_SET.has(item.language));
}

function answerWithinLimit(item: PublicExamItem, value: string): boolean {
  return value.length <= (
    item.kind === "code" ? SOURCE_CODE_MAX_CHARACTERS : WRITTEN_ANSWER_MAX_CHARACTERS
  );
}

function apiAnswer(item: PublicExamItem, value: string): ExamAnswer {
  if (item.kind === "code") {
    if (!item.language || !SUPPORTED_LANGUAGE_SET.has(item.language)) {
      throw new Error("The immutable code language is not supported.");
    }
    return { sourceCode: value, language: item.language };
  }
  return { text: value };
}

function responseEditorValue(item: PublicExamItem, value: unknown): string | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (item.kind === "code") {
    if (!item.language || !SUPPORTED_LANGUAGE_SET.has(item.language)) return null;
    if (keys.length !== 2 || !keys.includes("sourceCode") || !keys.includes("language")) return null;
    return typeof value.sourceCode === "string" && value.language === item.language
      ? value.sourceCode
      : null;
  }
  if (keys.length !== 1 || keys[0] !== "text") return null;
  return typeof value.text === "string" ? value.text : null;
}

function initialEditorValues(session: ExamSessionView) {
  const answers: Record<string, string> = {};
  const revisions = new Map<string, number>();
  for (const item of session.form.items) {
    answers[item.id] = editorValue(item, session.answers[item.id]?.answer);
    const saved = session.answers[item.id];
    if (saved && isSafeRevision(saved.revision)) revisions.set(item.id, saved.revision);
  }
  return { answers, revisions };
}

function estimatedDeadline(session: ExamSessionView, receivedAt: number): number {
  const serverNow = Date.parse(session.serverNow);
  const deadline = Date.parse(session.serverDeadlineAt);
  if (!Number.isFinite(serverNow) || !Number.isFinite(deadline)) return receivedAt;
  return receivedAt + (deadline - serverNow);
}

function createController(
  input: {
    namespace: string;
    session: ExamSessionView;
    repository: BrowserOutboxRepository;
  },
  publish: () => void,
): Controller {
  if (!isExamSessionView(input.session, input.session.sessionId)) {
    throw new Error("The exam session view is not safe for browser recovery.");
  }
  const baseline = initialEditorValues(input.session);
  return {
    ...input,
    items: new Map(input.session.form.items.map((item) => [item.id, item])),
    writeBarrier: sessionWriteBarrier(input.namespace, input.session.sessionId),
    publish,
    generation: 0,
    retired: true,
    closed: false,
    deadlineFenced: false,
    hydrationFailed: false,
    hydrated: false,
    estimatedDeadlineAt: estimatedDeadline(input.session, Date.now()),
    answers: baseline.answers,
    revisions: baseline.revisions,
    records: new Map(),
    pendingWrites: new Map(),
    failedWrites: new Map(),
    writeChains: new Map(),
    conflicts: new Map(),
    conflictActions: new Map(),
    answerIssues: new Map(),
    eventIssue: null,
    systemIssue: null,
    hardAnswerMutations: new Set(),
    sentAnswerBodies: new Map(),
    inFlightAnswer: null,
    answerDrain: null,
    answerRetryable: false,
    answerRetryIndex: 0,
    answerRetryTimer: null,
    answerDebounceTimer: null,
    events: new Map(),
    failedEventWrites: new Map(),
    hardEventIds: new Set(),
    sentEventBodies: new Map(),
    eventDrain: null,
    eventRetryIndex: 0,
    eventRetryTimer: null,
    deadlineTimer: null,
    abortControllers: new Set(),
  };
}

function live(controller: Controller, generation: number) {
  return !controller.retired && controller.generation === generation;
}

function deadlineReached(controller: Controller) {
  return controller.deadlineFenced || Date.now() >= controller.estimatedDeadlineAt;
}

function publish(controller: Controller) {
  if (!controller.retired) controller.publish();
}

const ISSUE_PRIORITY: Readonly<Record<ExamOutboxIssue["kind"], number>> = {
  "server-closure": 0,
  protocol: 1,
  "server-rejected": 2,
  "event-recovery": 3,
};

function visibleIssue(controller: Controller): ExamOutboxIssue | null {
  const candidates = [
    ...[...controller.answerIssues.values()]
      .sort((left, right) => (left.issue.itemId ?? "").localeCompare(right.issue.itemId ?? ""))
      .map(({ issue }) => ({ issue, lane: 0 })),
    ...(controller.eventIssue ? [{ issue: controller.eventIssue, lane: 1 }] : []),
    ...(controller.systemIssue ? [{ issue: controller.systemIssue, lane: 2 }] : []),
  ];
  candidates.sort((left, right) =>
    ISSUE_PRIORITY[left.issue.kind] - ISSUE_PRIORITY[right.issue.kind]
    || left.lane - right.lane
  );
  return candidates[0]?.issue ?? null;
}

function setAnswerIssue(
  controller: Controller,
  itemId: string,
  clientMutationId: string | null,
  issue: ExamOutboxIssue,
) {
  controller.answerIssues.set(itemId, { clientMutationId, issue });
}

function clearOwnedAnswerIssue(
  controller: Controller,
  itemId: string,
  clientMutationId: string,
) {
  const current = controller.answerIssues.get(itemId);
  if (current?.clientMutationId === clientMutationId) controller.answerIssues.delete(itemId);
}

function trackSessionWrite<T>(controller: Controller, operation: Promise<T>): Promise<T> {
  const tracked = operation.finally(() => {
    controller.writeBarrier.writes.delete(tracked);
  });
  controller.writeBarrier.writes.add(tracked);
  return tracked;
}

function clearTimer(
  controller: Controller,
  key: "answerRetryTimer" | "answerDebounceTimer" | "eventRetryTimer" | "deadlineTimer",
) {
  const timer = controller[key];
  if (timer !== null) clearTimeout(timer);
  controller[key] = null;
}

function stopOwnedWork(controller: Controller) {
  clearTimer(controller, "answerRetryTimer");
  clearTimer(controller, "answerDebounceTimer");
  clearTimer(controller, "eventRetryTimer");
  clearTimer(controller, "deadlineTimer");
  for (const abortController of controller.abortControllers) abortController.abort();
  controller.abortControllers.clear();
}

function closeControllerBoundary(controller: Controller) {
  controller.closed = true;
  stopOwnedWork(controller);
}

function fenceDeadline(controller: Controller, generation: number) {
  if (!live(controller, generation) || controller.deadlineFenced) return;
  controller.deadlineFenced = true;
  stopOwnedWork(controller);
  publish(controller);
}

function assertWorkAllowed(controller: Controller) {
  if (!controller.hydrated || controller.hydrationFailed) {
    throw new ClosedOutboxError("Exam recovery is not available.");
  }
  if (
    controller.retired
    || controller.closed
    || controller.writeBarrier.terminalClosed
    || controller.session.status !== "active"
    || deadlineReached(controller)
  ) {
    if (deadlineReached(controller)) fenceDeadline(controller, controller.generation);
    throw new ClosedOutboxError("This exam no longer accepts local work.");
  }
}

function buildAnswerRecord(
  controller: Controller,
  item: PublicExamItem,
  answer: string,
  clientMutationId = crypto.randomUUID(),
  baseRevision = controller.revisions.get(item.id) ?? 0,
): ExamAnswerOutboxRecord {
  const record: ExamAnswerOutboxRecord = {
    schemaVersion: 1,
    storageKey: examAnswerOutboxStorageKey(
      controller.namespace,
      controller.session.sessionId,
      item.id,
    ),
    namespace: controller.namespace,
    kind: "exam-answer",
    scope: controller.session.sessionId,
    clientMutationId,
    updatedAt: new Date().toISOString(),
    payload: { itemId: item.id, answer, baseRevision },
  };
  if (!isExamAnswerOutboxRecord(record)) throw new Error("Exam answer recovery record is invalid.");
  return record;
}

export function createExamEventOutboxRecord(input: {
  namespace: string;
  sessionId: string;
  eventType: ClientExamEventType;
  metadata?: Readonly<Record<string, unknown>>;
  clientEventId?: string;
  occurredAt?: string;
}): ExamEventOutboxRecord {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const clientEventId = input.clientEventId ?? crypto.randomUUID();
  const record: ExamEventOutboxRecord = {
    schemaVersion: 1,
    storageKey: examEventOutboxStorageKey(input.namespace, input.sessionId, clientEventId),
    namespace: input.namespace,
    kind: "exam-event",
    scope: input.sessionId,
    clientEventId,
    updatedAt: occurredAt,
    payload: {
      eventType: input.eventType,
      occurredAt,
      metadata: { ...(input.metadata ?? {}) },
    },
  };
  if (!isExamEventOutboxRecord(record)) throw new Error("Exam event recovery record is invalid.");
  return record;
}

function prepareControllerUnloadEvent(
  controller: Controller,
  metadata: Readonly<Record<string, unknown>>,
) {
  const generation = controller.generation;
  if (
    !live(controller, generation)
    || !controller.hydrated
    || controller.hydrationFailed
    || controller.closed
    || controller.writeBarrier.terminalClosed
    || controller.session.status !== "active"
    || deadlineReached(controller)
  ) {
    if (live(controller, generation) && deadlineReached(controller)) {
      fenceDeadline(controller, generation);
    }
    return null;
  }
  const record = createExamEventOutboxRecord({
    namespace: controller.namespace,
    sessionId: controller.session.sessionId,
    eventType: "navigation_attempt",
    metadata,
  });
  try {
    if (typeof window !== "undefined") writeEmergencyExamEvent(window.localStorage, record);
  } catch {
    // The canonical record is still eligible for the independent beacon attempt.
  }
  return record;
}

function answerSaveState(controller: Controller): ExamAnswerSaveState {
  if (controller.conflicts.size > 0) return "conflict";
  if (controller.failedWrites.size > 0) return "local-save-error";
  if (controller.pendingWrites.size > 0) return "saving-local";
  if (controller.inFlightAnswer !== null) return "syncing";
  if (controller.records.size > 0 && controller.answerRetryable) return "offline-saved-local";
  if (controller.records.size > 0) return "saved-local";
  return "server-saved";
}

function sortedAnswers(controller: Controller) {
  return [...controller.records.values()].sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) return left.updatedAt.localeCompare(right.updatedAt);
    return left.storageKey.localeCompare(right.storageKey);
  });
}

function hasEligibleAnswer(controller: Controller) {
  return sortedAnswers(controller).some((candidate) => {
    const itemId = candidate.payload.itemId;
    return !controller.pendingWrites.has(itemId)
      && !controller.failedWrites.has(itemId)
      && !controller.conflicts.has(itemId)
      && !controller.hardAnswerMutations.has(candidate.clientMutationId);
  });
}

function sortedEvents(records: Iterable<ExamEventOutboxRecord>) {
  return [...records].sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) return left.updatedAt.localeCompare(right.updatedAt);
    return left.storageKey.localeCompare(right.storageKey);
  });
}

async function requestJson(
  controller: Controller,
  generation: number,
  input: RequestInfo | URL,
  init: RequestInit,
) {
  if (!live(controller, generation) || controller.closed || deadlineReached(controller)) {
    if (deadlineReached(controller)) fenceDeadline(controller, generation);
    throw new ClosedOutboxError("The exam request boundary is closed.");
  }
  const abortController = new AbortController();
  controller.abortControllers.add(abortController);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, EXAM_REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(input, { ...init, signal: abortController.signal });
    } catch {
      if (!live(controller, generation) || controller.closed || deadlineReached(controller)) {
        throw new ClosedOutboxError("The exam request boundary is closed.");
      }
      throw new RetryableOutboxError(
        timedOut ? "The exam request timed out." : "The exam request was not confirmed.",
      );
    }
    if (!live(controller, generation) || controller.closed || deadlineReached(controller)) {
      throw new ClosedOutboxError("The exam request boundary is closed.");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (
        isRetryableHttpStatus(response.status)
        || timedOut
        || abortController.signal.aborted
        || !(error instanceof SyntaxError)
      ) {
        throw new RetryableOutboxError("The exam response was incomplete.");
      }
      body = undefined;
    }
    if (!live(controller, generation) || controller.closed || deadlineReached(controller)) {
      if (deadlineReached(controller)) fenceDeadline(controller, generation);
      throw new ClosedOutboxError("The exam request boundary is closed.");
    }
    return { response, body };
  } finally {
    clearTimeout(timeout);
    controller.abortControllers.delete(abortController);
  }
}

function retryDelay(index: number) {
  return EXAM_RETRY_DELAYS_MS[Math.min(index, EXAM_RETRY_DELAYS_MS.length - 1)]!;
}

function scheduleAnswerRetry(controller: Controller, generation: number) {
  if (!live(controller, generation) || controller.closed || deadlineReached(controller)) return;
  clearTimer(controller, "answerRetryTimer");
  const delay = retryDelay(controller.answerRetryIndex);
  controller.answerRetryIndex = Math.min(
    controller.answerRetryIndex + 1,
    EXAM_RETRY_DELAYS_MS.length - 1,
  );
  controller.answerRetryTimer = setTimeout(() => {
    controller.answerRetryTimer = null;
    if (!live(controller, generation) || controller.closed || deadlineReached(controller)) return;
    void startAnswerDrain(controller).catch(() => undefined);
  }, delay);
}

function scheduleEventRetry(controller: Controller, generation: number) {
  if (!live(controller, generation) || controller.closed || deadlineReached(controller)) return;
  clearTimer(controller, "eventRetryTimer");
  const delay = retryDelay(controller.eventRetryIndex);
  controller.eventRetryIndex = Math.min(
    controller.eventRetryIndex + 1,
    EXAM_RETRY_DELAYS_MS.length - 1,
  );
  controller.eventRetryTimer = setTimeout(() => {
    controller.eventRetryTimer = null;
    if (!live(controller, generation) || controller.closed || deadlineReached(controller)) return;
    void startEventDrain(controller).catch(() => undefined);
  }, delay);
}

function scheduleAnswerDebounce(controller: Controller, generation: number) {
  clearTimer(controller, "answerDebounceTimer");
  if (!live(controller, generation) || controller.closed || deadlineReached(controller)) return;
  controller.answerDebounceTimer = setTimeout(() => {
    controller.answerDebounceTimer = null;
    if (!live(controller, generation) || controller.closed || deadlineReached(controller)) return;
    void startAnswerDrain(controller).catch(() => undefined);
  }, EXAM_ANSWER_DEBOUNCE_MS);
}

async function autosaveOutcome(
  controller: Controller,
  generation: number,
  record: ExamAnswerOutboxRecord,
  item: PublicExamItem,
): Promise<AnswerOutcome> {
  const request = {
    clientMutationId: record.clientMutationId,
    itemId: record.payload.itemId,
    baseRevision: record.payload.baseRevision,
    answer: apiAnswer(item, record.payload.answer),
  };
  const freshBody = JSON.stringify(request);
  const priorBody = controller.sentAnswerBodies.get(record.clientMutationId);
  if (priorBody !== undefined && priorBody !== freshBody) {
    return {
      kind: "hard",
      issue: {
        kind: "protocol",
        itemId: item.id,
        message: "Needs attention: this recovered answer changed after synchronization began.",
      },
    };
  }
  const bodyText = priorBody ?? freshBody;
  controller.sentAnswerBodies.set(record.clientMutationId, bodyText);
  const { response, body } = await requestJson(
    controller,
    generation,
    `/api/exams/${controller.session.sessionId}/autosave`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: bodyText,
    },
  );

  if (isExamAuthorityBoundary(response.status, body)) {
    return {
      kind: "hard",
      closeGeneration: true,
      issue: {
        kind: "server-rejected",
        itemId: item.id,
        message: "Needs attention: Codestead rejected this exam authority boundary.",
      },
    };
  }

  if (response.ok) {
    if (!isPlainObject(body) || !isPlainObject(body.saved)) {
      return {
        kind: "hard",
        issue: {
          kind: "protocol",
          itemId: item.id,
          message: "Needs attention: Codestead returned an unexpected autosave acknowledgement.",
        },
      };
    }
    const saved = body.saved;
    const returnedValue = responseEditorValue(item, saved.answer);
    if (
      saved.clientMutationId !== record.clientMutationId
      || typeof saved.replayed !== "boolean"
      || !isSafeRevision(saved.revision, true)
      || saved.revision !== record.payload.baseRevision + 1
      || !isTimestamp(saved.savedAt)
      || returnedValue !== record.payload.answer
    ) {
      return {
        kind: "hard",
        issue: {
          kind: "protocol",
          itemId: item.id,
          message: "Needs attention: Codestead returned an unexpected autosave acknowledgement.",
        },
      };
    }
    return { kind: "ack", revision: saved.revision };
  }

  if (isRetryableHttpStatus(response.status)) {
    throw new RetryableOutboxError("Codestead did not confirm the autosave.");
  }

  if (isPlainObject(body) && body.code === "AUTOSAVE_REVISION_CONFLICT") {
    const serverAnswer = responseEditorValue(item, body.currentAnswer);
    const savedAt = body.currentSavedAt;
    if (
      !isSafeRevision(body.currentRevision)
      || serverAnswer === null
      || (savedAt !== null && !isTimestamp(savedAt))
    ) {
      return {
        kind: "hard",
        issue: {
          kind: "protocol",
          itemId: item.id,
          message: "Needs attention: Codestead returned an invalid answer conflict.",
        },
      };
    }
    return {
      kind: "conflict",
      conflict: {
        itemId: item.id,
        clientMutationId: record.clientMutationId,
        localAnswer: record.payload.answer,
        serverAnswer,
        serverRevision: body.currentRevision,
        serverSavedAt: savedAt,
      },
    };
  }

  if (isPlainObject(body) && (body.code === "EXAM_EXPIRED" || body.code === "EXAM_NOT_ACTIVE")) {
    return {
      kind: "closure",
      issue: {
        kind: "server-closure",
        itemId: item.id,
        message: "Codestead reports that this exam is closed. Refreshing authoritative status.",
      },
    };
  }

  return {
    kind: "hard",
    closeGeneration: responseCode(body) === "INVALID_AUTOSAVE"
      || responseCode(body) === "UNKNOWN_EXAM_ITEM",
    issue: {
      kind: isPlainObject(body) && body.code === "AUTOSAVE_IDEMPOTENCY_MISMATCH"
        ? "protocol"
        : "server-rejected",
      itemId: item.id,
      message: "Needs attention: Codestead did not accept this locally saved answer.",
    },
  };
}

async function currentPersistedAnswer(controller: Controller, itemId: string) {
  const listed = await controller.repository.listExamAnswers(
    controller.namespace,
    controller.session.sessionId,
  );
  return listed.find((candidate) => candidate.payload.itemId === itemId) ?? null;
}

function markAnswerDurabilityLost(
  controller: Controller,
  record: ExamAnswerOutboxRecord,
) {
  const itemId = record.payload.itemId;
  if (controller.records.get(itemId)?.clientMutationId === record.clientMutationId) {
    controller.records.delete(itemId);
  }
  controller.pendingWrites.delete(itemId);
  controller.failedWrites.set(itemId, record);
  controller.conflicts.delete(itemId);
  controller.hardAnswerMutations.add(record.clientMutationId);
  controller.answerRetryable = false;
  clearTimer(controller, "answerRetryTimer");
  setAnswerIssue(controller, itemId, record.clientMutationId, {
    kind: "protocol",
    itemId,
    message: "Needs attention: this answer is no longer confirmed as saved on this browser.",
  });
  publish(controller);
}

async function rebaseUnsentRecord(
  controller: Controller,
  generation: number,
  record: ExamAnswerOutboxRecord,
  baseRevision: number,
) {
  if (record.payload.baseRevision === baseRevision) return record;
  if (controller.sentAnswerBodies.has(record.clientMutationId)) {
    controller.hardAnswerMutations.add(record.clientMutationId);
    setAnswerIssue(controller, record.payload.itemId, record.clientMutationId, {
      kind: "protocol",
      itemId: record.payload.itemId,
      message: "Needs attention: a synchronized answer cannot be safely rebased.",
    });
    publish(controller);
    throw new ClosedOutboxError("The answer cannot be safely rebased.");
  }
  const rebased: ExamAnswerOutboxRecord = {
    ...record,
    updatedAt: new Date().toISOString(),
    payload: { ...record.payload, baseRevision },
  };
  try {
    if (controller.writeBarrier.terminalClosed) {
      throw new ClosedOutboxError("The queued local answer rebase is closed.");
    }
    await trackSessionWrite(controller, controller.repository.putExamAnswer(rebased));
  } catch {
    if (controller.writeBarrier.terminalClosed) {
      throw new ClosedOutboxError("The queued local answer rebase is closed.");
    }
    throw new RetryableOutboxError("The acknowledged answer could not be rebased locally.");
  }
  if (!live(controller, generation) || controller.closed || deadlineReached(controller)) {
    throw new ClosedOutboxError("The exam request boundary is closed.");
  }
  if (controller.records.get(record.payload.itemId)?.clientMutationId === record.clientMutationId) {
    controller.records.set(record.payload.itemId, rebased);
  }
  return rebased;
}

async function acknowledgeAnswer(
  controller: Controller,
  generation: number,
  record: ExamAnswerOutboxRecord,
  revision: number,
) {
  let removed: boolean;
  try {
    removed = await controller.repository.deleteExamAnswerIfMutation(
      controller.namespace,
      controller.session.sessionId,
      record.payload.itemId,
      record.clientMutationId,
    );
  } catch {
    throw new RetryableOutboxError("The autosave acknowledgement could not be cleared locally.");
  }
  if (!live(controller, generation) || controller.closed || deadlineReached(controller)) {
    throw new ClosedOutboxError("The exam request boundary is closed.");
  }
  controller.revisions.set(record.payload.itemId, revision);
  if (removed) {
    if (controller.records.get(record.payload.itemId)?.clientMutationId === record.clientMutationId) {
      controller.records.delete(record.payload.itemId);
    }
    clearOwnedAnswerIssue(controller, record.payload.itemId, record.clientMutationId);
    return;
  }
  let current: ExamAnswerOutboxRecord | null;
  try {
    current = await currentPersistedAnswer(controller, record.payload.itemId);
  } catch {
    throw new RetryableOutboxError("The autosave acknowledgement could not be reread locally.");
  }
  if (!live(controller, generation) || controller.closed || deadlineReached(controller)) {
    throw new ClosedOutboxError("The exam request boundary is closed.");
  }
  if (current && current.clientMutationId !== record.clientMutationId) {
    const rebased = await rebaseUnsentRecord(controller, generation, current, revision);
    controller.records.set(record.payload.itemId, rebased);
    return;
  }
  if (current === null) {
    markAnswerDurabilityLost(controller, record);
    throw new HardOutboxError("The acknowledged answer is no longer durable locally.");
  }
  throw new RetryableOutboxError("The autosave acknowledgement remains locally recoverable.");
}

async function runAnswerDrain(controller: Controller, generation: number) {
  while (live(controller, generation) && !controller.closed && !deadlineReached(controller)) {
    const record = sortedAnswers(controller).find((candidate) => {
      const itemId = candidate.payload.itemId;
      return !controller.pendingWrites.has(itemId)
        && !controller.failedWrites.has(itemId)
        && !controller.conflicts.has(itemId)
        && !controller.hardAnswerMutations.has(candidate.clientMutationId);
    });
    if (!record) return;
    const item = controller.items.get(record.payload.itemId);
    if (!validItem(item) || !answerWithinLimit(item, record.payload.answer)) {
      controller.hardAnswerMutations.add(record.clientMutationId);
      setAnswerIssue(controller, record.payload.itemId, record.clientMutationId, {
        kind: "protocol",
        itemId: record.payload.itemId,
        message: "Needs attention: a recovered answer does not match this immutable exam form.",
      });
      publish(controller);
      continue;
    }

    controller.inFlightAnswer = record;
    publish(controller);
    try {
      const outcome = await autosaveOutcome(controller, generation, record, item);
      if (!live(controller, generation) || controller.closed || deadlineReached(controller)) {
        throw new ClosedOutboxError("The exam request boundary is closed.");
      }
      if (outcome.kind === "ack") {
        await acknowledgeAnswer(controller, generation, record, outcome.revision);
        controller.answerRetryable = false;
        controller.answerRetryIndex = 0;
        clearTimer(controller, "answerRetryTimer");
      } else if (outcome.kind === "conflict") {
        controller.conflicts.set(record.payload.itemId, outcome.conflict);
      } else if (outcome.kind === "closure") {
        setAnswerIssue(
          controller,
          record.payload.itemId,
          record.clientMutationId,
          outcome.issue,
        );
        controller.hardAnswerMutations.add(record.clientMutationId);
        closeControllerBoundary(controller);
        controller.inFlightAnswer = null;
        publish(controller);
        throw new ClosedOutboxError("The server closed this exam.");
      } else {
        setAnswerIssue(
          controller,
          record.payload.itemId,
          record.clientMutationId,
          outcome.issue,
        );
        controller.hardAnswerMutations.add(record.clientMutationId);
        if (outcome.closeGeneration) {
          closeControllerBoundary(controller);
          controller.inFlightAnswer = null;
          publish(controller);
          throw new ClosedOutboxError("The server rejected this exam boundary.");
        }
      }
    } catch (error) {
      controller.inFlightAnswer = null;
      if (error instanceof RetryableOutboxError && live(controller, generation)) {
        controller.answerRetryable = true;
        publish(controller);
        scheduleAnswerRetry(controller, generation);
      } else {
        publish(controller);
      }
      throw error;
    }
    controller.inFlightAnswer = null;
    publish(controller);
  }
  if (deadlineReached(controller)) fenceDeadline(controller, generation);
}

function startAnswerDrain(controller: Controller): Promise<void> {
  if (controller.answerDrain) return controller.answerDrain;
  const generation = controller.generation;
  if (!live(controller, generation) || controller.closed || deadlineReached(controller)) {
    if (deadlineReached(controller)) fenceDeadline(controller, generation);
    return Promise.reject(new ClosedOutboxError("The answer drain is closed."));
  }
  const running = runAnswerDrain(controller, generation);
  controller.answerDrain = running;
  void running.finally(() => {
    if (controller.answerDrain === running) controller.answerDrain = null;
  }).catch(() => undefined);
  return running;
}

async function persistAnswer(
  controller: Controller,
  record: ExamAnswerOutboxRecord,
  immediate: boolean,
) {
  const generation = controller.generation;
  const itemId = record.payload.itemId;
  controller.pendingWrites.set(itemId, record);
  controller.failedWrites.delete(itemId);
  publish(controller);
  const prior = controller.writeChains.get(itemId) ?? Promise.resolve();
  let persistedRecord = record;
  const operation = prior.catch(() => undefined).then(async () => {
    if (
      !live(controller, generation)
      || controller.closed
      || controller.writeBarrier.terminalClosed
      || deadlineReached(controller)
    ) throw new ClosedOutboxError("The queued local answer write is closed.");
    await controller.repository.putExamAnswer(persistedRecord);
    const acknowledgedRevision = controller.revisions.get(itemId) ?? 0;
    if (
      persistedRecord.payload.baseRevision < acknowledgedRevision
      && !controller.sentAnswerBodies.has(persistedRecord.clientMutationId)
    ) {
      if (
        !live(controller, generation)
        || controller.closed
        || controller.writeBarrier.terminalClosed
        || deadlineReached(controller)
      ) throw new ClosedOutboxError("The queued local answer rebase is closed.");
      persistedRecord = {
        ...persistedRecord,
        updatedAt: new Date().toISOString(),
        payload: { ...persistedRecord.payload, baseRevision: acknowledgedRevision },
      };
      await controller.repository.putExamAnswer(persistedRecord);
    }
  });
  const trackedOperation = trackSessionWrite(controller, operation);
  controller.writeChains.set(itemId, trackedOperation);
  try {
    await trackedOperation;
    if (!live(controller, generation) || controller.closed || deadlineReached(controller)) {
      throw new ClosedOutboxError("The local answer committed after the exam boundary closed.");
    }
    if (controller.pendingWrites.get(itemId)?.clientMutationId === record.clientMutationId) {
      controller.pendingWrites.delete(itemId);
      controller.failedWrites.delete(itemId);
      controller.records.set(itemId, persistedRecord);
      controller.answerRetryable = false;
      controller.answerRetryIndex = 0;
      clearTimer(controller, "answerRetryTimer");
      publish(controller);
      if (immediate) void startAnswerDrain(controller).catch(() => undefined);
      else scheduleAnswerDebounce(controller, generation);
    }
    return persistedRecord;
  } catch (error) {
    if (
      live(controller, generation)
      && controller.pendingWrites.get(itemId)?.clientMutationId === record.clientMutationId
      && !(error instanceof ClosedOutboxError)
    ) {
      controller.pendingWrites.delete(itemId);
      controller.failedWrites.set(itemId, record);
      publish(controller);
    }
    throw error;
  } finally {
    if (controller.writeChains.get(itemId) === trackedOperation) controller.writeChains.delete(itemId);
  }
}

async function persistEventWriteFailure(controller: Controller, generation: number) {
  const record = sortedEvents(controller.failedEventWrites.values())[0];
  if (!record) return;
  try {
    if (controller.writeBarrier.terminalClosed) {
      throw new ClosedOutboxError("The queued integrity event write is closed.");
    }
    await trackSessionWrite(controller, controller.repository.putExamEvent(record));
  } catch {
    if (controller.writeBarrier.terminalClosed) {
      throw new ClosedOutboxError("The queued integrity event write is closed.");
    }
    controller.eventIssue = {
      kind: "event-recovery",
      message: "An integrity event remains queued for browser recovery.",
    };
    publish(controller);
    scheduleEventRetry(controller, generation);
    throw new RetryableOutboxError("The integrity event was not stored.");
  }
  if (!live(controller, generation) || controller.closed || deadlineReached(controller)) {
    throw new ClosedOutboxError("The event drain is closed.");
  }
  controller.failedEventWrites.delete(record.clientEventId);
  controller.events.set(record.clientEventId, record);
}

async function runEventDrain(controller: Controller, generation: number) {
  while (live(controller, generation) && !controller.closed && !deadlineReached(controller)) {
    if (controller.failedEventWrites.size > 0) await persistEventWriteFailure(controller, generation);
    const record = sortedEvents(controller.events.values())
      .find((candidate) => !controller.hardEventIds.has(candidate.clientEventId));
    if (!record) return;
    const freshBody = JSON.stringify({
      clientEventId: record.clientEventId,
      type: record.payload.eventType,
      metadata: record.payload.metadata,
    });
    const priorBody = controller.sentEventBodies.get(record.clientEventId);
    if (priorBody !== undefined && priorBody !== freshBody) {
      controller.hardEventIds.add(record.clientEventId);
      controller.eventIssue = {
        kind: "event-recovery",
        message: "An integrity event could not be safely replayed.",
      };
      publish(controller);
      continue;
    }
    const bodyText = priorBody ?? freshBody;
    controller.sentEventBodies.set(record.clientEventId, bodyText);
    try {
      const { response, body } = await requestJson(
        controller,
        generation,
        `/api/exams/${controller.session.sessionId}/events`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: bodyText,
          keepalive: true,
        },
      );
      if (isExamAuthorityBoundary(response.status, body)) {
        controller.hardEventIds.add(record.clientEventId);
        controller.eventIssue = {
          kind: "server-closure",
          message: "Codestead reports that this exam boundary changed. Refreshing authoritative status.",
        };
        closeControllerBoundary(controller);
        publish(controller);
        throw new ClosedOutboxError("The server closed this exam boundary.");
      }
      if (
        !response.ok
        || !isPlainObject(body)
        || body.accepted !== true
        || typeof body.duplicate !== "boolean"
      ) {
        if (isRetryableHttpStatus(response.status)) {
          throw new RetryableOutboxError("The integrity event was not confirmed.");
        }
        controller.hardEventIds.add(record.clientEventId);
        controller.eventIssue = {
          kind: "event-recovery",
          message: "An integrity event remains queued for browser recovery.",
        };
        publish(controller);
        continue;
      }
      try {
        await controller.repository.deleteExamEvent(
          controller.namespace,
          controller.session.sessionId,
          record.clientEventId,
        );
      } catch {
        throw new RetryableOutboxError("The integrity event acknowledgement could not be cleared locally.");
      }
      if (!live(controller, generation) || controller.closed || deadlineReached(controller)) {
        throw new ClosedOutboxError("The event drain is closed.");
      }
      controller.events.delete(record.clientEventId);
      controller.eventRetryIndex = 0;
      clearTimer(controller, "eventRetryTimer");
      if (
        controller.events.size === 0
        && controller.failedEventWrites.size === 0
        && controller.hardEventIds.size === 0
      ) controller.eventIssue = null;
      publish(controller);
    } catch (error) {
      if (error instanceof RetryableOutboxError && live(controller, generation)) {
        controller.eventIssue = {
          kind: "event-recovery",
          message: "An integrity event remains queued for browser recovery.",
        };
        publish(controller);
        scheduleEventRetry(controller, generation);
      }
      throw error;
    }
  }
  if (deadlineReached(controller)) fenceDeadline(controller, generation);
}

function startEventDrain(controller: Controller): Promise<void> {
  if (controller.eventDrain) return controller.eventDrain;
  const generation = controller.generation;
  if (!live(controller, generation) || controller.closed || deadlineReached(controller)) {
    if (deadlineReached(controller)) fenceDeadline(controller, generation);
    return Promise.reject(new ClosedOutboxError("The event drain is closed."));
  }
  const running = runEventDrain(controller, generation);
  controller.eventDrain = running;
  void running.finally(() => {
    if (controller.eventDrain === running) controller.eventDrain = null;
  }).catch(() => undefined);
  return running;
}

function validateRecoveredAnswer(controller: Controller, record: ExamAnswerOutboxRecord) {
  const item = controller.items.get(record.payload.itemId);
  if (!validItem(item) || !answerWithinLimit(item, record.payload.answer)) {
    controller.hardAnswerMutations.add(record.clientMutationId);
    setAnswerIssue(controller, record.payload.itemId, record.clientMutationId, {
      kind: "protocol",
      itemId: record.payload.itemId,
      message: "Needs attention: a recovered answer does not match this immutable exam form.",
    });
    return false;
  }
  return true;
}

function resetForInitialization(controller: Controller) {
  stopOwnedWork(controller);
  const baseline = initialEditorValues(controller.session);
  controller.closed = TERMINAL_EXAM_RECOVERY_STATUSES.has(controller.session.status);
  controller.deadlineFenced = false;
  controller.hydrationFailed = false;
  controller.hydrated = false;
  controller.estimatedDeadlineAt = estimatedDeadline(controller.session, Date.now());
  controller.answers = baseline.answers;
  controller.revisions = baseline.revisions;
  controller.records.clear();
  controller.pendingWrites.clear();
  controller.failedWrites.clear();
  controller.writeChains.clear();
  controller.conflicts.clear();
  controller.conflictActions.clear();
  controller.answerIssues.clear();
  controller.eventIssue = null;
  controller.systemIssue = null;
  controller.hardAnswerMutations.clear();
  controller.inFlightAnswer = null;
  controller.answerDrain = null;
  controller.answerRetryable = false;
  controller.answerRetryIndex = 0;
  controller.events.clear();
  controller.failedEventWrites.clear();
  controller.hardEventIds.clear();
  controller.eventDrain = null;
  controller.eventRetryIndex = 0;
}

async function initialize(controller: Controller, generation: number) {
  resetForInitialization(controller);
  if (controller.closed || NON_EDITABLE_EXAM_STATUSES.has(controller.session.status)) {
    controller.hydrated = true;
    publish(controller);
    return;
  }
  if (controller.session.status !== "active") {
    controller.hydrationFailed = true;
    controller.hydrated = true;
    controller.systemIssue = {
      kind: "event-recovery",
      message: "Browser recovery could not safely open this exam.",
    };
    publish(controller);
    return;
  }
  if (deadlineReached(controller)) {
    fenceDeadline(controller, generation);
  } else {
    const delay = Math.max(0, controller.estimatedDeadlineAt - Date.now());
    controller.deadlineTimer = setTimeout(() => fenceDeadline(controller, generation), delay);
  }
  try {
    if (typeof window === "undefined") throw new Error("Browser storage is unavailable.");
    await trackSessionWrite(controller, drainEmergencyExamEvents(
      window.localStorage,
      controller.repository,
      controller.namespace,
      controller.session.sessionId,
    ));
    const answers = await controller.repository.listExamAnswers(
      controller.namespace,
      controller.session.sessionId,
    );
    const events = await controller.repository.listExamEvents(
      controller.namespace,
      controller.session.sessionId,
    );
    if (!live(controller, generation)) return;
    for (const record of answers) {
      controller.records.set(record.payload.itemId, record);
      if (validateRecoveredAnswer(controller, record)) {
        controller.answers[record.payload.itemId] = record.payload.answer;
      }
    }
    for (const record of events) controller.events.set(record.clientEventId, record);
    controller.hydrated = true;
    publish(controller);
    if (deadlineReached(controller)) {
      fenceDeadline(controller, generation);
      return;
    }
    void startAnswerDrain(controller).catch(() => undefined);
    void startEventDrain(controller).catch(() => undefined);
  } catch {
    if (!live(controller, generation)) return;
    controller.hydrationFailed = true;
    controller.hydrated = true;
    controller.systemIssue = {
      kind: "event-recovery",
      message: "Could not restore browser recovery. Copy-safe editing is unavailable.",
    };
    publish(controller);
  }
}

async function flushAnswers(controller: Controller) {
  assertWorkAllowed(controller);
  clearTimer(controller, "answerDebounceTimer");
  clearTimer(controller, "answerRetryTimer");
  const chains = [...controller.writeChains.values()];
  if (chains.length > 0) await Promise.allSettled(chains);
  assertWorkAllowed(controller);
  for (const record of [...controller.failedWrites.values()]) {
    await persistAnswer(controller, record, false);
  }
  clearTimer(controller, "answerDebounceTimer");
  assertWorkAllowed(controller);
  do {
    await startAnswerDrain(controller);
  } while (hasEligibleAnswer(controller));
  if (
    controller.pendingWrites.size > 0
    || controller.failedWrites.size > 0
    || controller.records.size > 0
    || controller.conflicts.size > 0
    || controller.inFlightAnswer !== null
  ) {
    throw new Error("Not every locally saved answer was acknowledged by Codestead.");
  }
}

function assertConflictAction(
  controller: Controller,
  itemId: string,
  conflict: ExamAnswerConflict,
  action: ConflictAction,
) {
  assertWorkAllowed(controller);
  const currentAction = controller.conflictActions.get(itemId);
  if (
    currentAction?.token !== action.token
    || currentAction.clientMutationId !== conflict.clientMutationId
    || controller.conflicts.get(itemId)?.clientMutationId !== conflict.clientMutationId
  ) throw new ClosedOutboxError("The answer conflict changed while it was being resolved.");
}

async function resolveAnswerConflict(
  controller: Controller,
  itemId: string,
  choice: "keep-local" | "use-server",
) {
  assertWorkAllowed(controller);
  if (controller.conflictActions.has(itemId)) {
    throw new Error("An answer conflict choice is already being applied.");
  }
  const conflict = controller.conflicts.get(itemId);
  const item = controller.items.get(itemId);
  if (!conflict || !validItem(item)) throw new Error("The answer conflict is no longer available.");
  const action: ConflictAction = {
    clientMutationId: conflict.clientMutationId,
    token: {},
  };
  controller.conflictActions.set(itemId, action);
  publish(controller);
  try {
    if (choice === "keep-local") {
      const current = await currentPersistedAnswer(controller, itemId);
      assertConflictAction(controller, itemId, conflict, action);
      if (current && current.clientMutationId !== conflict.clientMutationId) {
        if (validateRecoveredAnswer(controller, current)) {
          controller.records.set(itemId, current);
          controller.answers = { ...controller.answers, [itemId]: current.payload.answer };
          controller.conflicts.set(itemId, {
            ...conflict,
            clientMutationId: current.clientMutationId,
            localAnswer: current.payload.answer,
          });
        }
        publish(controller);
        throw new Error("A newer recovered answer was preserved.");
      }
      const replacement = buildAnswerRecord(
        controller,
        item,
        conflict.localAnswer,
        crypto.randomUUID(),
        conflict.serverRevision,
      );
      await persistAnswer(controller, replacement, false);
      assertConflictAction(controller, itemId, conflict, action);
      controller.revisions.set(itemId, conflict.serverRevision);
      controller.conflicts.delete(itemId);
      controller.hardAnswerMutations.delete(conflict.clientMutationId);
      clearOwnedAnswerIssue(controller, itemId, conflict.clientMutationId);
      clearTimer(controller, "answerDebounceTimer");
      publish(controller);
      await startAnswerDrain(controller);
      return;
    }

    const conflictedRecord = controller.records.get(itemId);
    let removed: boolean;
    try {
      removed = await controller.repository.deleteExamAnswerIfMutation(
        controller.namespace,
        controller.session.sessionId,
        itemId,
        conflict.clientMutationId,
      );
    } catch (error) {
      publish(controller);
      throw error;
    }
    assertConflictAction(controller, itemId, conflict, action);
    if (removed) {
      if (controller.records.get(itemId)?.clientMutationId === conflict.clientMutationId) {
        controller.records.delete(itemId);
      }
      controller.answers = { ...controller.answers, [itemId]: conflict.serverAnswer };
      controller.revisions.set(itemId, conflict.serverRevision);
      controller.conflicts.delete(itemId);
      controller.hardAnswerMutations.delete(conflict.clientMutationId);
      clearOwnedAnswerIssue(controller, itemId, conflict.clientMutationId);
      publish(controller);
      return;
    }

    const newer = await currentPersistedAnswer(controller, itemId);
    assertConflictAction(controller, itemId, conflict, action);
    if (newer && validateRecoveredAnswer(controller, newer)) {
      controller.records.set(itemId, newer);
      controller.answers = { ...controller.answers, [itemId]: newer.payload.answer };
      controller.conflicts.set(itemId, {
        ...conflict,
        clientMutationId: newer.clientMutationId,
        localAnswer: newer.payload.answer,
      });
    } else if (newer === null && conflictedRecord) {
      markAnswerDurabilityLost(controller, conflictedRecord);
      throw new HardOutboxError("The conflicted answer is no longer durable locally.");
    }
    publish(controller);
    throw new Error("A newer recovered answer was preserved.");
  } finally {
    if (controller.conflictActions.get(itemId)?.token === action.token) {
      controller.conflictActions.delete(itemId);
      publish(controller);
    }
  }
}

type EmergencySnapshot = { key: string; raw: string };

function emergencyKey(record: ExamEventOutboxRecord) {
  return `${EMERGENCY_EXAM_EVENT_PREFIX}${encodeURIComponent(record.namespace)}:${encodeURIComponent(record.scope)}:${encodeURIComponent(record.clientEventId)}`;
}

function exactEmergencySnapshots(storage: Storage, namespace: string, recordSessionId: string) {
  const snapshots: EmergencySnapshot[] = [];
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) keys.push(key);
  }
  for (const key of keys) {
    if (!key.startsWith(EMERGENCY_EXAM_EVENT_PREFIX)) continue;
    const raw = storage.getItem(key);
    if (raw === null) continue;
    try {
      const record = JSON.parse(raw) as unknown;
      if (
        isExamEventOutboxRecord(record)
        && record.namespace === namespace
        && record.scope === recordSessionId
        && emergencyKey(record) === key
      ) snapshots.push({ key, raw });
    } catch {
      // Invalid or foreign emergency data is deliberately outside this exact-session purge.
    }
  }
  return snapshots;
}

async function purgeController(controller: Controller) {
  controller.writeBarrier.terminalClosed = true;
  controller.closed = true;
  controller.deadlineFenced = true;
  stopOwnedWork(controller);
  publish(controller);
  const storage = typeof window === "undefined" ? null : window.localStorage;
  const snapshots = storage
    ? exactEmergencySnapshots(storage, controller.namespace, controller.session.sessionId)
    : [];
  while (controller.writeBarrier.writes.size > 0) {
    await Promise.allSettled([...controller.writeBarrier.writes]);
  }
  await controller.repository.clearExamSession(
    controller.namespace,
    controller.session.sessionId,
  );
  if (storage) {
    for (const snapshot of snapshots) {
      if (storage.getItem(snapshot.key) === snapshot.raw) storage.removeItem(snapshot.key);
    }
  }
  controller.records.clear();
  controller.pendingWrites.clear();
  controller.failedWrites.clear();
  controller.conflicts.clear();
  controller.conflictActions.clear();
  controller.events.clear();
  controller.failedEventWrites.clear();
  controller.hardAnswerMutations.clear();
  controller.hardEventIds.clear();
  controller.answers = {};
  controller.answerIssues.clear();
  controller.eventIssue = null;
  controller.systemIssue = null;
  controller.inFlightAnswer = null;
  controller.answerRetryable = false;
  controller.hydrated = true;
  publish(controller);
}

function activateController(controller: Controller) {
  controller.retired = false;
  controller.writeBarrier.owners += 1;
  const generation = controller.generation + 1;
  controller.generation = generation;
  return generation;
}

function retireController(controller: Controller) {
  controller.retired = true;
  controller.writeBarrier.owners = Math.max(0, controller.writeBarrier.owners - 1);
  controller.generation += 1;
  stopOwnedWork(controller);
}

async function updateControllerAnswer(
  controller: Controller,
  itemId: string,
  answer: string,
) {
  assertWorkAllowed(controller);
  const item = controller.items.get(itemId);
  if (!validItem(item)) {
    setAnswerIssue(controller, itemId, null, {
      kind: "protocol",
      itemId,
      message: "Needs attention: this question is not part of the immutable exam form.",
    });
    publish(controller);
    throw new Error("The exam item is invalid.");
  }
  if (typeof answer !== "string" || !answerWithinLimit(item, answer)) {
    setAnswerIssue(controller, itemId, null, {
      kind: "server-rejected",
      itemId,
      message: "Needs attention: this answer is larger than Codestead can accept.",
    });
    publish(controller);
    throw new Error("The answer exceeds the supported character limit.");
  }
  const supersededMutationId = controller.records.get(itemId)?.clientMutationId;
  controller.answers = { ...controller.answers, [itemId]: answer };
  const record = buildAnswerRecord(controller, item, answer);
  controller.conflicts.delete(itemId);
  if (supersededMutationId) controller.hardAnswerMutations.delete(supersededMutationId);
  controller.answerIssues.delete(itemId);
  publish(controller);
  await persistAnswer(controller, record, false);
}

async function recordControllerEvent(
  controller: Controller,
  eventType: ClientExamEventType,
  metadata: Record<string, unknown>,
) {
  assertWorkAllowed(controller);
  const record = createExamEventOutboxRecord({
    namespace: controller.namespace,
    sessionId: controller.session.sessionId,
    eventType,
    metadata,
  });
  try {
    await trackSessionWrite(controller, controller.repository.putExamEvent(record));
  } catch (error) {
    if (controller.writeBarrier.terminalClosed || controller.closed) throw error;
    controller.failedEventWrites.set(record.clientEventId, record);
    controller.eventIssue = {
      kind: "event-recovery",
      message: "An integrity event remains queued for browser recovery.",
    };
    publish(controller);
    scheduleEventRetry(controller, controller.generation);
    throw error;
  }
  assertWorkAllowed(controller);
  controller.events.set(record.clientEventId, record);
  void startEventDrain(controller).catch(() => undefined);
}

export function useDurableExamOutbox(input: {
  namespace: string;
  session: ExamSessionView;
  repository: BrowserOutboxRepository;
}): {
  hydrated: boolean;
  answers: Readonly<Record<string, string>>;
  saveState: ExamAnswerSaveState;
  conflicts: Readonly<Record<string, ExamAnswerConflict>>;
  resolvingConflicts: Readonly<Record<string, boolean>>;
  issue: ExamOutboxIssue | null;
  updateAnswer(itemId: string, answer: string): Promise<void>;
  recordEvent(eventType: ClientExamEventType, metadata?: Record<string, unknown>): Promise<void>;
  prepareUnloadEvent(metadata?: Readonly<Record<string, unknown>>): ExamEventOutboxRecord | null;
  flush(): Promise<void>;
  resolveConflict(itemId: string, choice: "keep-local" | "use-server"): Promise<void>;
  purge(): Promise<void>;
} {
  const [, forceRender] = useReducer((value: number) => value + 1, 0);
  // A form/session snapshot is immutable within this generation; only boundary identity changes
  // retire it. Including the caller's object identity would recreate the controller on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const controller = useMemo(() => createController(input, forceRender), [
    forceRender,
    input.namespace,
    input.repository,
    input.session.sessionId,
    input.session.status,
  ]);

  useEffect(() => {
    const generation = activateController(controller);
    void initialize(controller, generation);
    const online = () => {
      if (!live(controller, generation) || controller.closed || deadlineReached(controller)) return;
      clearTimer(controller, "answerRetryTimer");
      clearTimer(controller, "eventRetryTimer");
      void startAnswerDrain(controller).catch(() => undefined);
      void startEventDrain(controller).catch(() => undefined);
    };
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("online", online);
      retireController(controller);
    };
  }, [controller]);

  const updateAnswer = useCallback(
    (itemId: string, answer: string) => updateControllerAnswer(controller, itemId, answer),
    [controller],
  );

  const recordEvent = useCallback(
    (eventType: ClientExamEventType, metadata: Record<string, unknown> = {}) =>
      recordControllerEvent(controller, eventType, metadata),
    [controller],
  );

  const prepareUnloadEvent = useCallback(
    (metadata: Readonly<Record<string, unknown>> = {}) =>
      prepareControllerUnloadEvent(controller, metadata),
    [controller],
  );

  const flush = useCallback(() => flushAnswers(controller), [controller]);
  const resolveConflict = useCallback(
    (itemId: string, choice: "keep-local" | "use-server") =>
      resolveAnswerConflict(controller, itemId, choice),
    [controller],
  );
  const purge = useCallback(() => purgeController(controller), [controller]);

  return {
    hydrated: controller.hydrated,
    answers: controller.answers,
    saveState: answerSaveState(controller),
    conflicts: Object.fromEntries(controller.conflicts),
    resolvingConflicts: Object.fromEntries(
      [...controller.conflictActions.keys()].map((itemId) => [itemId, true]),
    ),
    issue: visibleIssue(controller),
    updateAnswer,
    recordEvent,
    prepareUnloadEvent,
    flush,
    resolveConflict,
    purge,
  };
}
