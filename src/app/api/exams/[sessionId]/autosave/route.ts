import { type NextRequest } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/http/authz";

import { SUPPORTED_EXAM_LANGUAGES } from "../../_lib/contracts";
import { examError, examJson } from "../../_lib/http";
import { autosaveExamAnswer } from "../../_lib/service";

const autosaveSchema = z.object({
  clientMutationId: z.uuid(),
  itemId: z.string().trim().min(3).max(180),
  baseRevision: z.number().int().min(0).max(1_000_000),
  answer: z.object({
    text: z.string().max(32_000).optional(),
    sourceCode: z.string().max(131_072).optional(),
    language: z.enum(SUPPORTED_EXAM_LANGUAGES).optional(),
  }).strict(),
}).strict();

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const body = autosaveSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return examJson({ error: "Autosave payload is invalid.", code: "INVALID_AUTOSAVE" }, { status: 400 });
  }
  const { sessionId } = await params;
  try {
    const saved = await autosaveExamAnswer({
      userId: authz.session.user.id,
      sessionId,
      ...body.data,
    });
    return examJson({ saved });
  } catch (error) {
    return examError(error);
  }
}
