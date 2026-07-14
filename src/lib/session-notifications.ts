import { eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { notification, user } from "@/lib/db/schema";
import { enqueueEmail } from "@/lib/notifications/outbox";

const appUrl = () => process.env.APP_URL ?? "http://localhost:3000";

export async function notifySessionRevoked(input: {
  userId: string;
  device: string;
  idempotencySeed: string;
}) {
  const [owner] = await db
    .select({ email: user.email, name: user.name })
    .from(user)
    .where(eq(user.id, input.userId))
    .limit(1);
  if (!owner) return;
  await Promise.all([
    db.insert(notification).values({
      userId: input.userId,
      type: "session-revoked",
      title: "Browser profile revoked",
      body: `${input.device} was revoked by the administrator.`,
      actionUrl: "/settings?section=device",
    }),
    enqueueEmail({
      to: owner.email,
      userId: input.userId,
      template: "session-revoked",
      variables: {
        name: owner.name,
        device: input.device,
        url: `${appUrl()}/settings?section=device`,
      },
      idempotencySeed: input.idempotencySeed,
    }),
  ]);
}

export async function notifyRevocationDecision(input: {
  userId: string;
  decision: "approved" | "rejected";
  reason: string;
  idempotencySeed: string;
}) {
  const [owner] = await db
    .select({ email: user.email, name: user.name })
    .from(user)
    .where(eq(user.id, input.userId))
    .limit(1);
  if (!owner) return;
  await Promise.all([
    db.insert(notification).values({
      userId: input.userId,
      type: "session-revocation-updated",
      title: `Device revocation ${input.decision}`,
      body: input.reason,
      actionUrl: "/settings?section=device",
    }),
    enqueueEmail({
      to: owner.email,
      userId: input.userId,
      template: "session-revocation-updated",
      variables: {
        name: owner.name,
        decision: input.decision,
        reason: input.reason,
        url: `${appUrl()}/settings?section=device`,
      },
      idempotencySeed: input.idempotencySeed,
    }),
  ]);
}
