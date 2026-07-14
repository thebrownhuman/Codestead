import { describe, expect, it, vi } from "vitest";

import {
  createUnavailableDashboardData,
  dashboardLocalDateKey,
  deriveActivityProjection,
  deriveCourseMasteryProgress,
  deriveVersionSafeCourseProgress,
  deriveReviewProjection,
  deriveRoadmapProjection,
  deriveSelectedTrackPreviews,
  deriveTopicProjections,
  reportDashboardFailure,
  selectDashboardEnrollments,
  type DashboardActivityEvent,
  type DashboardMasteryTopicInput,
} from "../learner";

const NOW = new Date("2026-07-13T12:00:00.000Z");
const LESSON_ONE = "11111111-1111-4111-8111-111111111111";
const LESSON_TWO = "22222222-2222-4222-8222-222222222222";
const LESSON_THREE = "33333333-3333-4333-8333-333333333333";

function activityEvent(
  occurredAt: string,
  overrides: Partial<DashboardActivityEvent> = {},
): DashboardActivityEvent {
  return {
    type: "attempt_submitted",
    occurredAt: new Date(occurredAt),
    subjectType: "attempt",
    subjectId: occurredAt,
    authoritative: true,
    ...overrides,
  };
}

function masteryTopic(
  overrides: Partial<DashboardMasteryTopicInput> = {},
): DashboardMasteryTopicInput {
  return {
    conceptId: "concept-arrays",
    skillId: "arrays",
    title: "Arrays",
    score: 0.8,
    confidence: 0.75,
    status: "practicing",
    lastEvidenceAt: new Date("2026-07-12T10:00:00.000Z"),
    ...overrides,
  };
}

describe("deriveActivityProjection", () => {
  it("uses complete meaningful history for a streak longer than the weekly window", () => {
    const events = Array.from({ length: 10 }, (_, index) => activityEvent(
      new Date(Date.UTC(2026, 6, 13 - index, 10)).toISOString(),
    ));

    expect(deriveActivityProjection(events, NOW, new Set(), "UTC")).toEqual({
      meaningfulThisWeek: 7,
      streak: 10,
      weeklyActivity: [1, 1, 1, 1, 1, 1, 1],
      completedLessons: 0,
    });
  });

  it("counts distinct authoritative lesson ids without inflating retries", () => {
    const events = [
      activityEvent("2026-07-13T08:00:00.000Z", {
        type: "lesson_completed",
        subjectType: "lesson",
        subjectId: LESSON_ONE,
      }),
      activityEvent("2026-07-13T08:05:00.000Z", {
        type: "lesson_completed",
        subjectType: "lesson",
        subjectId: LESSON_ONE,
      }),
      activityEvent("2026-07-12T08:00:00.000Z", {
        type: "lesson_completed",
        subjectType: "lesson",
        subjectId: LESSON_TWO,
      }),
      activityEvent("2026-07-12T08:05:00.000Z", {
        type: "lesson_completed",
        subjectType: "concept",
        subjectId: "not-a-lesson",
        authoritative: false,
      }),
      activityEvent("2026-07-12T08:10:00.000Z", {
        type: "lesson_completed",
        subjectType: "lesson",
        subjectId: "   ",
        authoritative: false,
      }),
      activityEvent("2026-07-12T08:15:00.000Z", {
        type: "lesson_completed",
        subjectType: "lesson",
        subjectId: LESSON_THREE,
        authoritative: false,
      }),
      activityEvent("2026-07-13T08:30:00.000Z", {
        type: "attempt_submitted",
        authoritative: false,
      }),
      activityEvent("2026-07-13T09:00:00.000Z", { type: "heartbeat" }),
    ];

    const projection = deriveActivityProjection(
      events,
      NOW,
      new Set([LESSON_ONE, LESSON_TWO, LESSON_THREE]),
      "UTC",
    );
    expect(projection.completedLessons).toBe(2);
    expect(projection.meaningfulThisWeek).toBe(3);
  });

  it("ignores future and invalid timestamps instead of changing current evidence", () => {
    expect(deriveActivityProjection([
      activityEvent("2026-07-14T08:00:00.000Z"),
      activityEvent("invalid"),
    ], NOW, new Set(), "UTC")).toEqual({
      meaningfulThisWeek: 0,
      streak: 0,
      weeklyActivity: [0, 0, 0, 0, 0, 0, 0],
      completedLessons: 0,
    });
  });

  it("uses the learner's Asia/Kolkata calendar day instead of UTC midnight", () => {
    const now = new Date("2026-07-13T19:00:00.000Z"); // July 14, 00:30 IST
    const projection = deriveActivityProjection([
      activityEvent("2026-07-13T18:45:00.000Z"), // July 14 IST
      activityEvent("2026-07-12T19:00:00.000Z"), // July 13 IST
    ], now, new Set(), "Asia/Kolkata");

    expect(dashboardLocalDateKey(now, "Asia/Kolkata")).toBe("2026-07-14");
    expect(projection.streak).toBe(2);
    expect(projection.weeklyActivity.slice(-2)).toEqual([1, 1]);
  });

  it("keeps New York streak days contiguous across the spring DST transition", () => {
    const now = new Date("2026-03-09T04:30:00.000Z"); // March 9, 00:30 EDT
    const projection = deriveActivityProjection([
      activityEvent("2026-03-09T04:15:00.000Z"), // March 9 EDT
      activityEvent("2026-03-08T07:30:00.000Z"), // March 8 EDT, after jump
      activityEvent("2026-03-08T04:30:00.000Z"), // March 7 EST
    ], now, new Set(), "America/New_York");

    expect(projection.streak).toBe(3);
    expect(projection.weeklyActivity.slice(-3)).toEqual([1, 1, 1]);
  });
});

