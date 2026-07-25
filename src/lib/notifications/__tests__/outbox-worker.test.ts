import { describe, expect, it, vi } from "vitest";

import type {
  GuardedPreparedDispatch,
  MaterializedDispatch,
  PreparedDispatchEnvelope,
} from "../guarded-prepared-dispatch";
import {
  FatalProviderTransportError,
  GuardedDispatchCommitUnknownError,
  PostProviderPersistenceUnknownError,
  processOutboxBatch,
  type BoundaryResult,
  type MailProvider,
  type OutboxClaim,
  type OutboxStore,
  type PostProviderExit,
  type PreProviderExit,
  type ProviderCallPermit,
  type ProviderStartedClaim,
} from "../outbox-worker";

type Payload = Readonly<{ template: "invitation" }>;

const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const claim: OutboxClaim<Payload> = Object.freeze({
  phase: "pre-provider",
  id: "11111111-1111-4111-8111-111111111111",
  operationId: OPERATION_ID,
  claimToken: "44444444-4444-4444-8444-444444444444",
  claimOwner: "mail-worker:test",
  claimVersion: 3,
  userId: "learner-1",
  deliveryScopeKey: "a:learner-1",
  payload: Object.freeze({ template: "invitation" }),
  attempt: 1,
  leaseExpiresAt: new Date("2026-07-22T18:00:30.000Z"),
});
const started: ProviderStartedClaim = Object.freeze({
  phase: "post-provider",
  id: claim.id,
  operationId: claim.operationId,
  claimToken: claim.claimToken,
  claimOwner: claim.claimOwner,
  claimVersion: claim.claimVersion,
  userId: claim.userId,
  deliveryScopeKey: claim.deliveryScopeKey,
  bindingVersion: "gmail-raw-v1",
  bindingSha256: "a".repeat(64),
  adapter: "gmail",
  providerCallStartedAt: "2026-07-22 18:00:05.123456+00",
  leaseExpiresAt: new Date("2026-07-22T18:01:05.000Z"),
});
const permit = started as ProviderCallPermit;
const prepared = Object.freeze({
  adapter: "gmail",
}) as unknown as MaterializedDispatch["prepared"];
const envelope = Object.freeze({}) as PreparedDispatchEnvelope;
const materialized = Object.freeze({
  prepared,
  envelope,
}) as MaterializedDispatch;
const guarded = Object.freeze({}) as GuardedPreparedDispatch;
const sentExit = Object.freeze({
  kind: "sent",
  providerMessageId: "gmail-message-1",
}) satisfies PostProviderExit;

function harness() {
  const events: string[] = [];
  let retainedFatal: FatalProviderTransportError | null = null;
  const store = {
    quarantineAbandoned: vi.fn(async () => {
      events.push("sweep");
      return 0;
    }),
    claimNext: vi.fn()
      .mockImplementationOnce(async () => {
        events.push("claim");
        return claim;
      })
      .mockImplementation(async () => {
        events.push("claim");
        return null;
      }),
    beginProviderCall: vi.fn(async (
      _claim: typeof claim,
      input: Readonly<{
        adapter: string;
        leaseMs: number;
        envelope: PreparedDispatchEnvelope;
      }>,
    ): Promise<BoundaryResult> => {
      events.push("tx1");
      expect(Object.keys(input).sort()).toEqual([
        "adapter",
        "envelope",
        "leaseMs",
      ]);
      expect(input.envelope).toBe(envelope);
      return { kind: "applied", permit };
    }),
    finishBeforeProvider: vi.fn(async (
      _claim: typeof claim,
      exit: PreProviderExit,
    ) => {
      events.push(`finish-before:${exit.kind}`);
      return { kind: "applied" as const };
    }),
    finishAfterProvider: vi.fn(async (
      _permit: ProviderCallPermit,
      exit: PostProviderExit,
    ) => {
      events.push(`finish-after:${exit.kind}`);
      return { kind: "applied" as const };
    }),
    dispatchAfterProviderBoundary: vi.fn(async (
      receivedPermit: ProviderCallPermit,
      receivedGuarded: GuardedPreparedDispatch,
      fatalExit: (error: FatalProviderTransportError) => never,
    ) => {
      events.push("tx2");
      expect(receivedPermit).toBe(permit);
      expect(receivedGuarded).toBe(guarded);
      expect(fatalExit).toBeTypeOf("function");
      return { kind: "applied" as const, exit: sentExit };
    }),
  };
  const materialize = vi.fn(async () => {
    events.push("materialize");
    return { kind: "ready" as const, dispatch: materialized };
  });
  const preparedEnvelopeMatches = vi.fn((
    receivedEnvelope: PreparedDispatchEnvelope,
    receivedPrepared: MaterializedDispatch["prepared"],
  ) => {
    events.push("match");
    return receivedEnvelope === envelope && receivedPrepared === prepared;
  });
  const authorizePreparedDispatch = vi.fn(async (
    receivedEnvelope: PreparedDispatchEnvelope,
  ) => {
    events.push("oauth");
    expect(receivedEnvelope).toBe(envelope);
    return guarded;
  });
  const failStop = {
    fatalError: vi.fn(() => retainedFatal),
    latch: vi.fn((error: FatalProviderTransportError) => {
      events.push("latch");
      retainedFatal ??= error;
    }),
    hardExit: vi.fn((error: FatalProviderTransportError): never => {
      events.push("hard-exit");
      throw error;
    }),
  };
  const onEvent = vi.fn((event: { kind: string }) => {
    events.push(`event:${event.kind}`);
  });

  return {
    events,
    store,
    materialize,
    provider: {
      adapter: "gmail",
      preparedEnvelopeMatches,
      authorizePreparedDispatch,
    },
    preparedEnvelopeMatches,
    authorizePreparedDispatch,
    failStop,
    onEvent,
    retain(error: FatalProviderTransportError) {
      retainedFatal = error;
    },
  };
}

