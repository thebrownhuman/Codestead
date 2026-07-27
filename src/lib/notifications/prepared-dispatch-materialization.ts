import { createHash, timingSafeEqual } from "node:crypto";

import {
  authorizePreparedEmail,
  capturePreparedMailTransportPlan,
  discardPreparedEmailAuthorization,
  discardPreparedMailTransportPlan,
  sendPreparedEmail,
  type MailTransportConfiguration,
  type PreparedEmailAuthorization,
  type PreparedMailTransportPlan,
} from "./mailer-transport-internal";
import {
  classifyMailDeliveryError,
  FatalProviderTransportError,
  isFatalProviderTransportError,
  type CommittedPreparedDispatchReceipt,
  type PostProviderExit,
} from "./provider-dispatch-contract";

import {
  consumeMaterializedGmailPreparation,
  dispatchBinding,
  issueMaterializedGmailPreparation,
  prepareEmail,
  preparedEmailBindingMatches,
  type DispatchBinding,
  type MailAdapter,
  type MailDispatchAuthority,
  type PreparedEmail,
  type SourceAuthoritySha256,
} from "./prepared-dispatch";
import {
  buildRevocableSourceAuthorityQuery,
  parseRevocableSourceVariables,
  type LostDeviceAuthorityEvidence,
} from "./revocable-source-authority";
import {
  dispatchEvidenceSha256,
  PROVIDER_EVIDENCE_VERSION,
  type ProviderEvidenceVersion,
} from "./dispatch-evidence";
import {
  OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
  outboxCorrelationToken,
  type ProviderCorrelationVersion,
} from "./provider-correlation";
import {
  consumePreparedDispatchChannelOwner,
  type LiveProviderTx2Context,
  type PreparedDispatchChannelOwnerAuthority,
} from "./postgres-outbox-store";
import type { ProviderCallPermit } from "./outbox-worker";

const SOURCE_AUTHORITY_DOMAIN = "codestead.mail.dispatch-source.v1";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VARIABLE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const RESERVED_MAIL_AUTHORITY_VARIABLE_KEYS = new Set([
  "_mailAudienceId",
  "_mailOperationId",
  "_mailProducer",
  "_mailRecipient",
  "_mailSourceId",
]);
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

declare const preparedDispatchEnvelopeBrand: unique symbol;
declare const preparedDispatchStoreViewBrand: unique symbol;
declare const materializedDispatchBrand: unique symbol;

export type PreparedDispatchEnvelope = Readonly<{
  [preparedDispatchEnvelopeBrand]: "PreparedDispatchEnvelope";
}>;

export type PreparedDispatchStoreView = Readonly<{
  [preparedDispatchStoreViewBrand]: "PreparedDispatchStoreView";
}>;

export type MaterializedDispatch = Readonly<{
  [materializedDispatchBrand]: "MaterializedDispatch";
}>;

export type PreparedDispatchRuntimePlan = Readonly<{
  timeouts: Readonly<{
    oauthDeadlineMs: number;
    guardedSendDeadlineMs: number;
    providerAbortSettlementMs: number;
  }>;
}>;

export type PreparedDispatchStoreInspection = Readonly<{
  binding: DispatchBinding;
  providerRequestBodySha256: string;
  providerRequestBodyLength: number;
  sourceAuthoritySha256: SourceAuthoritySha256;
  authorityEvidence?: LostDeviceAuthorityEvidence;
  providerCorrelationVersion: ProviderCorrelationVersion;
  providerEvidenceVersion: ProviderEvidenceVersion | null;
  providerEvidenceSha256: string | null;
}>;

type PreparedDispatchState = Readonly<{
  prepared: PreparedEmail;
  authority: MailDispatchAuthority;
  source: PreparedDispatchSource;
  storeView: PreparedDispatchStoreView;
  runtimePlan: PreparedDispatchRuntimePlan;
  transportPlan: PreparedMailTransportPlan;
}>;

type MaterializedDispatchState = Readonly<{
  envelope: PreparedDispatchEnvelope;
}>;

const PREPARED_DISPATCH_STATES = new WeakMap<
  PreparedDispatchEnvelope,
  PreparedDispatchState
