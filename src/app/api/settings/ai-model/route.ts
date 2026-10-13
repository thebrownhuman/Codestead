import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/http/authz";
import { loadLearnerModelSettings, ModelChoiceError, saveLearnerModelChoice } from "@/lib/ai/learner-model-choice-store";
import { evaluateRequestOrigin } from "@/lib/security/request-origin-policy";
import { withRateLimit } from "@/lib/security/rate-limit";

const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const schema = z.object({ key: z.uuid().nullable() }).strict();
function failed(error: unknown) {
  return NextResponse.json({ error: error instanceof ModelChoiceError ? error.message : "AI model settings are temporarily unavailable." }, { status: error instanceof ModelChoiceError ? 400 : 503, headers });
}
export async function GET() {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  try { return NextResponse.json(await loadLearnerModelSettings(authz.session.user.id), { headers }); }
  catch (error) { return failed(error); }
}
export async function PATCH(request: NextRequest) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const originHeaders = new Headers(request.headers);
  if (!originHeaders.has("cookie")) originHeaders.set("cookie", "session-route=1");
  const origin = evaluateRequestOrigin({ method: request.method, headers: originHeaders, appUrl: process.env.APP_URL, production: process.env.NODE_ENV === "production" });
  if (!origin.allowed) return NextResponse.json({ error: origin.code }, { status: origin.status, headers });
  return withRateLimit({ policy: "social_profile_user", identity: { kind: "user", value: authz.session.user.id } }, async () => {
    let value: unknown = null;
    const reader = request.body?.getReader();
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 4096) {
          void reader.cancel().catch(() => undefined);
          return NextResponse.json({ error: "Request body is too large." }, { status: 413, headers });
        }
        chunks.push(part.value);
      }
      value = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
    } catch { value = null; }
    finally { reader?.releaseLock(); }
    const body = schema.safeParse(value);
    if (!body.success) return NextResponse.json({ error: "Choose a model or use the default." }, { status: 400, headers });
    try {
      await saveLearnerModelChoice(authz.session.user.id, body.data.key);
      return NextResponse.json(await loadLearnerModelSettings(authz.session.user.id), { headers });
    } catch (error) { return failed(error); }
  });
}
