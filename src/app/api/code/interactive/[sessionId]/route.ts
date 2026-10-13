import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/http/authz";
import { brokerControl, interactiveEnabled, InteractiveError } from "@/lib/runner/interactive-control";
import { canonicalOrigin, sameOrigin } from "@/lib/runner/interactive-protocol.mjs";

export const runtime = "nodejs";
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  if (!interactiveEnabled()) return new NextResponse(null, { status: 404 });
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  if (!sameOrigin(request.headers, canonicalOrigin(process.env.APP_URL, process.env.NODE_ENV === "production"))) {
    return NextResponse.json({ code: "ORIGIN_REJECTED" }, { status: 403 });
  }
  try {
    const { sessionId } = await params;
    await brokerControl({ action: "cancel", sessionId, userId: authz.session.user.id, authSessionId: authz.session.session.id });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    const failure = error instanceof InteractiveError ? error : new InteractiveError("BROKER_UNAVAILABLE");
    return NextResponse.json({ code: failure.code }, { status: failure.status });
  }
}
