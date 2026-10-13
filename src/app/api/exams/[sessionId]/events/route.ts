import { readBoundedJson } from "@/lib/http/bounded-json";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/http/authz";

import { CLIENT_EXAM_EVENT_TYPES } from "../../_lib/contracts";
import { examError, examJson } from "../../_lib/http";
import { recordExamEvent } from "../../_lib/service";

const eventSchema = z.object({
  clientEventId: z.string().uuid(),
  type: z.enum(CLIENT_EXAM_EVENT_TYPES),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const jsonBody = await readBoundedJson(request);
  if (jsonBody.response?.status === 413) return jsonBody.response;
  const body = eventSchema.safeParse(jsonBody.value);
  if (!body.success || JSON.stringify(body.data.metadata).length > 4_096) {
    return examJson({ error: "Integrity event is invalid.", code: "INVALID_EXAM_EVENT" }, { status: 400 });
  }
  const { sessionId } = await params;
  try {
    return examJson(await recordExamEvent({
      userId: authz.session.user.id,
      sessionId,
      ...body.data,
    }));
  } catch (error) {
    return examError(error);
  }
}