>();
const PREPARED_DISPATCH_STORE_STATES = new WeakMap<
  PreparedDispatchStoreView,
  PreparedDispatchStoreInspection
>();
const MATERIALIZED_DISPATCH_STATES = new WeakMap<
  MaterializedDispatch,
  MaterializedDispatchState
>();
const AUTHORIZATION_ELIGIBLE_ENVELOPES =
  new WeakSet<PreparedDispatchEnvelope>();

function invalidCanonicalData(): never {
  throw new Error("Prepared dispatch input must be canonical plain data.");
}

function plainDataDescriptors(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
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
    sortedActual.length !== sortedExpected.length ||
    sortedActual.some((key, index) => key !== sortedExpected[index])
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
      (!VARIABLE_KEY.test(key) &&
        !RESERVED_MAIL_AUTHORITY_VARIABLE_KEYS.has(key)) ||
      typeof field !== "string" ||
      field.length > 8_192 ||
      field.includes("\u0000")
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
  return (
    typeof value === "string" &&
    value.length <= maximumLength &&
    (allowEmpty || value.length > 0) &&
    !value.includes("\u0000")
  );
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
  const get = (key: (typeof expectedKeys)[number]) => descriptors[key]!.value;
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
    !boundedText(applicationUrl, 2_048, true) ||
    typeof outboxId !== "string" ||
    !UUID.test(outboxId) ||
    typeof operationId !== "string" ||
    !UUID.test(operationId) ||
    !boundedText(claimToken, 512) ||
    !boundedText(claimOwner, 128) ||
    !Number.isSafeInteger(claimVersion) ||
    Number(claimVersion) <= 0 ||
    !boundedText(deliveryScopeKey, 512) ||
    !boundedText(recipient, 320) ||
    /[\r\n]/.test(recipient) ||
    !boundedText(template, 80) ||
    !boundedText(templateVersion, 64)
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
    const query = buildRevocableSourceAuthorityQuery({
      applicationUrl: source.applicationUrl,
      authorityEvidence,
      now: new Date(0),
      outboxId: source.outboxId,
      template: source.template,
      templateVersion: source.templateVersion,
      variables: source.variables,
    });
    if (query?.kind !== "lost-device-proof") {
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
  ])
    updateLengthFramed(hash, value);
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
  const authorityEvidence = descriptors.authorityEvidence!
    .value as LostDeviceAuthorityEvidence;
  const variables = canonicalStringRecord(descriptors.variables!.value);
  const sourceId = assertSourceEvidence(source, authorityEvidence);
  if (
    !sourceId ||
    Object.keys(variables).sort().join("\u0000") !== "name\u0000url" ||
    variables.name !== source.variables.name
  ) {
    throw new Error("Prepared dispatch delivery evidence is invalid.");
  }
  let rawProof: string;
  try {
    const url = new URL(variables.url!);
    const origin = new URL(source.applicationUrl).origin;
    const prefix = "#proof=";
    if (
      url.origin !== origin ||
      url.pathname !== "/lost-device" ||
      url.search ||
      url.username ||
      url.password ||
      !url.hash.startsWith(prefix)
    )
      throw new Error("invalid");
    rawProof = decodeURIComponent(url.hash.slice(prefix.length));
    if (
      !LOST_DEVICE_RAW_PROOF.test(rawProof) ||
      variables.url !== `${origin}/lost-device#proof=${rawProof}`
    )
      throw new Error("invalid");
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
  if (
    source.template === "lost-device-proof" &&
    source.templateVersion === "1"
  ) {
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

function canonicalRuntimePlan(value: unknown): PreparedDispatchRuntimePlan {
  try {
    if (!value || typeof value !== "object" || !Object.isFrozen(value)) {
      throw new Error("invalid");
    }
    const planDescriptor = Object.getOwnPropertyDescriptor(value, "timeouts");
    if (!planDescriptor || !("value" in planDescriptor)) {
      throw new Error("invalid");
    }
    const timeouts = planDescriptor.value as unknown;
    if (
      !timeouts ||
      typeof timeouts !== "object" ||
      !Object.isFrozen(timeouts)
    ) {
      throw new Error("invalid");
    }
    const descriptors = Object.getOwnPropertyDescriptors(timeouts);
    for (const key of [
      "oauthDeadlineMs",
      "guardedSendDeadlineMs",
      "providerAbortSettlementMs",
    ]) {
      if (!("value" in (descriptors[key] ?? {}))) throw new Error("invalid");
    }
    if (
      descriptors.oauthDeadlineMs!.value !== 20_000 ||
      descriptors.guardedSendDeadlineMs!.value !== 20_000 ||
      descriptors.providerAbortSettlementMs!.value !== 5_000
    )
      throw new Error("invalid");
    return value as PreparedDispatchRuntimePlan;
  } catch {
    throw new Error("Prepared dispatch runtime plan is invalid.");
  }
}

function preparedGmailEvidenceToken(rfc822: string) {
  const separator = rfc822.indexOf("\r\n\r\n");
  if (separator < 0) {
    throw new Error("Prepared Gmail evidence header is invalid.");
  }
  const evidenceHeaders = rfc822
    .slice(0, separator)
    .split("\r\n")
    .filter((line) => /^x-codestead-dispatch-evidence:/iu.test(line));
  if (evidenceHeaders.length !== 1) {
    throw new Error("Prepared Gmail evidence header is invalid.");
  }
  const match = evidenceHeaders[0]!.match(
    /^X-Codestead-Dispatch-Evidence: v1\.([A-Za-z0-9_-]{43})$/u,
  );
  if (!match) {
    throw new Error("Prepared Gmail evidence header is invalid.");
  }
  const token = match[1]!;
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== token) {
    throw new Error("Prepared Gmail evidence header is invalid.");
  }
  return token;
}

export function createMaterializedDispatch(
  input: Readonly<{
    source: PreparedDispatchSource;
    adapter: MailAdapter;
    from: string;
    messageId: string;
    runtimePlan: PreparedDispatchRuntimePlan;
    transportConfiguration: MailTransportConfiguration;
    delivery?: PreparedDispatchDelivery;
  }>,
): MaterializedDispatch {
  const expectedKeys = [
    "source",
    "adapter",
    "from",
    "messageId",
    "runtimePlan",
    "transportConfiguration",
  ];
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
    (adapter !== "console" && adapter !== "gmail") ||
    !boundedText(from, 512) ||
    !boundedText(messageId, 512)
  ) {
    invalidCanonicalData();
  }
  if (
    hasDelivery &&
    (!descriptors.delivery || descriptors.delivery.value === undefined)
  )
    invalidCanonicalData();

  const source = canonicalSource(descriptors.source!.value);
  const runtimePlan = canonicalRuntimePlan(descriptors.runtimePlan!.value);
  const transportPlan = capturePreparedMailTransportPlan(
    adapter,
    runtimePlan.timeouts,
    descriptors.transportConfiguration!.value as MailTransportConfiguration,
  );
  const delivery = hasDelivery
    ? (descriptors.delivery!.value as PreparedDispatchDelivery)
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
  const outgoing = {
    to: source.recipient,
    template: source.template,
    templateVersion: source.templateVersion,
    variables: { ...rendered.variables },
  };
  let prepared: PreparedEmail;
  if (adapter === "gmail") {
    const capability = issueMaterializedGmailPreparation(outgoing, {
      adapter,
      from,
      messageId,
      authority,
    });
    const issued = consumeMaterializedGmailPreparation(capability);
    if (!issued) {
      throw new Error("Prepared Gmail materialization capability is invalid.");
    }
    prepared = issued;
  } else {
    prepared = prepareEmail(outgoing, {
      adapter,
      from,
      messageId,
      authority,
    });
  }
  if (!preparedEmailBindingMatches(prepared, authority)) {
    throw new Error("Prepared dispatch binding does not match its authority.");
  }
  const evidenceToken =
    prepared.adapter === "gmail"
      ? preparedGmailEvidenceToken(prepared.rfc822)
      : null;
  const providerEvidenceSha256 =
    prepared.adapter === "gmail"
      ? dispatchEvidenceSha256({
          operationId: source.operationId,
          providerCorrelationVersion:
            OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
          providerCorrelationToken: outboxCorrelationToken(source.operationId),
          dispatchBindingVersion: prepared.bindingVersion,
          adapterPayloadSha256: prepared.bindingSha256,
          providerEvidenceVersion: PROVIDER_EVIDENCE_VERSION,
          evidenceToken: evidenceToken!,
        })
      : null;
  const storeView = Object.freeze({}) as PreparedDispatchStoreView;
  PREPARED_DISPATCH_STORE_STATES.set(
    storeView,
    Object.freeze({
      binding: dispatchBinding(prepared),
      providerRequestBodySha256: prepared.requestBodySha256,
      providerRequestBodyLength: prepared.requestBodyLength,
      sourceAuthoritySha256: sourceDigest,
      ...(rendered.authorityEvidence
        ? { authorityEvidence: rendered.authorityEvidence }
        : {}),
      providerCorrelationVersion: OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
      providerEvidenceVersion:
        prepared.adapter === "gmail" ? PROVIDER_EVIDENCE_VERSION : null,
      providerEvidenceSha256,
    }),
  );
  const envelope = Object.freeze({}) as PreparedDispatchEnvelope;
  PREPARED_DISPATCH_STATES.set(
    envelope,
    Object.freeze({
      prepared,
      authority,
      source,
      storeView,
      runtimePlan,
      transportPlan,
    }),
  );
  AUTHORIZATION_ELIGIBLE_ENVELOPES.add(envelope);
  const materialized = Object.freeze({}) as MaterializedDispatch;
  MATERIALIZED_DISPATCH_STATES.set(materialized, Object.freeze({ envelope }));
  return materialized;
}

