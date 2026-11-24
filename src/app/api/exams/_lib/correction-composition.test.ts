import path from "node:path";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ContentRepository,
  type AssessmentBank,
  type CourseManifest,
  type CourseModule,
  type DeterministicAssessmentItem,
} from "@/lib/content";
import type {
  ExamFormSnapshot,
  ExamItem,
  ExamResult,
  ExamRunnerResult,
} from "@/lib/exams/contracts";
import { hashAppealEvidence } from "@/lib/appeals/evidence";

// Regression suite for review findings N04, N05 and N08. Real form building,
// correction domain, grading and the real worker run; only persistence (pg
// clients), audit, mastery repair, completion and the runner are replaced.

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  writeAuditEvent: vi.fn(),
  applyAssessmentMasteryProjectionRepair: vi.fn(),
  reconcileAssessmentCorrectionCompletion: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ pool: { connect: mocks.connect, query: mocks.query } }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));
vi.mock("@/lib/assessment-corrections/mastery-repair", () => ({
  applyAssessmentMasteryProjectionRepair: mocks.applyAssessmentMasteryProjectionRepair,
}));
vi.mock("@/lib/assessment-corrections/completion", () => ({
  reconcileAssessmentCorrectionCompletion: mocks.reconcileAssessmentCorrectionCompletion,
}));

import { buildEquivalentExamForm } from "@/app/api/exams/_lib/blueprint";
import type { ReplacementEvidence } from "@/lib/assessment-corrections/contracts";
import { createAssessmentCorrection } from "@/lib/assessment-corrections/admin-service";
import {
  AssessmentCorrectionError,
  applyPriorCorrections,
  buildImpactHashes,
  correctionTarget,
  formMatchesTarget,
  replaceFormEvidence,
  targetItemIdInForm,
  type AppliedCorrection,
  type ImpactSnapshot,
} from "@/lib/assessment-corrections/domain";
import type { RegradeExecutionInput } from "@/lib/assessment-corrections/runner-executor";
import { processOneAssessmentRegrade } from "@/lib/assessment-corrections/worker";

const DIGEST = `sha256:${"a".repeat(64)}`;

function normalize(sql: string) {
  return sql.replace(/\s+/gu, " ").trim().toLowerCase();
}

function result(rows: Record<string, unknown>[] = [], rowCount = rows.length) {
  return { rows, rowCount };
}

