import { createHash, timingSafeEqual } from "node:crypto";

import {
  authorizePreparedEmail,
  classifyMailDeliveryError,
  sendPreparedEmail,
  type PreparedEmailAuthorization,
} from "./mailer-transport-internal";
import {
  FatalProviderTransportError,
  type PostProviderExit,
} from "./provider-dispatch-contract";

import {
  dispatchBinding,
  prepareEmail,
  preparedEmailBindingMatches,
  type DispatchBinding,
  type MailAdapter,
  type MailDispatchAuthority,
  type PreparedEmail,
  type SourceAuthoritySha256,
} from "./prepared-dispatch";
import {
  issuedLostDeviceAuthorityEvidenceMatches,
  parseRevocableSourceVariables,
  type LostDeviceAuthorityEvidence,
} from "./revocable-source-authority";

const SOURCE_AUTHORITY_DOMAIN = "codestead.mail.dispatch-source.v1";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VARIABLE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const LOST_DEVICE_RAW_PROOF = /^[A-Za-z0-9_-]{43}$/;
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

export type PreparedDispatchDelivery = Readonly<{
  authorityEvidence: LostDeviceAuthorityEvidence;
  variables: Readonly<Record<string, string>>;
}>;

export type PreparedDispatchStoreView = Readonly<{
  binding: DispatchBinding;
  sourceAuthoritySha256: SourceAuthoritySha256;
  authorityEvidence?: LostDeviceAuthorityEvidence;
}>;

declare const preparedDispatchEnvelopeBrand: unique symbol;

export type PreparedDispatchEnvelope = Readonly<{
  [preparedDispatchEnvelopeBrand]: "PreparedDispatchEnvelope";
}>;

export type MaterializedDispatch = Readonly<{
  prepared: PreparedEmail;
  envelope: PreparedDispatchEnvelope;
}>;

type PreparedDispatchState = Readonly<{
  prepared: PreparedEmail;
  authority: MailDispatchAuthority;
  source: PreparedDispatchSource;
  storeView: PreparedDispatchStoreView;
}>;

const PREPARED_DISPATCH_STATES = new WeakMap<
  PreparedDispatchEnvelope,
  PreparedDispatchState
>();
const COMMIT_ELIGIBLE_ENVELOPES = new WeakSet<PreparedDispatchEnvelope>();

function invalidCanonicalData(): never {
  throw new Error("Prepared dispatch input must be canonical plain data.");
}

function plainDataDescriptors(value: unknown) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return invalidCanonicalData();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    return invalidCanonicalData();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      return invalidCanonicalData();
    }
  }
  return { descriptors, keys: keys as string[] };
}

function exactDescriptorKeys(
  actual: readonly string[],
  expected: readonly string[],
) {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  if (
    sortedActual.length !== sortedExpected.length
    || sortedActual.some((key, index) => key !== sortedExpected[index])
  ) {
    invalidCanonicalData();
  }
}

function canonicalStringRecord(value: unknown) {
  const { descriptors, keys } = plainDataDescriptors(value);
  if (keys.length > 128) invalidCanonicalData();
  const snapshot: Record<string, string> = {};
  for (const key of [...keys].sort()) {
    const field = descriptors[key]!.value;
    if (
      !VARIABLE_KEY.test(key)
      || typeof field !== "string"
      || field.length > 8_192
      || field.includes("\u0000")
    ) {
      invalidCanonicalData();
    }
    snapshot[key] = field;
  }
  return Object.freeze(snapshot);
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

function canonicalSource(value: unknown): PreparedDispatchSource {
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
  const { descriptors, keys } = plainDataDescriptors(value);
  exactDescriptorKeys(keys, expectedKeys);
  const get = (key: typeof expectedKeys[number]) => descriptors[key]!.value;
  const applicationUrl = get("applicationUrl");
  const outboxId = get("outboxId");
  const operationId = get("operationId");
  const claimToken = get("claimToken");
  const claimOwner = get("claimOwner");
  const claimVersion = get("claimVersion");
  const deliveryScopeKey = get("deliveryScopeKey");
  const recipient = get("recipient");
  const template = get("template");
  const templateVersion = get("templateVersion");
  if (
    !boundedText(applicationUrl, 2_048, true)
    || typeof outboxId !== "string"
    || !UUID.test(outboxId)
    || typeof operationId !== "string"
    || !UUID.test(operationId)
    || !boundedText(claimToken, 512)
    || !boundedText(claimOwner, 128)
    || !Number.isSafeInteger(claimVersion)
    || Number(claimVersion) <= 0
    || !boundedText(deliveryScopeKey, 512)
    || !boundedText(recipient, 320)
    || /[\r\n]/.test(recipient)
    || !boundedText(template, 80)
    || !boundedText(templateVersion, 64)
  ) {
    throw new Error("Prepared dispatch source is invalid.");
  }
  return Object.freeze({
    applicationUrl,
    outboxId,
    operationId,
    claimToken,
    claimOwner,
    claimVersion: Number(claimVersion),
    deliveryScopeKey,
    recipient,
    template: template as PreparedDispatchSource["template"],
    templateVersion,
    variables: canonicalStringRecord(get("variables")),
  });
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
      throw new Error("Prepared dispatch delivery evidence is invalid.");
    }
    return parsed.sourceId;
  }
  if (authorityEvidence !== undefined) {
    throw new Error("Prepared dispatch delivery override is not permitted.");
  }
  return null;
}

