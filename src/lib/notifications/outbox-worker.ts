import type { DispatchBinding } from "./prepared-dispatch";
import {
  materializedDispatchEnvelope,
  type GuardedPreparedDispatch,
  type MaterializedDispatch,
  type PreparedDispatchEnvelope,
} from "./guarded-prepared-dispatch";
import {
  disarmMailDispatchHardWatchdog,
  type ArmedMailDispatchHardWatchdog,
  type MailDispatchHardWatchdog,
} from "./mail-dispatch-hard-watchdog";
import { terminateMailDispatchImmediately } from "./mail-dispatch-fatal-termination";
import {
  guardedDispatchResultSafeToDisarm,
  releaseGuardedDispatchWatchdogClaim,
} from "./postgres-outbox-store";
import {
  PostProviderPersistenceUnknownError,
  ProviderBoundaryCommitUnknownError,
} from "./outbox-store-errors";
import {
  classifyMailDeliveryError,
  FatalProviderTransportError,
  isFatalProviderTransportError,
  type CommittedPreparedDispatchReceipt,
  type PostProviderExit,
} from "./provider-dispatch-contract";

export {
  FatalProviderTransportError,
  PostProviderPersistenceUnknownError,
  ProviderBoundaryCommitUnknownError,
  type PostProviderExit,
};

export type ClaimFence = Readonly<{
  id: string;
  operationId: string;
  claimToken: string;
  claimOwner: string;
  claimVersion: number;
  userId: string | null;
  deliveryScopeKey: string;
}>;

export type OutboxClaim<P = unknown> = ClaimFence &
  Readonly<{
    phase: "pre-provider";
    payload: P;
    attempt: number;
    leaseExpiresAt: Date;
  }>;

export type ProviderStartedClaim = ClaimFence &
  DispatchBinding &
  Readonly<{
    phase: "post-provider";
    adapter: string;
    providerCallStartedAt: string;
    leaseExpiresAt: Date;
  }>;

declare const providerCallPermitBrand: unique symbol;

export type ProviderCallPermit = Readonly<{
  [providerCallPermitBrand]: "ProviderCallPermit";
}>;

export type PreFinishResult =
  | { readonly kind: "applied" }
  | { readonly kind: "lost" };

export type PostFinishResult =
  | { readonly kind: "applied" }
  | { readonly kind: "already-applied" }
  | { readonly kind: "lost" };

export type BoundaryResult =
  | {
      readonly kind: "applied";
      readonly permit: ProviderCallPermit;
      readonly receipt: CommittedPreparedDispatchReceipt;
    }
  | { readonly kind: "suppressed"; readonly code: string }
  | { readonly kind: "lost" };

export type PreProviderExit =
  | { readonly kind: "retry"; readonly code: string; readonly retryAt: Date }
  | { readonly kind: "failed"; readonly code: string }
  | { readonly kind: "suppressed"; readonly code: string };

declare const guardedDispatchUncertaintyBrand: unique symbol;

export type GuardedDispatchUncertainty = Readonly<{
  [guardedDispatchUncertaintyBrand]: "GuardedDispatchUncertainty";
}>;

export type GuardedDispatchResult =
  | { readonly kind: "applied"; readonly exit: PostProviderExit }
  | { readonly kind: "lost" }
  | {
      readonly kind: "persistence-unknown";
      readonly uncertainty: GuardedDispatchUncertainty;
    };

export type GuardedUnknownFinishResult = Readonly<{
  result: PostFinishResult;
  exit: PostProviderExit;
}>;

export type MaterializeResult =
  | { readonly kind: "ready"; readonly materialized: MaterializedDispatch }
  | PreProviderExit;

export interface OutboxStore<P = unknown> {
  claimNext(
    input: Readonly<{
      owner: string;
      token: string;
      leaseMs: number;
    }>,
  ): Promise<OutboxClaim<P> | null>;

  beginProviderCall(
    claim: OutboxClaim<P>,
    input: Readonly<{
      adapter: string;
      envelope: PreparedDispatchEnvelope;
    }>,
  ): Promise<BoundaryResult>;

  finishBeforeProvider(
    claim: OutboxClaim<P>,
    exit: PreProviderExit,
  ): Promise<PreFinishResult>;

  finishAfterProvider(
    permit: ProviderCallPermit,
    exit: PostProviderExit,
  ): Promise<PostFinishResult>;

