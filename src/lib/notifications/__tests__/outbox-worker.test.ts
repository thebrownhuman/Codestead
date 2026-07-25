import { describe, expect, it, vi } from "vitest";

import {
  FatalProviderTransportError,
  processOutboxBatch,
  type OutboxClaim,
  type OutboxStore,
  type PreProviderExit,
  type ProviderCallPermit,
  type ProviderStartedClaim,
  type ProviderSendResult,
} from "../outbox-worker";

type Payload = { readonly template: "invitation" };

const OPERATION_ID = "22222222-2222-4222-8222-222222222222";

const claim: OutboxClaim<Payload> = {
  phase: "pre-provider",
  id: "outbox-1",
  operationId: OPERATION_ID,
  claimToken: "claim-1",
  claimOwner: "worker-1",
  claimVersion: 3,
  payload: { template: "invitation" },
  attempt: 1,
  leaseExpiresAt: new Date("2026-07-22T18:00:30.000Z"),
};

const started: ProviderStartedClaim = {
  phase: "post-provider",
  id: claim.id,
  operationId: claim.operationId,
  claimToken: claim.claimToken,
  claimOwner: claim.claimOwner,
  claimVersion: claim.claimVersion,
  adapter: "gmail",
  providerCallStartedAt: "2026-07-22 18:00:05.123456+00",
  leaseExpiresAt: new Date("2026-07-22T18:01:05.000Z"),
};
const permit = started as ProviderCallPermit;
const prepared = Object.freeze({
  adapter: "gmail" as const,
  bindingVersion: "gmail-raw-v1" as const,
  bindingSha256: "a".repeat(64),
  authorityBindingVersion: "prepared-authority-v1" as const,
  authorityBindingSha256: "b".repeat(64),
  requestBody: "{\"raw\":\"immutable\"}",
});

function harness() {
  const events: string[] = [];
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
      .mockImplementationOnce(async () => null),
    beginProviderCall: vi.fn(async () => {
      events.push("boundary");
      return { kind: "applied" as const, permit };
    }),
    finishBeforeProvider: vi.fn(async () => {
      events.push("finish-before");
      return { kind: "applied" as const };
    }),
    finishAfterProvider: vi.fn(async (_claim, exit) => {
      events.push(`finish-after:${exit.kind}`);
      return { kind: "applied" as const };
    }),
    dispatchAfterProviderBoundary: vi.fn(async (
      _permit: ProviderCallPermit,
      input: {
        prepared: typeof prepared;
        invoke(signal: AbortSignal): Promise<
          { kind: "sent"; providerMessageId: string }
          | { kind: "failed"; code: string }
          | { kind: "quarantined"; code: string }
        >;
      },
    ) => {
      events.push("guard");
      const exit = await input.invoke(new AbortController().signal);
      events.push(`finish-after:${exit.kind}`);
      return { kind: "applied" as const, exit };
    }),
  };
  const materialize = vi.fn(async () => {
    events.push("materialize");
    return { kind: "ready" as const, message: prepared };
  });
  const send = vi.fn(async (): Promise<ProviderSendResult> => {
    events.push("send");
    return { kind: "accepted" as const, providerMessageId: "gmail-1" };
  });
  const authorize = vi.fn(async () => {
    events.push("authorize");
    return Object.freeze({ accessToken: "never-log-this" });
  });
  let latched = false;
  const failStop = {
    isLatched: vi.fn(() => latched),
    latch: vi.fn(() => {
      latched = true;
      events.push("fail-stop");
    }),
  };
  const terminate = vi.fn(async () => {
    events.push("terminate-transport");
  });
  const onEvent = vi.fn();

  return {
    events,
    store,
    materialize,
    provider: { adapter: "gmail", authorize, dispatch: send, send, terminate },
    send,
    terminate,
    failStop,
    onEvent,
  };
}

