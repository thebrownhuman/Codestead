import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  disarm: vi.fn(),
  envelope: Object.freeze({}),
  fatal: vi.fn((): never => {
    throw new Error("MAIL_DISPATCH_FATAL_TERMINATION");
  }),
  materialized: Object.freeze({}),
  materializedDispatchEnvelope: vi.fn(),
  release: vi.fn(),
  safeToDisarm: vi.fn(),
}));

vi.mock("../guarded-prepared-dispatch", () => ({
  materializedDispatchEnvelope: runtime.materializedDispatchEnvelope,
}));
vi.mock("../mail-dispatch-hard-watchdog", () => ({
  disarmMailDispatchHardWatchdog: runtime.disarm,
}));
vi.mock("../mail-dispatch-fatal-termination", () => ({
  terminateMailDispatchImmediately: runtime.fatal,
}));
vi.mock("../postgres-outbox-store", () => ({
  guardedDispatchResultSafeToDisarm: runtime.safeToDisarm,
  releaseGuardedDispatchWatchdogClaim: runtime.release,
}));

import type {
  GuardedPreparedDispatch,
  MaterializedDispatch,
  PreparedDispatchEnvelope,
} from "../guarded-prepared-dispatch";
import type { ArmedMailDispatchHardWatchdog } from "../mail-dispatch-hard-watchdog";
import {
  FatalProviderTransportError,
  MailDeliveryError,
  type CommittedPreparedDispatchReceipt,
} from "../provider-dispatch-contract";
import {
  processOutboxBatch,
  type GuardedDispatchUncertainty,
  type MaterializeResult,
  type OutboxClaim,
  type OutboxStore,
  type PreProviderExit,
  type ProviderCallPermit,
} from "../outbox-worker";

type Payload = { readonly template: "invitation" };

const OUTBOX_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const CLAIM_TOKEN = "44444444-4444-4444-8444-444444444444";

const claim: OutboxClaim<Payload> = Object.freeze({
  phase: "pre-provider",
  id: OUTBOX_ID,
  operationId: OPERATION_ID,
  claimToken: CLAIM_TOKEN,
  claimOwner: "worker-1",
  claimVersion: 3,
  userId: USER_ID,
  deliveryScopeKey: `a:${USER_ID}`,
  payload: { template: "invitation" as const },
  attempt: 1,
  leaseExpiresAt: new Date("2026-07-22T18:00:30.000Z"),
});

type Harness = ReturnType<typeof harness>;

function capability<T>(): T {
  return Object.freeze({}) as T;
}

function harness() {
  const events: string[] = [];
  const permit = capability<ProviderCallPermit>();
  const receipt = capability<CommittedPreparedDispatchReceipt>();
  const guarded = capability<GuardedPreparedDispatch>();
  const armedWatchdog = capability<ArmedMailDispatchHardWatchdog>();
  const uncertainty = capability<GuardedDispatchUncertainty>();

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
      return { kind: "applied" as const, permit, receipt };
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
      return {
        kind: "applied" as const,
        exit: { kind: "sent" as const, providerMessageId: "gmail-1" },
      };
    }),
    finishGuardedDispatchUnknown: vi.fn(async () => {
      events.push("finish-unknown");
      return null;
    }),
  };
  const materialize = vi.fn(async (): Promise<MaterializeResult> => {
    events.push("materialize");
    return {
      kind: "ready" as const,
      materialized: runtime.materialized as MaterializedDispatch,
    };
  });
  const authorize = vi.fn(async () => {
    events.push("authorize");
    return guarded;
  });
  const discardReceipt = vi.fn(() => {
    events.push("discard-receipt");
    return true;
  });
  const discardGuard = vi.fn(() => {
    events.push("discard-guard");
    return true;
  });
  const watchdog = {
    arm: vi.fn(async () => {
      events.push("arm");
      return armedWatchdog;
    }),
    close: vi.fn(async () => undefined),
  };
  const onEvent = vi.fn();

  runtime.materializedDispatchEnvelope.mockImplementation((candidate) => (
    candidate === runtime.materialized
      ? runtime.envelope as PreparedDispatchEnvelope
      : null
  ));
  runtime.safeToDisarm.mockImplementation(() => {
    events.push("safe-to-disarm");
    return true;
  });
  runtime.disarm.mockImplementation(async () => {
    events.push("disarm");
  });
  runtime.release.mockImplementation(() => {
    events.push("release-watchdog");
    return true;
  });

  return {
    armedWatchdog,
    authorize,
    discardGuard,
    discardReceipt,
    events,
    guarded,
    materialize,
    onEvent,
    permit,
    receipt,
    store,
    uncertainty,
    watchdog,
  };
}

