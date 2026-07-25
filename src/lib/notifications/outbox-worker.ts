import { outboxMessageId } from "./provider-correlation";

export type ClaimFence = Readonly<{
  id: string;
  operationId: string;
  claimToken: string;
  claimOwner: string;
  claimVersion: number;
}>;

export type OutboxClaim<P = unknown> = ClaimFence & Readonly<{
  phase: "pre-provider";
  payload: P;
  attempt: number;
  leaseExpiresAt: Date;
}>;

export type ProviderStartedClaim = ClaimFence & Readonly<{
  phase: "post-provider";
  adapter: string;
  providerCallStartedAt: string;
  leaseExpiresAt: Date;
}>;

declare const providerCallPermitBrand: unique symbol;

export type ProviderCallPermit = ProviderStartedClaim & Readonly<{
  [providerCallPermitBrand]: true;
}>;

export type PreFinishResult =
  | { readonly kind: "applied" }
  | { readonly kind: "lost" };

export type PostFinishResult =
  | { readonly kind: "applied" }
  | { readonly kind: "already-applied" }
  | { readonly kind: "lost" };

export type BoundaryResult =
  | { readonly kind: "applied"; readonly permit: ProviderCallPermit }
  | { readonly kind: "suppressed"; readonly code: string }
  | { readonly kind: "lost" };

export type PreProviderExit =
  | { readonly kind: "retry"; readonly code: string; readonly retryAt: Date }
  | { readonly kind: "failed"; readonly code: string }
  | { readonly kind: "suppressed"; readonly code: string };

export type PostProviderExit =
  | { readonly kind: "sent"; readonly providerMessageId: string }
  | { readonly kind: "failed"; readonly code: string }
  | { readonly kind: "quarantined"; readonly code: string };

export type MaterializeResult<M> =
  | { readonly kind: "ready"; readonly message: M }
  | PreProviderExit;

export type ProviderSendResult =
  | { readonly kind: "accepted"; readonly providerMessageId: string }
  | { readonly kind: "definitely-rejected"; readonly code: string }
  | { readonly kind: "ambiguous"; readonly code: string }
  | { readonly kind: "fatal"; readonly code: string };

export class FatalProviderTransportError extends Error {
  constructor(readonly code: string) {
    super(`Fatal provider transport failure (${code}).`);
    this.name = "FatalProviderTransportError";
  }
}

export interface OutboxStore<P = unknown> {
  claimNext(input: Readonly<{
    owner: string;
    token: string;
    leaseMs: number;
  }>): Promise<OutboxClaim<P> | null>;

  beginProviderCall(
    claim: OutboxClaim<P>,
    input: Readonly<{ adapter: string; leaseMs: number }>,
  ): Promise<BoundaryResult>;

  finishBeforeProvider(
    claim: OutboxClaim<P>,
    exit: PreProviderExit,
  ): Promise<PreFinishResult>;

  finishAfterProvider(
    permit: ProviderCallPermit,
    exit: PostProviderExit,
  ): Promise<PostFinishResult>;

  quarantineAbandoned(input: Readonly<{ limit: number }>): Promise<number>;
}

export interface MailProvider<M> {
  readonly adapter: string;
  send(
    message: M,
    context: Readonly<{
      operationId: string;
      permit: ProviderCallPermit;
      messageId: string;
    }>,
  ): Promise<ProviderSendResult>;
}

