import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { and, eq, gt, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  lostDeviceProof,
  notification,
  session,
  sessionRevocationRequest,
  user,
} from "@/lib/db/schema";
import { enqueueEmailInTransaction } from "@/lib/notifications/outbox";
import { writeAuditEventInTransaction } from "@/lib/security/audit-writer";

export const LOST_DEVICE_PROOF_TTL_MS = 15 * 60_000;

function proofKey(value?: string) {
  const key = value ?? process.env.LOST_DEVICE_PROOF_KEY ??
    (process.env.NODE_ENV === "production" ? undefined : process.env.BETTER_AUTH_SECRET);
  if (!key || Buffer.byteLength(key, "utf8") < 32) {
    throw new Error(
      "LOST_DEVICE_PROOF_KEY must contain at least 32 bytes in production.",
    );
  }
  return key;
}

/**
 * Produces the mailbox bearer proof without persisting it. The outbox stores
 * only the non-secret request UUID; the worker derives this value in memory at
 * delivery time and the database retains only hashLostDeviceProof(result).
 */
export function deriveLostDeviceProof(requestId: string, key?: string) {
  return createHmac("sha256", proofKey(key))
    .update("learncoding-lost-device-proof-v1\0")
    .update(requestId)
    .digest("base64url");
}

export function hashLostDeviceProof(rawProof: string) {
  return createHash("sha256").update(rawProof).digest("hex");
}

