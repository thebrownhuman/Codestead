import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createDraftCacheNamespace } from "@/lib/drafts/cache-namespace";
import {
  DraftIdempotencyMismatchError,
  DraftQuotaExceededError,
  DraftScopeUnavailableError,
  DraftVersionConflictError,
  learnerDraftRepository,
} from "@/lib/drafts/repository";
import { DRAFT_CONTENT_MAX_BYTES } from "@/lib/drafts/types";
import { requireAuth } from "@/lib/http/authz";
import { withRateLimit } from "@/lib/security/rate-limit";

const keyFields = {
  kind: z.enum(["code", "lesson"]),
  courseId: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9._:-]+$/),
  skillId: z.string().trim().min(1).max(180).regex(/^[a-zA-Z0-9._:-]+$/),
} as const;

const languageValue = z.string().trim().min(1).max(40).regex(/^[a-zA-Z0-9_+.-]+$/);

function validateLanguageFacet(
  value: { kind: "code" | "lesson"; language: string | null },
  context: z.RefinementCtx,
) {
  if ((value.kind === "code") !== (value.language !== null)) {
    context.addIssue({
      code: "custom",
      path: ["language"],
      message: "Code drafts require a language; lesson drafts must not have one.",
    });
  }
}

const querySchema = z.object({
  ...keyFields,
  language: z.string().max(40).transform((value, context) => {
    if (value.trim() === "") return null;
    const parsed = languageValue.safeParse(value);
    if (!parsed.success) {
      context.addIssue({ code: "custom", message: "The draft language is invalid." });
      return z.NEVER;
    }
    return parsed.data;
  }),
}).strict().superRefine(validateLanguageFacet);
const bodySchema = z.object({
  ...keyFields,
  content: z.string()
    .max(DRAFT_CONTENT_MAX_BYTES)
    .refine((value) => Buffer.byteLength(value, "utf8") <= DRAFT_CONTENT_MAX_BYTES),
  language: languageValue.nullable(),
  expectedRowVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  requestId: z.string().uuid(),
}).strict().superRefine(validateLanguageFacet);

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function cacheNamespace(authz: { session: { user: { id: string }; session: { id: string } } }) {
  return createDraftCacheNamespace(authz.session.user.id, authz.session.session.id);
}

export async function GET(request: NextRequest) {
  const authz = await requireAuth({ closedBookCapability: "learning_workspace" });
  if (!authz.session) return authz.response;
  const query = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) {
    return json({ error: "A valid draft kind, course, and skill are required.", code: "INVALID_DRAFT_KEY" }, 400);
  }
  try {
    const draft = await learnerDraftRepository.load(authz.session.user.id, query.data);
    return json({ draft, cacheNamespace: cacheNamespace(authz) });
  } catch (error) {
    if (error instanceof DraftScopeUnavailableError) {
      return json({ error: "The draft scope is unavailable.", code: error.code }, 404);
    }
    return json({ error: "The server draft could not be loaded.", code: "DRAFT_STORE_UNAVAILABLE" }, 503);
  }
}

export async function PUT(request: NextRequest) {
  const authz = await requireAuth({ closedBookCapability: "learning_workspace" });
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "draft_sync_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const body = bodySchema.safeParse(await request.json().catch(() => null));
      if (!body.success) {
        return json({ error: "The draft mutation is invalid or too large.", code: "INVALID_DRAFT_MUTATION" }, 400);
      }
      try {
        const result = await learnerDraftRepository.save({
          ...body.data,
          userId: authz.session.user.id,
        });
        return json({ ...result, cacheNamespace: cacheNamespace(authz) });
      } catch (error) {
        if (error instanceof DraftVersionConflictError) {
          return json({
            error: error.message,
            code: error.code,
            current: error.current,
            cacheNamespace: cacheNamespace(authz),
          }, 409);
        }
        if (error instanceof DraftIdempotencyMismatchError) {
          return json({ error: error.message, code: error.code }, 409);
        }
        if (error instanceof DraftScopeUnavailableError) {
          return json({ error: "The draft scope is unavailable.", code: error.code }, 404);
        }
        if (error instanceof DraftQuotaExceededError) {
          return json({
            error: error.message,
            code: error.code,
            limit: error.limit,
          }, 409);
        }
        return json({ error: "The server draft could not be saved.", code: "DRAFT_STORE_UNAVAILABLE" }, 503);
      }
    },
  );
}
