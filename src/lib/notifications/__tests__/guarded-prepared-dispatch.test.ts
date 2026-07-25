import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authorizePreparedDispatch,
  createMaterializedDispatch,
  createPreparedDispatchEnvelope,
  dispatchGuardedPrepared,
  guardedDispatchStoreView,
  preparedDispatchStoreView,
  preparedEnvelopeMatches,
  sourceAuthoritySha256,
  type PreparedDispatchSource,
} from "../guarded-prepared-dispatch";
import {
  prepareEmail,
  preparedEmailBindingMatches,
  type MailDispatchAuthority,
} from "../prepared-dispatch";
import { FatalProviderTransportError } from "../outbox-worker";
import { outboxMessageId } from "../provider-correlation";
import {
  createLostDeviceAuthorityEvidence,
  type LostDeviceAuthorityEvidence,
} from "../revocable-source-authority";

const OUTBOX_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_OPERATION_ID = "55555555-5555-4555-8555-555555555555";
const CLAIM_TOKEN = "44444444-4444-4444-8444-444444444444";
const RECIPIENT = "learner@example.test";

function invitationSource(
  overrides: Partial<PreparedDispatchSource> = {},
): PreparedDispatchSource {
  const variables = overrides.variables ?? Object.freeze({
    name: "Learner",
    url: "https://example.test/activate?token=single-use",
  });
  return Object.freeze({
    applicationUrl: "https://example.test",
    outboxId: OUTBOX_ID,
    operationId: OPERATION_ID,
    claimToken: CLAIM_TOKEN,
    claimOwner: "mail-worker:test",
    claimVersion: 7,
    deliveryScopeKey: "a:learner-1",
    recipient: RECIPIENT,
    template: "invitation",
    templateVersion: "1",
    variables: Object.isFrozen(variables)
      ? variables
      : Object.freeze({ ...variables }),
    ...overrides,
  });
}

function authorityFor(
  source: PreparedDispatchSource,
  evidence?: LostDeviceAuthorityEvidence,
): MailDispatchAuthority {
  return Object.freeze({
    id: source.outboxId,
    operationId: source.operationId,
    claimToken: source.claimToken,
    claimOwner: source.claimOwner,
    claimVersion: source.claimVersion,
    deliveryScopeKey: source.deliveryScopeKey,
    recipient: source.recipient,
    template: source.template,
    templateVersion: source.templateVersion,
    sourceAuthoritySha256: sourceAuthoritySha256(source, evidence),
  });
}

function prepareFor(
  source: PreparedDispatchSource,
  authority: MailDispatchAuthority,
  adapter: "console" | "gmail" = "console",
) {
  return prepareEmail({
    to: source.recipient,
    template: source.template,
    templateVersion: source.templateVersion,
    variables: { ...source.variables },
  }, {
    adapter,
    from: "Codestead <authority@codestead.test>",
    messageId: outboxMessageId(source.operationId),
    authority,
  });
}

function invitationFixture() {
  const source = invitationSource();
  const authority = authorityFor(source);
  const prepared = prepareFor(source, authority);
  const envelope = createPreparedDispatchEnvelope({
    prepared,
    authority,
    source,
  });
  return { source, authority, prepared, envelope };
}

function issuedEvidence(
  sourceId: string,
  proofCharacter: string,
) {
  const rawProof = proofCharacter.repeat(43);
  const evidence = createLostDeviceAuthorityEvidence({
    sourceId,
    rawProof,
    storedProofHash: createHash("sha256")
      .update(rawProof)
      .digest("hex"),
  });
  if (!evidence) throw new Error("Expected issued lost-device evidence.");
  return evidence;
}

