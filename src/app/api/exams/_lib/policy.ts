import { requiredMasteryRecheckTargets, scoreExam } from "@/lib/domain/exam";
import { nextRetakeAtMs } from "@/lib/domain/remediation";
import { decodeEvidenceEnvelope } from "@/lib/learning-service/evidence-engine";
import type { StoredEvidence } from "@/lib/learning-service/types";
import {
  MASTERY_RECHECK_DELAY_MS,
  MATERIAL_DISCONNECT_SECONDS,
} from "@/lib/exams/constants";

import type {
  ClientExamEventType,
  ExamAnswer,
  ExamFinalizationReason,
  ExamFormSnapshot,
  ExamResult,
  ExamRunnerResult,
  RetakeEligibility,
} from "./contracts";

export const HEARTBEAT_INTERVAL_SECONDS = 15;
export const MIN_EXAM_VIEWPORT_WIDTH = 768;
export { MASTERY_RECHECK_DELAY_MS, MATERIAL_DISCONNECT_SECONDS };

export function hasPersistedRemediationEvidence(input: {
  readonly result: ExamResult | null;
  readonly form: ExamFormSnapshot | null;
  readonly evidenceRows: readonly StoredEvidence[];
}): boolean {
  if (!input.result?.remediation.required || !input.form) return true;
  const finalizedAt = Date.parse(input.result.finalizedAt);
  if (!Number.isFinite(finalizedAt)) return false;

  const targetSkills = new Set<string>();
  const unresolvedTargets = new Set<string>();
  for (const target of input.result.remediation.targets) {
    const matchingItems = input.form.items.filter(
      (candidate) =>
        candidate.id === target ||
        candidate.skillId === target ||
        candidate.clusterId === target,
    );
    if (matchingItems.length === 0) unresolvedTargets.add(target);
    matchingItems.forEach((item) => targetSkills.add(item.skillId));
  }

  // A low total score can require remediation without identifying a critical
  // item or cluster. Re-establish every skill represented by that immutable
  // form instead of treating an empty target list as complete.
  if (input.result.remediation.targets.length === 0) {
    input.form.items.forEach((item) => targetSkills.add(item.skillId));
  }

  if (unresolvedTargets.size > 0 || targetSkills.size === 0) return false;

  return [...targetSkills].every((skillId) =>
    input.evidenceRows.some((row) => {
      if (row.skillId !== skillId || row.recordedAt.getTime() <= finalizedAt || row.score !== 1) {
        return false;
      }
      const envelope = decodeEvidenceEnvelope(row);
      return envelope !== null &&
        envelope.skillId === skillId &&
        envelope.correct &&
        envelope.assistanceLevel === "A0" &&
        !envelope.solutionRevealed &&
        ["E3", "E4", "E5", "E6"].includes(envelope.evidenceLevel);
    }),
  );
}

export interface StartDeviceClaim {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly userAgent: string;
}

export interface StartDeviceDecision {
  readonly allowed: boolean;
  readonly reason: "supported" | "viewport-too-small" | "phone-detected" | "invalid-claim";
}

export function evaluateStartDevice(claim: StartDeviceClaim): StartDeviceDecision {
  if (
    !Number.isFinite(claim.viewportWidth) ||
    !Number.isFinite(claim.viewportHeight) ||
    claim.viewportWidth <= 0 ||
    claim.viewportHeight <= 0 ||
    claim.userAgent.length > 1_000
  ) {
    return { allowed: false, reason: "invalid-claim" };
  }
  if (claim.viewportWidth < MIN_EXAM_VIEWPORT_WIDTH) {
    return { allowed: false, reason: "viewport-too-small" };
  }
  const phonePattern = /iPhone|iPod|Windows Phone|Android[^\n]*Mobile/i;
  if (phonePattern.test(claim.userAgent)) {
    return { allowed: false, reason: "phone-detected" };
  }
  return { allowed: true, reason: "supported" };
}

export function examDurationMinutes(itemCount: number): number {
  if (!Number.isInteger(itemCount) || itemCount <= 0) {
    throw new RangeError("itemCount must be a positive integer");
  }
  return Math.min(45, Math.max(10, itemCount * 6));
}

