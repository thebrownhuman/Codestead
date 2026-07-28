import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  authorizeCommittedPreparedDispatch,
  captureMailDispatchApplicationOrigin,
  discardCommittedPreparedDispatchReceipt,
  guardedDispatchResultSafeToDisarm,
  mailDispatchApplicationUrl,
  mailDispatchPreparedRuntimePlan,
  PostgresOutboxStore,
  releaseGuardedDispatchWatchdogClaim,
  type EmailOutboxPayload,
  type OutboxPgClient,
  type OutboxPgPool,
} from "../postgres-outbox-store";
import {
  inspectMailDispatchRuntime,
  type MailDispatchStartupPool,
} from "../mail-dispatch-runtime-startup";
import {
  createMaterializedDispatch,
  materializedDispatchEnvelope,
} from "../guarded-prepared-dispatch";
import {
  disarmMailDispatchHardWatchdog,
  startMailDispatchHardWatchdog,
} from "../mail-dispatch-hard-watchdog";
import { captureMailTransportConfiguration } from "../mailer-transport-internal";
import { LEGACY_RAW_PROVIDER_CORRELATION_VERSION, outboxMessageId } from "../provider-correlation";
import { MailDispatchDbDeadlineExceededError } from "../mail-dispatch-db-deadline";
import { ProviderBoundaryCommitUnknownError } from "../outbox-store-errors";
import { isProductionEmailTemplate } from "../template-authority-policy";
import type { GmailReconciliationFence } from "../gmail-reconciliation";
import type { OutboxClaim } from "../outbox-worker";

const ID = "11111111-1111-4111-8111-111111111111";
const OPERATION = "22222222-2222-4222-8222-222222222222";
const TOKEN = "33333333-3333-4333-8333-333333333333";
const RELEASE_RECEIPT_SHA256 = "a".repeat(64);
const SOURCE = "44444444-4444-4444-8444-444444444444";
const ACTIVATION_TOKEN = "A".repeat(43);
const providerDispatch = {
  adapter: "gmail",
  dispatchBindingVersion: "gmail-raw-v1",
  dispatchBindingSha256: "b".repeat(64),
  providerCorrelationVersion: "opaque-sha256-v1",
  providerEvidenceVersion: "gmail-header-evidence-v1",
  providerEvidenceSha256: "c".repeat(64),
} as const;
const providerRequestBody = JSON.stringify({ raw: "fixture" });
const providerRequestBodySha256 = createHash("sha256")
  .update(providerRequestBody)
  .digest("hex");