export function materializedDispatchEnvelope(
  materialized: MaterializedDispatch,
): PreparedDispatchEnvelope | null {
  if (!Object.isFrozen(materialized)) return null;
  return MATERIALIZED_DISPATCH_STATES.get(materialized)?.envelope ?? null;
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
  ownerBinding: object;
  permit: ProviderCallPermit;
}>;

const GUARDED_DISPATCH_STATES = new WeakMap<
  GuardedPreparedDispatch,
  GuardedState
>();
const CLAIMED_GUARDED_DISPATCHES = new WeakSet<GuardedPreparedDispatch>();

export type StoreBoundPreparedDispatchChannel = Readonly<{
  binding: object;
  inspect(
    view: PreparedDispatchStoreView,
  ): PreparedDispatchStoreInspection | null;
  authorize(
    receipt: CommittedPreparedDispatchReceipt,
  ): Promise<GuardedPreparedDispatch>;
  claimGuard(
    permit: ProviderCallPermit,
    guarded: GuardedPreparedDispatch,
  ): boolean;
  dispatch(
    permit: ProviderCallPermit,
    guarded: GuardedPreparedDispatch,
    liveTx2Authority: unknown,
    liveTx2Context: LiveProviderTx2Context,
    signal: AbortSignal,
  ): Promise<PostProviderExit>;
  discardReceipt(
    permit: ProviderCallPermit,
    receipt: CommittedPreparedDispatchReceipt,
  ): boolean;
  discardGuard(
    permit: ProviderCallPermit,
    guarded: GuardedPreparedDispatch,
  ): boolean;
}>;

