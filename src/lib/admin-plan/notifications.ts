import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { notification, user } from "@/lib/db/schema";
import { enqueueEmailInTransaction } from "@/lib/notifications/outbox";

function planChangeNotificationId(input: {
  learnerUserId: string;
  idempotencySeed: string;
}) {
  // A deterministic UUIDv8 lets the existing primary key act as the
  // notification idempotency constraint without a schema-only event key.
  const hash = createHash("sha256")
    .update(JSON.stringify(["learning-plan-changed", input.learnerUserId, input.idempotencySeed]))
    .digest("hex");
  const variant = ((Number.parseInt(hash[16]!, 16) & 0b0011) | 0b1000).toString(16);
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `8${hash.slice(13, 16)}`,
    `${variant}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

export async function notifyLearningPlanChanged(input: {
  learnerUserId: string;
  courseTitle: string;
  revision: number;
  action: "updated" | "reverted";
  idempotencySeed: string;
}) {
  await db.transaction(async (tx) => {
    const [learner] = await tx
      .select({ email: user.email, name: user.name })
      .from(user)
      .where(eq(user.id, input.learnerUserId))
      .limit(1);
    if (!learner) return;
    const summary = `${input.courseTitle} plan ${input.action} as revision ${input.revision}. Mastery evidence and prerequisite gates were preserved.`;
    await enqueueEmailInTransaction(tx, {
      to: learner.email,
      userId: input.learnerUserId,
      template: "learning-plan-changed",
      variables: {
        name: learner.name,
        course: input.courseTitle,
        revision: String(input.revision),
        action: input.action,
        url: `${process.env.APP_URL ?? "http://localhost:3000"}/roadmap`,
      },
      idempotencySeed: input.idempotencySeed,
    });
    await tx
      .insert(notification)
      .values({
        id: planChangeNotificationId(input),
        userId: input.learnerUserId,
        type: "learning-plan-changed",
        title: "Learning plan changed",
        body: summary,
        actionUrl: "/roadmap",
      })
      .onConflictDoNothing({ target: notification.id });
  });
}