export type ItemOutcome = Readonly<{
  id: string;
  operationId: string;
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

export interface ProcessOutboxBatchDeps<P, M> {
  readonly store: OutboxStore<P>;
  readonly materialize: (claim: OutboxClaim<P>) => Promise<MaterializeResult<M>>;
  readonly provider: MailProvider<M>;
  readonly claimOwner: string;
  readonly newClaimToken: () => string;
  readonly shouldStop: () => boolean;
  readonly clock: { now(): Date };
  readonly retryPolicy: {
    unexpectedMaterializeError(input: Readonly<{
      attempt: number;
      now: Date;
      error: unknown;
    }>): Extract<PreProviderExit, { kind: "retry" | "failed" }>;
  };
  readonly policy: Readonly<{
    batchSize: number;
    materializeLeaseMs: number;
    providerLeaseMs: number;
    maxMaterializeAttempts: number;
    maxRetryDelayMs: number;
    terminalPersistenceAttempts: number;
  }>;
  readonly onEvent?: (event: ItemOutcome) => void;
  readonly failStop?: Readonly<{
    isLatched(): boolean;
    latch(error: FatalProviderTransportError): void;
  }>;
}

export type ProcessOutboxBatchResult = Readonly<{
  claimed: number;
  swept: number;
  outcomes: readonly ItemOutcome[];
}>;

function validateDependencies<P, M>(deps: ProcessOutboxBatchDeps<P, M>) {
  if (!deps.claimOwner.trim()) throw new Error("Mail claim owner must be nonblank.");
  if (!deps.provider.adapter.trim()) throw new Error("Mail provider adapter must be nonblank.");
  for (const [name, value] of [
    ["batchSize", deps.policy.batchSize],
    ["materializeLeaseMs", deps.policy.materializeLeaseMs],
    ["providerLeaseMs", deps.policy.providerLeaseMs],
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
  claim: ClaimFence,
  kind: ItemOutcome["kind"],
  code?: string,
): ItemOutcome {
  return {
    id: claim.id,
    operationId: claim.operationId,
    kind,
    ...(code ? { code } : {}),
  };
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

async function finishBefore<P, M>(
  deps: ProcessOutboxBatchDeps<P, M>,
  claim: OutboxClaim<P>,
  exit: PreProviderExit,
): Promise<ItemOutcome> {
  try {
    const result = await deps.store.finishBeforeProvider(claim, exit);
    if (result.kind === "lost") return outcome(claim, "claim-lost");
    return outcome(claim, exit.kind, exit.code);
  } catch {
    return outcome(claim, "persistence-unknown", "PRE_PROVIDER_PERSISTENCE_FAILED");
  }
}

async function finishAfter<P, M>(
  deps: ProcessOutboxBatchDeps<P, M>,
  permit: ProviderCallPermit,
  exit: PostProviderExit,
): Promise<ItemOutcome> {
  for (let attempt = 1; attempt <= deps.policy.terminalPersistenceAttempts; attempt += 1) {
    try {
      const result = await deps.store.finishAfterProvider(permit, exit);
      if (result.kind === "lost") {
        return outcome(permit, "persistence-unknown", "POST_PROVIDER_FENCE_LOST");
      }
      return outcome(permit, exit.kind, "code" in exit ? exit.code : undefined);
    } catch {
      if (attempt === deps.policy.terminalPersistenceAttempts) {
        return outcome(permit, "persistence-unknown", "POST_PROVIDER_PERSISTENCE_FAILED");
      }
    }
  }
  return outcome(permit, "persistence-unknown", "POST_PROVIDER_PERSISTENCE_FAILED");
}

function postProviderExit(providerResult: ProviderSendResult): PostProviderExit {
  if (providerResult.kind === "fatal") {
    throw new FatalProviderTransportError(providerResult.code);
  }
  if (providerResult.kind === "accepted") {
    const providerMessageId = providerResult.providerMessageId.trim();
    return providerMessageId
      ? { kind: "sent", providerMessageId }
      : { kind: "quarantined", code: "PROVIDER_MESSAGE_ID_MISSING" };
  }
  if (providerResult.kind === "definitely-rejected") {
    return { kind: "failed", code: providerResult.code };
  }
  return { kind: "quarantined", code: providerResult.code };
}

function capturedCommitUnknownExit(error: unknown): PostProviderExit | null {
  if (
    !(error instanceof Error)
    || error.name !== "GuardedDispatchCommitUnknownError"
    || !("exit" in error)
    || typeof error.exit !== "object"
    || error.exit === null
    || !("kind" in error.exit)
  ) {
    return null;
  }
  const exit = error.exit as Record<string, unknown>;
  if (
    exit.kind === "sent"
    && typeof exit.providerMessageId === "string"
    && exit.providerMessageId.trim().length > 0
    && exit.providerMessageId.length <= 512
  ) {
    return { kind: "sent", providerMessageId: exit.providerMessageId.trim() };
  }
  if (
    (exit.kind === "failed" || exit.kind === "quarantined")
    && typeof exit.code === "string"
    && validCode(exit.code)
  ) {
    return { kind: exit.kind, code: exit.code.trim() };
  }
  return null;
}

async function failStopWorker<P, M>(
  deps: ProcessOutboxBatchDeps<P, M>,
  error: FatalProviderTransportError,
): Promise<never> {
  try {
    deps.failStop?.latch(error);
  } catch {
    // A fail-stop observer cannot make the fatal transport state recoverable.
  }
  try {
    const provider = deps.provider as typeof deps.provider & {
      terminate?: (error: FatalProviderTransportError) => Promise<void>;
    };
    await provider.terminate?.(error);
  } catch {
    // Preserve the fatal transport error after best-effort transport teardown.
  }
  throw error;
}

export async function processOutboxBatch<P, M>(
  deps: ProcessOutboxBatchDeps<P, M>,
): Promise<ProcessOutboxBatchResult> {
  validateDependencies(deps);
  if (deps.failStop?.isLatched()) {
    return { claimed: 0, swept: 0, outcomes: [] };
  }
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

    let materialized: MaterializeResult<M>;
    try {
      materialized = await deps.materialize(next);
    } catch (error) {
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

    let boundary: BoundaryResult;
    try {
      boundary = await deps.store.beginProviderCall(next, {
        adapter: deps.provider.adapter,
        leaseMs: deps.policy.providerLeaseMs,
        prepared: materialized.message,
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

    const guardedStore = deps.store as typeof deps.store & {
      dispatchAfterProviderBoundary?: (
        permit: ProviderCallPermit,
        input: Readonly<{
          prepared: M;
          invoke(signal: AbortSignal): Promise<PostProviderExit>;
        }>,
      ) => Promise<
        | { readonly kind: "applied"; readonly exit: PostProviderExit }
        | { readonly kind: "lost" }
      >;
    };
    const guardedProvider = deps.provider as typeof deps.provider & {
      authorize?: (
        message: M,
        context: Readonly<{
          operationId: string;
          permit: ProviderCallPermit;
          messageId: string;
        }>,
      ) => Promise<unknown>;
      dispatch?: (
        message: M,
        authorization: unknown,
        context: Readonly<{
          operationId: string;
          permit: ProviderCallPermit;
          messageId: string;
          signal: AbortSignal;
        }>,
      ) => Promise<ProviderSendResult>;
    };

    if (
      guardedStore.dispatchAfterProviderBoundary
      && guardedProvider.authorize
      && guardedProvider.dispatch
    ) {
      let authorization: unknown;
      try {
        authorization = await guardedProvider.authorize(
          materialized.message,
          {
            operationId: next.operationId,
            permit: boundary.permit,
            messageId: outboxMessageId(next.operationId),
          },
        );
      } catch {
        const item = await finishAfter(
          deps,
          boundary.permit,
          { kind: "failed", code: "PROVIDER_AUTHORIZATION_FAILED" },
        );
        outcomes.push(item);
        emit(deps.onEvent, item);
        continue;
      }

      try {
        const guarded = await guardedStore.dispatchAfterProviderBoundary(
          boundary.permit,
          {
            prepared: materialized.message,
            invoke: async (signal) => {
              let providerResult: ProviderSendResult;
              try {
                providerResult = await guardedProvider.dispatch!(
                  materialized.message,
                  authorization,
                  {
                    operationId: next.operationId,
                    permit: boundary.permit,
                    messageId: outboxMessageId(next.operationId),
                    signal,
                  },
                );
              } catch {
                providerResult = {
                  kind: "ambiguous",
                  code: "PROVIDER_OUTCOME_AMBIGUOUS",
                };
              }
              return postProviderExit(providerResult);
            },
          },
        );
        const item = guarded.kind === "lost"
          ? outcome(boundary.permit, "claim-lost")
          : outcome(
            boundary.permit,
            guarded.exit.kind,
            "code" in guarded.exit ? guarded.exit.code : undefined,
          );
        outcomes.push(item);
        emit(deps.onEvent, item);
        continue;
      } catch (error) {
        if (error instanceof FatalProviderTransportError) {
          return await failStopWorker(deps, error);
        }
        const capturedExit = capturedCommitUnknownExit(error);
        if (capturedExit) {
          const item = await finishAfter(
            deps,
            boundary.permit,
            capturedExit,
          );
          outcomes.push(item);
          emit(deps.onEvent, item);
          continue;
        }
        const item = outcome(
          boundary.permit,
          "persistence-unknown",
          "POST_PROVIDER_PERSISTENCE_FAILED",
        );
        outcomes.push(item);
        emit(deps.onEvent, item);
        continue;
      }
    }

    let providerResult: ProviderSendResult;
    try {
      providerResult = await deps.provider.send(materialized.message, {
        operationId: next.operationId,
        permit: boundary.permit,
        messageId: outboxMessageId(next.operationId),
      });
    } catch {
      providerResult = {
        kind: "ambiguous",
        code: "PROVIDER_OUTCOME_AMBIGUOUS",
      };
    }

    const exit = postProviderExit(providerResult);
    const item = await finishAfter(deps, boundary.permit, exit);
    outcomes.push(item);
    emit(deps.onEvent, item);
  }

  return { claimed, swept, outcomes };
}
