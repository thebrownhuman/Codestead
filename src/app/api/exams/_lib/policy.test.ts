import { describe, expect, it } from "vitest";

import type {
  ExamFormSnapshot,
  ExamItem,
  ExamResult,
  ExamRunnerResult,
} from "./contracts";
import type { StoredEvidence } from "@/lib/learning-service/types";
import { buildTargetedMasteryRecheckForm, verifyEquivalentFormParity } from "./blueprint";
import {
  canConsumeEquivalentReexamGrant,
  computeRetakeEligibility,
  deduplicateExamEvents,
  disconnectedDeltaSeconds,
  evaluateStartDevice,
  gradeExamSubmission,
  hasDeadlinePassed,
  hasPersistedRemediationEvidence,
  latestRevisionByItem,
  remainingExamSeconds,
  sanitizeEventMetadata,
  serverClockOffsetMs,
} from "./policy";

function deterministicEvidence(
  skillId: string,
  recordedAt: string,
  overrides: Partial<StoredEvidence> & {
    readonly envelope?: Readonly<Record<string, unknown>>;
  } = {},
): StoredEvidence {
  const {
    envelope: envelopeOverrides = {},
    ...rowOverrides
  } = overrides;
  return {
    id: `evidence-${skillId}-${recordedAt}`,
    skillId,
    enrollmentId: "enrollment-1",
    conceptId: `concept-${skillId}`,
    languageContext: "conceptual",
    sourceType: "deterministic_attempt",
    sourceId: `source-${skillId}-${recordedAt}`,
    evidenceType: JSON.stringify({
      version: 1,
      origin: "deterministic_spec",
      skillId,
      itemVariantId: `variant-${skillId}`,
      evidenceLevel: "E3",
      assistanceLevel: "A0",
      correct: true,
      learningOpportunity: true,
      solutionRevealed: false,
      misconceptionTags: [],
      languageContext: "conceptual",
      ...envelopeOverrides,
    }),
    score: 1,
    weight: 1,
    criticalCriterion: "core",
    validity: "valid",
    recordedBy: "adaptive-deterministic-engine",
    recordedAt: new Date(recordedAt),
    ...rowOverrides,
  };
}

function failedResult(targets: readonly string[]): ExamResult {
  return {
    schemaVersion: 1,
    gradingStatus: "graded",
    outcome: "NOT_PASSED",
    officialScorePercent: 40,
    earnedPoints: 40,
    possiblePoints: 100,
    pendingReviewItemIds: [],
    failedCriticalClusters: [],
    masteryBlockingCodingItems: [],
    compilationGatePassed: false,
    infrastructureFailure: false,
    finalizedAt: "2026-07-12T00:10:00.000Z",
    finalizedBy: "learner-submit",
    policyVersion: "formal-exam-v1",
    remediation: { required: true, targets },
  };
}

function form(items: readonly ExamItem[]): ExamFormSnapshot {
  return {
    schemaVersion: 1,
    formId: "form-1",
    seed: "seed-1",
    courseId: "python",
    courseTitle: "Python",
    moduleId: "python.basics",
    moduleTitle: "Basics",
    contentVersion: "catalog-1:course-1",
    policyVersion: "formal-exam-v1",
    durationMinutes: 10,
    generatedAt: "2026-07-12T00:00:00.000Z",
    instructions: [],
    integrityDisclosure: {
      version: "v1",
      summary: "events disclosed",
      capturedEvents: [],
      notCaptured: [],
    },
    items,
  };
}

function exactItem(id: string, acceptedAnswer: string, points: number): ExamItem {
  return {
    id,
    skillId: `skill-${id}`,
    clusterId: `cluster-${id}`,
    title: id,
    prompt: id,
    kind: "short-answer",
    points,
    critical: false,
    gradingEvidence: {
      kind: "exact-answer",
      acceptedAnswers: [acceptedAnswer],
      caseSensitive: false,
    },
  };
}

