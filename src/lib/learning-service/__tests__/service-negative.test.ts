import { describe, expect, it, vi } from "vitest";

import type { LearningStore, LearningTransaction } from "../store";
import { LearningService } from "../service";
import type {
  ActivityContext,
  AttemptContext,
  LearningSessionRecord,
  SessionEventRecord,
  SubmissionInput,
} from "../types";
import { LESSON_COMPLETION_AUTHORITY } from "../types";

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
  const store: LearningStore = { transaction: (work) => work(transaction) };
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

function activity(specification: Record<string, unknown> = {
  kind: "short-answer",
  itemKey: "main",
  prompt: "Enter the deterministic value.",
  grading: { kind: "exact", acceptedAnswers: ["42"] },
}): ActivityContext {
  return {
    activityId: "20000000-0000-4000-8000-000000000001",
    activitySlug: "python-variable-check-a",
    activityType: "quiz",
    specification,
    skillId: "python.toolchain.repl",
    conceptId: "30000000-0000-4000-8000-000000000001",
    enrollmentId: "40000000-0000-4000-8000-000000000001",
    courseVersion: "0.1.0",
    trackId: "python",
    implementationLanguage: null,
    languageContext: "conceptual",
  };
}

function attempt(overrides: Partial<AttemptContext["attempt"]> = {}, specification?: Record<string, unknown>): AttemptContext {
  const ownedActivity = activity(specification);
  return {
    activity: ownedActivity,
    attempt: {
      id: "50000000-0000-4000-8000-000000000001",
      userId: USER_ID,
      activityId: ownedActivity.activityId,
      enrollmentId: ownedActivity.enrollmentId,
      kind: "practice",
      attemptNumber: 1,
      status: "in_progress",
      policyVersion: "adaptive-learning-v1",
      contentVersion: "0.1.0",
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
      ...overrides,
    },
  };
}

const submission: SubmissionInput = {
  itemKey: "main",
  responseRevision: 1,
  answer: { value: "42" },
  assistanceLevel: "A0",
  solutionRevealed: false,
  submittedAt: NOW,
};