function run(
  input = harness(),
  retryDecision: Extract<PreProviderExit, { kind: "retry" | "failed" }> = {
    kind: "retry",
    code: "MATERIALIZE_TRANSIENT",
    retryAt: new Date("2026-07-22T18:01:00.000Z"),
  },
  shouldStop: () => boolean = () => false,
) {
  return {
    input,
    result: processOutboxBatch({
      store: input.store,
      materialize: input.materialize,
      provider: input.provider,
      claimOwner: "worker-1",
      newClaimToken: () => "claim-generated",
      shouldStop,
      clock: { now: () => new Date("2026-07-22T18:00:00.000Z") },
      retryPolicy: {
        unexpectedMaterializeError: () => retryDecision,
      },
      policy: {
        batchSize: 2,
        materializeLeaseMs: 30_000,
        providerLeaseMs: 60_000,
        maxMaterializeAttempts: 8,
        maxRetryDelayMs: 6 * 60 * 60_000,
        terminalPersistenceAttempts: 2,
      },
      onEvent: input.onEvent,
      failStop: input.failStop,
    }),
  };
}

describe("fenced outbox worker", () => {
  it.each([
    "store guard",
    "provider authorization",
    "provider dispatch",
  ] as const)("fails closed before all DB work without required %s", async (missing) => {
    const input = harness();
    if (missing === "store guard") {
      Reflect.deleteProperty(input.store, "dispatchAfterProviderBoundary");
    } else if (missing === "provider authorization") {
      Reflect.deleteProperty(input.provider, "authorize");
    } else {
      Reflect.deleteProperty(input.provider, "dispatch");
    }

    const { result } = run(input);

    await expect(result).rejects.toThrow(
      "Mail worker guarded dispatch dependencies are required.",
    );
    expect(input.store.quarantineAbandoned).not.toHaveBeenCalled();
    expect(input.store.claimNext).not.toHaveBeenCalled();
    expect(input.send).not.toHaveBeenCalled();
  });

  it("authorizes after TX1 and invokes exactly one send inside the retained TX2 guard", async () => {
    const events: string[] = [];
    const prepared = Object.freeze({
      adapter: "gmail" as const,
      bindingVersion: "gmail-raw-v1" as const,
      bindingSha256: "a".repeat(64),
      authorityBindingVersion: "prepared-authority-v1" as const,
      authorityBindingSha256: "b".repeat(64),
      requestBody: "{\"raw\":\"immutable\"}",
    });
    const authorization = Object.freeze({ accessToken: "never-log-this" });
    const dispatch = vi.fn(async (
      _message: typeof prepared,
      receivedAuthorization: typeof authorization,
      context: { signal: AbortSignal },
    ): Promise<ProviderSendResult> => {
      events.push("provider-send");
      expect(receivedAuthorization).toBe(authorization);
      expect(context.signal).toBeInstanceOf(AbortSignal);
      return { kind: "accepted", providerMessageId: "gmail-guarded-1" };
    });
    const finishAfterProvider = vi.fn(async () => ({
      kind: "applied" as const,
    }));
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
        .mockResolvedValueOnce(null),
      beginProviderCall: vi.fn(async (
        _claim: typeof claim,
        input: { prepared: typeof prepared },
      ) => {
        events.push("tx1-commit");
        expect(input.prepared).toBe(prepared);
        return { kind: "applied" as const, permit };
      }),
      finishBeforeProvider: vi.fn(),
      finishAfterProvider,
      dispatchAfterProviderBoundary: vi.fn(async (
        _permit: ProviderCallPermit,
        input: {
          prepared: typeof prepared;
          invoke(signal: AbortSignal): Promise<unknown>;
        },
      ) => {
        events.push("tx2-begin");
        expect(input.prepared).toBe(prepared);
        const exit = await input.invoke(new AbortController().signal);
        events.push(`tx2-terminal:${(exit as { kind: string }).kind}`);
        return { kind: "applied" as const, exit };
      }),
    };
    const provider = {
      adapter: "gmail",
      authorize: vi.fn(async () => {
        events.push("oauth");
        return authorization;
      }),
      dispatch,
    };

    const result = processOutboxBatch({
      store,
      materialize: vi.fn(async () => {
        events.push("prepare");
        return { kind: "ready" as const, message: prepared };
      }),
      provider,
      claimOwner: "worker-1",
      newClaimToken: () => "claim-generated",
      shouldStop: () => false,
      clock: { now: () => new Date("2026-07-22T18:00:00.000Z") },
      retryPolicy: {
        unexpectedMaterializeError: vi.fn(),
      },
      policy: {
        batchSize: 2,
        materializeLeaseMs: 30_000,
        providerLeaseMs: 60_000,
        maxMaterializeAttempts: 8,
        maxRetryDelayMs: 6 * 60 * 60_000,
        terminalPersistenceAttempts: 2,
      },
    } as never);

    await expect(result).resolves.toMatchObject({
      outcomes: [{ kind: "sent" }],
    });
    expect(events).toEqual([
      "sweep",
      "claim",
      "prepare",
      "tx1-commit",
      "oauth",
      "tx2-begin",
      "provider-send",
      "tx2-terminal:sent",
    ]);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(finishAfterProvider).not.toHaveBeenCalled();
  });

  it("commits the provider boundary before one send and fenced sent persistence", async () => {
    const { input, result } = run();

    await expect(result).resolves.toEqual({
      claimed: 1,
      swept: 0,
      outcomes: [{
        id: "outbox-1",
        operationId: OPERATION_ID,
        kind: "sent",
      }],
    });
    expect(input.events).toEqual([
      "sweep",
      "claim",
      "materialize",
      "boundary",
      "authorize",
      "guard",
      "send",
      "finish-after:sent",
    ]);
    expect(input.send).toHaveBeenCalledTimes(1);
    expect(input.store.finishAfterProvider).not.toHaveBeenCalled();
    expect(input.store.dispatchAfterProviderBoundary).toHaveBeenCalledOnce();
  });

  it("derives a deterministic RFC Message-ID only after the provider permit", async () => {
    const { input, result } = run();

    await expect(result).resolves.toMatchObject({
      outcomes: [{ kind: "sent" }],
    });
    expect(input.events.indexOf("boundary")).toBeLessThan(
      input.events.indexOf("send"),
    );
    expect(input.send).toHaveBeenCalledWith(
      prepared,
      expect.objectContaining({ accessToken: "never-log-this" }),
      {
        operationId: OPERATION_ID,
        permit,
        messageId:
          "<codestead.outbox.22222222-2222-4222-8222-222222222222@mail.codestead.invalid>",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("reports an applied authority suppression without calling the provider", async () => {
    const input = harness();
    vi.mocked(input.store.beginProviderCall).mockResolvedValue({
      kind: "suppressed",
      code: "ACCOUNT_NOT_ACTIVE_AT_PROVIDER_BOUNDARY",
    });
    const { result } = run(input);

    await expect(result).resolves.toMatchObject({
      outcomes: [{
        kind: "suppressed",
        code: "ACCOUNT_NOT_ACTIVE_AT_PROVIDER_BOUNDARY",
      }],
    });
    expect(input.send).not.toHaveBeenCalled();
    expect(input.store.finishAfterProvider).not.toHaveBeenCalled();
  });

  it("finishes an in-flight send but stops before claiming another item", async () => {
    const input = harness();
    let stopping = false;
    const secondClaim: OutboxClaim<Payload> = {
      ...claim,
      id: "outbox-2",
      operationId: "operation-2",
      claimToken: "claim-2",
    };
    vi.mocked(input.store.claimNext)
      .mockReset()
      .mockResolvedValueOnce(claim)
      .mockResolvedValueOnce(secondClaim)
      .mockResolvedValueOnce(null);
    input.send.mockImplementationOnce(async () => {
      stopping = true;
      await Promise.resolve();
      return {
        kind: "accepted" as const,
        providerMessageId: "gmail-1",
      };
    });

    const { result } = run(input, undefined, () => stopping);

    await expect(result).resolves.toEqual({
      claimed: 1,
      swept: 0,
      outcomes: [{
        id: "outbox-1",
        operationId: OPERATION_ID,
        kind: "sent",
      }],
    });
    expect(input.send).toHaveBeenCalledTimes(1);
    expect(input.store.dispatchAfterProviderBoundary).toHaveBeenCalledTimes(1);
    expect(input.store.claimNext).toHaveBeenCalledTimes(1);
  });

  it("never calls the provider when the boundary CAS is lost", async () => {
    const input = harness();
    vi.mocked(input.store.beginProviderCall).mockResolvedValue({ kind: "lost" });
    const { result } = run(input);

    await expect(result).resolves.toMatchObject({
      outcomes: [{ kind: "claim-lost" }],
    });
    expect(input.send).not.toHaveBeenCalled();
    expect(input.store.finishAfterProvider).not.toHaveBeenCalled();
  });

  it("settles retryable materialization failures before the provider boundary", async () => {
    const input = harness();
    input.materialize.mockRejectedValueOnce(new Error("temporary database read"));
    const { result } = run(input);

    await expect(result).resolves.toMatchObject({
      outcomes: [{ kind: "retry", code: "MATERIALIZE_TRANSIENT" }],
    });
    expect(input.store.finishBeforeProvider).toHaveBeenCalledWith(
      claim,
      expect.objectContaining({ kind: "retry", code: "MATERIALIZE_TRANSIENT" }),
    );
    expect(input.store.beginProviderCall).not.toHaveBeenCalled();
    expect(input.send).not.toHaveBeenCalled();
  });

  it("quarantines every unexpected post-boundary provider error without retry", async () => {
    const input = harness();
    input.send.mockRejectedValueOnce(new Error("connection reset after request write"));
    const { result } = run(input);

    await expect(result).resolves.toMatchObject({
      outcomes: [{ kind: "quarantined", code: "PROVIDER_OUTCOME_AMBIGUOUS" }],
    });
    expect(input.send).toHaveBeenCalledTimes(1);
    expect(input.store.finishAfterProvider).not.toHaveBeenCalled();
  });


  it("latches fail-stop, terminates transport, and rejects every later claim after an unsettled abort", async () => {
    const input = harness();
    input.send.mockRejectedValueOnce(new FatalProviderTransportError(
      "GMAIL_DELIVERY_TRANSPORT_UNSETTLED",
    ));
    const { result } = run(input);

    await expect(result).rejects.toThrow(
      "Fatal provider transport failure (GMAIL_DELIVERY_TRANSPORT_UNSETTLED).",
    );
    expect(input.send).toHaveBeenCalledOnce();
    expect(input.store.finishAfterProvider).not.toHaveBeenCalled();
    expect(input.store.claimNext).toHaveBeenCalledOnce();
    expect(input.failStop.latch).toHaveBeenCalledOnce();
    expect(input.terminate).toHaveBeenCalledOnce();
    expect(input.events.slice(-2)).toEqual([
      "fail-stop",
      "terminate-transport",
    ]);

    const later = run(input).result;
    await expect(later).resolves.toEqual({ claimed: 0, swept: 0, outcomes: [] });
    expect(input.store.quarantineAbandoned).toHaveBeenCalledOnce();
    expect(input.store.claimNext).toHaveBeenCalledOnce();
  });
  it("defensively quarantines an accepted response with a blank provider ID", async () => {
    const input = harness();
    input.send.mockResolvedValueOnce({
      kind: "accepted",
      providerMessageId: "   ",
    });
    const { result } = run(input);

    await expect(result).resolves.toMatchObject({
      outcomes: [{ kind: "quarantined", code: "PROVIDER_MESSAGE_ID_MISSING" }],
    });
    expect(input.send).toHaveBeenCalledTimes(1);
    expect(input.store.finishAfterProvider).not.toHaveBeenCalled();
  });

  it("retries only captured terminal persistence after an unknown TX2 commit", async () => {
    const input = harness();
    vi.mocked(input.store.dispatchAfterProviderBoundary).mockImplementationOnce(
      async (_permit, guarded) => {
        const exit = await guarded.invoke(new AbortController().signal);
        throw Object.assign(
          new Error("TX2 commit acknowledgement lost"),
          {
            name: "GuardedDispatchCommitUnknownError",
            exit,
          },
        );
      },
    );
    vi.mocked(input.store.finishAfterProvider).mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    const { result } = run(input);

    await expect(result).resolves.toMatchObject({ outcomes: [{ kind: "sent" }] });
    expect(input.send).toHaveBeenCalledTimes(1);
    expect(input.store.finishAfterProvider).toHaveBeenCalledTimes(2);
  });

  it("never resends when TX2 commit and every DB-only finalizer are uncertain", async () => {
    const input = harness();
    vi.mocked(input.store.dispatchAfterProviderBoundary).mockImplementationOnce(
      async (_permit, guarded) => {
        const exit = await guarded.invoke(new AbortController().signal);
        throw Object.assign(
          new Error("TX2 commit acknowledgement lost"),
          {
            name: "GuardedDispatchCommitUnknownError",
            exit,
          },
        );
      },
    );
    vi.mocked(input.store.finishAfterProvider).mockRejectedValue(
      new Error("database unavailable"),
    );
    const { result } = run(input);

    await expect(result).resolves.toMatchObject({
      outcomes: [{ kind: "persistence-unknown", code: "POST_PROVIDER_PERSISTENCE_FAILED" }],
    });
    expect(input.send).toHaveBeenCalledTimes(1);
    expect(input.store.finishAfterProvider).toHaveBeenCalledTimes(2);
  });

  it("does not send or replay the boundary when its commit acknowledgement is unknown", async () => {
    const input = harness();
    vi.mocked(input.store.beginProviderCall).mockRejectedValueOnce(
      new Error("connection lost after commit"),
    );
    const { result } = run(input);

    await expect(result).resolves.toMatchObject({
      outcomes: [{
        kind: "persistence-unknown",
        code: "PROVIDER_BOUNDARY_PERSISTENCE_UNKNOWN",
      }],
    });
    expect(input.store.beginProviderCall).toHaveBeenCalledTimes(1);
    expect(input.send).not.toHaveBeenCalled();
    expect(input.store.finishAfterProvider).not.toHaveBeenCalled();
  });

  it.each([
    { label: "invalid", retryAt: new Date(Number.NaN) },
    { label: "equal-to-now", retryAt: new Date("2026-07-22T18:00:00.000Z") },
    { label: "past", retryAt: new Date("2026-07-22T17:59:59.999Z") },
    { label: "too-far", retryAt: new Date("2026-07-23T00:00:00.001Z") },
  ])("fails closed for a $label retry date", async ({ retryAt }) => {
    const input = harness();
    input.materialize.mockRejectedValueOnce(new Error("temporary database read"));
    const { result } = run(input, {
      kind: "retry",
      code: "MATERIALIZE_TRANSIENT",
      retryAt,
    });

    await expect(result).resolves.toMatchObject({
      outcomes: [{ kind: "failed", code: "RETRY_POLICY_INVALID" }],
    });
    expect(input.store.finishBeforeProvider).toHaveBeenCalledWith(
      claim,
      { kind: "failed", code: "RETRY_POLICY_INVALID" },
    );
    expect(input.store.beginProviderCall).not.toHaveBeenCalled();
    expect(input.send).not.toHaveBeenCalled();
  });

  it("sweeps abandoned post-boundary work before claiming new rows", async () => {
    const input = harness();
    vi.mocked(input.store.quarantineAbandoned).mockImplementationOnce(async () => {
      input.events.push("sweep");
      return 4;
    });
    const { result } = run(input);

    await expect(result).resolves.toMatchObject({ claimed: 1, swept: 4 });
    expect(input.events[0]).toBe("sweep");
  });
});
