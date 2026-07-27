import type { EmailTemplate } from "./outbox";
import { materializeLostDeviceProofDelivery } from "@/lib/security/lost-device-recovery";
import {
  type LostDeviceAuthorityEvidence,
  parseRevocableSourceVariables,
} from "./revocable-source-authority";

export type MaterializedDeliveryVariables = Readonly<{
  authorityEvidence: LostDeviceAuthorityEvidence | null;
  variables: Readonly<Record<string, string>>;
}>;

/**
 * Expands delivery-only values in memory. Sensitive bearer links and authority
 * evidence must never be persisted back to email_outbox or included in logs.
 */
export async function materializeDeliveryWithAuthorityEvidence(input: {
  applicationUrl: string;
  template: EmailTemplate;
  templateVersion: string;
  variables: Record<string, string>;
  now?: Date;
}): Promise<MaterializedDeliveryVariables | null> {
  if (input.template !== "lost-device-proof") {
    return Object.freeze({
      authorityEvidence: null,
      variables: Object.freeze({ ...input.variables }),
    });
  }
  const parsed = parseRevocableSourceVariables({
    applicationUrl: input.applicationUrl,
    template: input.template,
    templateVersion: input.templateVersion,
    variables: input.variables,
  });
  if (parsed?.kind !== "lost-device-proof") return null;
  return materializeLostDeviceProofDelivery({
    requestId: parsed.sourceId,
    name: input.variables.name,
    now: input.now,
  });
}

/** Variables-only compatibility adapter retained for non-worker callers. */
export async function materializeDeliveryVariables(input: {
  applicationUrl: string;
  template: EmailTemplate;
  templateVersion: string;
  variables: Record<string, string>;
  now?: Date;
}): Promise<Record<string, string> | null> {
  const delivery = await materializeDeliveryWithAuthorityEvidence(input);
  return delivery ? { ...delivery.variables } : null;
}