function run(
  input: Harness = harness(),
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
      newClaimToken: () => CLAIM_TOKEN,
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

function expectFatal(result: Promise<unknown>) {
  return expect(result).rejects.toThrow("MAIL_DISPATCH_FATAL_TERMINATION");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("guarded outbox worker", () => {
  it("routes the only physical provider call through store-owned guarded TX2", async () => {
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
      "safe-to-disarm",
      "disarm",
      "release-watchdog",
    ]);
    expect(input.store.dispatchAfterProviderBoundary).toHaveBeenCalledWith(
      input.permit,
      input.guarded,
      input.armedWatchdog,
    );
    expect(input.store.finishAfterProvider).not.toHaveBeenCalled();
    expect(Object.keys(input.permit)).toEqual([]);
  });

  it("redacts row and operation identity from outcomes and telemetry", async () => {
    const { input, result } = run();

    await expect(result).resolves.toMatchObject({
      outcomes: [{ kind: "sent" }],
    });
    expect(input.onEvent).toHaveBeenCalledWith({ kind: "sent" });
    expect(input.onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: OUTBOX_ID }),
    );
    expect(input.onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ operationId: OPERATION_ID }),
    );
  });

  it("passes only the opaque envelope to committed TX1", async () => {
    const { input, result } = run();

    await expect(result).resolves.toMatchObject({
      outcomes: [{ kind: "sent" }],
    });
    expect(input.store.beginProviderCall).toHaveBeenCalledWith(claim, {
      adapter: "gmail",
      envelope: runtime.envelope,
    });
    expect(input.authorize).toHaveBeenCalledWith(input.receipt);
  });

  it.each([
    {
      label: "lost",
      boundary: { kind: "lost" as const },
      outcome: { kind: "claim-lost" },
    },
    {
      label: "suppressed",
      boundary: {
        kind: "suppressed" as const,
        code: "ACCOUNT_NOT_ACTIVE_AT_PROVIDER_BOUNDARY",
      },
      outcome: {
        kind: "suppressed",
        code: "ACCOUNT_NOT_ACTIVE_AT_PROVIDER_BOUNDARY",
      },
    },
  ])("does no OAuth or TX2 when TX1 is $label", async ({
    boundary,
    outcome,
  }) => {
    const input = harness();
    vi.mocked(input.store.beginProviderCall).mockResolvedValue(boundary);
    const { result } = run(input);

    await expect(result).resolves.toMatchObject({ outcomes: [outcome] });
    expect(input.authorize).not.toHaveBeenCalled();
    expect(input.store.dispatchAfterProviderBoundary).not.toHaveBeenCalled();
  });

  it("does no OAuth or TX2 when TX1 commit acknowledgement is unknown", async () => {
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
    expect(input.authorize).not.toHaveBeenCalled();
    expect(input.store.dispatchAfterProviderBoundary).not.toHaveBeenCalled();
  });

  it("discards the exact receipt when stopping after TX1", async () => {
    const input = harness();
    const shouldStop = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const { result } = run(input, undefined, shouldStop);

    await expect(result).resolves.toMatchObject({
      claimed: 1,
      outcomes: [{
        kind: "persistence-unknown",
        code: "WORKER_STOPPED_AFTER_PROVIDER_BOUNDARY",
      }],
    });
    expect(input.discardReceipt).toHaveBeenCalledWith(
      input.permit,
      input.receipt,
    );
    expect(input.authorize).not.toHaveBeenCalled();
  });

  it("discards the exact guard when stopping after authorization", async () => {
    const input = harness();
    const shouldStop = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const { result } = run(input, undefined, shouldStop);

    await expect(result).resolves.toMatchObject({
      claimed: 1,
      outcomes: [{
        kind: "persistence-unknown",
        code: "WORKER_STOPPED_AFTER_PROVIDER_AUTHORIZATION",
      }],
    });
    expect(input.discardGuard).toHaveBeenCalledWith(
      input.permit,
      input.guarded,
    );
    expect(input.watchdog.arm).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "receipt",
      configure(input: Harness) {
        input.discardReceipt.mockReturnValue(false);
        return vi.fn()
          .mockReturnValueOnce(false)
          .mockReturnValueOnce(true);
      },
    },
    {
      label: "guard",
      configure(input: Harness) {
        input.discardGuard.mockReturnValue(false);
        return vi.fn()
          .mockReturnValueOnce(false)
          .mockReturnValueOnce(false)
          .mockReturnValueOnce(true);
      },
    },
  ])("fails stopped when the one-shot $label cannot be discarded", async ({
    configure,
  }) => {
    const input = harness();
    await expectFatal(run(input, undefined, configure(input)).result);
    expect(input.store.dispatchAfterProviderBoundary).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "definite OAuth rejection",
      error: new MailDeliveryError("GMAIL_OAUTH_FAILED"),
      exit: { kind: "failed" as const, code: "GMAIL_OAUTH_FAILED" },
    },
    {
      label: "unknown OAuth response",
      error: new Error("invalid OAuth response"),
      exit: {
        kind: "quarantined" as const,
        code: "PROVIDER_OUTCOME_UNKNOWN",
      },
    },
  ])("settles $label outside TX2", async ({ error, exit }) => {
    const input = harness();
    input.authorize.mockRejectedValueOnce(error);
    const { result } = run(input);

    await expect(result).resolves.toMatchObject({ outcomes: [exit] });
    expect(input.store.finishAfterProvider).toHaveBeenCalledWith(
      input.permit,
      exit,
    );
    expect(input.store.dispatchAfterProviderBoundary).not.toHaveBeenCalled();
  });

  it("does not trust an error that merely spoofs the fatal error name", async () => {
    const input = harness();
    input.authorize.mockRejectedValueOnce(
      Object.assign(new Error("spoof"), {
        name: "FatalProviderTransportError",
      }),
    );
    const { result } = run(input);

    await expect(result).resolves.toMatchObject({
      outcomes: [{
        kind: "quarantined",
        code: "PROVIDER_OUTCOME_UNKNOWN",
      }],
    });
    expect(runtime.fatal).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "authorization",
      configure(input: Harness) {
        input.authorize.mockRejectedValueOnce(
          new FatalProviderTransportError(
            "GMAIL_OAUTH_TRANSPORT_UNSETTLED",
          ),
        );
      },
    },
    {
      label: "materialization",
      configure(input: Harness) {
        input.materialize.mockRejectedValueOnce(
          new FatalProviderTransportError("PROVIDER_TRANSPORT_FATAL"),
        );
      },
    },
    {
      label: "watchdog arm",
      configure(input: Harness) {
        input.watchdog.arm.mockRejectedValueOnce(new Error("watchdog down"));
      },
    },
    {
      label: "TX2 throw",
      configure(input: Harness) {
        vi.mocked(input.store.dispatchAfterProviderBoundary)
          .mockRejectedValueOnce(new Error("TX2 result unknown"));
      },
    },
    {
      label: "untrusted TX2 result",
      configure() {
        runtime.safeToDisarm.mockReturnValueOnce(false);
      },
    },
    {
      label: "watchdog disarm",
      configure() {
        runtime.disarm.mockRejectedValueOnce(new Error("no acknowledgement"));
      },
    },
    {
      label: "watchdog release refusal",
      configure() {
        runtime.release.mockReturnValueOnce(false);
      },
    },
    {
      label: "watchdog release throw",
      configure() {
        runtime.release.mockImplementationOnce(() => {
          throw new Error("release failed");
        });
      },
    },
  ])("fails stopped for $label", async ({ configure }) => {
    const input = harness();
    configure(input);
    await expectFatal(run(input).result);
  });

  it("settles TX2 persistence uncertainty once through the DB-only finalizer", async () => {
    const input = harness();
    vi.mocked(input.store.dispatchAfterProviderBoundary).mockResolvedValueOnce({
      kind: "persistence-unknown",
      uncertainty: input.uncertainty,
    });
    vi.mocked(input.store.finishGuardedDispatchUnknown).mockResolvedValueOnce({
      result: { kind: "already-applied" },
      exit: { kind: "sent", providerMessageId: "gmail-1" },
    });
    const { result } = run(input);

    await expect(result).resolves.toMatchObject({
      outcomes: [{ kind: "sent" }],
    });
    expect(input.store.dispatchAfterProviderBoundary).toHaveBeenCalledTimes(1);
    expect(input.store.finishGuardedDispatchUnknown).toHaveBeenCalledWith(
      input.uncertainty,
    );
    expect(input.store.finishAfterProvider).not.toHaveBeenCalled();
    expect(runtime.disarm).toHaveBeenCalledTimes(1);
    expect(runtime.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "finalizer failure",
      settle(store: Harness["store"]) {
        vi.mocked(store.finishGuardedDispatchUnknown).mockRejectedValueOnce(
          new Error("database unavailable"),
        );
      },
      outcome: {
        kind: "persistence-unknown",
        code: "POST_PROVIDER_PERSISTENCE_FAILED",
      },
    },
    {
      label: "lost finalizer fence",
      settle(store: Harness["store"]) {
        vi.mocked(store.finishGuardedDispatchUnknown).mockResolvedValueOnce({
          result: { kind: "lost" },
          exit: {
            kind: "quarantined",
            code: "PROVIDER_OUTCOME_AMBIGUOUS",
          },
        });
      },
      outcome: {
        kind: "persistence-unknown",
        code: "POST_PROVIDER_FENCE_LOST",
      },
    },
  ])("never redispatches after $label", async ({ settle, outcome }) => {
    const input = harness();
    vi.mocked(input.store.dispatchAfterProviderBoundary).mockResolvedValueOnce({
      kind: "persistence-unknown",
      uncertainty: input.uncertainty,
    });
    settle(input.store);
    const { result } = run(input);

    await expect(result).resolves.toMatchObject({ outcomes: [outcome] });
    expect(input.store.dispatchAfterProviderBoundary).toHaveBeenCalledTimes(1);
    expect(input.store.finishGuardedDispatchUnknown).toHaveBeenCalledTimes(1);
    expect(input.store.finishAfterProvider).not.toHaveBeenCalled();
  });

  it("reports TX2 CAS loss without a second dispatch", async () => {
    const input = harness();
    vi.mocked(input.store.dispatchAfterProviderBoundary).mockResolvedValueOnce({
      kind: "lost",
    });
    const { result } = run(input);

    await expect(result).resolves.toMatchObject({
      outcomes: [{ kind: "claim-lost" }],
    });
    expect(input.store.dispatchAfterProviderBoundary).toHaveBeenCalledTimes(1);
    expect(input.store.finishGuardedDispatchUnknown).not.toHaveBeenCalled();
  });

  it("does not let throwing telemetry alter a committed outcome", async () => {
    const input = harness();
    input.onEvent.mockImplementation(() => {
      throw new Error("telemetry unavailable");
    });
    const { result } = run(input);

    await expect(result).resolves.toMatchObject({
      outcomes: [{ kind: "sent" }],
    });
  });

  it("freezes an outcome before exposing it to telemetry", async () => {
    const input = harness();
    input.onEvent.mockImplementation((event) => {
      (event as { kind: string }).kind = "failed";
    });
    const { result } = run(input);
    const batch = await result;

    expect(batch).toMatchObject({
      outcomes: [{ kind: "sent" }],
    });
    expect(Object.isFrozen(batch.outcomes[0])).toBe(true);
  });

  it.each([
    {
      label: "thrown retryable error",
      materialized: new Error("temporary read failure"),
      outcome: { kind: "retry", code: "MATERIALIZE_TRANSIENT" },
    },
    {
      label: "explicit suppression",
      materialized: {
        kind: "suppressed" as const,
        code: "TEMPLATE_POLICY_INVALID",
      },
      outcome: { kind: "suppressed", code: "TEMPLATE_POLICY_INVALID" },
    },
  ])("settles $label before TX1", async ({ materialized, outcome }) => {
    const input = harness();
    if (materialized instanceof Error) {
      input.materialize.mockRejectedValueOnce(materialized);
    } else {
      input.materialize.mockResolvedValueOnce(materialized);
    }
    const { result } = run(input);

    await expect(result).resolves.toMatchObject({ outcomes: [outcome] });
    expect(input.store.beginProviderCall).not.toHaveBeenCalled();
  });

  it("fails materialization closed when no authentic envelope exists", async () => {
    const input = harness();
    runtime.materializedDispatchEnvelope.mockReturnValueOnce(null);
    const { result } = run(input);

    await expect(result).resolves.toMatchObject({
      outcomes: [{
        kind: "failed",
        code: "MATERIALIZED_DISPATCH_INVALID",
      }],
    });
    expect(input.store.beginProviderCall).not.toHaveBeenCalled();
  });

  it.each([
    { label: "invalid", retryAt: new Date(Number.NaN) },
    { label: "equal-to-now", retryAt: new Date("2026-07-22T18:00:00.000Z") },
    { label: "past", retryAt: new Date("2026-07-22T17:59:59.999Z") },
    { label: "too-far", retryAt: new Date("2026-07-23T00:00:00.001Z") },
  ])("fails closed for a $label retry date", async ({ retryAt }) => {
    const input = harness();
    input.materialize.mockRejectedValueOnce(new Error("temporary read failure"));
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
  });

  it("sweeps abandoned work before claiming new rows", async () => {
    const input = harness();
    vi.mocked(input.store.quarantineAbandoned).mockImplementationOnce(
      async () => {
        input.events.push("sweep");
        return 4;
      },
    );
    const { result } = run(input);

    await expect(result).resolves.toMatchObject({ claimed: 1, swept: 4 });
    expect(input.events[0]).toBe("sweep");
  });
});
