import { and, eq, notInArray } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { user } from "@/lib/db/schema";
import { authorizeLifecycleAdmin } from "@/lib/data-lifecycle/admin-authorization";
import { createLearnerExport } from "@/lib/data-lifecycle/export";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";

const bodySchema = z.object({
  requestId: z.uuid(),
  reason: z.string().trim().min(8).max(500),
  maxRecords: z.number().int().min(1).max(10_000).optional(),
  maxBytes: z.number().int().min(1_024).max(20 * 1_024 * 1_024).optional(),
}).strict();

const responseHeaders = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Content-Disposition": 'attachment; filename="codestead-export.ndjson"',
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;

const noStoreJsonHeaders = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ learnerId: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) {
    for (const [name, value] of Object.entries(noStoreJsonHeaders)) {
      authz.response.headers.set(name, value);
    }
    return authz.response;
  }
  return withRateLimit(
    { policy: "data_export_admin", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const body = bodySchema.safeParse(await request.json().catch(() => null));
      if (!body.success) return NextResponse.json(
        { error: "A request id, bounded export size, and specific reason are required." },
        { status: 400, headers: noStoreJsonHeaders },
      );
      const { learnerId } = await context.params;
      const [target] = await db
        .select({ id: user.id })
        .from(user)
        .where(and(
          eq(user.id, learnerId),
          eq(user.role, "learner"),
          notInArray(user.status, ["deletion_pending", "deleted"]),
        ))
        .limit(1);
      if (!target) return NextResponse.json(
        { error: "Learner not found." },
        { status: 404, headers: noStoreJsonHeaders },
      );
      const gate = await authorizeLifecycleAdmin({
        actorUserId: authz.session.user.id,
        actorSessionId: authz.session.session.id,
        actorRole: authz.account.role,
        reason: body.data.reason,
        action: "data.export",
      });
      if (!gate.allowed) {
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          subjectUserId: learnerId,
          action: "data.export",
          resourceType: "learner_data",
          resourceId: learnerId,
          reason: body.data.reason,
          outcome: "denied",
          metadata: { denialCode: gate.code },
        });
        return NextResponse.json(
          { error: gate.code },
          { status: 403, headers: noStoreJsonHeaders },
        );
      }
      await writeAuditEvent({
        actorUserId: authz.session.user.id,
        subjectUserId: learnerId,
        action: "data.export",
        resourceType: "learner_data",
        resourceId: learnerId,
        reason: body.data.reason,
        outcome: "allowed",
        metadata: { phase: "pre_stream", requestId: body.data.requestId },
      });
      const exportResult = await createLearnerExport({
        learnerId,
        actorUserId: authz.session.user.id,
        requestId: body.data.requestId,
        maxRecords: body.data.maxRecords,
        maxBytes: body.data.maxBytes,
      }).catch(() => null);
      if (!exportResult) {
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          subjectUserId: learnerId,
          action: "data.export",
          resourceType: "learner_data",
          resourceId: learnerId,
          reason: body.data.reason,
          outcome: "failure",
          metadata: { errorCode: "EXPORT_START_FAILED" },
        });
        return NextResponse.json(
          { error: "Export could not start or the request id was already used." },
          { status: 409, headers: noStoreJsonHeaders },
        );
      }
      void exportResult.completion.then(async (metrics) => {
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          subjectUserId: learnerId,
          action: "data.export",
          resourceType: "data_lifecycle_run",
          resourceId: exportResult.runId,
          reason: body.data.reason,
          outcome: "success",
          metadata: {
            records: metrics.records,
            bytes: metrics.bytes,
            truncated: metrics.truncated,
          },
        });
      }).catch(async () => {
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          subjectUserId: learnerId,
          action: "data.export",
          resourceType: "data_lifecycle_run",
          resourceId: exportResult.runId,
          reason: body.data.reason,
          outcome: "failure",
          metadata: { errorCode: "EXPORT_STREAM_FAILED" },
        }).catch(() => undefined);
      });
      return new NextResponse(exportResult.stream, {
        status: 200,
        headers: { ...responseHeaders, "X-Export-Run-Id": exportResult.runId },
      });
    },
  );
}