function ownerAcceptsBinding(
  owner: PreparedDispatchChannelOwnerAuthority,
  binding: object,
) {
  try {
    return owner.acceptsBinding(binding) === true;
  } catch {
    return false;
  }
}

function consumeCommittedTuple(
  owner: PreparedDispatchChannelOwnerAuthority,
  binding: object,
  receipt: CommittedPreparedDispatchReceipt,
  expectedPermit?: ProviderCallPermit,
) {
  try {
    const committed = owner.consumeCommittedReceipt(
      binding,
      receipt,
      expectedPermit,
    );
    if (
      !committed ||
      !Object.isFrozen(committed) ||
      Object.getPrototypeOf(committed) !== Object.prototype
    )
      return null;
    const descriptors = Object.getOwnPropertyDescriptors(committed);
    const keys = Reflect.ownKeys(committed);
    if (
      keys.length !== 3 ||
      keys.some((key) => typeof key !== "string") ||
      [...keys]
        .sort()
        .some((key, index) => key !== ["envelope", "permit", "view"][index]) ||
      !["envelope", "permit", "view"].every(
        (key) => "value" in (descriptors[key] ?? {}),
      )
    )
      return null;
    return Object.freeze({
      envelope: descriptors.envelope!.value as PreparedDispatchEnvelope,
      permit: descriptors.permit!.value as ProviderCallPermit,
      view: descriptors.view!.value as PreparedDispatchStoreView,
    });
  } catch {
    return null;
  }
}