function codeItem(): ExamItem {
  return {
    id: "code-1",
    skillId: "skill-code",
    clusterId: "cluster-code",
    title: "Code",
    prompt: "Code",
    kind: "code",
    points: 100,
    critical: true,
    language: "python",
    starterCode: "",
    gradingEvidence: {
      kind: "runner-tests",
      bundleVersion: "bundle-1",
      tests: [{
        id: "critical-1",
        visibility: "HIDDEN",
        category: "critical",
        stdin: "",
        expectedStdout: "ok",
        comparison: "TRIMMED",
        critical: true,
      }],
    },
  };
}

function runnerResult(overrides: Partial<ExamRunnerResult> = {}): ExamRunnerResult {
  return {
    status: "ACCEPTED",
    requestHash: "a".repeat(64),
    sourceHash: "b".repeat(64),
    runtimeVersion: "Python 3.14",
    imageDigest: `sha256:${"c".repeat(64)}`,
    compile: {
      status: "OK",
      exitCode: 0,
      stdout: "",
      stderr: "",
      wallTimeMs: 2,
    },
    tests: [{
      id: "critical-1",
      visibility: "HIDDEN",
      category: "critical",
      status: "PASSED",
      feedbackCode: "PASS",
      exitCode: 0,
      wallTimeMs: 2,
    }],
    totals: { passed: 1, failed: 0, total: 1 },
    startedAt: "2026-07-12T00:00:00.000Z",
    finishedAt: "2026-07-12T00:00:01.000Z",
    ...overrides,
  };
}

describe("server-authoritative exam timing", () => {
  it("uses the server clock offset instead of trusting the client clock", () => {
    const clientReceivedAt = Date.parse("2026-07-12T10:00:00.000Z");
    const offset = serverClockOffsetMs("2026-07-12T10:02:00.000Z", clientReceivedAt);
    expect(offset).toBe(120_000);
    expect(remainingExamSeconds("2026-07-12T10:07:00.000Z", clientReceivedAt, offset)).toBe(300);
  });

  it("expires at zero and selects the latest autosave revision", () => {
    const now = new Date("2026-07-12T10:07:00.000Z");
    expect(hasDeadlinePassed(new Date("2026-07-12T10:07:00.000Z"), now)).toBe(true);
    expect(remainingExamSeconds(now.toISOString(), now.getTime(), 0)).toBe(0);
    const latest = latestRevisionByItem([
      { itemKey: "q1", revision: 1, value: "old", savedAt: new Date("2026-07-12T10:01:00Z") },
      { itemKey: "q1", revision: 3, value: "latest", savedAt: new Date("2026-07-12T10:03:00Z") },
      { itemKey: "q1", revision: 2, value: "middle", savedAt: new Date("2026-07-12T10:02:00Z") },
    ]);
    expect(latest.get("q1")?.value).toBe("latest");
  });

  it("counts only the heartbeat gap beyond the expected reconnect interval", () => {
    expect(disconnectedDeltaSeconds(
      new Date("2026-07-12T10:00:00.000Z"),
      new Date("2026-07-12T10:00:45.000Z"),
      15,
    )).toBe(30);
    expect(disconnectedDeltaSeconds(
      new Date("2026-07-12T10:00:00.000Z"),
      new Date("2026-07-12T10:00:10.000Z"),
      15,
    )).toBe(0);
  });
});

describe("integrity event policy", () => {
  it("deduplicates focus events by client id", () => {
    const focus = { clientEventId: "event-focus-00000001", type: "window_focus" as const, metadata: { target: "window" } };
    expect(deduplicateExamEvents([focus, focus, { ...focus, clientEventId: "event-focus-00000002" }])).toHaveLength(2);
  });

  it("keeps focus metadata but drops clipboard contents and unknown fields", () => {
    expect(sanitizeEventMetadata({
      target: "window",
      pastedCharacters: 42,
      clipboardContents: "secret answer",
      arbitrary: { nested: true },
    })).toEqual({ target: "window", pastedCharacters: 42 });
  });
});