describe("learning service input boundaries", () => {
  it.each([
    [null, "Learner profile is unavailable."],
    [{ selectedTrackIds: [], dsaLanguage: null, selfReportedLevel: "beginner" }, "No tracks are selected."],
  ])("returns an empty plan when planning input is absent", async (profile, warning) => {
    const service = serviceWith({ getPlanningProfile: vi.fn(async () => profile) });
    await expect(service.initializePlans(USER_ID, "plan-key-0001")).resolves.toMatchObject({
      state: "empty", plans: [], warnings: [warning],
      placement: { required: true, selfReportUsedAsEvidence: false },
    });
  });

  it.each(["", "short", "spaces only", "contains/slash", "x".repeat(129)])(
    "rejects unsafe idempotency key %j",
    async (idempotencyKey) => {
      await expect(serviceWith({}).startSession({
        userId: USER_ID, idempotencyKey, goal: "Study loops", plannedMinutes: 20,
      })).rejects.toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY" });
    },
  );

  it.each([
    ["ab", 20, "INVALID_SESSION_GOAL"],
    ["x".repeat(241), 20, "INVALID_SESSION_GOAL"],
    ["Valid goal", 4, "INVALID_SESSION_LENGTH"],
    ["Valid goal", 181, "INVALID_SESSION_LENGTH"],
    ["Valid goal", 20.5, "INVALID_SESSION_LENGTH"],
  ])("rejects invalid session goal/length", async (goal, plannedMinutes, code) => {
    await expect(serviceWith({}).startSession({
      userId: USER_ID, idempotencyKey: "valid-key-0001", goal: String(goal), plannedMinutes: Number(plannedMinutes),
    })).rejects.toMatchObject({ code });
  });

  it("rejects invalid row versions and runtime session actions", async () => {
    const service = serviceWith({});
    await expect(service.mutateSession({
      userId: USER_ID, sessionId: session().id, expectedRowVersion: 0, action: "end",
    })).rejects.toMatchObject({ code: "INVALID_ROW_VERSION" });
    await expect(service.mutateSession({
      userId: USER_ID, sessionId: session().id, expectedRowVersion: 1,
      action: "pause" as unknown as "end",
    })).rejects.toMatchObject({ code: "INVALID_SESSION_ACTION" });
  });

  it.each([
    { type: "not-an-event", clientEventId: "event-key-0001", code: "INVALID_EVENT_TYPE" },
    { type: "heartbeat", clientEventId: "bad/id", code: "INVALID_CLIENT_EVENT_ID" },
  ])("rejects invalid event input with $code", async ({ type, clientEventId, code }) => {
    await expect(serviceWith({}).recordSessionEvent({
      userId: USER_ID,
      sessionId: session().id,
      clientEventId,
      expectedRowVersion: 1,
      type: type as SessionEventRecord["type"],
    })).rejects.toMatchObject({ code });
  });

  it.each([
    { response: { ...submission, responseRevision: 0 }, code: "INVALID_RESPONSE_REVISION" },
    { response: { ...submission, responseRevision: 1.2 }, code: "INVALID_RESPONSE_REVISION" },
    { response: { ...submission, itemKey: "  " }, code: "INVALID_ITEM_KEY" },
    { response: { ...submission, itemKey: "x".repeat(161) }, code: "INVALID_ITEM_KEY" },
  ])("rejects invalid attempt response with $code", async ({ response, code }) => {
    await expect(serviceWith({}).submitAttempt(USER_ID, attempt().attempt.id, response))
      .rejects.toMatchObject({ code });
  });

  it("rejects unknown attempt kinds and skills before creating state", async () => {
    await expect(serviceWith({}).createAttempt({
      userId: USER_ID, idempotencyKey: "attempt-key-0010", skillId: "python.toolchain.repl",
      kind: "essay" as unknown as "practice",
    })).rejects.toMatchObject({ code: "INVALID_ATTEMPT_KIND" });
    await expect(serviceWith({}).createAttempt({
      userId: USER_ID, idempotencyKey: "attempt-key-0011", skillId: "python.missing.skill", kind: "practice",
    })).rejects.toMatchObject({ code: "SKILL_NOT_FOUND", status: 404 });
  });
});