function client(handler: (sql: string, values: readonly unknown[]) => { rows: Record<string, unknown>[]; rowCount: number }) {
  return {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => handler(normalize(sql), values)),
    release: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Real generated forms for N04.
let course: CourseManifest;
let stateModule: CourseModule;
let variablesBank: AssessmentBank;
let codeItem: DeterministicAssessmentItem;

beforeAll(async () => {
  const repository = new ContentRepository({ contentRoot: path.resolve(process.cwd(), "content") });
  course = (await repository.getCourse("programming-foundations"))!;
  stateModule = (await repository.getModule("pf.state"))!;
  variablesBank = (await repository.listAssessmentBanks({ skillId: "pf.state.variables" }))[0]!;
  codeItem = variablesBank.items.find((item) => item.kind === "code")!;
});

function approvedBank(items: readonly DeterministicAssessmentItem[]): AssessmentBank {
  return {
    ...variablesBank,
    publication: {
      ...variablesBank.publication,
      stage: "approved",
      reviewer: {
        id: "test-human-reviewer", displayName: "Test Human Reviewer", kind: "human",
        reviewedAt: "2026-07-12T06:00:00.000Z", reviewVersion: variablesBank.schemaVersion,
      },
    },
    items: items.map((item) => ({
      ...item,
      examEligibility: { eligible: true, rationale: "Human-reviewed deterministic fixture approved for exams." },
    })) as readonly DeterministicAssessmentItem[],
  };
}

function generatedForm(seed: string, item: DeterministicAssessmentItem = codeItem): ExamFormSnapshot {
  return buildEquivalentExamForm({
    course,
    module: { ...stateModule, skills: stateModule.skills.filter((skill) => skill.id === "pf.state.variables") },
    catalogVersion: "published:v1",
    seed,
    assessmentBanks: [approvedBank([item])],
  });
}

function replacementFor(bundleVersion: string, expected = "fixed\n"): ReplacementEvidence {
  return {
    kind: "runner-tests",
    bundleVersion,
    runtimeImageDigest: DIGEST,
    tests: [
      { id: "visible-fixed", visibility: "VISIBLE", category: "functional", stdin: "", expectedStdout: expected, comparison: "EXACT", critical: true },
      { id: "hidden-fixed", visibility: "HIDDEN", category: "edge", stdin: "", expectedStdout: expected, comparison: "EXACT", critical: true },
    ],
  };
}

describe("N04: a shared faulty bank item is corrected in every learner's form", () => {
  it("matches two forms whose randomized question IDs differ", () => {
    const appellant = generatedForm("seed-appellant");
    const other = generatedForm("seed-other-learner");
    expect(appellant.items[0]!.id).not.toBe(other.items[0]!.id);

    const target = correctionTarget(appellant, appellant.items[0]!.id);
    expect(formMatchesTarget(appellant, target)).toBe(true);
    expect(formMatchesTarget(other, target)).toBe(true);
    expect(targetItemIdInForm(other, target)).toBe(other.items[0]!.id);

    const corrected = replaceFormEvidence(other, target, replacementFor("reviewed-v2"));
    expect(corrected.items[0]!.id).toBe(other.items[0]!.id);
    expect(corrected.items[0]!.gradingEvidence).toMatchObject({ bundleVersion: "reviewed-v2" });
    // The immutable base form is not rewritten.
    expect(other.items[0]!.gradingEvidence).not.toMatchObject({ bundleVersion: "reviewed-v2" });
  });

  it("excludes a different authored item even with an identical oracle", () => {
    const appellant = generatedForm("seed-appellant");
    const different = generatedForm("seed-other", { ...codeItem, prompt: `${codeItem.prompt} (different item)` } as DeterministicAssessmentItem);
    expect(formMatchesTarget(different, correctionTarget(appellant, appellant.items[0]!.id))).toBe(false);
  });

  it("excludes the same authored item graded by a different oracle", () => {
    const appellant = generatedForm("seed-appellant");
    const otherOracle = generatedForm("seed-other", {
      ...codeItem,
      tests: codeItem.kind === "code" ? codeItem.tests.map((test, index) =>
        index === 0 ? { ...test, expectedStdout: `${test.expectedStdout}x` } : test) : [],
    } as DeterministicAssessmentItem);
    expect(formMatchesTarget(otherOracle, correctionTarget(appellant, appellant.items[0]!.id))).toBe(false);
  });

  it("refuses an ambiguous form that contains the authored item twice", () => {
    const appellant = generatedForm("seed-appellant");
    const target = correctionTarget(appellant, appellant.items[0]!.id);
    const doubled: ExamFormSnapshot = {
      ...appellant,
      items: [appellant.items[0]!, { ...appellant.items[0]!, id: "q02-duplicate" }],
    };
    expect(targetItemIdInForm(doubled, target)).toBeNull();
    expect(() => replaceFormEvidence(doubled, target, replacementFor("reviewed-v2")))
      .toThrow(AssessmentCorrectionError);
  });
});

// ---------------------------------------------------------------------------
// Hand-built two-question form for N08 composition.
function codeQuestion(id: string, skillId: string, faultyExpected: string): ExamItem {
  return {
    id, skillId, clusterId: skillId, title: `Question ${id}`, prompt: `Print the ${skillId} answer.`,
    kind: "code", points: 50, critical: true, language: "python",
    runtime: { version: "Python 3.14", imageDigest: DIGEST },
    gradingEvidence: {
      kind: "runner-tests",
      bundleVersion: `faulty:${id}`,
      tests: [
        { id: `${id}-visible`, visibility: "VISIBLE", category: "functional", stdin: "", expectedStdout: faultyExpected, comparison: "EXACT", critical: true },
        { id: `${id}-hidden`, visibility: "HIDDEN", category: "edge", stdin: "", expectedStdout: faultyExpected, comparison: "EXACT", critical: true },
      ],
    },
  } as ExamItem;
}

const twoQuestionForm: ExamFormSnapshot = {
  schemaVersion: 1, purpose: "formal-exam", formId: "form-n08", seed: "seed-n08",
  courseId: "python", courseTitle: "Python", moduleId: "python.loops", moduleTitle: "Loops",
  contentVersion: "published:v1:1", policyVersion: "formal-exam-v1", durationMinutes: 20,
  generatedAt: "2026-07-12T00:00:00.000Z", instructions: ["Closed book"],
  integrityDisclosure: { version: "1", summary: "Events recorded", capturedEvents: [], notCaptured: [] },
  items: [codeQuestion("q01-alpha", "loops.for", "wrong-a\n"), codeQuestion("q02-beta", "loops.while", "wrong-b\n")],
} as unknown as ExamFormSnapshot;

const correctionA: AppliedCorrection = {
  correctionId: "c0000000-0000-4000-8000-00000000000a",
  outcomeId: "d0000000-0000-4000-8000-00000000000a",
  itemId: "q01-alpha",
  faultyEvidenceHash: hashAppealEvidence(twoQuestionForm.items[0]!.gradingEvidence),
  replacement: replacementFor("reviewed-a"),
};

describe("N08: corrections compose instead of reverting each other (domain)", () => {
  it("re-applies an earlier correction to another question", () => {
    const prepared = applyPriorCorrections(twoQuestionForm, [correctionA], "q02-beta");
    expect(prepared.items[0]!.gradingEvidence).toMatchObject({ bundleVersion: "reviewed-a" });
    expect(prepared.items[1]!.gradingEvidence).toMatchObject({ bundleVersion: "faulty:q02-beta" });
    expect(twoQuestionForm.items[0]!.gradingEvidence).toMatchObject({ bundleVersion: "faulty:q01-alpha" });
  });

  it("lets a later correction of the same question supersede the earlier one", () => {
    const prepared = applyPriorCorrections(twoQuestionForm, [correctionA], "q01-alpha");
    expect(prepared.items[0]!.gradingEvidence).toMatchObject({ bundleVersion: "faulty:q01-alpha" });
  });

  it("fails closed when a chain link no longer matches the base form", () => {
    expect(() => applyPriorCorrections(twoQuestionForm, [{ ...correctionA, faultyEvidenceHash: "f".repeat(64) }], "q02-beta"))
      .toThrow(AssessmentCorrectionError);
    expect(() => applyPriorCorrections(twoQuestionForm, [{ ...correctionA, itemId: "q99-missing" }], "q02-beta"))
      .toThrow(AssessmentCorrectionError);
  });
});

// ---------------------------------------------------------------------------
// Worker end-to-end for N08: correction B runs after A finished.
const learnerAnswers = {
  "q01-alpha": { revision: 1, answer: { sourceCode: "print('fixed')\n", language: "python" } },
  "q02-beta": { revision: 1, answer: { sourceCode: "print('fixed')\n", language: "python" } },
} as const;

const afterA: ExamResult = {
  schemaVersion: 1, gradingStatus: "graded", outcome: "NOT_PASSED", officialScorePercent: 50,
  earnedPoints: 50, possiblePoints: 100, pendingReviewItemIds: [], failedCriticalClusters: ["loops.while"],
  masteryBlockingCodingItems: ["q02-beta"], compilationGatePassed: true, infrastructureFailure: false,
  finalizedAt: "2026-07-12T00:10:00.000Z", finalizedBy: "learner-submit", policyVersion: "formal-exam-v1",
  remediation: { required: true, targets: ["loops.while"] },
} as unknown as ExamResult;

// The learner's code prints "fixed": only reviewed oracles accept it.
const executor = {
  execute: vi.fn(async (input: RegradeExecutionInput): Promise<ExamRunnerResult> => {
    const passes = input.evidence.bundleVersion.startsWith("reviewed");
    return {
      status: passes ? "ACCEPTED" : "WRONG_ANSWER",
      requestHash: "c".repeat(64), sourceHash: "d".repeat(64),
      runtimeVersion: input.expectedRuntimeVersion, imageDigest: input.expectedRuntimeImageDigest,
      compile: { status: "OK", exitCode: 0, stdout: "", stderr: "", wallTimeMs: 1 },
      tests: input.evidence.tests.map((test) => ({
        id: test.id, visibility: test.visibility, category: test.category,
        status: passes ? "PASSED" : "FAILED", feedbackCode: passes ? "OK" : "WRONG_OUTPUT",
        exitCode: 0, wallTimeMs: 1,
      })),
      totals: { passed: passes ? input.evidence.tests.length : 0, failed: passes ? 0 : input.evidence.tests.length, total: input.evidence.tests.length },
      startedAt: "2026-07-13T00:00:00.000Z", finishedAt: "2026-07-13T00:00:01.000Z",
    } as ExamRunnerResult;
  }),
};

function regradeRun(snapshot: ImpactSnapshot) {
  const hashes = buildImpactHashes(snapshot);
  const replacementB = replacementFor("reviewed-b");
  const claimRow = {
    id: "e0000000-0000-4000-8000-000000000001",
    correction_id: "c0000000-0000-4000-8000-00000000000b",
    impact_id: "f0000000-0000-4000-8000-000000000001",
    attempt_count: 0, runner_request_generation: 1,
    attempt_id: "a0000000-0000-4000-8000-000000000001", user_id: "learner-n08", exam_session_id: null,
    snapshot, snapshot_hash: hashes.snapshotHash, form_hash: hashes.formHash,
    answer_set_hash: hashes.answerSetHash, original_result_hash: hashes.originalResultHash,
    replacement_evidence: replacementB,
    faulty_bundle_version: "faulty:q02-beta",
    faulty_evidence_hash: hashAppealEvidence(twoQuestionForm.items[1]!.gradingEvidence),
    course_id: "python", module_id: "python.loops", item_id: "q02-beta", skill_id: "loops.while",
    content_version: twoQuestionForm.contentVersion, created_by: "admin-1", source_appeal_id: null,
    review_hash: "6".repeat(64),
  };
  const outcomeInserts: unknown[][] = [];
  // The worker renews its lease through pool.query after each runner item.
  mocks.query.mockResolvedValue(result([{ id: claimRow.id }], 1));
  mocks.connect
    .mockResolvedValueOnce(client((sql) => {
      if (sql.includes("join assessment_correction_impact")) return result([claimRow], 1);
      if (sql.includes("from assessment_regrade_job j") && sql.includes("j.status = 'running'")) return result([], 0);
      return result([], 1);
    }))
    .mockResolvedValueOnce(client((sql, values) => {
      if (sql.includes('from "user"')) return result([{ status: "active", name: "Ada", email: "ada@example.com" }], 1);
      if (sql.startsWith("select status from assessment_regrade_job")) return result([{ status: "running" }], 1);
      if (sql.includes("from assessment_attempt_effective_result")) {
        return result([{ outcome_id: correctionA.outcomeId, result_hash: hashes.originalResultHash, revision: 1, result: afterA }], 1);
      }
      if (sql.startsWith("select id from assessment_regrade_outcome")) return result([], 0);
      if (sql.startsWith("insert into assessment_regrade_outcome")) {
        outcomeInserts.push([...values]);
        return result([{ id: "90000000-0000-4000-8000-000000000001" }], 1);
      }
      if (sql.startsWith("insert into assessment_mastery_adjustment")) return result([{ id: "91000000-0000-4000-8000-000000000001" }], 1);
      if (sql.startsWith("insert into assessment_mastery_projection_repair")) return result([{ id: "92000000-0000-4000-8000-000000000001" }], 1);
      if (sql.startsWith("insert into email_outbox")) return result([], 0);
      return result([], 1);
    }));
  return { outcomeInserts };
}

describe("N08: a later correction keeps an earlier correction's oracle (worker)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.writeAuditEvent.mockResolvedValue(undefined);
    mocks.applyAssessmentMasteryProjectionRepair.mockResolvedValue(undefined);
    mocks.reconcileAssessmentCorrectionCompletion.mockResolvedValue(undefined);
  });

  it("grades correction B on top of finished correction A", async () => {
    const snapshot: ImpactSnapshot = {
      schemaVersion: 1,
      attempt: {
        id: "a0000000-0000-4000-8000-000000000001", userId: "learner-n08", status: "graded",
        policyVersion: "formal-exam-v1", contentVersion: twoQuestionForm.contentVersion,
        score: 50, passed: false, masteryAwarded: false,
      },
      examSessionId: null,
      form: twoQuestionForm,
      answers: learnerAnswers,
      originalResult: afterA,
      targetItemId: "q02-beta",
      appliedCorrections: [correctionA],
    };
    const { outcomeInserts } = regradeRun(snapshot);
    const outcome = await processOneAssessmentRegrade({
      workerId: "worker-n08", executor, now: new Date("2026-07-13T00:00:00.000Z"),
      clock: () => new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(outcome).toMatchObject({ processed: true, succeeded: true });
    const corrected = JSON.parse(String(outcomeInserts[0]![8])) as ExamResult;
    expect(corrected.officialScorePercent).toBe(100);
    const bundles = executor.execute.mock.calls.map(([input]) => [input.itemId, input.evidence.bundleVersion]);
    expect(bundles).toEqual([["q01-alpha", "reviewed-a"], ["q02-beta", "reviewed-b"]]);
    // The immutable base snapshot still carries both original faulty oracles.
    expect(snapshot.form.items.map((item) => (item.gradingEvidence as { bundleVersion: string }).bundleVersion))
      .toEqual(["faulty:q01-alpha", "faulty:q02-beta"]);
  });
});

