import { beforeEach, describe, expect, it, vi } from "vitest";

const moduleCapabilities = vi.hoisted(() => ({
  envelope: Object.freeze({}),
  materialized: Object.freeze({}),
  safeToDisarm: vi.fn(() => true),
  releaseWatchdogClaim: vi.fn(() => true),
  disarmWatchdog: vi.fn(async () => undefined),
  materializedEnvelope: vi.fn((value: object) =>
    value === moduleCapabilities.materialized
      ? moduleCapabilities.envelope
      : null),
}));

vi.mock("../guarded-prepared-dispatch", () => ({
  materializedDispatchEnvelope: moduleCapabilities.materializedEnvelope,
}));
vi.mock("../postgres-outbox-store", () => ({
  guardedDispatchResultSafeToDisarm: moduleCapabilities.safeToDisarm,
  releaseGuardedDispatchWatchdogClaim: moduleCapabilities.releaseWatchdogClaim,
}));
vi.mock("../mail-dispatch-hard-watchdog", () => ({
  disarmMailDispatchHardWatchdog: moduleCapabilities.disarmWatchdog,
}));

import type {
  GuardedPreparedDispatch,
  MaterializedDispatch,
} from "../guarded-prepared-dispatch";
import type {
  ArmedMailDispatchHardWatchdog,
  MailDispatchHardWatchdog,
} from "../mail-dispatch-hard-watchdog";
import {
  MailDeliveryError,
  type CommittedPreparedDispatchReceipt,
} from "../provider-dispatch-contract";
import {
  processOutboxBatch,
  type GuardedDispatchResult,
  type GuardedDispatchUncertainty,
  type MaterializeResult,
  type OutboxClaim,
  type OutboxStore,
  type PreProviderExit,
  type ProviderCallPermit,
} from "../outbox-worker";

const MATERIALIZED = moduleCapabilities.materialized as MaterializedDispatch;
const ENVELOPE = moduleCapabilities.envelope;
const PERMIT = Object.freeze({}) as ProviderCallPermit;
const RECEIPT = Object.freeze({}) as CommittedPreparedDispatchReceipt;
const GUARDED = Object.freeze({}) as GuardedPreparedDispatch;
const ARMED = Object.freeze({}) as ArmedMailDispatchHardWatchdog;
const UNCERTAINTY = Object.freeze({}) as GuardedDispatchUncertainty;

const SENT_EXIT = Object.freeze({
  kind: "sent" as const,
  providerMessageId: "gmail-1",
});
const APPLIED_SENT = Object.freeze({
  kind: "applied" as const,
  exit: SENT_EXIT,
}) as GuardedDispatchResult;

type Payload = Readonly<{ template: "verify-email" }>;

const claim: OutboxClaim<Payload> = {
  phase: "pre-provider",
  id: "outbox-1",
  operationId: "22222222-2222-4222-8222-222222222222",
  claimToken: "claim-1",
  claimOwner: "worker-1",
  claimVersion: 3,
  userId: "learner-1",
  deliveryScopeKey: "a:learner-1",
  payload: { template: "verify-email" },
  attempt: 1,
  leaseExpiresAt: new Date("2026-07-22T18:00:30.000Z"),
};

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
      return {
        kind: "applied" as const,
        permit: PERMIT,
        receipt: RECEIPT,
      };
    }),
    finishBeforeProvider: vi.fn(async () => {
      events.push("finish-before");
      return { kind: "applied" as const };
    }),
    finishAfterProvider: vi.fn(async (_permit, exit) => {
      events.push(`finish-after:${exit.kind}`);
      return { kind: "applied" as const };
    }),
    dispatchAfterProviderBoundary: vi.fn(async () => {
      events.push("dispatch");
      return APPLIED_SENT;
    }),
    finishGuardedDispatchUnknown: vi.fn(async () => null),
  } satisfies OutboxStore<Payload>;
  const materialize = vi.fn(async (): Promise<MaterializeResult> => {
    events.push("materialize");
    return { kind: "ready", materialized: MATERIALIZED };
  });
  const authorize = vi.fn(async () => {
    events.push("authorize");
    return GUARDED;
  });
  const discardReceipt = vi.fn(() => true);
  const discardGuard = vi.fn(() => true);
  const watchdog = {
    arm: vi.fn(async () => {
      events.push("arm");
      return ARMED;
    }),
    close: vi.fn(async () => undefined),
  } satisfies MailDispatchHardWatchdog;
  const onEvent = vi.fn();

  return {
    authorize,
    discardGuard,
    discardReceipt,
    events,
    materialize,
    onEvent,
    store,
    watchdog,
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
      adapter: "gmail",
      authorize: input.authorize,
      discardReceipt: input.discardReceipt,
      discardGuard: input.discardGuard,
      watchdog: input.watchdog,
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
        maxMaterializeAttempts: 8,
        maxRetryDelayMs: 6 * 60 * 60_000,
        terminalPersistenceAttempts: 2,
      },
      onEvent: input.onEvent,
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  moduleCapabilities.safeToDisarm.mockReturnValue(true);
  moduleCapabilities.releaseWatchdogClaim.mockReturnValue(true);
  moduleCapabilities.disarmWatchdog.mockResolvedValue(undefined);
  moduleCapabilities.materializedEnvelope.mockImplementation((value: object) =>
    value === moduleCapabilities.materialized
      ? moduleCapabilities.envelope
      : null);
});