describe("exam device gate", () => {
  it("denies a phone even when its reported CSS width is large", () => {
    expect(evaluateStartDevice({
      viewportWidth: 932,
      viewportHeight: 430,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    })).toEqual({ allowed: false, reason: "phone-detected" });
  });

  it("allows desktop and tablet-sized clients", () => {
    expect(evaluateStartDevice({ viewportWidth: 1366, viewportHeight: 768, userAgent: "Mozilla/5.0 Windows" }).allowed).toBe(true);
    expect(evaluateStartDevice({ viewportWidth: 820, viewportHeight: 1180, userAgent: "Mozilla/5.0 (iPad)" }).allowed).toBe(true);
  });
});

describe("evidence-safe grading", () => {
  it("makes a compiler error a deterministic functional failure", () => {
    const result = gradeExamSubmission({
      form: form([codeItem()]),
      answers: { "code-1": { sourceCode: "not valid", language: "python" } },
      runnerResults: {
        "code-1": runnerResult({
          status: "COMPILE_ERROR",
          compile: {
            status: "COMPILE_ERROR",
            exitCode: 1,
            stdout: "",
            stderr: "SyntaxError",
            wallTimeMs: 2,
          },
          tests: [],
          totals: { passed: 0, failed: 0, total: 0 },
        }),
      },
      finalizedAt: "2026-07-12T00:10:00.000Z",
      finalizedBy: "learner-submit",
    });
    expect(result.outcome).toBe("NOT_PASSED");
    expect(result.officialScorePercent).toBe(0);
    expect(result.compilationGatePassed).toBe(false);
  });

  it("awards pass at 80 percent without incorrectly awarding mastery", () => {
    const result = gradeExamSubmission({
      form: form([exactItem("q1", "yes", 80), exactItem("q2", "yes", 20)]),
      answers: { q1: { text: "yes" }, q2: { text: "no" } },
      runnerResults: {},
      finalizedAt: "2026-07-12T00:10:00.000Z",
      finalizedBy: "learner-submit",
    });
    expect(result.outcome).toBe("PASSED");
    expect(result.officialScorePercent).toBe(80);
    expect(result.masteryRecheck).toEqual({
      required: true,
      clusterIds: ["cluster-q2"],
      codingItemIds: [],
    });
  });

  it("awards mastery when all critical runner tests pass", () => {
    const result = gradeExamSubmission({
      form: form([codeItem()]),
      answers: { "code-1": { sourceCode: "print('ok')", language: "python" } },
      runnerResults: { "code-1": runnerResult() },
      finalizedAt: "2026-07-12T00:10:00.000Z",
      finalizedBy: "learner-submit",
    });
    expect(result.outcome).toBe("MASTERED");
    expect(result.officialScorePercent).toBe(100);
    expect(result.masteryBlockingCodingItems).toEqual([]);
  });

  it("never invents an official score when an item lacks answer or test evidence", () => {
    const pendingItem: ExamItem = {
      ...exactItem("q1", "yes", 100),
      gradingEvidence: { kind: "pending-review", reason: "No reviewed oracle." },
    };
    const result = gradeExamSubmission({
      form: form([pendingItem]),
      answers: { q1: { text: "yes" } },
      runnerResults: {},
      finalizedAt: "2026-07-12T00:10:00.000Z",
      finalizedBy: "deadline",
    });
    expect(result.outcome).toBe("PENDING_REVIEW");
    expect(result.officialScorePercent).toBeNull();
    expect(result.earnedPoints).toBeNull();
  });
});