export function serverClockOffsetMs(serverNowIso: string, receivedAtMs: number): number {
  const serverNowMs = Date.parse(serverNowIso);
  if (!Number.isFinite(serverNowMs) || !Number.isFinite(receivedAtMs)) {
    throw new RangeError("server and client clock values must be valid");
  }
  return serverNowMs - receivedAtMs;
}

export function remainingExamSeconds(
  deadlineIso: string,
  clientNowMs: number,
  serverOffsetMs: number,
): number {
  const deadlineMs = Date.parse(deadlineIso);
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(clientNowMs) || !Number.isFinite(serverOffsetMs)) {
    throw new RangeError("deadline and clock values must be valid");
  }
  return Math.max(0, Math.ceil((deadlineMs - (clientNowMs + serverOffsetMs)) / 1_000));
}

export function hasDeadlinePassed(deadline: Date | null, now: Date): boolean {
  return deadline !== null && deadline.getTime() <= now.getTime();
}

export function disconnectedDeltaSeconds(
  lastHeartbeatAt: Date | null,
  now: Date,
  expectedIntervalSeconds = HEARTBEAT_INTERVAL_SECONDS,
): number {
  if (lastHeartbeatAt === null) return 0;
  const elapsed = Math.max(0, Math.floor((now.getTime() - lastHeartbeatAt.getTime()) / 1_000));
  return Math.max(0, elapsed - expectedIntervalSeconds);
}

export interface RevisionedValue<T> {
  readonly itemKey: string;
  readonly revision: number;
  readonly value: T;
  readonly savedAt: Date;
}

export function latestRevisionByItem<T>(
  rows: readonly RevisionedValue<T>[],
): ReadonlyMap<string, RevisionedValue<T>> {
  const latest = new Map<string, RevisionedValue<T>>();
  for (const row of rows) {
    const current = latest.get(row.itemKey);
    if (
      current === undefined ||
      row.revision > current.revision ||
      (row.revision === current.revision && row.savedAt.getTime() > current.savedAt.getTime())
    ) {
      latest.set(row.itemKey, row);
    }
  }
  return latest;
}

export interface ExamEventInput {
  readonly clientEventId: string;
  readonly type: ClientExamEventType;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export function deduplicateExamEvents(events: readonly ExamEventInput[]): readonly ExamEventInput[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (seen.has(event.clientEventId)) return false;
    seen.add(event.clientEventId);
    return true;
  });
}

const ALLOWED_EVENT_METADATA = new Set([
  "itemId",
  "target",
  "visibilityState",
  "reason",
  "pastedCharacters",
  "online",
  "fullscreen",
]);

export function sanitizeEventMetadata(
  metadata: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(metadata).slice(0, 12)) {
    if (!ALLOWED_EVENT_METADATA.has(key)) continue;
    if (typeof rawValue === "string") sanitized[key] = rawValue.slice(0, 200);
    else if (typeof rawValue === "boolean") sanitized[key] = rawValue;
    else if (typeof rawValue === "number" && Number.isFinite(rawValue)) sanitized[key] = rawValue;
  }
  return sanitized;
}

function normalizedAnswer(value: string, caseSensitive: boolean): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  return caseSensitive ? normalized : normalized.toLocaleLowerCase("en-US");
}

export interface GradeExamInput {
  readonly form: ExamFormSnapshot;
  readonly answers: Readonly<Record<string, ExamAnswer>>;
  readonly runnerResults: Readonly<Record<string, ExamRunnerResult>>;
  readonly finalizedAt: string;
  readonly finalizedBy: ExamFinalizationReason;
}

