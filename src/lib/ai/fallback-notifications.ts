import { eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { notification, user } from "@/lib/db/schema";
import { enqueueEmailInTransaction } from "@/lib/notifications/outbox";

type FallbackNotificationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type FallbackGrantChangedInput = {
  learnerId: string;
  provider: string;
  action: "enabled" | "revoked";
  summary: string;
  idempotencySeed: string;
};

export async function notifyFallbackGrantChangedInTransaction(
  tx: FallbackNotificationTransaction,
  input: FallbackGrantChangedInput,
) {
  const [learner] = await tx
    .select({ email: user.email, name: user.name })
    .from(user)
    .where(eq(user.id, input.learnerId))
    .limit(1);
  if (!learner) return;
  const provider = input.provider.replaceAll("_", " ");
  await tx.insert(notification).values({
    userId: input.learnerId,
    type: "fallback-grant-changed",
    title: `Administrator AI fallback ${input.action}`,
    body: `${provider}: ${input.summary}`,
    actionUrl: "/settings?section=ai",
  });
  await enqueueEmailInTransaction(tx, {
    to: learner.email,
    userId: input.learnerId,
    template: "fallback-grant-changed",
    variables: {
      name: learner.name,
      provider,
      action: input.action,
      summary: input.summary,
      url: `${process.env.APP_URL ?? "http://localhost:3000"}/settings?section=ai`,
    },
    idempotencySeed: input.idempotencySeed,
  });
}

export async function notifyFallbackGrantChanged(input: FallbackGrantChangedInput) {
  return db.transaction((tx) => notifyFallbackGrantChangedInTransaction(tx, input));
}
