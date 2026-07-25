import type { EmailTemplate } from "./outbox";
import { materializeLostDeviceProofVariables } from "@/lib/security/lost-device-recovery";
import { parseRevocableSourceVariables } from "./revocable-source-authority";

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
  const parsed = parseRevocableSourceVariables({
    applicationUrl: process.env.APP_URL ?? "http://localhost:3000",
    template: input.template,
    templateVersion: "1",
    variables: input.variables,
  });
  if (parsed?.kind !== "lost-device-proof") return null;
  const requestId = parsed.sourceId;
  return materializeLostDeviceProofVariables({
    requestId,
    name: input.variables.name,
    now: input.now,
  });
}
