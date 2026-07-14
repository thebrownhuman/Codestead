import { describe, expect, it, vi } from "vitest";

import type { LearningStore, LearningTransaction } from "../store";
import { deterministicUuid } from "../ids";
import { LearningService } from "../service";
import {
  LESSON_COMPLETION_AUTHORITY,
  type ActivityContext,
  type AttemptContext,
  type LearningSessionRecord,
} from "../types";

const NOW = new Date("2026-07-12T12:00:00.000Z");
const USER_ID = "learner-1";
const SERIALIZATION_METHODS = new Set([
  "lockPlanInitialization",
  "lockSessionStart",
  "lockAttemptCreation",
  "lockDsaLanguageSwitch",
]);

function serviceWith(overrides: Partial<LearningTransaction>): LearningService {
  const transaction = new Proxy(overrides, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      if (typeof property === "string" && SERIALIZATION_METHODS.has(property)) {
        return vi.fn(async () => undefined);
      }
      return vi.fn(async () => {
        throw new Error(`Unexpected fake transaction call: ${String(property)}`);
      });
    },
  }) as LearningTransaction;
  const store: LearningStore = {
    transaction: (work) => work(transaction),
  };
  return new LearningService({ store, now: () => NOW });
}

function session(overrides: Partial<LearningSessionRecord> = {}): LearningSessionRecord {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    userId: USER_ID,
    enrollmentId: null,
    goal: "Practice Python variables",
    plannedMinutes: 25,
    reviewOnly: false,
    status: "active",
    startedAt: NOW,
    lastActivityAt: NOW,
    endedAt: null,
    rowVersion: 1,
    ...overrides,
  };
}

function activity(specification: Record<string, unknown>): ActivityContext {
  return {
    activityId: "20000000-0000-4000-8000-000000000001",
    activitySlug: "python-variable-check-a",
    activityType: "quiz",
    specification,
    skillId: "python.variables.assignment",
    conceptId: "30000000-0000-4000-8000-000000000001",
    enrollmentId: "40000000-0000-4000-8000-000000000001",
    courseVersion: "1.0.0",
    trackId: "python",
    implementationLanguage: null,
    languageContext: "conceptual",
  };
}

function attemptContext(specification: Record<string, unknown>): AttemptContext {
  const activityContext = activity(specification);
  return {
    activity: activityContext,
    attempt: {
      id: "50000000-0000-4000-8000-000000000001",
      userId: USER_ID,
      activityId: activityContext.activityId,
      enrollmentId: activityContext.enrollmentId,
      kind: "practice",
      attemptNumber: 1,
      status: "in_progress",
      policyVersion: "adaptive-learning-v1",
      contentVersion: "1.0.0",
      score: null,
      passed: null,
      masteryAwarded: false,
      infrastructureFailure: false,
      assistanceLevel: "A0",
      solutionRevealed: false,
      helpStep: 0,
      startedAt: NOW,
      submittedAt: null,
      gradedAt: null,
    },
  };
}

