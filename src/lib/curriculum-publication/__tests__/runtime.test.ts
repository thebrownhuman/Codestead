import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ pool: { query: mocks.query } }));

import {
  listPublishedExamCourses,
  PublishedCurriculumRuntimeError,
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

describe("published curriculum runtime fail-closed boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns no reviewed publications only when no publication pointer exists", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(listPublishedExamCourses()).resolves.toEqual([]);
  });

  it.each([
    ["missing artifacts", {}],
    ["cross-course pointer", { version_course_id: "10000000-0000-4000-8000-000000000099" }],
    ["draft target", { course_stage: "draft" }],
    ["missing publish event", { publication_event_exists: false }],
    ["missing release evidence", { release_evidence_exists: false }],
  ])("rejects a pointer with %s instead of falling back to draft files", async (_label, overrides) => {
    mocks.query.mockResolvedValue({ rows: [pointerRow(overrides)] });
    await expect(listPublishedExamCourses()).rejects.toBeInstanceOf(PublishedCurriculumRuntimeError);
    await expect(listPublishedExamCourses()).rejects.toMatchObject({ code: "PUBLICATION_POINTER_INVALID" });
  });
});