describe("learning session negative and idempotent paths", () => {
  it("resumes the learner's already active session instead of creating a second one", async () => {
    const active = session();
    const insertSession = vi.fn();
    const service = serviceWith({
      getSession: vi.fn(async () => null),
      getActiveSession: vi.fn(async () => active),
      insertSession,
    });
    await expect(service.startSession({
      userId: USER_ID, idempotencyKey: "session-key-0002", goal: "Study arrays", plannedMinutes: 30,
    })).resolves.toEqual({ session: active, resumed: true });
    expect(insertSession).not.toHaveBeenCalled();
  });

  it("rejects deterministic session-key reuse with different parameters", async () => {
    const existing = session({
      id: "3c3a55eb-4a3c-5483-856a-7d3db15e9cc8",
    });
    const service = serviceWith({ getSession: vi.fn(async () => existing) });
    await expect(service.startSession({
      userId: USER_ID,
      idempotencyKey: "session-key-conflict-0001",
      goal: "A different goal",
      plannedMinutes: 25,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it("handles missing, ended, already-ended, and concurrent session mutations", async () => {
    await expect(serviceWith({ getSession: vi.fn(async () => null) }).mutateSession({
      userId: USER_ID, sessionId: session().id, expectedRowVersion: 1, action: "end",
    })).rejects.toMatchObject({ code: "SESSION_NOT_FOUND", status: 404 });

    const ended = session({ status: "completed", endedAt: NOW });
    await expect(serviceWith({ getSession: vi.fn(async () => ended) }).mutateSession({
      userId: USER_ID, sessionId: ended.id, expectedRowVersion: 1, action: "resume",
    })).rejects.toMatchObject({ code: "SESSION_ENDED", status: 409 });
    await expect(serviceWith({ getSession: vi.fn(async () => ended) }).mutateSession({
      userId: USER_ID, sessionId: ended.id, expectedRowVersion: 1, action: "end",
    })).resolves.toMatchObject({ session: ended, idempotent: true });

    await expect(serviceWith({
      getSession: vi.fn(async () => session()), updateSession: vi.fn(async () => null),
    }).mutateSession({
      userId: USER_ID, sessionId: session().id, expectedRowVersion: 1, action: "end",
    })).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
  });

  it("rejects events for missing or ended sessions", async () => {
    const base = {
      userId: USER_ID, sessionId: session().id, clientEventId: "client-event-0002",
      expectedRowVersion: 1, type: "heartbeat" as const,
    };
    await expect(serviceWith({
      getSessionEvent: vi.fn(async () => null), getSession: vi.fn(async () => null),
    }).recordSessionEvent(base)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    await expect(serviceWith({
      getSessionEvent: vi.fn(async () => null),
      getSession: vi.fn(async () => session({ endedAt: NOW, status: "completed" })),
    }).recordSessionEvent(base)).rejects.toMatchObject({ code: "SESSION_ENDED" });
  });

  it("does not count heartbeats as meaningful activity and truncates event references", async () => {
    const updated = session({ rowVersion: 2 });
    const insertSessionEvent = vi.fn(async (input: { id: string; clientEventId: string; meaningful: boolean }) => ({
      id: input.id, sessionId: session().id, userId: USER_ID, clientEventId: input.clientEventId,
      type: "heartbeat" as const, meaningful: input.meaningful, authority: null, occurredAt: NOW,
    }));
    const touch = vi.fn();
    const service = serviceWith({
      getSessionEvent: vi.fn(async () => null), getSession: vi.fn(async () => session()),
      updateSession: vi.fn(async () => updated), insertSessionEvent: insertSessionEvent as LearningTransaction["insertSessionEvent"],
      touchMeaningfulActivity: touch,
    });
    const result = await service.recordSessionEvent({
      userId: USER_ID, sessionId: session().id, clientEventId: "client-event-0003",
      expectedRowVersion: 1, type: "heartbeat", subjectType: "t".repeat(100), subjectId: "i".repeat(200),
    });
    expect(result.idempotent).toBe(false);
    expect(insertSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      meaningful: false, subjectType: "t".repeat(80), subjectId: "i".repeat(160),
    }));
    expect(touch).not.toHaveBeenCalled();
  });

  it.each([
    "attempt_submitted",
    "review_completed",
    "remediation_recovered",
    "project_milestone",
  ] as const)("keeps raw browser %s telemetry non-authoritative", async (type) => {
    const touch = vi.fn();
    const insertSessionEvent = vi.fn(async (input) => ({
      id: input.id,
      sessionId: input.sessionId,
      userId: input.userId,
      clientEventId: input.clientEventId,
      type: input.type,
      meaningful: input.meaningful,
      authority: input.authority,
      occurredAt: NOW,
    }));
    const service = serviceWith({
      getSessionEvent: vi.fn(async () => null),
      getSession: vi.fn(async () => session()),
      updateSession: vi.fn(async () => session({ rowVersion: 2 })),
      insertSessionEvent,
      touchMeaningfulActivity: touch,
    });

    await service.recordSessionEvent({
      userId: USER_ID,
      sessionId: session().id,
      clientEventId: `raw-${type}-event`,
      expectedRowVersion: 1,
      type,
      subjectType: "client-assertion",
      subjectId: "not-official-evidence",
    });
    expect(insertSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      meaningful: false,
      authority: null,
    }));
    expect(touch).not.toHaveBeenCalled();
  });

  it("touches meaningful activity only after a meaningful event is committed", async () => {
    const touch = vi.fn(async () => undefined);
    const service = serviceWith({
      getSessionEvent: vi.fn(async () => null),
      getSession: vi.fn(async () => session({ enrollmentId: "40000000-0000-4000-8000-000000000001" })),
      isLessonCompletionAuthorized: vi.fn(async () => true),
      updateSession: vi.fn(async () => session({ rowVersion: 2 })),
      insertSessionEvent: vi.fn(async (input) => ({
        id: input.id, sessionId: input.sessionId, userId: input.userId,
        clientEventId: input.clientEventId, type: input.type, meaningful: input.meaningful,
        authority: input.authority, occurredAt: NOW,
      })),
      touchMeaningfulActivity: touch,
    });
    await service.recordSessionEvent({
      userId: USER_ID, sessionId: session().id, clientEventId: "client-event-0004",
      expectedRowVersion: 1, type: "lesson_completed", subjectType: "lesson",
      subjectId: "50000000-0000-4000-8000-000000000001",
    });
    expect(touch).toHaveBeenCalledWith(USER_ID, NOW);
    expect(touch).toHaveBeenCalledTimes(1);
  });

  it("rejects forged and cross-enrollment lesson completion before mutation", async () => {
    const updateSession = vi.fn();
    const insertSessionEvent = vi.fn();
    const authorize = vi.fn(async () => false);
    const service = serviceWith({
      getSessionEvent: vi.fn(async () => null),
      getSession: vi.fn(async () => session({ enrollmentId: "40000000-0000-4000-8000-000000000001" })),
      isLessonCompletionAuthorized: authorize,
      updateSession,
      insertSessionEvent,
    });

    await expect(service.recordSessionEvent({
      userId: USER_ID,
      sessionId: session().id,
      clientEventId: "client-event-forged-0005",
      expectedRowVersion: 1,
      type: "lesson_completed",
      subjectType: "lesson",
      subjectId: "50000000-0000-4000-8000-000000000099",
    })).rejects.toMatchObject({ code: "INVALID_EVENT_SUBJECT", status: 400 });
    expect(authorize).toHaveBeenCalledWith(
      USER_ID,
      "40000000-0000-4000-8000-000000000001",
      "50000000-0000-4000-8000-000000000099",
    );
    expect(updateSession).not.toHaveBeenCalled();
    expect(insertSessionEvent).not.toHaveBeenCalled();
  });

  it("marks only an enrollment-bound lesson completion as authoritative", async () => {
    const insertSessionEvent = vi.fn(async (input) => ({
      id: input.id,
      sessionId: input.sessionId,
      userId: input.userId,
      clientEventId: input.clientEventId,
      type: input.type,
      meaningful: input.meaningful,
      authority: input.authority,
      occurredAt: NOW,
    }));
    const service = serviceWith({
      getSessionEvent: vi.fn(async () => null),
      getSession: vi.fn(async () => session({ enrollmentId: "40000000-0000-4000-8000-000000000001" })),
      isLessonCompletionAuthorized: vi.fn(async () => true),
      updateSession: vi.fn(async () => session({ rowVersion: 2 })),
      insertSessionEvent,
      touchMeaningfulActivity: vi.fn(async () => undefined),
    });
    await service.recordSessionEvent({
      userId: USER_ID,
      sessionId: session().id,
      clientEventId: "client-event-authority-0006",
      expectedRowVersion: 1,
      type: "lesson_completed",
      subjectType: "lesson",
      subjectId: "50000000-0000-4000-8000-000000000001",
    });
    expect(insertSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      meaningful: true,
      authority: LESSON_COMPLETION_AUTHORITY,
    }));
  });
});

