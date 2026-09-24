import { pool } from "@/lib/db/client";
import { writeAuditEvent } from "@/lib/security/audit-writer";

/*
 * Lightweight owner review tracker.
 *
 * Codestead has a single reviewer, so instead of the (disabled) seven-dimension
 * checklist the owner marks artifacts as reviewed with one click. Marks live in
 * the append-only audit log (action curriculum.owner_review.mark/unmark) and are
 * bound to the artifact's content hash: editing a lesson and restaging it clears
 * its mark automatically.
 *
 * These marks do NOT approve content for exams or "verified" publication; that
 * still requires the full approval pipeline (see docs/APP_STATUS.md, "Simple
 * review flow"), which can later consume these marks.
 */

const MARK = "curriculum.owner_review.mark";
const UNMARK = "curriculum.owner_review.unmark";
const RESOURCE_TYPE = "curriculum_artifact_key";

export const OWNER_REVIEW_BATCH_LIMIT = 500;

export async function listOwnerReviewedArtifactIds(courseVersionId: string): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `select ca.id
       from curriculum_artifact ca
       join lateral (
         select ae.action, ae.metadata
           from audit_event ae
          where ae.resource_type = $2
            and ae.resource_id = ca.artifact_key
            and ae.action in ($3, $4)
          order by ae.occurred_at desc, ae.id desc
          limit 1
       ) latest on true
      where ca.course_version_id = $1
        and latest.action = $3
        and latest.metadata->>'contentHash' = ca.content_hash`,
    [courseVersionId, RESOURCE_TYPE, MARK, UNMARK],
  );
  return result.rows.map((row) => row.id);
}

export async function setOwnerReview(input: {
  readonly actorUserId: string;
  readonly courseVersionId: string;
  readonly artifactIds: readonly string[];
  readonly reviewed: boolean;
}): Promise<number> {
  const result = await pool.query<{ artifact_key: string; content_hash: string }>(
    `select artifact_key, content_hash
       from curriculum_artifact
      where course_version_id = $1 and id = any($2::uuid[])`,
    [input.courseVersionId, [...new Set(input.artifactIds)]],
  );
  for (const row of result.rows) {
    await writeAuditEvent({
      actorUserId: input.actorUserId,
      action: input.reviewed ? MARK : UNMARK,
      resourceType: RESOURCE_TYPE,
      resourceId: row.artifact_key,
      outcome: "success",
      metadata: { contentHash: row.content_hash, courseVersionId: input.courseVersionId },
    });
  }
  return result.rows.length;
}
