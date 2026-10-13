import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentRepository, type CourseManifest } from "@/lib/content";
import { REVIEW_DIMENSIONS } from "../contracts";
import * as curriculumHash from "../hash";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ pool: { query: mocks.query } }));

import {
  listPointerSelectedCourseSlugs,
  listPublishedCourseStages,
  listPublishedExamCourses,
  listPublishedExamCourseAvailability,
  loadPublishedExamModule,
} from "../runtime";

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

async function reviewedRows(suffix: string) {
  const repository = new ContentRepository();
  const original = (await repository.getCourse("programming-foundations"))!;
  const courseModule = original.modules.find((entry) => entry.id === "pf.computing")!;
  const skill = courseModule.skills.find((entry) => entry.id === "pf.computing.program")!;
  const course: CourseManifest = {
    ...original, id: `reviewed-${suffix}`, status: "beta", modules: [{ ...courseModule, skills: [skill] }],
    coverage_summary: { required_skills: 1, elective_skills: 0, total_skills: 1, covered: 1, partial: 0, planned: 0 },
  };
  const authored = await repository.getAuthoredContentSet();
  const originalBank = authored.assessmentBanks.find((entry) => entry.skillId === skill.id)!;
  const bank = {
    ...originalBank, courseId: course.id,
    publication: { ...originalBank.publication, stage: "approved" as const, reviewer: {
      id: "test-human", displayName: "Test Human", kind: "human" as const,
      reviewedAt: "2026-07-12T07:00:00.000Z", reviewVersion: "1.0.0",
    } },
    items: originalBank.items.filter((item) => item.kind === "mcq").map((item) => ({
      ...item, examEligibility: { eligible: true, rationale: "Independently reviewed deterministic oracle for the runtime fixture." },
    })),
  };
  const artifacts = [
    { key: `course.${course.id}`, type: "course_manifest", content: course, skillKey: null, itemIds: [`course.${course.id}`] },
    { key: bank.id, type: "assessment_bank", content: bank, skillKey: skill.id, itemIds: bank.items.map((item) => item.id) },
  ];
  const versionHash = curriculumHash.aggregateArtifactHash(artifacts.map((artifact) => ({
    artifactKey: artifact.key, artifactType: artifact.type, contentHash: curriculumHash.hashCurriculumValue(artifact.content),
  })));
  return artifacts.map((artifact) => {
    const hash = curriculumHash.hashCurriculumValue(artifact.content);
    return pointerRow({
      pointer_course_id: `course-${suffix}`, version_course_id: `course-${suffix}`,
      course_slug: course.id, course_version_id: `version-${suffix}`, course_version: course.version,
      version_content_hash: versionHash, artifact_key: artifact.key, artifact_type: artifact.type,
      skill_key: artifact.skillKey, content: artifact.content, content_hash: hash,
      publication_stage: "draft", review_status: "approved",
      latest_review: {
        reviewer_kind: "human", decision: "approved", content_hash: hash, reviewed_item_ids: artifact.itemIds,
        checklist: Object.fromEntries(REVIEW_DIMENSIONS.map((dimension) => [dimension, {
          passed: true, evidenceRef: `runtime-test:${dimension}:evidence`,
          note: `Independent ${dimension} review passed for this fixture.`,
        }])),
      },
    });
  });
}