describe("attempt ownership, concurrency, and degraded paths", () => {
  it("rejects missing, closed, or duplicate-revision attempts", async () => {
    await expect(serviceWith({ getAttempt: vi.fn(async () => null) })
      .submitAttempt(USER_ID, attempt().attempt.id, submission))
      .rejects.toMatchObject({ code: "ATTEMPT_NOT_FOUND", status: 404 });
    await expect(serviceWith({ getAttempt: vi.fn(async () => attempt({ status: "cancelled" })) })
      .submitAttempt(USER_ID, attempt().attempt.id, submission))
      .rejects.toMatchObject({ code: "ATTEMPT_NOT_SUBMITTABLE", status: 409 });
    await expect(serviceWith({
      getAttempt: vi.fn(async () => attempt()), insertResponseIfAbsent: vi.fn(async () => false),
    }).submitAttempt(USER_ID, attempt().attempt.id, submission))
      .rejects.toMatchObject({ code: "RESPONSE_REVISION_CONFLICT", status: 409 });
  });

  it("returns an already graded attempt idempotently without writing evidence", async () => {
    const appendOfficialEvidence = vi.fn();
    const service = serviceWith({
      getAttempt: vi.fn(async () => attempt({
        status: "graded", score: 1, passed: true, masteryAwarded: true, gradedAt: NOW,
      })),
      appendOfficialEvidence,
    });
    await expect(service.submitAttempt(USER_ID, attempt().attempt.id, submission)).resolves.toMatchObject({
      state: "graded", score: 1, passed: true, masteryAwarded: true, idempotent: true,
    });
    expect(appendOfficialEvidence).not.toHaveBeenCalled();
  });

  it("keeps incomplete runner work degraded and writes no official evidence", async () => {
    const appendOfficialEvidence = vi.fn();
    const service = serviceWith({
      getAttempt: vi.fn(async () => attempt({}, { grading: { kind: "runner" } })),
      insertResponseIfAbsent: vi.fn(async () => true),
      getVerifiedRunnerResult: vi.fn(async () => ({ passed: true, score: 2 })),
      markAttemptSubmitted: vi.fn(async () => true), appendOfficialEvidence,
    });
    await expect(service.submitAttempt(USER_ID, attempt().attempt.id, submission)).resolves.toMatchObject({
      state: "degraded", officialEvidenceRecorded: false, degradedReason: "runner_not_complete",
    });
    expect(appendOfficialEvidence).not.toHaveBeenCalled();
  });

  it("fails the transaction when official evidence or mastery loses a concurrency race", async () => {
    const base = {
      getAttempt: vi.fn(async () => attempt()), insertResponseIfAbsent: vi.fn(async () => true),
      getMasteryBundle: vi.fn(async () => ({ mastery: null, evidence: [], activeReview: null })),
    };
    await expect(serviceWith({
      ...base, appendOfficialEvidence: vi.fn(async () => false),
    }).submitAttempt(USER_ID, attempt().attempt.id, submission))
      .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(serviceWith({
      ...base, appendOfficialEvidence: vi.fn(async () => true), writeMastery: vi.fn(async () => false),
    }).submitAttempt(USER_ID, attempt().attempt.id, submission))
      .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("detects attempt idempotency-key reuse with different parameters", async () => {
    const existing = attempt();
    const service = serviceWith({ getAttempt: vi.fn(async () => existing) });
    await expect(service.createAttempt({
      userId: USER_ID, idempotencyKey: "attempt-key-0009", skillId: "python.toolchain.repl", kind: "quiz",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it("returns the matching existing attempt idempotently", async () => {
    const existing = attempt();
    const service = serviceWith({ getAttempt: vi.fn(async () => existing) });
    await expect(service.createAttempt({
      userId: USER_ID, idempotencyKey: "attempt-key-0012",
      skillId: "python.toolchain.repl", kind: "practice",
    })).resolves.toMatchObject({
      state: "ready", attempt: existing.attempt, activity: existing.activity, idempotent: true,
    });
  });

  it("fails closed before inserting a practice attempt whose published activity lacks a supported deterministic prompt", async () => {
    const insertAttempt = vi.fn();
    const unsupported = activity({
      kind: "mcq",
      prompt: "An unsafe model-graded prompt.",
      options: [{ id: "a", text: "A" }, { id: "b", text: "B" }],
      grading: { kind: "llm" },
    });
    const service = serviceWith({
      getAttempt: vi.fn(async () => null),
      resolveActivity: vi.fn(async () => unsupported),
      insertAttempt,
    });
    await expect(service.createAttempt({
      userId: USER_ID,
      idempotencyKey: "attempt-key-0013",
      skillId: "python.toolchain.repl",
      kind: "practice",
    })).resolves.toMatchObject({
      state: "degraded",
      reason: "activity_unsupported",
      attempt: null,
    });
    expect(insertAttempt).not.toHaveBeenCalled();
  });

  it("fails closed before inserting or replaying a non-MCQ official checkpoint", async () => {
    const traceSpecification = {
      kind: "trace",
      itemKey: "trace-only",
      prompt: "What value is displayed?",
      artifact: ["print(4)"],
      grading: { kind: "exact", acceptedAnswers: ["4"] },
    };
    const insertAttempt = vi.fn();
    const service = serviceWith({
      getAttempt: vi.fn(async () => null),
      resolveActivity: vi.fn(async () => activity(traceSpecification)),
      insertAttempt,
    });
    await expect(service.createAttempt({
      userId: USER_ID,
      idempotencyKey: "checkpoint-key-0001",
      skillId: "python.toolchain.repl",
      kind: "quiz",
    })).resolves.toMatchObject({
      state: "degraded",
      reason: "activity_unsupported",
      attempt: null,
      idempotent: false,
    });
    expect(insertAttempt).not.toHaveBeenCalled();

    const existing = attempt({ kind: "quiz" }, traceSpecification);
    await expect(serviceWith({ getAttempt: vi.fn(async () => existing) }).createAttempt({
      userId: USER_ID,
      idempotencyKey: "checkpoint-key-0002",
      skillId: "python.toolchain.repl",
      kind: "quiz",
    })).resolves.toMatchObject({
      state: "degraded",
      reason: "activity_unsupported",
      attempt: null,
      idempotent: true,
    });
  });

  it("binds a learner submission to the server-selected item key", async () => {
    const owned = attempt({}, {
      kind: "short-answer",
      itemKey: "server-item-a",
      prompt: "Enter 42.",
      grading: { kind: "exact", acceptedAnswers: ["42"] },
    });
    const insertResponse = vi.fn();
    await expect(serviceWith({
      getAttempt: vi.fn(async () => owned),
      insertResponseIfAbsent: insertResponse,
    }).submitAttempt(USER_ID, owned.attempt.id, {
      ...submission,
      itemKey: "different-item",
    })).rejects.toMatchObject({ code: "ITEM_KEY_MISMATCH", status: 409 });
    expect(insertResponse).not.toHaveBeenCalled();
  });

  it("rolls back when final attempt grading loses a concurrency race", async () => {
    const service = serviceWith({
      getAttempt: vi.fn(async () => attempt()), insertResponseIfAbsent: vi.fn(async () => true),
      getMasteryBundle: vi.fn(async () => ({ mastery: null, evidence: [], activeReview: null })),
      appendOfficialEvidence: vi.fn(async () => true), writeMastery: vi.fn(async () => true),
      writeReview: vi.fn(async (input) => ({
        id: "review-final-conflict", userId: USER_ID, enrollmentId: attempt().activity.enrollmentId,
        conceptId: attempt().activity.conceptId, skillId: attempt().activity.skillId,
        languageContext: "conceptual", dueAt: input.dueAt, intervalDays: input.intervalDays,
        reason: input.reason, status: "scheduled",
      })),
      gradeAttempt: vi.fn(async () => false),
    });
    await expect(service.submitAttempt(USER_ID, attempt().attempt.id, {
      ...submission, solutionRevealed: true,
    })).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
  });
});

describe("adaptive recommendation guards", () => {
  it("blocks language-specific DSA practice until implementation language is chosen", async () => {
    const service = serviceWith({ getAdaptiveSnapshot: vi.fn(async () => ({
      planItems: [{
        schemaVersion: 1 as const, id: "dsa:arrays", kind: "learn" as const, trackId: "dsa",
        courseVersion: "0.1.0", moduleId: "dsa.arrays", skillId: "dsa.arrays.traverse",
        title: "Traverse arrays", position: 1, required: true, prerequisites: [],
        evidenceTypes: ["code"], languageContext: "dsa:unselected", goalPriority: 10, prerequisiteCentrality: 1,
      }],
      progress: [], reviews: [], sessionCounts: { completedActions: 0, reviewActions: 0 },
    })) });
    await expect(service.recommendNext(USER_ID)).resolves.toEqual({
      state: "degraded", action: null,
      reason: "Choose a DSA implementation language before language-specific practice.",
    });
  });
});

describe("DSA language switch guards", () => {
  it("rejects unsupported implementation languages", async () => {
    await expect(serviceWith({}).switchDsaLanguage({
      userId: USER_ID, language: "Rust" as unknown as "Python", idempotencyKey: "dsa-key-0001",
    })).rejects.toMatchObject({ code: "INVALID_DSA_LANGUAGE" });
  });

  it("degrades safely when no published DSA enrollment exists", async () => {
    const service = serviceWith({ getDsaEnrollment: vi.fn(async () => null) });
    await expect(service.switchDsaLanguage({
      userId: USER_ID, language: "Python", idempotencyKey: "dsa-key-0002",
    })).resolves.toEqual({
      state: "degraded", previousLanguage: null, language: "Python", revisionId: null,
      syntaxRetestSkillIds: [], preservedPriorEvidence: true,
      reason: "No published DSA enrollment is available.",
    });
  });

  it("keeps the existing plan when the normalized language is unchanged", async () => {
    const write = vi.fn(async () => "unchanged" as const);
    const service = serviceWith({
      getDsaEnrollment: vi.fn(async () => ({
        enrollmentId: "enrollment-dsa", courseVersionId: "version-dsa", courseVersion: "0.1.0",
        implementationLanguage: "py", latestRevisionId: "revision-current", latestRevision: 2, latestPlan: [],
      })),
      writeDsaLanguageSwitch: write,
    });
    const result = await service.switchDsaLanguage({
      userId: USER_ID, language: "Python", idempotencyKey: "dsa-key-0003",
    });
    expect(result).toMatchObject({
      state: "unchanged", previousLanguage: "py", language: "Python",
      revisionId: "revision-current", preservedPriorEvidence: true,
    });
    expect(result.syntaxRetestSkillIds.length).toBeGreaterThan(0);
    expect(write).toHaveBeenCalledOnce();
  });

  it("reports a version conflict if the language-plan revision cannot be committed", async () => {
    const service = serviceWith({
      getDsaEnrollment: vi.fn(async () => ({
        enrollmentId: "enrollment-dsa", courseVersionId: "version-dsa", courseVersion: "0.1.0",
        implementationLanguage: "C++", latestRevisionId: "revision-current", latestRevision: 2, latestPlan: [],
      })),
      writeDsaLanguageSwitch: vi.fn(async () => "stale" as const),
    });
    await expect(service.switchDsaLanguage({
      userId: USER_ID, language: "Python", idempotencyKey: "dsa-key-0004",
    })).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
  });

  it("reports an idempotency conflict when a DSA switch key is reused", async () => {
    const service = serviceWith({
      getDsaEnrollment: vi.fn(async () => ({
        enrollmentId: "enrollment-dsa", courseVersionId: "version-dsa", courseVersion: "0.1.0",
        implementationLanguage: "C++", latestRevisionId: "revision-current", latestRevision: 2, latestPlan: [],
      })),
      writeDsaLanguageSwitch: vi.fn(async () => "conflict" as const),
    });
    await expect(service.switchDsaLanguage({
      userId: USER_ID, language: "Python", idempotencyKey: "dsa-key-conflict-0001",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });
});
