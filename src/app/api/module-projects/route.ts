import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/http/authz";
import {
  listLearnerModuleProjects,
  ModuleProjectError,
  startModuleProject,
} from "@/lib/projects/module-project-service";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";

const headers = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow",
};
const startSchema = z.object({ requestId: z.uuid(), templateId: z.uuid() }).strict();

function errorStatus(code: string) {
  if (code === "NOT_FOUND") return 404;
  if (code === "INVALID_REQUEST") return 400;
  if (code === "PLAN_GATE_FAILED" || code === "MASTERY_GATE_FAILED") return 422;
  return 409;
}

export async function GET() {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  try {
    const projects = await listLearnerModuleProjects(authz.session.user.id);
    return NextResponse.json({ projects }, { headers });
  } catch (error) {
    const code = error instanceof ModuleProjectError ? error.code : "MODULE_PROJECTS_LOAD_FAILED";
    return NextResponse.json({ error: code }, { status: errorStatus(code), headers });
  }
}

export async function POST(request: NextRequest) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const parsed = startSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400, headers });
  return withRateLimit(
    { policy: "module_project_start_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      try {
        await writeAuditEvent({
          actorUserId: authz.session!.user.id,
          subjectUserId: authz.session!.user.id,
          action: "module_project.start",
          resourceType: "module_project_template",
          resourceId: parsed.data.templateId,
          outcome: "allowed",
          correlationId: parsed.data.requestId,
          metadata: { phase: "pre_mutation", directAwardPolicy: "none" },
        });
      } catch {
        return NextResponse.json(
          { error: "Module-project start protection is temporarily unavailable." },
          { status: 503, headers },
        );
      }

      let result: Awaited<ReturnType<typeof startModuleProject>>;
      try {
        result = await startModuleProject({ userId: authz.session!.user.id, ...parsed.data });
      } catch (error) {
        const code = error instanceof ModuleProjectError ? error.code : "MODULE_PROJECT_START_FAILED";
        await writeAuditEvent({
          actorUserId: authz.session!.user.id,
          subjectUserId: authz.session!.user.id,
          action: "module_project.start",
          resourceType: "module_project_template",
          resourceId: parsed.data.templateId,
          outcome: "failure",
          correlationId: parsed.data.requestId,
          metadata: { errorCode: code, directAwardPolicy: "none" },
        }).catch(() => undefined);
        return NextResponse.json({ error: code }, { status: errorStatus(code), headers });
      }

      const completionAuditRecorded = await writeAuditEvent({
        actorUserId: authz.session!.user.id,
        subjectUserId: authz.session!.user.id,
        action: "module_project.start",
        resourceType: "project",
        resourceId: result.project.id,
        outcome: "success",
        correlationId: parsed.data.requestId,
        metadata: {
          templateId: parsed.data.templateId,
          replayed: result.replayed,
          reusedExisting: result.reusedExisting,
          directAwardPolicy: "none",
        },
      }).then(() => true).catch(() => false);
      return NextResponse.json({
        result,
        completionAuditRecorded,
        ...(completionAuditRecorded ? {} : {
          warning: "The project was started, but its completion audit needs operator reconciliation. Do not repeat the request.",
        }),
      }, { status: result.replayed || result.reusedExisting ? 200 : 201, headers });
    },
  );
}