type Harness = ReturnType<typeof harness>;

function run(
  input: Harness = harness(),
  options: Readonly<{
    retryDecision?: Extract<PreProviderExit, { kind: "retry" | "failed" }>;
    shouldStop?: () => boolean;
    batchSize?: number;
  }> = {},
) {
  const retryDecision = options.retryDecision ?? {
    kind: "retry" as const,
    code: "MATERIALIZE_TRANSIENT",
    retryAt: new Date("2026-07-22T18:01:00.000Z"),
  };
  return processOutboxBatch({
    store: input.store as unknown as OutboxStore<Payload>,
    materialize: input.materialize,
    provider: input.provider as MailProvider,
    claimOwner: "mail-worker:test",
    newClaimToken: () => "55555555-5555-4555-8555-555555555555",
    shouldStop: options.shouldStop ?? (() => false),
    clock: { now: () => new Date("2026-07-22T18:00:00.000Z") },
    retryPolicy: {
      unexpectedMaterializeError: () => retryDecision,
    },
    policy: {
      batchSize: options.batchSize ?? 1,
      materializeLeaseMs: 30_000,
      providerLeaseMs: 60_000,
      maxMaterializeAttempts: 8,
      maxRetryDelayMs: 6 * 60 * 60_000,
      terminalPersistenceAttempts: 2,
    },
    onEvent: input.onEvent,
    failStop: input.failStop,
  });
}

