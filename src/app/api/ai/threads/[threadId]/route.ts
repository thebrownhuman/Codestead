import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  ChatThreadLifecycleError,
  readOwnedChatThread,
  setOwnedChatThreadStatus,
} from "@/lib/ai/chat-lifecycle";
import { requireAuth } from "@/lib/http/authz";
import { withRateLimit } from "@/lib/security/rate-limit";

const paramsSchema = z.object({ threadId: z.uuid() }).strict();
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(500).optional(),
}).strict();
const mutationSchema = z.object({
  status: z.enum(["active", "archived"]),
  expectedUpdatedAt: z.iso.datetime({ offset: true }),
}).strict();
const noStore = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

function errorResponse(error: unknown) {
  if (error instanceof ChatThreadLifecycleError) {
    if (error.code === "NOT_FOUND") return NextResponse.json({ error: "Tutor thread not found." }, { status: 404, headers: noStore });
    if (error.code === "VERSION_CONFLICT") {
      return NextResponse.json({ error: "Tutor thread changed in another tab.", code: error.code, current: error.current }, { status: 409, headers: noStore });
    }
    if (error.code === "INVALID_CURSOR" || error.code === "INVALID_REQUEST") {
      return NextResponse.json({ error: "Tutor thread request is invalid.", code: error.code }, { status: 400, headers: noStore });
    }
  }
  return NextResponse.json({ error: "Tutor history is temporarily unavailable." }, { status: 503, headers: noStore });
}

export async function GET(request: NextRequest, context: { params: Promise<{ threadId: string }> }) {
  const authz = await requireAuth({ closedBookCapability: "ai_tutor" });
  if (!authz.session) return authz.response;
  const [params, query] = await Promise.all([
    context.params.then((value) => paramsSchema.safeParse(value)),
    Promise.resolve(querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()))),
  ]);
  if (!params.success || !query.success) return NextResponse.json({ error: "Tutor thread request is invalid." }, { status: 400, headers: noStore });
  try {
    return NextResponse.json(await readOwnedChatThread({
      userId: authz.session.user.id,
      threadId: params.data.threadId,
      limit: query.data.limit,
      cursor: query.data.cursor,
    }), { headers: noStore });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ threadId: string }> }) {
  const authz = await requireAuth({ closedBookCapability: "ai_tutor" });
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "learning_request_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const [params, body] = await Promise.all([
        context.params.then((value) => paramsSchema.safeParse(value)),
        request.json().catch(() => null).then((value) => mutationSchema.safeParse(value)),
      ]);
      if (!params.success || !body.success) return NextResponse.json({ error: "Tutor thread request is invalid." }, { status: 400, headers: noStore });
      try {
        return NextResponse.json({ thread: await setOwnedChatThreadStatus({
          userId: authz.session.user.id,
          threadId: params.data.threadId,
          status: body.data.status,
          expectedUpdatedAt: body.data.expectedUpdatedAt,
        }) }, { headers: noStore });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
