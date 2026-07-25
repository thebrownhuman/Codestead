import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as guardedDispatchModule from "../guarded-prepared-dispatch";
import * as materializationModule from
  "../prepared-dispatch-materialization";
import {
  createMaterializedDispatch,
  createPreparedDispatchCommitBridge,
  dispatchGuardedPrepared,
  guardedDispatchCommitmentMatches,
  guardedDispatchStoreView,
  preparedDispatchStoreView,
  type CommittedPreparedDispatchReceipt,
  type PreparedDispatchDelivery,
  type PreparedDispatchSource,
} from "../guarded-prepared-dispatch";
import { FatalProviderTransportError } from "../provider-dispatch-contract";
import { outboxMessageId } from "../provider-correlation";
import {
  createLostDeviceAuthorityEvidence,
  type LostDeviceAuthorityEvidence,
} from "../revocable-source-authority";

const OUTBOX_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const CLAIM_TOKEN = "44444444-4444-4444-8444-444444444444";
const RECIPIENT = "learner@example.test";
const FROM = "Codestead <authority@codestead.test>";
const RESET_TOKEN_A = "reset-token-source-aaaaaaaa";
const RESET_TOKEN_B = "reset-token-prepared-bbbbb";

function source(
  overrides: Partial<PreparedDispatchSource> = {},
): PreparedDispatchSource {
  return {
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
    variables: {
      name: "Learner",
      url: "https://example.test/activate?token=single-use",
    },
    ...overrides,
  };
}

function resetSource(token: string): PreparedDispatchSource {
  return source({
    template: "reset-password",
    templateVersion: "1",
    variables: {
      name: "Learner",
      resetVerificationId: "reset-verification-1",
      url: `https://example.test/api/auth/reset-password/${token}?callbackURL=%2Freset-password`,
    },
  });
}

function lostDeviceSource(sourceId: string): PreparedDispatchSource {
  return source({
    template: "lost-device-proof",
    templateVersion: "1",
    variables: {
      name: "Learner",
      recoveryRequestId: sourceId,
    },
  });
}

function issuedEvidence(
  sourceId: string,
  proofCharacter: string,
): Readonly<{ evidence: LostDeviceAuthorityEvidence; rawProof: string }> {
  const rawProof = proofCharacter.repeat(43);
  const evidence = createLostDeviceAuthorityEvidence({
    sourceId,
    rawProof,
    storedProofHash: createHash("sha256")
      .update(rawProof)
      .digest("hex"),
  });
  if (!evidence) throw new Error("Expected issued lost-device evidence.");
  return Object.freeze({ evidence, rawProof });
}

function lostDeviceDelivery(
  sourceId: string,
  proofCharacter: string,
): PreparedDispatchDelivery {
  const { evidence, rawProof } = issuedEvidence(sourceId, proofCharacter);
  return {
    authorityEvidence: evidence,
    variables: {
      name: "Learner",
      url: `https://example.test/lost-device#proof=${rawProof}`,
    },
  };
}

function materialize(
  dispatchSource: PreparedDispatchSource,
  options: Readonly<{
    adapter?: "console" | "gmail";
    delivery?: PreparedDispatchDelivery;
  }> = {},
) {
  return createMaterializedDispatch({
    source: dispatchSource,
    adapter: options.adapter ?? "console",
    from: FROM,
    messageId: outboxMessageId(dispatchSource.operationId),
    ...(options.delivery ? { delivery: options.delivery } : {}),
  });
}

