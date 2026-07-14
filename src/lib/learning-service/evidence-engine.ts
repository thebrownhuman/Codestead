import {
  applyEvidence,
  evaluateExamReadiness,
  evaluateRemediation,
  evidenceRank,
  isQualifyingIndependentEvidence,
  isRemediationResolved,
  type ActiveMisconception,
  type EvidenceObservation,
  type MisconceptionProbe,
  type ReviewOutcome,
  type SkillProgress,
} from "@/lib/domain";

import type {
  ActivityContext,
  AttemptContext,
  AttemptEvaluation,
  DeterministicEvaluation,
  EvidenceEnvelopeV1,
  MasteryBundle,
  MasteryTransition,
  StoredEvidence,
  SubmissionInput,
  SupportedAttemptKind,
} from "./types";

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteScore(value: unknown): number | null {
  const score = typeof value === "number" ? value : Number(value);
  return Number.isFinite(score) && score >= 0 && score <= 1 ? score : null;
}

function canonical(value: unknown, caseSensitive: boolean, trim: boolean): string {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (trim) text = text.trim();
  return caseSensitive ? text : text.toLocaleLowerCase("en-US");
}

function answerValue(answer: JsonRecord): unknown {
  return Object.prototype.hasOwnProperty.call(answer, "value") ? answer.value : answer;
}

function misconceptionTagsFor(
  grading: JsonRecord,
  answer: JsonRecord,
  caseSensitive: boolean,
  trim: boolean,
): readonly string[] {
  if (!Array.isArray(grading.misconceptions)) return [];
  const actual = canonical(answerValue(answer), caseSensitive, trim);
  const tags = new Set<string>();
  for (const candidate of grading.misconceptions) {
    if (!isRecord(candidate) || typeof candidate.tag !== "string") continue;
    if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(candidate.tag)) continue;
    const answers = Array.isArray(candidate.answers) ? candidate.answers : [];
    if (answers.some((value) => canonical(value, caseSensitive, trim) === actual)) {
      tags.add(candidate.tag);
    }
  }
  return [...tags].sort();
}

/** Supports only deterministic, authored grader specifications. */
export function evaluateAuthoredActivity(
  activity: Pick<ActivityContext, "specification">,
  answer: JsonRecord,
): AttemptEvaluation {
  const grading = activity.specification.grading;
  if (!isRecord(grading) || typeof grading.kind !== "string") {
    return { state: "unavailable", reason: "grader_not_configured" };
  }
  if (grading.kind === "llm" || grading.kind === "model" || grading.kind === "ai") {
    return { state: "unavailable", reason: "unsupported_grader" };
  }
  if (grading.kind === "runner") {
    return { state: "unavailable", reason: "runner_not_complete" };
  }
  const passThreshold = finiteScore(grading.passThreshold) ?? 1;
  const caseSensitive = grading.caseSensitive === true;
  const trim = grading.trim !== false;
  let score: number | null = null;

  if (grading.kind === "exact" || grading.kind === "choice") {
    const accepted = Array.isArray(grading.acceptedAnswers)
      ? grading.acceptedAnswers
      : Array.isArray(grading.correctOptionIds)
        ? grading.correctOptionIds
        : null;
    if (!accepted?.length) {
      return { state: "unavailable", reason: "invalid_grader_specification" };
    }
    const actual = canonical(answerValue(answer), caseSensitive, trim);
    score = accepted.some((value) => canonical(value, caseSensitive, trim) === actual) ? 1 : 0;
  } else if (grading.kind === "set") {
    const expected = Array.isArray(grading.correctOptionIds)
      ? grading.correctOptionIds.map(String).sort()
      : null;
    const actualValue = answer.selectedOptionIds;
    const actual = Array.isArray(actualValue) ? actualValue.map(String).sort() : null;
    if (!expected || !actual) {
      return { state: "unavailable", reason: "invalid_grader_specification" };
    }
    score = JSON.stringify(expected) === JSON.stringify(actual) ? 1 : 0;
  } else if (grading.kind === "numeric") {
    const expected = typeof grading.expected === "number" ? grading.expected : Number(grading.expected);
    const actualRaw = answerValue(answer);
    const actual = typeof actualRaw === "number" ? actualRaw : Number(actualRaw);
    const tolerance = typeof grading.tolerance === "number" ? grading.tolerance : 0;
    if (!Number.isFinite(expected) || !Number.isFinite(actual) || tolerance < 0) {
      return { state: "unavailable", reason: "invalid_grader_specification" };
    }
    score = Math.abs(actual - expected) <= tolerance ? 1 : 0;
  } else if (grading.kind === "gaps") {
    const acceptedByGap = isRecord(grading.acceptedByGap) ? grading.acceptedByGap : null;
    const actualByGap = isRecord(answer.gaps) ? answer.gaps : null;
    const expectedEntries = acceptedByGap ? Object.entries(acceptedByGap) : [];
    if (!actualByGap || !expectedEntries.length || expectedEntries.some(([, values]) => !Array.isArray(values) || !values.length)) {
      return { state: "unavailable", reason: "invalid_grader_specification" };
    }
    const matched = expectedEntries.filter(([gapId, accepted]) =>
      (accepted as readonly unknown[]).some((value) =>
        canonical(value, caseSensitive, trim) === canonical(actualByGap[gapId], caseSensitive, trim),
      ),
    ).length;
    score = matched / expectedEntries.length;
  } else {
    return { state: "unavailable", reason: "unsupported_grader" };
  }

  const passed = score >= passThreshold;
  return {
    state: "graded",
    origin: "deterministic_spec",
    score,
    passed,
    correct: passed,
    misconceptionTags: passed
      ? []
      : misconceptionTagsFor(grading, answer, caseSensitive, trim),
  };
}

