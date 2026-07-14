import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  queueProjectReviewCorrectionWithClient: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  pool: { connect: mocks.connect, query: mocks.query },
}));

vi.mock("@/lib/projects/review-correction-service", () => ({
  queueProjectReviewCorrectionWithClient: mocks.queueProjectReviewCorrectionWithClient,
}));

import {
  AppealAdminError,
  decideAppeal,
  getAppealSubject,
  getAdminAppealDetail,
  listAdminAppeals,
} from "../admin-service";
import { hashAppealEvidence } from "../evidence";

const appealId = "10000000-0000-4000-8000-000000000001";
const actorUserId = "admin-user";
const requestId = "50000000-0000-4000-8000-000000000001";
const now = new Date("2026-07-12T12:00:00.000Z");

const baseCandidate: {
  id: string;
  user_id: string;
  learner_name: string;
  learner_email: string;
  attempt_id: string | null;
  project_review_id: string | null;
  status: string;
  evidence_hash: string;
  row_version: string;
  exam_session_id: string | null;
  attempt_status: string | null;
} = {
  id: appealId,
  user_id: "learner-user",
  learner_name: "Learner",
  learner_email: "learner@example.test",
  attempt_id: "30000000-0000-4000-8000-000000000001",
  project_review_id: null,
  status: "open",
  evidence_hash: "a".repeat(64),
  row_version: "1",
  exam_session_id: "40000000-0000-4000-8000-000000000001",
  attempt_status: "graded",
};

function decisionInput(
  override: Partial<Parameters<typeof decideAppeal>[0]> = {},
): Parameters<typeof decideAppeal>[0] {
  return {
    actorUserId,
    appealId,
    requestId,
    expectedVersion: 1,
    decision: "upheld",
    reason: "The immutable evidence supports the original result.",
    now,
    ...override,
  };
}

function decisionClient(config: {
  actor?: { role: string | null; status: string } | null;
  candidate?: typeof baseCandidate | null;
  prior?: {
    actor_user_id: string | null;
    event: string;
    reason: string;
    evidence: Record<string, unknown>;
    occurred_at: Date;
  } | null;
  updatedRowCount?: number;
  current?: Record<string, unknown> | null;
} = {}) {
  const actor = config.actor === undefined ? { role: "admin", status: "active" } : config.actor;
  const candidate = config.candidate === undefined ? baseCandidate : config.candidate;
  const prior = config.prior ?? null;
  const current = config.current === undefined ? {
    id: appealId,
    user_id: "learner-user",
    decision: "upheld",
    status: "upheld",
    row_version: "2",
    decided_at: now,
    exam_session_id: baseCandidate.exam_session_id,
    project_review_id: null,
    correction_id: null,
    correction_status: null,
    correction_revision: null,
  } : config.current;
  const query = vi.fn(async (...args: [statement: string, parameters?: unknown[]]) => {
    const [statement] = args;
    if (statement === "begin" || statement === "commit" || statement === "rollback") return { rows: [] };
    if (statement.startsWith("select pg_advisory")) return { rows: [] };
    if (statement.includes('select role, status from "user"')) return { rows: actor ? [actor] : [] };
    if (statement.includes("select a.id, a.user_id, u.name")) return { rows: candidate ? [candidate] : [] };
    if (statement.includes("client_request_id = $2")) return { rows: prior ? [prior] : [] };
    if (statement.includes("insert into appeal_event")) return { rows: [], rowCount: 1 };
    if (statement.includes("update appeal")) return { rows: [], rowCount: config.updatedRowCount ?? 1 };
    if (statement.includes("update exam_session")) return { rows: [], rowCount: 1 };
    if (statement.includes("insert into notification")) return { rows: [], rowCount: 1 };
    if (statement.includes("insert into email_outbox")) return { rows: [], rowCount: 1 };
    if (statement.includes("select a.id, a.user_id, a.decision")) return { rows: current ? [current] : [] };
    throw new Error(`Unexpected query: ${statement}`);
  });
  const release = vi.fn();
  mocks.connect.mockResolvedValue({ query, release });
  return { query, release };
}

