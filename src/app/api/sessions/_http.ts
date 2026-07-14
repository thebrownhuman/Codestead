import { NextResponse } from "next/server";

export const SESSION_NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

export function sessionJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: SESSION_NO_STORE_HEADERS });
}

export function secureSessionResponse(response: NextResponse) {
  for (const [name, value] of Object.entries(SESSION_NO_STORE_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}