export function validateRunnerEvaluation(value: unknown): AttemptEvaluation {
  if (!isRecord(value) || typeof value.passed !== "boolean") {
    return { state: "unavailable", reason: "runner_not_complete" };
  }
  const score = finiteScore(value.score);
  if (score === null) return { state: "unavailable", reason: "runner_not_complete" };
  const misconceptionTags = Array.isArray(value.misconceptionTags)
    ? value.misconceptionTags
        .filter((tag): tag is string => typeof tag === "string" && /^[a-z][a-z0-9_.-]{1,63}$/.test(tag))
        .slice(0, 12)
        .sort()
    : [];
  return {
    state: "graded",
    origin: "verified_runner",
    score,
    passed: value.passed,
    correct: value.passed,
    misconceptionTags: value.passed ? [] : misconceptionTags,
  };
}

export function encodeEvidenceEnvelope(envelope: EvidenceEnvelopeV1): string {
  return JSON.stringify(envelope);
}

export function decodeEvidenceEnvelope(row: StoredEvidence): EvidenceEnvelopeV1 | null {
  if (
    row.validity !== "valid" ||
    /(?:llm|model|chat)/i.test(row.sourceType) ||
    /(?:llm|model|chat)/i.test(row.recordedBy ?? "")
  ) {
    return null;
  }
  try {
    const value = JSON.parse(row.evidenceType) as unknown;
    if (!isRecord(value) || value.version !== 1) return null;
    if (value.origin !== "deterministic_spec" && value.origin !== "verified_runner") return null;
    if (
      typeof value.skillId !== "string" ||
      typeof value.itemVariantId !== "string" ||
      !["E0", "E1", "E2", "E3", "E4", "E5", "E6"].includes(String(value.evidenceLevel)) ||
      !["A0", "A1", "A2", "A3", "A4"].includes(String(value.assistanceLevel)) ||
      typeof value.correct !== "boolean" ||
      typeof value.learningOpportunity !== "boolean" ||
      typeof value.solutionRevealed !== "boolean" ||
      !Array.isArray(value.misconceptionTags) ||
      typeof value.languageContext !== "string"
    ) return null;
    return value as unknown as EvidenceEnvelopeV1;
  } catch {
    return null;
  }
}

function observationFromEvidence(row: StoredEvidence): EvidenceObservation | null {
  const envelope = decodeEvidenceEnvelope(row);
  if (!envelope) return null;
  return {
    id: row.id,
    skillId: envelope.skillId,
    itemVariantId: envelope.itemVariantId,
    evidenceLevel: envelope.evidenceLevel,
    assistanceLevel: envelope.assistanceLevel,
    correct: envelope.correct,
    occurredAtMs: row.recordedAt.getTime(),
    learningOpportunity: envelope.learningOpportunity,
    solutionRevealed: envelope.solutionRevealed,
    misconceptionTags: envelope.misconceptionTags,
  };
}

function domainStage(databaseStatus: string): SkillProgress["stage"] {
  switch (databaseStatus) {
    case "mastered": return "MASTERED";
    case "needs_review": return "REVIEW_DUE";
    case "proficient": return "PASSED";
    case "practicing": return "INDEPENDENT_PRACTICE";
    case "learning": return "LEARNING";
    default: return "UNSEEN";
  }
}