describe("deriveReviewProjection", () => {
  it("counts every learner-local due review while returning six deterministically ordered cards", () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      id: `review-${String(8 - index).padStart(2, "0")}`,
      skillId: `skill-${index}`,
      title: `Skill ${index}`,
      courseId: "python",
      courseTitle: "Python",
      dueAt: new Date(`2026-07-13T${String(10 - (index % 2)).padStart(2, "0")}:00:00.000Z`),
      confidence: 0.5,
      reason: "Scheduled review",
    }));
    rows.push({
      id: "future-local-day",
      skillId: "future",
      title: "Future",
      courseId: "python",
      courseTitle: "Python",
      dueAt: new Date("2026-07-13T19:00:00.000Z"), // July 14 in Kolkata
      confidence: 0.5,
      reason: "Not due yet",
    });

    const projection = deriveReviewProjection(
      rows,
      new Date("2026-07-13T18:00:00.000Z"),
      "Asia/Kolkata",
    );
    expect(projection.reviewsDueCount).toBe(8);
    expect(projection.reviews).toHaveLength(6);
    expect(projection.reviews.map((review) => review.id)).toEqual([
      "review-01", "review-03", "review-05", "review-07", "review-02", "review-04",
    ]);
  });
});

describe("deriveCourseMasteryProgress", () => {
  it("deduplicates language contexts by concept and clamps mastered progress to the manifest total", () => {
    expect(deriveCourseMasteryProgress([
      { conceptId: "arrays" },
      { conceptId: "arrays" },
      { conceptId: "loops" },
      { conceptId: "extra-corrupt-row" },
    ], 2)).toEqual({ mastered: 2, progress: 100 });
    expect(deriveCourseMasteryProgress([{ conceptId: "arrays" }], 0)).toEqual({
      mastered: 0,
      progress: 0,
    });
  });

  it("refuses to apply totals from a different manifest version", () => {
    expect(deriveVersionSafeCourseProgress({
      masteryRows: [{ conceptId: "arrays" }, { conceptId: "loops" }],
      enrollmentVersion: "1.0.0",
      manifest: { version: "2.0.0", totalSkills: 40 },
    })).toEqual({
      mastered: 0,
      progress: 0,
      total: 0,
      progressState: "manifest_unavailable",
    });
    expect(deriveVersionSafeCourseProgress({
      masteryRows: [{ conceptId: "arrays" }, { conceptId: "arrays" }, { conceptId: "loops" }],
      enrollmentVersion: "2.0.0",
      manifest: { version: "2.0.0", totalSkills: 4 },
    })).toEqual({
      mastered: 2,
      progress: 50,
      total: 4,
      progressState: "verified",
    });
  });
});

