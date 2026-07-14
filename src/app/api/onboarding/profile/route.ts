import { and, eq, inArray, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { consentRecord, learnerProfile, user } from "@/lib/db/schema";
import { requireAuth } from "@/lib/http/authz";
import {
  consentInsert,
  ENROLLMENT_DISCLOSURE_VERSION,
  REQUIRED_DISCLOSURE_PURPOSES,
} from "@/lib/privacy/consent";
import { INTEREST_CATEGORIES } from "@/lib/profile/interests";
import { lockUserAuthority } from "@/lib/security/user-authority-lock";

const allowedTracks = [
  "programming-foundations",
  "c",
  "cpp",
  "java",
  "python",
  "html",
  "css",
  "javascript",
  "react",
  "dsa",
  "git-tooling",
  "ai",
] as const;

const profileSchema = z.object({
  requestId: z.string().uuid(),
  disclosureVersion: z.literal(ENROLLMENT_DISCLOSURE_VERSION),
  acknowledgements: z.object({
    adult18Plus: z.literal(true),
    mentorVisibility: z.literal(true),
    externalAiRouting: z.literal(true),
    serverCodeExecution: z.literal(true),
    retentionPolicy: z.literal(true),
    inactivityMentorNotice: z.literal(true),
    nvidiaNimProvider: z.literal(true),
  }),
  optionalConsents: z.object({
    cohortProfile: z.boolean(),
    leaderboard: z.boolean(),
    adminFallbackAi: z.boolean(),
  }),
  name: z.string().trim().min(2).max(80),
  level: z.enum(["beginner", "some_experience", "intermediate", "advanced"]),
  preferredSessionMinutes: z.number().int().min(10).max(120),
  weeklyGoalMinutes: z.number().int().min(30).max(1_260),
  goal: z.string().trim().min(3).max(300),
  hobbies: z.array(z.object({
    label: z.string().trim().min(2).max(50),
    category: z.enum(INTEREST_CATEGORIES),
    confirmed: z.literal(true),
  })).max(8),
  analogyFrequency: z.enum(["neutral", "helpful", "frequent"]),
  selectedTracks: z.array(z.enum(allowedTracks)).min(1).max(12),
  dsaLanguage: z.enum(["c", "cpp", "java", "python"]).optional(),
  timezone: z.string().trim().min(3).max(80),
});

export async function POST(request: NextRequest) {
  const authz = await requireAuth({ allowPending: true });
  if (!authz.session) return authz.response;
  const body = profileSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json(
      { error: "Please complete your profile and select at least one track." },
      { status: 400 },
    );
  }
  if (body.data.selectedTracks.includes("dsa") && !body.data.dsaLanguage) {
    return NextResponse.json({ error: "Choose one implementation language for DSA." }, { status: 400 });
  }
  if (body.data.optionalConsents.leaderboard && !body.data.optionalConsents.cohortProfile) {
    return NextResponse.json(
      { error: "Leaderboard sharing requires the cohort profile opt-in." },
      { status: 400 },
    );
  }
  const interests = body.data.hobbies;
  const now = new Date();
  const consentDecisions = [
    ...REQUIRED_DISCLOSURE_PURPOSES.map((purpose) => consentInsert({
      userId: authz.session.user.id,
      purpose,
      decision: "accepted",
      source: "onboarding",
      requestId: body.data.requestId,
      occurredAt: now,
    })),
    consentInsert({
      userId: authz.session.user.id,
      purpose: "provider:nvidia_nim",
      decision: "accepted",
      source: "onboarding",
      requestId: body.data.requestId,
      occurredAt: now,
    }),
    consentInsert({
      userId: authz.session.user.id,
      purpose: "cohort_profile",
      decision: body.data.optionalConsents.cohortProfile ? "accepted" : "withdrawn",
      source: "onboarding",
      requestId: body.data.requestId,
      occurredAt: now,
    }),
    consentInsert({
      userId: authz.session.user.id,
      purpose: "leaderboard",
      decision: body.data.optionalConsents.leaderboard ? "accepted" : "withdrawn",
      source: "onboarding",
      requestId: body.data.requestId,
      occurredAt: now,
    }),
    consentInsert({
      userId: authz.session.user.id,
      purpose: "admin_fallback_ai",
      decision: body.data.optionalConsents.adminFallbackAi ? "accepted" : "withdrawn",
      source: "onboarding",
      requestId: body.data.requestId,
      occurredAt: now,
    }),
  ];
  const persisted = await db.transaction(async (tx) => {
    await lockUserAuthority(tx, authz.session.user.id);
    const [account] = await tx
      .select({ status: user.status })
      .from(user)
      .where(and(
        eq(user.id, authz.session.user.id),
        inArray(user.status, ["pending", "active"]),
      ))
      .limit(1);
    if (!account || !["pending", "active"].includes(account.status)) return false;
    await tx
      .update(user)
      .set({
        name: body.data.name,
        timezone: body.data.timezone,
        adultConfirmedAt: sql`coalesce(${user.adultConfirmedAt}, ${now})`,
      })
      .where(eq(user.id, authz.session.user.id));
    await tx
      .insert(learnerProfile)
      .values({
        userId: authz.session.user.id,
        selfReportedLevel: body.data.level,
        preferredSessionMinutes: body.data.preferredSessionMinutes,
        weeklyGoalMinutes: body.data.weeklyGoalMinutes,
        analogyFrequency: body.data.analogyFrequency,
        analogyInterests: interests,
        learningGoals: [body.data.goal],
        selectedTracks: body.data.selectedTracks,
        dsaLanguage: body.data.dsaLanguage,
        onboardingStep: "mfa",
      })
      .onConflictDoUpdate({
        target: learnerProfile.userId,
        set: {
          selfReportedLevel: body.data.level,
          preferredSessionMinutes: body.data.preferredSessionMinutes,
          weeklyGoalMinutes: body.data.weeklyGoalMinutes,
          analogyFrequency: body.data.analogyFrequency,
          analogyInterests: interests,
          learningGoals: [body.data.goal],
          selectedTracks: body.data.selectedTracks,
          dsaLanguage: body.data.dsaLanguage,
          onboardingStep: "mfa",
          updatedAt: new Date(),
        },
      });
    await tx
      .insert(consentRecord)
      .values(consentDecisions)
      .onConflictDoNothing({ target: consentRecord.idempotencyKey });
    return true;
  });
  if (!persisted) {
    return NextResponse.json(
      { error: "This account is unavailable for onboarding changes.", code: "ACCOUNT_UNAVAILABLE" },
      { status: 409 },
    );
  }
  return NextResponse.json({
    ok: true,
    interests,
    disclosureVersion: ENROLLMENT_DISCLOSURE_VERSION,
  });
}
