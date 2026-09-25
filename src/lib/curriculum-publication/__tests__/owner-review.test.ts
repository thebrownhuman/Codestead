import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ pool: { query: mocks.query } }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));

import { listOwnerReviewedArtifactIds, setOwnerReview } from "../owner-review";

const courseVersionId = "20000000-0000-4000-8000-000000000001";

describe("listOwnerReviewedArtifactIds", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queries the audit log with the course version and returns the matching artifact ids", async () => {
    mocks.query.mockResolvedValue({ rows: [{ id: "artifact-1" }, { id: "artifact-2" }] });

    const ids = await listOwnerReviewedArtifactIds(courseVersionId);

    expect(ids).toEqual(["artifact-1", "artifact-2"]);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("curriculum_artifact ca"),
      [courseVersionId, "curriculum_artifact_key", "curriculum.owner_review.mark", "curriculum.owner_review.unmark"],
    );
  });

  it("returns an empty list when nothing has been marked reviewed", async () => {
    mocks.query.mockResolvedValue({ rows: [] });

    expect(await listOwnerReviewedArtifactIds(courseVersionId)).toEqual([]);
  });
});

describe("setOwnerReview", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes a mark audit event per matched artifact with its content hash bound in", async () => {
    mocks.query.mockResolvedValue({
      rows: [
        { artifact_key: "lesson.python.variables.v1", content_hash: "a".repeat(64) },
        { artifact_key: "lesson.python.loops.v1", content_hash: "b".repeat(64) },
      ],
    });
    mocks.writeAuditEvent.mockResolvedValue(undefined);

    const updated = await setOwnerReview({
      actorUserId: "admin-1",
      courseVersionId,
      artifactIds: ["artifact-1", "artifact-2"],
      reviewed: true,
    });

    expect(updated).toBe(2);
    expect(mocks.writeAuditEvent).toHaveBeenCalledTimes(2);
    expect(mocks.writeAuditEvent).toHaveBeenNthCalledWith(1, {
      actorUserId: "admin-1",
      action: "curriculum.owner_review.mark",
      resourceType: "curriculum_artifact_key",
      resourceId: "lesson.python.variables.v1",
      outcome: "success",
      metadata: { contentHash: "a".repeat(64), courseVersionId },
    });
  });

  it("writes an unmark event when reviewed is false", async () => {
    mocks.query.mockResolvedValue({
      rows: [{ artifact_key: "lesson.python.variables.v1", content_hash: "a".repeat(64) }],
    });
    mocks.writeAuditEvent.mockResolvedValue(undefined);

    await setOwnerReview({
      actorUserId: "admin-1",
      courseVersionId,
      artifactIds: ["artifact-1"],
      reviewed: false,
    });

    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "curriculum.owner_review.unmark",
    }));
  });

  it("deduplicates repeated artifact ids before querying and returns zero for no matches", async () => {
    mocks.query.mockResolvedValue({ rows: [] });

    const updated = await setOwnerReview({
      actorUserId: "admin-1",
      courseVersionId,
      artifactIds: ["artifact-1", "artifact-1", "artifact-1"],
      reviewed: true,
    });

    expect(updated).toBe(0);
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith(
      expect.any(String),
      [courseVersionId, ["artifact-1"]],
    );
  });
});