describe("adaptive learning application service", () => {
  it.each([
    ["c", "C"],
    ["C++", "C++"],
    ["java", "Java"],
    ["py", "Python"],
  ] as const)("reads the enrolled DSA language alias %s as %s", async (storedLanguage, expected) => {
    const getPlanningProfile = vi.fn();
    const service = serviceWith({
      getDsaEnrollment: vi.fn(async () => ({
        enrollmentId: "dsa-enrollment",
        courseVersionId: "dsa-version",
        courseVersion: "1.0.0",
        implementationLanguage: storedLanguage,
        latestRevisionId: null,
        latestRevision: 0,
        latestPlan: [],
      })),
      getPlanningProfile,
    });

    await expect(service.getDsaImplementationLanguage(USER_ID)).resolves.toBe(expected);
    expect(getPlanningProfile).not.toHaveBeenCalled();
  });

  it("falls back to the enrolled learner's profile language when a legacy enrollment has no language", async () => {
    const service = serviceWith({
      getDsaEnrollment: vi.fn(async () => ({
        enrollmentId: "dsa-enrollment",
        courseVersionId: "dsa-version",
        courseVersion: "1.0.0",
        implementationLanguage: null,
        latestRevisionId: null,
        latestRevision: 0,
        latestPlan: [],
      })),
      getPlanningProfile: vi.fn(async () => ({
        selectedTrackIds: ["dsa"],
        dsaLanguage: "python",
        selfReportedLevel: "beginner",
      })),
    });

    await expect(service.getDsaImplementationLanguage(USER_ID)).resolves.toBe("Python");
  });

  it("does not authorize DSA lesson code from a profile without a published enrollment", async () => {
    const getPlanningProfile = vi.fn(async () => ({
      selectedTrackIds: ["dsa"],
      dsaLanguage: "cpp",
      selfReportedLevel: "beginner",
    }));
    const service = serviceWith({
      getDsaEnrollment: vi.fn(async () => null),
      getPlanningProfile,
    });

    await expect(service.getDsaImplementationLanguage(USER_ID)).resolves.toBeNull();
    expect(getPlanningProfile).not.toHaveBeenCalled();
  });

  it("fails closed instead of hiding an invalid enrolled DSA language with a profile fallback", async () => {
    const getPlanningProfile = vi.fn();
    const service = serviceWith({
      getDsaEnrollment: vi.fn(async () => ({
        enrollmentId: "dsa-enrollment",
        courseVersionId: "dsa-version",
        courseVersion: "1.0.0",
        implementationLanguage: "Ruby",
        latestRevisionId: null,
        latestRevision: 0,
        latestPlan: [],
      })),
      getPlanningProfile,
    });

    await expect(service.getDsaImplementationLanguage(USER_ID)).resolves.toBeNull();
    expect(getPlanningProfile).not.toHaveBeenCalled();
  });

  it("initializes immutable plans from profile-selected tracks while excluding self-report evidence", async () => {
    const persistPlan = vi.fn(async (input: { draft: { trackId: string } }) => ({
      enrollmentId: `enrollment-${input.draft.trackId}`,
      trackId: input.draft.trackId,
      revisionId: `revision-${input.draft.trackId}`,
      revision: 1,
      idempotent: false,
    }));
    const service = serviceWith({
      getPlanningProfile: vi.fn(async () => ({
        selectedTrackIds: ["python"],
        dsaLanguage: null,
        selfReportedLevel: "advanced",
      })),
      getCoursePublications: vi.fn(async (trackIds: readonly string[]) =>
        trackIds.map((trackId) => ({
          trackId,
          courseVersionId: `version-${trackId}`,
          version: "0.1.0",
          stage: "beta",
        }))),
      persistPlan: persistPlan as LearningTransaction["persistPlan"],
    });

    const result = await service.initializePlans(USER_ID, "plan-init-0001");

    expect(result.state).toBe("ready");
    expect(result.resolvedTrackIds).toEqual(["programming-foundations", "python"]);
    expect(result.placement.selfReportUsedAsEvidence).toBe(false);
    expect(result.placement.reason).toContain("advanced");
    expect(persistPlan).toHaveBeenCalledTimes(2);
  });

  it("returns a clear degraded plan when a published version is absent", async () => {
    const service = serviceWith({
      getPlanningProfile: vi.fn(async () => ({
        selectedTrackIds: ["python"],
        dsaLanguage: null,
        selfReportedLevel: "beginner",
      })),
      getCoursePublications: vi.fn(async () => []),
      persistPlan: vi.fn(),
    });
    const result = await service.initializePlans(USER_ID, "plan-init-0002");
    expect(result.state).toBe("degraded");
    expect(result.missingPublications).toEqual(["programming-foundations", "python"]);
    expect(result.plans).toEqual([]);
  });

  it("makes session starts and client events idempotent", async () => {
    const existing = session({
      id: deterministicUuid("learning-session", `${USER_ID}:session-key-0001`),
    });
    const insertSession = vi.fn();
    const service = serviceWith({
      getSession: vi.fn(async () => existing),
      getActiveSession: vi.fn(async () => null),
      insertSession,
    });
    const started = await service.startSession({
      userId: USER_ID,
      idempotencyKey: "session-key-0001",
      goal: "Practice Python variables",
      plannedMinutes: 25,
    });
    expect(started.idempotent).toBe(true);
    expect(insertSession).not.toHaveBeenCalled();

    const duplicateEvent = {
      id: "60000000-0000-4000-8000-000000000001",
      sessionId: existing.id,
      userId: USER_ID,
      clientEventId: "client-event-0001",
      type: "lesson_completed" as const,
      meaningful: true,
      authority: LESSON_COMPLETION_AUTHORITY,
      occurredAt: NOW,
    };
    const updateSession = vi.fn();
    const eventService = serviceWith({
      getSessionEvent: vi.fn(async () => duplicateEvent),
      getSession: vi.fn(async () => existing),
      updateSession,
    });
    const event = await eventService.recordSessionEvent({
      userId: USER_ID,
      sessionId: existing.id,
      clientEventId: "client-event-0001",
      expectedRowVersion: 1,
      type: "lesson_completed",
    });
    expect(event.idempotent).toBe(true);
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("persists review-only mode only from the explicit session choice", async () => {
    const insertSession = vi.fn(async (input: Parameters<LearningTransaction["insertSession"]>[0]) => session({
      id: input.id,
      goal: input.goal,
      plannedMinutes: input.plannedMinutes,
      reviewOnly: input.reviewOnly,
    }));
    const service = serviceWith({
      getSession: vi.fn(async () => null),
      getActiveSession: vi.fn(async () => null),
      insertSession,
    });
    await service.startSession({
      userId: USER_ID,
      idempotencyKey: "session-mode-0001",
      goal: "Complete the reviewed foundations journey",
      plannedMinutes: 25,
    });
    expect(insertSession).toHaveBeenLastCalledWith(expect.objectContaining({
      goal: "Complete the reviewed foundations journey",
      reviewOnly: false,
    }));
    await service.startSession({
      userId: USER_ID,
      idempotencyKey: "session-mode-0002",
      goal: "Concentrate on due work",
      plannedMinutes: 25,
      reviewOnly: true,
    });
    expect(insertSession).toHaveBeenLastCalledWith(expect.objectContaining({ reviewOnly: true }));
  });

  it("rejects stale optimistic session mutations", async () => {
    const service = serviceWith({
      getSession: vi.fn(async () => session({ rowVersion: 3 })),
    });
    await expect(service.mutateSession({
      userId: USER_ID,
      sessionId: session().id,
      expectedRowVersion: 2,
      action: "end",
    })).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
  });

  it("returns degraded instead of inventing an attempt when publication activity is absent", async () => {
    const service = serviceWith({
      getAttempt: vi.fn(async () => null),
      resolveActivity: vi.fn(async () => null),
    });
    const result = await service.createAttempt({
      userId: USER_ID,
      idempotencyKey: "attempt-key-0001",
      skillId: "python.toolchain.repl",
      kind: "practice",
    });
    expect(result).toMatchObject({
      state: "degraded",
      attempt: null,
      reason: "activity_unavailable",
    });
  });

  it("grades authored deterministic work and persists evidence, mastery, review, and attempt atomically", async () => {
    const ownedAttempt = attemptContext({ grading: { kind: "exact", acceptedAnswers: ["42"] } });
    const appendOfficialEvidence = vi.fn(async () => true);
    const writeMastery = vi.fn(async () => true);
    const writeReview = vi.fn(async (input: { dueAt: Date; intervalDays: number; reason: string }) => ({
      id: "review-1",
      userId: USER_ID,
      enrollmentId: ownedAttempt.activity.enrollmentId,
      conceptId: ownedAttempt.activity.conceptId,
      skillId: ownedAttempt.activity.skillId,
      languageContext: "conceptual",
      dueAt: input.dueAt,
      intervalDays: input.intervalDays,
      reason: input.reason,
      status: "scheduled",
    }));
    const gradeAttempt = vi.fn(async () => true);
    const service = serviceWith({
      getAttempt: vi.fn(async () => ownedAttempt),
      insertResponseIfAbsent: vi.fn(async () => true),
      getMasteryBundle: vi.fn(async () => ({ mastery: null, evidence: [], activeReview: null })),
      appendOfficialEvidence,
      writeMastery,
      writeReview: writeReview as LearningTransaction["writeReview"],
      gradeAttempt,
      touchMeaningfulActivity: vi.fn(async () => undefined),
    });
    const result = await service.submitAttempt(USER_ID, ownedAttempt.attempt.id, {
      itemKey: "main",
      responseRevision: 1,
      answer: { value: "42" },
      assistanceLevel: "A0",
      solutionRevealed: false,
      submittedAt: NOW,
    });
    expect(result.state).toBe("graded");
    expect(result.officialEvidenceRecorded).toBe(true);
    expect(appendOfficialEvidence).toHaveBeenCalledOnce();
    expect(writeMastery).toHaveBeenCalledOnce();
    expect(writeReview).toHaveBeenCalledOnce();
    expect(gradeAttempt).toHaveBeenCalledOnce();
  });

  it("uses durable attempt assistance when a forged client submits A0/false after help and solution reveal", async () => {
    const base = attemptContext({
      kind: "short-answer",
      itemKey: "main",
      prompt: "Enter 42.",
      grading: { kind: "exact", acceptedAnswers: ["42"] },
      solutionReveal: { answer: "42", explanation: "The deterministic answer is 42." },
    });
    const ownedAttempt = {
      ...base,
      attempt: { ...base.attempt, assistanceLevel: "A4" as const, solutionRevealed: true, helpStep: 4 },
    };
    const appendOfficialEvidence = vi.fn(async () => true);
    const service = serviceWith({
      getAttempt: vi.fn(async () => ownedAttempt),
      insertResponseIfAbsent: vi.fn(async (_attemptId, input) => {
        expect(input).toMatchObject({ assistanceLevel: "A4", solutionRevealed: true });
        return true;
      }),
      getMasteryBundle: vi.fn(async () => ({ mastery: null, evidence: [], activeReview: null })),
      appendOfficialEvidence,
      writeMastery: vi.fn(async () => true),
      gradeAttempt: vi.fn(async () => true),
      touchMeaningfulActivity: vi.fn(async () => undefined),
    });
    const result = await service.submitAttempt(USER_ID, ownedAttempt.attempt.id, {
      itemKey: "main",
      responseRevision: 1,
      answer: { value: "42" },
      assistanceLevel: "A0",
      solutionRevealed: false,
      submittedAt: NOW,
    });
    expect(result).toMatchObject({
      passed: true,
      masteryAwarded: false,
      feedback: {
        assistanceLevel: "A4",
        solutionRevealed: true,
        independent: false,
        solution: { answer: "42" },
        nextAction: "retry_fresh",
      },
    });
    expect(appendOfficialEvidence).toHaveBeenCalledWith(expect.objectContaining({
      transition: expect.objectContaining({
        observation: expect.objectContaining({ assistanceLevel: "A4", solutionRevealed: true }),
        masteryAwarded: false,
      }),
    }));
  });

  it("ignores forged upward assistance claims when the server ledger remains independent", async () => {
    const ownedAttempt = attemptContext({ grading: { kind: "exact", acceptedAnswers: ["42"] } });
    const insertResponse = vi.fn(async (_attemptId, input) => {
      expect(input).toMatchObject({ assistanceLevel: "A0", solutionRevealed: false });
      return true;
    });
    const service = serviceWith({
      getAttempt: vi.fn(async () => ownedAttempt),
      insertResponseIfAbsent: insertResponse,
      getMasteryBundle: vi.fn(async () => ({ mastery: null, evidence: [], activeReview: null })),
      appendOfficialEvidence: vi.fn(async () => true),
      writeMastery: vi.fn(async () => true),
      writeReview: vi.fn(async (input) => ({
        id: "review-forged-upward", userId: USER_ID, enrollmentId: ownedAttempt.activity.enrollmentId,
        conceptId: ownedAttempt.activity.conceptId, skillId: ownedAttempt.activity.skillId,
        languageContext: "conceptual", dueAt: input.dueAt, intervalDays: input.intervalDays,
        reason: input.reason, status: "scheduled",
      })),
      gradeAttempt: vi.fn(async () => true),
      touchMeaningfulActivity: vi.fn(async () => undefined),
    });
    const result = await service.submitAttempt(USER_ID, ownedAttempt.attempt.id, {
      itemKey: "main",
      responseRevision: 1,
      answer: { value: "42" },
      assistanceLevel: "A4",
      solutionRevealed: true,
      submittedAt: NOW,
    });
    expect(result.feedback).toMatchObject({ assistanceLevel: "A0", solutionRevealed: false, independent: true, solution: null });
  });

  it("submits unsupported LLM grading as degraded and writes no official evidence", async () => {
    const ownedAttempt = attemptContext({ grading: { kind: "llm" } });
    const appendOfficialEvidence = vi.fn();
    const service = serviceWith({
      getAttempt: vi.fn(async () => ownedAttempt),
      insertResponseIfAbsent: vi.fn(async () => true),
      markAttemptSubmitted: vi.fn(async () => true),
      appendOfficialEvidence,
    });
    const result = await service.submitAttempt(USER_ID, ownedAttempt.attempt.id, {
      itemKey: "main",
      responseRevision: 1,
      answer: { value: "plausible prose" },
      assistanceLevel: "A0",
      solutionRevealed: false,
      submittedAt: NOW,
    });
    expect(result).toMatchObject({
      state: "degraded",
      officialEvidenceRecorded: false,
      degradedReason: "unsupported_grader",
    });
    expect(appendOfficialEvidence).not.toHaveBeenCalled();
  });

  it("returns deterministic next action and an explicit empty-plan state", async () => {
    const empty = serviceWith({
      getAdaptiveSnapshot: vi.fn(async () => ({
        planItems: [], progress: [], reviews: [],
        sessionCounts: { completedActions: 0, reviewActions: 0 },
      })),
    });
    await expect(empty.recommendNext(USER_ID)).resolves.toEqual({
      state: "empty",
      action: null,
      reason: "No current plan is available.",
    });

    const ready = serviceWith({
      getAdaptiveSnapshot: vi.fn(async () => ({
        planItems: [{
          schemaVersion: 1 as const,
          id: "pf:a:learn:conceptual",
          kind: "learn" as const,
          trackId: "programming-foundations",
          courseVersion: "1.0.0",
          moduleId: "pf.module",
          skillId: "pf.skill",
          title: "A skill",
          position: 0,
          required: true,
          prerequisites: [],
          evidenceTypes: ["concept-check"],
          languageContext: "conceptual",
          goalPriority: 10,
          prerequisiteCentrality: 1,
        }],
        progress: [], reviews: [],
        sessionCounts: { completedActions: 0, reviewActions: 0 },
      })),
    });
    await expect(ready.recommendNext(USER_ID)).resolves.toMatchObject({
      state: "ready",
      action: { kind: "START_SKILL", skillId: "pf.skill" },
    });
  });
});