type Step = Readonly<{
  contains: string;
  rows?: Record<string, unknown>[] | ((values: readonly unknown[]) =>
    Record<string, unknown>[]);
  error?: Error;
  operation?: Promise<{ rows: Record<string, unknown>[] }>;
}>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function compact(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

class ScriptedClient extends EventEmitter implements OutboxPgClient {
  readonly calls: Array<{
    sql: string;
    values: unknown[];
    parametersSupplied: boolean;
  }> = [];
  released = false;
  destroyed = false;

  constructor(private readonly steps: Step[]) {
    super();
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) {
    const sql = compact(text);
    const normalizedSql = sql.toLowerCase();
    const queryValues = values ?? [];
    this.calls.push({ sql, values: queryValues, parametersSupplied: values !== undefined });
    const step = this.steps.shift();
    expect(step, `Unexpected SQL: ${sql}`).toBeDefined();
    expect(normalizedSql).toContain(step!.contains.toLowerCase());
    if (step!.error) throw step!.error;
    if (step!.operation) return await step!.operation as { rows: Row[] };
    const rows = typeof step!.rows === "function"
      ? step!.rows(queryValues)
      : (step!.rows ?? []);
    return { rows: rows as Row[] };
  }

  release(destroy = false) {
    this.released = true;
    this.destroyed ||= destroy;
    if (destroy) queueMicrotask(() => this.emit("end"));
  }
}

async function harness(steps: Step[]) {
  const startupClient = new ScriptedClient([
    { contains: "begin isolation level repeatable read read only" },
    {
      contains: "max_connections",
      rows: [{
        max_connections: "200",
        admin_reserved_connections: "3",
        server_version_num: "170000",
      }],
    },
    {
      contains: "with hold_column as",
      rows: [{
        hold_catalog_present: true,
        hold_catalog_exact: true,
        delivery_release_capability_exact: true,
      }],
    },
    { contains: "commit" },
  ]);
  const client = new ScriptedClient(steps);
  const connect = vi.fn(async () => client)
    .mockResolvedValueOnce(startupClient);
  const pool = {
    options: Object.freeze({
      max: 3,
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 30_000,
    }),
    connect,
  } satisfies OutboxPgPool & MailDispatchStartupPool;
  const inspection = await inspectMailDispatchRuntime(pool);
  expect(startupClient.calls).toHaveLength(4);
  expect(startupClient.released).toBe(true);
  expect(startupClient.destroyed).toBe(false);
  const origin = captureMailDispatchApplicationOrigin(inspection);
  const store = new PostgresOutboxStore(pool, inspection, origin);
  return {
    applicationUrl: mailDispatchApplicationUrl(origin),
    client,
    connect,
    inspection,
    pool,
    startupClient,
    store,
  };
}

function expectedTx1BootstrapSql(
  input: Awaited<ReturnType<typeof harness>>,
) {
  const timeouts = input.inspection.plan.timeouts;
  return compact(`
    begin;
    set local lock_timeout = '${timeouts.lockMs}ms';
    set local statement_timeout = '${timeouts.statementMs}ms';
    set local idle_in_transaction_session_timeout = '${timeouts.tx1Ms}ms';
    set local transaction_timeout = '${timeouts.tx1Ms}ms'
  `);
}

function genuineBoundaryInput(
  store: PostgresOutboxStore,
  activeClaim: OutboxClaim<EmailOutboxPayload>,
  applicationUrl: string,
  adapter: "console" | "gmail" = "gmail",
) {
  if (!isProductionEmailTemplate(activeClaim.payload.template)) {
    throw new Error("Expected a production email template.");
  }
  const materialized = createMaterializedDispatch({
    source: {
      applicationUrl,
      outboxId: activeClaim.id,
      operationId: activeClaim.operationId,
      claimToken: activeClaim.claimToken,
      claimOwner: activeClaim.claimOwner,
      claimVersion: activeClaim.claimVersion,
      deliveryScopeKey: activeClaim.deliveryScopeKey,
      recipient: activeClaim.payload.to,
      template: activeClaim.payload.template,
      templateVersion: activeClaim.payload.templateVersion,
      variables: activeClaim.payload.variables,
    },
    adapter,
    from: "Codestead <mail@codestead.test>",
    messageId: outboxMessageId(activeClaim.operationId),
    runtimePlan: mailDispatchPreparedRuntimePlan(store),
    transportConfiguration: captureMailTransportConfiguration(adapter),
  });
  const envelope = materializedDispatchEnvelope(materialized);
  if (!envelope) throw new Error("Expected a genuine prepared envelope.");
  return Object.freeze({ adapter, envelope });
}

function claimRow() {
  return {
    id: ID,
    user_id: "learner-1",
    delivery_scope_key: "a:learner-1",
    operation_id: OPERATION,
    claim_version: 4,
    to_email: "learner@example.test",
    template: "invitation",
    template_version: "1",
    variables: { name: "Learner" },
    claim_token: TOKEN,
    claim_owner: "worker-1",
    attempt_count: 2,
    lease_expires_at: new Date("2026-07-22T19:01:00.000Z"),
  };
}

function scopeRow(claimVersion = 4, attemptCount = 1) {
  return {
    id: ID,
    user_id: "learner-1",
    operation_id: OPERATION,
    delivery_scope_key: "a:learner-1",
    claim_version: claimVersion,
    attempt_count: attemptCount,
  };
}
function systemScopeRow() {
  return {
    ...scopeRow(),
    user_id: null,
    delivery_scope_key: `s:${OPERATION}`,
  };
}

function boundaryRow(values?: readonly unknown[]) {
  return {
    provider_call_started: "2026-07-22 19:00:05.123456+00",
    lease_expires_at: new Date("2026-07-22T19:01:05.000Z"),
    dispatch_binding_version: values?.[18]
      ?? providerDispatch.dispatchBindingVersion,
    dispatch_binding_sha256: values?.[19]
      ?? providerDispatch.dispatchBindingSha256,
    provider_correlation_version: values?.[20]
      ?? providerDispatch.providerCorrelationVersion,
    provider_request_body_sha256: values?.[23] ?? providerRequestBodySha256,
    provider_request_body_length: values?.[24]
      ?? Buffer.byteLength(providerRequestBody, "utf8"),
    release_receipt_sha256: "a".repeat(64),
    provider_evidence_version: values === undefined
      ? providerDispatch.providerEvidenceVersion
      : values[21],
    provider_evidence_sha256: values === undefined
      ? providerDispatch.providerEvidenceSha256
      : values[22],
  };
}

function permitFenceRow(
  values: readonly unknown[],
  claimVersion = claim.claimVersion,
) {
  return {
    ...scopeRow(claimVersion),
    provider_call_started: values[6],
    lease_expires_at: values[11],
    dispatch_binding_version: values[9],
    dispatch_binding_sha256: values[10],
    provider_correlation_version: values[12],
    provider_evidence_version: values[13],
    provider_evidence_sha256: values[14],
    provider_request_body_sha256: values[15],
    provider_request_body_length: values[16],
    release_receipt_sha256: values[17],
  };
}
type CapturedBoundaryAuthority = Readonly<{
  adapter: "console" | "gmail";
  bindingVersion: string;
  bindingSha256: string;
  correlationVersion: string;
  evidenceVersion: string | null;
  evidenceSha256: string | null;
  requestBodySha256: string;
  requestBodyLength: number;
  releaseReceiptSha256: string;
  providerCallStartedAt: string;
  leaseExpiresAt: string;
}>;

function capturedBoundaryAuthority(values: readonly unknown[]) {
  const adapter = values[5];
  if (adapter !== "console" && adapter !== "gmail") {
    throw new Error("Expected a supported adapter.");
  }
  const row = boundaryRow(values);
  return Object.freeze({
    adapter,
    bindingVersion: String(values[18]),
    bindingSha256: String(values[19]),
    correlationVersion: String(values[20]),
    evidenceVersion: values[21] === null ? null : String(values[21]),
    evidenceSha256: values[22] === null ? null : String(values[22]),
    requestBodySha256: String(values[23]),
    requestBodyLength: Number(values[24]),
    releaseReceiptSha256: String(row.release_receipt_sha256),
    providerCallStartedAt: String(row.provider_call_started),
    leaseExpiresAt: String(row.lease_expires_at),
  });
}
function committedPermitSteps(
  captured?: { authority?: CapturedBoundaryAuthority },
): Step[] {
  return [
    { contains: "begin" },
    { contains: "pg_advisory_xact_lock" },
    {
      contains: "select id::text, user_id, operation_id::text, delivery_scope_key",
      rows: [scopeRow()],
    },
    { contains: "select case", rows: [{ decision: "allowed" }] },
    { contains: "select case", rows: [{ decision: "allowed" }] },
    {
      contains: "update public.email_outbox",
      rows: (values) => {
        if (captured) captured.authority = capturedBoundaryAuthority(values);
        return [boundaryRow(values)];
      },
    },
    { contains: "commit" },
  ];
}

async function finalizerHarness(steps: Step[]) {
  const input = await harness([...committedPermitSteps(), ...steps]);
  const boundary = await input.store.beginProviderCall(
    claim,
    genuineBoundaryInput(input.store, claim, input.applicationUrl),
  );
  if (boundary.kind !== "applied") {
    throw new Error("Expected a genuine committed provider permit.");
  }
  expect(Reflect.ownKeys(boundary.permit)).toEqual([]);
  expect(discardCommittedPreparedDispatchReceipt(
    input.store,
    boundary.permit,
    boundary.receipt,
  )).toBe(true);
  return { ...input, permit: boundary.permit };
}
function guardedLiveRow(authority: CapturedBoundaryAuthority) {
  return {
    id: claim.id,
    user_id: claim.userId,
    operation_id: claim.operationId,
    delivery_scope_key: claim.deliveryScopeKey,
    claim_version: claim.claimVersion,
    to_email: claim.payload.to,
    template: claim.payload.template,
    template_version: claim.payload.templateVersion,
    variables: claim.payload.variables,
    claim_token: claim.claimToken,
    claim_owner: claim.claimOwner,
    attempt_count: claim.attempt,
    lease_expires_at: authority.leaseExpiresAt,
    adapter: authority.adapter,
    provider_call_started: authority.providerCallStartedAt,
    transaction_id: "42",
    dispatch_binding_version: authority.bindingVersion,
    dispatch_binding_sha256: authority.bindingSha256,
    provider_correlation_version: authority.correlationVersion,
    provider_evidence_version: authority.evidenceVersion,
    provider_evidence_sha256: authority.evidenceSha256,
    provider_request_body_sha256: authority.requestBodySha256,
    provider_request_body_length: authority.requestBodyLength,
    release_receipt_sha256: authority.releaseReceiptSha256,
  };
}

function uncertainTx2Steps(
  captured: { authority?: CapturedBoundaryAuthority; providerMessageId?: string },
): Step[] {
  const authority = () => {
    if (!captured.authority) throw new Error("Expected captured TX1 authority.");
    return captured.authority;
  };
  return [
    { contains: "begin" },
    { contains: "set local lock_timeout" },
    { contains: "set local statement_timeout" },
    { contains: "set local idle_in_transaction_session_timeout = '0'" },
    { contains: "set local transaction_timeout = '0'" },
    { contains: "pg_advisory_xact_lock" },
    {
      contains: "pg_catalog.pg_current_xact_id()",
      rows: () => [guardedLiveRow(authority())],
    },
    { contains: "select case", rows: [{ decision: "allowed" }] },
    {
      contains: "select 1 from public.email_outbox",
      rows: [{ authorized: 1 }],
    },
    { contains: "set local transaction_timeout = '60000ms'" },
    {
      contains: "set local idle_in_transaction_session_timeout = '60000ms'",
    },
    {
      contains: "update public.email_outbox",
      rows: (values) => {
        captured.providerMessageId = String(values[15]);
        throw new Error("Injected terminal persistence uncertainty.");
      },
    },
    {
      contains: "select pg_catalog.pg_xact_status",
      rows: [{ transaction_status: "aborted" }],
    },
    { contains: "begin" },
    { contains: "set local lock_timeout" },
    { contains: "pg_advisory_xact_lock" },
    { contains: "commit" },
  ];
}

type SentRecoveryMode =
  | "already-applied"
  | "still-started"
  | "successor"
  | "conflict";

function sentRecoveryFenceRow(
  authority: CapturedBoundaryAuthority,
  mode: SentRecoveryMode,
) {
  return {
    ...scopeRow(mode === "successor" ? claim.claimVersion + 1 : claim.claimVersion),
    provider_call_started: authority.providerCallStartedAt,
    lease_expires_at: mode === "still-started" ? authority.leaseExpiresAt : null,
    dispatch_binding_version: authority.bindingVersion,
    dispatch_binding_sha256: authority.bindingSha256,
    provider_correlation_version: authority.correlationVersion,
    provider_evidence_version: authority.evidenceVersion,
    provider_evidence_sha256: authority.evidenceSha256,
    provider_request_body_sha256: authority.requestBodySha256,
    provider_request_body_length: authority.requestBodyLength,
    release_receipt_sha256: authority.releaseReceiptSha256,
  };
}

function recoveredSentRow(
  authority: CapturedBoundaryAuthority,
  providerMessageId: string,
) {
  return {
    status: "sent",
    claim_version: claim.claimVersion,
    adapter: authority.adapter,
    provider_message_id: providerMessageId,
    provider_call_started: authority.providerCallStartedAt,
    sent_at: "2026-07-22 19:00:06.123456+00",
    quarantined_at: null,
    last_error_code: null,
  };
}

function sentRecoverySteps(
  captured: { authority?: CapturedBoundaryAuthority; providerMessageId?: string },
  mode: SentRecoveryMode,
): Step[] {
  const authority = () => {
    if (!captured.authority) throw new Error("Expected captured TX1 authority.");
    return captured.authority;
  };
  const providerMessageId = () => {
    if (!captured.providerMessageId) throw new Error("Expected provider message ID.");
    return captured.providerMessageId;
  };
  const prefix: Step[] = [
    { contains: "begin" },
    { contains: "pg_advisory_xact_lock" },
    {
      contains: "select id::text, user_id, operation_id::text, delivery_scope_key",
      rows: () => mode === "conflict"
        ? []
        : [sentRecoveryFenceRow(authority(), mode)],
    },
  ];
  if (mode === "conflict") return [...prefix, { contains: "commit" }];
  if (mode === "still-started") {
    return [
      ...prefix,
      {
        contains: "set provider_message_id = $7::text",
        rows: () => [recoveredSentRow(authority(), providerMessageId())],
      },
      { contains: "commit" },
    ];
  }
  if (mode === "successor") {
    return [
      ...prefix,
      { contains: "set provider_message_id = $7::text", rows: [] },
      {
        contains: "set status = case when $8::text = 'sent'",
        rows: () => [{
          ...recoveredSentRow(authority(), providerMessageId()),
          status: "quarantined",
          claim_version: claim.claimVersion + 1,
          quarantined_at: "2026-07-22 19:00:06.000000+00",
          last_error_code: "ABANDONED_POST_PROVIDER_BOUNDARY",
        }],
      },
      { contains: "commit" },
    ];
  }
  return [
    ...prefix,
    { contains: "set provider_message_id = $7::text", rows: [] },
    {
      contains: "set status = case when $8::text = 'sent'",
      rows: [],
    },
    {
      contains: "select status::text",
      rows: () => [recoveredSentRow(authority(), providerMessageId())],
    },
    { contains: "commit" },
  ];
}

type ConsoleWriteCallback = (error?: Error | null) => void;

function immediateConsoleWrite() {
  function implementation(
    chunk: string | Uint8Array,
    callback?: ConsoleWriteCallback,
  ): boolean;
  function implementation(
    chunk: string | Uint8Array,
    encoding?: BufferEncoding,
    callback?: ConsoleWriteCallback,
  ): boolean;
  function implementation(
    _chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ConsoleWriteCallback,
    callback?: ConsoleWriteCallback,
  ) {
    const writeCallback = typeof encodingOrCallback === "function"
      ? encodingOrCallback
      : callback;
    writeCallback?.();
    return true;
  }
  return vi.spyOn(process.stdout, "write").mockImplementation(implementation);
}

type SentRecoveryStepBuilder = (
  captured: {
    authority?: CapturedBoundaryAuthority;
    providerMessageId?: string;
  },
) => Step[];

async function sentPersistenceUnknownHarness(
  recoverySteps: SentRecoveryStepBuilder,
) {
  const captured: {
    authority?: CapturedBoundaryAuthority;
    providerMessageId?: string;
  } = {};
  const input = await harness([
    ...committedPermitSteps(captured),
    ...uncertainTx2Steps(captured),
    ...recoverySteps(captured),
  ]);
  const boundary = await input.store.beginProviderCall(
    claim,
    genuineBoundaryInput(input.store, claim, input.applicationUrl, "console"),
  );
  if (boundary.kind !== "applied" || !captured.authority) {
    throw new Error("Expected genuine committed console authority.");
  }
  const guarded = await authorizeCommittedPreparedDispatch(
    input.store,
    boundary.receipt,
  );
  const write = immediateConsoleWrite();
  const controller = await startMailDispatchHardWatchdog();
  const armed = await controller.arm();
  const result = await input.store.dispatchAfterProviderBoundary(
    boundary.permit,
    guarded,
    armed,
  );
  if (result.kind !== "persistence-unknown") {
    throw new Error("Expected genuine guarded persistence uncertainty.");
  }
  expect(guardedDispatchResultSafeToDisarm(input.store, armed, result)).toBe(true);
  await disarmMailDispatchHardWatchdog(armed);
  expect(releaseGuardedDispatchWatchdogClaim(input.store, armed)).toBe(true);
  await controller.close();
  return {
    ...input,
    uncertainty: result.uncertainty,
    write,
    providerMessageId: captured.providerMessageId,
  };
}

async function recoverSentUnknown(mode: SentRecoveryMode) {
  const input = await sentPersistenceUnknownHarness(
    (captured) => sentRecoverySteps(captured, mode),
  );
  const recovered = await input.store.finishGuardedDispatchUnknown(
    input.uncertainty,
  );
  return { ...input, recovered };
}

const claim: OutboxClaim<EmailOutboxPayload> = {
  phase: "pre-provider",
  id: ID,
  operationId: OPERATION,
  claimToken: TOKEN,
  claimOwner: "worker-1",
  claimVersion: 4,
  userId: "learner-1",
  deliveryScopeKey: "a:learner-1",
  attempt: 2,
  leaseExpiresAt: new Date("2026-07-22T19:01:00.000Z"),
  payload: {
    userId: "learner-1",
    to: "learner@example.test",
    template: "invitation",
    templateVersion: "1",
    variables: { name: "Learner" },
  },
};

const deletionClaim: OutboxClaim<EmailOutboxPayload> = {
  ...claim,
  payload: {
    userId: "learner-1",
    to: "learner@example.test",
    template: "account-deleted",
    templateVersion: "1",
    variables: {
      backupRetentionUntil: "2027-07-12T00:00:00.000Z",
      tombstoneId: "44444444-4444-4444-8444-444444444444",
      deletionRunId: "55555555-5555-4555-8555-555555555555",
    },
  },
};

const malformedDeletionClaim: OutboxClaim<EmailOutboxPayload> = {
  ...deletionClaim,
  payload: {
    ...deletionClaim.payload,
    variables: { tombstoneId: "44444444-4444-4444-8444-444444444444" },
  },
};

const extraKeyDeletionClaim: OutboxClaim<EmailOutboxPayload> = {
  ...deletionClaim,
  payload: {
    ...deletionClaim.payload,
    variables: {
      ...deletionClaim.payload.variables,
      unexpected: "must-not-be-accepted",
    },
  },
};

const reconciliationFence: GmailReconciliationFence = {
  id: ID,
  operationId: OPERATION,
  claimVersion: 4,
  userId: "learner-1",
  deliveryScopeKey: "a:learner-1",
  claimToken: null,
  claimOwner: null,
  leaseExpiresAt: null,
  adapter: "gmail",
  providerCallStartedAt: "2026-07-22 19:00:05+00",
  quarantinedAt: "2026-07-22 19:01:05+00",
  dispatchBindingVersion: null,
  dispatchBindingSha256: null,
  providerCorrelationVersion: LEGACY_RAW_PROVIDER_CORRELATION_VERSION,
  providerRequestBodySha256: null,
  providerRequestBodyLength: null,
  releaseReceiptSha256: RELEASE_RECEIPT_SHA256,
  providerEvidenceVersion: null,
  providerEvidenceSha256: null,
  lastErrorCode: "PROVIDER_OUTCOME_AMBIGUOUS",
};

const boundReconciliationFence: GmailReconciliationFence = {
  ...reconciliationFence,
  dispatchBindingVersion: "gmail-raw-v1",
  dispatchBindingSha256: "b".repeat(64),
};

describe("PostgresOutboxStore", () => {
  beforeEach(() => {
    process.env.DELETION_TOMBSTONE_KEY = "deletion-test-secret-that-is-at-least-32-bytes";
    vi.stubEnv("APP_URL", "http://localhost:3000");
    vi.stubEnv("GMAIL_CLIENT_ID", "fixture-client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "fixture-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "fixture-refresh");
    vi.stubEnv("MAIL_FROM", "Codestead <mail@codestead.test>");
  });

  afterEach(() => {
    delete process.env.DELETION_TOMBSTONE_KEY;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("claims with an account lock and full generation fence", async () => {
    const input = await harness([
      { contains: "begin" },
      {
        contains: "select id::text, user_id, operation_id::text, delivery_scope_key",
        rows: [scopeRow(3)],
      },
      { contains: "pg_try_advisory_xact_lock", rows: [{ locked: true }] },
      { contains: "update public.email_outbox", rows: [claimRow()] },
      { contains: "commit" },
    ]);

    await expect(input.store.claimNext({
      owner: "worker-1",
      token: TOKEN,
      leaseMs: 30_000,
    })).resolves.toEqual(claim);

    const candidateSql = input.client.calls[1]!.sql;
    expect(candidateSql).not.toContain("for update");
    expect(candidateSql).toContain("provider_call_started is null");
    expect(candidateSql).toContain("lease_expires_at < pg_catalog.statement_timestamp()");
    expect(candidateSql).toContain("not exists");
    expect(candidateSql).toContain("active.delivery_scope_key = candidate.delivery_scope_key");
    expect(candidateSql).toContain("active.provider_call_started is not null");
    expect(candidateSql).toContain("candidate.attempt_count");
    expect(candidateSql).not.toContain("candidate.claim_version < 2147483647");
    const claimSql = input.client.calls[3]!.sql;
    expect(claimSql).toContain("claim_version = claim_version + 1");
    expect(claimSql).toContain("claim_version < 2147483646");
    expect(claimSql).toContain("attempt_count < 2147483647");
    expect(claimSql).toContain("claim_token = $4::uuid");
    expect(claimSql).toContain("user_id is not distinct from $7::text");
    expect(claimSql).toContain("active.delivery_scope_key = $8::text");
    expect(input.client.released).toBe(true);
  });

  it("retires an exhausted claim generation and continues to another eligible scope", async () => {
    const exhausted = {
      id: "55555555-5555-4555-8555-555555555555",
      user_id: "learner-exhausted",
      operation_id: "66666666-6666-4666-8666-666666666666",
      delivery_scope_key: "a:learner-exhausted",
      claim_version: 2_147_483_646,
      attempt_count: 8,
    };
    const input = await harness([
      { contains: "begin" },
      {
        contains: "select id::text, user_id, operation_id::text, delivery_scope_key",
        rows: [exhausted, scopeRow(3, 1)],
      },
      { contains: "pg_try_advisory_xact_lock", rows: [{ locked: true }] },
      { contains: "update public.email_outbox", rows: [{ id: exhausted.id }] },
      { contains: "pg_try_advisory_xact_lock", rows: [{ locked: true }] },
      { contains: "update public.email_outbox", rows: [claimRow()] },
      { contains: "commit" },
    ]);

    await expect(input.store.claimNext({
      owner: "worker-1",
      token: TOKEN,
      leaseMs: 30_000,
    })).resolves.toEqual(claim);

    const updates = input.client.calls.filter(({ sql }) =>
      sql.startsWith("update public.email_outbox")
    );
    expect(updates).toHaveLength(2);
    const retirementSql = updates[0]!.sql;
    expect(retirementSql).toContain("status = 'failed'");
    expect(retirementSql).toContain("claim_token = null");
    expect(retirementSql).toContain("claim_owner = null");
    expect(retirementSql).toContain("lease_expires_at = null");
    expect(retirementSql).toContain(
      "claim_version = case when claim_version < 2147483647 then claim_version + 1 else 2147483647 end",
    );
    expect(retirementSql).toContain(
      "last_error_code = 'DELIVERY_COUNTER_EXHAUSTED'",
    );
    expect(retirementSql).toContain("attempt_count = $4::integer");
    expect(updates[0]!.values[2]).toBe(2_147_483_646);
    expect(updates[0]!.values[3]).toBe(8);

    const retirementSet = retirementSql.split(" where ")[0]!;
    expect(retirementSet).not.toContain("attempt_count = attempt_count + 1");
    expect(retirementSet).not.toContain("provider_call_started =");
    expect(retirementSet).not.toContain("adapter =");
    expect(retirementSet).not.toContain("provider_message_id =");
    expect(retirementSet).not.toContain("next_attempt_at =");
    expect(retirementSet).not.toContain("quarantined_at =");

    const claimSql = updates[1]!.sql;
    expect(claimSql).toContain("claim_version < 2147483646");
    expect(claimSql).toContain("attempt_count < 2147483647");
  });

  it("retires the maximum claim generation without incrementing past int4", async () => {
    const input = await harness([
      { contains: "begin" },
      {
        contains: "select id::text, user_id, operation_id::text, delivery_scope_key",
        rows: [scopeRow(2_147_483_647, 3)],
      },
      { contains: "pg_try_advisory_xact_lock", rows: [{ locked: true }] },
      { contains: "update public.email_outbox", rows: [{ id: ID }] },
      {
        contains: "select id::text, user_id, operation_id::text, delivery_scope_key",
        rows: [],
      },
      { contains: "commit" },
    ]);

    await expect(input.store.claimNext({
      owner: "worker-1",
      token: TOKEN,
      leaseMs: 30_000,
    })).resolves.toBeNull();

    const retirement = input.client.calls[3]!;
    expect(retirement.sql).toContain(
      "claim_version = case when claim_version < 2147483647 then claim_version + 1 else 2147483647 end",
    );
    expect(retirement.sql).toContain(
      "last_error_code = 'DELIVERY_COUNTER_EXHAUSTED'",
    );
    expect(retirement.values[2]).toBe(2_147_483_647);
    expect(retirement.values[3]).toBe(3);
  });

  it("retires a maximum-attempt row without changing its attempt count", async () => {
    const input = await harness([
      { contains: "begin" },
      {
        contains: "select id::text, user_id, operation_id::text, delivery_scope_key",
        rows: [scopeRow(12, 2_147_483_647)],
      },
      { contains: "pg_try_advisory_xact_lock", rows: [{ locked: true }] },
      { contains: "update public.email_outbox", rows: [{ id: ID }] },
      {
        contains: "select id::text, user_id, operation_id::text, delivery_scope_key",
        rows: [],
      },
      { contains: "commit" },
    ]);

    await expect(input.store.claimNext({
      owner: "worker-1",
      token: TOKEN,
      leaseMs: 30_000,
    })).resolves.toBeNull();

    const retirement = input.client.calls[3]!;
    expect(retirement.sql).toContain(
      "last_error_code = 'DELIVERY_COUNTER_EXHAUSTED'",
    );
    expect(retirement.sql).toContain("attempt_count = $4::integer");
    expect(retirement.values[3]).toBe(2_147_483_647);
    expect(retirement.sql.split(" where ")[0]).not.toContain(
      "attempt_count = attempt_count + 1",
    );
  });

  it("reselects after retiring a full exhausted candidate page", async () => {
    const exhausted = Array.from({ length: 16 }, (_, index) => {
      const serial = String(index + 1).padStart(12, "0");
      const userId = `learner-exhausted-${index + 1}`;
      return {
        id: `70000000-0000-4000-8000-${serial}`,
        user_id: userId,
        operation_id: `80000000-0000-4000-8000-${serial}`,
        delivery_scope_key: `a:${userId}`,
        claim_version: 2_147_483_646,
        attempt_count: 1,
      };
    });
    const retirements: Step[] = exhausted.flatMap((candidate) => [
      { contains: "pg_try_advisory_xact_lock", rows: [{ locked: true }] },
      {
        contains: "update public.email_outbox",
        rows: [{ id: candidate.id }],
      },
    ]);
    const input = await harness([
      { contains: "begin" },
      {
        contains: "select id::text, user_id, operation_id::text, delivery_scope_key",
        rows: exhausted,
      },
      ...retirements,
      {
        contains: "select id::text, user_id, operation_id::text, delivery_scope_key",
        rows: [scopeRow(3, 1)],
      },
      { contains: "pg_try_advisory_xact_lock", rows: [{ locked: true }] },
      { contains: "update public.email_outbox", rows: [claimRow()] },
      { contains: "commit" },
    ]);

    await expect(input.store.claimNext({
      owner: "worker-1",
      token: TOKEN,
      leaseMs: 30_000,
    })).resolves.toEqual(claim);

    const candidateReads = input.client.calls.filter(({ sql }) =>
      sql.includes("pg_catalog.row_number() over")
    );
    expect(candidateReads).toHaveLength(2);
    expect(input.client.calls.filter(({ sql }) =>
      sql.startsWith("update public.email_outbox")
    )).toHaveLength(17);
  });

  it("fences a normal pre-provider retry below both counter limits", async () => {
    const retryAt = new Date("2026-07-22T19:05:00.000Z");
    const input = await harness([
      { contains: "begin" },
      { contains: "pg_advisory_xact_lock" },
      {
        contains: "select id::text, user_id, operation_id::text, delivery_scope_key",
        rows: [scopeRow(claim.claimVersion, claim.attempt)],
      },
      {
        contains: "update public.email_outbox",
        rows: [{
          status: "pending",
          claim_version: claim.claimVersion + 1,
          last_error_code: "MATERIALIZATION_RETRY",
        }],
      },
      { contains: "commit" },
    ]);

    await expect(input.store.finishBeforeProvider(claim, {
      kind: "retry",
      code: "MATERIALIZATION_RETRY",
      retryAt,
    })).resolves.toEqual({ kind: "applied" });

    const update = input.client.calls[3]!;
    expect(update.sql).toContain("claim_version <= 2147483644");
    expect(update.sql).toContain("attempt_count <= 2147483646");
    expect(update.sql).toContain("attempt_count = $11::integer");
    expect(update.sql).toContain(
      "returning status::text, claim_version, last_error_code",
    );
    expect(update.values[10]).toBe(claim.attempt);
  });

  it.each([
    ["last retry generation", 2_147_483_645, 2, 2_147_483_646],
    ["maximum attempt", 4, 2_147_483_647, 5],
  ] as const)(
    "retires a pre-provider retry at the %s",
    async (_case, claimVersion, attempt, expectedVersion) => {
      const exhaustedClaim: OutboxClaim<EmailOutboxPayload> = {
        ...claim,
        claimVersion,
        attempt,
      };
      const input = await harness([
        { contains: "begin" },
        { contains: "pg_advisory_xact_lock" },
        {
          contains: "select id::text, user_id, operation_id::text, delivery_scope_key",
          rows: [scopeRow(claimVersion, attempt)],
        },
        {
          contains: "update public.email_outbox",
          rows: [{
            status: "failed",
            claim_version: expectedVersion,
            last_error_code: "DELIVERY_COUNTER_EXHAUSTED",
          }],
        },
        { contains: "commit" },
      ]);

      await expect(input.store.finishBeforeProvider(exhaustedClaim, {
        kind: "retry",
        code: "MATERIALIZATION_RETRY",
        retryAt: new Date("2026-07-22T19:05:00.000Z"),
      })).resolves.toEqual({ kind: "applied" });

      const update = input.client.calls[3]!;
      expect(update.sql).toContain("status = 'failed'");
      expect(update.sql).toContain(
        "last_error_code = 'DELIVERY_COUNTER_EXHAUSTED'",
      );
      expect(update.sql).toContain(
        "claim_version = case when claim_version < 2147483647 then claim_version + 1 else 2147483647 end",
      );
      expect(update.sql).toContain("attempt_count = $6::integer");
      const retirementSet = update.sql.split(" where ")[0]!;
      expect(retirementSet).not.toContain("next_attempt_at =");
      expect(retirementSet).not.toContain("attempt_count =");
      expect(update.values[5]).toBe(attempt);
    },
  );

  it("rejects an inconsistent pre-provider retirement result", async () => {
    const exhaustedClaim: OutboxClaim<EmailOutboxPayload> = {
      ...claim,
      claimVersion: 2_147_483_645,
    };
    const input = await harness([
      { contains: "begin" },
      { contains: "pg_advisory_xact_lock" },
      {
        contains: "select id::text, user_id, operation_id::text, delivery_scope_key",
        rows: [scopeRow(exhaustedClaim.claimVersion, exhaustedClaim.attempt)],
      },
      {
        contains: "update public.email_outbox",
        rows: [{
          status: "pending",
          claim_version: exhaustedClaim.claimVersion + 1,
          last_error_code: "MATERIALIZATION_RETRY",
        }],
      },
      { contains: "rollback" },
    ]);

    await expect(input.store.finishBeforeProvider(exhaustedClaim, {
      kind: "retry",
      code: "MATERIALIZATION_RETRY",
      retryAt: new Date("2026-07-22T19:05:00.000Z"),
    })).rejects.toThrow(
      "Pre-provider outbox transition returned an inconsistent fence.",
    );
  });

  it("cannot redirect operations away from the inspected pool", async () => {
    const input = await harness([
      { contains: "begin" },
      {
        contains: "select id::text, user_id, operation_id::text, delivery_scope_key",
        rows: [scopeRow(3)],
      },
      { contains: "pg_try_advisory_xact_lock", rows: [{ locked: true }] },
      { contains: "update public.email_outbox", rows: [claimRow()] },
      { contains: "commit" },
    ]);
    const redirectedConnect = vi.fn(async () => {
      throw new Error("Redirected pool must never be observed.");
    });
    Object.defineProperty(input.store, "pool", {
      configurable: true,
      value: { connect: redirectedConnect },
    });

    await expect(input.store.claimNext({
      owner: "worker-1",
      token: TOKEN,
      leaseMs: 30_000,
    })).resolves.toEqual(claim);
    expect(redirectedConnect).not.toHaveBeenCalled();
    expect(input.connect).toHaveBeenCalledTimes(2);
  });
  it("returns no claim when a competing CAS wins", async () => {
    const input = await harness([
      { contains: "begin" },
      {
        contains: "select id::text, user_id, operation_id::text, delivery_scope_key",
        rows: [scopeRow(3)],
      },
      { contains: "pg_try_advisory_xact_lock", rows: [{ locked: true }] },
      { contains: "update public.email_outbox", rows: [] },
      { contains: "commit" },
    ]);

    await expect(input.store.claimNext({
      owner: "worker-1",
      token: TOKEN,
      leaseMs: 30_000,
    })).resolves.toBeNull();
  });

  it("returns a provider permit only from the freshly applied boundary", async () => {
    const input = await harness([
      { contains: "begin" },
      { contains: "pg_advisory_xact_lock" },
      { contains: "select id::text, user_id, operation_id::text, delivery_scope_key", rows: [scopeRow()] },
      { contains: "select case", rows: [{ decision: "allowed" }] },
      { contains: "select case", rows: [{ decision: "allowed" }] },
      {
        contains: "update public.email_outbox",
        rows: (values) => [boundaryRow(values)],
      },
      { contains: "commit" },
    ]);

    const boundary = await input.store.beginProviderCall(
      claim,
      genuineBoundaryInput(input.store, claim, input.applicationUrl),
    );
    expect(boundary.kind).toBe("applied");
    if (boundary.kind !== "applied") throw new Error("Expected applied TX1 boundary.");
    expect(Object.isFrozen(boundary.permit)).toBe(true);
    expect(Reflect.ownKeys(boundary.permit)).toEqual([]);

    const boundaryUpdate = input.client.calls[5]!;
    const providerLease = input.inspection.plan.providerLease;
    expect(providerLease.providerLeaseStampMs).not.toBe(
      providerLease.postCommitProviderLeaseMs,
    );
    expect(boundaryUpdate.values[6]).toBe(providerLease.providerLeaseStampMs);
    const sql = boundaryUpdate.sql;
    expect(sql).toContain("claim_token = $3::uuid");
    expect(sql).toContain("claim_owner = $4::text");
    expect(sql).toContain("claim_version = $5::integer");
    expect(sql).toContain(
      "lease_expires_at = pg_catalog.statement_timestamp() + ($7::integer * interval '1 millisecond')",
    );
    expect(sql).toContain("provider_call_started is null");
    expect(sql).toContain("lease_expires_at > pg_catalog.statement_timestamp()");
    expect(sql).toContain("dispatch_binding_version = $19::text");
    expect(sql).toContain("provider_correlation_version = $21::text");
    const exactDispatchTuple = input.client.calls[5]!.values.slice(-7);
    expect(exactDispatchTuple[0]).toBe("gmail-raw-v1");
    expect(exactDispatchTuple[1]).toMatch(/^[a-f0-9]{64}$/u);
    expect(exactDispatchTuple[2]).toBe("opaque-sha256-v1");
    expect(exactDispatchTuple[3]).toBe("gmail-header-evidence-v1");
    expect(exactDispatchTuple[4]).toMatch(/^[a-f0-9]{64}$/u);
    expect(exactDispatchTuple[5]).toMatch(/^[a-f0-9]{64}$/u);
    expect(exactDispatchTuple[6]).toEqual(expect.any(Number));
    expect(Number(exactDispatchTuple[6])).toBeGreaterThan(0);
    const boundarySql = input.client.calls[3]!.sql;
    const lockedBoundarySql = input.client.calls[4]!.sql;
    expect(lockedBoundarySql).toContain("for share of account_user");
    expect(lockedBoundarySql).toContain("for share of source_invitation, source_request");
    expect(lockedBoundarySql).toContain("for share of source_request, admin_recipient");
    expect(boundarySql).toContain("outbox.to_email = lower(btrim($8::text))");
    expect(boundarySql).toContain("outbox.template = $9::text");
    expect(boundarySql).toContain("outbox.template_version = $10::text");
    expect(boundarySql).toContain("outbox.variables = $11::jsonb");
    expect(input.client.calls[3]!.values.slice(6, 11)).toEqual([
      "learner-1",
      "learner@example.test",
      "invitation",
      "1",
      JSON.stringify({ name: "Learner" }),
    ]);
    expect(input.client.calls[3]!.values.slice(11)).toEqual([null, null, false, null, null]);
    expect(input.client.calls[4]!.values).toEqual(input.client.calls[3]!.values);
    expect(sql).toContain("outbox.to_email = lower(btrim($10::text))");
    expect(sql).toContain("template = $11::text");
    expect(sql).toContain("template_version = $12::text");
    expect(sql).toContain("variables = $13::jsonb");
    expect(sql).toContain("source_invitation.token_hash = $17::text");
    expect(sql).toContain("outbox.variables ->> 'url' = $18::text");
    expect(input.client.calls[4]!.values.slice(13)).toEqual([false, null, null]);
  });

  it.each([
    [
      "canonical",
      `https://learn.example.test/activate?token=${ACTIVATION_TOKEN}`,
      createHash("sha256").update(ACTIVATION_TOKEN).digest("hex"),
    ],
    [
      "cross-origin",
      `https://attacker.example/activate?token=${ACTIVATION_TOKEN}`,
      null,
    ],
  ])("derives %s approved-invitation evidence without shifting deletion evidence", async (
    _case,
    url,
    expectedTokenHash,
  ) => {
    vi.stubEnv("APP_URL", "https://learn.example.test");
    const approvedClaim: OutboxClaim<EmailOutboxPayload> = {
      ...claim,
      userId: null,
      deliveryScopeKey: `s:${OPERATION}`,
      payload: {
        userId: null,
        to: "learner@example.test",
        template: "invitation",
        templateVersion: "1",
        variables: {
          name: "Learner",
          url,
          _mailOperationId: OPERATION,
          _mailRecipient: "learner@example.test",
          _mailProducer: "access-request-approved",
          _mailSourceId: SOURCE,
        },
      },
    };
    const input = await harness([
      { contains: "begin" },
      { contains: "pg_advisory_xact_lock" },
      {
        contains: "select id::text, user_id, operation_id::text, delivery_scope_key",
        rows: [systemScopeRow()],
      },
      { contains: "select case", rows: [{ decision: "SYSTEM_EMAIL_AUTHORITY_INVALID" }] },
      { contains: "update public.email_outbox", rows: [{ id: ID }] },
      { contains: "commit" },
    ]);

    await expect(input.store.beginProviderCall(
      approvedClaim,
      genuineBoundaryInput(input.store, approvedClaim, input.applicationUrl),
    )).resolves.toEqual({
      kind: "suppressed",
      code: "SYSTEM_EMAIL_AUTHORITY_INVALID",
    });

    const decision = input.client.calls[3]!;
    const suppression = input.client.calls[4]!;
    for (const call of [decision, suppression]) {
      const normalizedSql = call.sql.replace(/\s+/g, " ");
      for (const template of [
        "invitation",
        "access-request-admin",
        "access-rejected",
      ]) {
        expect(normalizedSql).toContain(
          `( outbox.template = '${template}' `
          + "and (outbox.template_version = '1') )",
        );
      }
    }
    expect(decision.sql).toContain("_mailOperationId");
    expect(decision.sql).toContain("_mailSourceId");
    expect(decision.sql).toContain("source_invitation.token_hash = $15::text");
    expect(suppression.sql).toContain("source_invitation.token_hash = $16::text");
    expect(decision.values.slice(11, 14)).toEqual([null, null, false]);
    expect(suppression.values.slice(12, 15)).toEqual([null, null, false]);
    expect(decision.values[14]).toBe(expectedTokenHash);
    expect(suppression.values[15]).toBe(expectedTokenHash);
  });

  it("revalidates canonical admin authority under row locks and in the provider CAS", async () => {
    vi.stubEnv("APP_URL", "https://learn.example.test");
    const adminClaim: OutboxClaim<EmailOutboxPayload> = {
      ...claim,
      userId: null,
      deliveryScopeKey: `s:${OPERATION}`,
      payload: {
        userId: null,
        to: "admin@example.test",
        template: "access-request-admin",
        templateVersion: "1",
        variables: {
          name: "Administrator",
          url: "https://learn.example.test/admin/access",
          _mailOperationId: OPERATION,
          _mailRecipient: "admin@example.test",
          _mailProducer: "access-request-admin",
          _mailSourceId: SOURCE,
        },
      },
    };
    const input = await harness([
      { contains: "begin" },
      { contains: "pg_advisory_xact_lock" },
      {
        contains: "select id::text, user_id, operation_id::text, delivery_scope_key",
        rows: [systemScopeRow()],
      },
      { contains: "select case", rows: [{ decision: "allowed" }] },
      { contains: "select case", rows: [{ decision: "allowed" }] },
      {
        contains: "update public.email_outbox",
        rows: (values) => [boundaryRow(values)],
      },
      { contains: "commit" },
    ]);

    const boundaryResult = await input.store.beginProviderCall(
      adminClaim,
      genuineBoundaryInput(input.store, adminClaim, input.applicationUrl),
    );
    expect(boundaryResult.kind).toBe("applied");
    if (boundaryResult.kind !== "applied") throw new Error("Expected applied TX1 boundary.");
    expect(Reflect.ownKeys(boundaryResult.permit)).toEqual([]);

    const decision = input.client.calls[3]!;
    const lockedDecision = input.client.calls[4]!;
    const boundary = input.client.calls[5]!;
    for (const call of [decision, lockedDecision, boundary]) {
      expect(call.sql).toContain("_mailOperationId");
      expect(call.sql).toContain("_mailRecipient");
      expect(call.sql).toContain(
        "public.backup_status_mail_authorized(outbox.id)",
      );
      expect(call.sql).toMatch(
        /outbox\.variables ->> '_mailAudienceId'\s*=\s*admin_recipient\.id::text/u,
      );
      expect(call.sql).toMatch(
        /outbox\.variables ->> '_mailAudienceId'\s*=\s*source_request\.id::text/u,
      );
      expect(call.sql).toContain("idempotency_authority_version");
      expect(call.sql).toContain("idempotency_authority_sha256");
      expect(call.sql).toContain("idempotency_original_payload_sha256");
      expect(call.sql).toContain("mail_delivery_release_receipt");
      expect(call.sql).not.toContain("'admin:' || admin_recipient.id::text");
      expect(call.sql).not.toContain("'requester:' || source_request.id::text");
      expect(call.sql).toContain("_mailProducer");
      expect(call.sql).toContain("_mailSourceId");
      expect(call.sql).toContain("source_request.adult_confirmed_at is not null");
      expect(call.sql).toContain("source_request.decided_by is null");
      expect(call.sql).toContain("admin_recipient.banned = false");
      expect(call.sql).toContain("variables ->> 'name' = 'Administrator'");
    }
    expect(lockedDecision.sql).toContain("for share of source_request, admin_recipient");
    expect(decision.sql).toContain("outbox.variables ->> 'url' = $16::text");
    expect(boundary.sql).toContain("returning outbox.provider_call_started::text as provider_call_started");
    expect(boundary.sql).toContain("outbox.variables ->> 'url' = $18::text");
    expect(decision.values.slice(11)).toEqual([
      null,
      null,
      false,
      null,
      "https://learn.example.test/admin/access",
    ]);
    expect(boundary.values.slice(13, 18)).toEqual([
      null,
      null,
      false,
      null,
      "https://learn.example.test/admin/access",
    ]);
  });

  it("repeats the exact immutable deletion capability inside the provider-boundary CAS", async () => {
    const input = await harness([
      { contains: "begin" },
      { contains: "pg_advisory_xact_lock" },
      { contains: "select id::text, user_id, operation_id::text, delivery_scope_key", rows: [scopeRow()] },
      { contains: "select case", rows: [{ decision: "allowed" }] },
      { contains: "select case", rows: [{ decision: "allowed" }] },
      {
        contains: "update public.email_outbox",
        rows: (values) => [boundaryRow(values)],
      },
      { contains: "commit" },
    ]);

    const boundaryResult = await input.store.beginProviderCall(
      deletionClaim,
      genuineBoundaryInput(input.store, deletionClaim, input.applicationUrl),
    );
    expect(boundaryResult.kind).toBe("applied");
    if (boundaryResult.kind !== "applied") throw new Error("Expected applied TX1 boundary.");
    expect(Reflect.ownKeys(boundaryResult.permit)).toEqual([]);

    const decision = input.client.calls[3]!;
    const lockedDecision = input.client.calls[4]!;
    const boundary = input.client.calls[5]!;
    for (const call of [decision, lockedDecision, boundary]) {
      expect(call.sql.replace(/\s+/g, " ")).toContain(
        "( outbox.template = 'account-deleted' "
        + "and (outbox.template_version = '1') )",
      );
      expect(call.sql).toContain("from public.account_deletion_tombstone tombstone");
      expect(call.sql).toContain("join public.data_lifecycle_run lifecycle");
      expect(call.sql).toContain("join public.\"user\" deleted_user");
      expect(call.sql).toContain("deleted_user.status = 'deleted'");
      expect(call.sql).toContain("tombstone.primary_deletion_completed_at is not null");
      expect(call.sql).toContain("lifecycle.status = 'succeeded'");
      expect(call.sql).toContain("lifecycle.operation = 'account_deletion'");
      expect(call.sql).toContain("#>> '{deletionNotice,outboxId}'");
      expect(call.sql).toContain("#>> '{deletionNotice,operationId}'");
      expect(call.sql).toContain("#>> '{deletionNotice,recipientHmacSha256}'");
      expect(call.sql).toContain("#>> '{deletionNotice,payloadSha256}'");
    }
    expect(decision.sql).toContain("outbox.to_email = lower(btrim($8::text))");
    expect(boundary.sql).toContain("outbox.to_email = lower(btrim($10::text))");
    expect(boundary.sql).toContain("$16::boolean");
    expect(decision.values[11]).toMatch(/^[0-9a-f]{64}$/);
    expect(decision.values[12]).toMatch(/^[0-9a-f]{64}$/);
    expect(decision.values[13]).toBe(true);
    expect(decision.values.slice(14)).toEqual([null, null]);
    expect(lockedDecision.values).toEqual(decision.values);
    expect(boundary.values[13]).toBe(decision.values[11]);
    expect(boundary.values[14]).toBe(decision.values[12]);
    expect(boundary.values[15]).toBe(true);
    expect(boundary.values.slice(16, 18)).toEqual([null, null]);
  });

  it.each([
    ["missing required keys", malformedDeletionClaim],
    ["containing an extra key", extraKeyDeletionClaim],
  ] as const)(
    "suppresses deletion variables %s without throwing and rechecks invalidity atomically",
    async (_case, invalidClaim) => {
    const input = await harness([
      { contains: "begin" },
      { contains: "pg_advisory_xact_lock" },
      { contains: "select id::text, user_id, operation_id::text, delivery_scope_key", rows: [scopeRow()] },
      {
        contains: "select case",
        rows: [{ decision: "DELETION_NOTICE_CAPABILITY_INVALID" }],
      },
      { contains: "update public.email_outbox", rows: [{ id: ID }] },
      { contains: "commit" },
    ]);

    await expect(input.store.beginProviderCall(
      invalidClaim,
      genuineBoundaryInput(input.store, invalidClaim, input.applicationUrl),
    )).resolves.toEqual({
      kind: "suppressed",
      code: "DELETION_NOTICE_CAPABILITY_INVALID",
    });

    const decision = input.client.calls[3]!;
    const suppression = input.client.calls[4]!;
    expect(decision.values[11]).toBeNull();
    expect(decision.values[12]).toBeNull();
    expect(decision.values[13]).toBe(false);
    expect(suppression.sql).toContain("not (");
    expect(suppression.sql).toContain("from public.account_deletion_tombstone tombstone");
    expect(suppression.sql).toContain("#>> '{deletionNotice,payloadSha256}'");
    expect(suppression.sql).toContain("lease_expires_at > pg_catalog.statement_timestamp()");
    expect(suppression.values[12]).toBeNull();
    expect(suppression.values[13]).toBeNull();
    expect(suppression.values[14]).toBe(false);
    },
  );

  it("reports a durable provider-boundary suppression with its authority code", async () => {
    const input = await harness([
      { contains: "begin" },
      { contains: "pg_advisory_xact_lock" },
      { contains: "select id::text, user_id, operation_id::text, delivery_scope_key", rows: [scopeRow()] },
      {
        contains: "select case",
        rows: [{ decision: "ACCOUNT_NOT_ACTIVE_AT_PROVIDER_BOUNDARY" }],
      },
      { contains: "update public.email_outbox", rows: [{ id: ID }] },
      { contains: "commit" },
    ]);

    await expect(input.store.beginProviderCall(
      claim,
      genuineBoundaryInput(input.store, claim, input.applicationUrl),
    )).resolves.toEqual({
      kind: "suppressed",
      code: "ACCOUNT_NOT_ACTIVE_AT_PROVIDER_BOUNDARY",
    });
    const suppressionSql = input.client.calls[4]!.sql;
    expect(suppressionSql).toContain("outbox.to_email = lower(btrim($9::text))");
    expect(suppressionSql).toContain("template = $10::text");
    expect(suppressionSql).toContain("template_version = $11::text");
    expect(suppressionSql).toContain("variables = $12::jsonb");
    expect(input.client.calls[4]!.values[11]).toBe(JSON.stringify(claim.payload.variables));
  });

  it("removes exam-result from every account boundary allowlist and suppresses it", async () => {
    const examClaim: OutboxClaim<EmailOutboxPayload> = {
      ...claim,
      payload: {
        userId: "learner-1",
        to: "learner@example.test",
        template: "exam-result",
        templateVersion: "1",
        variables: {},
      },
    };
    const input = await harness([]);
    const connectsAfterStartup = input.connect.mock.calls.length;
    expect(() =>
      genuineBoundaryInput(input.store, examClaim, input.applicationUrl)
    ).toThrow("Expected a production email template.");
    expect(input.connect).toHaveBeenCalledTimes(connectsAfterStartup);
  });

  it("does not reconstruct a permit after an unknown boundary commit", async () => {
    const input = await harness([
      { contains: "begin" },
      { contains: "pg_advisory_xact_lock" },
      { contains: "select id::text, user_id, operation_id::text, delivery_scope_key", rows: [scopeRow()] },
      { contains: "select case", rows: [{ decision: "allowed" }] },
      { contains: "select case", rows: [{ decision: "allowed" }] },
      {
        contains: "update public.email_outbox",
        rows: (values) => [boundaryRow(values)],
      },
      { contains: "commit", error: new Error("commit acknowledgement lost") },
      { contains: "rollback" },
    ]);

    await expect(input.store.beginProviderCall(
      claim,
      genuineBoundaryInput(input.store, claim, input.applicationUrl),
    )).rejects.toThrow("Provider boundary commit result is unknown.");
    expect(input.client.calls.filter(({ sql }) => sql.includes("update public.email_outbox")))
      .toHaveLength(1);
  });

    it("rejects sent recovery when the exact permit fence conflicts", async () => {
    const input = await recoverSentUnknown("conflict");
    expect(input.recovered).toEqual({
      result: { kind: "lost" },
      exit: {
        kind: "sent",
        providerMessageId: input.providerMessageId,
      },
    });
    expect(input.write).toHaveBeenCalledOnce();
  });

    it("accepts an exact already-persisted sent recovery", async () => {
    const input = await recoverSentUnknown("already-applied");
    expect(input.recovered).toEqual({
      result: { kind: "already-applied" },
      exit: {
        kind: "sent",
        providerMessageId: input.providerMessageId,
      },
    });
    expect(input.write).toHaveBeenCalledOnce();
  });

  it("atomically releases and advances the fence for provider ambiguity", async () => {
    const input = await finalizerHarness([
      { contains: "begin" },
      { contains: "pg_advisory_xact_lock" },
      { contains: "select id::text, user_id, operation_id::text, delivery_scope_key", rows: (values) => [permitFenceRow(values)] },
      {
        contains: "update public.email_outbox",
        rows: [{
          status: "quarantined",
          claim_version: 5,
          adapter: "gmail",
          provider_message_id: null,
          provider_call_started: "2026-07-22 19:00:05.123456+00",
          sent_at: null,
          quarantined_at: new Date("2026-07-22T19:00:06.000Z"),
          last_error_code: "PROVIDER_OUTCOME_AMBIGUOUS",
        }],
      },
      { contains: "commit" },
    ]);

    await expect(input.store.finishAfterProvider(input.permit, {
      kind: "quarantined",
      code: "PROVIDER_OUTCOME_AMBIGUOUS",
    })).resolves.toEqual({ kind: "applied" });

    const sql = input.client.calls[10]!.sql;
    expect(sql).toContain(
      "claim_version = case when $7::text = 'quarantined' then claim_version + 1 else claim_version end",
    );
    expect(sql).toContain("claim_token = null");
    expect(sql).toContain("claim_owner = null");
    expect(sql).toContain("lease_expires_at = null");
    expect(sql).toContain("updated_at = pg_catalog.statement_timestamp()");
    expect(sql).toContain("claim_token = $3::uuid");
    expect(sql).toContain("claim_owner = $4::text");
    expect(sql).toContain("claim_version = $5::integer");
  });
  it("rejects a quarantined transition that did not return the exact next generation", async () => {
    const input = await finalizerHarness([
      { contains: "begin" },
      { contains: "pg_advisory_xact_lock" },
      { contains: "select id::text, user_id, operation_id::text, delivery_scope_key", rows: (values) => [permitFenceRow(values)] },
      {
        contains: "update public.email_outbox",
        rows: [{
          status: "quarantined",
          claim_version: 4,
          adapter: "gmail",
          provider_message_id: null,
          provider_call_started: "2026-07-22 19:00:05.123456+00",
          sent_at: null,
          quarantined_at: new Date("2026-07-22T19:00:06.000Z"),
          last_error_code: "PROVIDER_OUTCOME_AMBIGUOUS",
        }],
      },
      { contains: "commit" },
    ]);

    await expect(input.store.finishAfterProvider(input.permit, {
      kind: "quarantined",
      code: "PROVIDER_OUTCOME_AMBIGUOUS",
    })).resolves.toEqual({ kind: "lost" });
  });
    it("finalizes a captured sent receipt against the exact released successor fence", async () => {
    const input = await recoverSentUnknown("successor");
    expect(input.recovered).toEqual({
      result: { kind: "applied" },
      exit: {
        kind: "sent",
        providerMessageId: input.providerMessageId,
      },
    });
    expect(input.write).toHaveBeenCalledOnce();
  });

    it("accepts an exact reconciled sent receipt at the released successor generation", async () => {
    const input = await recoverSentUnknown("already-applied");
    expect(input.recovered).toEqual({
      result: { kind: "already-applied" },
      exit: {
        kind: "sent",
        providerMessageId: input.providerMessageId,
      },
    });
    expect(input.write).toHaveBeenCalledOnce();
  });

    it("rejects a conflicting reconciled provider identity at the successor generation", async () => {
    const input = await recoverSentUnknown("conflict");
    expect(input.recovered).toEqual({
      result: { kind: "lost" },
      exit: {
        kind: "sent",
        providerMessageId: input.providerMessageId,
      },
    });
    expect(input.write).toHaveBeenCalledOnce();
  });

  it("safely records a definite rejection against the exact released successor fence", async () => {
    const input = await finalizerHarness([
      { contains: "begin" },
      { contains: "pg_advisory_xact_lock" },
      {
        contains: "select id::text, user_id, operation_id::text, delivery_scope_key",
        rows: (values) => [permitFenceRow(values, 5)],
      },
      { contains: "update public.email_outbox", rows: [] },
      {
        contains: "last_error_code = 'ABANDONED_POST_PROVIDER_BOUNDARY'",
        rows: [{
          status: "failed",
          claim_version: 5,
          adapter: "gmail",
          provider_message_id: null,
          provider_call_started: "2026-07-22 19:00:05.123456+00",
          sent_at: null,
          quarantined_at: null,
          last_error_code: "PROVIDER_DEFINITELY_REJECTED",
        }],
      },
      { contains: "commit" },
    ]);

    await expect(input.store.finishAfterProvider(input.permit, {
      kind: "failed",
      code: "PROVIDER_DEFINITELY_REJECTED",
    })).resolves.toEqual({ kind: "applied" });

    const successorSql = input.client.calls[11]!.sql;
    expect(successorSql).toContain("else 'failed'::public.notification_status");
    expect(successorSql).toContain("quarantined_at = case when $8::text = 'sent' then quarantined_at else null end");
    expect(successorSql).toContain("last_error_code = case when $8::text = 'sent' then last_error_code else $10::text end");
  });
    it("rejects a conflicting already-persisted provider identity", async () => {
    const input = await recoverSentUnknown("conflict");
    expect(input.recovered).toEqual({
      result: { kind: "lost" },
      exit: {
        kind: "sent",
        providerMessageId: input.providerMessageId,
      },
    });
    expect(input.write).toHaveBeenCalledOnce();
  });

  it("reports an exact terminal Gmail result as already applied on unknown-commit replay", async () => {
    const input = await harness([
      { contains: "begin" },
      {
        contains: "operation_id = $1::uuid",
        rows: [{
          id: ID,
          user_id: "learner-1",
          operation_id: OPERATION,
          delivery_scope_key: "a:learner-1",
          claim_version: 4,
          claim_token: null,
          claim_owner: null,
          lease_expires_at: null,
          adapter: "gmail",
          provider_call_started: "2026-07-22 19:00:05+00",
          dispatch_binding_version: null,
          dispatch_binding_sha256: null,
          provider_correlation_version: "legacy-raw-v0",
          provider_evidence_version: null,
          provider_evidence_sha256: null,
          provider_request_body_sha256: null,
          provider_request_body_length: null,
          release_receipt_sha256: RELEASE_RECEIPT_SHA256,
          status: "sent",
          provider_message_id: "gmail-1",
          sent_at: "2026-07-22 19:02:00+00",
          quarantined_at: null,
          last_error_code: null,
        }],
      },
      { contains: "commit" },
    ]);

    await expect(input.store.findGmailReconciliationFence({
      operationId: OPERATION,
    })).resolves.toEqual({ kind: "already-applied" });
    expect(input.client.calls[1]!.values).toEqual([OPERATION]);
    expect(input.client.calls[1]!.sql)
      .toContain("lease_expires_at is null ) ) and (");
  });

  it("observes only an unresolved quarantined Gmail row as an exact reconciliation fence", async () => {
    const input = await harness([
      { contains: "begin" },
      {
        contains: "status = 'quarantined'",
        rows: [{
          id: ID,
          user_id: "learner-1",
          operation_id: OPERATION,
          delivery_scope_key: "a:learner-1",
          claim_version: 4,
          claim_token: null,
          claim_owner: null,
          lease_expires_at: null,
          adapter: "gmail",
          provider_call_started: "2026-07-22 19:00:05+00",
          dispatch_binding_version: null,
          dispatch_binding_sha256: null,
          provider_correlation_version: "legacy-raw-v0",
          provider_evidence_version: null,
          provider_evidence_sha256: null,
          provider_request_body_sha256: null,
          provider_request_body_length: null,
          release_receipt_sha256: RELEASE_RECEIPT_SHA256,
          status: "quarantined",
          provider_message_id: null,
          sent_at: null,
          quarantined_at: "2026-07-22 19:01:05+00",
          last_error_code: "PROVIDER_OUTCOME_AMBIGUOUS",
        }],
      },
      { contains: "commit" },
    ]);

    await expect(input.store.findGmailReconciliationFence({
      operationId: OPERATION,
    })).resolves.toEqual({ kind: "ready", fence: reconciliationFence });

    const sql = input.client.calls[1]!.sql;
    expect(sql).toContain("adapter = 'gmail'");
    expect(sql).toContain("provider_call_started is not null");
    expect(sql).toContain("provider_message_id is null");
    expect(sql).toContain("sent_at is null");
    expect(sql).toContain("dispatch_binding_version");
    expect(sql).toContain("dispatch_binding_sha256");
    expect(sql).toContain("provider_correlation_version");
    expect(sql).toContain("provider_evidence_version");
    expect(sql).toContain("provider_request_body_sha256");
    expect(sql).toContain("provider_request_body_length");
    expect(sql).toContain("release_receipt_sha256");
    expect(sql).toContain("provider_evidence_sha256");
  });

  it.each([
    null,
    "future-unreviewed-v2",
  ])("rejects persisted correlation version %j before returning a Gmail fence", async (
    providerCorrelationVersion,
  ) => {
    const input = await harness([
      { contains: "begin" },
      {
        contains: "status = 'quarantined'",
        rows: [{
          id: ID,
          user_id: "learner-1",
          operation_id: OPERATION,
          delivery_scope_key: "a:learner-1",
          claim_version: 4,
          claim_token: null,
          claim_owner: null,
          lease_expires_at: null,
          adapter: "gmail",
          provider_call_started: "2026-07-22 19:00:05+00",
          dispatch_binding_version: null,
          dispatch_binding_sha256: null,
          provider_correlation_version: providerCorrelationVersion,
          provider_evidence_version: null,
          provider_evidence_sha256: null,
          provider_request_body_sha256: null,
          provider_request_body_length: null,
          release_receipt_sha256: RELEASE_RECEIPT_SHA256,
          status: "quarantined",
          provider_message_id: null,
          sent_at: null,
          quarantined_at: "2026-07-22 19:01:05+00",
          last_error_code: "PROVIDER_OUTCOME_AMBIGUOUS",
        }],
      },
      { contains: "commit" },
    ]);

    await expect(input.store.findGmailReconciliationFence({
      operationId: OPERATION,
    })).resolves.toEqual({ kind: "not-reconcilable" });
  });

  it("finalizes a Gmail match only under the exact fence and delivery-scope lock", async () => {
    const input = await harness([
      { contains: "begin" },
      { contains: "pg_advisory_xact_lock" },
      { contains: "status = 'quarantined'", rows: [scopeRow()] },
      {
        contains: "update public.email_outbox",
        rows: [{
          status: "sent",
          claim_version: 4,
          adapter: "gmail",
          provider_message_id: "gmail-1",
          provider_call_started: "2026-07-22 19:00:05.123456+00",
          dispatch_binding_version: "gmail-raw-v1",
          dispatch_binding_sha256: "b".repeat(64),
          provider_correlation_version: "legacy-raw-v0",
          provider_evidence_version: null,
          provider_evidence_sha256: null,
          sent_at: new Date("2026-07-22T19:02:00.000Z"),
          provider_request_body_sha256: null,
          provider_request_body_length: null,
          release_receipt_sha256: RELEASE_RECEIPT_SHA256,
          quarantined_at: null,
          last_error_code: null,
        }],
      },
      { contains: "commit" },
    ]);

    await expect(input.store.finalizeGmailReconciliation({
      fence: boundReconciliationFence,
      providerMessageId: "gmail-1",
      proof: {
        kind: "raw-sha256-v1",
        adapterPayloadSha256: "b".repeat(64),
      },
    })).resolves.toEqual({ kind: "applied" });

    const update = input.client.calls[3]!;
    expect(update.sql).toContain("claim_token is not distinct from $7::uuid");
    expect(update.sql).toContain("provider_call_started = $10::timestamptz");
    expect(update.sql).toContain("quarantined_at = $11::timestamptz");
    expect(update.sql).toContain("last_error_code = $12::text");
    expect(update.sql).toContain("status = 'quarantined'");
    expect(update.sql).toContain("dispatch_binding_version is not distinct from");
    expect(update.sql).toContain("dispatch_binding_sha256 is not distinct from");
    expect(update.sql).toContain("provider_correlation_version =");
    expect(update.sql).toContain("provider_evidence_version is not distinct from");
    expect(update.sql).toContain("provider_evidence_sha256 is not distinct from");
    expect(update.values).toContain("a:learner-1");
    expect(update.sql).toContain("provider_request_body_sha256 is not distinct from");
    expect(update.sql).toContain("provider_request_body_length is not distinct from");
    expect(update.sql).toContain("mail_delivery_release_receipt_sha256");
    expect(update.values.slice(17, 21)).toEqual([
      null,
      null,
      RELEASE_RECEIPT_SHA256,
      "gmail-1",
    ]);
    expect(update.values).toContain("gmail-1");
  });

  it("rolls back when Gmail reconciliation returns an inconsistent terminal row", async () => {
    const input = await harness([
      { contains: "begin" },
      { contains: "pg_advisory_xact_lock" },
      { contains: "status = 'quarantined'", rows: [scopeRow()] },
      {
        contains: "update public.email_outbox",
        rows: [{
          status: "sent",
          claim_version: 4,
          adapter: "gmail",
          provider_message_id: "gmail-conflicting",
          provider_call_started: "2026-07-22 19:00:05.123456+00",
          dispatch_binding_version: "gmail-raw-v1",
          dispatch_binding_sha256: "b".repeat(64),
          provider_correlation_version: "legacy-raw-v0",
          provider_evidence_version: null,
          provider_evidence_sha256: null,
          sent_at: new Date("2026-07-22T19:02:00.000Z"),
          provider_request_body_sha256: null,
          provider_request_body_length: null,
          release_receipt_sha256: RELEASE_RECEIPT_SHA256,
          quarantined_at: null,
          last_error_code: null,
        }],
      },
      { contains: "rollback" },
    ]);

    await expect(input.store.finalizeGmailReconciliation({
      fence: boundReconciliationFence,
      providerMessageId: "gmail-1",
      proof: {
        kind: "raw-sha256-v1",
        adapterPayloadSha256: "b".repeat(64),
      },
    })).rejects.toThrow(
      "Gmail reconciliation finalization returned an inconsistent terminal row.",
    );

    expect(input.client.calls.at(-1)?.sql).toBe("rollback");
    expect(input.client.calls.some(({ sql }) => sql === "commit")).toBe(false);
  });

  it("quarantines only expired post-boundary rows with the exact observed fence", async () => {
    const lease = new Date("2026-07-22T18:58:00.000Z");
    const input = await harness([
      { contains: "begin" },
      {
        contains: "provider_call_started is not null",
        rows: [{
          id: ID,
          user_id: "learner-1",
          delivery_scope_key: "a:learner-1",
          operation_id: OPERATION,
          claim_version: 4,
          claim_token: TOKEN,
          claim_owner: "worker-1",
          lease_expires_at: lease,
        }],
      },
      { contains: "pg_try_advisory_xact_lock", rows: [{ locked: true }] },
      { contains: "update public.email_outbox", rows: [{ operation_id: OPERATION, claim_version: 5, claim_token: null, claim_owner: null, lease_expires_at: null }] },
      { contains: "commit" },
    ]);

    await expect(input.store.quarantineAbandoned({ limit: 10 })).resolves.toBe(1);
    const sql = input.client.calls[3]!.sql;
    expect(sql).toContain("claim_token = $3::uuid");
    expect(sql).toContain("claim_owner = $4::text");
    expect(sql).toContain("claim_version = $5::integer");
    expect(input.client.calls[1]!.sql).toContain("lease_expires_at::text as lease_expires_at");
    expect(sql).toContain("lease_expires_at = $7::timestamptz");
    expect(sql).toContain("claim_token = null");
    expect(sql).toContain("claim_owner = null");
    expect(sql).toContain("lease_expires_at = null");
    expect(sql).toContain("claim_version = claim_version + 1");
    expect(sql).toContain("updated_at = pg_catalog.statement_timestamp()");
    expect(sql).toContain(
      "returning operation_id::text, claim_version, claim_token::text, claim_owner, lease_expires_at",
    );
    expect(sql).not.toContain("status = 'pending'");
  });

  it("aborts an abandoned-row transition whose returned released fence is inconsistent", async () => {
    const lease = new Date("2026-07-22T18:58:00.000Z");
    const input = await harness([
      { contains: "begin" },
      {
        contains: "provider_call_started is not null",
        rows: [{
          id: ID,
          user_id: "learner-1",
          delivery_scope_key: "a:learner-1",
          operation_id: OPERATION,
          claim_version: 4,
          claim_token: TOKEN,
          claim_owner: "worker-1",
          lease_expires_at: lease,
        }],
      },
      { contains: "pg_try_advisory_xact_lock", rows: [{ locked: true }] },
      {
        contains: "update public.email_outbox",
        rows: [{
          operation_id: OPERATION,
          claim_version: 4,
          claim_token: TOKEN,
          claim_owner: "worker-1",
          lease_expires_at: lease,
        }],
      },
      { contains: "rollback" },
    ]);

    await expect(input.store.quarantineAbandoned({ limit: 10 }))
      .rejects.toThrow("Abandoned outbox fence did not release at the next generation.");
  });

  it("arms every TX1 server bound in the first parameterless database round trip", async () => {
    const input = await harness([
      { contains: "begin" },
      {
        contains: "select id::text, user_id, operation_id::text, delivery_scope_key",
        rows: [],
      },
      { contains: "commit" },
    ]);

    await expect(input.store.claimNext({
      owner: "worker-1",
      token: TOKEN,
      leaseMs: 30_000,
    })).resolves.toBeNull();

    expect(input.client.calls[0]).toEqual({
      sql: expectedTx1BootstrapSql(input),
      values: [],
      parametersSupplied: false,
    });
    expect(input.client.calls[1]!.sql).toContain(
      "select id::text, user_id, operation_id::text, delivery_scope_key",
    );
  });

  it("destroys a client whose atomic TX1 bootstrap fails", async () => {
    const input = await harness([
      { contains: "begin", error: new Error("TX1 bootstrap failed") },
    ]);

    await expect(input.store.claimNext({
      owner: "worker-1",
      token: TOKEN,
      leaseMs: 30_000,
    })).rejects.toThrow("TX1 bootstrap failed");

    expect(input.client.calls).toHaveLength(1);
    expect(input.client.calls[0]).toEqual({
      sql: expectedTx1BootstrapSql(input),
      values: [],
      parametersSupplied: false,
    });
    expect(input.client.released).toBe(true);
    expect(input.client.destroyed).toBe(true);
  });

  it("destroys a client when the atomic TX1 bootstrap misses its deadline", async () => {
    vi.useFakeTimers();
    const bootstrap = deferred<{ rows: Record<string, unknown>[] }>();
    const input = await harness([
      { contains: "begin", operation: bootstrap.promise },
    ]);
    const pending = input.store.claimNext({
      owner: "worker-1",
      token: TOKEN,
      leaseMs: 30_000,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(input.inspection.plan.timeouts.tx1Ms);
    const observed = await Promise.race([
      pending,
      Promise.resolve(Symbol("bootstrap-remained-pending")),
    ]);

    expect(observed).toBeInstanceOf(MailDispatchDbDeadlineExceededError);
    expect(input.client.calls).toHaveLength(1);
    expect(input.client.calls[0]).toEqual({
      sql: expectedTx1BootstrapSql(input),
      values: [],
      parametersSupplied: false,
    });
    expect(input.client.released).toBe(true);
    expect(input.client.destroyed).toBe(true);

    bootstrap.resolve({ rows: [] });
    await vi.runAllTimersAsync();
  });

  it("bounds a hung transaction pool checkout and destroys a late client", async () => {
    vi.useFakeTimers();
    const input = await harness([]);
    const connection = deferred<ScriptedClient>();
    input.connect.mockImplementationOnce(() => connection.promise);
    const pending = input.store.claimNext({
      owner: "worker-1",
      token: TOKEN,
      leaseMs: 30_000,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(
      input.inspection.plan.timeouts.poolAcquireMs,
    );
    const observed = await Promise.race([
      pending,
      Promise.resolve(Symbol("transaction-remained-pending")),
    ]);

    expect(observed).toBeInstanceOf(MailDispatchDbDeadlineExceededError);
    connection.resolve(input.client);
    await vi.runAllTimersAsync();
    expect(input.client.destroyed).toBe(true);
  });

  it("bounds and destroys a hung transaction query at the aggregate TX1 cutoff", async () => {
    vi.useFakeTimers();
    const query = deferred<{ rows: Record<string, unknown>[] }>();
    const input = await harness([
      { contains: "begin" },
      { contains: "select candidate.id", operation: query.promise },
    ]);
    const pending = input.store.claimNext({
      owner: "worker-1",
      token: TOKEN,
      leaseMs: 30_000,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(input.inspection.plan.timeouts.tx1Ms);
    const observed = await Promise.race([
      pending,
      Promise.resolve(Symbol("transaction-remained-pending")),
    ]);

    expect(observed).toBeInstanceOf(MailDispatchDbDeadlineExceededError);
    expect(input.client.destroyed).toBe(true);
  });

  it("classifies a provider-boundary COMMIT timeout as persistence unknown", async () => {
    vi.useFakeTimers();
    const commit = deferred<{ rows: Record<string, unknown>[] }>();
    const steps = committedPermitSteps();
    steps[steps.length - 1] = { contains: "commit", operation: commit.promise };
    const input = await harness(steps);
    const pending = input.store.beginProviderCall(
      claim,
      genuineBoundaryInput(input.store, claim, input.applicationUrl),
    ).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(input.inspection.plan.timeouts.tx1Ms);
    const observed = await Promise.race([
      pending,
      Promise.resolve(Symbol("transaction-remained-pending")),
    ]);

    expect(observed).toBeInstanceOf(ProviderBoundaryCommitUnknownError);
    expect(input.client.destroyed).toBe(true);
  });

  it("bounds and destroys a hung post-provider finalizer", async () => {
    vi.useFakeTimers();
    const lock = deferred<{ rows: Record<string, unknown>[] }>();
    const input = await finalizerHarness([
      { contains: "begin" },
      { contains: "pg_advisory_xact_lock", operation: lock.promise },
    ]);
    const pending = input.store.finishAfterProvider(input.permit, {
      kind: "failed",
      code: "PROVIDER_DEFINITELY_REJECTED",
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(input.inspection.plan.timeouts.tx1Ms);
    const observed = await Promise.race([
      pending,
      Promise.resolve(Symbol("finalizer-remained-pending")),
    ]);

    expect(observed).toBeInstanceOf(MailDispatchDbDeadlineExceededError);
    expect(observed).toMatchObject({ phase: "post-provider" });
    expect(input.client.destroyed).toBe(true);
  });
  it("bounds a sent unknown finalizer and consumes its capability once", async () => {
    const lock = deferred<{ rows: Record<string, unknown>[] }>();
    const input = await sentPersistenceUnknownHarness(() => [
      { contains: "begin" },
      { contains: "pg_advisory_xact_lock", operation: lock.promise },
    ]);
    vi.useFakeTimers();
    const pending = input.store.finishGuardedDispatchUnknown(
      input.uncertainty,
    ).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(input.inspection.plan.timeouts.tx1Ms);
    const observed = await Promise.race([
      pending,
      Promise.resolve(Symbol("unknown-finalizer-remained-pending")),
    ]);

    expect(observed).toBeInstanceOf(MailDispatchDbDeadlineExceededError);
    const connectsAfterTimeout = input.connect.mock.calls.length;
    await expect(input.store.finishGuardedDispatchUnknown(input.uncertainty))
      .resolves.toBeNull();
    expect(input.connect).toHaveBeenCalledTimes(connectsAfterTimeout);
    expect(input.write).toHaveBeenCalledOnce();
  });
  it("validates claim inputs before opening a database connection", async () => {
    const input = await harness([]);
    const connectsAfterStartup = input.connect.mock.calls.length;

    await expect(input.store.claimNext({
      owner: "worker-1",
      token: "not-a-uuid",
      leaseMs: 30_000,
    })).rejects.toThrow("claim token must be a UUID");
    expect(input.connect).toHaveBeenCalledTimes(connectsAfterStartup);
  });
});