export function gradeExamSubmission(input: GradeExamInput): ExamResult {
  const pending = new Set<string>();
  const infrastructureItems = new Set<string>();
  const criteria: Array<{
    itemId: string;
    criterionId: string;
    clusterId: string;
    kind: "FUNCTIONAL" | "CONCEPT";
    earnedPoints: number;
    possiblePoints: number;
    critical: boolean;
  }> = [];
  const codingItems: Array<{
    itemId: string;
    mandatory: boolean;
    compiled: boolean;
    criticalTestsPassed: boolean;
  }> = [];

  for (const item of input.form.items) {
    const answer = input.answers[item.id] ?? {};
    const evidence = item.gradingEvidence;
    if (evidence.kind === "pending-review") {
      pending.add(item.id);
      continue;
    }

    if (evidence.kind === "exact-answer") {
      if (evidence.acceptedAnswers.length === 0) {
        pending.add(item.id);
        continue;
      }
      const actual = normalizedAnswer(answer.text ?? "", evidence.caseSensitive);
      const correct = evidence.acceptedAnswers.some(
        (accepted) => normalizedAnswer(accepted, evidence.caseSensitive) === actual,
      );
      criteria.push({
        itemId: item.id,
        criterionId: `${item.id}:answer`,
        clusterId: item.clusterId,
        kind: "CONCEPT",
        earnedPoints: correct ? item.points : 0,
        possiblePoints: item.points,
        critical: item.critical,
      });
      continue;
    }

    if (evidence.tests.length === 0) {
      pending.add(item.id);
      continue;
    }

    if (!(answer.sourceCode ?? "").trim()) {
      criteria.push({
        itemId: item.id,
        criterionId: `${item.id}:tests`,
        clusterId: item.clusterId,
        kind: "FUNCTIONAL",
        earnedPoints: 0,
        possiblePoints: item.points,
        critical: item.critical,
      });
      codingItems.push({
        itemId: item.id,
        mandatory: item.critical,
        compiled: false,
        criticalTestsPassed: false,
      });
      continue;
    }

    const execution = input.runnerResults[item.id];
    if (execution === undefined) {
      pending.add(item.id);
      infrastructureItems.add(item.id);
      continue;
    }
    if (
      execution.status === "INFRASTRUCTURE_ERROR" ||
      execution.compile.status === "INFRASTRUCTURE_ERROR" ||
      execution.tests.some((test) => test.status === "INFRASTRUCTURE_ERROR")
    ) {
      pending.add(item.id);
      infrastructureItems.add(item.id);
      continue;
    }

    const resultById = new Map(execution.tests.map((test) => [test.id, test]));
    const completeEvidence = evidence.tests.every((test) => resultById.has(test.id));
    if (!completeEvidence && execution.compile.status === "OK") {
      pending.add(item.id);
      infrastructureItems.add(item.id);
      continue;
    }

    const compiled = execution.compile.status === "OK";
    const passedCount = compiled
      ? evidence.tests.filter((test) => resultById.get(test.id)?.status === "PASSED").length
      : 0;
    const criticalTests = evidence.tests.filter((test) => test.critical);
    const criticalTestsPassed =
      compiled && criticalTests.every((test) => resultById.get(test.id)?.status === "PASSED");
    criteria.push({
      itemId: item.id,
      criterionId: `${item.id}:tests`,
      clusterId: item.clusterId,
      kind: "FUNCTIONAL",
      earnedPoints: compiled ? item.points * (passedCount / evidence.tests.length) : 0,
      possiblePoints: item.points,
      critical: item.critical,
    });
    codingItems.push({
      itemId: item.id,
      mandatory: item.critical,
      compiled,
      criticalTestsPassed,
    });
  }

  const possiblePoints = input.form.items.reduce((total, item) => total + item.points, 0);
  if (pending.size > 0) {
    return {
      schemaVersion: 1,
      gradingStatus: "pending-review",
      outcome: "PENDING_REVIEW",
      officialScorePercent: null,
      earnedPoints: null,
      possiblePoints,
      pendingReviewItemIds: [...pending].sort(),
      failedCriticalClusters: [],
      masteryBlockingCodingItems: [],
      compilationGatePassed: null,
      infrastructureFailure: infrastructureItems.size > 0,
      finalizedAt: input.finalizedAt,
      finalizedBy: input.finalizedBy,
      policyVersion: input.form.policyVersion,
      remediation: { required: false, targets: [] },
      masteryRecheck: { required: false, clusterIds: [], codingItemIds: [] },
    };
  }

  const score = scoreExam({
    criteria,
    codingItems,
    singleProject: codingItems.length === 1,
  });
  const remediationTargets = score.outcome === "NOT_PASSED"
    ? [...new Set([...score.failedCriticalClusters, ...score.masteryBlockingCodingItems])].sort()
    : [];
  const recheckTargets = requiredMasteryRecheckTargets(score);
  const representedTargetItems = input.form.items.filter((item) =>
    recheckTargets.clusterIds.includes(item.clusterId) ||
    recheckTargets.codingItemIds.includes(item.id)
  );
  // A targeted recheck is offered only when it is genuinely shorter than the
  // immutable source form. If every item needs rechecking, the equivalent
  // full-form retake remains the honest route to mastery.
  const targetedRecheckRequired = score.outcome === "PASSED" &&
    representedTargetItems.length > 0 &&
    representedTargetItems.length < input.form.items.length;
  return {
    schemaVersion: 1,
    gradingStatus: "graded",
    outcome: score.outcome,
    officialScorePercent: score.percent,
    earnedPoints: score.earnedPoints,
    possiblePoints: score.possiblePoints,
    pendingReviewItemIds: [],
    failedCriticalClusters: score.failedCriticalClusters,
    masteryBlockingCodingItems: score.masteryBlockingCodingItems,
    compilationGatePassed: score.compilationGatePassed,
    infrastructureFailure: false,
    finalizedAt: input.finalizedAt,
    finalizedBy: input.finalizedBy,
    policyVersion: input.form.policyVersion,
    remediation: {
      required: score.outcome === "NOT_PASSED",
      targets: remediationTargets,
    },
    masteryRecheck: {
      required: targetedRecheckRequired,
      clusterIds: targetedRecheckRequired ? recheckTargets.clusterIds : [],
      codingItemIds: targetedRecheckRequired ? recheckTargets.codingItemIds : [],
    },
  };
}

