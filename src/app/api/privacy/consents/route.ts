import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { consentRecord, user } from "@/lib/db/schema";
import { requireAuth } from "@/lib/http/authz";
import {
  consentInsert,
  DATA_CATEGORIES,
  ENROLLMENT_DISCLOSURES,
  ENROLLMENT_DISCLOSURE_VERSION,
  getCurrentConsents,
  getCurrentConsentsFrom,
  isConsentPurpose,
  isCurrentConsentAccepted,
  isWithdrawablePurpose,
  OPTIONAL_CONSENT_PURPOSES,
  type ConsentPurpose,
} from "@/lib/privacy/consent";
import { lockUserAuthority } from "@/lib/security/user-authority-lock";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";
import { withdrawCohortProfileForConsent } from "@/lib/social/profile-service";

const bodySchema = z.object({
  requestId: z.string().uuid(),
  purpose: z.string().trim().min(2).max(100),
  decision: z.enum(["accepted", "withdrawn"]),
  policyVersion: z.literal(ENROLLMENT_DISCLOSURE_VERSION),
});

export async function GET() {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const current = await getCurrentConsents(authz.session.user.id);
  return NextResponse.json(
    {
      policyVersion: ENROLLMENT_DISCLOSURE_VERSION,
      requiredDisclosures: ENROLLMENT_DISCLOSURES,
      optionalPurposes: OPTIONAL_CONSENT_PURPOSES.map((purpose) => ({
        purpose,
        dataCategories: DATA_CATEGORIES[purpose],
      })),
      current: Object.fromEntries(
        [...current].filter(([purpose]) => isConsentPurpose(purpose)).map(([purpose, record]) => [
          purpose,
          {
            decision: record.decision,
            policyVersion: record.policyVersion,
            dataCategories: record.dataCategories,
            occurredAt: record.occurredAt.toISOString(),
            currentVersionAccepted: isCurrentConsentAccepted(current, purpose as ConsentPurpose),
          },
        ]),
      ),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function POST(request: NextRequest) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "privacy_consent_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const body = bodySchema.safeParse(await request.json().catch(() => null));
      if (!body.success || !isConsentPurpose(body.data.purpose)) {
        return NextResponse.json({ error: "Choose a supported consent purpose and decision." }, { status: 400 });
      }
      const purpose: ConsentPurpose = body.data.purpose;
      if (!isWithdrawablePurpose(purpose)) {
        return NextResponse.json(
          {
            error: "This record is a core service disclosure. Disable the related optional routing or request account deletion instead.",
          },
          { status: 409 },
        );
      }
      const mutation = await db.transaction(async (tx) => {
        await lockUserAuthority(tx, authz.session.user.id);
        const [account] = await tx
          .select({ status: user.status })
          .from(user)
          .where(eq(user.id, authz.session.user.id))
          .limit(1);
        if (account?.status !== "active") {
          return { outcome: "unavailable" as const, inserted: [], purposes: [] as string[] };
        }
        const current = await getCurrentConsentsFrom(tx, authz.session.user.id);
        if (
          purpose === "leaderboard" &&
          body.data.decision === "accepted" &&
          !isCurrentConsentAccepted(current, "cohort_profile")
        ) return { outcome: "conflict" as const, inserted: [], purposes: [] as string[] };
        // Timestamp after acquiring the authority lock so the append-only
        // current-decision ordering matches serialized commit authority.
        const occurredAt = new Date();
        const decisions = [consentInsert({
          userId: authz.session.user.id,
          purpose,
          decision: body.data.decision,
          source: "settings",
          requestId: body.data.requestId,
          occurredAt,
        })];
        if (purpose === "cohort_profile" && body.data.decision === "withdrawn") {
          decisions.push(consentInsert({
            userId: authz.session.user.id,
            purpose: "leaderboard",
            decision: "withdrawn",
            source: "settings",
            requestId: `${body.data.requestId}:cascade`,
            occurredAt,
          }));
        }
        const inserted = await tx
          .insert(consentRecord)
          .values(decisions)
          .onConflictDoNothing({ target: consentRecord.idempotencyKey })
          .returning({ id: consentRecord.id, purpose: consentRecord.purpose });
        return {
          outcome: "applied" as const,
          inserted,
          purposes: decisions.map((decision) => decision.purpose),
        };
      });
      if (mutation.outcome === "unavailable") {
        return NextResponse.json(
          { error: "This account is unavailable for consent changes.", code: "ACCOUNT_UNAVAILABLE" },
          { status: 409 },
        );
      }
      if (mutation.outcome === "conflict") {
        return NextResponse.json(
          { error: "Enable the cohort profile before joining the leaderboard." },
          { status: 409 },
        );
      }
      const { inserted } = mutation;
      if (body.data.purpose === "cohort_profile" && body.data.decision === "withdrawn") {
        await withdrawCohortProfileForConsent({
          userId: authz.session.user.id,
          consentRequestId: body.data.requestId,
        });
      }
      await writeAuditEvent({
        actorUserId: authz.session.user.id,
        subjectUserId: authz.session.user.id,
        action: `consent.${body.data.decision}`,
        resourceType: "consent",
        resourceId: body.data.purpose,
        outcome: "success",
        metadata: {
          policyVersion: ENROLLMENT_DISCLOSURE_VERSION,
          purposes: mutation.purposes,
          replayed: inserted.length === 0,
        },
      });
      return NextResponse.json(
        {
          ok: true,
          replayed: inserted.length === 0,
          purpose: body.data.purpose,
          decision: body.data.decision,
          effectiveForFutureProcessing: true,
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    },
  );
}