describe("selectDashboardEnrollments", () => {
  const row = (
    enrollmentId: string,
    courseId: string,
    status: "planned" | "active" | "paused" | "completed",
    contentVersion: string,
    startedAt: string | null,
  ) => ({
    enrollmentId,
    courseId,
    courseTitle: courseId.toUpperCase(),
    contentVersion,
    stage: "beta",
    status,
    startedAt: startedAt ? new Date(startedAt) : null,
    createdAt: new Date(startedAt ?? "2026-01-01T00:00:00.000Z"),
  });

  it("returns one deterministic current path per course across versions and statuses", () => {
    const selected = selectDashboardEnrollments([
      row("python-completed-v1", "python", "completed", "1.0.0", "2026-06-01T00:00:00.000Z"),
      row("python-active-v2-old", "python", "active", "2.0.0", "2026-06-02T00:00:00.000Z"),
      row("python-active-v2-new", "python", "active", "2.0.0", "2026-07-02T00:00:00.000Z"),
      row("c-paused", "c", "paused", "1.0.0", "2026-07-03T00:00:00.000Z"),
      row("c-planned", "c", "planned", "2.0.0", "2026-07-04T00:00:00.000Z"),
    ]);

    expect(selected.map((item) => item.enrollmentId)).toEqual([
      "c-paused",
      "python-active-v2-new",
    ]);
    expect(new Set(selected.map((item) => item.courseId)).size).toBe(selected.length);
  });
});

describe("deriveTopicProjections", () => {
  it("classifies strong and review topics deterministically without labeling unseen topics", () => {
    const projections = deriveTopicProjections([
      masteryTopic({ skillId: "loops", conceptId: "concept-loops", title: "Loops", status: "proficient", score: 0.86, confidence: 0.82 }),
      masteryTopic({ skillId: "arrays", status: "mastered", score: 0.96, confidence: 0.93 }),
      masteryTopic({ skillId: "strings", conceptId: "concept-strings", title: "Strings", status: "needs_review", score: 0.61, confidence: 0.7 }),
      masteryTopic({ skillId: "functions", conceptId: "concept-functions", title: "Functions", status: "learning", score: 0.3, confidence: 0.2 }),
      masteryTopic({ skillId: "pointers", conceptId: "concept-pointers", title: "Pointers", status: "unseen", score: 0, confidence: 0, lastEvidenceAt: null }),
      masteryTopic({ skillId: "syntax", conceptId: "concept-syntax", title: "Syntax", status: "practicing", lastEvidenceAt: null }),
    ]);

    expect(projections.strongTopics).toEqual([
      { id: "arrays", title: "Arrays", confidence: 93 },
      { id: "loops", title: "Loops", confidence: 82 },
    ]);
    expect(projections.needsReviewTopics).toEqual([
      { id: "strings", title: "Strings", confidence: 70, reason: "Mastery status requires review." },
      { id: "functions", title: "Functions", confidence: 20, reason: "Evidence has not reached proficiency yet." },
    ]);
    expect([...projections.strongTopics, ...projections.needsReviewTopics].map((topic) => topic.id)).not.toContain("pointers");
    expect(projections.needsReviewTopics.map((topic) => topic.id)).not.toContain("syntax");
  });

  it("uses evidenced learning as a conservative fallback and safe topic identity", () => {
    expect(deriveTopicProjections([
      masteryTopic({
        conceptId: "concept-fallback",
        skillId: " ",
        title: " ",
        status: "practicing",
        confidence: 0.446,
      }),
    ])).toEqual({
      strongTopics: [],
      needsReviewTopics: [{
        id: "concept-fallback",
        title: "concept-fallback",
        confidence: 45,
        reason: "Evidence has not reached proficiency yet.",
      }],
    });
  });

  it("never shows the same concept as strong when another context needs review", () => {
    const projections = deriveTopicProjections([
      masteryTopic({ status: "mastered", score: 0.98, confidence: 0.96 }),
      masteryTopic({ status: "needs_review", score: 0.58, confidence: 0.51 }),
    ]);

    expect(projections.strongTopics).toEqual([]);
    expect(projections.needsReviewTopics).toEqual([{
      id: "arrays",
      title: "Arrays",
      confidence: 51,
      reason: "Mastery status requires review.",
    }]);
  });
});

describe("createUnavailableDashboardData", () => {
  it("returns safe empty progress defaults when authoritative loading fails", () => {
    const fallback = createUnavailableDashboardData("  ");
    expect(fallback.firstName).toBe("buddy");
    expect(fallback.completedLessons).toBe(0);
    expect(fallback.reviewsDueCount).toBe(0);
    expect(fallback.strongTopics).toEqual([]);
    expect(fallback.needsReviewTopics).toEqual([]);
    expect(fallback.streak).toBe(0);
    expect(fallback.roadmap.state).toBe("unavailable");
    expect(fallback.degraded).toBe(true);
  });
});

