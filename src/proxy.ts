import { type NextRequest, NextResponse } from "next/server";

import { evaluateRequestOrigin } from "@/lib/security/request-origin-policy";

export function proxy(request: NextRequest) {
  const decision = evaluateRequestOrigin({
    method: request.method,
    headers: request.headers,
    appUrl: process.env.APP_URL,
    production: process.env.NODE_ENV === "production",
  });
  if (decision.allowed) return NextResponse.next();

  return NextResponse.json(
    { error: decision.code },
    {
      status: decision.status,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}

export const config = {
  matcher: ["/api/:path*"],
};
