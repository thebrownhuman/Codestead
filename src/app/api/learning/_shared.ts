import { NextResponse } from "next/server";
import type { ZodType } from "zod";

import { LearningServiceError } from "@/lib/learning-service";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

export function learningJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

export function secureLearningResponse(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(name, value);
  return response;
}

export async function parseLearningBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    throw new LearningServiceError(
      "INVALID_REQUEST",
      "Learning request fields are invalid.",
      400,
      { fields: parsed.error.issues.map((issue) => issue.path.join(".")).filter(Boolean).slice(0, 12) },
    );
  }
  return parsed.data;
}

export async function learningRoute<T>(work: () => Promise<T>, successStatus = 200): Promise<NextResponse> {
  try {
    return learningJson(await work(), successStatus);
  } catch (error) {
    if (error instanceof LearningServiceError) {
      return learningJson(
        { error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) },
        error.status,
      );
    }
    console.error("Adaptive learning route failed", error);
    return learningJson(
      { error: "Adaptive learning is temporarily unavailable.", code: "LEARNING_SERVICE_UNAVAILABLE" },
      503,
    );
  }
}