function lostDeviceSource(sourceId: string): PreparedDispatchSource {
  return Object.freeze({
    applicationUrl: "https://example.test",
    outboxId: OUTBOX_ID,
    operationId: OPERATION_ID,
    claimToken: CLAIM_TOKEN,
    claimOwner: "mail-worker:test",
    claimVersion: 7,
    deliveryScopeKey: "a:learner-1",
    recipient: RECIPIENT,
    template: "lost-device-proof",
    templateVersion: "1",
    variables: Object.freeze({
      name: "Learner",
      recoveryRequestId: sourceId,
    }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("guarded prepared dispatch", () => {
  it("keeps one opaque store view through TX1, OAuth, and one TX2 send", async () => {
    const { prepared, envelope } = invitationFixture();
    const write = vi.spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const materialized = createMaterializedDispatch(prepared, envelope);
    const tx1View = preparedDispatchStoreView(materialized.envelope);

    expect(Object.isFrozen(materialized)).toBe(true);
    expect(materialized.prepared).toBe(prepared);
    expect(materialized.envelope).toBe(envelope);
    expect(tx1View).not.toBeNull();
    expect(Object.keys(tx1View!).sort()).toEqual([
      "binding",
      "sourceAuthoritySha256",
    ]);

    const guarded = await authorizePreparedDispatch(materialized.envelope);
    const tx2View = guardedDispatchStoreView(guarded);
    expect(tx2View?.envelope).toBe(envelope);
    expect(tx2View?.dispatch).toBe(tx1View);

    await expect(dispatchGuardedPrepared(
      guarded,
      new AbortController().signal,
    )).resolves.toMatchObject({ kind: "sent" });
    expect(write).toHaveBeenCalledOnce();
    await expect(dispatchGuardedPrepared(
      guarded,
      new AbortController().signal,
    )).rejects.toThrow("invalid or already consumed");
    await expect(authorizePreparedDispatch(envelope))
      .rejects.toThrow("invalid or already used");
    expect(write).toHaveBeenCalledOnce();
  });

  it("surfaces unsettled OAuth as an exact fatal error and consumes the envelope", async () => {
    vi.useFakeTimers();
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh-secret");
    vi.stubEnv("GMAIL_REQUEST_TIMEOUT_MS", "1000");
    const fetchMock = vi.fn<typeof fetch>(() => (
      new Promise<Response>(() => undefined)
    ));
    vi.stubGlobal("fetch", fetchMock);
    const source = invitationSource();
    const authority = authorityFor(source);
    const prepared = prepareFor(source, authority, "gmail");
    const envelope = createPreparedDispatchEnvelope({
      prepared,
      authority,
      source,
    });

    let outcome: unknown = "pending";
    void authorizePreparedDispatch(envelope).then(
      (value) => { outcome = value; },
      (error: unknown) => { outcome = error; },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(6_000);
    expect(outcome).toBeInstanceOf(FatalProviderTransportError);
    expect(outcome).toMatchObject({
      code: "GMAIL_OAUTH_TRANSPORT_UNSETTLED",
    });
    await expect(authorizePreparedDispatch(envelope))
      .rejects.toThrow("invalid or already used");
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("surfaces unsettled delivery as an exact fatal error and consumes the guarded handle", async () => {
    vi.useFakeTimers();
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh-secret");
    vi.stubEnv("GMAIL_REQUEST_TIMEOUT_MS", "1000");
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        '{"access_token":"oauth-access-secret"}',
        { status: 200 },
      ))
      .mockImplementationOnce(() => (
        new Promise<Response>(() => undefined)
      ));
    vi.stubGlobal("fetch", fetchMock);
    const source = invitationSource();
    const authority = authorityFor(source);
    const prepared = prepareFor(source, authority, "gmail");
    const envelope = createPreparedDispatchEnvelope({
      prepared,
      authority,
      source,
    });
    const guardedPromise = authorizePreparedDispatch(envelope);
    await vi.advanceTimersByTimeAsync(0);
    const guarded = await guardedPromise;
    fetchMock.mockClear();

    let outcome: unknown = "pending";
    void dispatchGuardedPrepared(
      guarded,
      new AbortController().signal,
    ).then(
      (value) => { outcome = value; },
      (error: unknown) => { outcome = error; },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(6_000);
    expect(outcome).toBeInstanceOf(FatalProviderTransportError);
    expect(outcome).toMatchObject({
      code: "GMAIL_DELIVERY_TRANSPORT_UNSETTLED",
    });
    await expect(dispatchGuardedPrepared(
      guarded,
      new AbortController().signal,
    )).rejects.toThrow("invalid or already consumed");
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it.each([
    ["applicationUrl", { applicationUrl: "https://other.example.test" }],
    ["outboxId", { outboxId: "33333333-3333-4333-8333-333333333333" }],
    ["operationId", { operationId: OTHER_OPERATION_ID }],
    ["claimToken", { claimToken: "different-claim-token" }],
    ["claimOwner", { claimOwner: "mail-worker:other" }],
    ["claimVersion", { claimVersion: 8 }],
    ["deliveryScopeKey", { deliveryScopeKey: "a:learner-2" }],
    ["recipient", { recipient: "other@example.test" }],
    ["template", { template: "backup-status" as const }],
    ["templateVersion", { templateVersion: "2" }],
    ["variables", {
      variables: Object.freeze({
        name: "Different Learner",
        url: "https://example.test/activate?token=single-use",
      }),
    }],
  ] as const)("rejects a %s source swap before authorization", (_field, change) => {
    const fixture = invitationFixture();
    const swapped = invitationSource(change);

    expect(() => createPreparedDispatchEnvelope({
      prepared: fixture.prepared,
      authority: fixture.authority,
      source: swapped,
    })).toThrow();
  });

  it("rejects valid evidence B attached to frozen prepared/source A", () => {
    const sourceIdA = "33333333-3333-4333-8333-333333333333";
    const sourceIdB = "66666666-6666-4666-8666-666666666666";
    const evidenceA = issuedEvidence(sourceIdA, "A");
    const evidenceB = issuedEvidence(sourceIdB, "B");
    const sourceA = lostDeviceSource(sourceIdA);
    const authorityA = authorityFor(sourceA, evidenceA);
    const preparedA = prepareFor(sourceA, authorityA);

    expect(() => createPreparedDispatchEnvelope({
      prepared: preparedA,
      authority: authorityA,
      source: sourceA,
      authorityEvidence: evidenceB,
    })).toThrow("source evidence is invalid");
  });

  it("rejects prepared B paired with envelope A before OAuth", () => {
    const fixtureA = invitationFixture();
    const sourceB = invitationSource({
      variables: Object.freeze({
        name: "Other Learner",
        url: "https://example.test/activate?token=single-use",
      }),
    });
    const authorityB = authorityFor(sourceB);
    const preparedB = prepareFor(sourceB, authorityB);

    expect(preparedEnvelopeMatches(fixtureA.envelope, preparedB)).toBe(false);
    expect(() => createMaterializedDispatch(
      preparedB,
      fixtureA.envelope,
    )).toThrow("identity does not match");
    expect(preparedEnvelopeMatches(
      fixtureA.envelope,
      fixtureA.prepared,
    )).toBe(true);
  });

  it("seals randomized MIME bytes to the same source hash without re-rendering", () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("33333333-3333-4333-8333-333333333333")
      .mockReturnValueOnce("66666666-6666-4666-8666-666666666666");
    const source = invitationSource();
    const authority = authorityFor(source);
    const preparedA = prepareFor(source, authority, "gmail");
    const preparedB = prepareFor(source, authority, "gmail");

    expect(preparedA).not.toEqual(preparedB);
    expect(preparedEmailBindingMatches(preparedA, authority)).toBe(true);
    expect(preparedEmailBindingMatches(preparedB, authority)).toBe(true);
    const envelopeA = createPreparedDispatchEnvelope({
      prepared: preparedA,
      authority,
      source,
    });
    const envelopeB = createPreparedDispatchEnvelope({
      prepared: preparedB,
      authority,
      source,
    });
    expect(preparedEnvelopeMatches(envelopeA, preparedA)).toBe(true);
    expect(preparedEnvelopeMatches(envelopeA, preparedB)).toBe(false);
    expect(preparedEnvelopeMatches(envelopeB, preparedB)).toBe(true);
  });
});
