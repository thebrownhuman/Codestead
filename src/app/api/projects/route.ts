import { and, desc, eq, inArray } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db/client";
import {
  appeal,
  project,
  projectReview,
  projectReviewCorrection,
  projectReviewEffective,
} from "@/lib/db/schema";
import { requireAuth } from "@/lib/http/authz";
import { projectReviewQualityAssessment } from "@/lib/github/reviewer";

const createSchema = z.object({
  title: z.string().trim().min(3).max(100),
  summary: z.string().trim().min(20).max(1_000),
  track: z.string().trim().min(1).max(60),
  difficulty: z.enum(["starter", "portfolio", "stretch"]),
});

function projectPrd(input: z.infer<typeof createSchema>) {
  return {
    version: "1.0",
    track: input.track,
    difficulty: input.difficulty,
    problem: input.summary,
    users: ["The learner", "One invited reviewer"],
    goals: [
      "Demonstrate the selected course concepts independently.",
      "Produce a small, testable artifact suitable for a portfolio walkthrough.",
      "Explain design choices, trade-offs, and known limitations.",
    ],
    nonGoals: [
      "The tutor will not write the full implementation.",
      "No production-scale infrastructure or paid service is required.",
      "Features outside the declared learning outcome are optional.",
    ],
    milestones: [
      { id: 1, title: "Clarify inputs, outputs, users, and constraints", evidence: "Short design note and acceptance examples" },
      { id: 2, title: "Build the smallest vertical slice", evidence: "One working path plus an automated or repeatable check" },
      { id: 3, title: "Handle boundaries and failures", evidence: "Tests and an error-handling note" },
      { id: 4, title: "Refactor and document", evidence: "Readable structure, README, and decisions" },
      { id: 5, title: "Publish and reflect", evidence: "Immutable GitHub commit plus retrospective" },
    ],
    acceptance: [
      "The core user can complete the promised workflow.",
      "Normal, boundary, and failure behavior are tested.",
      "No credentials or generated build artifacts are committed.",
      "The learner can explain every submitted design decision.",
    ],
  };
}

export async function GET() {
  const authz = await requireAuth({ closedBookCapability: "project_workspace" });
  if (!authz.session) return authz.response;
  const projects = await db
    .select()
    .from(project)
    .where(eq(project.userId, authz.session.user.id))
    .orderBy(desc(project.updatedAt));
  const reviewRows = await db
    .select({
      id: projectReview.id,
      projectId: projectReview.projectId,
      commitSha: projectReview.commitSha,
      analyzerVersion: projectReview.analyzerVersion,
      rubricVersion: projectReview.rubricVersion,
      analysisProvenance: projectReview.analysisProvenance,
      findings: projectReview.findings,
      findingsHash: projectReview.findingsHash,
      status: projectReview.status,
      createdAt: projectReview.createdAt,
      appealId: appeal.id,
      appealStatus: appeal.status,
    })
    .from(projectReview)
    .innerJoin(project, eq(project.id, projectReview.projectId))
    .leftJoin(
      appeal,
      and(
        eq(appeal.projectReviewId, projectReview.id),
        inArray(appeal.status, ["open", "under_review", "needs_learner_input"]),
      ),
    )
    .where(eq(project.userId, authz.session.user.id))
    .orderBy(desc(projectReview.createdAt), desc(projectReview.id));
  const correctionRows = await db
    .select({
      id: projectReviewCorrection.id,
      projectId: projectReviewCorrection.projectId,
      sourceReviewId: projectReviewCorrection.sourceReviewId,
      sourceAppealId: projectReviewCorrection.sourceAppealId,
      revision: projectReviewCorrection.revision,
      status: projectReviewCorrection.status,
      sourceCommitSha: projectReviewCorrection.sourceCommitSha,
      sourceFindingsHash: projectReviewCorrection.sourceFindingsHash,
      resultFindingsHash: projectReviewCorrection.resultFindingsHash,
      projectionApplied: projectReviewCorrection.projectionApplied,
      createdAt: projectReviewCorrection.createdAt,
      completedAt: projectReviewCorrection.completedAt,
    })
    .from(projectReviewCorrection)
    .innerJoin(project, eq(project.id, projectReviewCorrection.projectId))
    .where(eq(project.userId, authz.session.user.id))
    .orderBy(desc(projectReviewCorrection.revision), desc(projectReviewCorrection.createdAt));
  const effectiveRows = await db
    .select({
      projectId: projectReviewEffective.projectId,
      sourceReviewId: projectReviewEffective.sourceReviewId,
      correctionId: projectReviewEffective.correctionId,
      commitSha: projectReviewEffective.commitSha,
      analyzerVersion: projectReviewEffective.analyzerVersion,
      rubricVersion: projectReviewEffective.rubricVersion,
      provenance: projectReviewEffective.provenance,
      findings: projectReviewEffective.findings,
      findingsHash: projectReviewEffective.findingsHash,
      revision: projectReviewEffective.revision,
      updatedAt: projectReviewEffective.updatedAt,
    })
    .from(projectReviewEffective)
    .innerJoin(project, eq(project.id, projectReviewEffective.projectId))
    .where(eq(project.userId, authz.session.user.id));
  const correctionByReview = new Map<string, (typeof correctionRows)[number]>();
  for (const correction of correctionRows) {
    if (!correctionByReview.has(correction.sourceReviewId)) {
      correctionByReview.set(correction.sourceReviewId, correction);
    }
  }
  const effectiveByProject = new Map(effectiveRows.map((row) => [row.projectId, row]));
  const reviewsByProject = new Map<string, typeof reviewRows>();
  for (const review of reviewRows) {
    const items = reviewsByProject.get(review.projectId) ?? [];
    items.push(review);
    reviewsByProject.set(review.projectId, items);
  }
  return NextResponse.json({
    projects: projects.map((item) => ({
      ...item,
      effectiveReview: (() => {
        const effective = effectiveByProject.get(item.id);
        return effective
          ? { ...effective, qualityAssessment: projectReviewQualityAssessment(effective.provenance) }
          : null;
      })(),
      reviews: (reviewsByProject.get(item.id) ?? []).map((review) => ({
        id: review.id,
        commitSha: review.commitSha,
        analyzerVersion: review.analyzerVersion,
        rubricVersion: review.rubricVersion,
        analysisProvenance: review.analysisProvenance,
        findings: review.findings,
        findingsHash: review.findingsHash,
        status: review.status,
        createdAt: review.createdAt,
        qualityAssessment: projectReviewQualityAssessment(review.analysisProvenance),
        appeal: review.appealId
          ? { id: review.appealId, status: review.appealStatus }
          : null,
        correction: correctionByReview.get(review.id) ?? null,
      })),
    })),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const authz = await requireAuth({ closedBookCapability: "project_workspace" });
  if (!authz.session) return authz.response;
  const body = createSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Describe a clear project idea first." }, { status: 400 });
  const [created] = await db
    .insert(project)
    .values({
      userId: authz.session.user.id,
      title: body.data.title,
      summary: body.data.summary,
      status: "idea",
      prd: projectPrd(body.data),
    })
    .returning();
  return NextResponse.json({ project: created }, { status: 201 });
}
