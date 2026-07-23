import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/lib/db/client";
import { learnerProfile, providerCredential, twoFactor, user } from "@/lib/db/schema";
import { requireAuth } from "@/lib/http/authz";
import { learningService } from "@/lib/learning-service/runtime";
import { lockUserAuthority } from "@/lib/security/user-authority-lock";
import { withRateLimit } from "@/lib/security/rate-limit";
import {
  getCurrentConsents,
  isCurrentConsentAccepted,
  REQUIRED_DISCLOSURE_PURPOSES,
} from "@/lib/privacy/consent";

export async function POST() {
  const authz = await requireAuth({ allowPending: true });
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "onboarding_complete_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
  const [profile] = await db
    .select({ selectedTracks: learnerProfile.selectedTracks })
    .from(learnerProfile)
    .where(eq(learnerProfile.userId, authz.session.user.id))
    .limit(1);
  const [nim] = await db
    .select({ id: providerCredential.id })
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
  const currentConsents = await getCurrentConsents(authz.session.user.id);
  const disclosureAccepted = REQUIRED_DISCLOSURE_PURPOSES.every((purpose) =>
    isCurrentConsentAccepted(currentConsents, purpose)) &&
    isCurrentConsentAccepted(currentConsents, "provider:nvidia_nim");
  const missing = [
    ...(authz.account.mustChangePassword === true ? ["password_change"] : []),
    ...(!profile?.selectedTracks.length ? ["profile"] : []),
    ...(!disclosureAccepted ? ["current_disclosure"] : []),
    ...(!(authz.account.twoFactorEnabled === true && factor?.verified === true) ? ["mfa"] : []),
    ...(!nim ? ["nvidia_nim"] : []),
  ];
  if (missing.length) {
    return NextResponse.json({ error: "Onboarding requirements are incomplete.", missing }, { status: 409 });
  }
  const now = new Date();
  const accountAvailable = await db.transaction(async (tx) => {
    await lockUserAuthority(tx, authz.session.user.id);
    const [account] = await tx
      .select({ status: user.status })
      .from(user)
      .where(and(
        eq(user.id, authz.session.user.id),
        inArray(user.status, ["pending", "active"]),
      ))
      .limit(1);
    if (!account) return false;
    await tx
      .update(learnerProfile)
      .set({ onboardingStep: "complete", onboardingCompletedAt: now })
      .where(eq(learnerProfile.userId, authz.session.user.id));
    await tx
      .update(user)
      .set({ status: "active" })
      .where(and(
        eq(user.id, authz.session.user.id),
        inArray(user.status, ["pending", "active"]),
      ));
    return true;
  });
  if (!accountAvailable) {
    return NextResponse.json(
      { error: "This account is unavailable for onboarding changes.", code: "ACCOUNT_UNAVAILABLE" },
      { status: 409 },
    );
  }
      let planInitialization: {
        state: "ready" | "degraded" | "empty" | "unavailable";
        planCount: number;
        missingPublications: readonly string[];
      };
      try {
        const initialized = await learningService.initializePlans(
          authz.session.user.id,
          `onboarding-plans:${authz.session.user.id}`,
        );
        planInitialization = {
          state: initialized.state,
          planCount: initialized.plans.length,
          missingPublications: initialized.missingPublications,
        };
      } catch {
        // Onboarding/account activation is already durable. A transient planning
        // failure must not force the learner to repeat MFA or credential setup.
        planInitialization = {
          state: "unavailable",
          planCount: 0,
          missingPublications: [],
        };
      }
      return NextResponse.json({ ok: true, redirectTo: "/learn", planInitialization });
    },
  );
}