describe("guarded outbox worker", () => {
  it.each([
    "store dispatch",
    "identity matcher",
    "OAuth authorization",
    "fatal reader",
    "fatal latch",
    "hard exit",
  ] as const)("fails before DB work without the required %s seam", async (missing) => {
    const input = harness();
    if (missing === "store dispatch") {
      Reflect.deleteProperty(input.store, "dispatchAfterProviderBoundary");
    } else if (missing === "identity matcher") {
      Reflect.deleteProperty(input.provider, "preparedEnvelopeMatches");
    } else if (missing === "OAuth authorization") {
      Reflect.deleteProperty(input.provider, "authorizePreparedDispatch");
    } else if (missing === "fatal reader") {
      Reflect.deleteProperty(input.failStop, "fatalError");
    } else if (missing === "fatal latch") {
      Reflect.deleteProperty(input.failStop, "latch");
    } else {
      Reflect.deleteProperty(input.failStop, "hardExit");
    }

    await expect(run(input)).rejects.toThrow(
      "Mail worker guarded dispatch dependencies are required.",
    );
    expect(input.store.quarantineAbandoned).not.toHaveBeenCalled();
    expect(input.store.claimNext).not.toHaveBeenCalled();
    expect(input.onEvent).not.toHaveBeenCalled();
  });

  it("sends only the same opaque pair through TX1, OAuth, and retained TX2", async () => {
    const input = harness();

    await expect(run(input)).resolves.toEqual({
      claimed: 1,
      swept: 0,
      outcomes: [{
        id: claim.id,
        operationId: OPERATION_ID,
        kind: "sent",
      }],
    });
    expect(input.events).toEqual([
      "sweep",
      "claim",
      "materialize",
      "match",
      "tx1",
      "oauth",
      "tx2",
      "event:sent",
    ]);
    expect(input.store.finishAfterProvider).not.toHaveBeenCalled();
  });

  it("rejects a mismatched materialized pair before TX1 or OAuth", async () => {
    const input = harness();
    input.preparedEnvelopeMatches.mockReturnValueOnce(false);

    await expect(run(input)).resolves.toMatchObject({
      outcomes: [{
        kind: "failed",
        code: "MATERIALIZED_DISPATCH_IDENTITY_INVALID",
      }],
    });
    expect(input.store.finishBeforeProvider).toHaveBeenCalledWith(
      claim,
      {
        kind: "failed",
        code: "MATERIALIZED_DISPATCH_IDENTITY_INVALID",
      },
    );
    expect(input.store.beginProviderCall).not.toHaveBeenCalled();
    expect(input.authorizePreparedDispatch).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "lost" as const }, "claim-lost", undefined],
    [
      { kind: "suppressed" as const, code: "ACCOUNT_AUTHORITY_REVOKED" },
      "suppressed",
      "ACCOUNT_AUTHORITY_REVOKED",
    ],
  ])("never authorizes after a non-applied TX1 result", async (
    boundary,
    expectedKind,
    expectedCode,
  ) => {
    const input = harness();
    input.store.beginProviderCall.mockResolvedValueOnce(boundary);

    await expect(run(input)).resolves.toMatchObject({
      outcomes: [{
        kind: expectedKind,
        ...(expectedCode ? { code: expectedCode } : {}),
      }],
    });
    expect(input.authorizePreparedDispatch).not.toHaveBeenCalled();
    expect(input.store.dispatchAfterProviderBoundary).not.toHaveBeenCalled();
  });

  it("does not authorize when TX1 commit acknowledgement is unknown", async () => {
    const input = harness();
    input.store.beginProviderCall.mockRejectedValueOnce(
      new Error("connection lost after commit"),
    );

    await expect(run(input)).resolves.toMatchObject({
      outcomes: [{
        kind: "persistence-unknown",
        code: "PROVIDER_BOUNDARY_PERSISTENCE_UNKNOWN",
      }],
    });
    expect(input.store.beginProviderCall).toHaveBeenCalledOnce();
    expect(input.authorizePreparedDispatch).not.toHaveBeenCalled();
    expect(input.store.dispatchAfterProviderBoundary).not.toHaveBeenCalled();
  });

  it("DB-finalizes a definite OAuth rejection without entering TX2", async () => {
    const input = harness();
    input.authorizePreparedDispatch.mockRejectedValueOnce(
      new Error("OAuth rejected"),
    );

    await expect(run(input)).resolves.toMatchObject({
      outcomes: [{
        kind: "failed",
        code: "PROVIDER_AUTHORIZATION_FAILED",
      }],
    });
    expect(input.store.finishAfterProvider).toHaveBeenCalledWith(
      permit,
      { kind: "failed", code: "PROVIDER_AUTHORIZATION_FAILED" },
    );
    expect(input.store.dispatchAfterProviderBoundary).not.toHaveBeenCalled();
  });

  it("synchronously latches and hard-exits an unsettled OAuth transport", async () => {
    const input = harness();
    const fatal = new FatalProviderTransportError(
      "GMAIL_OAUTH_TRANSPORT_UNSETTLED",
    );
    input.authorizePreparedDispatch.mockRejectedValueOnce(fatal);

    await expect(run(input)).rejects.toBe(fatal);
    expect(input.failStop.latch).toHaveBeenCalledWith(fatal);
    expect(input.failStop.hardExit).toHaveBeenCalledWith(fatal);
    expect(input.events.slice(-3)).toEqual(["oauth", "latch", "hard-exit"]);
    expect(input.store.dispatchAfterProviderBoundary).not.toHaveBeenCalled();
    expect(input.store.finishAfterProvider).not.toHaveBeenCalled();
    expect(input.onEvent).not.toHaveBeenCalled();
  });

  it("passes an in-lock fatal hook that preserves the exact unsettled delivery error", async () => {
    const input = harness();
    const fatal = new FatalProviderTransportError(
      "GMAIL_DELIVERY_TRANSPORT_UNSETTLED",
    );
    input.store.dispatchAfterProviderBoundary.mockImplementationOnce(
      async (_permit, _guarded, fatalExit) => {
        input.events.push("tx2-live");
        fatalExit(fatal);
      },
    );

    await expect(run(input)).rejects.toBe(fatal);
    expect(input.events.slice(-3)).toEqual([
      "tx2-live",
      "latch",
      "hard-exit",
    ]);
    expect(input.failStop.latch).toHaveBeenCalledWith(fatal);
    expect(input.failStop.hardExit).toHaveBeenCalledTimes(1);
    expect(input.store.finishAfterProvider).not.toHaveBeenCalled();
    expect(input.onEvent).not.toHaveBeenCalled();
  });

  it("hard-exits a retained exact fatal before sweep, claim, or telemetry", async () => {
    const input = harness();
    const fatal = new FatalProviderTransportError(
      "GMAIL_DELIVERY_TRANSPORT_UNSETTLED",
    );
    input.retain(fatal);

    await expect(run(input)).rejects.toBe(fatal);
    expect(input.failStop.hardExit).toHaveBeenCalledWith(fatal);
    expect(input.store.quarantineAbandoned).not.toHaveBeenCalled();
    expect(input.store.claimNext).not.toHaveBeenCalled();
    expect(input.onEvent).not.toHaveBeenCalled();
  });

  it("rejects an invalid retained fatal state before DB work", async () => {
    const input = harness();
    input.retain(Object.assign(new Error("spoof"), {
      name: "FatalProviderTransportError",
      code: "GMAIL_DELIVERY_TRANSPORT_UNSETTLED",
    }) as FatalProviderTransportError);

    await expect(run(input)).rejects.toThrow(
      "Mail worker retained fatal state is invalid.",
    );
    expect(input.failStop.hardExit).not.toHaveBeenCalled();
    expect(input.store.quarantineAbandoned).not.toHaveBeenCalled();
  });

  it.each([
    [
      "commit",
      (exit: PostProviderExit) =>
        new GuardedDispatchCommitUnknownError(exit),
    ],
    [
      "persistence",
      (exit: PostProviderExit) =>
        new PostProviderPersistenceUnknownError(exit),
    ],
  ] as const)("uses only the carried exit after nominal %s uncertainty", async (
    _label,
    errorFor,
  ) => {
    const input = harness();
    input.store.dispatchAfterProviderBoundary.mockRejectedValueOnce(
      errorFor(sentExit),
    );

    await expect(run(input)).resolves.toMatchObject({
      outcomes: [{ kind: "sent" }],
    });
    expect(input.store.finishAfterProvider).toHaveBeenCalledOnce();
    expect(input.store.finishAfterProvider.mock.calls[0]?.[1]).toBe(sentExit);
    expect(input.store.dispatchAfterProviderBoundary).toHaveBeenCalledOnce();
    expect(input.authorizePreparedDispatch).toHaveBeenCalledOnce();
  });

  it.each([
    "GuardedDispatchCommitUnknownError",
    "PostProviderPersistenceUnknownError",
  ])("does not trust a name-shaped %s spoof", async (name) => {
    const input = harness();
    input.store.dispatchAfterProviderBoundary.mockRejectedValueOnce(
      Object.assign(new Error("spoofed uncertainty"), {
        name,
        exit: sentExit,
      }),
    );

    await expect(run(input)).resolves.toMatchObject({
      outcomes: [{
        kind: "persistence-unknown",
        code: "POST_PROVIDER_PERSISTENCE_FAILED",
      }],
    });
    expect(input.store.finishAfterProvider).not.toHaveBeenCalled();
    expect(input.store.dispatchAfterProviderBoundary).toHaveBeenCalledOnce();
  });

  it("rejects an invalid exit carried by a nominal uncertainty error", async () => {
    const input = harness();
    const invalidExit = {
      kind: "sent",
      providerMessageId: " ",
    } as PostProviderExit;
    input.store.dispatchAfterProviderBoundary.mockRejectedValueOnce(
      new PostProviderPersistenceUnknownError(invalidExit),
    );

    await expect(run(input)).resolves.toMatchObject({
      outcomes: [{
        kind: "persistence-unknown",
        code: "POST_PROVIDER_PERSISTENCE_FAILED",
      }],
    });
    expect(input.store.finishAfterProvider).not.toHaveBeenCalled();
  });

  it("retries only DB finalization after a carried exit and never re-dispatches", async () => {
    const input = harness();
    input.store.dispatchAfterProviderBoundary.mockRejectedValueOnce(
      new GuardedDispatchCommitUnknownError(sentExit),
    );
    input.store.finishAfterProvider
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce({ kind: "applied" });

    await expect(run(input)).resolves.toMatchObject({
      outcomes: [{ kind: "sent" }],
    });
    expect(input.store.dispatchAfterProviderBoundary).toHaveBeenCalledOnce();
    expect(input.store.finishAfterProvider).toHaveBeenCalledTimes(2);
    expect(input.authorizePreparedDispatch).toHaveBeenCalledOnce();
  });

  it("reports DB-only finalizer uncertainty without replaying OAuth or TX2", async () => {
    const input = harness();
    input.store.dispatchAfterProviderBoundary.mockRejectedValueOnce(
      new PostProviderPersistenceUnknownError(sentExit),
    );
    input.store.finishAfterProvider.mockRejectedValue(
      new Error("database unavailable"),
    );

    await expect(run(input)).resolves.toMatchObject({
      outcomes: [{
        kind: "persistence-unknown",
        code: "POST_PROVIDER_PERSISTENCE_FAILED",
      }],
    });
    expect(input.store.dispatchAfterProviderBoundary).toHaveBeenCalledOnce();
    expect(input.store.finishAfterProvider).toHaveBeenCalledTimes(2);
    expect(input.authorizePreparedDispatch).toHaveBeenCalledOnce();
  });

  it("settles materialization errors before TX1 with validated retry policy", async () => {
    const input = harness();
    input.materialize.mockRejectedValueOnce(new Error("source unavailable"));

    await expect(run(input)).resolves.toMatchObject({
      outcomes: [{
        kind: "retry",
        code: "MATERIALIZE_TRANSIENT",
      }],
    });
    expect(input.store.finishBeforeProvider).toHaveBeenCalledWith(
      claim,
      expect.objectContaining({
        kind: "retry",
        code: "MATERIALIZE_TRANSIENT",
      }),
    );
    expect(input.store.beginProviderCall).not.toHaveBeenCalled();
  });

  it("fails closed for an invalid retry date before TX1", async () => {
    const input = harness();
    input.materialize.mockRejectedValueOnce(new Error("source unavailable"));

    await expect(run(input, {
      retryDecision: {
        kind: "retry",
        code: "MATERIALIZE_TRANSIENT",
        retryAt: new Date(Number.NaN),
      },
    })).resolves.toMatchObject({
      outcomes: [{
        kind: "failed",
        code: "RETRY_POLICY_INVALID",
      }],
    });
    expect(input.store.beginProviderCall).not.toHaveBeenCalled();
  });

  it("sweeps before claims and honors a pre-claim stop", async () => {
    const input = harness();
    input.store.quarantineAbandoned.mockResolvedValueOnce(4);

    await expect(run(input, {
      shouldStop: () => true,
    })).resolves.toEqual({
      claimed: 0,
      swept: 4,
      outcomes: [],
    });
    expect(input.store.quarantineAbandoned).toHaveBeenCalledOnce();
    expect(input.store.claimNext).not.toHaveBeenCalled();
  });

  it("does not let telemetry failures change a committed delivery outcome", async () => {
    const input = harness();
    input.onEvent.mockImplementationOnce(() => {
      throw new Error("telemetry unavailable");
    });

    await expect(run(input)).resolves.toMatchObject({
      outcomes: [{ kind: "sent" }],
    });
  });
});
