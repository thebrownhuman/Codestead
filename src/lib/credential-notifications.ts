import { eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { notification, user } from "@/lib/db/schema";
import { enqueueEmailInTransaction } from "@/lib/notifications/outbox";

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

type CredentialNotificationTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

type CredentialNotificationInput = Readonly<{
  userId: string;
  provider: string;
  action: keyof typeof actionLabel;
  idempotencySeed: string;
}>;

export async function notifyCredentialChangedInTransaction(
  tx: CredentialNotificationTransaction,
  input: CredentialNotificationInput,
) {
  const [owner] = await tx
    .select({ email: user.email, name: user.name })
    .from(user)
    .where(eq(user.id, input.userId))
    .limit(1);
  if (!owner) return;

  const provider = input.provider.replaceAll("_", " ");
  const summary = `Your ${provider} credential was ${actionLabel[input.action]}.`;
  await tx.insert(notification).values({
    userId: input.userId,
    type: "credential-changed",
    title: "AI provider credential changed",
    body: summary,
    actionUrl: "/settings?section=ai",
  });
  await enqueueEmailInTransaction(tx, {
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
  });
}

export async function notifyCredentialChanged(
  input: CredentialNotificationInput,
) {
  await db.transaction((tx) => notifyCredentialChangedInTransaction(tx, input));
}