  dispatchAfterProviderBoundary(
    permit: ProviderCallPermit,
    guarded: GuardedPreparedDispatch,
    armedWatchdog: ArmedMailDispatchHardWatchdog,
  ): Promise<GuardedDispatchResult>;

  finishGuardedDispatchUnknown(
    uncertainty: GuardedDispatchUncertainty,
  ): Promise<GuardedUnknownFinishResult | null>;

  quarantineAbandoned(input: Readonly<{ limit: number }>): Promise<number>;
}

export type ItemOutcome = Readonly<{
  kind:
    | "sent"
    | "retry"
    | "failed"
    | "suppressed"
    | "quarantined"
    | "claim-lost"
    | "persistence-unknown";
  code?: string;
}>;

export interface ProcessOutboxBatchDeps<P> {
  readonly store: OutboxStore<P>;
  readonly materialize: (
    claim: OutboxClaim<P>,
  ) => Promise<MaterializeResult>;
  readonly adapter: string;
  readonly authorize: (
    receipt: CommittedPreparedDispatchReceipt,
  ) => Promise<GuardedPreparedDispatch>;
  readonly discardReceipt: (
    permit: ProviderCallPermit,
    receipt: CommittedPreparedDispatchReceipt,
  ) => boolean;
  readonly discardGuard: (
    permit: ProviderCallPermit,
    guarded: GuardedPreparedDispatch,
  ) => boolean;
  readonly watchdog: MailDispatchHardWatchdog;
  readonly claimOwner: string;
  readonly newClaimToken: () => string;
  readonly shouldStop: () => boolean;
  readonly clock: { now(): Date };
  readonly retryPolicy: {
    unexpectedMaterializeError(
      input: Readonly<{
        attempt: number;
        now: Date;
        error: unknown;
      }>,
    ): Extract<PreProviderExit, { kind: "retry" | "failed" }>;
  };
  readonly policy: Readonly<{
    batchSize: number;
    materializeLeaseMs: number;
    maxMaterializeAttempts: number;
    maxRetryDelayMs: number;
    terminalPersistenceAttempts: number;
  }>;
  readonly onEvent?: (event: ItemOutcome) => void;
}

export type ProcessOutboxBatchResult = Readonly<{
  claimed: number;
  swept: number;
  outcomes: readonly ItemOutcome[];
}>;

