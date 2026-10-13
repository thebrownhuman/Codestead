import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { session, user } from "@/lib/db/schema";
import { lockUserAuthority } from "@/lib/security/user-authority-lock";
import { accountMayUseProtectedFeatures } from "@/lib/security/account-policy";
import { getCurrentConsentsFrom, isCurrentConsentAccepted } from "@/lib/privacy/consent";
import { gateClosedBookCapability } from "@/lib/exams/capability-gate";
import { bodyHash, brokerSecret, signEnvelope } from "./interactive-protocol.mjs";

export const interactiveEnabled = () => process.env.INTERACTIVE_RUNNER_ENABLED === "true";
export class InteractiveError extends Error {
  constructor(public readonly code: string, public readonly status = 503) { super(code); }
}

export async function brokerControl(payload: Record<string, unknown>) {
  try {
    const origin = new URL(process.env.INTERACTIVE_BROKER_URL ?? "http://interactive-runner:3100");
    if (origin.protocol !== "http:" || origin.pathname !== "/" || origin.search || origin.username || origin.password) throw new Error();
    const body = JSON.stringify(payload);
    const proof = signEnvelope(brokerSecret(), "control", { method: "POST", path: "/control", bodyHash: bodyHash(body) });
    const response = await fetch(new URL("/control", origin), {
      method: "POST", body, redirect: "error", cache: "no-store",
      headers: { "Content-Type": "application/json", "x-interactive-proof": proof },
      signal: AbortSignal.timeout(7000),
    });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new InteractiveError(typeof result.code === "string" ? result.code : "BROKER_UNAVAILABLE",
      [400, 404, 409, 429].includes(response.status) ? response.status : 503);
    return result;
  } catch (error) {
    if (error instanceof InteractiveError) throw error;
    throw new InteractiveError("BROKER_UNAVAILABLE");
  }
}

export async function withInteractiveAuthority<T>(userId: string, authSessionId: string, operation: () => Promise<T>) {
  const result = await db.transaction(async tx => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await lockUserAuthority(tx, userId);
    const [current] = await tx.select({ status: user.status, mfaEnabled: user.twoFactorEnabled,
      mustChangePassword: user.mustChangePassword, expiresAt: session.expiresAt,
      revokedAt: session.revokedAt, mfaVerifiedAt: session.mfaVerifiedAt })
      .from(session).innerJoin(user, eq(user.id, session.userId))
      .where(and(eq(session.id, authSessionId), eq(session.userId, userId))).limit(1);
    if (!current || current.revokedAt !== null || !Number.isFinite(current.expiresAt.getTime()) || current.expiresAt.getTime() <= Date.now()
      || current.mustChangePassword || !accountMayUseProtectedFeatures(current.status, false,
        current.mfaEnabled === true, current.mfaVerifiedAt !== null && Number.isFinite(current.mfaVerifiedAt.getTime()))) {
      throw new InteractiveError("AUTH_REQUIRED", 401);
    }
    // READ COMMITTED reads exam state after acquiring authority. Exam
    // admission uses this same lock until broker cancellation and DB commit.
    const gate = await gateClosedBookCapability(userId, "general_code_runner", tx);
    // Commit the gate's coalesced integrity event even when admission is denied.
    if (!gate.allowed) return { error: new InteractiveError(gate.code, gate.status), value: null } as const;
    if (!isCurrentConsentAccepted(await getCurrentConsentsFrom(tx, userId), "server_code_execution")) {
      throw new InteractiveError("CONSENT_REQUIRED", 409);
    }
    return { error: null, value: await operation() } as const;
  });
  if (result.error) throw result.error;
  return result.value;
}

/** Call only while holding the user's authority lock, before inserting an exam. */
export async function cancelInteractiveForExam(userId: string) {
  if (!interactiveEnabled()) return;
  await brokerControl({ action: "cancel-user", userId });
}
