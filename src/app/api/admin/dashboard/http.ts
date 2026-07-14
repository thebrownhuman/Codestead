import { NextResponse } from "next/server";

export const ADMIN_NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

export function adminJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: ADMIN_NO_STORE_HEADERS });
}

export function secureAdminResponse(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(ADMIN_NO_STORE_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}
