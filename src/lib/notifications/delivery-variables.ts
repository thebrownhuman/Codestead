import type { EmailTemplate } from "./outbox";
import { materializeLostDeviceProofVariables } from "@/lib/security/lost-device-recovery";

/**
 * Expands delivery-only values in memory. Sensitive bearer links must never be
 * written back to email_outbox or included in worker logs.
 */
export async function materializeDeliveryVariables(input: {
  template: EmailTemplate;
  variables: Record<string, string>;
  now?: Date;
}): Promise<Record<string, string> | null> {
  if (input.template !== "lost-device-proof") return input.variables;
  const requestId = input.variables.recoveryRequestId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId ?? "")) {
    return null;
  }
  return materializeLostDeviceProofVariables({
    requestId,
    name: input.variables.name ?? "learner",
    now: input.now,
  });
}