function remediationState(observations: readonly EvidenceObservation[]): {
  readonly active: readonly ActiveMisconception[];
  readonly confirming: readonly string[];
} {
  const tags = new Set(observations.flatMap((observation) => observation.misconceptionTags ?? []));
  const active: ActiveMisconception[] = [];
  const confirming: string[] = [];
  for (const tag of [...tags].sort()) {
    const probes: MisconceptionProbe[] = observations
      .filter((observation) => observation.misconceptionTags?.includes(tag) || observation.correct)
      .map((observation) => ({
        id: observation.id,
        misconceptionTag: tag,
        itemVariantId: observation.itemVariantId,
        correct: observation.correct,
        assistanceLevel: observation.assistanceLevel,
        confidence: 1,
        occurredAtMs: observation.occurredAtMs,
      }));
    const decision = evaluateRemediation(tag, probes);
    if (decision.requestConfirmingProbe) confirming.push(tag);
    if (!decision.activateRemediation) continue;

    const distinctFailures = new Set<string>();
    let activatedAt = 0;
    for (const probe of [...probes].sort((left, right) => left.occurredAtMs - right.occurredAtMs)) {
      if (!probe.correct && probe.assistanceLevel === "A0") {
        distinctFailures.add(probe.itemVariantId);
        if (distinctFailures.size >= 2) {
          activatedAt = probe.occurredAtMs;
          break;
        }
      }
    }
    const resolutionProbes = probes.filter((probe) => probe.occurredAtMs > activatedAt);
    if (!isRemediationResolved(tag, resolutionProbes)) {
      active.push({ tag, blocking: true, confirmedAtMs: activatedAt });
    }
  }
  return { active, confirming };
}

function evidenceLevelFor(
  kind: SupportedAttemptKind,
  activity: ActivityContext,
  reviewDue: boolean,
): EvidenceObservation["evidenceLevel"] {
  if (kind === "diagnostic") return "E2";
  if (kind === "mastery_check") return reviewDue ? "E6" : "E5";
  if (
    ["code", "debug", "test", "project", "performance", "artifact"].some((type) =>
      activity.activityType.toLocaleLowerCase("en-US").includes(type),
    )
  ) return "E4";
  return "E3";
}

function databaseStatusFor(
  progress: SkillProgress,
  masteryAwarded: boolean,
): string {
  if (masteryAwarded) return "mastered";
  if (progress.activeMisconceptions.some((item) => item.blocking)) return "learning";
  switch (progress.stage) {
    case "MASTERED": return "mastered";
    case "REVIEW_DUE": return "needs_review";
    case "PASSED":
    case "EXAM_READY": return "proficient";
    case "GUIDED_PRACTICE":
    case "INDEPENDENT_PRACTICE": return "practicing";
    default: return "learning";
  }
}

function confidenceFor(progress: SkillProgress): number {
  const gate = evaluateExamReadiness(progress);
  const requirements = [
    Math.min(1, gate.summary.distinctApplicationVariants / 2),
    Math.min(1, gate.summary.independentImplementations),
    Math.min(1, gate.summary.delayedChecks),
    Math.min(1, gate.summary.transferChecks),
    gate.summary.hasBlockingMisconception ? 0 : 1,
  ];
  return requirements.reduce((total, value) => total + value, 0) / requirements.length;
}

export function progressFromMasteryBundle(
  skillId: string,
  bundle: MasteryBundle,
): SkillProgress {
  const observations = bundle.evidence
    .map(observationFromEvidence)
    .filter((item): item is EvidenceObservation => item !== null)
    .sort((left, right) => left.occurredAtMs - right.occurredAtMs);
  const remediation = remediationState(observations);
  const mastery = bundle.mastery;
  const referenceTime = mastery?.lastEvidenceAt?.getTime();
  return {
    skillId,
    stage: remediation.active.length ? "REMEDIATION" : domainStage(mastery?.status ?? "unseen"),
    masteryProbability: mastery?.score ?? 0,
    ...(referenceTime && ["proficient", "mastered", "needs_review"].includes(mastery?.status ?? "")
      ? { passedAtMs: referenceTime }
      : {}),
    ...(referenceTime && ["mastered", "needs_review"].includes(mastery?.status ?? "")
      ? { masteredAtMs: referenceTime }
      : {}),
    activeMisconceptions: remediation.active,
    evidence: observations,
  };
}

