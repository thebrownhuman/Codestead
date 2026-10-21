import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentRepository, type CourseManifest } from "@/lib/content";
import { getTableName } from "drizzle-orm";
import { listExamCatalog, startExam } from "@/app/api/exams/_lib/service";
import { BLUEPRINT_RESPONSE_KEY } from "@/app/api/exams/_lib/contracts";
import type { CurriculumReleaseEvidence } from "@/lib/curriculum-publication/contracts";
import {
  approveCurriculumArtifactsAsOwner,
  publishCurriculumVersion,
  submitCurriculumReleaseEvidence,
} from "@/lib/curriculum-publication/admin-service";
import { hashCurriculumValue } from "@/lib/curriculum-publication/hash";
import { stageFilesystemCurriculum } from "@/lib/curriculum-publication/staging";

const mocks = vi.hoisted(() => ({
  query: vi.fn(), connect: vi.fn(), contentRepository: vi.fn(),
  select: vi.fn(), insert: vi.fn(), update: vi.fn(), execute: vi.fn(), transaction: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  pool: { query: mocks.query, connect: mocks.connect },
  db: { select: mocks.select, insert: mocks.insert, update: mocks.update, execute: mocks.execute, transaction: mocks.transaction },
}));
vi.mock("@/lib/content", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/content")>(),
  createContentRepository: mocks.contentRepository,
}));

import {
  listPublishedExamCourses,
  loadPublishedExamModule,
} from "@/lib/curriculum-publication/runtime";

function pointerRow(overrides: Record<string, unknown> = {}) {
  return {
    pointer_course_id: "10000000-0000-4000-8000-000000000001",
    version_course_id: "10000000-0000-4000-8000-000000000001",
    course_slug: "reviewed-course",
    course_version_id: "20000000-0000-4000-8000-000000000001",
    course_version: "1.0.0",
    course_stage: "beta",
    version_content_hash: "a".repeat(64),
    approved_by: "admin-user",
    published_at: new Date("2026-07-12T07:00:00.000Z"),
    publication_event_exists: true,
    release_evidence_exists: true,
    artifact_key: null,
    artifact_type: null,
    skill_key: null,
    content: null,
    content_hash: null,
    publication_stage: null,
    review_status: null,
    review_event_exists: false,
    ...overrides,
  };
}

type Artifact = {
  id: string; artifact_key: string; artifact_type: string; skill_key: string | null;
  content: Record<string, unknown>; content_hash: string; publication_stage: string;
  review_status: string; row_version: number; ai_assisted: boolean;
};
type Review = {
  artifact_id: string; reviewer_kind: string; decision: string; content_hash: string;
  checklist: Record<string, unknown>; reviewed_item_ids: string[]; resulting_version: number;
};
const courseId = "10000000-0000-4000-8000-000000000001";
const versionId = "20000000-0000-4000-8000-000000000001";
const now = new Date("2026-09-30T12:00:00Z");
const reason = "Human-reviewed publication for the runtime regression fixture.";

