import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  ProjectReviewAppealError,
  submitProjectReviewAppeal,
} from "@/lib/appeals/project-review-service";
import { requireAuth } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";

const paramsSchema = z.object({
  id: z.string().uuid(),
  reviewId: z.string().uuid(),
});

const bodySchema = z.object({
  clientRequestId: z.string().uuid(),
  category: z.literal("project_finding"),
  reason: z.string().trim().min(20).max(1_000),
});

function errorResponse(error: unknown) {
  if (!(error instanceof ProjectReviewAppealError)) {
    return NextResponse.json(
      { error: "The project-review appeal could not be recorded.", code: "APPEAL_UNAVAILABLE" },
      { status: 500 },
    );
  }
  const status = error.code === "REVIEW_NOT_FOUND"
    ? 404
    : ["INVALID_TIME", "INVALID_REQUEST_ID", "INVALID_REASON", "INVALID_CATEGORY"].includes(error.code)
      ? 400
      : 409;
  return NextResponse.json({ error: error.message, code: error.code }, { status });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; reviewId: string }> },
) {
  const authz = await requireAuth({ closedBookCapability: "project_workspace" });
  if (!authz.session) return authz.response;
  return withRateLimit(
    {
      policy: "project_review_appeal_user",
      identity: { kind: "user", value: authz.session.user.id },
    },
    async () => {
      const parsedParams = paramsSchema.safeParse(await params);
      const body = bodySchema.safeParse(await request.json().catch(() => null));
      if (!parsedParams.success || !body.success) {
        return NextResponse.json(
          { error: "Give a concise reason for this stored project-review appeal.", code: "INVALID_APPEAL" },
          { status: 400 },
        );
      }
      try {
        const result = await submitProjectReviewAppeal({
          userId: authz.session.user.id,
          projectId: parsedParams.data.id,
          projectReviewId: parsedParams.data.reviewId,
          ...body.data,
        });
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          subjectUserId: authz.session.user.id,
          action: "project_review.appeal_submit",
          resourceType: "appeal",
          resourceId: result.appealId,
          reason: "Learner submitted a project-review appeal.",
          outcome: "success",
          correlationId: body.data.clientRequestId,
          metadata: {
            projectId: parsedParams.data.id,
            projectReviewId: parsedParams.data.reviewId,
            evidenceHash: result.evidenceHash,
            duplicate: result.duplicate,
          },
        });
        return NextResponse.json(result, {
          status: 202,
          headers: { "Cache-Control": "private, no-store" },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
