import { type NextRequest } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/http/authz";

import { examError, examJson } from "../../_lib/http";
import { submitExamAppeal } from "../../_lib/service";

const appealSchema = z.object({
  clientRequestId: z.string().uuid(),
  category: z.enum(["scoring", "technical", "integrity", "accessibility"]),
  reason: z.string().trim().min(20).max(1_000),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const body = appealSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return examJson({ error: "Give a concise reason for the appeal.", code: "INVALID_APPEAL" }, { status: 400 });
  }
  const { sessionId } = await params;
  try {
    return examJson(await submitExamAppeal({
      userId: authz.session.user.id,
      sessionId,
      ...body.data,
    }), { status: 202 });
  } catch (error) {
    return examError(error);
  }
}
