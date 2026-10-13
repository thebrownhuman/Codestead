import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/http/authz";
import { brokerControl, interactiveEnabled, InteractiveError, withInteractiveAuthority } from "@/lib/runner/interactive-control";
import { brokerSecret, canonicalOrigin, sameOrigin, verifyEnvelope } from "@/lib/runner/interactive-protocol.mjs";

export const runtime = "nodejs";
export async function GET(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  if (!interactiveEnabled()) return new NextResponse(null, { status: 404 });
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  if (!sameOrigin(request.headers, canonicalOrigin(process.env.APP_URL, process.env.NODE_ENV === "production"))) {
    return NextResponse.json({ code: "ORIGIN_REJECTED" }, { status: 403 });
  }
  try {
    const { sessionId } = await params;
    const proof = verifyEnvelope(brokerSecret(), "authorize", request.headers.get("x-interactive-proof"));
    if (proof.sessionId !== sessionId || proof.userId !== authz.session.user.id
      || proof.authSessionId !== authz.session.session.id || !["activate", "check"].includes(String(proof.action))) {
      return NextResponse.json({ code: "SESSION_NOT_FOUND" }, { status: 404 });
    }
    await withInteractiveAuthority(authz.session.user.id, authz.session.session.id, async () => {
      if (proof.action === "activate") await brokerControl({ action: "activate", sessionId,
        userId: authz.session!.user.id, authSessionId: authz.session!.session.id });
    });
    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const failure = error instanceof InteractiveError ? error : new InteractiveError("AUTH_REQUIRED", 403);
    return NextResponse.json({ code: failure.code }, { status: failure.status });
  }
}
