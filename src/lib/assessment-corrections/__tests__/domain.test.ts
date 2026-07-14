import { describe, expect, it } from "vitest";

import type {
  ExamFormSnapshot,
  ExamResult,
  ExamRunnerResult,
} from "@/lib/exams/contracts";
import { hashAppealEvidence } from "@/lib/appeals/evidence";

import { replacementEvidenceSchema, type ReplacementEvidence } from "../contracts";
import {
  AssessmentCorrectionError,
  buildImpactHashes,
  correctionMasteryLanguageContext,
  correctionTarget,
  formMatchesTarget,
  masteryEffect,
  replaceFormEvidence,
  reviewedReplacement,
  runnerEvidenceManifest,
  verifyImpactSnapshot,
  type ImpactSnapshot,
} from "../domain";

const digest = `sha256:${"a".repeat(64)}`;

function form(): ExamFormSnapshot {
  return {
    schemaVersion: 1,
    formId: "form-1",
    seed: "secret-seed",
    courseId: "python",
    courseTitle: "Python",
    moduleId: "python.loops",
    moduleTitle: "Loops",
    contentVersion: "2026.07",
    policyVersion: "formal-exam-v1",
    durationMinutes: 20,
    generatedAt: "2026-07-12T00:00:00.000Z",
    instructions: ["Closed book"],
    integrityDisclosure: { version: "1", summary: "Events recorded", capturedEvents: [], notCaptured: [] },
    items: [{
      id: "python.loops.code-1",
      skillId: "python.loops.for",
      clusterId: "loops",
      title: "Loop",
      prompt: "Print 1 through 3.",
      kind: "code",
      points: 100,
      critical: true,
      language: "python",
      gradingEvidence: {
        kind: "runner-tests",
        bundleVersion: "faulty-v1",
        tests: [{
          id: "visible-1",
          visibility: "VISIBLE",
          category: "functional",
          stdin: "",
          expectedStdout: "1\n2\n3\n",
          comparison: "EXACT",
          critical: true,
        }, {
          id: "hidden-1",
          visibility: "HIDDEN",
          category: "edge",
          stdin: "",
          expectedStdout: "1\n2\n3\n",
          comparison: "TRIMMED",
          critical: true,
        }],
      },
    }],
  };
}

function replacement(): ReplacementEvidence {
  return {
    kind: "runner-tests",
    bundleVersion: "reviewed-v2",
    runtimeImageDigest: digest,
    tests: [{
      id: "visible-2",
      visibility: "VISIBLE",
      category: "functional",
      stdin: "",
      expectedStdout: "1\n2\n3\n",
      comparison: "EXACT",
      critical: true,
    }, {
      id: "hidden-2",
      visibility: "HIDDEN",
      category: "edge",
      stdin: "",
      expectedStdout: "1\n2\n3\n",
      comparison: "EXACT",
      critical: true,
    }],
  };
}

const originalResult: ExamResult = {
  schemaVersion: 1,
  gradingStatus: "graded",
  outcome: "NOT_PASSED",
  officialScorePercent: 0,
  earnedPoints: 0,
  possiblePoints: 100,
  pendingReviewItemIds: [],
  failedCriticalClusters: ["loops"],
  masteryBlockingCodingItems: ["python.loops.code-1"],
  compilationGatePassed: true,
  infrastructureFailure: false,
  finalizedAt: "2026-07-12T00:10:00.000Z",
  finalizedBy: "learner-submit",
  policyVersion: "formal-exam-v1",
  remediation: { required: true, targets: ["loops"] },
};

function snapshot(): ImpactSnapshot {
  return {
    schemaVersion: 1,
    attempt: {
      id: "10000000-0000-4000-8000-000000000001",
      userId: "learner-1",
      status: "graded",
      policyVersion: "formal-exam-v1",
      contentVersion: "2026.07",
      score: 0,
      passed: false,
      masteryAwarded: false,
    },
    examSessionId: "20000000-0000-4000-8000-000000000001",
    form: form(),
    answers: { "python.loops.code-1": { revision: 3, answer: { language: "python", sourceCode: "for i in range(1, 4): print(i)" } } },
    originalResult,
  };
}

