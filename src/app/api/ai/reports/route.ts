import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { learningRequest, modelCall } from "@/lib/db/schema";
import { requireAuth } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";
import { containsCredentialOrHiddenEvidence } from "@/lib/security/sensitive-text";

const reportSchema = z.object({
  modelCallId: z.string().uuid(),
  category: z.enum(["incorrect", "harmful", "off-topic", "privacy", "other"]),
  description: z.string().trim().min(20).max(2_000),
});

export async function POST(request: NextRequest) {
  const authz = await requireAuth({ closedBookCapability: "ai_tutor" });
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "learning_request_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const body = reportSchema.safeParse(await request.json().catch(() => null));
      if (!body.success) {
        return NextResponse.json(
          { error: "Choose a category and describe the problem in at least 20 characters." },
          { status: 400, headers: { "Cache-Control": "private, no-store" } },
        );
      }
      if (containsCredentialOrHiddenEvidence(body.data.description)) {
        return NextResponse.json(
          { error: "Remove credentials or private grading material before sending this report." },
          { status: 400, headers: { "Cache-Control": "private, no-store" } },
        );
      }

      const [ownedCall] = await db
        .select({
          id: modelCall.id,
          provider: modelCall.provider,
          model: modelCall.model,
          promptVersion: modelCall.promptVersion,
          contextManifest: modelCall.contextManifest,
          requestHash: modelCall.requestHash,
          responseHash: modelCall.responseHash,
          createdAt: modelCall.createdAt,
        })
        .from(modelCall)
        .where(
          and(
            eq(modelCall.id, body.data.modelCallId),
            eq(modelCall.userId, authz.session.user.id),
            eq(modelCall.operation, "tutor"),
          ),
        )
        .limit(1);
      if (!ownedCall) {
        return NextResponse.json(
          { error: "Tutor response not found." },
          { status: 404, headers: { "Cache-Control": "private, no-store" } },
        );
      }

      const evidence = {
        modelCallId: ownedCall.id,
        provider: ownedCall.provider,
        model: ownedCall.model,
        promptVersion: ownedCall.promptVersion,
        contextManifest: ownedCall.contextManifest,
        requestHash: ownedCall.requestHash,
        responseHash: ownedCall.responseHash,
        calledAt: ownedCall.createdAt.toISOString(),
      };
      const [created] = await db
        .insert(learningRequest)
        .values({
          userId: authz.session.user.id,
          kind: "ai-output-report",
          subject: `AI tutor report: ${body.data.category}`,
          details: JSON.stringify({
            category: body.data.category,
            description: body.data.description,
            evidence,
          }),
        })
        .returning({
          id: learningRequest.id,
          status: learningRequest.status,
          createdAt: learningRequest.createdAt,
        });
      await writeAuditEvent({
        actorUserId: authz.session.user.id,
        subjectUserId: authz.session.user.id,
        action: "ai_output.report",
        resourceType: "learning_request",
        resourceId: created.id,
        outcome: "success",
        metadata: {
          category: body.data.category,
          modelCallId: ownedCall.id,
          provider: ownedCall.provider,
          model: ownedCall.model,
        },
      });
      return NextResponse.json(
        { report: created },
        { status: 201, headers: { "Cache-Control": "private, no-store" } },
      );
    },
  );
}