// ---------------------------------------------------------------------------
// Correction creation: N04 cross-form capture, N05 rechecks, N08 chain capture.
describe("correction creation captures every affected official attempt", () => {
  const actor = "admin-1";
  const appealId = "11000000-0000-4000-8000-000000000001";
  const sourceAttempt = "12000000-0000-4000-8000-000000000001";
  const otherAttempt = "12000000-0000-4000-8000-000000000002";
  const graded: ExamResult = { ...afterA, officialScorePercent: 0, earnedPoints: 0 } as ExamResult;

  function creation(options: {
    readonly candidates: Record<string, unknown>[];
    readonly chain?: Record<string, unknown>[];
  }) {
    const sourceForm = generatedForm("seed-appellant");
    const inserts: unknown[][] = [];
    let candidateSql = "";
    let scopeLock = "";
    mocks.connect.mockResolvedValueOnce(client((sql, values) => {
      if (sql.startsWith('select role, status from "user"')) return result([{ role: "admin", status: "active" }], 1);
      if (sql.startsWith("select c.id, e.evidence")) return result([], 0);
      if (sql.startsWith("select id, attempt_id, decision, status from appeal")) {
        return result([{ id: appealId, attempt_id: sourceAttempt, decision: "overturned", status: "resolved" }], 1);
      }
      if (sql.startsWith("select answer from response")) return result([{ answer: { snapshot: sourceForm } }], 1);
      if (sql.startsWith("select pg_advisory_xact_lock") && String(values[0]).startsWith("assessment-correction-scope:")) {
        scopeLock = String(values[0]);
      }
      if (sql.startsWith("select id from assessment_correction")) return result([], 0);
      if (sql.startsWith("insert into assessment_correction (")) return result([{ id: "13000000-0000-4000-8000-000000000001" }], 1);
      if (sql.includes("from response blueprint")) {
        candidateSql = sql;
        return result(options.candidates.map((candidate) => ({ ...candidate })));
      }
      if (sql.startsWith("with recursive chain")) return result(options.chain ?? []);
      if (sql.startsWith("select distinct on (item_key)")) return result([]);
      if (sql.startsWith("insert into assessment_correction_impact")) {
        inserts.push([...values]);
        return result([], 1);
      }
      if (sql.startsWith("select id, source_appeal_id")) {
        return result([{
          id: "13000000-0000-4000-8000-000000000001", source_appeal_id: appealId, status: "reviewed",
          course_id: sourceForm.courseId, module_id: sourceForm.moduleId, item_id: sourceForm.items[0]!.id,
          skill_id: sourceForm.items[0]!.skillId, content_version: sourceForm.contentVersion,
          faulty_bundle_version: "x", faulty_evidence_hash: "y", replacement_bundle_version: "reviewed-v2",
          replacement_evidence_hash: "z", review_hash: "r", affected_count: inserts.length, row_version: 1,
          created_at: new Date(), started_at: null, completed_at: null,
        }], 1);
      }
      return result([], 1);
    }));
    const input = {
      actorUserId: actor,
      requestId: "14000000-0000-4000-8000-000000000001",
      appealId,
      itemId: sourceForm.items[0]!.id,
      defectKind: "faulty_test" as const,
      reason: "The hidden test expected the wrong output for this reviewed item.",
      replacementEvidence: replacementFor("reviewed-v2"),
      review: {
        reviewerKind: "human" as const, specificationClarified: true as const, expectedOutputsReviewed: true as const,
        hiddenTestCoverageReviewed: true as const, pinnedRuntimeReviewed: true as const,
        evidenceRef: "review-ticket-1234", note: "Reviewed the specification and replacement tests.",
      },
      now: new Date("2026-07-13T00:00:00.000Z"),
    };
    return { sourceForm, inserts, input, sql: () => candidateSql, scopeLock: () => scopeLock };
  }

  function candidate(attemptId: string, form: ExamFormSnapshot, effective: ExamResult | null = null) {
    return {
      attempt_id: attemptId, user_id: `user-${attemptId.slice(-1)}`, attempt_status: "graded",
      policy_version: "formal-exam-v1", content_version: form.contentVersion, score: 0, passed: false,
      mastery_awarded: false, exam_session_id: `session-${attemptId.slice(-1)}`,
      blueprint: { snapshot: form }, original_result: graded, effective_result: effective,
    };
  }

  beforeEach(() => mocks.connect.mockReset());

  it("N04: impacts the other learner's form under its own question ID", async () => {
    const other = generatedForm("seed-other-learner");
    const appellantForm = generatedForm("seed-appellant");
    const fresh = creation({
      candidates: [candidate(sourceAttempt, appellantForm), candidate(otherAttempt, other)],
    });
    await expect(createAssessmentCorrection(fresh.input)).resolves.toMatchObject({ affectedCount: 2 });
    const snapshots = fresh.inserts.map((values) => JSON.parse(String(values[8])) as ImpactSnapshot);
    expect(snapshots.map((snapshot) => snapshot.targetItemId)).toEqual([
      fresh.sourceForm.items[0]!.id,
      other.items[0]!.id,
    ]);
    // The defect scope lock no longer depends on the appellant's random ID.
    expect(fresh.scopeLock()).not.toContain(fresh.sourceForm.items[0]!.id);
  });

  it("N05: official mastery rechecks are candidates; practice mastery checks are not", async () => {
    const fresh = creation({ candidates: [] });
    await expect(createAssessmentCorrection(fresh.input)).rejects.toMatchObject({ code: "NO_AFFECTED_ATTEMPTS" });
    expect(fresh.sql()).toContain("a.kind = 'mastery_check' and es.id is not null");
    expect(fresh.sql()).toContain("a.kind in ('exam', 'retake')");
  });

  it("N08: captures the effective correction chain with the impact", async () => {
    const withEffective = creation({
      candidates: [candidate(sourceAttempt, generatedForm("seed-appellant"), afterA)],
      chain: [{
        outcome_id: correctionA.outcomeId, correction_id: correctionA.correctionId,
        item_id: "q-source-id", local_item_id: "q-local-id",
        faulty_evidence_hash: "e".repeat(64), replacement_evidence: replacementFor("reviewed-a"),
      }],
    });
    await expect(createAssessmentCorrection(withEffective.input)).resolves.toMatchObject({ affectedCount: 1 });
    const snapshot = JSON.parse(String(withEffective.inserts[0]![8])) as ImpactSnapshot;
    expect(snapshot.originalResult).toMatchObject({ officialScorePercent: 50 });
    expect(snapshot.appliedCorrections).toEqual([{
      correctionId: correctionA.correctionId,
      outcomeId: correctionA.outcomeId,
      itemId: "q-local-id",
      faultyEvidenceHash: "e".repeat(64),
      replacement: replacementFor("reviewed-a"),
    }]);
  });
});