describe("equivalent retake and targeted mastery recheck forms", () => {
  const source = form([exactItem("q1", "yes", 80), exactItem("q2", "yes", 20)]);
  const candidate: ExamFormSnapshot = {
    ...source,
    formId: "form-2",
    seed: "seed-2",
    generatedAt: "2026-07-13T00:00:00.000Z",
    items: source.items.map((item, index) => ({ ...item, id: `fresh-${index + 1}` })),
  };

  it("requires fresh identifiers while proving version and calibrated blueprint parity", () => {
    expect(verifyEquivalentFormParity(source, candidate)).toMatchObject({ equivalent: true, issues: [] });
    expect(verifyEquivalentFormParity(source, { ...candidate, contentVersion: "changed" })).toMatchObject({
      equivalent: false,
      issues: expect.arrayContaining(["CONTENT_VERSION_MISMATCH"]),
    });
    expect(verifyEquivalentFormParity(source, { ...candidate, seed: source.seed })).toMatchObject({
      equivalent: false,
      issues: expect.arrayContaining(["SEED_REUSED"]),
    });
  });

  it("builds a strictly shorter reviewed form from unmet targets and preserves the source pass", () => {
    const sourceResult: ExamResult = {
      ...failedResult([]),
      outcome: "PASSED",
      officialScorePercent: 80,
      earnedPoints: 80,
      compilationGatePassed: true,
      remediation: { required: false, targets: [] },
      masteryRecheck: { required: true, clusterIds: ["cluster-q2"], codingItemIds: [] },
    };
    const recheck = buildTargetedMasteryRecheckForm({
      sourceForm: source,
      sourceResult,
      candidateForm: candidate,
      now: new Date("2026-07-13T00:00:00.000Z"),
      formId: "recheck-form",
    });
    expect(recheck.purpose).toBe("mastery-recheck");
    expect(recheck.items).toHaveLength(1);
    expect(recheck.items[0]?.skillId).toBe("skill-q2");
    expect(recheck.items.length).toBeLessThan(source.items.length);
    expect(recheck.instructions[1]).toMatch(/prior passing result cannot be lowered/i);
  });

  it("fails closed on pending evidence and a target set that would not be shorter", () => {
    const baseResult: ExamResult = {
      ...failedResult([]), outcome: "PASSED", officialScorePercent: 90, earnedPoints: 90,
      compilationGatePassed: true, remediation: { required: false, targets: [] },
      masteryRecheck: { required: true, clusterIds: ["cluster-q1", "cluster-q2"], codingItemIds: [] },
    };
    expect(() => buildTargetedMasteryRecheckForm({
      sourceForm: source, sourceResult: baseResult, candidateForm: candidate,
    })).toThrow(/remain shorter/i);
    const unreviewed = {
      ...candidate,
      items: candidate.items.map((item, index) => index === 1
        ? { ...item, gradingEvidence: { kind: "pending-review" as const, reason: "not reviewed" } }
        : item),
    };
    expect(verifyEquivalentFormParity(source, unreviewed).issues).toContain("UNREVIEWED_EVIDENCE");
  });
});

