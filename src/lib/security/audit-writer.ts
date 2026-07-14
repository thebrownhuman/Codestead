import { desc, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/lib/db/client";
import { auditEvent } from "@/lib/db/schema";
import { hashAuditEvent, nextAuditTimestamp } from "./audit";

export type AuditEventInput = {
  actorUserId?: string;
  subjectUserId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  reason?: string;
  outcome: "allowed" | "denied" | "success" | "failure";
  correlationId?: string;
  ipPseudonym?: string;
  metadata?: Record<string, unknown>;
};

export type AuditTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Appends to the audit hash chain inside an existing database transaction.
 * Callers can use this to make a privileged state change, its audit event,
 * and its durable notifications succeed or roll back as one unit.
 */
export async function writeAuditEventInTransaction(
  tx: AuditTransaction,
  input: AuditEventInput,
) {
  const correlationId = input.correlationId ?? randomUUID();
  const metadata = input.metadata ?? {};
  // A hash chain has one head. Serialize writers so concurrent security
  // events cannot create two valid-looking children of the same event.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('learncoding:audit-chain'))`);
  const [latest] = await tx
    .select({ eventHash: auditEvent.eventHash, occurredAt: auditEvent.occurredAt })
    .from(auditEvent)
    .orderBy(desc(auditEvent.occurredAt), desc(auditEvent.id))
    .limit(1);
  // Preserve one unambiguous head even when two events arrive in the same
  // millisecond or the host clock moves slightly backwards.
  const occurredAt = nextAuditTimestamp(latest?.occurredAt);
  const eventHash = hashAuditEvent(
    {
      ...input,
      correlationId,
      occurredAt: occurredAt.toISOString(),
      metadata,
    },
    latest?.eventHash ?? null,
  );
  await tx.insert(auditEvent).values({
    actorUserId: input.actorUserId,
    subjectUserId: input.subjectUserId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    reason: input.reason,
    outcome: input.outcome,
    correlationId,
    ipPseudonym: input.ipPseudonym,
    metadata,
    previousHash: latest?.eventHash,
    eventHash,
    occurredAt,
  });
  return { correlationId, eventHash };
}

export async function writeAuditEvent(input: AuditEventInput) {
  return db.transaction((tx) => writeAuditEventInTransaction(tx, input));
}
