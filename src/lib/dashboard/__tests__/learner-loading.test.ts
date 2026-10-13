import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ select: vi.fn(), selectDistinctOn: vi.fn(), execute: vi.fn(), recommendNext: vi.fn(), initializePlans: vi.fn(), rewards: vi.fn(), listCourses: vi.fn(), getSkillLocation: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select, selectDistinctOn: mocks.selectDistinctOn, execute: mocks.execute } }));
vi.mock("@/lib/learning-service/runtime", () => ({ learningService: mocks }));
vi.mock("@/lib/rewards/service", () => ({ loadRewardProgress: mocks.rewards }));
vi.mock("@/lib/content", () => ({ createContentRepository: () => mocks }));
import * as schema from "@/lib/db/schema";
import { LESSON_COMPLETION_AUTHORITY } from "@/lib/learning-service/types";
import { createUnavailableDashboardData, deriveActivityProjection, ensureLearnerRoadmapInitialized, loadAuthoritativeDashboard } from "../learner";

const now = new Date("2026-10-01T12:00:00Z");
const lessonId = "11111111-1111-4111-8111-111111111111";
const rows = new Map<string, unknown[]>();
const filters: Array<{ table: string; filter: Parameters<PgDialect["sqlToQuery"]>[0] }> = [];
function seed(table: Parameters<typeof getTableName>[0], values: unknown[]) { rows.set(getTableName(table), values); }
const manifest = { id: "python", title: "Python", summary: "Learn Python", version: "1.0.0", modules: [{ id: "loops" }], coverage_summary: { total_skills: 4 } };

beforeEach(() => {
  vi.resetAllMocks(); rows.clear(); filters.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  seed(schema.user, [{ timezone: "UTC" }]);
  mocks.recommendNext.mockResolvedValue({ state: "ready", action: null });
  mocks.rewards.mockResolvedValue({ xp: 12 }); mocks.listCourses.mockResolvedValue([manifest]);
  mocks.select.mockImplementation(() => {
    let table = "";
    const query = {
      from: vi.fn((value) => { table = getTableName(value); return query; }),
      innerJoin: vi.fn(() => query), where: vi.fn((filter) => { filters.push({ table, filter }); return query; }),
      limit: vi.fn(() => query), orderBy: vi.fn(() => query),
      then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(rows.get(table) ?? []).then(resolve, reject),
    };
    return query;
  });
  mocks.selectDistinctOn.mockImplementation((_columns, fields) => mocks.select(fields));
  mocks.execute.mockImplementation(() => {
    const events = (rows.get(getTableName(schema.sessionEvent)) ?? []) as Array<{ type: string; occurredAt: Date; subjectType: string | null; subjectId: string | null; metadata: Record<string, unknown> }>;
    const attempts = (rows.get(getTableName(schema.attempt)) ?? []) as Array<{ id: string; occurredAt: Date | null }>;
    const lessons = (rows.get(getTableName(schema.lesson)) ?? []) as Array<{ id: string }>;
    return Promise.resolve({ rows: [deriveActivityProjection([
      ...events.map((row) => ({ ...row, authoritative: row.metadata.authority === LESSON_COMPLETION_AUTHORITY })),
      ...attempts.flatMap((row) => row.occurredAt ? [{ type: "attempt_submitted", occurredAt: row.occurredAt, subjectType: "attempt", subjectId: row.id, authoritative: true }] : []),
    ], now, new Set(lessons.map((row) => row.id)), "UTC")] });
  });
});