function digestCanonicalSource(
  source: PreparedDispatchSource,
  authorityEvidence?: LostDeviceAuthorityEvidence,
) {
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
  ]) updateLengthFramed(hash, value);
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

export function sourceAuthoritySha256(
  source: PreparedDispatchSource,
  authorityEvidence?: LostDeviceAuthorityEvidence,
): SourceAuthoritySha256 {
  return digestCanonicalSource(canonicalSource(source), authorityEvidence);
}

function sameSha256(left: string, right: string) {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function linkedLostDeviceVariables(
  source: PreparedDispatchSource,
  delivery: PreparedDispatchDelivery,
) {
  const { descriptors, keys } = plainDataDescriptors(delivery);
  exactDescriptorKeys(keys, ["authorityEvidence", "variables"]);
  const authorityEvidence = descriptors.authorityEvidence!.value as
    LostDeviceAuthorityEvidence;
  const variables = canonicalStringRecord(descriptors.variables!.value);
  const sourceId = assertSourceEvidence(source, authorityEvidence);
  if (
    !sourceId
    || Object.keys(variables).sort().join("\u0000") !== "name\u0000url"
    || variables.name !== source.variables.name
  ) {
    throw new Error("Prepared dispatch delivery evidence is invalid.");
  }
  let rawProof: string;
  try {
    const url = new URL(variables.url!);
    const origin = new URL(source.applicationUrl).origin;
    const prefix = "#proof=";
    if (
      url.origin !== origin
      || url.pathname !== "/lost-device"
      || url.search
      || url.username
      || url.password
      || !url.hash.startsWith(prefix)
    ) throw new Error("invalid");
    rawProof = decodeURIComponent(url.hash.slice(prefix.length));
    if (
      !LOST_DEVICE_RAW_PROOF.test(rawProof)
      || variables.url !== `${origin}/lost-device#proof=${rawProof}`
    ) throw new Error("invalid");
  } catch {
    throw new Error("Prepared dispatch delivery evidence is invalid.");
  }
  const proofHash = createHash("sha256").update(rawProof).digest("hex");
  if (!sameSha256(proofHash, authorityEvidence.proofHash)) {
    throw new Error("Prepared dispatch delivery evidence is invalid.");
  }
  return Object.freeze({ authorityEvidence, variables });
}

function materializedVariables(
  source: PreparedDispatchSource,
  delivery?: PreparedDispatchDelivery,
) {
  if (source.template === "lost-device-proof" && source.templateVersion === "1") {
    if (!delivery) {
      throw new Error("Prepared dispatch delivery evidence is invalid.");
    }
    return linkedLostDeviceVariables(source, delivery);
  }
  if (delivery !== undefined) {
    throw new Error("Prepared dispatch delivery override is not permitted.");
  }
  assertSourceEvidence(source);
  return Object.freeze({
    authorityEvidence: undefined,
    variables: source.variables,
  });
}

export function createMaterializedDispatch(input: Readonly<{
  source: PreparedDispatchSource;
  adapter: MailAdapter;
  from: string;
  messageId: string;
  delivery?: PreparedDispatchDelivery;
}>): MaterializedDispatch {
  const expectedKeys = ["source", "adapter", "from", "messageId"];
  const { descriptors, keys } = plainDataDescriptors(input);
  const hasDelivery = keys.includes("delivery");
  exactDescriptorKeys(
    keys,
    hasDelivery ? [...expectedKeys, "delivery"] : expectedKeys,
  );
  const adapter = descriptors.adapter!.value;
  const from = descriptors.from!.value;
  const messageId = descriptors.messageId!.value;
  if (
    (adapter !== "console" && adapter !== "gmail")
    || !boundedText(from, 512)
    || !boundedText(messageId, 512)
  ) {
    invalidCanonicalData();
  }
  if (
    hasDelivery
    && (
      !descriptors.delivery
      || descriptors.delivery.value === undefined
    )
  ) invalidCanonicalData();

  const source = canonicalSource(descriptors.source!.value);
  const delivery = hasDelivery
    ? descriptors.delivery!.value as PreparedDispatchDelivery
    : undefined;
  const rendered = materializedVariables(source, delivery);
  const sourceDigest = digestCanonicalSource(
    source,
    rendered.authorityEvidence,
  );
  const authority = Object.freeze({
    id: source.outboxId,
    operationId: source.operationId,
    claimToken: source.claimToken,
    claimOwner: source.claimOwner,
    claimVersion: source.claimVersion,
    deliveryScopeKey: source.deliveryScopeKey,
    sourceAuthoritySha256: sourceDigest,
    recipient: source.recipient,
    template: source.template,
    templateVersion: source.templateVersion,
  });
  const prepared = prepareEmail({
    to: source.recipient,
    template: source.template,
    templateVersion: source.templateVersion,
    variables: { ...rendered.variables },
  }, {
    adapter,
    from,
    messageId,
    authority,
  });
  if (!preparedEmailBindingMatches(prepared, authority)) {
    throw new Error("Prepared dispatch binding does not match its authority.");
  }
  const storeView = Object.freeze({
    binding: dispatchBinding(prepared),
    sourceAuthoritySha256: sourceDigest,
    ...(rendered.authorityEvidence
      ? { authorityEvidence: rendered.authorityEvidence }
      : {}),
  });
  const envelope = Object.freeze({}) as PreparedDispatchEnvelope;
  PREPARED_DISPATCH_STATES.set(envelope, Object.freeze({
    prepared,
    authority,
    source,
    storeView,
  }));
  COMMIT_ELIGIBLE_ENVELOPES.add(envelope);
  const materialized = Object.create(null) as MaterializedDispatch;
  Object.defineProperties(materialized, {
    prepared: {
      configurable: false,
      enumerable: false,
      value: prepared,
      writable: false,
    },
    envelope: {
      configurable: false,
      enumerable: false,
      value: envelope,
      writable: false,
    },
  });
  return Object.freeze(materialized);
}

export function preparedDispatchStoreView(
  envelope: PreparedDispatchEnvelope,
): PreparedDispatchStoreView | null {
  if (!Object.isFrozen(envelope)) return null;
  return PREPARED_DISPATCH_STATES.get(envelope)?.storeView ?? null;
}

declare const guardedPreparedDispatchBrand: unique symbol;

export type GuardedPreparedDispatch = Readonly<{
  [guardedPreparedDispatchBrand]: "GuardedPreparedDispatch";
}>;

type GuardedState = Readonly<{
  authorization: PreparedEmailAuthorization;
}>;

const GUARDED_DISPATCH_STATES = new WeakMap<
  GuardedPreparedDispatch,
  GuardedState
>();

function fatalTransportError(error: unknown) {
  if (error instanceof FatalProviderTransportError) return error;
  const failure = classifyMailDeliveryError(error);
  return failure.kind === "fatal"
    ? new FatalProviderTransportError(failure.code)
    : null;
}

/**
 * Store-only provider primitive. Production import-surface tests restrict this
 * receipt-free function to PostgresOutboxStore, which invokes it only after
 * consuming its own definite-TX1, store-instance-bound receipt.
 */
export async function authorizeCommittedPreparedDispatch(
  envelope: PreparedDispatchEnvelope,
): Promise<GuardedPreparedDispatch> {
  if (
    !Object.isFrozen(envelope)
    || !COMMIT_ELIGIBLE_ENVELOPES.has(envelope)
  ) {
    throw new Error("Prepared dispatch envelope is invalid or already used.");
  }
  const dispatch = PREPARED_DISPATCH_STATES.get(envelope);
  if (!dispatch) {
    throw new Error("Prepared dispatch envelope is invalid or already used.");
  }
  COMMIT_ELIGIBLE_ENVELOPES.delete(envelope);

  let authorization: PreparedEmailAuthorization;
  try {
    authorization = await authorizePreparedEmail(
      dispatch.prepared,
      dispatch.authority,
    );
  } catch (error) {
    const fatalError = fatalTransportError(error);
    if (fatalError) throw fatalError;
    throw error;
  }

  const guarded = Object.freeze({}) as GuardedPreparedDispatch;
  GUARDED_DISPATCH_STATES.set(guarded, Object.freeze({ authorization }));
  return guarded;
}

async function settlePreparedDelivery(
  delivery: Promise<Readonly<{ providerId: string }>>,
): Promise<PostProviderExit> {
  try {
    const result = await delivery;
    const providerMessageId = result.providerId.trim();
    return providerMessageId && providerMessageId.length <= 512
      ? { kind: "sent", providerMessageId }
      : { kind: "quarantined", code: "PROVIDER_MESSAGE_ID_MISSING" };
  } catch (error) {
    if (error instanceof FatalProviderTransportError) throw error;
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

export async function dispatchGuardedPrepared(
  guarded: GuardedPreparedDispatch,
  signal: AbortSignal,
): Promise<PostProviderExit> {
  const state = GUARDED_DISPATCH_STATES.get(guarded);
  if (!state || !Object.isFrozen(guarded)) {
    throw new Error("Guarded prepared dispatch is invalid or already used.");
  }
  GUARDED_DISPATCH_STATES.delete(guarded);

  // sendPreparedEmail calls the physical provider operation synchronously before
  // returning its promise. The store may arm post-initiation watchdogs only
  // after this call returns.
  const delivery = sendPreparedEmail(state.authorization, { signal });
  return settlePreparedDelivery(delivery);
}