// Real staging, supported owner approval, release submission, gate and publish
// services; only persistence and filesystem repository selection are mocked.
async function stagedPublication(stage: "beta" | "verified" = "beta") {
  const repository = new ContentRepository();
  const original = (await repository.getCourse("programming-foundations"))!;
  const courseModule = original.modules.find((module) => module.id === "pf.computing")!;
  const skill = courseModule.skills.find((entry) => entry.id === "pf.computing.program")!;
  const course: CourseManifest = {
    ...original, status: stage, modules: [{ ...courseModule, skills: [skill] }],
    coverage_summary: { required_skills: 1, elective_skills: 0, total_skills: 1, covered: 1, partial: 0, planned: 0 },
  };
  const authored = await repository.getAuthoredContentSet();
  const originalBank = authored.assessmentBanks.find((bank) => bank.skillId === skill.id)!;
  const bank = {
    ...originalBank,
    publication: { ...originalBank.publication, stage: "approved", reviewer: {
      id: "test-human", displayName: "Test Human", kind: "human", reviewedAt: now.toISOString(), reviewVersion: "1.0.0",
    } },
    items: originalBank.items.filter((item) => item.kind === "mcq").map((item) => ({
      ...item, examEligibility: { eligible: true, rationale: "Independently reviewed deterministic oracle for the runtime fixture." },
    })),
  };
  const lesson = authored.lessons.find((entry) => entry.skillId === skill.id)!;
  mocks.contentRepository.mockReturnValue({
    getSnapshot: async () => ({ catalog: { tracks: [] }, courses: [course], manifestPaths: {} }),
    getAuthoredContentSet: async () => ({ lessons: [lesson], assessmentBanks: [bank] }),
    listCourses: async () => [],
  });
  const artifacts: Artifact[] = [];
  const reviews: Review[] = [];
  let contentHash = "";
  let currentStage = "draft";
  let publicationRevision = 1;
  let published = false;
  let release: { evidence_version: number; content_hash: string; evidence: CurriculumReleaseEvidence; evidence_hash: string } | null = null;
  const latest = (artifact: Artifact) => reviews.filter((review) => review.artifact_id === artifact.id)
    .sort((a, b) => b.resulting_version - a.resulting_version)[0];
  const runtimeRows = () => artifacts.map((artifact) => ({
    ...pointerRow(), course_slug: course.id, course_version: course.version,
    course_stage: currentStage, version_content_hash: contentHash,
    publication_event_exists: published, release_evidence_exists: release !== null,
    ...artifact,
    // Old runtime EXISTS semantics intentionally include superseded approvals;
    // the latest_review field represents the lateral query required by N01.
    review_event_exists: reviews.some((review) => review.artifact_id === artifact.id && review.decision === "approved" && review.reviewer_kind === "human" && review.content_hash === artifact.content_hash),
    latest_review: latest(artifact) ?? null,
  }));
  const query = vi.fn(async (raw: string, args: unknown[] = []) => {
    const sql = raw.replace(/\s+/g, " ").trim();
    const result = (rows: unknown[] = [], rowCount = rows.length) => ({ rows, rowCount });
    if (/^(begin|commit|rollback)$/.test(sql) || sql.includes("pg_advisory_xact_lock")) return result();
    if (sql.startsWith("select role, status")) return result([{ role: "admin", status: "active" }]);
    if (sql.startsWith("insert into course (")) return result([{ id: courseId }]);
    if (sql.startsWith("select id, title, summary, domain")) return result([{ id: courseId, title: course.title, summary: course.summary, domain: "curriculum" }]);
    if (sql.startsWith("insert into course_version")) { contentHash = String(args[4]); return result([{ id: versionId }]); }
    if (sql.startsWith("insert into curriculum_artifact")) {
      const payload = JSON.parse(String(args[2])) as Artifact[];
      artifacts.push(...payload.map((artifact) => ({ ...artifact, id: randomUUID(), review_status: "unreviewed", row_version: 1 })));
      return result([], payload.length);
    }
    if (sql.startsWith("select artifact_key, content_hash")) return result(artifacts);
    if (sql.startsWith("select a.id, a.artifact_key")) return result(artifacts.map((artifact) => ({ ...artifact, latest_decision: latest(artifact)?.decision ?? null, latest_hash: latest(artifact)?.content_hash ?? null })));
    if (sql.startsWith("insert into curriculum_review_event")) {
      reviews.push({ artifact_id: String(args[0]), reviewer_kind: "human", decision: "approved", content_hash: String(args[3]), checklist: JSON.parse(String(args[4])), reviewed_item_ids: JSON.parse(String(args[5])), resulting_version: Number(args[7]) });
      return result([], 1);
    }
    if (sql.startsWith("update curriculum_artifact")) { const artifact = artifacts.find((entry) => entry.id === args[0])!; artifact.review_status = "approved"; artifact.row_version++; return result([], 1); }
    if (sql.startsWith("select course_id")) return result([{ course_id: courseId, content_hash: contentHash, stage: currentStage, publication_revision: publicationRevision }]);
    if (sql.startsWith("select cre.submitted_by") || sql.startsWith("select actor_user_id") || sql.startsWith("select course_version_id, actor_user_id")) return result();
    if (sql.startsWith("select coalesce(max(evidence_version)")) return result([{ version: 1 }]);
    if (sql.startsWith("insert into curriculum_release_evidence")) { release = { evidence_version: Number(args[3]), content_hash: String(args[4]), evidence: JSON.parse(String(args[5])), evidence_hash: String(args[6]) }; return result([], 1); }
    if (sql.startsWith("update course_version")) { publicationRevision++; if (sql.includes("set stage")) currentStage = String(args[1]); return result([], 1); }
    if (sql.startsWith("insert into curriculum_publication_pointer")) { published = true; return result([], 1); }
    if (sql.startsWith("insert into curriculum_publication_event")) return result([], 1);
    if (sql.startsWith("select id, stage, content_hash")) return result([{ id: versionId, stage: currentStage, content_hash: contentHash }]);
    if (sql.startsWith("select id, artifact_key")) return result(artifacts);
    if (sql.startsWith("select distinct on (artifact_id)")) return result(artifacts.flatMap((artifact) => latest(artifact) ? [latest(artifact)!] : []));
    if (sql.startsWith("select l.slug")) return result([{ slug: skill.id, content_status: stage, block_count: 1 }]);
    if (sql.startsWith("select a.specification")) return result();
    if (sql.startsWith("select evidence_version")) return result(release ? [release] : []);
    if (sql.startsWith("select cpp.course_id")) return result(runtimeRows());
    if (sql.startsWith("select c.slug from curriculum_publication_pointer")) return result(published ? [{ slug: course.id }] : []);
    throw new Error(`Unhandled fixture SQL: ${sql}`);
  });
  mocks.query.mockImplementation(query);
  mocks.connect.mockResolvedValue({ query, release: vi.fn() });
  await stageFilesystemCurriculum({ actorUserId: "admin-user", requestId: randomUUID(), reason, now });
  const immutable = artifacts.map(({ content, content_hash, publication_stage }) => structuredClone({ content, content_hash, publication_stage }));
  await approveCurriculumArtifactsAsOwner({ actorUserId: "admin-user", courseVersionId: versionId, requestId: randomUUID(), reason, now });
  const passed = { passed: true as const, reportHash: "a".repeat(64) };
  const scoped = { status: "not_applicable" as const, reportHash: "a".repeat(64), rationale: "Not applicable to this deterministic choice-only course." };
  const evidence: CurriculumReleaseEvidence = {
    schemaVersion: 1, generatedAt: now.toISOString(), generator: "runtime-regression",
    sourceCoverage: { ...passed, sourceRefs: [...skill.source_refs] },
    skillCoverage: { ...passed, skillIds: [skill.id], lessonArtifactKeys: [lesson.id], assessmentBankArtifactKeys: [bank.id] },
    dagMastery: passed, codeExecution: { ...passed, executedItemIds: [], runtimeImageDigests: [] },
    languageParity: { ...scoped, languages: [] }, webAccessibility: scoped, security: passed,
    exclusions: { reportHash: "a".repeat(64), items: [] },
  };
  await submitCurriculumReleaseEvidence({ actorUserId: "admin-user", courseVersionId: versionId, requestId: randomUUID(), expectedVersion: publicationRevision, reason, evidence, now });
  await publishCurriculumVersion({ actorUserId: "admin-user", courseVersionId: versionId, requestId: randomUUID(), expectedVersion: publicationRevision, targetStage: "beta", reason, now });
  if (stage === "verified") await publishCurriculumVersion({ actorUserId: "admin-user", courseVersionId: versionId, requestId: randomUUID(), expectedVersion: publicationRevision, targetStage: "verified", reason, now });
  return { course, artifacts, reviews, runtimeRows, immutable, skill };
}

