import { createHash } from "node:crypto";

import {
  dispatchBinding,
  preparedEmailBindingMatches,
  type DispatchBinding,
  type MailDispatchAuthority,
  type PreparedEmail,
} from "./prepared-dispatch";
import {
  parseRevocableSourceVariables,
  type LostDeviceAuthorityEvidence,
} from "./revocable-source-authority";

declare const dispatchAuthorizationEnvelopeBrand: unique symbol;
declare const dispatchSourceSha256Brand: unique symbol;

export type DispatchAuthorizationEnvelope = Readonly<{
  [dispatchAuthorizationEnvelopeBrand]: "DispatchAuthorizationEnvelope";
}>;

type DispatchSourceSha256 = string &
  Readonly<{
    [dispatchSourceSha256Brand]: "DispatchSourceSha256";
  }>;

export type DispatchAuthorizationSource = Readonly<{
  applicationUrl: string;
  outboxId: string;
  template: string;
  templateVersion: string;
  variables: Readonly<Record<string, string>>;
}>;

export type DispatchAuthorizationState = Readonly<{
  binding: DispatchBinding;
  authorityEvidence?: LostDeviceAuthorityEvidence;
  sourceSha256: DispatchSourceSha256;
}>;

const AUTHORIZATION_STATES = new WeakMap<
  DispatchAuthorizationEnvelope,
  DispatchAuthorizationState
>();

function updateFramed(hash: ReturnType<typeof createHash>, value: string) {
  hash.update(`${Buffer.byteLength(value, "utf8")}:`, "utf8");
  hash.update(value, "utf8");
}

function sourceSha256(source: DispatchAuthorizationSource) {
  const hash = createHash("sha256");
  updateFramed(hash, "codestead.mail.dispatch-source.v1");
  updateFramed(hash, source.applicationUrl);
  updateFramed(hash, source.outboxId);
  updateFramed(hash, source.template);
  updateFramed(hash, source.templateVersion);
  for (const [key, value] of Object.entries(source.variables).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    updateFramed(hash, key);
    updateFramed(hash, value);
  }
  return hash.digest("hex") as DispatchSourceSha256;
}

function validSource(source: DispatchAuthorizationSource) {
  return (
    Object.isFrozen(source) &&
    Object.isFrozen(source.variables) &&
    Object.entries(source.variables).every(
      ([key, value]) => key.length > 0 && typeof value === "string",
    )
  );
}

export function createDispatchAuthorizationEnvelope(
  input: Readonly<{
    authority: MailDispatchAuthority;
    prepared: PreparedEmail;
    source: DispatchAuthorizationSource;
    authorityEvidence?: LostDeviceAuthorityEvidence;
  }>,
): DispatchAuthorizationEnvelope {
  if (
    !Object.isFrozen(input.prepared) ||
    !Object.isFrozen(input.authority) ||
    !validSource(input.source) ||
    (input.authorityEvidence !== undefined &&
      !Object.isFrozen(input.authorityEvidence)) ||
    !preparedEmailBindingMatches(input.prepared, input.authority) ||
    input.authority.id !== input.source.outboxId ||
    input.authority.template !== input.source.template ||
    input.authority.templateVersion !== input.source.templateVersion
  ) {
    throw new Error("Dispatch authorization input is not sealed.");
  }

  const parsed = parseRevocableSourceVariables({
    applicationUrl: input.source.applicationUrl,
    template: input.source.template,
    templateVersion: input.source.templateVersion,
    variables: input.source.variables,
  });
  if (
    (input.authorityEvidence === undefined &&
      input.source.template === "lost-device-proof") ||
    (input.authorityEvidence !== undefined &&
      (parsed?.kind !== "lost-device-proof" ||
        parsed.sourceId !== input.authorityEvidence.sourceId))
  ) {
    throw new Error(
      "Dispatch source evidence does not match prepared authority.",
    );
  }

  const state = Object.freeze({
    binding: dispatchBinding(input.prepared),
    sourceSha256: sourceSha256(input.source),
    ...(input.authorityEvidence === undefined
      ? {}
      : { authorityEvidence: input.authorityEvidence }),
  });
  const envelope = Object.freeze({}) as DispatchAuthorizationEnvelope;
  AUTHORIZATION_STATES.set(envelope, state);
  return envelope;
}

export function inspectDispatchAuthorizationEnvelope(
  envelope: DispatchAuthorizationEnvelope,
): DispatchAuthorizationState | null {
  if (!Object.isFrozen(envelope)) return null;
  return AUTHORIZATION_STATES.get(envelope) ?? null;
}

export function dispatchAuthorizationMatchesSource(
  envelope: DispatchAuthorizationEnvelope,
  source: DispatchAuthorizationSource,
) {
  const state = inspectDispatchAuthorizationEnvelope(envelope);
  return (
    state !== null &&
    validSource(source) &&
    state.sourceSha256 === sourceSha256(source)
  );
}
