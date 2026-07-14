import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/http/authz";
import {
  createProjectRevision,
  listProjectRevisions,
  MAX_PROJECT_REVISION_FILES,
  MAX_PROJECT_REVISION_PAGE,
  ProjectRevisionError,
} from "@/lib/projects/revision-service";
import { withRateLimit } from "@/lib/security/rate-limit";

const paramsSchema = z.object({ id: z.string().uuid() }).strict();
const positiveInteger = z.string().regex(/^[1-9][0-9]*$/).transform(Number);
const querySchema = z.object({
  limit: positiveInteger.refine((value) => value <= MAX_PROJECT_REVISION_PAGE).optional(),
  beforeSequence: positiveInteger.refine(Number.isSafeInteger).optional(),
}).strict();
const createSchema = z.object({
  clientRequestId: z.string().uuid(),
  expectedLatestRevision: z.number().int().min(0).max(2_147_483_647),
  changeSummary: z.string().trim().min(10).max(1_000),
  reflection: z.string().trim().max(4_000).nullable().optional(),
  fileIds: z.array(z.string().uuid()).max(MAX_PROJECT_REVISION_FILES)
    .refine((ids) => new Set(ids).size === ids.length, "File identifiers must be unique."),
}).strict();

type RouteContext = { params: Promise<{ id: string }> };

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function errorResponse(error: unknown) {
  if (!(error instanceof ProjectRevisionError)) {
    return json({ error: "Project revisions are temporarily unavailable.", code: "REVISION_STORE_UNAVAILABLE" }, 503);
  }
  if (error.code === "PROJECT_NOT_FOUND" || error.code === "REVISION_NOT_FOUND") {
    return json({ error: "Project was not found.", code: "PROJECT_NOT_FOUND" }, 404);
  }
  if (error.code === "VERSION_CONFLICT") {
    return json({
      error: error.message,
      code: error.code,
      currentLatestRevision: error.currentLatestRevision,
    }, 409);
  }
  if (error.code === "IDEMPOTENCY_MISMATCH" || error.code === "FILE_NOT_AVAILABLE") {
    return json({ error: error.message, code: error.code }, 409);
  }
  if (error.code === "INVALID_INPUT") {
    return json({ error: error.message, code: error.code }, 400);
  }
  return json({ error: "Project revision could not be recorded.", code: error.code }, 503);
}

function hasDuplicateQueryKeys(request: NextRequest) {
  return [...new Set(request.nextUrl.searchParams.keys())]
    .some((key) => request.nextUrl.searchParams.getAll(key).length !== 1);
}

export async function GET(request: NextRequest, context: RouteContext) {
  const authz = await requireAuth({ closedBookCapability: "project_workspace" });
  if (!authz.session) return authz.response;
  const params = paramsSchema.safeParse(await context.params);
  const query = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!params.success || !query.success || hasDuplicateQueryKeys(request)) {
    return json({ error: "Project revision pagination is invalid.", code: "INVALID_REVISION_QUERY" }, 400);
  }
  try {
    return json(await listProjectRevisions({
      userId: authz.session.user.id,
      projectId: params.data.id,
      ...query.data,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const authz = await requireAuth({ closedBookCapability: "project_workspace" });
  if (!authz.session) return authz.response;
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) {
    return json({ error: "Project was not found.", code: "PROJECT_NOT_FOUND" }, 404);
  }
  return withRateLimit(
    { policy: "project_revision_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const body = createSchema.safeParse(await request.json().catch(() => null));
      if (!body.success) {
        return json({ error: "Project revision input is invalid.", code: "INVALID_REVISION_INPUT" }, 400);
      }
      try {
        const result = await createProjectRevision({
          userId: authz.session.user.id,
          projectId: params.data.id,
          ...body.data,
        });
        return json(result, result.duplicate ? 200 : 201);
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
