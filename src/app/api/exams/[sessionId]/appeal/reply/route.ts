import { type NextRequest } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/http/authz";

import { examError, examJson } from "../../../_lib/http";
import { submitExamAppealReply } from "../../../_lib/service";

const replySchema = z.object({
  clientRequestId: z.uuid(),
  message: z.string().trim().min(20).max(2_000),
}).strict();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const body = replySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return examJson({
      error: "Give the reviewer a reply from 20 to 2000 characters.",
      code: "INVALID_APPEAL_REPLY",
    }, { status: 400 });
  }
  const { sessionId } = await params;
  try {
    return examJson(await submitExamAppealReply({
      userId: authz.session.user.id,
      sessionId,
      ...body.data,
    }), { status: 202 });
  } catch (error) {
    return examError(error);
  }
}