function fatalTransportError(error: unknown) {
  if (isFatalProviderTransportError(error)) return error;
  const failure = classifyMailDeliveryError(error);
  return failure.kind === "fatal"
    ? new FatalProviderTransportError(failure.code)
    : null;
}

function canonicalProviderMessageId(result: unknown): string | null {
  try {
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      Object.getPrototypeOf(result) !== Object.prototype
    )
      return null;
    const keys = Reflect.ownKeys(result);
    if (keys.length !== 1 || keys[0] !== "providerId") return null;
    const descriptor = Object.getOwnPropertyDescriptor(result, "providerId");
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
    const providerId = descriptor.value;
    if (
      typeof providerId !== "string" ||
      !providerId ||
      providerId !== providerId.trim() ||
      providerId.length > 512 ||
      /[\r\n\u0000]/u.test(providerId)
    )
      return null;
    return providerId;
  } catch {
    return null;
  }
}

async function settlePreparedDelivery(
  delivery: Promise<unknown>,
): Promise<PostProviderExit> {
  let result: unknown;
  try {
    result = await delivery;
  } catch (error) {
    if (isFatalProviderTransportError(error)) throw error;
    const failure = classifyMailDeliveryError(error);
    if (failure.kind === "fatal") {
      throw new FatalProviderTransportError(failure.code);
    }
    if (failure.kind === "definitely-rejected") {
      return Object.freeze({ kind: "failed", code: failure.code });
    }
    return Object.freeze({ kind: "quarantined", code: failure.code });
  }
  const providerMessageId = canonicalProviderMessageId(result);
  return providerMessageId === null
    ? Object.freeze({
        kind: "quarantined" as const,
        code: "PROVIDER_OUTCOME_INVALID",
      })
    : Object.freeze({ kind: "sent" as const, providerMessageId });
}