function fluent(rows: unknown[]) {
  const builder = {
    from: () => builder, where: () => builder, innerJoin: () => builder,
    leftJoin: () => builder, limit: () => builder, orderBy: () => builder,
    for: () => builder, set: () => builder,
    then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
  };
  return builder;
}

function examPersistence(skillId: string) {
  let formAnswer: unknown;
  let formReads = 0;
  let savedAttempt: Record<string, unknown> = {};
  let savedSession: Record<string, unknown> = {};
  mocks.select.mockImplementation((fields: Record<string, unknown> = {}) => {
    const builder = fluent([]);
    builder.from = (table?: Parameters<typeof getTableName>[0]) => {
      const name = table ? getTableName(table) : "";
      const rows = name === "user" ? [{ status: "active" }]
        : name === "enrollment" ? [{ skillId, status: "mastered", criticalRequirementsMet: true }]
        : name === "exam_session" && Object.hasOwn(fields, "session") ? [{ session: savedSession, attempt: savedAttempt }]
        : name === "response" && formAnswer && Object.hasOwn(fields, "answer") && formReads++ === 0 ? [{ answer: formAnswer }]
        : [];
      return fluent(rows);
    };
    return builder;
  });
  mocks.execute.mockResolvedValue({ rows: [] });
  mocks.update.mockImplementation(() => fluent([]));
  mocks.insert.mockImplementation((table: Parameters<typeof getTableName>[0]) => ({
    values: (values: Record<string, unknown>) => {
      const name = getTableName(table);
      if (name === "attempt") savedAttempt = { ...values, id: "attempt-1" };
      if (name === "exam_session") savedSession = { ...values, id: "session-1", disconnectedSeconds: 0 };
      if (name === "response" && values.itemKey === BLUEPRINT_RESPONSE_KEY) formAnswer = values.answer;
      return { returning: async () => [{ id: name === "attempt" ? "attempt-1" : "session-1" }] };
    },
  }));
  mocks.transaction.mockImplementation(async (operation: (tx: typeof mocks) => unknown) => operation(mocks));
}