describe("published curriculum runtime fail-closed boundary", () => {
  it("explains a closed course and opens it after matching release evidence exists", async () => {
    const rows = await reviewedRows("availability");
    mocks.query.mockResolvedValue({ rows: rows.map((row) => ({ ...row, release_evidence_exists: false })) });
    expect(await listPublishedExamCourseAvailability()).toEqual([expect.objectContaining({ open: false, reason: "missing release evidence" })]);
    mocks.query.mockResolvedValue({ rows });
    expect(await listPublishedExamCourseAvailability()).toEqual([expect.objectContaining({ open: true, reason: null })]);
    expect(await listPublishedExamCourses()).toHaveLength(1);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns no reviewed publications only when no publication pointer exists", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(listPublishedExamCourses()).resolves.toEqual([]);
  });

  it.each([
    ["missing artifacts", {}],
    ["cross-course pointer", { version_course_id: "10000000-0000-4000-8000-000000000099" }],
    ["draft target", { course_stage: "draft" }],
    ["missing publish event", { publication_event_exists: false }],
  ])("excludes and flags a pointer with %s", async (_label, overrides) => {
    mocks.query.mockResolvedValue({ rows: [pointerRow(overrides)] });
    await expect(listPublishedExamCourses()).resolves.toEqual([]);
    expect(console.error).toHaveBeenCalledWith("Curriculum publication excluded from exams", {
      courseId: pointerRow().pointer_course_id,
      courseVersionId: pointerRow().course_version_id,
      code: "PUBLICATION_POINTER_INVALID",
    });
  });

  it("leaves owner-published courses without release evidence out of the exam catalog", async () => {
    mocks.query.mockResolvedValue({ rows: [pointerRow({ release_evidence_exists: false })] });
    await expect(listPublishedExamCourses()).resolves.toEqual([]);
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

  it("skips only the invalid course and preserves both healthy publications and their immutable artifacts", async () => {
    const first = await reviewedRows("first");
    const second = await reviewedRows("second");
    const rows = [...first, pointerRow(), ...second];
    const before = structuredClone(rows);
    mocks.query.mockResolvedValue({ rows });
    const publications = await listPublishedExamCourses();
    expect(publications.map((entry) => entry.course.id)).toEqual(["reviewed-first", "reviewed-second"]);
    expect(publications.map((entry) => entry.courseVersionId)).toEqual(["version-first", "version-second"]);
    expect(publications.every((entry) => entry.assessmentBanks.length === 1)).toBe(true);
    expect(rows).toEqual(before);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("Curriculum publication excluded from exams", {
      courseId: pointerRow().pointer_course_id, courseVersionId: pointerRow().course_version_id,
      code: "PUBLICATION_POINTER_INVALID",
    });
  });

  it("rethrows an unexpected hashing error instead of treating it as a bad publication", async () => {
    const rows = await reviewedRows("unexpected-error");
    mocks.query.mockResolvedValue({ rows });
    const unexpected = new TypeError("Unexpected hashing dependency failure");
    vi.spyOn(curriculumHash, "hashCurriculumValue").mockImplementationOnce(() => { throw unexpected; });
    await expect(listPublishedExamCourses()).rejects.toBe(unexpected);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("loads the reviewed module with its version-bound course and bank", async () => {
    const rows = await reviewedRows("module");
    mocks.query.mockResolvedValue({ rows });
    await expect(loadPublishedExamModule("pf.computing")).resolves.toMatchObject({
      courseVersionId: "version-module", course: { id: "reviewed-module" },
      module: { id: "pf.computing" }, assessmentBanks: [{ courseId: "reviewed-module" }],
    });
  });

  it("returns no published module when the requested ID is absent", async () => {
    mocks.query.mockResolvedValue({ rows: await reviewedRows("missing-module") });
    await expect(loadPublishedExamModule("pf.missing")).resolves.toBeNull();
  });

  it("maps pointer-selected beta and verified course stages", async () => {
    mocks.query.mockResolvedValue({ rows: [{ slug: "beta-course", stage: "beta" }, { slug: "verified-course", stage: "verified" }] });
    expect(await listPublishedCourseStages()).toEqual(new Map([["beta-course", "beta"], ["verified-course", "verified"]]));
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("where cv.stage in ('beta', 'verified')"));
  });

  it("returns an empty stage map when no publication pointers exist", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    expect(await listPublishedCourseStages()).toEqual(new Map());
  });

  it("lists every pointer-selected course, unfiltered by stage or exam readiness", async () => {
    mocks.query.mockResolvedValue({ rows: [{ slug: "owner-beta" }, { slug: "draft-pointer" }] });
    expect(await listPointerSelectedCourseSlugs()).toEqual(new Set(["owner-beta", "draft-pointer"]));
    const sql = mocks.query.mock.calls[0]![0] as string;
    expect(sql).toContain("from curriculum_publication_pointer cpp");
    expect(sql).not.toMatch(/where/u);
    expect(sql).not.toContain("release_evidence");
  });
});