export function computeRetakeEligibility(input: {
  readonly result: ExamResult | null;
  readonly durationMinutes: number;
  readonly nowMs: number;
  readonly remediationComplete: boolean;
}): RetakeEligibility {
  if (input.result === null) {
    return {
      eligible: true,
      reason: "first-attempt",
      nextEligibleAt: null,
      requiresRemediation: false,
    };
  }
  if (input.result.infrastructureFailure) {
    return {
      eligible: true,
      reason: "technical-incident",
      nextEligibleAt: input.result.finalizedAt,
      requiresRemediation: false,
    };
  }
  if (input.result.outcome === "PENDING_REVIEW") {
    return {
      eligible: false,
      reason: "pending-review",
      nextEligibleAt: null,
      requiresRemediation: false,
    };
  }
  if (input.result.outcome === "MASTERED") {
    return {
      eligible: false,
      reason: "already-mastered",
      nextEligibleAt: null,
      requiresRemediation: false,
    };
  }
  const requiresRemediation = input.result.outcome === "NOT_PASSED";
  if (requiresRemediation && !input.remediationComplete) {
    return {
      eligible: false,
      reason: "remediation-required",
      nextEligibleAt: null,
      requiresRemediation: true,
    };
  }
  const nextAt = nextRetakeAtMs(
    Date.parse(input.result.finalizedAt),
    input.durationMinutes,
    true,
    false,
  );
  if (nextAt !== null && input.nowMs < nextAt) {
    return {
      eligible: false,
      reason: "cooldown",
      nextEligibleAt: new Date(nextAt).toISOString(),
      requiresRemediation,
    };
  }
  return {
    eligible: true,
    reason: "eligible",
    nextEligibleAt: nextAt === null ? null : new Date(nextAt).toISOString(),
    requiresRemediation,
  };
}

export function canConsumeEquivalentReexamGrant(input: {
  readonly result: ExamResult | null;
  readonly grantSourceExamSessionId: string | null;
  readonly authoritativeExamSessionId: string | null;
}): boolean {
  return input.result?.gradingStatus === "graded" &&
    input.result.outcome === "NOT_PASSED" &&
    !input.result.infrastructureFailure &&
    input.grantSourceExamSessionId !== null &&
    input.grantSourceExamSessionId === input.authoritativeExamSessionId;
}
