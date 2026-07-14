import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  CareerGuidanceError,
  listCareerAdminCards,
  listCareerPrerequisiteCourses,
  mutateCareerCard,
} from "@/lib/career/service";
import { db } from "@/lib/db/client";
import { session } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { authorizePrivilegedAction, type PrivilegedAction } from "@/lib/security/privileged-access";
import { withRateLimit } from "@/lib/security/rate-limit";

const noStore = { "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" };
const marketSchema = z.object({
  claim: z.string().trim().min(10).max(1_000),
  sourceUrl: z.url().startsWith("https://"),
  region: z.string().trim().min(2).max(120),
  observedAt: z.iso.datetime({ offset: true }),
  reviewedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict();
const mutationSchema = z.object({
  requestId: z.uuid(),
  cardId: z.uuid().nullable(),
  expectedVersion: z.number().int().min(0),
  action: z.enum(["save", "publish", "retire"]),
  slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{2,79}$/),
  path: z.string().trim().min(2).max(120),
  technology: z.string().trim().min(1).max(120),
  title: z.string().trim().min(3).max(160),
  summary: z.string().trim().min(20).max(1_200),
  futureScope: z.string().trim().min(20).max(2_000),
  prerequisites: z.array(z.object({ courseId: z.uuid(), rationale: z.string().trim().min(8).max(500) }).strict()).max(50),
  market: marketSchema.nullable(),
  reason: z.string().trim().min(8).max(500),
}).strict();

function errorStatus(code: string) {
  if (code === "ADMIN_REQUIRED") return 403;
  if (code === "NOT_FOUND") return 404;
  if (code === "INVALID_REQUEST" || code === "PREREQUISITE_NOT_VERIFIED") return 400;
  return 409;
}

export async function GET() {
  const authz = await requireAdmin();
  if (!authz.session) return authz.response;
  try {
    const [cards, courses] = await Promise.all([listCareerAdminCards(), listCareerPrerequisiteCourses()]);
    return NextResponse.json({ cards, courses }, { headers: noStore });
  } catch {
    return NextResponse.json({ error: "Career guidance is temporarily unavailable." }, { status: 503, headers: noStore });
  }
}

export async function POST(request: NextRequest) {
  const authz = await requireAdmin();
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "career_mutation_admin", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const parsed = mutationSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400, headers: noStore });
      const privilegedAction: PrivilegedAction | null = parsed.data.action === "publish"
        ? "career.publish"
        : parsed.data.action === "retire"
          ? "career.retire"
          : null;
      if (privilegedAction) {
        let activeSession: { mfaVerifiedAt: Date | null } | undefined;
        try {
          [activeSession] = await db
            .select({ mfaVerifiedAt: session.mfaVerifiedAt })
            .from(session)
            .where(and(
              eq(session.id, authz.session.session.id),
              eq(session.userId, authz.session.user.id),
            ))
            .limit(1);
        } catch {
          return NextResponse.json(
            { error: "Career guidance mutation protection is temporarily unavailable." },
            { status: 503, headers: noStore },
          );
        }
        const gate = authorizePrivilegedAction({
          actorRole: authz.account.role,
          mfaVerifiedAt: activeSession?.mfaVerifiedAt,
          reason: parsed.data.reason,
          action: privilegedAction,
        });
        if (!gate.allowed) {
          await writeAuditEvent({
            actorUserId: authz.session.user.id,
            action: `career_card.${parsed.data.action}`,
            resourceType: "career_card",
            resourceId: parsed.data.cardId ?? parsed.data.slug,
            outcome: "denied",
            reason: parsed.data.reason,
            correlationId: parsed.data.requestId,
            metadata: { denialCode: gate.code, expectedVersion: parsed.data.expectedVersion },
          }).catch(() => undefined);
          return NextResponse.json({ error: gate.code }, { status: 403, headers: noStore });
        }
      }
      try {
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          action: `career_card.${parsed.data.action}`,
          resourceType: "career_card",
          resourceId: parsed.data.cardId ?? parsed.data.slug,
          outcome: "allowed",
          reason: parsed.data.reason,
          correlationId: parsed.data.requestId,
          metadata: { phase: "pre_mutation", expectedVersion: parsed.data.expectedVersion },
        });
      } catch {
        return NextResponse.json(
          { error: "Career guidance mutation protection is temporarily unavailable." },
          { status: 503, headers: noStore },
        );
      }
      try {
        const result = await mutateCareerCard({
          ...parsed.data,
          actorUserId: authz.session.user.id,
          market: parsed.data.market ? {
            ...parsed.data.market,
            observedAt: new Date(parsed.data.market.observedAt),
            reviewedAt: new Date(parsed.data.market.reviewedAt),
            expiresAt: new Date(parsed.data.market.expiresAt),
          } : null,
        });
        const completionAuditRecorded = await writeAuditEvent({
          actorUserId: authz.session.user.id,
          action: `career_card.${result.event}`,
          resourceType: "career_card",
          resourceId: result.cardId,
          outcome: "success",
          reason: parsed.data.reason,
          correlationId: parsed.data.requestId,
          metadata: { rowVersion: result.rowVersion, replayed: result.replayed, prerequisiteCount: parsed.data.prerequisites.length, marketClaimIncluded: Boolean(parsed.data.market) },
        }).then(() => true).catch(() => false);
        const cardsResult = await listCareerAdminCards()
          .then((cards) => ({ cards, readWarning: null as string | null }))
          .catch(() => ({ cards: null, readWarning: "The change completed, but the refreshed card list is temporarily unavailable." }));
        const warnings = [
          ...(completionAuditRecorded ? [] : ["The change completed, but its completion audit needs operator reconciliation. Do not repeat the request."]),
          ...(cardsResult.readWarning ? [cardsResult.readWarning] : []),
        ];
        return NextResponse.json({
          result,
          cards: cardsResult.cards,
          completionAuditRecorded,
          ...(warnings.length ? { warning: warnings.join(" ") } : {}),
        }, { status: result.event === "created" ? 201 : 200, headers: noStore });
      } catch (error) {
        const code = error instanceof CareerGuidanceError ? error.code : "CAREER_MUTATION_FAILED";
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          action: `career_card.${parsed.data.action}`,
          resourceType: "career_card",
          resourceId: parsed.data.cardId ?? parsed.data.slug,
          outcome: "failure",
          reason: parsed.data.reason,
          correlationId: parsed.data.requestId,
          metadata: { errorCode: code, expectedVersion: parsed.data.expectedVersion },
        }).catch(() => undefined);
        return NextResponse.json({ error: code }, { status: errorStatus(code), headers: noStore });
      }
    },
  );
}
