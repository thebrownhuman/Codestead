import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { achievement, notification, user, userAchievement } from "@/lib/db/schema";
import { enqueueEmailInTransaction } from "@/lib/notifications/outbox";
import { lockUserAuthority } from "@/lib/security/user-authority-lock";

export const EXAM_MASTERY_RULE_VERSION = "exam-mastery-v1";

export class ExamMasteryAwardError extends Error {
  constructor(readonly code: "LEARNER_NOT_ACTIVE") {
    super(code);
    this.name = "ExamMasteryAwardError";
  }
}

export function examModuleMasterySlug(courseId: string, moduleId: string) {
  const identity = `${courseId}:${moduleId}`;
  const readable = identity.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72);
  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  return `mastery-${readable || "module"}-${suffix}`;
}

export async function awardExamModuleMastery(input: {
  readonly userId: string;
  readonly attemptId: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly moduleId: string;
  readonly moduleTitle: string;
  readonly scorePercent: number;
  readonly criticalRequirementsMet: boolean;
}) {
  if (!Number.isFinite(input.scorePercent) || input.scorePercent < 95 || !input.criticalRequirementsMet) {
    return { awarded: false as const, reason: "MASTERY_THRESHOLD_NOT_MET" as const };
  }
  const slug = examModuleMasterySlug(input.courseId, input.moduleId);
  return db.transaction(async (tx) => {
    await lockUserAuthority(tx, input.userId);
    const [learner] = await tx
      .select({ status: user.status, name: user.name, email: user.email })
      .from(user)
      .where(eq(user.id, input.userId))
      .limit(1);
    if (learner?.status !== "active") throw new ExamMasteryAwardError("LEARNER_NOT_ACTIVE");
    await tx
      .insert(achievement)
      .values({
        slug,
        title: `Mastery: ${input.moduleTitle}`,
        description: `Demonstrated at least 95% with every critical requirement satisfied in ${input.courseTitle}.`,
        icon: "medal",
        ruleVersion: EXAM_MASTERY_RULE_VERSION,
        rule: {
          event: "exam_mastery",
          courseId: input.courseId,
          moduleId: input.moduleId,
          minimumScorePercent: 95,
          criticalRequirementsRequired: true,
        },
      })
      .onConflictDoNothing({ target: achievement.slug });
    const [badge] = await tx
      .select({ id: achievement.id })
      .from(achievement)
      .where(eq(achievement.slug, slug))
      .limit(1);
    if (!badge) throw new Error("Mastery achievement could not be resolved.");
    const [award] = await tx
      .insert(userAchievement)
      .values({
        userId: input.userId,
        achievementId: badge.id,
        evidenceId: `exam-attempt:${input.attemptId}`,
        visibility: "private",
      })
      .onConflictDoNothing({
        target: [userAchievement.userId, userAchievement.achievementId, userAchievement.evidenceId],
      })
      .returning({ id: userAchievement.id });
    if (!award) return { awarded: false as const, reason: "ALREADY_AWARDED" as const };
    await tx.insert(notification).values({
      userId: input.userId,
      type: "mastery-awarded",
      title: `Mastery earned: ${input.moduleTitle}`,
      body: `You independently demonstrated ${input.scorePercent}% with every critical requirement satisfied. The badge is private until you choose to publish it to the cohort.`,
      actionUrl: "/community",
    });
    await enqueueEmailInTransaction(tx, {
      to: learner.email,
      userId: input.userId,
      template: "mastery-awarded",
      variables: {
        name: learner.name,
        topic: input.moduleTitle,
        url: `${process.env.APP_URL ?? "http://localhost:3000"}/community`,
      },
      idempotencySeed: `exam-mastery:${input.attemptId}`,
    });
    return { awarded: true as const, badgeAwardId: award.id, emailQueued: true as const };
  });
}