describe("administrator appeal service", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([0, -1, 201, 1.5, Number.NaN])("rejects an unsafe list limit %s before querying", async (limit) => {
    await expect(listAdminAppeals({ limit })).rejects.toThrow("from 1 to 200");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("lists actionable and all appeals with stable target and date projections", async () => {
    mocks.query.mockResolvedValue({ rows: [
      {
        id: appealId,
        user_id: "learner-user",
        learner_public_id: "20000000-0000-4000-8000-000000000001",
        learner_name: "Learner",
        category: "scoring",
        reason: "Please review this score.",
        status: "open",
        decision: null,
        attempt_id: "30000000-0000-4000-8000-000000000001",
        project_review_id: null,
        exam_session_id: "40000000-0000-4000-8000-000000000001",
        row_version: "2",
        created_at: new Date("2026-07-01T00:00:00.000Z"),
        updated_at: new Date("2026-07-02T00:00:00.000Z"),
        decided_at: null,
      },
      {
        id: "10000000-0000-4000-8000-000000000002",
        user_id: "learner-user",
        learner_public_id: "20000000-0000-4000-8000-000000000001",
        learner_name: "Learner",
        category: "project_review",
        reason: "Please review the project feedback.",
        status: "upheld",
        decision: "upheld",
        attempt_id: null,
        project_review_id: "60000000-0000-4000-8000-000000000001",
        exam_session_id: null,
        row_version: 3,
        created_at: new Date("2026-07-03T00:00:00.000Z"),
        updated_at: new Date("2026-07-04T00:00:00.000Z"),
        decided_at: new Date("2026-07-05T00:00:00.000Z"),
      },
    ] });

    const actionable = await listAdminAppeals();
    expect(actionable.map((entry) => entry.target)).toEqual(["exam_attempt", "project_review"]);
    expect(actionable[0]?.decidedAt).toBeNull();
    expect(actionable[1]?.decidedAt).toBe("2026-07-05T00:00:00.000Z");
    expect(mocks.query).toHaveBeenLastCalledWith(expect.any(String), [true, expect.any(Array), 100]);

    await listAdminAppeals({ scope: "all", limit: 1 });
    expect(mocks.query).toHaveBeenLastCalledWith(expect.any(String), [false, expect.any(Array), 1]);
  });

  it("returns the appeal subject or null without widening the learner join", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: appealId, user_id: "learner-user", status: "open" }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(getAppealSubject(appealId)).resolves.toEqual({
      id: appealId,
      user_id: "learner-user",
      status: "open",
    });
    await expect(getAppealSubject(appealId)).resolves.toBeNull();
  });

  it("removes the seed and hidden grading evidence from administrator detail while verifying the manifest", async () => {
    const evidence = { schemaVersion: 1, targetType: "exam_attempt", answerHash: "a".repeat(64) };
    const form = {
      schemaVersion: 1,
      formId: "form-1",
      seed: "hidden-seed",
      courseId: "python",
      courseTitle: "Python",
      moduleId: "variables",
      moduleTitle: "Variables",
      contentVersion: "v1",
      policyVersion: "p1",
      durationMinutes: 10,
      generatedAt: "2026-07-12T00:00:00.000Z",
      instructions: [],
      integrityDisclosure: { version: "1", summary: "", capturedEvents: [], notCaptured: [] },
      items: [{
        id: "item-1", skillId: "s", clusterId: "c", title: "Question", prompt: "Prompt",
        kind: "short-answer", points: 1, critical: true,
        gradingEvidence: { kind: "exact-answer", acceptedAnswers: ["hidden-answer"], caseSensitive: false },
      }],
    };
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("select a.id, a.user_id, u.public_id")) {
        return { rows: [{
          id: appealId,
          user_id: "learner-user",
          learner_public_id: "20000000-0000-4000-8000-000000000001",
          learner_name: "Learner",
          learner_email: "learner@example.test",
          category: "scoring",
          reason: "The deterministic score looks incorrect.",
          evidence,
          evidence_hash: hashAppealEvidence(evidence),
          status: "open",
          decision: null,
          decision_reason: null,
          row_version: "1",
          created_at: new Date("2026-07-12T00:00:00.000Z"),
          updated_at: new Date("2026-07-12T00:00:00.000Z"),
          decided_at: null,
          attempt_id: "30000000-0000-4000-8000-000000000001",
          attempt_kind: "exam",
          attempt_status: "graded",
          attempt_score: 50,
          attempt_passed: false,
          policy_version: "p1",
          content_version: "v1",
          exam_session_id: "40000000-0000-4000-8000-000000000001",
          exam_status: "under_review",
          integrity_review_state: "appeal_pending",
        }] };
      }
      if (statement.includes("from appeal_event")) return { rows: [] };
      if (statement.includes("from response")) {
        return { rows: [{
          item_key: "__exam_blueprint_v1__",
          revision: 1,
          answer: { snapshot: form },
          source: "server",
          saved_at: new Date("2026-07-12T00:00:00.000Z"),
          submitted_at: null,
        }] };
      }
      if (statement.includes("from code_submission")) return { rows: [] };
      if (statement.includes("from exam_event")) return { rows: [] };
      throw new Error(`Unexpected query: ${statement}`);
    });

    const detail = await getAdminAppealDetail(appealId);
    expect(detail.appeal.evidenceHashValid).toBe(true);
    expect(detail.publicForm).not.toBeNull();
    expect(detail.publicForm).not.toHaveProperty("seed");
    expect(detail.publicForm?.items[0]).not.toHaveProperty("gradingEvidence");
    expect(JSON.stringify(detail.publicForm)).not.toContain("hidden-answer");
  });

  it("rejects a missing detail and projects a project-only correction without exam queries", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(getAdminAppealDetail(appealId)).rejects.toEqual(
      expect.objectContaining({ code: "APPEAL_NOT_FOUND" }),
    );

    const correctionEvidence = { schemaVersion: 1, targetType: "project_review" };
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("select a.id, a.user_id, u.public_id")) {
        return { rows: [{
          id: appealId,
          user_id: "learner-user",
          learner_public_id: "20000000-0000-4000-8000-000000000001",
          learner_name: "Learner",
          learner_email: "learner@example.test",
          category: "project_review",
          reason: "The static review missed evidence.",
          evidence: correctionEvidence,
          evidence_hash: "not-the-evidence-hash",
          status: "overturned",
          decision: "overturned",
          decision_reason: "The immutable commit supports a corrected review.",
          row_version: 2,
          created_at: new Date("2026-07-01T00:00:00.000Z"),
          updated_at: new Date("2026-07-02T00:00:00.000Z"),
          decided_at: new Date("2026-07-02T00:00:00.000Z"),
          attempt_id: null,
          attempt_kind: null,
          attempt_status: null,
          attempt_score: null,
          attempt_passed: null,
          policy_version: null,
          content_version: null,
          exam_session_id: null,
          exam_status: null,
          integrity_review_state: null,
          project_review_id: "60000000-0000-4000-8000-000000000001",
          project_id: "70000000-0000-4000-8000-000000000001",
          project_title: "Portfolio",
          review_commit_sha: "abc123",
          review_analyzer_version: "1",
          review_rubric_version: "1",
          review_provenance: {},
          review_findings_hash: "b".repeat(64),
          review_status: "appealed",
          correction_id: "80000000-0000-4000-8000-000000000001",
          correction_status: "succeeded",
          correction_revision: "2",
          correction_reason: "Re-run the immutable source commit.",
          correction_source_findings_hash: "b".repeat(64),
          correction_result_findings_hash: "c".repeat(64),
          correction_evidence: correctionEvidence,
          correction_evidence_hash: hashAppealEvidence(correctionEvidence),
          correction_projection_applied: true,
          correction_attempt_count: null,
          correction_last_error_code: null,
          correction_completed_at: new Date("2026-07-02T00:00:00.000Z"),
        }] };
      }
      if (statement.includes("from appeal_event")) return { rows: [] };
      if (statement.includes("from project_review_correction_event")) {
        return { rows: [{
          id: "90000000-0000-4000-8000-000000000001",
          actor_role: "system",
          event: "succeeded",
          reason: "Deterministic correction completed.",
          evidence: correctionEvidence,
          evidence_hash: "invalid-event-hash",
          occurred_at: new Date("2026-07-02T00:00:00.000Z"),
        }] };
      }
      throw new Error(`Unexpected project detail query: ${statement}`);
    });

    const detail = await getAdminAppealDetail(appealId);
    expect(detail.appeal.evidenceHashValid).toBe(false);
    expect(detail.publicForm).toBeNull();
    expect(detail.originalResult).toBeNull();
    expect(detail.projectCorrection).toMatchObject({
      status: "succeeded",
      revision: 2,
      evidenceHashValid: true,
      attemptCount: 0,
    });
    expect(detail.projectCorrection?.timeline[0]?.evidenceHashValid).toBe(false);
    expect(mocks.query.mock.calls.some(([statement]) => String(statement).includes("from response"))).toBe(false);
    expect(mocks.query.mock.calls.some(([statement]) => String(statement).includes("from exam_event"))).toBe(false);
  });

  it.each([
    [{ requestId: "not-a-uuid" }, "requestId must be a UUID"],
    [{ expectedVersion: 0 }, "expectedVersion must be a positive integer"],
    [{ reason: "too short" }, "decision reason"],
    [{ now: new Date("invalid") }, "valid decision timestamp"],
    [{ correctiveAction: "x".repeat(2001) }, "Corrective action"],
  ])("validates decision input before opening a transaction", async (override, expected) => {
    await expect(decideAppeal(decisionInput(override))).rejects.toThrow(expected);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("requires a corrective instruction before an overturn", async () => {
    await expect(decideAppeal({
      actorUserId,
      appealId,
      requestId: "50000000-0000-4000-8000-000000000001",
      expectedVersion: 1,
      decision: "overturned",
      reason: "The original result does not match the immutable evidence.",
    })).rejects.toEqual(expect.objectContaining({ code: "CORRECTIVE_ACTION_REQUIRED" }));
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["missing appeal", { candidate: null }, "APPEAL_NOT_FOUND"],
    ["terminal appeal", { candidate: { ...baseCandidate, status: "upheld" } }, "ALREADY_DECIDED"],
    ["stale expected version", { candidate: { ...baseCandidate, row_version: "2" } }, "VERSION_CONFLICT"],
    ["lost compare-and-swap", { updatedRowCount: 0 }, "WRITE_CONFLICT"],
    ["missing committed report", { current: null }, "WRITE_CONFLICT"],
  ])("rolls back a %s conflict", async (_label, config, code) => {
    const { query, release } = decisionClient(config);
    await expect(decideAppeal(decisionInput())).rejects.toEqual(expect.objectContaining({ code }));
    expect(query).toHaveBeenCalledWith("rollback");
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    [{ actor_user_id: "different-admin" }, "actor"],
    [{ event: "overturned" }, "decision"],
    [{ reason: "A different immutable-evidence decision reason." }, "reason"],
    [{ evidence: { correctiveAction: "A different corrective instruction with sufficient detail." } }, "evidence"],
  ])("rejects an idempotency replay with changed %s", async (override, label) => {
    void label;
    const prior = {
      actor_user_id: actorUserId,
      event: "upheld",
      reason: decisionInput().reason,
      evidence: {},
      occurred_at: now,
      ...override,
    };
    const { query } = decisionClient({ prior });
    await expect(decideAppeal(decisionInput())).rejects.toEqual(
      expect.objectContaining({ code: "IDEMPOTENCY_MISMATCH" }),
    );
    expect(query).toHaveBeenCalledWith("rollback");
  });

  it("replays an identical decision without duplicating learner side effects", async () => {
    const prior = {
      actor_user_id: actorUserId,
      event: "upheld",
      reason: decisionInput().reason,
      evidence: {},
      occurred_at: now,
    };
    const { query } = decisionClient({ prior });
    const report = await decideAppeal(decisionInput());
    expect(report.replayed).toBe(true);
    expect(query).toHaveBeenCalledWith("commit");
    expect(query.mock.calls.some(([statement]) => String(statement).includes("insert into notification"))).toBe(false);
  });

  it("commits an upheld exam appeal and restores a deterministically graded session", async () => {
    const { query, release } = decisionClient();
    const report = await decideAppeal(decisionInput());
    expect(report).toMatchObject({
      decision: "upheld",
      correctionPending: false,
      replayed: false,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("update exam_session"),
      [baseCandidate.exam_session_id, "graded", "appeal_upheld", now],
    );
    expect(query).toHaveBeenCalledWith("commit");
    expect(release).toHaveBeenCalledOnce();
  });

  it("commits a learner-input request while keeping manual grading under review", async () => {
    const candidate = { ...baseCandidate, attempt_status: "manual_review" };
    const current = {
      id: appealId,
      user_id: "learner-user",
      decision: "needs_learner_input",
      status: "needs_learner_input",
      row_version: 2,
      decided_at: now,
      exam_session_id: candidate.exam_session_id,
      project_review_id: null,
      correction_id: null,
      correction_status: null,
      correction_revision: null,
    };
    const { query } = decisionClient({ candidate, current });
    const report = await decideAppeal(decisionInput({ decision: "needs_learner_input" }));
    expect(report.decision).toBe("needs_learner_input");
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("update exam_session"),
      [candidate.exam_session_id, "under_review", "appeal_needs_learner_input", now],
    );
    expect(query.mock.calls.find(([statement]) => String(statement).includes("insert into notification"))?.[1]).toEqual([
      "learner-user",
      "Your appeal needs more information",
      expect.stringContaining("asked for more information"),
      `/exams/${candidate.exam_session_id}`,
      now,
    ]);
  });

  it("queues an exact-commit correction for an overturned project-review appeal", async () => {
    const projectReviewId = "60000000-0000-4000-8000-000000000001";
    const candidate = {
      ...baseCandidate,
      attempt_id: null,
      attempt_status: null,
      exam_session_id: null,
      project_review_id: projectReviewId,
    };
    const current = {
      id: appealId,
      user_id: "learner-user",
      decision: "overturned",
      status: "overturned",
      row_version: "2",
      decided_at: now,
      exam_session_id: null,
      project_review_id: projectReviewId,
      correction_id: "80000000-0000-4000-8000-000000000001",
      correction_status: "queued",
      correction_revision: "1",
    };
    decisionClient({ candidate, current });
    const correctiveAction = "Re-run the deterministic static review on the preserved commit.";
    const report = await decideAppeal(decisionInput({
      decision: "overturned",
      correctiveAction,
    }));
    expect(report).toMatchObject({
      decision: "overturned",
      correctionPending: true,
      projectReviewCorrectionRevision: 1,
    });
    expect(mocks.queueProjectReviewCorrectionWithClient).toHaveBeenCalledWith(expect.anything(), {
      actorUserId,
      sourceReviewId: projectReviewId,
      sourceAppealId: appealId,
      requestId,
      reason: correctiveAction,
      now,
    });
  });

  it("independently rejects an inactive or non-administrator actor and rolls back", async () => {
    const query = vi.fn(async (statement: string) => {
      if (statement === "begin" || statement.startsWith("select pg_advisory") || statement === "rollback") return { rows: [] };
      if (statement.includes('from "user"')) return { rows: [{ role: "learner", status: "active" }] };
      throw new Error(`Unexpected query: ${statement}`);
    });
    const release = vi.fn();
    mocks.connect.mockResolvedValue({ query, release });
    await expect(decideAppeal({
      actorUserId,
      appealId,
      requestId: "50000000-0000-4000-8000-000000000001",
      expectedVersion: 1,
      decision: "upheld",
      reason: "The immutable evidence supports the original result.",
    })).rejects.toBeInstanceOf(AppealAdminError);
    expect(query).toHaveBeenCalledWith("rollback");
    expect(release).toHaveBeenCalledOnce();
  });
});
