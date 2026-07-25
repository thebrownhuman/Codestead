import type { Database } from "@/lib/db/client";
import type { EmailTemplate } from "./outbox";
import {
  materializeLostDeviceProofDelivery,
  materializeLostDeviceProofDeliveryWithDatabase,
  type MaterializedLostDeviceProofDelivery,
} from "@/lib/security/lost-device-recovery";
import {
  type LostDeviceAuthorityEvidence,
  parseRevocableSourceVariables,
} from "./revocable-source-authority";

export type MaterializedDeliveryVariables = Readonly<{
  authorityEvidence: LostDeviceAuthorityEvidence | null;
  variables: Readonly<Record<string, string>>;
}>;

type DeliveryInput = Readonly<{
  template: EmailTemplate;
  variables: Record<string, string>;
  now?: Date;
}>;

/**
 * Expands delivery-only values in memory. Sensitive bearer links and authority
 * evidence must never be persisted back to email_outbox or included in logs.
 */
async function materializeDeliveryWith(
  input: DeliveryInput,
  materializeLostDeviceProof: (
    proofInput: { requestId: string; name: string; now?: Date },
  ) => Promise<MaterializedLostDeviceProofDelivery | null>,
): Promise<MaterializedDeliveryVariables | null> {
  if (input.template !== "lost-device-proof") {
    return Object.freeze({
      authorityEvidence: null,
      variables: Object.freeze({ ...input.variables }),
    });
  }
  const parsed = parseRevocableSourceVariables({
    applicationUrl: process.env.APP_URL ?? "http://localhost:3000",
    template: input.template,
    templateVersion: "1",
    variables: input.variables,
  });
  if (parsed?.kind !== "lost-device-proof") return null;
  return materializeLostDeviceProof({
    requestId: parsed.sourceId,
    name: input.variables.name,
    now: input.now,
  });
}

export async function materializeDeliveryWithAuthorityEvidence(
  input: DeliveryInput,
): Promise<MaterializedDeliveryVariables | null> {
  return materializeDeliveryWith(input, materializeLostDeviceProofDelivery);
}

export async function materializeDeliveryWithAuthorityEvidenceWithDatabase(
  database: Pick<Database, "select">,
  input: DeliveryInput,
): Promise<MaterializedDeliveryVariables | null> {
  return materializeDeliveryWith(
    input,
    (proofInput) => materializeLostDeviceProofDeliveryWithDatabase(database, proofInput),
  );
}

/** Variables-only compatibility adapter; live authority integration remains pending. */
export async function materializeDeliveryVariables(
  input: DeliveryInput,
): Promise<Record<string, string> | null> {
  const delivery = await materializeDeliveryWithAuthorityEvidence(input);
  return delivery ? { ...delivery.variables } : null;
}

export async function materializeDeliveryVariablesWithDatabase(
  database: Pick<Database, "select">,
  input: DeliveryInput,
): Promise<Record<string, string> | null> {
  const delivery = await materializeDeliveryWithAuthorityEvidenceWithDatabase(
    database,
    input,
  );
  return delivery ? { ...delivery.variables } : null;
}
