import { describe, expect, it, vi } from "vitest";

import {
  processOutboxBatch,
  type OutboxClaim,
  type OutboxStore,
  type PreProviderExit,
  type ProviderCallPermit,
  type ProviderStartedClaim,
} from "../outbox-worker";

type Payload = { readonly template: "invitation" };

const claim: OutboxClaim<Payload> = {
  phase: "pre-provider",
  id: "outbox-1",
  operationId: "operation-1",
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
  providerCallStartedAt: new Date("2026-07-22T18:00:05.000Z"),
  leaseExpiresAt: new Date("2026-07-22T18:01:05.000Z"),
};
const permit = started as ProviderCallPermit;

function harness() {
  const events: string[] = [];
  const store: OutboxStore<Payload> = {
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
  };
  const materialize = vi.fn(async () => {
    events.push("materialize");
    return { kind: "ready" as const, message: { to: "learner@example.test" } };
  });
  const send = vi.fn(async () => {
    events.push("send");
    return { kind: "accepted" as const, providerMessageId: "gmail-1" };
  });
  const onEvent = vi.fn();

  return {
    events,
    store,
    materialize,
    provider: { adapter: "gmail", send },
    send,
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
) {
  return {
    input,
    result: processOutboxBatch({
      store: input.store,
      materialize: input.materialize,
      provider: input.provider,
      claimOwner: "worker-1",
      newClaimToken: () => "claim-generated",
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
    }),
  };
}

describe("fenced outbox worker", () => {
  it("commits the provider boundary before one send and fenced sent persistence", async () => {
    const { input, result } = run();

    await expect(result).resolves.toEqual({
      claimed: 1,
      swept: 0,
      outcomes: [{
        id: "outbox-1",
        operationId: "operation-1",
        kind: "sent",
      }],
    });
    expect(input.events).toEqual([
      "sweep",
      "claim",
      "materialize",
      "boundary",
      "send",
      "finish-after:sent",
    ]);
    expect(input.send).toHaveBeenCalledTimes(1);
    expect(input.store.finishAfterProvider).toHaveBeenCalledWith(
      permit,
      { kind: "sent", providerMessageId: "gmail-1" },
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
    expect(input.store.finishAfterProvider).toHaveBeenCalledWith(
      permit,
      { kind: "quarantined", code: "PROVIDER_OUTCOME_AMBIGUOUS" },
    );
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
    expect(input.store.finishAfterProvider).toHaveBeenCalledWith(
      permit,
      { kind: "quarantined", code: "PROVIDER_MESSAGE_ID_MISSING" },
    );
  });

  it("retries only terminal persistence without a second provider call", async () => {
    const input = harness();
    vi.mocked(input.store.finishAfterProvider).mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    const { result } = run(input);

    await expect(result).resolves.toMatchObject({ outcomes: [{ kind: "sent" }] });
    expect(input.send).toHaveBeenCalledTimes(1);
    expect(input.store.finishAfterProvider).toHaveBeenCalledTimes(2);
  });

  it("reports persistence uncertainty when every terminal write fails", async () => {
    const input = harness();
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