export function buildMasteryTransition(
  context: AttemptContext,
  bundle: MasteryBundle,
  response: SubmissionInput,
  evaluation: DeterministicEvaluation,
  now: Date,
): MasteryTransition {
  const priorEvidence = bundle.evidence
    .filter((row) => row.languageContext === context.activity.languageContext)
    .map(observationFromEvidence)
    .filter((item): item is EvidenceObservation => item !== null)
    .sort((left, right) => left.occurredAtMs - right.occurredAtMs);
  const priorRemediation = remediationState(priorEvidence);
  const mastery = bundle.mastery;
  const priorProgress: SkillProgress = {
    skillId: context.activity.skillId,
    stage: priorRemediation.active.length
      ? "REMEDIATION"
      : domainStage(mastery?.status ?? "unseen"),
    masteryProbability: mastery?.score ?? 0,
    ...(mastery?.status === "proficient" || mastery?.status === "mastered" || mastery?.status === "needs_review"
      ? { passedAtMs: mastery.lastEvidenceAt?.getTime() ?? now.getTime() }
      : {}),
    ...(mastery?.status === "mastered" || mastery?.status === "needs_review"
      ? { masteredAtMs: mastery.lastEvidenceAt?.getTime() ?? now.getTime() }
      : {}),
    activeMisconceptions: priorRemediation.active,
    evidence: priorEvidence,
  };
  const reviewDue = Boolean(bundle.activeReview && bundle.activeReview.dueAt.getTime() <= now.getTime());
  const observation: EvidenceObservation = {
    id: context.attempt.id,
    skillId: context.activity.skillId,
    itemVariantId: context.activity.activitySlug,
    evidenceLevel: evidenceLevelFor(context.attempt.kind, context.activity, reviewDue),
    assistanceLevel: response.assistanceLevel,
    correct: evaluation.correct,
    occurredAtMs: now.getTime(),
    learningOpportunity: context.attempt.kind === "practice" || context.attempt.kind === "game",
    solutionRevealed: response.solutionRevealed,
    misconceptionTags: evaluation.misconceptionTags,
  };
  const applied = applyEvidence(priorProgress, observation);
  const remediation = remediationState(applied.evidence);
  let progress: SkillProgress = {
    ...applied,
    activeMisconceptions: remediation.active,
    ...(remediation.active.length ? { stage: "REMEDIATION" as const } : {}),
  };
  const gate = evaluateExamReadiness(progress);
  const masteryAwarded =
    context.attempt.kind === "mastery_check" &&
    evaluation.passed &&
    response.assistanceLevel === "A0" &&
    !response.solutionRevealed &&
    gate.eligible;
  if (masteryAwarded) {
    progress = {
      ...progress,
      stage: "MASTERED",
      passedAtMs: progress.passedAtMs ?? now.getTime(),
      masteredAtMs: now.getTime(),
    };
  }
  const reviewOutcome: ReviewOutcome | null = bundle.activeReview && reviewDue
    ? !evaluation.correct
      ? "FAILED"
      : response.assistanceLevel === "A0" && !response.solutionRevealed
        ? "CLEAN"
        : "ASSISTED"
    : null;
  return {
    observation,
    progress,
    databaseStatus: databaseStatusFor(progress, masteryAwarded),
    confidence: confidenceFor(progress),
    criticalRequirementsMet: gate.eligible,
    unmetCriticalGates: gate.unmet,
    activeMisconceptionTags: remediation.active.map((item) => item.tag),
    confirmingProbeTags: remediation.confirming,
    masteryAwarded,
    evidenceType: "official-deterministic-observation",
    reviewOutcome,
    createInitialReview:
      !bundle.activeReview &&
      isQualifyingIndependentEvidence(observation, "E3") &&
      evidenceRank(observation.evidenceLevel) >= evidenceRank("E3"),
  };
}

export function evidenceEnvelopeFor(
  context: AttemptContext,
  transition: MasteryTransition,
  evaluation: DeterministicEvaluation,
): EvidenceEnvelopeV1 {
  const observation = transition.observation;
  return {
    version: 1,
    origin: evaluation.origin,
    skillId: observation.skillId,
    itemVariantId: observation.itemVariantId,
    evidenceLevel: observation.evidenceLevel,
    assistanceLevel: observation.assistanceLevel,
    correct: observation.correct,
    learningOpportunity: observation.learningOpportunity,
    solutionRevealed: Boolean(observation.solutionRevealed),
    misconceptionTags: observation.misconceptionTags ?? [],
    languageContext: context.activity.languageContext,
  };
}
