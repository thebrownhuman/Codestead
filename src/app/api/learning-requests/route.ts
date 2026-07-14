import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/http/authz";
import {
  LearningRequestRepositoryError,
  learningRequestRepository,
} from "@/lib/learning-requests/repository";
import { withRateLimit } from "@/lib/security/rate-limit";
import { containsCredentialOrHiddenEvidence } from "@/lib/security/sensitive-text";

const createSchema = z.object({
  requestId: z.uuid(),
  kind: z.enum(["new-subject", "topic-extension", "content-defect"]),
  subject: z.string().trim().min(2).max(120),
  details: z.string().trim().min(10).max(2_000),
}).strict();

const noStoreHeaders = { "Cache-Control": "private, no-store" } as const;

function repositoryErrorResponse(error: unknown) {
  if (error instanceof LearningRequestRepositoryError) {
    if (error.code === "INVALID_REQUEST_ID") {
      return NextResponse.json(
        { error: "Choose a valid request identifier.", code: "LEARNING_REQUEST_INVALID_ID" },
        { status: 400, headers: noStoreHeaders },
      );
    }
    if (error.code === "IDEMPOTENCY_MISMATCH") {
      return NextResponse.json(
        {
          error: "This request retry used different content. Edit the request and try again.",
          code: "LEARNING_REQUEST_IDEMPOTENCY_MISMATCH",
        },
        { status: 409, headers: noStoreHeaders },
      );
    }
    return NextResponse.json(
      {
        error: "The request could not be recorded. Try again.",
        code: "LEARNING_REQUEST_WRITE_UNAVAILABLE",
      },
      { status: 503, headers: noStoreHeaders },
    );
  }
  return NextResponse.json(
    { error: "Requests are temporarily unavailable. Try again.", code: "LEARNING_REQUESTS_UNAVAILABLE" },
    { status: 503, headers: noStoreHeaders },
  );
}

export async function GET() {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  try {
    const requests = await learningRequestRepository.listForUser(authz.session.user.id);
    return NextResponse.json({ requests }, { headers: noStoreHeaders });
  } catch (error) {
    return repositoryErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;

  const body = createSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json(
      {
        error: "Choose a request type and provide a clear subject and description.",
        code: "LEARNING_REQUEST_INVALID_INPUT",
      },
      { status: 400, headers: noStoreHeaders },
    );
  }

  if (
    containsCredentialOrHiddenEvidence(body.data.subject)
    || containsCredentialOrHiddenEvidence(body.data.details)
  ) {
    return NextResponse.json(
      {
        error: "Remove credentials or private grading material before sending this request.",
        code: "LEARNING_REQUEST_SENSITIVE_INPUT",
      },
      { status: 400, headers: noStoreHeaders },
    );
  }

  const input = { userId: authz.session.user.id, ...body.data };
  try {
    const replay = await learningRequestRepository.findReplay(input);
    if (replay) {
      return NextResponse.json(
        { request: replay, replayed: true },
        { status: 200, headers: noStoreHeaders },
      );
    }
  } catch (error) {
    return repositoryErrorResponse(error);
  }

  return withRateLimit(
    { policy: "learning_request_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      try {
        const result = await learningRequestRepository.create(input);
        return NextResponse.json(
          result,
          { status: result.replayed ? 200 : 201, headers: noStoreHeaders },
        );
      } catch (error) {
        return repositoryErrorResponse(error);
      }
    },
  );
}