describe("fenced outbox worker", () => {
  it("uses the committed receipt, guarded dispatch, and watchdog in order", async () => {
    const { input, result } = run();

    await expect(result).resolves.toEqual({
      claimed: 1,
      swept: 0,
      outcomes: [{ kind: "sent" }],
    });
    expect(input.events).toEqual([
      "sweep",
      "claim",
      "materialize",
      "boundary",
      "authorize",
      "arm",
      "dispatch",
    ]);
    expect(input.store.beginProviderCall).toHaveBeenCalledWith(claim, {
      adapter: "gmail",
      envelope: ENVELOPE,
    });
    expect(input.authorize).toHaveBeenCalledWith(RECEIPT);
    expect(input.store.dispatchAfterProviderBoundary).toHaveBeenCalledWith(
      PERMIT,
      GUARDED,
      ARMED,
    );
    expect(moduleCapabilities.safeToDisarm).toHaveBeenCalledWith(
      input.store,
      ARMED,
      APPLIED_SENT,
    );
    expect(moduleCapabilities.disarmWatchdog).toHaveBeenCalledWith(ARMED);
    expect(moduleCapabilities.releaseWatchdogClaim).toHaveBeenCalledWith(
      input.store,
      ARMED,
    );
    expect(input.store.finishAfterProvider).not.toHaveBeenCalled();
  });

  it("reports an applied authority suppression without authorizing dispatch", async () => {
    const input = harness();
    input.store.beginProviderCall.mockResolvedValueOnce({
      kind: "suppressed",
      code: "ACCOUNT_NOT_ACTIVE_AT_PROVIDER_BOUNDARY",
    } as never);

    await expect(run(input).result).resolves.toMatchObject({
      outcomes: [{
        kind: "suppressed",
        code: "ACCOUNT_NOT_ACTIVE_AT_PROVIDER_BOUNDARY",
      }],
    });
    expect(input.authorize).not.toHaveBeenCalled();
    expect(input.watchdog.arm).not.toHaveBeenCalled();
    expect(input.store.dispatchAfterProviderBoundary).not.toHaveBeenCalled();
  });

  it("never authorizes dispatch when the boundary CAS is lost", async () => {
    const input = harness();
    input.store.beginProviderCall.mockResolvedValueOnce({ kind: "lost" } as never);

    await expect(run(input).result).resolves.toMatchObject({
      outcomes: [{ kind: "claim-lost" }],
    });
    expect(input.authorize).not.toHaveBeenCalled();
    expect(input.store.dispatchAfterProviderBoundary).not.toHaveBeenCalled();
  });

  it("discards a committed receipt when stop is requested after the boundary", async () => {
    const input = harness();
    const shouldStop = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    await expect(run(input, undefined, shouldStop).result).resolves.toEqual({
      claimed: 1,
      swept: 0,
      outcomes: [{
        kind: "persistence-unknown",
        code: "WORKER_STOPPED_AFTER_PROVIDER_BOUNDARY",
      }],
    });
    expect(input.discardReceipt).toHaveBeenCalledWith(PERMIT, RECEIPT);
    expect(input.authorize).not.toHaveBeenCalled();
    expect(input.store.claimNext).toHaveBeenCalledTimes(1);
  });

  it("discards guarded authority when stop is requested after authorization", async () => {
    const input = harness();
    const shouldStop = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    await expect(run(input, undefined, shouldStop).result).resolves.toMatchObject({
      outcomes: [{
        kind: "persistence-unknown",
        code: "WORKER_STOPPED_AFTER_PROVIDER_AUTHORIZATION",
      }],
    });
    expect(input.discardGuard).toHaveBeenCalledWith(PERMIT, GUARDED);
    expect(input.watchdog.arm).not.toHaveBeenCalled();
  });

  it("settles retryable materialization failures before the provider boundary", async () => {
    const input = harness();
    input.materialize.mockRejectedValueOnce(new Error("temporary database read"));

    await expect(run(input).result).resolves.toMatchObject({
      outcomes: [{ kind: "retry", code: "MATERIALIZE_TRANSIENT" }],
    });
    expect(input.store.finishBeforeProvider).toHaveBeenCalledWith(
      claim,
      expect.objectContaining({ kind: "retry", code: "MATERIALIZE_TRANSIENT" }),
    );
    expect(input.store.beginProviderCall).not.toHaveBeenCalled();
  });

  it("settles explicit materialization suppression before boundary work", async () => {
    const input = harness();
    input.materialize.mockResolvedValueOnce({
      kind: "suppressed",
      code: "TEMPLATE_POLICY_INVALID",
    });

    await expect(run(input).result).resolves.toMatchObject({
      outcomes: [{ kind: "suppressed", code: "TEMPLATE_POLICY_INVALID" }],
    });
    expect(input.store.finishBeforeProvider).toHaveBeenCalledWith(claim, {
      kind: "suppressed",
      code: "TEMPLATE_POLICY_INVALID",
    });
    expect(input.store.beginProviderCall).not.toHaveBeenCalled();
  });

  it("fails a forged materialized dispatch before the provider boundary", async () => {
    const input = harness();
    input.materialize.mockResolvedValueOnce({
      kind: "ready",
      materialized: Object.freeze({}) as MaterializedDispatch,
    });

    await expect(run(input).result).resolves.toMatchObject({
      outcomes: [{ kind: "failed", code: "MATERIALIZED_DISPATCH_INVALID" }],
    });
    expect(input.store.finishBeforeProvider).toHaveBeenCalledWith(claim, {
      kind: "failed",
      code: "MATERIALIZED_DISPATCH_INVALID",
    });
    expect(input.store.beginProviderCall).not.toHaveBeenCalled();
  });

  it("does not replay a provider boundary whose commit is unknown", async () => {
    const input = harness();
    input.store.beginProviderCall.mockRejectedValueOnce(
      new Error("connection lost after commit"),
    );

    await expect(run(input).result).resolves.toMatchObject({
      outcomes: [{
        kind: "persistence-unknown",
        code: "PROVIDER_BOUNDARY_PERSISTENCE_UNKNOWN",
      }],
    });
    expect(input.store.beginProviderCall).toHaveBeenCalledTimes(1);
    expect(input.authorize).not.toHaveBeenCalled();
  });

  it("quarantines an unexpected authorization error with the issued permit", async () => {
    const input = harness();
    input.authorize.mockRejectedValueOnce(new Error("provider state unknown"));

    await expect(run(input).result).resolves.toMatchObject({
      outcomes: [{ kind: "quarantined", code: "PROVIDER_OUTCOME_UNKNOWN" }],
    });
    expect(input.store.finishAfterProvider).toHaveBeenCalledWith(PERMIT, {
      kind: "quarantined",
      code: "PROVIDER_OUTCOME_UNKNOWN",
    });
    expect(input.watchdog.arm).not.toHaveBeenCalled();
  });

  it("retries only a definite-rejection terminal write", async () => {
    const input = harness();
    input.authorize.mockRejectedValueOnce(new MailDeliveryError("GMAIL_OAUTH_FAILED"));
    input.store.finishAfterProvider
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce({ kind: "applied" });

    await expect(run(input).result).resolves.toMatchObject({
      outcomes: [{ kind: "failed", code: "GMAIL_OAUTH_FAILED" }],
    });
    expect(input.authorize).toHaveBeenCalledTimes(1);
    expect(input.store.finishAfterProvider).toHaveBeenCalledTimes(2);
  });

  it("disarms before recovering a guarded persistence-unknown result", async () => {
    const input = harness();
    const unknown = Object.freeze({
      kind: "persistence-unknown" as const,
      uncertainty: UNCERTAINTY,
    }) as GuardedDispatchResult;
    input.store.dispatchAfterProviderBoundary.mockResolvedValueOnce(unknown);
    input.store.finishGuardedDispatchUnknown.mockResolvedValueOnce({
      result: { kind: "applied" },
      exit: SENT_EXIT,
    } as never);

    await expect(run(input).result).resolves.toMatchObject({
      outcomes: [{ kind: "sent" }],
    });
    expect(moduleCapabilities.disarmWatchdog).toHaveBeenCalledWith(ARMED);
    expect(moduleCapabilities.releaseWatchdogClaim).toHaveBeenCalledWith(
      input.store,
      ARMED,
    );
    expect(input.store.finishGuardedDispatchUnknown).toHaveBeenCalledWith(
      UNCERTAINTY,
    );
  });

  it("reports an unrecoverable guarded persistence result without resending", async () => {
    const input = harness();
    input.store.dispatchAfterProviderBoundary.mockResolvedValueOnce(Object.freeze({
      kind: "persistence-unknown" as const,
      uncertainty: UNCERTAINTY,
    }) as GuardedDispatchResult);
    input.store.finishGuardedDispatchUnknown.mockResolvedValueOnce(null);

    await expect(run(input).result).resolves.toMatchObject({
      outcomes: [{
        kind: "persistence-unknown",
        code: "POST_PROVIDER_PERSISTENCE_FAILED",
      }],
    });
    expect(input.store.dispatchAfterProviderBoundary).toHaveBeenCalledTimes(1);
    expect(input.store.finishAfterProvider).not.toHaveBeenCalled();
  });

  it("reports a lost guarded dispatch only after safe watchdog release", async () => {
    const input = harness();
    const lost = Object.freeze({ kind: "lost" as const }) as GuardedDispatchResult;
    input.store.dispatchAfterProviderBoundary.mockResolvedValueOnce(lost);

    await expect(run(input).result).resolves.toMatchObject({
      outcomes: [{ kind: "claim-lost" }],
    });
    expect(moduleCapabilities.safeToDisarm).toHaveBeenCalledWith(
      input.store,
      ARMED,
      lost,
    );
    expect(moduleCapabilities.releaseWatchdogClaim).toHaveBeenCalled();
  });

  it.each([
    { label: "invalid", retryAt: new Date(Number.NaN) },
    { label: "equal-to-now", retryAt: new Date("2026-07-22T18:00:00.000Z") },
    { label: "past", retryAt: new Date("2026-07-22T17:59:59.999Z") },
    { label: "too-far", retryAt: new Date("2026-07-23T00:00:00.001Z") },
  ])("fails closed for a $label retry date", async ({ retryAt }) => {
    const input = harness();
    input.materialize.mockRejectedValueOnce(new Error("temporary database read"));

    await expect(run(input, {
      kind: "retry",
      code: "MATERIALIZE_TRANSIENT",
      retryAt,
    }).result).resolves.toMatchObject({
      outcomes: [{ kind: "failed", code: "RETRY_POLICY_INVALID" }],
    });
    expect(input.store.finishBeforeProvider).toHaveBeenCalledWith(claim, {
      kind: "failed",
      code: "RETRY_POLICY_INVALID",
    });
    expect(input.store.beginProviderCall).not.toHaveBeenCalled();
  });

  it("sweeps abandoned post-boundary work before claiming new rows", async () => {
    const input = harness();
    input.store.quarantineAbandoned.mockImplementationOnce(async () => {
      input.events.push("sweep");
      return 4;
    });

    await expect(run(input).result).resolves.toMatchObject({ claimed: 1, swept: 4 });
    expect(input.events[0]).toBe("sweep");
  });
});