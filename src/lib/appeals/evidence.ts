import { createHash } from "node:crypto";

import type {
  ExamFormSnapshot,
  ExamResult,
  SavedExamAnswer,
} from "@/lib/exams/contracts";

export type ExamAppealCategory = "scoring" | "technical" | "integrity" | "accessibility";
export type ProjectReviewAppealCategory = "project_finding";

function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(",")}}`;
}

export function hashAppealEvidence(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function buildExamAppealEvidence(input: {
  examSessionId: string;
  attemptId: string;
  category: ExamAppealCategory;
  form: ExamFormSnapshot;
  answers: Readonly<Record<string, SavedExamAnswer>>;
  result: ExamResult | null;
  submissions: readonly {
    id: string;
    sourceHash: string;
    runtimeImageDigest: string;
    status: string;
    createdAt: Date;
  }[];
  capturedAt: Date;
}) {
  const evidence = {
    schemaVersion: 1,
    targetType: "exam_attempt",
    examSessionId: input.examSessionId,
    attemptId: input.attemptId,
    category: input.category,
    capturedAt: input.capturedAt.toISOString(),
    form: {
      formId: input.form.formId,
      seedHash: hashAppealEvidence(input.form.seed),
      courseId: input.form.courseId,
      moduleId: input.form.moduleId,
      contentVersion: input.form.contentVersion,
      policyVersion: input.form.policyVersion,
      generatedAt: input.form.generatedAt,
    },
    answers: Object.entries(input.answers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([itemId, saved]) => ({
        itemId,
        revision: saved.revision,
        savedAt: saved.savedAt,
        answerHash: hashAppealEvidence(saved.answer),
      })),
    result: input.result === null
      ? null
      : {
          outcome: input.result.outcome,
          gradingStatus: input.result.gradingStatus,
          officialScorePercent: input.result.officialScorePercent,
          finalizedAt: input.result.finalizedAt,
          policyVersion: input.result.policyVersion,
          infrastructureFailure: input.result.infrastructureFailure,
          resultHash: hashAppealEvidence(input.result),
        },
    submissions: input.submissions.map((submission) => ({
      id: submission.id,
      sourceHash: submission.sourceHash,
      runtimeImageDigest: submission.runtimeImageDigest,
      status: submission.status,
      createdAt: submission.createdAt.toISOString(),
    })),
  } as const;
  return { evidence, evidenceHash: hashAppealEvidence(evidence) } as const;
}

/**
 * Captures the exact stored review that the learner is disputing. The review
 * commit, analyzer version, and findings are copied into the immutable appeal
 * manifest so a later repository change or re-analysis cannot rewrite the
 * evidence considered by the administrator.
 */
export function buildProjectReviewAppealEvidence(input: {
  project: {
    id: string;
    title: string;
    githubUrl: string | null;
    githubCommitSha: string | null;
  };
  review: {
    id: string;
    commitSha: string;
    analyzerVersion: string;
    rubricVersion: string;
    modelCallId: string | null;
    analysisProvenance: Record<string, unknown>;
    findings: readonly Record<string, unknown>[];
    findingsHash: string | null;
    status: string;
    createdAt: Date;
  };
  category: ProjectReviewAppealCategory;
  capturedAt: Date;
}) {
  const evidence = {
    schemaVersion: 1,
    targetType: "project_review",
    category: input.category,
    capturedAt: input.capturedAt.toISOString(),
    project: {
      id: input.project.id,
      title: input.project.title,
      githubUrl: input.project.githubUrl,
      currentCommitSha: input.project.githubCommitSha,
    },
    review: {
      id: input.review.id,
      commitSha: input.review.commitSha,
      analyzerVersion: input.review.analyzerVersion,
      rubricVersion: input.review.rubricVersion,
      modelCallId: input.review.modelCallId,
      analysisProvenance: input.review.analysisProvenance,
      status: input.review.status,
      createdAt: input.review.createdAt.toISOString(),
      findings: input.review.findings,
      findingsHash: input.review.findingsHash ?? hashAppealEvidence(input.review.findings),
    },
  } as const;
  return { evidence, evidenceHash: hashAppealEvidence(evidence) } as const;
}
