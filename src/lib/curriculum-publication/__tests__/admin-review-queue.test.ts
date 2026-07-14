import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ pool: { query: mocks.query } }));

import { listCurriculumReviewQueue } from "../admin-service";

describe("curriculum editorial review queue", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns every non-approved artifact with cross-course and status counts", async () => {
    mocks.query.mockResolvedValue({
      rows: [
        {
          id: "10000000-0000-4000-8000-000000000001",
          course_version_id: "20000000-0000-4000-8000-000000000001",
          course_slug: "python",
          course_title: "Python",
          course_version: "0.1.0",
          course_stage: "draft",
          artifact_key: "lesson.python.variables.v1",
          artifact_type: "authored_lesson",
          source_path: "authored/lessons/python.variables.json",
          publication_stage: "draft",
          ai_assisted: true,
          review_status: "unreviewed",
          row_version: "1",
          updated_at: new Date("2026-07-13T10:00:00.000Z"),
        },
        {
          id: "10000000-0000-4000-8000-000000000002",
          course_version_id: "20000000-0000-4000-8000-000000000001",
          course_slug: "python",
          course_title: "Python",
          course_version: "0.1.0",
          course_stage: "draft",
          artifact_key: "bank.python.variables.v1",
          artifact_type: "assessment_bank",
          source_path: "authored/assessment-banks/python.variables.json",
          publication_stage: "draft",
          ai_assisted: true,
          review_status: "changes_requested",
          row_version: 2,
          updated_at: new Date("2026-07-13T10:01:00.000Z"),
        },
        {
          id: "10000000-0000-4000-8000-000000000003",
          course_version_id: "20000000-0000-4000-8000-000000000002",
          course_slug: "javascript",
          course_title: "JavaScript",
          course_version: "0.1.0",
          course_stage: "draft",
          artifact_key: "manifest.javascript.0.1.0",
          artifact_type: "course_manifest",
          source_path: "courses/javascript.json",
          publication_stage: "draft",
          ai_assisted: false,
          review_status: "unreviewed",
          row_version: 1,
          updated_at: new Date("2026-07-13T10:02:00.000Z"),
        },
      ],
    });

    const queue = await listCurriculumReviewQueue();

    expect(queue).toMatchObject({
      total: 3,
      courseCount: 2,
      statusCounts: [
        { status: "unreviewed", count: 2 },
        { status: "changes_requested", count: 1 },
      ],
      courseCounts: [
        expect.objectContaining({ courseSlug: "python", count: 2 }),
        expect.objectContaining({ courseSlug: "javascript", count: 1 }),
      ],
    });
    expect(queue.items).toHaveLength(3);
    expect(queue.items[0]).toMatchObject({
      courseSlug: "python",
      artifactKey: "lesson.python.variables.v1",
      rowVersion: 1,
      updatedAt: "2026-07-13T10:00:00.000Z",
    });
    const sql = String(mocks.query.mock.calls[0]?.[0]);
    expect(sql).toContain("ca.review_status <> 'approved'");
    expect(sql).toContain("cv.stage <> 'retired'");
  });
});
