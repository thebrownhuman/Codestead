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
  providerCallStartedAt: Date;
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
  | { readonly kind: "ambiguous"; readonly code: string };

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

export async function processOutboxBatch<P, M>(
  deps: ProcessOutboxBatchDeps<P, M>,
): Promise<ProcessOutboxBatchResult> {
  validateDependencies(deps);
  const swept = await deps.store.quarantineAbandoned({
    limit: deps.policy.batchSize,
  });
  const outcomes: ItemOutcome[] = [];
  let claimed = 0;

  for (let index = 0; index < deps.policy.batchSize; index += 1) {
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

    let providerResult: ProviderSendResult;
    try {
      providerResult = await deps.provider.send(materialized.message, {
        operationId: next.operationId,
        permit: boundary.permit,
      });
    } catch {
      providerResult = {
        kind: "ambiguous",
        code: "PROVIDER_OUTCOME_AMBIGUOUS",
      };
    }

    let exit: PostProviderExit;
    if (providerResult.kind === "accepted") {
      const providerMessageId = providerResult.providerMessageId.trim();
      exit = providerMessageId
        ? { kind: "sent", providerMessageId }
        : { kind: "quarantined", code: "PROVIDER_MESSAGE_ID_MISSING" };
    } else if (providerResult.kind === "definitely-rejected") {
      exit = { kind: "failed", code: providerResult.code };
    } else {
      exit = { kind: "quarantined", code: providerResult.code };
    }

    const item = await finishAfter(deps, boundary.permit, exit);
    outcomes.push(item);
    emit(deps.onEvent, item);
  }

  return { claimed, swept, outcomes };
}
