import {
  dispatchBinding,
  preparedEmailBindingMatches,
  type DispatchBinding,
  type MailDispatchAuthority,
  type PreparedEmail,
} from "./prepared-dispatch";
import type { LostDeviceAuthorityEvidence } from "./revocable-source-authority";

declare const dispatchAuthorizationEnvelopeBrand: unique symbol;

export type DispatchAuthorizationEnvelope = Readonly<{
  [dispatchAuthorizationEnvelopeBrand]: "DispatchAuthorizationEnvelope";
}>;

export type DispatchAuthorizationState = Readonly<{
  binding: DispatchBinding;
  authorityEvidence?: LostDeviceAuthorityEvidence;
}>;

const AUTHORIZATION_STATES = new WeakMap<
  DispatchAuthorizationEnvelope,
  DispatchAuthorizationState
>();

export function createDispatchAuthorizationEnvelope(
  input: Readonly<{
    authority: MailDispatchAuthority;
    prepared: PreparedEmail;
    authorityEvidence?: LostDeviceAuthorityEvidence;
  }>,
): DispatchAuthorizationEnvelope {
  if (
    !Object.isFrozen(input.prepared) ||
    !Object.isFrozen(input.authority) ||
    (input.authorityEvidence !== undefined &&
      !Object.isFrozen(input.authorityEvidence)) ||
    !preparedEmailBindingMatches(input.prepared, input.authority)
  ) {
    throw new Error("Dispatch authorization input is not sealed.");
  }
  const state = Object.freeze({
    binding: dispatchBinding(input.prepared),
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
