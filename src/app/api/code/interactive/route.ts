import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/http/authz";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { withRateLimit } from "@/lib/security/rate-limit";
import pistonInputs from "../../../../../infra/piston/image-inputs.lock.json";
import { brokerControl, interactiveEnabled, InteractiveError, withInteractiveAuthority } from "@/lib/runner/interactive-control";
import { canonicalOrigin, LIMITS, practiceInput, sameOrigin } from "@/lib/runner/interactive-protocol.mjs";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  if (!interactiveEnabled()) return new NextResponse(null, { status: 404 });
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const origin = canonicalOrigin(process.env.APP_URL, process.env.NODE_ENV === "production");
  if (!sameOrigin(request.headers, origin)) return NextResponse.json({ code: "ORIGIN_REJECTED" }, { status: 403 });
  return withRateLimit([
    { policy: "code_run_minute", identity: { kind: "user", value: authz.session.user.id } },
    { policy: "code_run_hour", identity: { kind: "user", value: authz.session.user.id } },
  ], async () => {
    const body = await readBoundedJson(request, LIMITS.frameBytes);
    if (body.response) return body.response;
    try {
      const init = practiceInput(body.value, pistonInputs.runtimes);
      const result = await withInteractiveAuthority(authz.session!.user.id, authz.session!.session.id, () => brokerControl({
        action: "create", userId: authz.session!.user.id, authSessionId: authz.session!.session.id, origin, init,
      }));
      return NextResponse.json({ ...result, officialMasteryEvidence: false }, {
        status: 201, headers: { "Cache-Control": "private, no-store" },
      });
    } catch (error) {
      const failure = error instanceof InteractiveError ? error : new InteractiveError("PRACTICE_ONLY", 400);
      return NextResponse.json({ code: failure.code }, { status: failure.status, headers: { "Cache-Control": "private, no-store" } });
    }
  });
}
