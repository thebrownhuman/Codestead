import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/lib/db/client";
import { learnerProfile, providerCredential, twoFactor } from "@/lib/db/schema";
import { requireAuth } from "@/lib/http/authz";
import {
  ENROLLMENT_DISCLOSURE_VERSION,
  getCurrentConsents,
  isCurrentConsentAccepted,
  REQUIRED_DISCLOSURE_PURPOSES,
} from "@/lib/privacy/consent";
import { isFreshMfa } from "@/lib/security/privileged-access";

export async function GET() {
  const authz = await requireAuth({ allowPending: true });
  if (!authz.session) return authz.response;
  const [profile] = await db
    .select()
    .from(learnerProfile)
    .where(eq(learnerProfile.userId, authz.session.user.id))
    .limit(1);
  const [nim] = await db
    .select({ id: providerCredential.id, status: providerCredential.status })
    .from(providerCredential)
    .where(
      and(
        eq(providerCredential.userId, authz.session.user.id),
        eq(providerCredential.provider, "nvidia_nim"),
        eq(providerCredential.status, "active"),
      ),
    )
    .limit(1);
  const [factor] = await db
    .select({ verified: twoFactor.verified })
    .from(twoFactor)
    .where(eq(twoFactor.userId, authz.session.user.id))
    .limit(1);
  const rawMfaVerifiedAt = (authz.session.session as { mfaVerifiedAt?: Date | string | null }).mfaVerifiedAt;
  const mfaVerifiedAt = rawMfaVerifiedAt instanceof Date
    ? rawMfaVerifiedAt
    : typeof rawMfaVerifiedAt === "string"
      ? new Date(rawMfaVerifiedAt)
      : null;
  const mfaEnabled = authz.account.twoFactorEnabled === true && factor?.verified === true;
  const currentConsents = await getCurrentConsents(authz.session.user.id);
  const disclosureAccepted = REQUIRED_DISCLOSURE_PURPOSES.every((purpose) =>
    isCurrentConsentAccepted(currentConsents, purpose)) &&
    isCurrentConsentAccepted(currentConsents, "provider:nvidia_nim");
  return NextResponse.json(
    {
      profile,
      account: {
        name: authz.session.user.name,
        timezone: authz.session.user.timezone,
      },
      requirements: {
        profileComplete: Boolean(profile?.selectedTracks.length) && disclosureAccepted,
        mfaEnabled,
        mfaFresh: mfaEnabled && isFreshMfa(mfaVerifiedAt),
        nimActive: Boolean(nim),
      },
      disclosureVersion: ENROLLMENT_DISCLOSURE_VERSION,
      consents: Object.fromEntries(
        [...currentConsents].map(([purpose, record]) => [purpose, {
          decision: record.decision,
          policyVersion: record.policyVersion,
          occurredAt: record.occurredAt.toISOString(),
        }]),
      ),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
