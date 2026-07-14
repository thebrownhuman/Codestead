import { createHash } from "node:crypto";

import { and, eq, gt, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { invitation } from "@/lib/db/schema";

export interface InvitationClaim extends Record<string, unknown> {
  readonly id: string;
  readonly email: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function findUsableInvitationByToken(
  rawToken: string,
  now = new Date(),
): Promise<InvitationClaim | null> {
  const [record] = await db
    .select({
      id: invitation.id,
      email: invitation.email,
      expiresAt: invitation.expiresAt,
      consumedAt: invitation.consumedAt,
    })
    .from(invitation)
    .where(
      and(
        eq(invitation.tokenHash, hashInvitationToken(rawToken)),
        isNull(invitation.consumedAt),
        gt(invitation.expiresAt, now),
      ),
    )
    .limit(1);
  return record ?? null;
}

/**
 * Atomically consumes a token. The update predicate is the replay barrier: even
 * when callers race, PostgreSQL can return the invitation to at most one of
 * them.
 */
export async function consumeInvitationByToken(input: {
  readonly rawToken: string;
  readonly expectedEmail: string;
  readonly now?: Date;
}): Promise<InvitationClaim | null> {
  const now = input.now ?? new Date();
  const [record] = await db
    .update(invitation)
    .set({ consumedAt: now, updatedAt: now })
    .where(
      and(
        eq(invitation.tokenHash, hashInvitationToken(input.rawToken)),
        sql`lower(${invitation.email}) = lower(${input.expectedEmail})`,
        isNull(invitation.consumedAt),
        gt(invitation.expiresAt, now),
      ),
    )
    .returning({
      id: invitation.id,
      email: invitation.email,
      expiresAt: invitation.expiresAt,
      consumedAt: invitation.consumedAt,
    });
  return record ?? null;
}
