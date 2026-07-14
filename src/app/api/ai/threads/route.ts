import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ChatThreadLifecycleError, listOwnedChatThreads } from "@/lib/ai/chat-lifecycle";
import { requireAuth } from "@/lib/http/authz";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().max(500).optional(),
  includeArchived: z.enum(["true", "false"]).optional(),
}).strict();

const noStore = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(request: NextRequest) {
  const authz = await requireAuth({ closedBookCapability: "ai_tutor" });
  if (!authz.session) return authz.response;
  const query = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));
  if (!query.success) return NextResponse.json({ error: "Thread query is invalid." }, { status: 400, headers: noStore });
  try {
    return NextResponse.json(await listOwnedChatThreads({
      userId: authz.session.user.id,
      limit: query.data.limit,
      cursor: query.data.cursor,
      includeArchived: query.data.includeArchived === "true",
    }), { headers: noStore });
  } catch (error) {
    if (error instanceof ChatThreadLifecycleError && (error.code === "INVALID_CURSOR" || error.code === "INVALID_REQUEST")) {
      return NextResponse.json({ error: "Thread query is invalid.", code: error.code }, { status: 400, headers: noStore });
    }
    return NextResponse.json({ error: "Tutor history is temporarily unavailable." }, { status: 503, headers: noStore });
  }
}