describe("server-verified retake remediation", () => {
  const secondItem: ExamItem = {
    ...exactItem("q2", "yes", 50),
    skillId: "skill-second",
    clusterId: "shared-cluster",
  };
  const firstItem: ExamItem = {
    ...exactItem("q1", "yes", 50),
    skillId: "skill-first",
    clusterId: "shared-cluster",
  };
  const examForm = form([firstItem, secondItem]);

  it("denies a forged client completion claim when no persisted evidence exists", () => {
    const forgedInput = {
      result: failedResult(["shared-cluster"]),
      form: examForm,
      evidenceRows: [],
      remediationComplete: true,
    };
    expect(hasPersistedRemediationEvidence(forgedInput)).toBe(false);
  });

  it("denies stale evidence and requires every skill represented by a failed cluster", () => {
    const result = failedResult(["shared-cluster"]);
    expect(hasPersistedRemediationEvidence({
      result,
      form: examForm,
      evidenceRows: [
        deterministicEvidence("skill-first", "2026-07-12T00:09:59.000Z"),
        deterministicEvidence("skill-second", "2026-07-12T00:11:00.000Z"),
      ],
    })).toBe(false);
    expect(hasPersistedRemediationEvidence({
      result,
      form: examForm,
      evidenceRows: [deterministicEvidence("skill-first", "2026-07-12T00:11:00.000Z")],
    })).toBe(false);
  });

  it("allows complete clean deterministic evidence recorded after the failure", () => {
    expect(hasPersistedRemediationEvidence({
      result: failedResult(["shared-cluster"]),
      form: examForm,
      evidenceRows: [
        deterministicEvidence("skill-first", "2026-07-12T00:11:00.000Z"),
        deterministicEvidence("skill-second", "2026-07-12T00:12:00.000Z", {
          envelope: { origin: "verified_runner", evidenceLevel: "E4" },
          sourceType: "verified_runner",
          recordedBy: "verified-runner",
        }),
      ],
    })).toBe(true);
  });

  it("rejects assisted, revealed, non-deterministic, and unresolved evidence", () => {
    const result = failedResult(["skill-first"]);
    for (const evidence of [
      deterministicEvidence("skill-first", "2026-07-12T00:11:00.000Z", {
        envelope: { assistanceLevel: "A1" },
      }),
      deterministicEvidence("skill-first", "2026-07-12T00:11:00.000Z", {
        envelope: { solutionRevealed: true },
      }),
      deterministicEvidence("skill-first", "2026-07-12T00:11:00.000Z", {
        sourceType: "llm_tutor",
        recordedBy: "model",
      }),
    ]) {
      expect(hasPersistedRemediationEvidence({ result, form: examForm, evidenceRows: [evidence] })).toBe(false);
    }
    expect(hasPersistedRemediationEvidence({
      result: failedResult(["missing-target"]),
      form: examForm,
      evidenceRows: [
        deterministicEvidence("skill-first", "2026-07-12T00:11:00.000Z"),
        deterministicEvidence("skill-second", "2026-07-12T00:11:00.000Z"),
      ],
    })).toBe(false);
  });

  it("still enforces the duration-based cooldown after remediation completes", () => {
    const result = failedResult(["skill-first"]);
    const beforeCooldown = computeRetakeEligibility({
      result,
      durationMinutes: 10,
      remediationComplete: true,
      nowMs: Date.parse("2026-07-12T01:09:59.999Z"),
    });
    expect(beforeCooldown).toMatchObject({ eligible: false, reason: "cooldown" });
    expect(computeRetakeEligibility({
      result,
      durationMinutes: 10,
      remediationComplete: true,
      nowMs: Date.parse("2026-07-12T01:10:00.000Z"),
    })).toMatchObject({ eligible: true, reason: "eligible" });
  });
});

describe("authoritative equivalent re-exam grants", () => {
  it("binds consumption to the current failed source and blocks passed, mastered, pending, and stale sources", () => {
    const failed = failedResult([]);
    const input = {
      result: failed,
      grantSourceExamSessionId: "source-current",
      authoritativeExamSessionId: "source-current",
    };
    expect(canConsumeEquivalentReexamGrant(input)).toBe(true);
    expect(canConsumeEquivalentReexamGrant({ ...input, authoritativeExamSessionId: "source-newer" })).toBe(false);
    for (const outcome of ["PASSED", "MASTERED", "PENDING_REVIEW"] as const) {
      expect(canConsumeEquivalentReexamGrant({
        ...input,
        result: {
          ...failed,
          outcome,
          gradingStatus: outcome === "PENDING_REVIEW" ? "pending-review" : "graded",
        },
      })).toBe(false);
    }
    expect(canConsumeEquivalentReexamGrant({
      ...input,
      result: { ...failed, infrastructureFailure: true },
    })).toBe(false);
  });
});
