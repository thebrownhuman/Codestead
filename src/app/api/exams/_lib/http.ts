import { NextResponse } from "next/server";

import { ExamServiceError } from "./service";

export function examJson(value: unknown, init?: ResponseInit): NextResponse {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(value, { ...init, headers });
}

export function examError(error: unknown): NextResponse {
  if (error instanceof ExamServiceError) {
    return examJson(
      { error: error.message, code: error.code, ...error.details },
      { status: error.status },
    );
  }
  return examJson(
    { error: "The exam service could not complete this request.", code: "EXAM_SERVICE_FAILURE" },
    { status: 500 },
  );
}