describe("N01 staged publication runtime regressions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("CODE_RUNNER_PROVIDER", "piston");
    vi.stubEnv("PISTON_URL", "http://piston:2000");
    vi.stubEnv("PISTON_IMAGE", `codestead-piston@sha256:${"a".repeat(64)}`);
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(["beta", "verified"] as const)("loads the catalog and starts a supported human-approved %s publication without changing immutable artifacts", async (stage) => {
    const fixture = await stagedPublication(stage);
    expect(fixture.artifacts.find((artifact) => artifact.artifact_type === "course_manifest")?.publication_stage).toBe("draft");
    const publications = await listPublishedExamCourses();
    expect(publications).toHaveLength(1);
    expect(publications[0]?.course.status).toBe(stage);
    examPersistence(fixture.skill.id);
    const catalog = await listExamCatalog("learner", now);
    expect(catalog.map((entry) => entry.moduleId)).toContain(fixture.course.modules[0]!.id);
    const session = await startExam("learner", {
      moduleId: fixture.course.modules[0]!.id, integrityDisclosureAccepted: true, readinessAcknowledged: true,
      device: { viewportWidth: 1280, viewportHeight: 800, userAgent: "Regression desktop" },
    }, now);
    expect(session.status).toBe("active");
    expect(session.form.items[0]?.verificationAvailable).toBe(true);
    expect(fixture.artifacts.map(({ content, content_hash, publication_stage }) => ({ content, content_hash, publication_stage }))).toEqual(fixture.immutable);
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(["tampered content", "aggregate hash", "different approval hash", "revoked approval", "superseded approval", "non-human approval", "no approval", "incomplete checklist", "generic review attestation", "incomplete item review", "draft bank", "ineligible bank"])("excludes and reports %s", async (fault) => {
    const fixture = await stagedPublication();
    const manifest = fixture.artifacts.find((artifact) => artifact.artifact_type === "course_manifest")!;
    const bank = fixture.artifacts.find((artifact) => artifact.artifact_type === "assessment_bank")!;
    const review = fixture.reviews.find((entry) => entry.artifact_id === manifest.id)!;
    if (fault === "tampered content") manifest.content.title = "Tampered course title";
    if (fault === "different approval hash") review.content_hash = "b".repeat(64);
    if (fault === "non-human approval") review.reviewer_kind = "ai-assisted";
    if (fault === "revoked approval" || fault === "superseded approval") fixture.reviews.push({ ...review, decision: fault === "revoked approval" ? "rejected" : "changes_requested", resulting_version: review.resulting_version + 1 });
    if (fault === "no approval") fixture.reviews.splice(fixture.reviews.indexOf(review), 1);
    if (fault === "incomplete checklist") review.checklist = {};
    if (fault === "generic review attestation") review.checklist = { independentlyReviewed: true };
    if (fault === "incomplete item review") review.reviewed_item_ids = [];
    if (fault === "draft bank") (bank.content.publication as Record<string, unknown>).stage = "draft";
    if (fault === "ineligible bank") ((bank.content.items as Record<string, unknown>[])[0]!.examEligibility as Record<string, unknown>).eligible = false;
    const rows = fixture.runtimeRows();
    if (fault === "aggregate hash") rows.forEach((row) => { row.version_content_hash = "b".repeat(64); });
    // Rebind all outer hashes/reviews for bank mutations so rejection proves
    // the independent oracle rule, rather than only detecting a content edit.
    if (fault === "draft bank" || fault === "ineligible bank") {
      bank.content_hash = hashCurriculumValue(bank.content);
      const bankReview = fixture.reviews.find((entry) => entry.artifact_id === bank.id)!;
      bankReview.content_hash = bank.content_hash;
      rows.find((row) => row.artifact_type === "assessment_bank")!.content_hash = bank.content_hash;
      const aggregate = hashCurriculumValue([...fixture.artifacts].sort((a, b) => a.artifact_key.localeCompare(b.artifact_key)).map((artifact) => ({ artifactKey: artifact.artifact_key, artifactType: artifact.artifact_type, contentHash: artifact.content_hash })));
      rows.forEach((row) => { row.version_content_hash = aggregate; });
    }
    mocks.query.mockResolvedValue({ rows });
    await expect(listPublishedExamCourses()).resolves.toEqual([]);
    expect(console.error).toHaveBeenCalledWith("Curriculum publication excluded from exams", expect.objectContaining({ courseVersionId: versionId, code: expect.stringMatching(/^PUBLICATION_/) }));
    if (fault === "draft bank" || fault === "ineligible bank") expect(console.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ code: fault === "draft bank" ? "PUBLICATION_BANK_INVALID" : "PUBLICATION_BANK_UNREVIEWED" }));
  });

  it("keeps a healthy course and module load available beside a broken pointer", async () => {
    const fixture = await stagedPublication();
    mocks.query.mockResolvedValue({ rows: [...fixture.runtimeRows(), pointerRow({ course_version_id: "20000000-0000-4000-8000-000000000099" })] });
    await expect(listPublishedExamCourses()).resolves.toHaveLength(1);
    await expect(loadPublishedExamModule(fixture.course.modules[0]!.id)).resolves.toMatchObject({ courseVersionId: versionId });
    expect(console.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ courseVersionId: "20000000-0000-4000-8000-000000000099", code: "PUBLICATION_POINTER_INVALID" }));
  });

  it("selects the latest review before checking approval, including later rejecting events", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await listPublishedExamCourses();
    const sql = mocks.query.mock.calls[0]![0] as string;
    expect(sql).toContain("left join lateral");
    expect(sql).toContain("order by resulting_version desc, id desc");
    expect(sql).toContain("limit 1");
    expect(sql).not.toMatch(/decision\s*=\s*'approved'/);
    expect(sql).not.toMatch(/reviewer_kind\s*=\s*'human'/);
  });
});