describe("authoritative dashboard loading", () => {
  it("loads one SQL activity summary and latest plans without loading event/attempt history", async () => {
    seed(schema.enrollment, [{ enrollmentId: "e1", courseId: "python", courseTitle: "Python", contentVersion: "1.0.0", stage: "verified", status: "active", startedAt: now, createdAt: now }]);
    const result = await loadAuthoritativeDashboard("owner", "Ada", now);
    expect(result.degraded).toBe(false);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.selectDistinctOn).toHaveBeenCalledWith([schema.planRevision.enrollmentId], expect.any(Object));
    expect(filters.map((filter) => filter.table)).not.toContain(getTableName(schema.sessionEvent));
    expect(filters.map((filter) => filter.table)).not.toContain(getTableName(schema.attempt));
    expect(filters.map((filter) => filter.table)).not.toContain(getTableName(schema.lesson));
  });
  it("hydrates verified mastery, deduplicated lessons, reviews and the newest plan revision", async () => {
    seed(schema.conceptMastery, [
      { enrollmentId: "e1", conceptId: "loops", skillId: "loops", title: "Loops", score: 1, confidence: 0.9, status: "mastered", lastEvidenceAt: now },
      { enrollmentId: "e1", conceptId: "loops", skillId: "loops", title: "Loops", score: 0.8, confidence: 0.6, status: "proficient", lastEvidenceAt: now },
      { enrollmentId: "e1", conceptId: "loops", skillId: "loops", title: "Loops", score: 0.7, confidence: 0.8, status: "practicing", lastEvidenceAt: now },
    ]);
    seed(schema.reviewSchedule, [
      { id: "review-1", enrollmentId: "e1", conceptId: "loops", skillId: "loops", title: "Loops", courseId: "python", courseTitle: "Python", dueAt: now, reason: "Review loops" },
      { id: "review-2", enrollmentId: "e2", conceptId: "missing", skillId: "missing", title: "Missing", courseId: "missing", courseTitle: "Missing", dueAt: now, reason: "Review missing" },
    ]);
    seed(schema.sessionEvent, [
      { type: "lesson_completed", occurredAt: now, subjectType: "lesson", subjectId: lessonId, metadata: { authority: LESSON_COMPLETION_AUTHORITY } },
      { type: "lesson_completed", occurredAt: now, subjectType: "lesson", subjectId: null, metadata: {} },
    ]);
    seed(schema.lesson, [{ id: lessonId }]);
    seed(schema.attempt, [{ id: "a1", occurredAt: now }, { id: "a2", occurredAt: null }]);
    seed(schema.enrollment, [
      { enrollmentId: "e1", courseId: "python", courseTitle: "Python", contentVersion: "1.0.0", stage: "verified", status: "active", startedAt: now, createdAt: now },
      { enrollmentId: "e2", courseId: "missing", courseTitle: "Missing", contentVersion: "0.1.0", stage: "beta", status: "planned", startedAt: null, createdAt: now },
    ]);
    seed(schema.planRevision, [
      { enrollmentId: "e1", revision: 3, source: "mastery", reason: "Advance", createdAt: now },
      { enrollmentId: "e1", revision: 2, source: "initial", reason: "Old", createdAt: now },
    ]);
    seed(schema.learnerProfile, [{ selectedTracks: ["python", "missing"] }]);
    seed(schema.curriculumPublicationPointer, [{ trackId: "python", version: "1.0.0" }]);
    mocks.recommendNext.mockResolvedValue({ state: "ready", action: { skillId: "loops/name", reason: "Practice next" } });
    mocks.getSkillLocation.mockResolvedValue({ course: { id: "python", title: "Python" }, skill: { id: "loops/name", title: "Loops" } });
    const result = await loadAuthoritativeDashboard("owner", " Ada Lovelace ", now);
    expect(result).toMatchObject({ firstName: "Ada", masteryPercent: 83, averageConfidencePercent: 77, masteredSkills: 1, completedLessons: 1, meaningfulThisWeek: 2, degraded: false, next: { title: "Loops", course: "Python", reason: "Practice next", href: "/courses/python/skills/loops%2Fname" } });
    expect(result.courses.find((course) => course.id === "python")).toMatchObject({ progress: 25, mastered: 1, total: 4, planRevision: { revision: 3, reason: "Advance", createdAt: now.toISOString() } });
    expect(result.courses.find((course) => course.id === "missing")).toMatchObject({ progressState: "manifest_unavailable", total: 0, planRevision: undefined });
    expect(result.reviews.map((review) => review.confidence)).toEqual([60, 0]);
    expect(result.roadmap).toMatchObject({ state: "ready", selectedTrackIds: ["python", "missing"] });
    expect(mocks.rewards).toHaveBeenCalledWith("owner", now);
    expect(new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0]).params).toContain("owner");
  });

  it("returns empty verified projections and an initialization prompt for a new published track", async () => {
    seed(schema.learnerProfile, [{ selectedTracks: ["python"] }]);
    seed(schema.curriculumPublicationPointer, [{ trackId: "python", version: "1.0.0" }]);
    const result = await loadAuthoritativeDashboard("owner", "", now);
    expect(result).toMatchObject({ firstName: "buddy", masteryPercent: 0, averageConfidencePercent: 0, masteredSkills: 0, reviews: [], completedLessons: 0, courses: [], next: null, degraded: false, roadmap: { state: "initialization_required" } });
  });

  it("keeps usable dashboard data when recommendation and rewards fail independently", async () => {
    mocks.recommendNext.mockRejectedValue(new Error("private details")); mocks.rewards.mockRejectedValue(new Error("private details"));
    const result = await loadAuthoritativeDashboard("owner", "Ada", now);
    expect(result).toMatchObject({ firstName: "Ada", degraded: true, rewards: null, next: null, roadmap: { state: "no_tracks" } });
    expect(console.error).toHaveBeenCalledWith("[dashboard] next-recommendation failed (Error).");
    expect(console.error).toHaveBeenCalledWith("[dashboard] reward-projection failed (Error).");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private details");
  });

  it("does not invent a next lesson when its authored location is absent", async () => {
    mocks.recommendNext.mockResolvedValue({ state: "ready", action: { skillId: "missing" } }); mocks.getSkillLocation.mockResolvedValue(null);
    expect((await loadAuthoritativeDashboard("owner", "Ada", now)).next).toBeNull();
    expect(mocks.getSkillLocation).toHaveBeenCalledWith("missing");
  });

  it.each(["owner missing", "content unavailable"])("fails closed when %s", async (failure) => {
    if (failure === "owner missing") seed(schema.user, []);
    else mocks.listCourses.mockRejectedValue(new Error("private query"));
    expect(await loadAuthoritativeDashboard("owner", "Ada", now)).toEqual(createUnavailableDashboardData("Ada"));
    expect(console.error).toHaveBeenCalledWith("[dashboard] authoritative-load failed (Error).");
  });

  it("initializes only when required and preserves the old dashboard on failure", async () => {
    const current = createUnavailableDashboardData("Ada");
    expect(await ensureLearnerRoadmapInitialized("owner", "Ada", current)).toBe(current);
    expect(mocks.initializePlans).not.toHaveBeenCalled();
    const uninitialized = { ...current, roadmap: { ...current.roadmap, state: "initialization_required" as const } };
    mocks.initializePlans.mockRejectedValueOnce(new Error("offline"));
    expect(await ensureLearnerRoadmapInitialized("owner", "Ada", uninitialized)).toBe(uninitialized);
    mocks.initializePlans.mockResolvedValueOnce(undefined);
    expect(await ensureLearnerRoadmapInitialized("owner", "Ada", uninitialized)).toMatchObject({ firstName: "Ada", roadmap: { state: "no_tracks" }, degraded: false });
    expect(mocks.initializePlans).toHaveBeenLastCalledWith("owner", "lazy-plans:owner");
  });
});
