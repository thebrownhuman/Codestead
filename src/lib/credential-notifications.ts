import { eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { notification, user } from "@/lib/db/schema";
import { enqueueEmail } from "@/lib/notifications/outbox";

const appUrl = () => process.env.APP_URL ?? "http://localhost:3000";

const actionLabel = {
  add: "added",
  prefer: "marked preferred",
  disable: "disabled",
  enable: "enabled",
  test: "tested",
  replace: "replaced",
  delete: "deleted",
} as const;

export async function notifyCredentialChanged(input: {
  userId: string;
  provider: string;
  action: keyof typeof actionLabel;
  idempotencySeed: string;
}) {
  const [owner] = await db
    .select({ email: user.email, name: user.name })
    .from(user)
    .where(eq(user.id, input.userId))
    .limit(1);
  if (!owner) return;

  const provider = input.provider.replaceAll("_", " ");
  const summary = `Your ${provider} credential was ${actionLabel[input.action]}.`;
  await Promise.all([
    db.insert(notification).values({
      userId: input.userId,
      type: "credential-changed",
      title: "AI provider credential changed",
      body: summary,
      actionUrl: "/settings?section=ai",
    }),
    enqueueEmail({
      to: owner.email,
      userId: input.userId,
      template: "credential-changed",
      variables: {
        name: owner.name,
        provider,
        action: actionLabel[input.action],
        url: `${appUrl()}/settings?section=ai`,
      },
      idempotencySeed: input.idempotencySeed,
    }),
  ]);
}
