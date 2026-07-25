import { createHash } from "node:crypto";

import {
  authorizePreparedEmail,
  classifyMailDeliveryError,
  sendPreparedEmail,
  type PreparedEmailAuthorization,
} from "./mailer";
import {
  dispatchBinding,
  preparedEmailBindingMatches,
  type DispatchBinding,
  type MailDispatchAuthority,
  type PreparedEmail,
  type SourceAuthoritySha256,
} from "./prepared-dispatch";
import {
  issuedLostDeviceAuthorityEvidenceMatches,
  parseRevocableSourceVariables,
  type LostDeviceAuthorityEvidence,
} from "./revocable-source-authority";
import {
  FatalProviderTransportError,
  type PostProviderExit,
} from "./outbox-worker";

const SOURCE_AUTHORITY_DOMAIN = "codestead.mail.dispatch-source.v1";
const SHA256 = /^[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VARIABLE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const REVOCABLE_TEMPLATE_VERSIONS = new Set([
  "reset-password@1",
  "lost-device-proof@1",
  "session-revocation-requested@1",
  "inactivity-reminder@2",
  "inactivity-reminder-followup@2",
  "inactivity-admin-notice@2",
  "daily-study-reminder@1",
  "revision-reminder@1",
  "goal-reminder@1",
  "challenge-reminder@1",
  "weekly-summary@1",
]);

export type PreparedDispatchSource = Readonly<{
  applicationUrl: string;
  outboxId: string;
  operationId: string;
  claimToken: string;
  claimOwner: string;
  claimVersion: number;
  deliveryScopeKey: string;
  recipient: string;
  template: MailDispatchAuthority["template"];
  templateVersion: string;
  variables: Readonly<Record<string, string>>;
}>;

export type PreparedDispatchStoreView = Readonly<{
  binding: DispatchBinding;
  sourceAuthoritySha256: SourceAuthoritySha256;
  authorityEvidence?: LostDeviceAuthorityEvidence;
}>;

declare const preparedDispatchEnvelopeBrand: unique symbol;
declare const guardedPreparedDispatchBrand: unique symbol;

export type PreparedDispatchEnvelope = Readonly<{
  [preparedDispatchEnvelopeBrand]: "PreparedDispatchEnvelope";
}>;

export type GuardedPreparedDispatch = Readonly<{
  [guardedPreparedDispatchBrand]: "GuardedPreparedDispatch";
}>;

export type MaterializedDispatch = Readonly<{
  prepared: PreparedEmail;
  envelope: PreparedDispatchEnvelope;
}>;

export type GuardedPreparedDispatchStoreView = Readonly<{
  envelope: PreparedDispatchEnvelope;
  dispatch: PreparedDispatchStoreView;
}>;

type PreparedDispatchState = Readonly<{
  prepared: PreparedEmail;
  authority: MailDispatchAuthority;
  source: PreparedDispatchSource;
  storeView: PreparedDispatchStoreView;
}>;

type GuardedPreparedDispatchState = Readonly<{
  authorization: PreparedEmailAuthorization;
  storeView: GuardedPreparedDispatchStoreView;
}>;

const PREPARED_DISPATCH_STATES = new WeakMap<
  PreparedDispatchEnvelope,
  PreparedDispatchState
>();
const GUARDED_DISPATCH_STATES = new WeakMap<
  GuardedPreparedDispatch,
  GuardedPreparedDispatchState
>();

function exactOwnKeys(value: object, expected: readonly string[]) {
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.length
    && actual.every((key) => typeof key === "string")
    && [...actual].sort().every((key, index) => key === [...expected].sort()[index]);
}

function boundedText(
  value: unknown,
  maximumLength: number,
  allowEmpty = false,
): value is string {
  return typeof value === "string"
    && value.length <= maximumLength
    && (allowEmpty || value.length > 0)
    && !value.includes("\u0000");
}

function assertPreparedDispatchSource(source: PreparedDispatchSource) {
  const expectedKeys = [
    "applicationUrl",
    "outboxId",
    "operationId",
    "claimToken",
    "claimOwner",
    "claimVersion",
    "deliveryScopeKey",
    "recipient",
    "template",
    "templateVersion",
    "variables",
  ] as const;
  if (
    !Object.isFrozen(source)
    || !exactOwnKeys(source, expectedKeys)
    || !boundedText(source.applicationUrl, 2_048, true)
    || !UUID.test(source.outboxId)
    || !UUID.test(source.operationId)
    || !boundedText(source.claimToken, 512)
    || !boundedText(source.claimOwner, 128)
    || !Number.isSafeInteger(source.claimVersion)
    || source.claimVersion <= 0
    || !boundedText(source.deliveryScopeKey, 512)
    || !boundedText(source.recipient, 320)
    || /[\r\n]/.test(source.recipient)
    || !boundedText(source.template, 80)
    || !boundedText(source.templateVersion, 64)
    || typeof source.variables !== "object"
    || source.variables === null
    || !Object.isFrozen(source.variables)
  ) {
    throw new Error("Prepared dispatch source is invalid.");
  }
  const variableKeys = Reflect.ownKeys(source.variables);
  if (
    variableKeys.length > 128
    || variableKeys.some((key) => typeof key !== "string")
  ) {
    throw new Error("Prepared dispatch variables are invalid.");
  }
  for (const key of variableKeys as string[]) {
    const value = source.variables[key];
    if (
      !VARIABLE_KEY.test(key)
      || !boundedText(value, 8_192, true)
    ) {
      throw new Error("Prepared dispatch variables are invalid.");
    }
  }
}

function updateLengthFramed(
  hash: ReturnType<typeof createHash>,
  value: string,
) {
  hash.update(`${Buffer.byteLength(value, "utf8")}:`, "utf8");
  hash.update(value, "utf8");
}

function assertSourceEvidence(
  source: PreparedDispatchSource,
  authorityEvidence?: LostDeviceAuthorityEvidence,
) {
  const parsed = parseRevocableSourceVariables({
    applicationUrl: source.applicationUrl,
    template: source.template,
    templateVersion: source.templateVersion,
    variables: source.variables,
  });
  const sourceKey = `${source.template}@${source.templateVersion}`;
  if (REVOCABLE_TEMPLATE_VERSIONS.has(sourceKey) && !parsed) {
    throw new Error("Prepared dispatch source evidence is invalid.");
  }
  if (parsed?.kind === "lost-device-proof") {
    if (!issuedLostDeviceAuthorityEvidenceMatches(
      authorityEvidence,
      parsed.sourceId,
    )) {
      throw new Error("Prepared dispatch source evidence is invalid.");
    }
    return;
  }
  if (authorityEvidence !== undefined) {
    throw new Error("Prepared dispatch source evidence is invalid.");
  }
}

export function sourceAuthoritySha256(
  source: PreparedDispatchSource,
  authorityEvidence?: LostDeviceAuthorityEvidence,
): SourceAuthoritySha256 {
  assertPreparedDispatchSource(source);
  assertSourceEvidence(source, authorityEvidence);
  const hash = createHash("sha256");
  for (const value of [
    SOURCE_AUTHORITY_DOMAIN,
    source.applicationUrl,
    source.outboxId,
    source.operationId,
    source.claimToken,
    source.claimOwner,
    String(source.claimVersion),
    source.deliveryScopeKey,
    source.recipient,
    source.template,
    source.templateVersion,
  ]) {
    updateLengthFramed(hash, value);
  }
  const variableKeys = Object.keys(source.variables).sort();
  updateLengthFramed(hash, String(variableKeys.length));
  for (const key of variableKeys) {
    updateLengthFramed(hash, key);
    updateLengthFramed(hash, source.variables[key]!);
  }
  if (authorityEvidence === undefined) {
    updateLengthFramed(hash, "none");
  } else {
    updateLengthFramed(hash, authorityEvidence.kind);
    updateLengthFramed(hash, authorityEvidence.sourceId);
    updateLengthFramed(hash, authorityEvidence.proofHash);
  }
  return hash.digest("hex") as SourceAuthoritySha256;
}

function assertSourceMatchesAuthority(
  source: PreparedDispatchSource,
  authority: MailDispatchAuthority,
  expectedSourceSha256: SourceAuthoritySha256,
) {
  if (
    authority.id !== source.outboxId
    || authority.operationId !== source.operationId
    || authority.claimToken !== source.claimToken
    || authority.claimOwner !== source.claimOwner
    || authority.claimVersion !== source.claimVersion
    || authority.deliveryScopeKey !== source.deliveryScopeKey
    || authority.recipient !== source.recipient
    || authority.template !== source.template
    || authority.templateVersion !== source.templateVersion
    || authority.sourceAuthoritySha256 !== expectedSourceSha256
  ) {
    throw new Error("Prepared dispatch source does not match its authority.");
  }
}

export function createPreparedDispatchEnvelope(input: Readonly<{
  prepared: PreparedEmail;
  authority: MailDispatchAuthority;
  source: PreparedDispatchSource;
  authorityEvidence?: LostDeviceAuthorityEvidence;
}>): PreparedDispatchEnvelope {
  if (
    !Object.isFrozen(input.prepared)
    || !Object.isFrozen(input.authority)
    || !Object.isFrozen(input.source)
    || (
      input.authorityEvidence !== undefined
      && !Object.isFrozen(input.authorityEvidence)
    )
  ) {
    throw new Error("Prepared dispatch envelope input is not sealed.");
  }
  const expectedSourceSha256 = sourceAuthoritySha256(
    input.source,
    input.authorityEvidence,
  );
  if (!SHA256.test(expectedSourceSha256)) {
    throw new Error("Prepared dispatch source digest is invalid.");
  }
  assertSourceMatchesAuthority(
    input.source,
    input.authority,
    expectedSourceSha256,
  );
  if (!preparedEmailBindingMatches(input.prepared, input.authority)) {
    throw new Error("Prepared dispatch binding does not match its authority.");
  }
  const storeView = Object.freeze({
    binding: dispatchBinding(input.prepared),
    sourceAuthoritySha256: expectedSourceSha256,
    ...(input.authorityEvidence === undefined
      ? {}
      : { authorityEvidence: input.authorityEvidence }),
  });
  const envelope = Object.freeze({}) as PreparedDispatchEnvelope;
  PREPARED_DISPATCH_STATES.set(envelope, Object.freeze({
    prepared: input.prepared,
    authority: input.authority,
    source: input.source,
    storeView,
  }));
  return envelope;
}

export function preparedDispatchStoreView(
  envelope: PreparedDispatchEnvelope,
): PreparedDispatchStoreView | null {
  if (!Object.isFrozen(envelope)) return null;
  return PREPARED_DISPATCH_STATES.get(envelope)?.storeView ?? null;
}

export function preparedEnvelopeMatches(
  envelope: PreparedDispatchEnvelope,
  prepared: PreparedEmail,
) {
  return Object.isFrozen(envelope)
    && Object.isFrozen(prepared)
    && PREPARED_DISPATCH_STATES.get(envelope)?.prepared === prepared;
}

export function createMaterializedDispatch(
  prepared: PreparedEmail,
  envelope: PreparedDispatchEnvelope,
): MaterializedDispatch {
  if (!preparedEnvelopeMatches(envelope, prepared)) {
    throw new Error("Materialized dispatch identity does not match.");
  }
  return Object.freeze({ prepared, envelope });
}

function fatalTransportError(error: unknown) {
  const failure = classifyMailDeliveryError(error);
  return failure.kind === "fatal"
    ? new FatalProviderTransportError(failure.code)
    : null;
}

export async function authorizePreparedDispatch(
  envelope: PreparedDispatchEnvelope,
): Promise<GuardedPreparedDispatch> {
  const state = PREPARED_DISPATCH_STATES.get(envelope);
  if (!state || !Object.isFrozen(envelope)) {
    throw new Error("Prepared dispatch envelope is invalid or already used.");
  }
  PREPARED_DISPATCH_STATES.delete(envelope);
  let authorization: PreparedEmailAuthorization;
  try {
    authorization = await authorizePreparedEmail(
      state.prepared,
      state.authority,
    );
  } catch (error) {
    const fatalError = fatalTransportError(error);
    if (fatalError) throw fatalError;
    throw error;
  }
  const guarded = Object.freeze({}) as GuardedPreparedDispatch;
  GUARDED_DISPATCH_STATES.set(guarded, Object.freeze({
    authorization,
    storeView: Object.freeze({
      envelope,
      dispatch: state.storeView,
    }),
  }));
  return guarded;
}

export function guardedDispatchStoreView(
  guarded: GuardedPreparedDispatch,
): GuardedPreparedDispatchStoreView | null {
  if (!Object.isFrozen(guarded)) return null;
  return GUARDED_DISPATCH_STATES.get(guarded)?.storeView ?? null;
}

export async function dispatchGuardedPrepared(
  guarded: GuardedPreparedDispatch,
  signal: AbortSignal,
): Promise<PostProviderExit> {
  const state = GUARDED_DISPATCH_STATES.get(guarded);
  if (!state || !Object.isFrozen(guarded)) {
    throw new Error("Guarded prepared dispatch is invalid or already consumed.");
  }
  GUARDED_DISPATCH_STATES.delete(guarded);
  try {
    const result = await sendPreparedEmail(
      state.authorization,
      { signal },
    );
    const providerMessageId = result.providerId.trim();
    return providerMessageId && providerMessageId.length <= 512
      ? { kind: "sent", providerMessageId }
      : { kind: "quarantined", code: "PROVIDER_MESSAGE_ID_MISSING" };
  } catch (error) {
    const failure = classifyMailDeliveryError(error);
    if (failure.kind === "fatal") {
      throw new FatalProviderTransportError(failure.code);
    }
    if (failure.kind === "definitely-rejected") {
      return { kind: "failed", code: failure.code };
    }
    return { kind: "quarantined", code: failure.code };
  }
}
