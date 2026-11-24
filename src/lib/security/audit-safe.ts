import { writeAuditEvent, type AuditEventInput } from "@/lib/security/audit-writer";

/**
 * Writes an audit event after the audited change has already committed. A
 * failure must not turn a completed action into an error response, but it must
 * not be silent either: it is logged as a structured event and the caller gets
 * `null` (so it can report `completionAuditRecorded: false`).
 *
 * The log carries only identifiers. Reason, metadata and error text can hold
 * private or secret values, so they are never logged.
 */
export async function writeAuditEventSafely(
  input: AuditEventInput,
): Promise<Awaited<ReturnType<typeof writeAuditEvent>> | null> {
  try {
    return await writeAuditEvent(input);
  } catch (error) {
    console.error(JSON.stringify({
      event: "audit.write_failed",
      action: input.action,
      outcome: input.outcome,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    return null;
  }
}