function commitment() {
  return {
    store: {},
    permit: Object.freeze({
      outboxId: OUTBOX_ID,
      operationId: OPERATION_ID,
      claimToken: CLAIM_TOKEN,
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("exact-byte prepared dispatch audit", () => {
  it("removes the source-A/prepared-B factory and renders reset bytes only from source A", () => {
    expect(guardedDispatchModule).not.toHaveProperty(
      "createPreparedDispatchEnvelope",
    );
    expect(guardedDispatchModule).not.toHaveProperty(
      "authorizePreparedDispatch",
    );
    expect(materializationModule).not.toHaveProperty(
      "takePreparedDispatchCommitState",
    );

    const sourceA = resetSource(RESET_TOKEN_A);
    const materialized = materialize(sourceA, { adapter: "gmail" });
    if (materialized.prepared.adapter !== "gmail") {
      throw new Error("Expected Gmail preparation.");
    }
    expect(materialized.prepared.rfc822).toContain(RESET_TOKEN_A);
    expect(materialized.prepared.rfc822).not.toContain(RESET_TOKEN_B);

    const deliveryB = {
      variables: resetSource(RESET_TOKEN_B).variables,
      authorityEvidence: issuedEvidence(
        "33333333-3333-4333-8333-333333333333",
        "B",
      ).evidence,
    };
    expect(() => materialize(sourceA, { delivery: deliveryB }))
      .toThrow("delivery override");
  });

  it("takes one canonical source snapshot before preparing provider bytes", () => {
    const mutable = source();
    const originalUrl = mutable.variables.url!;
    const materialized = materialize(mutable, { adapter: "gmail" });

    (mutable.variables as Record<string, string>).url =
      "https://attacker.test/changed-after-entry";
    (mutable as { recipient: string }).recipient =
      "attacker@example.test";

    if (materialized.prepared.adapter !== "gmail") {
      throw new Error("Expected Gmail preparation.");
    }
    expect(materialized.prepared.rfc822).toContain(originalUrl);
    expect(materialized.prepared.rfc822).toContain(`To: ${RECIPIENT}`);
    expect(materialized.prepared.rfc822).not.toContain("attacker.test");
    expect(materialized.prepared.rfc822).not.toContain("attacker@example.test");
  });

  it.each(["outboxId", "operationId"] as const)(
    "rejects an object-valued %s without invoking toString",
    (field) => {
      const toString = vi.fn(() => OUTBOX_ID);
      const dispatchSource = source({
        [field]: { toString } as unknown as string,
      });

      expect(() => createMaterializedDispatch({
        source: dispatchSource,
        adapter: "console",
        from: FROM,
        messageId: outboxMessageId(OPERATION_ID),
      }))
        .toThrow("source is invalid");
      expect(toString).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["non-enumerable", () => {
      const variables: Record<string, string> = { name: "Learner" };
      Object.defineProperty(variables, "url", {
        configurable: false,
        enumerable: false,
        value: "https://example.test/hidden",
        writable: false,
      });
      return Object.freeze(variables);
    }],
    ["prototype", () => Object.freeze(Object.assign(
      Object.create({ url: "https://example.test/inherited" }),
      { name: "Learner" },
    ))],
  ] as const)("rejects %s dispatch variables as non-canonical", (_case, makeVariables) => {
    expect(() => materialize(source({ variables: makeVariables() })))
      .toThrow("canonical plain data");
  });

  it("rejects accessor variables without invoking the accessor", () => {
    const read = vi.fn(() => "https://example.test/from-getter");
    const variables: Record<string, string> = { name: "Learner" };
    Object.defineProperty(variables, "url", {
      configurable: false,
      enumerable: true,
      get: read,
    });
    Object.freeze(variables);

    expect(() => materialize(source({ variables })))
      .toThrow("canonical plain data");
    expect(read).not.toHaveBeenCalled();
  });

  it("cryptographically links lost-device delivery bytes to source and issued evidence", () => {
    const sourceIdA = "33333333-3333-4333-8333-333333333333";
    const sourceIdB = "66666666-6666-4666-8666-666666666666";
    const deliveryA = lostDeviceDelivery(sourceIdA, "A");
    const deliveryB = lostDeviceDelivery(sourceIdB, "B");
    const sameSourceTamperedProof = {
      authorityEvidence: deliveryA.authorityEvidence,
      variables: {
        ...deliveryA.variables,
        url: `https://example.test/lost-device#proof=${"B".repeat(43)}`,
      },
    };
    expect(() => materialize(lostDeviceSource(sourceIdA), {
      delivery: sameSourceTamperedProof,
    })).toThrow("delivery evidence");

    expect(() => materialize(lostDeviceSource(sourceIdA), {
      delivery: deliveryB,
    })).toThrow("delivery evidence");

    const materialized = materialize(lostDeviceSource(sourceIdA), {
      adapter: "gmail",
      delivery: deliveryA,
    });
    if (materialized.prepared.adapter !== "gmail") {
      throw new Error("Expected Gmail preparation.");
    }
    expect(materialized.prepared.rfc822).toContain("A".repeat(43));
    expect(materialized.prepared.rfc822).not.toContain("B".repeat(43));
  });
});

describe("committed prepared dispatch receipt", () => {
  it("does not expose any pre-TX1 OAuth path and consumes a receipt before OAuth", async () => {
    vi.stubEnv("GMAIL_CLIENT_ID", "client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh-secret");
    let resolveOAuth!: (response: Response) => void;
    const oauth = new Promise<Response>((resolve) => {
      resolveOAuth = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => oauth)
      .mockResolvedValueOnce(new Response(
        '{"id":"provider-message-id"}',
        { status: 200 },
      ));
    vi.stubGlobal("fetch", fetchMock);

    const materialized = materialize(source(), { adapter: "gmail" });
    const bridge = createPreparedDispatchCommitBridge();
    const forgedReceipt = Object.freeze({}) as CommittedPreparedDispatchReceipt;

    await expect(bridge.authorizePreparedDispatch(forgedReceipt))
      .rejects.toThrow("committed receipt is invalid");
    expect(fetchMock).not.toHaveBeenCalled();

    const committed = commitment();
    const receipt = bridge.acknowledgePreparedDispatch(
      materialized.envelope,
      committed,
    );
    const guardedPromise = bridge.authorizePreparedDispatch(receipt);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await expect(bridge.authorizePreparedDispatch(receipt))
      .rejects.toThrow("committed receipt is invalid");

    resolveOAuth(new Response(
      '{"access_token":"oauth-access-secret"}',
      { status: 200 },
    ));
    const guarded = await guardedPromise;
    const dispatch = preparedDispatchStoreView(materialized.envelope);
    expect(dispatch).not.toBeNull();
    expect(guardedDispatchCommitmentMatches(guarded, {
      ...committed,
      dispatch: dispatch!,
      envelope: materialized.envelope,
      receipt,
    })).toBe(true);
    await expect(dispatchGuardedPrepared(
      guarded,
      {
        ...committed,
        dispatch: dispatch!,
        envelope: materialized.envelope,
        receipt,
      },
      new AbortController().signal,
    )).resolves.toEqual({
      kind: "sent",
      providerMessageId: "provider-message-id",
    });
  });

  it("rejects accessor commit identities before consuming envelope eligibility", () => {
    const materialized = materialize(source());
    const bridge = createPreparedDispatchCommitBridge();
    const readPermit = vi.fn(() => ({}));
    const accessorCommitment = { store: {} } as {
      store: object;
      permit: object;
    };
    Object.defineProperty(accessorCommitment, "permit", {
      enumerable: true,
      get: readPermit,
    });

    expect(() => bridge.acknowledgePreparedDispatch(
      materialized.envelope,
      accessorCommitment,
    )).toThrow("commitment is invalid");
    expect(readPermit).not.toHaveBeenCalled();

    expect(bridge.acknowledgePreparedDispatch(
      materialized.envelope,
      commitment(),
    )).toBeDefined();
  });

  it("issues opaque one-shot receipts and keeps receipt/guard/store-view serialization empty", async () => {
    const write = vi.spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const materialized = materialize(source());
    const bridge = createPreparedDispatchCommitBridge();
    const committed = commitment();
    const tx1View = preparedDispatchStoreView(materialized.envelope);
    expect(tx1View).not.toBeNull();

    const receipt = bridge.acknowledgePreparedDispatch(
      materialized.envelope,
      committed,
    );
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.keys(receipt)).toEqual([]);
    expect(JSON.stringify(receipt)).toBe("{}");
    expect(() => bridge.acknowledgePreparedDispatch(
      materialized.envelope,
      committed,
    )).toThrow("not eligible for commit acknowledgement");

    const guarded = await bridge.authorizePreparedDispatch(receipt);
    const guardedView = guardedDispatchStoreView(guarded);
    expect(Object.isFrozen(guarded)).toBe(true);
    expect(Object.keys(guarded)).toEqual([]);
    expect(JSON.stringify(guarded)).toBe("{}");
    expect(guardedView).not.toBeNull();
    expect(Object.keys(guardedView!)).toEqual([]);
    expect(JSON.stringify(guardedView)).toBe("{}");
    expect(JSON.stringify({ receipt, guarded, guardedView }))
      .not.toContain(CLAIM_TOKEN);
    const serialization = JSON.stringify({ receipt, guarded, guardedView });
    for (const secret of [
      OUTBOX_ID,
      OPERATION_ID,
      CLAIM_TOKEN,
      RECIPIENT,
      materialized.prepared.requestBody,
      "33333333-3333-4333-8333-333333333333",
      "A".repeat(43),
      "oauth-access-secret",
      "client-secret",
      "refresh-secret",
    ]) expect(serialization).not.toContain(secret);

    const proof = {
      ...committed,
      dispatch: tx1View!,
      envelope: materialized.envelope,
      receipt,
    };
    expect(guardedDispatchCommitmentMatches(guarded, proof)).toBe(true);
    await expect(dispatchGuardedPrepared(
      guarded,
      proof,
      new AbortController().signal,
    )).resolves.toMatchObject({ kind: "sent" });
    expect(write).toHaveBeenCalledOnce();
    expect(guardedDispatchCommitmentMatches(guarded, proof)).toBe(false);
  });

  it("rejects swapped bridge, store, permit, receipt, envelope, and TX1 view before send", async () => {
    const write = vi.spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const materializedA = materialize(source());
    const materializedB = materialize(source({
      operationId: "55555555-5555-4555-8555-555555555555",
    }));
    const bridgeA = createPreparedDispatchCommitBridge();
    const bridgeB = createPreparedDispatchCommitBridge();
    const committed = commitment();
    const receiptA = bridgeA.acknowledgePreparedDispatch(
      materializedA.envelope,
      committed,
    );

    await expect(bridgeB.authorizePreparedDispatch(receiptA))
      .rejects.toThrow("committed receipt is invalid");
    const guarded = await bridgeA.authorizePreparedDispatch(receiptA);
    const dispatchA = preparedDispatchStoreView(materializedA.envelope)!;
    const valid = {
      ...committed,
      dispatch: dispatchA,
      envelope: materializedA.envelope,
      receipt: receiptA,
    };
    const mismatches = [
      { ...valid, store: {} },
      { ...valid, permit: Object.freeze({ ...committed.permit }) },
      { ...valid, receipt: Object.freeze({}) as CommittedPreparedDispatchReceipt },
      { ...valid, envelope: materializedB.envelope },
      { ...valid, dispatch: preparedDispatchStoreView(materializedB.envelope)! },
    ];
    for (const mismatch of mismatches) {
      expect(guardedDispatchCommitmentMatches(guarded, mismatch)).toBe(false);
      await expect(dispatchGuardedPrepared(
        guarded,
        mismatch,
        new AbortController().signal,
      )).rejects.toThrow("commitment does not match");
    }
    expect(write).not.toHaveBeenCalled();

    await expect(dispatchGuardedPrepared(
      guarded,
      valid,
      new AbortController().signal,
    )).resolves.toMatchObject({ kind: "sent" });
    expect(write).toHaveBeenCalledOnce();
  });

  it("rethrows an incoming canonical fatal transport error by exact identity", async () => {
    const fatal = new FatalProviderTransportError(
      "GMAIL_DELIVERY_TRANSPORT_UNSETTLED",
    );
    vi.spyOn(process.stdout, "write").mockImplementation(() => {
      throw fatal;
    });
    const materialized = materialize(source());
    const bridge = createPreparedDispatchCommitBridge();
    const committed = commitment();
    const dispatch = preparedDispatchStoreView(materialized.envelope)!;
    const receipt = bridge.acknowledgePreparedDispatch(
      materialized.envelope,
      committed,
    );
    const guarded = await bridge.authorizePreparedDispatch(receipt);

    await expect(dispatchGuardedPrepared(
      guarded,
      {
        ...committed,
        dispatch,
        envelope: materialized.envelope,
        receipt,
      },
      new AbortController().signal,
    )).rejects.toBe(fatal);
  });
});
