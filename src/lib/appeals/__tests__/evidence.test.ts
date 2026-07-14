import { describe, expect, it } from "vitest";

import type { ExamFormSnapshot, ExamResult } from "@/lib/exams/contracts";

import {
  buildExamAppealEvidence,
  buildProjectReviewAppealEvidence,
  hashAppealEvidence,
} from "../evidence";

const form: ExamFormSnapshot = {
  schemaVersion: 1,
  formId: "form-1",
  seed: "raw-secret-seed",
  courseId: "python",
  courseTitle: "Python",
  moduleId: "variables",
  moduleTitle: "Variables",
  contentVersion: "content-v1",
  policyVersion: "policy-v1",
  durationMinutes: 10,
  generatedAt: "2026-07-12T00:00:00.000Z",
  instructions: [],
  integrityDisclosure: { version: "1", summary: "Test", capturedEvents: [], notCaptured: [] },
  items: [{
    id: "item-1",
    skillId: "skill-1",
    clusterId: "cluster-1",
    title: "Question",
    prompt: "Give the answer",
    kind: "short-answer",
    points: 10,
    critical: true,
    gradingEvidence: { kind: "exact-answer", acceptedAnswers: ["hidden-answer"], caseSensitive: false },
  }],
};

const result: ExamResult = {
  schemaVersion: 1,
  gradingStatus: "graded",
  outcome: "NOT_PASSED",
  officialScorePercent: 50,
  earnedPoints: 5,
  possiblePoints: 10,
  pendingReviewItemIds: [],
  failedCriticalClusters: ["cluster-1"],
  masteryBlockingCodingItems: [],
  compilationGatePassed: true,
  infrastructureFailure: false,
  finalizedAt: "2026-07-12T00:10:00.000Z",
  finalizedBy: "learner-submit",
  policyVersion: "policy-v1",
  remediation: { required: true, targets: ["cluster-1"] },
};

describe("appeal evidence manifest", () => {
  it("hashes object keys canonically while preserving meaningful array order", () => {
    expect(hashAppealEvidence({ b: 2, a: { d: 4, c: 3 } }))
      .toBe(hashAppealEvidence({ a: { c: 3, d: 4 }, b: 2 }));
    expect(hashAppealEvidence({ values: [1, 2] }))
      .not.toBe(hashAppealEvidence({ values: [2, 1] }));
    expect(hashAppealEvidence({ value: "x" })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("binds the original artifacts without copying seed, hidden grading evidence, or raw answers", () => {
    const built = buildExamAppealEvidence({
      examSessionId: "20000000-0000-4000-8000-000000000001",
      attemptId: "20000000-0000-4000-8000-000000000002",
      category: "scoring",
      form,
      answers: {
        "item-1": {
          revision: 2,
          answer: { text: "learner-raw-answer" },
          savedAt: "2026-07-12T00:09:00.000Z",
        },
      },
      result,
      submissions: [{
        id: "30000000-0000-4000-8000-000000000001",
        sourceHash: "a".repeat(64),
        runtimeImageDigest: `sha256:${"b".repeat(64)}`,
        status: "completed",
        createdAt: new Date("2026-07-12T00:08:00.000Z"),
      }],
      capturedAt: new Date("2026-07-12T00:11:00.000Z"),
    });
    const serialized = JSON.stringify(built.evidence);
    expect(serialized).not.toContain("raw-secret-seed");
    expect(serialized).not.toContain("hidden-answer");
    expect(serialized).not.toContain("learner-raw-answer");
    expect(built.evidence.form.seedHash).toBe(hashAppealEvidence("raw-secret-seed"));
    expect(built.evidence.answers[0]).toMatchObject({ itemId: "item-1", revision: 2 });
    expect(built.evidence.answers[0]?.answerHash).toBe(hashAppealEvidence({ text: "learner-raw-answer" }));
    expect(built.evidenceHash).toBe(hashAppealEvidence(built.evidence));
  });

  it("sorts answer bindings so storage iteration order cannot change the manifest", () => {
    const common = {
      examSessionId: "session",
      attemptId: "attempt",
      category: "technical" as const,
      form,
      result: null,
      submissions: [],
      capturedAt: new Date("2026-07-12T00:11:00.000Z"),
    };
    const first = buildExamAppealEvidence({
      ...common,
      answers: {
        z: { revision: 1, answer: { text: "z" }, savedAt: "2026-07-12T00:00:00.000Z" },
        a: { revision: 1, answer: { text: "a" }, savedAt: "2026-07-12T00:00:00.000Z" },
      },
    });
    const second = buildExamAppealEvidence({
      ...common,
      answers: {
        a: { revision: 1, answer: { text: "a" }, savedAt: "2026-07-12T00:00:00.000Z" },
        z: { revision: 1, answer: { text: "z" }, savedAt: "2026-07-12T00:00:00.000Z" },
      },
    });
    expect(first.evidence.answers.map((answer) => answer.itemId)).toEqual(["a", "z"]);
    expect(first.evidenceHash).toBe(second.evidenceHash);
  });

  it("binds a project appeal to the exact stored commit, analyzer, and findings", () => {
    const findings = [{ rule: "secret-scan", severity: "high", file: "src/app.ts", line: 4 }];
    const built = buildProjectReviewAppealEvidence({
      project: {
        id: "40000000-0000-4000-8000-000000000001",
        title: "Portfolio API",
        githubUrl: "https://github.com/example/project",
        githubCommitSha: "newer-current-commit",
      },
      review: {
        id: "40000000-0000-4000-8000-000000000002",
        commitSha: "appealed-immutable-commit",
        analyzerVersion: "static-review-v1",
        rubricVersion: "static-project-review-rubric-v1",
        modelCallId: null,
        analysisProvenance: {
          schemaVersion: 1,
          analysisMode: "deterministic_static",
          aiUsed: false,
          promptVersion: null,
          provider: null,
          model: null,
          modelCallId: null,
          rubricVersion: "static-project-review-rubric-v1",
          repositoryExecution: "none",
          runnerTemplateId: null,
        },
        findings,
        findingsHash: null,
        status: "complete",
        createdAt: new Date("2026-07-12T01:00:00.000Z"),
      },
      category: "project_finding",
      capturedAt: new Date("2026-07-12T02:00:00.000Z"),
    });
    expect(built.evidence).toMatchObject({
      targetType: "project_review",
      category: "project_finding",
      project: { currentCommitSha: "newer-current-commit" },
      review: {
        commitSha: "appealed-immutable-commit",
        analyzerVersion: "static-review-v1",
        findings,
      },
    });
    expect(built.evidence.review.findingsHash).toBe(hashAppealEvidence(findings));
    expect(built.evidenceHash).toBe(hashAppealEvidence(built.evidence));
  });
});
