import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/http/authz";
import { getProjectRevision, ProjectRevisionError } from "@/lib/projects/revision-service";

const paramsSchema = z.object({
  id: z.string().uuid(),
  revisionId: z.string().uuid(),
}).strict();

type RouteContext = { params: Promise<{ id: string; revisionId: string }> };

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(request: NextRequest, context: RouteContext) {
  const authz = await requireAuth({ closedBookCapability: "project_workspace" });
  if (!authz.session) return authz.response;
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success || request.nextUrl.searchParams.size !== 0) {
    return json({ error: "Project revision was not found.", code: "REVISION_NOT_FOUND" }, 404);
  }
  try {
    const revision = await getProjectRevision({
      userId: authz.session.user.id,
      projectId: params.data.id,
      revisionId: params.data.revisionId,
    });
    return json({ revision });
  } catch (error) {
    if (error instanceof ProjectRevisionError
      && (error.code === "PROJECT_NOT_FOUND" || error.code === "REVISION_NOT_FOUND")) {
      return json({ error: "Project revision was not found.", code: "REVISION_NOT_FOUND" }, 404);
    }
    if (error instanceof ProjectRevisionError && error.code === "INVALID_INPUT") {
      return json({ error: "Project revision was not found.", code: "REVISION_NOT_FOUND" }, 404);
    }
    return json({ error: "Project revisions are temporarily unavailable.", code: "REVISION_STORE_UNAVAILABLE" }, 503);
  }
}