describe("dashboard operational failure reporting", () => {
  it("reports a bounded failure class without exposing the exception message", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    reportDashboardFailure(
      "authoritative-load",
      new TypeError("database password=must-never-reach-logs"),
    );

    expect(consoleError).toHaveBeenCalledWith(
      "[dashboard] authoritative-load failed (TypeError).",
    );
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("must-never-reach-logs");
    consoleError.mockRestore();
  });

  it("normalizes an unsafe custom error name before logging", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("private detail");
    error.name = "bad\nname";
    reportDashboardFailure("reward-projection", error);

    expect(consoleError).toHaveBeenCalledWith(
      "[dashboard] reward-projection failed (UnknownError).",
    );
    consoleError.mockRestore();
  });
});

describe("deriveRoadmapProjection", () => {
  it.each([
    {
      name: "reports a persisted enrollment as ready",
      input: {
        selectedTrackIds: ["programming-foundations", "c"],
        publishedTrackIds: ["programming-foundations"],
        enrollmentCount: 1,
      },
      state: "ready",
      unavailableTrackIds: ["c"],
    },
    {
      name: "distinguishes a learner who selected no tracks",
      input: {
        selectedTrackIds: [],
        publishedTrackIds: ["programming-foundations"],
        enrollmentCount: 0,
      },
      state: "no_tracks",
      unavailableTrackIds: [],
    },
    {
      name: "waits when none of the selected tracks has a reviewed publication",
      input: {
        selectedTrackIds: ["programming-foundations", "c"],
        publishedTrackIds: ["python"],
        enrollmentCount: 0,
      },
      state: "awaiting_publication",
      unavailableTrackIds: ["programming-foundations", "c"],
    },
    {
      name: "requires initialization when at least one selected track is publishable",
      input: {
        selectedTrackIds: ["programming-foundations", "c"],
        publishedTrackIds: ["programming-foundations"],
        enrollmentCount: 0,
      },
      state: "initialization_required",
      unavailableTrackIds: ["c"],
    },
  ])("$name", ({ input, state, unavailableTrackIds }) => {
    expect(deriveRoadmapProjection(input)).toEqual({
      state,
      selectedTrackIds: input.selectedTrackIds,
      unavailableTrackIds,
    });
  });
});

describe("deriveSelectedTrackPreviews", () => {
  const manifests = [{
    id: "programming-foundations",
    title: "Programming Foundations",
    summary: "Build reliable beginner programming mental models.",
    version: "0.1.0",
    moduleCount: 8,
    skillCount: 32,
  }, {
    id: "c",
    title: "C: Beginner to Intermediate",
    summary: "Learn portable C through deterministic practice.",
    version: "0.1.0",
    moduleCount: 9,
    skillCount: 36,
  }] as const;

  it("uses exact manifest metadata and requires an exact publication version match", () => {
    expect(deriveSelectedTrackPreviews({
      selectedTrackIds: ["programming-foundations", "c"],
      manifests,
      publications: [{
        trackId: "programming-foundations",
        version: "0.1.0",
      }, {
        trackId: "c",
        version: "0.0.9",
      }],
    })).toEqual([{
      id: "programming-foundations",
      title: "Programming Foundations",
      summary: "Build reliable beginner programming mental models.",
      moduleCount: 8,
      skillCount: 32,
      publicationReady: true,
      href: "/courses/programming-foundations",
    }, {
      id: "c",
      title: "C: Beginner to Intermediate",
      summary: "Learn portable C through deterministic practice.",
      moduleCount: 9,
      skillCount: 36,
      publicationReady: false,
      href: "/courses/c",
    }]);
  });

  it("keeps a selected track visible but non-navigable when its manifest is missing", () => {
    expect(deriveSelectedTrackPreviews({
      selectedTrackIds: ["missing-track"],
      manifests,
      publications: [{ trackId: "missing-track", version: "0.1.0" }],
    })).toEqual([{
      id: "missing-track",
      title: "missing-track",
      summary: "Course details are unavailable because its content manifest could not be loaded.",
      moduleCount: 0,
      skillCount: 0,
      publicationReady: false,
      href: null,
    }]);
  });
});
