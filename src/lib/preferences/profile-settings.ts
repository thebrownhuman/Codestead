import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { db, pool } from "@/lib/db/client";
import { learnerProfile, user } from "@/lib/db/schema";
import { lockUserAuthority } from "@/lib/security/user-authority-lock";
import { loadOwnCohortSettings, SocialProfileError, updateCohortProfileInTransaction } from "@/lib/social/profile-service";
import { ProfileSettingsError, type LearningProfile, type ProfileSettingsInput } from "./profile-settings-values";

type CohortSettings = Awaited<ReturnType<typeof loadOwnCohortSettings>>;
function visibility(settings: CohortSettings | null): LearningProfile["cohortVisibility"] {
  if (!settings?.live) return "hidden";
  return settings.profile.showBio || settings.profile.showStreak || settings.profile.showMasterySummary || settings.badges.some((item) => item.selected) || settings.projects.some((item) => item.selected) ? "selected" : "alias";
}
export async function loadLearningProfile(userId: string, name: string, role: string | null): Promise<LearningProfile> {
  const [profile] = await db.select({ bio: learnerProfile.bio, analogyFrequency: learnerProfile.analogyFrequency, rowVersion: learnerProfile.rowVersion }).from(learnerProfile).where(eq(learnerProfile.userId, userId)).limit(1);
  const cohort = role === "learner" ? await loadOwnCohortSettings(userId) : null;
  return { name, bio: profile?.bio ?? "", analogyFrequency: profile?.analogyFrequency === "frequent" || profile?.analogyFrequency === "neutral" ? profile.analogyFrequency : "helpful", profileVersion: Number(profile?.rowVersion ?? 0), cohortVisibility: visibility(cohort), cohortVersion: cohort?.profile.rowVersion ?? 0, cohortAlias: cohort?.profile.alias ?? null, cohortConsent: cohort?.consent.cohortProfile ?? false };
}
export async function saveLearningProfile(userId: string, role: string | null, input: ProfileSettingsInput) {
  // The cohort read is a pre-check only; the cohort write below re-verifies
  // expectedVersion under its own row lock inside the shared transaction.
  const cohort = role === "learner" ? await loadOwnCohortSettings(userId) : null;
  if (input.cohortVisibility !== "hidden" && !cohort?.consent.cohortProfile) throw new ProfileSettingsError(400, "Accept cohort sharing in Privacy & consent before publishing.");
  if (input.cohortVersion !== (cohort?.profile.rowVersion ?? 0)) throw new ProfileSettingsError(409, "Cohort settings changed. Reload the profile before saving.");
  // One client, one transaction: the learning preferences and the cohort
  // visibility either both commit or both roll back.
  const client = await pool.connect();
  try {
    await client.query("begin");
    const tx = drizzle(client);
    await lockUserAuthority(tx, userId);
    const [owner] = await tx.select({ status: user.status }).from(user).where(eq(user.id, userId)).limit(1);
    if (owner?.status !== "active") throw new ProfileSettingsError(403, "This account is no longer active.");
    const [existing] = await tx.select({ rowVersion: learnerProfile.rowVersion }).from(learnerProfile).where(eq(learnerProfile.userId, userId)).limit(1);
    if (Number(existing?.rowVersion ?? 0) !== input.profileVersion) throw new ProfileSettingsError(409, "Profile settings changed. Reload before saving.");
    await tx.insert(learnerProfile).values({ userId, bio: input.bio || null, analogyFrequency: input.analogyFrequency }).onConflictDoUpdate({ target: learnerProfile.userId, set: { bio: input.bio || null, analogyFrequency: input.analogyFrequency, rowVersion: sql`${learnerProfile.rowVersion} + 1`, updatedAt: new Date() } });
    if (cohort && input.cohortVisibility !== visibility(cohort)) {
      const hidden = input.cohortVisibility === "hidden";
      const selected = input.cohortVisibility === "selected";
      try {
        await updateCohortProfileInTransaction(client, { actorUserId: userId, requestId: input.requestId, expectedVersion: input.cohortVersion, alias: cohort.profile.alias, bio: cohort.profile.bio || null,
          // A private learning bio/name is never copied into public fields.
          showBio: hidden && cohort.profile.showBio, showMasterySummary: hidden && cohort.profile.showMasterySummary,
          showStreak: hidden ? cohort.profile.showStreak : selected, publish: !hidden,
          selectedAchievementIds: hidden || selected ? cohort.badges.filter((item) => item.selected).map((item) => item.id) : [],
          selectedProjectIds: hidden || selected ? cohort.projects.filter((item) => item.selected).map((item) => item.id) : [],
        });
      } catch (error) {
        if (error instanceof SocialProfileError) throw new ProfileSettingsError(409, "Cohort visibility changed or could not be saved, so nothing was saved. Reload before retrying.");
        throw error;
      }
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
