import { and, eq, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { project, projectReview, projectReviewEffective } from "@/lib/db/schema";
import { hashAppealEvidence } from "@/lib/appeals/evidence";
import { reviewPublicRepository } from "@/lib/github/reviewer";
import { requireAuth } from "@/lib/http/authz";
import { withRateLimit } from "@/lib/security/rate-limit";

const bodySchema = z.object({ repositoryUrl: z.url().max(300) });

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireAuth({ closedBookCapability: "project_workspace" });
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "github_review_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Provide a public GitHub repository URL." }, { status: 400 });
  const { id } = await context.params;
  const [owned] = await db
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.id, id), eq(project.userId, authz.session.user.id)))
    .limit(1);
  if (!owned) return NextResponse.json({ error: "Project not found." }, { status: 404 });
  try {
    const review = await reviewPublicRepository(body.data.repositoryUrl);
    const findings = review.findings.map((finding) => ({ ...finding })) as Record<string, unknown>[];
    const findingsHash = hashAppealEvidence(findings);
    const [stored] = await db.transaction(async (tx) => {
      const updated = await tx
        .update(project)
        .set({ githubUrl: review.repositoryUrl, githubCommitSha: review.commitSha, status: "reviewed" })
        .where(and(eq(project.id, owned.id), eq(project.userId, authz.session.user.id)))
        .returning({ id: project.id });
      if (!updated[0]) throw new Error("Project ownership changed before the review could be stored.");
      const inserted = await tx
        .insert(projectReview)
        .values({
          projectId: owned.id,
          commitSha: review.commitSha,
          analyzerVersion: review.analyzerVersion,
          rubricVersion: review.rubricVersion,
          analysisProvenance: { ...review.provenance },
          findings,
          findingsHash,
        })
        .returning();
      const created = inserted[0];
      if (!created) throw new Error("Project review could not be stored.");
      await tx.execute(sql`select set_config('app.project_review_projection_write', '1', true)`);
      await tx
        .insert(projectReviewEffective)
        .values({
          projectId: owned.id,
          sourceReviewId: created.id,
          correctionId: null,
          commitSha: review.commitSha,
          analyzerVersion: review.analyzerVersion,
          rubricVersion: review.rubricVersion,
          provenance: { ...review.provenance },
          findings,
          findingsHash,
          revision: 1,
        })
        .onConflictDoUpdate({
          target: projectReviewEffective.projectId,
          set: {
            sourceReviewId: created.id,
            correctionId: null,
            commitSha: review.commitSha,
            analyzerVersion: review.analyzerVersion,
            rubricVersion: review.rubricVersion,
            provenance: { ...review.provenance },
            findings,
            findingsHash,
            revision: sql`${projectReviewEffective.revision} + 1`,
            updatedAt: new Date(),
          },
        });
      return inserted;
    });
    return NextResponse.json({ review: { ...stored, filesReviewed: review.filesReviewed } }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Repository review failed." },
      { status: 422 },
    );
      }
    },
  );
}
