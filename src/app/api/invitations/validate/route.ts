import { NextRequest, NextResponse } from "next/server";

import { findUsableInvitationByToken } from "@/lib/security/invitation-store";
import { rateLimitIp, withRateLimit } from "@/lib/security/rate-limit";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  return withRateLimit(
    [
      { policy: "invitation_validate_ip", identity: { kind: "ip", value: rateLimitIp(request) } },
      { policy: "invitation_validate_token", identity: { kind: "invitation", value: token } },
    ],
    async () => {
      if (token.length < 32) return NextResponse.json({ valid: false }, { status: 400 });
      const record = await findUsableInvitationByToken(token);
      if (!record) return NextResponse.json({ valid: false }, { status: 404 });
      return NextResponse.json({ valid: true, email: record.email, expiresAt: record.expiresAt });
    },
  );
}
