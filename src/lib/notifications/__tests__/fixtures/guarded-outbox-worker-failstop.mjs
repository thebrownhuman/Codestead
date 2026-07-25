const mode = process.argv[2];
if (!new Set([
  "discard-guard-false",
  "dispatch-sync-throw",
  "hostile-dispatch-result",
]).has(mode)) {
  throw new Error("invalid guarded worker fail-stop fixture mode");
}

const [{ processOutboxBatch }, materialization, transport, correlation] = await Promise.all([
  import("../../outbox-worker.ts"),
  import("../../prepared-dispatch-materialization.ts"),
  import("../../mailer-transport-internal.ts"),
  import("../../provider-correlation.ts"),
]);

const claim = Object.freeze({
  phase: "pre-provider",
  id: "11111111-1111-4111-8111-111111111111",
  operationId: "22222222-2222-4222-8222-222222222222",
  claimToken: "33333333-3333-4333-8333-333333333333",
  claimOwner: "fail-stop-fixture",
  claimVersion: 1,
  userId: "learner-fail-stop",
  deliveryScopeKey: "a:learner-fail-stop",
  payload: Object.freeze({ template: "invitation" }),
  attempt: 1,
  leaseExpiresAt: new Date(Date.now() + 120_000),
});
const runtimePlan = Object.freeze({
  timeouts: Object.freeze({
    oauthDeadlineMs: 20_000,
    guardedSendDeadlineMs: 20_000,
    providerAbortSettlementMs: 5_000,
  }),
});
const materialized = materialization.createMaterializedDispatch({
  source: {
    applicationUrl: "https://codestead.invalid",
    outboxId: claim.id,
    operationId: claim.operationId,
    claimToken: claim.claimToken,
    claimOwner: claim.claimOwner,
    claimVersion: claim.claimVersion,
    deliveryScopeKey: claim.deliveryScopeKey,
    recipient: "learner@integration.invalid",
    template: "invitation",
    templateVersion: "1",
    variables: {
      name: "Learner",
      url: "https://codestead.invalid/invitations/fail-stop",
    },
  },
  adapter: "console",
  from: "Codestead <mail@codestead.invalid>",
  messageId: correlation.outboxMessageId(claim.operationId),
  runtimePlan,
  transportConfiguration: transport.captureMailTransportConfiguration("console"),
});
const permit = Object.freeze({});
const receipt = Object.freeze({});
const guarded = Object.freeze({});
const armed = Object.freeze({});
let claimIssued = false;
let stopChecks = 0;

const store = {
  async claimNext() {
    if (claimIssued) return null;
    claimIssued = true;
    return claim;
  },
  async beginProviderCall() {
    return Object.freeze({ kind: "applied", permit, receipt });
  },
  async finishBeforeProvider() {
    process.stdout.write("FORBIDDEN_FINISH_BEFORE\n");
    return { kind: "lost" };
  },
  async finishAfterProvider() {
    process.stdout.write("FORBIDDEN_FINISH_AFTER\n");
    return { kind: "lost" };
  },
  async dispatchAfterProviderBoundary() {
    if (mode === "dispatch-sync-throw") {
      process.stdout.write("DISPATCH_INVOKED\n");
      throw new Error("synchronous failure after dispatch invocation");
    }
    if (mode === "hostile-dispatch-result") {
      process.stdout.write("DISPATCH_RETURNED\n");
      return new Proxy({}, {
        get(_target, property) {
          if (property === "then") return undefined;
          process.stdout.write("FORBIDDEN_PROPERTY_READ\n");
          throw new Error("hostile result property read");
        },
        getOwnPropertyDescriptor() {
          process.stdout.write("FORBIDDEN_REFLECTION\n");
          throw new Error("hostile result reflection");
        },
        isExtensible() {
          process.stdout.write("FORBIDDEN_REFLECTION\n");
          throw new Error("hostile result reflection");
        },
        ownKeys() {
          process.stdout.write("FORBIDDEN_REFLECTION\n");
          throw new Error("hostile result reflection");
        },
      });
    }
    throw new Error("dispatch must not run in discard mode");
  },
  releaseGuardedDispatchWatchdog() {
    process.stdout.write("FORBIDDEN_WATCHDOG_RELEASE\n");
    return false;
  },
  async finishGuardedDispatchUnknown() {
    process.stdout.write("FORBIDDEN_UNKNOWN_FINISH\n");
    return null;
  },
  async quarantineAbandoned() {
    return 0;
  },
};

process.stdout.write("ENTER\n");
await processOutboxBatch({
  store,
  materialize: async () => ({ kind: "ready", materialized }),
  adapter: "console",
  authorize: async () => guarded,
  discardReceipt: () => true,
  discardGuard: () => mode !== "discard-guard-false",
  watchdog: Object.freeze({
    arm: async () => armed,
    close: async () => undefined,
  }),
  claimOwner: "fail-stop-worker",
  newClaimToken: () => "44444444-4444-4444-8444-444444444444",
  shouldStop: () => {
    stopChecks += 1;
    return mode === "discard-guard-false" && stopChecks === 3;
  },
  clock: { now: () => new Date() },
  retryPolicy: {
    unexpectedMaterializeError: () => ({ kind: "failed", code: "FIXTURE" }),
  },
  policy: {
    batchSize: 1,
    materializeLeaseMs: 120_000,
    maxMaterializeAttempts: 2,
    maxRetryDelayMs: 120_000,
    terminalPersistenceAttempts: 2,
  },
});
process.stdout.write("RESUMED\n");