describe("assessment correction evidence domain", () => {
  it("binds scope to the exact form item, bundle, content version, and canonical test hash", () => {
    const target = correctionTarget(form(), "python.loops.code-1");
    expect(target).toMatchObject({
      courseId: "python",
      moduleId: "python.loops",
      itemId: "python.loops.code-1",
      contentVersion: "2026.07",
      faultyBundleVersion: "faulty-v1",
      hadHiddenTests: true,
    });
    expect(target.faultyEvidenceHash).toHaveLength(64);
    expect(formMatchesTarget(form(), target)).toBe(true);
    const base = form();
    const originalEvidence = base.items[0]!.gradingEvidence;
    if (originalEvidence.kind !== "runner-tests") throw new Error("fixture must use runner tests");
    const changed: ExamFormSnapshot = {
      ...base,
      items: [{
        ...base.items[0]!,
        gradingEvidence: {
          ...originalEvidence,
          bundleVersion: "different",
        },
      }],
    };
    expect(formMatchesTarget(changed, target)).toBe(false);
  });

  it("requires a new bundle version, unique tests, a pinned image, and preserved hidden coverage", () => {
    const target = correctionTarget(form(), "python.loops.code-1");
    expect(reviewedReplacement(target, replacement())).toEqual(replacement());
    expect(() => reviewedReplacement(target, { ...replacement(), bundleVersion: "faulty-v1" }))
      .toThrow(expect.objectContaining({ code: "REPLACEMENT_VERSION_REUSED" }));
    expect(() => reviewedReplacement(target, {
      ...replacement(), tests: replacement().tests.filter((test) => test.visibility === "VISIBLE"),
    })).toThrow(expect.objectContaining({ code: "HIDDEN_TEST_COVERAGE_REMOVED" }));
    expect(replacementEvidenceSchema.safeParse({ ...replacement(), runtimeImageDigest: "latest" }).success).toBe(false);
    expect(replacementEvidenceSchema.safeParse({ ...replacement(), tests: [replacement().tests[0], replacement().tests[0]] }).success).toBe(false);
  });

  it("creates a corrected form without mutating the original hidden test evidence", () => {
    const original = form();
    const target = correctionTarget(original, "python.loops.code-1");
    const corrected = replaceFormEvidence(original, target, replacement());
    expect(corrected.items[0]!.gradingEvidence).toEqual(replacement());
    expect(original.items[0]!.gradingEvidence).toMatchObject({ bundleVersion: "faulty-v1" });
    expect(hashAppealEvidence(original)).not.toBe(hashAppealEvidence(corrected));
  });

  it("detects any mutation to immutable form, answer, result, or snapshot evidence", () => {
    const original = snapshot();
    const hashes = buildImpactHashes(original);
    expect(verifyImpactSnapshot(original, hashes)).toBe(true);
    const tampered: ImpactSnapshot = {
      ...original,
      answers: { ...original.answers, "python.loops.code-1": { revision: 4, answer: { sourceCode: "print('tampered')" } } },
    };
    expect(verifyImpactSnapshot(tampered, hashes)).toBe(false);
  });

  it("records only runner result provenance—not hidden inputs or expected outputs—in the outcome manifest", () => {
    const target = correctionTarget(form(), "python.loops.code-1");
    const result: ExamRunnerResult = {
      status: "ACCEPTED",
      requestHash: "b".repeat(64),
      sourceHash: "c".repeat(64),
      runtimeVersion: "Python 3.14",
      imageDigest: digest,
      testBundleVersion: "reviewed-v2",
      compile: { status: "OK", exitCode: 0, stdout: "", stderr: "", wallTimeMs: 1 },
      tests: [{ id: "hidden-2", visibility: "HIDDEN", category: "edge", status: "PASSED", feedbackCode: "OK", exitCode: 0, wallTimeMs: 1 }],
      totals: { passed: 1, failed: 0, total: 1 },
      startedAt: "2026-07-12T01:00:00.000Z",
      finishedAt: "2026-07-12T01:00:01.000Z",
    };
    const manifest = runnerEvidenceManifest({ target, replacement: replacement(), results: { "python.loops.code-1": result }, executedAt: new Date("2026-07-12T01:00:01.000Z") });
    expect(JSON.stringify(manifest)).not.toContain("edge input");
    expect(JSON.stringify(manifest)).not.toContain("expectedStdout");
    expect(manifest.items[0]).toMatchObject({ itemId: "python.loops.code-1", imageDigest: digest, status: "ACCEPTED" });
  });

  it("derives append-only mastery award and revocation effects from old and superseding outcomes", () => {
    expect(masteryEffect("NOT_PASSED", "MASTERED")).toBe("award");
    expect(masteryEffect("MASTERED", "PASSED")).toBe("revoke");
    expect(masteryEffect("PASSED", "PASSED")).toBe("no_change");
  });

  it("uses conceptual facets for language courses and one canonical dsa implementation facet", () => {
    expect(correctionMasteryLanguageContext(form())).toBe("conceptual");
    const dsa: ExamFormSnapshot = {
      ...form(),
      courseId: "dsa",
      moduleId: "dsa.arrays",
      items: form().items.map((item) => ({ ...item, language: "cpp" })),
    };
    expect(correctionMasteryLanguageContext(dsa)).toBe("dsa:c++");
    expect(() => correctionMasteryLanguageContext({
      ...dsa,
      items: [...dsa.items, { ...dsa.items[0]!, id: "dsa.arrays.java", language: "java" }],
    })).toThrow(expect.objectContaining({ code: "EXAM_EVIDENCE_MISSING" }));
  });

  it("fails closed for missing or non-deterministic targets", () => {
    expect(() => correctionTarget(form(), "missing")).toThrow(AssessmentCorrectionError);
    const base = form();
    const pending: ExamFormSnapshot = {
      ...base,
      items: [{ ...base.items[0]!, gradingEvidence: { kind: "pending-review", reason: "Human review required." } }],
    };
    expect(() => correctionTarget(pending, "python.loops.code-1"))
      .toThrow(expect.objectContaining({ code: "ITEM_NOT_DETERMINISTIC" }));
  });
});