function sameHash(left: string, right: string) {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

type IssuedProof = Readonly<{
  requestId: string;
  expiresAt: Date;
}>;

/**
 * Returns null for unknown, unverified, inactive, non-learner, or sessionless
 * accounts. Public callers intentionally discard the distinction and return a
 * neutral response. Concurrent requests for the same active family reuse one
 * proof/outbox row rather than rotating a link an attacker could invalidate.
 */
export async function issueLostDeviceProof(
  email: string,
  now = new Date(),
): Promise<IssuedProof | null> {
  const normalizedEmail = email.trim().toLowerCase();
  const [candidate] = await db
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      sessionId: session.id,
    })
    .from(user)
    .innerJoin(
      session,
      and(
        eq(session.userId, user.id),
        isNull(session.revokedAt),
        gt(session.expiresAt, now),
      ),
    )
    .where(
      and(
        sql`lower(${user.email}) = ${normalizedEmail}`,
        eq(user.role, "learner"),
        eq(user.status, "active"),
        eq(user.emailVerified, true),
      ),
    )
    .limit(1);
  if (!candidate) return null;

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`lost-device:${candidate.userId}`}))`,
    );
    const [stillActive] = await tx
      .select({ id: session.id })
      .from(session)
      .where(
        and(
          eq(session.id, candidate.sessionId),
          eq(session.userId, candidate.userId),
          isNull(session.revokedAt),
          gt(session.expiresAt, now),
        ),
      )
      .limit(1);
    if (!stillActive) return null;

    const [open] = await tx
      .select({
        id: lostDeviceProof.id,
        proofHash: lostDeviceProof.proofHash,
        expiresAt: lostDeviceProof.expiresAt,
      })
      .from(lostDeviceProof)
      .where(
        and(
          eq(lostDeviceProof.userId, candidate.userId),
          eq(lostDeviceProof.sessionId, candidate.sessionId),
          isNull(lostDeviceProof.consumedAt),
        ),
      )
      .limit(1)
      .for("update");

    if (open && open.expiresAt > now) {
      const expected = hashLostDeviceProof(deriveLostDeviceProof(open.id));
      // A key rotation or row corruption must not silently issue a proof that
      // cannot match the persisted verifier.
      if (!sameHash(open.proofHash, expected)) return null;
      await enqueueEmailInTransaction(tx, {
        to: candidate.email,
        userId: candidate.userId,
        template: "lost-device-proof",
        variables: { name: candidate.name, recoveryRequestId: open.id },
        idempotencySeed: open.id,
      });
      return { requestId: open.id, expiresAt: open.expiresAt };
    }

    if (open) {
      await tx
        .update(lostDeviceProof)
        .set({ consumedAt: now, updatedAt: now })
        .where(eq(lostDeviceProof.id, open.id));
    }

    const requestId = randomUUID();
    const expiresAt = new Date(now.getTime() + LOST_DEVICE_PROOF_TTL_MS);
    const proofHash = hashLostDeviceProof(deriveLostDeviceProof(requestId));
    await tx.insert(lostDeviceProof).values({
      id: requestId,
      userId: candidate.userId,
      sessionId: candidate.sessionId,
      proofHash,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });
    await enqueueEmailInTransaction(tx, {
      to: candidate.email,
      userId: candidate.userId,
      template: "lost-device-proof",
      variables: { name: candidate.name, recoveryRequestId: requestId },
      idempotencySeed: requestId,
    });
    await writeAuditEventInTransaction(tx, {
      subjectUserId: candidate.userId,
      action: "session.lost_device_proof_issued",
      resourceType: "lost_device_proof",
      resourceId: requestId,
      outcome: "success",
      metadata: { expiresAt: expiresAt.toISOString() },
    });
    return { requestId, expiresAt };
  });
}

type VerifiedProof = Readonly<{
  requestId: string;
  userId: string;
  sessionId: string;
}>;

/**
 * Atomically consumes a valid mailbox proof and creates the ordinary pending
 * administrator revocation request. The proof carries its owner/session
 * binding; callers cannot nominate a different account or device.
 */
export async function verifyLostDeviceProof(input: {
  rawProof: string;
  reason: string;
  now?: Date;
}): Promise<VerifiedProof | null> {
  const now = input.now ?? new Date();
  const proofHash = hashLostDeviceProof(input.rawProof);
  return db.transaction(async (tx) => {
    const [claim] = await tx
      .update(lostDeviceProof)
      .set({ consumedAt: now, updatedAt: now })
      .where(
        and(
          eq(lostDeviceProof.proofHash, proofHash),
          isNull(lostDeviceProof.consumedAt),
          gt(lostDeviceProof.expiresAt, now),
        ),
      )
      .returning({
        id: lostDeviceProof.id,
        userId: lostDeviceProof.userId,
        sessionId: lostDeviceProof.sessionId,
      });
    if (!claim) return null;

    const [owner] = await tx
      .select({ id: user.id, name: user.name })
      .from(user)
      .innerJoin(
        session,
        and(
          eq(session.id, claim.sessionId),
          eq(session.userId, user.id),
          isNull(session.revokedAt),
          gt(session.expiresAt, now),
        ),
      )
      .where(
        and(
          eq(user.id, claim.userId),
          eq(user.role, "learner"),
          eq(user.status, "active"),
          eq(user.emailVerified, true),
        ),
      )
      .limit(1);
    if (!owner) return null;

    const [created] = await tx
      .insert(sessionRevocationRequest)
      .values({
        userId: claim.userId,
        sessionId: claim.sessionId,
        reason: input.reason,
        requestChannel: "email_proof",
        identityVerifiedAt: now,
        proofRequestId: claim.id,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: sessionRevocationRequest.id });
    const [existing] = created
      ? [created]
      : await tx
          .select({ id: sessionRevocationRequest.id })
          .from(sessionRevocationRequest)
          .where(
            and(
              eq(sessionRevocationRequest.userId, claim.userId),
              eq(sessionRevocationRequest.sessionId, claim.sessionId),
              eq(sessionRevocationRequest.status, "pending"),
            ),
          )
          .limit(1);
    if (!existing) return null;

    if (created) {
      const admins = await tx
        .select({ id: user.id, email: user.email, name: user.name })
        .from(user)
        .where(and(eq(user.role, "admin"), eq(user.status, "active")));
      const actionUrl = `${process.env.APP_URL ?? "http://localhost:3000"}/admin/learners/${claim.userId}`;
      for (const admin of admins) {
        await tx.insert(notification).values({
          userId: admin.id,
          type: "session-revocation-requested",
          title: "Verified lost-device request needs review",
          body: `${owner.name} confirmed mailbox control for a lost-device request. Complete the separate identity check before deciding.`,
          actionUrl: `/admin/learners/${claim.userId}`,
        });
        await enqueueEmailInTransaction(tx, {
          to: admin.email,
          userId: admin.id,
          template: "session-revocation-requested",
          variables: {
            name: admin.name,
            device: "the learner's only approved browser profile",
            url: actionUrl,
          },
          idempotencySeed: existing.id,
        });
      }
    }
    await writeAuditEventInTransaction(tx, {
      subjectUserId: claim.userId,
      action: "session.lost_device_proof_verified",
      resourceType: "session_revocation_request",
      resourceId: existing.id,
      outcome: "success",
      metadata: {
        sessionId: claim.sessionId,
        requestChannel: created ? "email_proof" : "existing_authenticated_request",
      },
    });
    return {
      requestId: existing.id,
      userId: claim.userId,
      sessionId: claim.sessionId,
    };
  });
}

export async function materializeLostDeviceProofVariables(input: {
  requestId: string;
  name: string;
  now?: Date;
}): Promise<Record<string, string> | null> {
  const now = input.now ?? new Date();
  const [record] = await db
    .select({ proofHash: lostDeviceProof.proofHash })
    .from(lostDeviceProof)
    .where(
      and(
        eq(lostDeviceProof.id, input.requestId),
        isNull(lostDeviceProof.consumedAt),
        gt(lostDeviceProof.expiresAt, now),
      ),
    )
    .limit(1);
  if (!record) return null;
  const rawProof = deriveLostDeviceProof(input.requestId);
  if (!sameHash(record.proofHash, hashLostDeviceProof(rawProof))) return null;
  const applicationUrl = new URL(
    "/lost-device",
    process.env.APP_URL ?? "http://localhost:3000",
  );
  // URL fragments are not sent in HTTP requests or Referer headers, keeping
  // the bearer proof out of ordinary reverse-proxy/application access logs.
  applicationUrl.hash = `proof=${encodeURIComponent(rawProof)}`;
  return { name: input.name, url: applicationUrl.toString() };
}