function validateDependencies<P>(deps: ProcessOutboxBatchDeps<P>) {
  if (!deps.claimOwner.trim()) {
    throw new Error("Mail claim owner must be nonblank.");
  }
  if (!deps.adapter.trim()) {
    throw new Error("Mail provider adapter must be nonblank.");
  }
  for (const [name, value] of [
    ["batchSize", deps.policy.batchSize],
    ["materializeLeaseMs", deps.policy.materializeLeaseMs],
    ["maxMaterializeAttempts", deps.policy.maxMaterializeAttempts],
    ["maxRetryDelayMs", deps.policy.maxRetryDelayMs],
    ["terminalPersistenceAttempts", deps.policy.terminalPersistenceAttempts],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Mail worker ${name} must be a positive safe integer.`);
    }
  }
}

function validCode(code: string) {
  const trimmed = code.trim();
  return trimmed.length > 0 && trimmed.length <= 80;
}

function validatePreProviderDecision(
  decision: Extract<PreProviderExit, { kind: "retry" | "failed" }>,
  input: Readonly<{
    now: Date;
    attempt: number;
    maxAttempts: number;
    maxRetryDelayMs: number;
  }>,
): Extract<PreProviderExit, { kind: "retry" | "failed" }> {
  if (!validCode(decision.code)) {
    return { kind: "failed", code: "RETRY_POLICY_INVALID" };
  }
  if (decision.kind === "failed") return decision;

  const nowMs = input.now.getTime();
  const retryMs = decision.retryAt.getTime();
  if (
    !Number.isFinite(nowMs)
    || !Number.isFinite(retryMs)
    || input.attempt >= input.maxAttempts
    || retryMs <= nowMs
    || retryMs > nowMs + input.maxRetryDelayMs
  ) {
    return { kind: "failed", code: "RETRY_POLICY_INVALID" };
  }
  return { ...decision, retryAt: new Date(retryMs) };
}

function outcome(
  _claim: ClaimFence,
  kind: ItemOutcome["kind"],
  code?: string,
): ItemOutcome {
  return Object.freeze({
    kind,
    ...(code ? { code } : {}),
  });
}

function emit(
  callback: ((event: ItemOutcome) => void) | undefined,
  event: ItemOutcome,
) {
  try {
    callback?.(event);
  } catch {
    // Observability must never control delivery state.
  }
}

async function finishBefore<P>(
  deps: ProcessOutboxBatchDeps<P>,
  claim: OutboxClaim<P>,
  exit: PreProviderExit,
): Promise<ItemOutcome> {
  try {
    const result = await deps.store.finishBeforeProvider(claim, exit);
    if (result.kind === "lost") return outcome(claim, "claim-lost");
    return outcome(claim, exit.kind, exit.code);
  } catch {
    return outcome(
      claim,
      "persistence-unknown",
      "PRE_PROVIDER_PERSISTENCE_FAILED",
    );
  }
}

async function finishAfter<P>(
  deps: ProcessOutboxBatchDeps<P>,
  claim: OutboxClaim<P>,
  permit: ProviderCallPermit,
  exit: PostProviderExit,
): Promise<ItemOutcome> {
  for (
    let attempt = 1;
    attempt <= deps.policy.terminalPersistenceAttempts;
    attempt += 1
  ) {
    try {
      const result = await deps.store.finishAfterProvider(permit, exit);
      if (result.kind === "lost") {
        return outcome(
          claim,
          "persistence-unknown",
          "POST_PROVIDER_FENCE_LOST",
        );
      }
      return outcome(
        claim,
        exit.kind,
        "code" in exit ? exit.code : undefined,
      );
    } catch {
      if (attempt === deps.policy.terminalPersistenceAttempts) {
        return outcome(
          claim,
          "persistence-unknown",
          "POST_PROVIDER_PERSISTENCE_FAILED",
        );
      }
    }
  }
  return outcome(
    claim,
    "persistence-unknown",
    "POST_PROVIDER_PERSISTENCE_FAILED",
  );
}

function failStopped(): never {
  return terminateMailDispatchImmediately();
}

export async function processOutboxBatch<P>(
  deps: ProcessOutboxBatchDeps<P>,
): Promise<ProcessOutboxBatchResult> {
  validateDependencies(deps);
  const swept = await deps.store.quarantineAbandoned({
    limit: deps.policy.batchSize,
  });
  const outcomes: ItemOutcome[] = [];
  let claimed = 0;

  for (let index = 0; index < deps.policy.batchSize; index += 1) {
    if (deps.shouldStop()) break;
    const next = await deps.store.claimNext({
      owner: deps.claimOwner,
      token: deps.newClaimToken(),
      leaseMs: deps.policy.materializeLeaseMs,
    });
    if (!next) break;
    claimed += 1;

    let materialized: MaterializeResult;
    try {
      materialized = await deps.materialize(next);
    } catch (error) {
      if (isFatalProviderTransportError(error)) return failStopped();
      const now = deps.clock.now();
      try {
        materialized = validatePreProviderDecision(
          deps.retryPolicy.unexpectedMaterializeError({
            attempt: next.attempt,
            now,
            error,
          }),
          {
            now,
            attempt: next.attempt,
            maxAttempts: deps.policy.maxMaterializeAttempts,
            maxRetryDelayMs: deps.policy.maxRetryDelayMs,
          },
        );
      } catch {
        materialized = { kind: "failed", code: "RETRY_POLICY_INVALID" };
      }
    }

    if (materialized.kind !== "ready") {
      const item = await finishBefore(deps, next, materialized);
      outcomes.push(item);
      emit(deps.onEvent, item);
      continue;
    }

    const envelope = materializedDispatchEnvelope(materialized.materialized);
    if (!envelope) {
      const item = await finishBefore(deps, next, {
        kind: "failed",
        code: "MATERIALIZED_DISPATCH_INVALID",
      });
      outcomes.push(item);
      emit(deps.onEvent, item);
      continue;
    }

    let boundary: BoundaryResult;
    try {
      boundary = await deps.store.beginProviderCall(next, {
        adapter: deps.adapter,
        envelope,
      });
    } catch {
      const item = outcome(
        next,
        "persistence-unknown",
        "PROVIDER_BOUNDARY_PERSISTENCE_UNKNOWN",
      );
      outcomes.push(item);
      emit(deps.onEvent, item);
      continue;
    }
    if (boundary.kind === "lost") {
      const item = outcome(next, "claim-lost");
      outcomes.push(item);
      emit(deps.onEvent, item);
      continue;
    }
    if (boundary.kind === "suppressed") {
      const item = outcome(next, "suppressed", boundary.code);
      outcomes.push(item);
      emit(deps.onEvent, item);
      continue;
    }

    if (deps.shouldStop()) {
      let discarded = false;
      try {
        discarded = deps.discardReceipt(
          boundary.permit,
          boundary.receipt,
        );
      } catch {
        // The exact one-shot receipt remains live.
      }
      if (!discarded) return failStopped();
      const item = outcome(
        next,
        "persistence-unknown",
        "WORKER_STOPPED_AFTER_PROVIDER_BOUNDARY",
      );
      outcomes.push(item);
      emit(deps.onEvent, item);
      break;
    }

    let guarded: GuardedPreparedDispatch;
    try {
      guarded = await deps.authorize(boundary.receipt);
    } catch (error) {
      if (isFatalProviderTransportError(error)) return failStopped();
      const failure = classifyMailDeliveryError(error);
      if (failure.kind === "fatal") return failStopped();
      const exit: PostProviderExit = failure.kind === "definitely-rejected"
        ? Object.freeze({ kind: "failed" as const, code: failure.code })
        : Object.freeze({
            kind: "quarantined" as const,
            code: failure.code,
          });
      const item = await finishAfter(
        deps,
        next,
        boundary.permit,
        exit,
      );
      outcomes.push(item);
      emit(deps.onEvent, item);
      continue;
    }

    if (deps.shouldStop()) {
      let discarded = false;
      try {
        discarded = deps.discardGuard(boundary.permit, guarded);
      } catch {
        // The exact one-shot guard remains live.
      }
      if (!discarded) return failStopped();
      const item = outcome(
        next,
        "persistence-unknown",
        "WORKER_STOPPED_AFTER_PROVIDER_AUTHORIZATION",
      );
      outcomes.push(item);
      emit(deps.onEvent, item);
      break;
    }

    let armedWatchdog: ArmedMailDispatchHardWatchdog;
    try {
      armedWatchdog = await deps.watchdog.arm();
    } catch {
      return failStopped();
    }

    let dispatchResult: GuardedDispatchResult;
    try {
      dispatchResult = await deps.store.dispatchAfterProviderBoundary(
        boundary.permit,
        guarded,
        armedWatchdog,
      );
    } catch {
      return failStopped();
    }

    let safeToDisarm = false;
    try {
      safeToDisarm = guardedDispatchResultSafeToDisarm(
        deps.store as object,
        armedWatchdog,
        dispatchResult,
      );
    } catch {
      // Only a store-issued result can prove the provider is no longer active.
    }
    if (!safeToDisarm) return failStopped();

    try {
      await disarmMailDispatchHardWatchdog(armedWatchdog);
    } catch {
      return failStopped();
    }
    try {
      if (
        releaseGuardedDispatchWatchdogClaim(
          deps.store as object,
          armedWatchdog,
        ) !== true
      ) {
        return failStopped();
      }
    } catch {
      return failStopped();
    }

    if (dispatchResult.kind === "persistence-unknown") {
      let recovered: GuardedUnknownFinishResult | null = null;
      try {
        recovered = await deps.store.finishGuardedDispatchUnknown(
          dispatchResult.uncertainty,
        );
      } catch {
        // Safe DISARM completed; this is a DB-only settlement failure.
      }
      const item = recovered === null
        ? outcome(
            next,
            "persistence-unknown",
            "POST_PROVIDER_PERSISTENCE_FAILED",
          )
        : recovered.result.kind === "lost"
          ? outcome(
              next,
              "persistence-unknown",
              "POST_PROVIDER_FENCE_LOST",
            )
          : outcome(
              next,
              recovered.exit.kind,
              "code" in recovered.exit ? recovered.exit.code : undefined,
            );
      outcomes.push(item);
      emit(deps.onEvent, item);
      continue;
    }

    if (dispatchResult.kind === "lost") {
      const item = outcome(next, "claim-lost");
      outcomes.push(item);
      emit(deps.onEvent, item);
      continue;
    }
    const item = outcome(
      next,
      dispatchResult.exit.kind,
      "code" in dispatchResult.exit
        ? dispatchResult.exit.code
        : undefined,
    );
    outcomes.push(item);
    emit(deps.onEvent, item);
  }

  return { claimed, swept, outcomes };
}