export function createStoreBoundPreparedDispatchChannel(
  ownerHandle: unknown,
): StoreBoundPreparedDispatchChannel {
  const owner = consumePreparedDispatchChannelOwner(ownerHandle);
  if (!owner) {
    throw new Error("Prepared dispatch channel owner is invalid.");
  }
  const canonicalPlan = canonicalRuntimePlan(owner.runtimePlan);
  const binding = Object.freeze({});

  const inspect = (
    view: PreparedDispatchStoreView,
  ): PreparedDispatchStoreInspection | null => {
    if (!Object.isFrozen(view) || !ownerAcceptsBinding(owner, binding))
      return null;
    return PREPARED_DISPATCH_STORE_STATES.get(view) ?? null;
  };

  const authorize = async (
    receipt: CommittedPreparedDispatchReceipt,
  ): Promise<GuardedPreparedDispatch> => {
    if (!ownerAcceptsBinding(owner, binding)) {
      throw new Error("Committed prepared dispatch receipt is invalid.");
    }
    const committed = consumeCommittedTuple(owner, binding, receipt);
    if (!committed) {
      throw new Error("Committed prepared dispatch receipt is invalid.");
    }
    const dispatch = Object.isFrozen(committed.envelope)
      ? PREPARED_DISPATCH_STATES.get(committed.envelope)
      : undefined;
    if (
      !dispatch ||
      dispatch.runtimePlan !== canonicalPlan ||
      dispatch.storeView !== committed.view ||
      !Object.isFrozen(committed.view) ||
      PREPARED_DISPATCH_STORE_STATES.get(committed.view) === undefined ||
      !Object.isFrozen(committed.permit) ||
      !AUTHORIZATION_ELIGIBLE_ENVELOPES.has(committed.envelope)
    ) {
      throw new Error("Committed prepared dispatch receipt is invalid.");
    }
    AUTHORIZATION_ELIGIBLE_ENVELOPES.delete(committed.envelope);

    let authorization: PreparedEmailAuthorization;
    try {
      authorization = await authorizePreparedEmail(
        dispatch.prepared,
        dispatch.authority,
        dispatch.transportPlan,
      );
    } catch (error) {
      const fatalError = fatalTransportError(error);
      if (fatalError) throw fatalError;
      throw error;
    }

    const guarded = Object.freeze({}) as GuardedPreparedDispatch;
    GUARDED_DISPATCH_STATES.set(
      guarded,
      Object.freeze({
        authorization,
        ownerBinding: binding,
        permit: committed.permit,
      }),
    );
    return guarded;
  };

  const dispatch = async (
    permit: ProviderCallPermit,
    guarded: GuardedPreparedDispatch,
    liveTx2Authority: unknown,
    liveTx2Context: LiveProviderTx2Context,
    signal: AbortSignal,
  ): Promise<PostProviderExit> => {
    const state = Object.isFrozen(guarded)
      ? GUARDED_DISPATCH_STATES.get(guarded)
      : undefined;
    if (
      !state ||
      state.ownerBinding !== binding ||
      state.permit !== permit ||
      !CLAIMED_GUARDED_DISPATCHES.has(guarded) ||
      !ownerAcceptsBinding(owner, binding)
    ) {
      throw new Error("Guarded prepared dispatch is invalid or already used.");
    }
    CLAIMED_GUARDED_DISPATCHES.delete(guarded);
    GUARDED_DISPATCH_STATES.delete(guarded);
    const delivery = sendPreparedEmail(
      liveTx2Authority,
      liveTx2Context,
      state.authorization,
      { signal },
    );
    return settlePreparedDelivery(delivery);
  };

  const claimGuard = (
    permit: ProviderCallPermit,
    guarded: GuardedPreparedDispatch,
  ): boolean => {
    const state = Object.isFrozen(guarded)
      ? GUARDED_DISPATCH_STATES.get(guarded)
      : undefined;
    if (
      !state ||
      state.ownerBinding !== binding ||
      state.permit !== permit ||
      CLAIMED_GUARDED_DISPATCHES.has(guarded) ||
      !ownerAcceptsBinding(owner, binding)
    )
      return false;
    CLAIMED_GUARDED_DISPATCHES.add(guarded);
    return true;
  };

  const discardReceipt = (
    permit: ProviderCallPermit,
    receipt: CommittedPreparedDispatchReceipt,
  ): boolean => {
    if (!ownerAcceptsBinding(owner, binding)) return false;
    const committed = consumeCommittedTuple(owner, binding, receipt, permit);
    if (!committed) return false;
    const dispatch = Object.isFrozen(committed.envelope)
      ? PREPARED_DISPATCH_STATES.get(committed.envelope)
      : undefined;
    if (!dispatch) return false;
    AUTHORIZATION_ELIGIBLE_ENVELOPES.delete(committed.envelope);
    discardPreparedMailTransportPlan(dispatch.transportPlan);
    PREPARED_DISPATCH_STATES.delete(committed.envelope);
    PREPARED_DISPATCH_STORE_STATES.delete(dispatch.storeView);
    return (
      committed.permit === permit &&
      dispatch.runtimePlan === canonicalPlan &&
      dispatch.storeView === committed.view
    );
  };
  const discardGuard = (
    permit: ProviderCallPermit,
    guarded: GuardedPreparedDispatch,
  ): boolean => {
    const state = Object.isFrozen(guarded)
      ? GUARDED_DISPATCH_STATES.get(guarded)
      : undefined;
    if (
      !state ||
      state.ownerBinding !== binding ||
      state.permit !== permit ||
      !ownerAcceptsBinding(owner, binding)
    )
      return false;
    CLAIMED_GUARDED_DISPATCHES.delete(guarded);
    GUARDED_DISPATCH_STATES.delete(guarded);
    return discardPreparedEmailAuthorization(state.authorization);
  };

  return Object.freeze({
    binding,
    inspect,
    authorize,
    claimGuard,
    dispatch,
    discardReceipt,
    discardGuard,
  });
}
