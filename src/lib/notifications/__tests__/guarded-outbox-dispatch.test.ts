import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  connectMailDispatchDbWithin,
  createMailDispatchDbDeadline,
  MailDispatchDbDeadlineExceededError,
} from "../mail-dispatch-db-deadline";
import {
  disarmMailDispatchHardWatchdog,
  isMailDispatchHardWatchdogArmed,
  startMailDispatchHardWatchdog,
  type ArmedMailDispatchHardWatchdog,
  type MailDispatchHardWatchdog,
} from "../mail-dispatch-hard-watchdog";
import { captureMailTransportConfiguration } from "../mailer-transport-internal";
import {
  inspectMailDispatchRuntime,
  type MailDispatchStartupPool,
} from "../mail-dispatch-runtime-startup";
import {
  createMaterializedDispatch,
  materializedDispatchEnvelope,
  type GuardedPreparedDispatch,
  type PreparedDispatchEnvelope,
} from "../prepared-dispatch-materialization";
import {
  authorizeCommittedPreparedDispatch,
  captureMailDispatchApplicationOrigin,
  discardGuardedPreparedDispatch,
  guardedDispatchResultSafeToDisarm,
  mailDispatchPreparedRuntimePlan,
  PostgresOutboxStore,
  releaseGuardedDispatchWatchdogClaim,
  type EmailOutboxPayload,
  type OutboxPgClient,
  type OutboxPgPool,
} from "../postgres-outbox-store";
import { outboxMessageId } from "../provider-correlation";
import {
  createResetPasswordSourceVariables,
} from "../revocable-source-authority";
import {
  PRODUCTION_EMAIL_TEMPLATES,
  type EmailTemplate,
} from "../template-authority-policy";
import type {
  GuardedDispatchResult,
  OutboxClaim,
  ProviderCallPermit,
} from "../outbox-worker";
import { userAuthorityLockKey } from "../../security/user-authority-lock";

const ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const CLAIM_TOKEN = "33333333-3333-4333-8333-333333333333";
const USER_ID = "learner-1";
const SCOPE = `a:${USER_ID}`;
const APP_URL = "https://codestead.test";
const PROVIDER_STARTED_AT = "2026-07-22 19:00:05.123456+00";
const PROVIDER_LEASE_EXPIRES_AT = "2026-07-22 19:05:05.123456+00";
const RELEASE_RECEIPT_SHA256 = "a".repeat(64);

type Rows = Record<string, unknown>[];
type Step = Readonly<{
  name: string;
  contains: string;
  rows?: Rows | ((values: unknown[]) => Rows);
  reject?: Error;
  operation?: Promise<Readonly<{ rows: Rows }>>;
}>;
type Call = Readonly<{ name: string; sql: string; values: unknown[] }>;

function compact(sql: string) {
  return sql.replace(/\s+/gu, " ").trim();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class ScriptedClient extends EventEmitter implements OutboxPgClient {
  readonly calls: Call[] = [];
  readonly releaseCalls: boolean[] = [];

  constructor(
    private readonly steps: Step[],
    private readonly timeline?: string[],
  ) {
    super();
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ) {
    const sql = compact(text);
    const step = this.steps.shift();
    expect(step, `Unexpected SQL: ${sql}`).toBeDefined();
    expect(sql.toLowerCase()).toContain(step!.contains.toLowerCase());
    this.calls.push({ name: step!.name, sql, values });
    this.timeline?.push(`db:${step!.name}`);
    if (step!.reject) throw step!.reject;
    if (step!.operation) {
      const result = await step!.operation;
      return { rows: result.rows as Row[] };
    }
    const rows =
      typeof step!.rows === "function"
        ? step!.rows(values)
        : step!.rows ?? [];
    return { rows: rows as Row[] };
  }

  release(destroy = false) {
    this.releaseCalls.push(destroy);
    if (destroy) queueMicrotask(() => this.emit("end"));
  }

  assertExhausted() {
    expect(this.steps, "Unconsumed scripted SQL").toEqual([]);
  }
}

class ScriptedPool implements OutboxPgPool, MailDispatchStartupPool {
  readonly options = Object.freeze({
    max: 3,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
  });
  readonly connectCalls: number[] = [];
  private readonly clients: Array<
    OutboxPgClient | Promise<OutboxPgClient>
  > = [];

  enqueue(client: OutboxPgClient | Promise<OutboxPgClient>) {
    this.clients.push(client);
  }

  async connect() {
    this.connectCalls.push(this.connectCalls.length + 1);
    const client = this.clients.shift();
    if (!client) throw new Error("Unexpected outbox database connection.");
    return client;
  }
}

function startupSteps(): Step[] {
  return [
    {
      name: "startup-begin",
      contains: "begin isolation level repeatable read read only",
    },
    {
      name: "startup-snapshot",
      contains: "current_setting('max_connections')",
      rows: [{
        max_connections: "89",
        admin_reserved_connections: "3",
        server_version_num: "170005",
      }],
    },
    {
      name: "startup-authority",
      contains: "public.attest_email_outbox_delivery_release_lineage",
      rows: [{
        hold_catalog_present: true,
        hold_catalog_exact: true,
        delivery_release_capability_exact: true,
      }],
    },
    { name: "startup-commit", contains: "commit" },
  ];
}

type Authority = Readonly<{
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
type FrozenConsoleWrite = Readonly<{
  chunk: string;
  encoding: "utf8";
  sha256: string;
  length: number;
}>;
type Boundary = Readonly<{
  permit: ProviderCallPermit;
  guarded: GuardedPreparedDispatch;
  authority: Authority;
  expectedConsoleWrite: FrozenConsoleWrite | null;
}>;
type Watchdog = Readonly<{
  controller: MailDispatchHardWatchdog;
  armed: ArmedMailDispatchHardWatchdog;
}>;

const watchdogs = new Set<Watchdog>();

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const watchdog of [...watchdogs]) {
    try {
      if (isMailDispatchHardWatchdogArmed(watchdog.armed)) {
        await disarmMailDispatchHardWatchdog(watchdog.armed);
      }
    } catch {
      // Assertion failures must not leak the real watchdog child.
    }
    try {
      await watchdog.controller.close();
    } catch {
      // A fatal-path child may already be closed.
    }
    watchdogs.delete(watchdog);
  }
});

const claim: OutboxClaim<EmailOutboxPayload> = Object.freeze({
  phase: "pre-provider",
  id: ID,
  operationId: OPERATION_ID,
  claimToken: CLAIM_TOKEN,
  claimOwner: "mail-worker:test",
  claimVersion: 4,
  userId: USER_ID,
  deliveryScopeKey: SCOPE,
  attempt: 2,
  leaseExpiresAt: new Date("2026-07-22T19:01:00.000Z"),
  payload: Object.freeze({
    userId: USER_ID,
    to: "learner@example.test",
    template: "invitation",
    templateVersion: "1",
    variables: Object.freeze({
      name: "Learner",
      url: `${APP_URL}/invitations/2`,
    }),
  }),
});

const otherClaim: OutboxClaim<EmailOutboxPayload> = Object.freeze({
  phase: "pre-provider",
  id: "44444444-4444-4444-8444-444444444444",
  operationId: "55555555-5555-4555-8555-555555555555",
  claimToken: "66666666-6666-4666-8666-666666666666",
  claimOwner: "mail-worker:test",
  claimVersion: 5,
  userId: "learner-2",
  deliveryScopeKey: "a:learner-2",
  attempt: 1,
  leaseExpiresAt: new Date("2026-07-22T19:01:00.000Z"),
  payload: Object.freeze({
    userId: "learner-2",
    to: "other@example.test",
    template: "invitation",
    templateVersion: "1",
    variables: Object.freeze({
      name: "Other Learner",
      url: `${APP_URL}/invitations/5`,
    }),
  }),
});

function createResetClaim(): OutboxClaim<EmailOutboxPayload> {
  const token = "R".repeat(32);
  const verificationId =
    "77777777-7777-4777-8777-777777777777";
  const url =
    `${APP_URL}/api/auth/reset-password/${token}`
    + `?callbackURL=${encodeURIComponent(`${APP_URL}/reset-password`)}`;
  const variables = createResetPasswordSourceVariables({
    applicationUrl: APP_URL,
    name: "Learner",
    token,
    url,
    verificationId,
  });
  if (!variables) {
    throw new Error("Expected canonical reset-password source variables.");
  }
  return Object.freeze({
    phase: "pre-provider",
    id: ID,
    operationId: OPERATION_ID,
    claimToken: CLAIM_TOKEN,
    claimOwner: "mail-worker:test",
    claimVersion: 4,
    userId: USER_ID,
    deliveryScopeKey: SCOPE,
    attempt: 2,
    leaseExpiresAt: new Date("2026-07-22T19:01:00.000Z"),
    payload: Object.freeze({
      userId: USER_ID,
      to: "learner@example.test",
      template: "reset-password",
      templateVersion: "1",
      variables,
    }),
  });
}

const resetClaim = createResetClaim();

async function createHarness() {
  vi.stubEnv("APP_URL", APP_URL);
  const pool = new ScriptedPool();
  const startup = new ScriptedClient(startupSteps());
  pool.enqueue(startup);
  const inspection = await inspectMailDispatchRuntime(pool);
  startup.assertExhausted();
  expect(startup.calls.map(({ name }) => name)).toEqual([
    "startup-begin",
    "startup-snapshot",
    "startup-authority",
    "startup-commit",
  ]);
  expect(startup.releaseCalls).toEqual([false]);
  const origin = captureMailDispatchApplicationOrigin(inspection);
  const store = new PostgresOutboxStore(pool, inspection, origin);
  return { pool, store };
}

function productionTemplate(value: string): EmailTemplate {
  const template = PRODUCTION_EMAIL_TEMPLATES.find(
    (candidate) => candidate === value,
  );
  if (!template) {
    throw new Error("Expected a production email template.");
  }
  return template;
}

function frozenExpectedConsoleWrite(
  outboxClaim: OutboxClaim<EmailOutboxPayload>,
): FrozenConsoleWrite {
  const chunk = `${JSON.stringify({
    event: "email.console_delivery",
    template: outboxClaim.payload.template,
  })}\n`;
  return Object.freeze({
    chunk,
    encoding: "utf8",
    sha256: createHash("sha256").update(chunk, "utf8").digest("hex"),
    length: Buffer.byteLength(chunk, "utf8"),
  });
}

function preparedEnvelope(
  store: PostgresOutboxStore,
  outboxClaim: OutboxClaim<EmailOutboxPayload>,
  adapter: "console" | "gmail" = "console",
): Readonly<{
  envelope: PreparedDispatchEnvelope;
  expectedConsoleWrite: FrozenConsoleWrite | null;
}> {
  if (adapter === "gmail") {
    vi.stubEnv("GMAIL_CLIENT_ID", "client-id");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "refresh-token");
  }
  const expectedConsoleWrite =
    adapter === "console" ? frozenExpectedConsoleWrite(outboxClaim) : null;
  const materialized = createMaterializedDispatch({
    source: {
      applicationUrl: APP_URL,
      outboxId: outboxClaim.id,
      operationId: outboxClaim.operationId,
      claimToken: outboxClaim.claimToken,
      claimOwner: outboxClaim.claimOwner,
      claimVersion: outboxClaim.claimVersion,
      deliveryScopeKey: outboxClaim.deliveryScopeKey,
      recipient: outboxClaim.payload.to,
      template: productionTemplate(outboxClaim.payload.template),
      templateVersion: outboxClaim.payload.templateVersion,
      variables: outboxClaim.payload.variables,
    },
    adapter,
    from: "Codestead <mail@codestead.test>",
    messageId: outboxMessageId(outboxClaim.operationId),
    runtimePlan: mailDispatchPreparedRuntimePlan(store),
    transportConfiguration: captureMailTransportConfiguration(adapter),
  });
  const envelope = materializedDispatchEnvelope(materialized);
  if (!envelope) throw new Error("Expected a prepared dispatch envelope.");
  return Object.freeze({ envelope, expectedConsoleWrite });
}

function text(value: unknown, name: string) {
  if (typeof value !== "string") {
    throw new Error(`Expected ${name} to be a string.`);
  }
  return value;
}

function nullableText(value: unknown, name: string) {
  if (value !== null && typeof value !== "string") {
    throw new Error(`Expected ${name} to be a nullable string.`);
  }
  return value;
}

function tx1Steps(
  outboxClaim: OutboxClaim<EmailOutboxPayload>,
  captured: { authority?: Authority },
): Step[] {
  return [
    { name: "tx1-begin", contains: "begin" },
    { name: "tx1-scope-lock", contains: "pg_advisory_xact_lock" },
    {
      name: "tx1-fence",
      contains:
        "select id::text, user_id, operation_id::text, delivery_scope_key",
      rows: [{
        id: outboxClaim.id,
        user_id: outboxClaim.userId,
        operation_id: outboxClaim.operationId,
        delivery_scope_key: outboxClaim.deliveryScopeKey,
        claim_version: outboxClaim.claimVersion,
      }],
    },
    {
      name: "tx1-authority-unlocked",
      contains: "select case",
      rows: [{ decision: "allowed" }],
    },
    {
      name: "tx1-authority-locked",
      contains: "select case",
      rows: [{ decision: "allowed" }],
    },
    {
      name: "tx1-arm",
      contains: "update public.email_outbox as outbox",
      rows: (values) => {
        const adapter = text(values[5], "adapter");
        if (adapter !== "console" && adapter !== "gmail") {
          throw new Error("Expected a supported adapter.");
        }
        if (
          typeof values[24] !== "number"
          || !Number.isSafeInteger(values[24])
        ) {
          throw new Error("Expected an exact request-body length.");
        }
        const authority: Authority = Object.freeze({
          adapter,
          bindingVersion: text(values[18], "binding version"),
          bindingSha256: text(values[19], "binding digest"),
          correlationVersion: text(values[20], "correlation version"),
          evidenceVersion: nullableText(values[21], "evidence version"),
          evidenceSha256: nullableText(values[22], "evidence digest"),
          requestBodySha256: text(values[23], "request-body digest"),
          requestBodyLength: values[24],
          releaseReceiptSha256: RELEASE_RECEIPT_SHA256,
          providerCallStartedAt: PROVIDER_STARTED_AT,
          leaseExpiresAt: PROVIDER_LEASE_EXPIRES_AT,
        });
        captured.authority = authority;
        return [{
          provider_call_started: authority.providerCallStartedAt,
          lease_expires_at: authority.leaseExpiresAt,
          dispatch_binding_version: authority.bindingVersion,
          dispatch_binding_sha256: authority.bindingSha256,
          provider_correlation_version: authority.correlationVersion,
          provider_evidence_version: authority.evidenceVersion,
          provider_evidence_sha256: authority.evidenceSha256,
          provider_request_body_sha256: authority.requestBodySha256,
          provider_request_body_length: authority.requestBodyLength,
          release_receipt_sha256: authority.releaseReceiptSha256,
        }];
      },
    },
    { name: "tx1-commit", contains: "commit" },
  ];
}

async function armBoundary(
  harness: Awaited<ReturnType<typeof createHarness>>,
  outboxClaim: OutboxClaim<EmailOutboxPayload> = claim,
  adapter: "console" | "gmail" = "console",
): Promise<Boundary> {
  const captured: { authority?: Authority } = {};
  const tx1 = new ScriptedClient(tx1Steps(outboxClaim, captured));
  const prepared = preparedEnvelope(harness.store, outboxClaim, adapter);
  harness.pool.enqueue(tx1);
  const result = await harness.store.beginProviderCall(outboxClaim, {
    adapter,
    envelope: prepared.envelope,
  });
  expect(result.kind).toBe("applied");
  if (result.kind !== "applied" || !captured.authority) {
    throw new Error("Expected committed TX1 provider authority.");
  }
  const guarded = await authorizeCommittedPreparedDispatch(
    harness.store,
    result.receipt,
  );
  tx1.assertExhausted();
  expect(tx1.releaseCalls).toEqual([false]);
  return Object.freeze({
    permit: result.permit,
    guarded,
    authority: captured.authority,
    expectedConsoleWrite: prepared.expectedConsoleWrite,
  });
}

function liveRow(
  outboxClaim: OutboxClaim<EmailOutboxPayload>,
  authority: Authority,
) {
  return {
    id: outboxClaim.id,
    user_id: outboxClaim.userId,
    operation_id: outboxClaim.operationId,
    delivery_scope_key: outboxClaim.deliveryScopeKey,
    claim_version: outboxClaim.claimVersion,
    to_email: outboxClaim.payload.to,
    template: outboxClaim.payload.template,
    template_version: outboxClaim.payload.templateVersion,
    variables: outboxClaim.payload.variables,
    claim_token: outboxClaim.claimToken,
    claim_owner: outboxClaim.claimOwner,
    attempt_count: outboxClaim.attempt,
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

function terminalRow(
  outboxClaim: OutboxClaim<EmailOutboxPayload>,
  authority: Authority,
  values: unknown[],
) {
  const kind = text(values[14], "terminal kind");
  return {
    status: kind,
    claim_version:
      kind === "quarantined"
        ? outboxClaim.claimVersion + 1
        : outboxClaim.claimVersion,
    user_id: outboxClaim.userId,
    delivery_scope_key: outboxClaim.deliveryScopeKey,
    adapter: authority.adapter,
    provider_message_id: values[15],
    provider_call_started: authority.providerCallStartedAt,
    sent_at:
      kind === "sent" ? "2026-07-22 19:00:06.123456+00" : null,
    quarantined_at:
      kind === "quarantined"
        ? "2026-07-22 19:00:06.123456+00"
        : null,
    last_error_code: values[16],
    claim_token: null,
    claim_owner: null,
    lease_expires_at: null,
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

function successfulTx2Steps(
  authority: Authority,
  outboxClaim: OutboxClaim<EmailOutboxPayload> = claim,
): Step[] {
  return [
    { name: "tx2-begin", contains: "begin" },
    { name: "tx2-lock-timeout", contains: "set local lock_timeout" },
    {
      name: "tx2-statement-timeout",
      contains: "set local statement_timeout",
    },
    {
      name: "tx2-idle-zero",
      contains: "set local idle_in_transaction_session_timeout = '0'",
    },
    {
      name: "tx2-transaction-zero",
      contains: "set local transaction_timeout = '0'",
    },
    { name: "tx2-scope-lock", contains: "pg_advisory_xact_lock" },
    {
      name: "tx2-live-fence",
      contains: "pg_catalog.pg_current_xact_id()",
      rows: [liveRow(outboxClaim, authority)],
    },
    {
      name: "tx2-authority",
      contains: "select case",
      rows: [{ decision: "allowed" }],
    },
    {
      name: "tx2-final-fence",
      contains: "select 1 from public.email_outbox",
      rows: [{ authorized: 1 }],
    },
    {
      name: "tx2-transaction-finite",
      contains: "set local transaction_timeout = '60000ms'",
    },
    {
      name: "tx2-idle-finite",
      contains:
        "set local idle_in_transaction_session_timeout = '60000ms'",
    },
    {
      name: "tx2-terminal",
      contains: "update public.email_outbox",
      rows: (values) => [terminalRow(outboxClaim, authority, values)],
    },
    { name: "tx2-commit", contains: "commit" },
  ];
}

function uncertainTx2Steps(
  authority: Authority,
  captured: { providerMessageId?: string },
): Step[] {
  const beforeTerminal = successfulTx2Steps(authority).slice(0, -2);
  return [
    ...beforeTerminal,
    {
      name: "tx2-terminal-unknown",
      contains: "update public.email_outbox",
      rows: (values) => {
        captured.providerMessageId = text(
          values[15],
          "provider message ID",
        );
        throw new Error("Injected terminal persistence uncertainty.");
      },
    },
  ];
}

function postProviderHungTx2Steps(
  authority: Authority,
  operation: Promise<Readonly<{ rows: Rows }>>,
): Step[] {
  return [
    ...successfulTx2Steps(authority).slice(0, -2),
    {
      name: "tx2-terminal-hung",
      contains: "update public.email_outbox",
      operation,
    },
  ];
}

function commitAckUnknownTx2Steps(authority: Authority): Step[] {
  return [
    ...successfulTx2Steps(authority).slice(0, -1),
    {
      name: "tx2-commit-ack-unknown",
      contains: "commit",
      reject: new Error("Injected COMMIT acknowledgement uncertainty."),
    },
  ];
}

function teardownProofSteps(
  transactionStatus: "aborted" | "committed" = "aborted",
): Step[] {
  return [
    {
      name: "proof-transaction-status",
      contains: "select pg_catalog.pg_xact_status",
      rows: [{ transaction_status: transactionStatus }],
    },
    { name: "proof-begin", contains: "begin" },
    {
      name: "proof-lock-timeout",
      contains: "set local lock_timeout",
    },
    {
      name: "proof-scope-lock",
      contains: "pg_advisory_xact_lock",
    },
    { name: "proof-commit", contains: "commit" },
  ];
}

function expectExactTeardownProof(
  tx2: ScriptedClient,
  proof: ScriptedClient,
) {
  expect(proof).not.toBe(tx2);
  expect(tx2.releaseCalls).toEqual([true]);
  expect(proof.releaseCalls).toEqual([false]);

  const transactionStatus = proof.calls.find(
    ({ name }) => name === "proof-transaction-status",
  );
  expect(transactionStatus).toBeDefined();
  expect(transactionStatus!.values).toEqual(["42"]);

  const scopeLock = proof.calls.find(
    ({ name }) => name === "proof-scope-lock",
  );
  expect(scopeLock).toBeDefined();
  const canonicalScopeLockKey = userAuthorityLockKey(USER_ID);
  expect(canonicalScopeLockKey).toBe(`user-authority:${USER_ID}`);
  expect(scopeLock!.values).toEqual([canonicalScopeLockKey]);
  expect(
    proof.calls.filter(({ name }) => name === "proof-commit"),
  ).toHaveLength(1);
}

type FinalizerMode = "already-applied" | "still-started" | "conflict";

function finalizerFenceRow(
  authority: Authority,
  mode: FinalizerMode,
) {
  return {
    id: claim.id,
    user_id: claim.userId,
    operation_id: claim.operationId,
    delivery_scope_key: claim.deliveryScopeKey,
    claim_version: claim.claimVersion,
    provider_call_started: authority.providerCallStartedAt,
    lease_expires_at:
      mode === "still-started" ? authority.leaseExpiresAt : null,
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
  authority: Authority,
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

function finalizerSteps(
  authority: Authority,
  providerMessageId: string,
  mode: FinalizerMode,
): Step[] {
  const prefix: Step[] = [
    { name: "finish-begin", contains: "begin" },
    {
      name: "finish-scope-lock",
      contains: "pg_advisory_xact_lock",
    },
    {
      name: "finish-permit-fence",
      contains:
        "select id::text, user_id, operation_id::text, delivery_scope_key",
      rows:
        mode === "conflict"
          ? []
          : [finalizerFenceRow(authority, mode)],
    },
  ];
  if (mode === "conflict") {
    return [...prefix, { name: "finish-commit", contains: "commit" }];
  }
  if (mode === "still-started") {
    return [
      ...prefix,
      {
        name: "finish-persist",
        contains: "set provider_message_id = $7::text",
        rows: [recoveredSentRow(authority, providerMessageId)],
      },
      { name: "finish-commit", contains: "commit" },
    ];
  }
  return [
    ...prefix,
    {
      name: "finish-persist-noop",
      contains: "set provider_message_id = $7::text",
      rows: [],
    },
    {
      name: "finish-successor-noop",
      contains: "set status = case when $8::text = 'sent'",
      rows: [],
    },
    {
      name: "finish-existing",
      contains: "select status::text",
      rows: [recoveredSentRow(authority, providerMessageId)],
    },
    { name: "finish-commit", contains: "commit" },
  ];
}

function revocableTx2Steps(
  authority: Authority,
  sourceAuthorized: boolean,
): Step[] {
  const base = successfulTx2Steps(authority, resetClaim);
  const finalFenceIndex = base.findIndex(
    ({ name }) => name === "tx2-final-fence",
  );
  if (finalFenceIndex < 0) {
    throw new Error("Expected the final TX2 fence step.");
  }
  const beforeFinalFence = base.slice(0, finalFenceIndex);
  const sourceSteps: Step[] = [
    {
      name: "tx2-source-clock",
      contains: "select pg_catalog.statement_timestamp() as now",
      rows: [{ now: "2026-07-22 19:00:05.500000+00" }],
    },
    {
      name: "tx2-source-authority",
      contains: "from public.verification source_verification",
      rows: sourceAuthorized ? [{ authorized: 1 }] : [],
    },
  ];
  if (!sourceAuthorized) {
    return [
      ...beforeFinalFence,
      ...sourceSteps,
      { name: "tx2-rollback", contains: "rollback" },
    ];
  }
  return [
    ...beforeFinalFence,
    ...sourceSteps,
    ...base.slice(finalFenceIndex),
  ];
}

function rejectedLiveFenceSteps(): Step[] {
  return [
    { name: "tx2-begin", contains: "begin" },
    { name: "tx2-lock-timeout", contains: "set local lock_timeout" },
    {
      name: "tx2-statement-timeout",
      contains: "set local statement_timeout",
    },
    {
      name: "tx2-idle-zero",
      contains: "set local idle_in_transaction_session_timeout = '0'",
    },
    {
      name: "tx2-transaction-zero",
      contains: "set local transaction_timeout = '0'",
    },
    { name: "tx2-scope-lock", contains: "pg_advisory_xact_lock" },
    {
      name: "tx2-live-fence",
      contains: "pg_catalog.pg_current_xact_id()",
      rows: [],
    },
    { name: "tx2-rollback", contains: "rollback" },
  ];
}

async function createWatchdog(): Promise<Watchdog> {
  const controller = await startMailDispatchHardWatchdog();
  const armed = await controller.arm();
  const watchdog = Object.freeze({ controller, armed });
  watchdogs.add(watchdog);
  return watchdog;
}

async function disarmSafeResult(
  store: PostgresOutboxStore,
  watchdog: Watchdog,
  result: GuardedDispatchResult,
) {
  expect(
    guardedDispatchResultSafeToDisarm(store, watchdog.armed, result),
  ).toBe(true);
  await disarmMailDispatchHardWatchdog(watchdog.armed);
  expect(
    releaseGuardedDispatchWatchdogClaim(store, watchdog.armed),
  ).toBe(true);
  await watchdog.controller.close();
  watchdogs.delete(watchdog);
}

type ConsoleWriteCallback = (error?: Error | null) => void;

type CapturedConsoleWrite = Readonly<{
  chunk: string | Uint8Array;
  encoding: BufferEncoding | undefined;
}>;

function deferredConsoleWrite(timeline: string[]) {
  let settle: ((error?: Error | null) => void) | undefined;
  const writes: CapturedConsoleWrite[] = [];
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
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ConsoleWriteCallback,
    callback?: ConsoleWriteCallback,
  ) {
    timeline.push("provider:start");
    writes.push(Object.freeze({
      chunk:
        typeof chunk === "string" ? chunk : Uint8Array.from(chunk),
      encoding:
        typeof encodingOrCallback === "string"
          ? encodingOrCallback
          : undefined,
    }));
    settle =
      typeof encodingOrCallback === "function"
        ? encodingOrCallback
        : callback;
    return true;
  }
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(implementation);
  return {
    write,
    writes,
    settle(error?: Error | null) {
      if (!settle) throw new Error("Provider write did not start.");
      settle(error);
    },
  };
}

function immediateConsoleWrite(error?: Error) {
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
    const writeCallback =
      typeof encodingOrCallback === "function"
        ? encodingOrCallback
        : callback;
    writeCallback?.(error);
    return true;
  }
  return vi
    .spyOn(process.stdout, "write")
    .mockImplementation(implementation);
}

type FatalScenario =
  | "acquire-timeout"
  | "pre-provider-hang"
  | "post-init-arm-failure"
  | "provider-unsettled"
  | "unarmed-watchdog"
  | "already-claimed-watchdog";

async function runFatalScenario(scenario: FatalScenario) {
  const fixture = path.resolve(
    process.cwd(),
    "src/lib/notifications/__tests__/fixtures/"
      + "guarded-outbox-dispatch-fatal-parent.ts",
  );
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    APP_URL,
    MAIL_DISPATCH_TX2_FATAL_SCENARIO: scenario,
    MAIL_DISPATCH_WATCHDOG_TEST_TIMEOUT_MS:
      scenario === "provider-unsettled" ? "250" : "9000",
    MAIL_DISPATCH_WATCHDOG_TEST_HANDSHAKE_TIMEOUT_MS: "1000",
  };
  for (const name of ["PATH", "SYSTEMROOT", "WINDIR"] as const) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fixture],
    {
      cwd: process.cwd(),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exit = await new Promise<Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>>((resolve, reject) => {
    let killedForTimeout = false;
    const timeout = setTimeout(() => {
      killedForTimeout = true;
      child.kill("SIGKILL");
    }, 12_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (killedForTimeout) {
        reject(new Error(`Fatal TX2 fixture hung (${scenario}).`));
        return;
      }
      resolve({ code, signal });
    });
  });
  return Object.freeze({
    ...exit,
    stdout,
    stderr,
  });
}

describe("guarded outbox dispatch", () => {
  it("observes checked-out client errors only for the lifetime of the database lease", async () => {
    const client = new ScriptedClient([]);
    const lease = await connectMailDispatchDbWithin({
      pool: { connect: async () => client },
      deadline: createMailDispatchDbDeadline({
        phase: "pool-acquire",
        budgetMs: 1_000,
      }),
    });

    expect(client.listenerCount("error")).toBe(1);
    expect(client.listenerCount("end")).toBe(1);
    expect(lease.clientEnded).toBe(false);
    expect(() => client.emit("error", new Error("connection lost"))).not.toThrow();
    client.emit("end");
    expect(lease.clientEnded).toBe(true);

    lease.release();

    expect(client.releaseCalls).toEqual([false]);
    expect(client.listenerCount("error")).toBe(0);
    expect(client.listenerCount("end")).toBe(0);
  });
  it("holds one TX2 client and scope lock through send, finite timeout arm, terminal CAS, and COMMIT", async () => {
    const harness = await createHarness();
    const boundary = await armBoundary(harness);
    const timeline: string[] = [];
    const tx2 = new ScriptedClient(
      successfulTx2Steps(boundary.authority),
      timeline,
    );
    harness.pool.enqueue(tx2);
    const provider = deferredConsoleWrite(timeline);
    const watchdog = await createWatchdog();

    const operation = harness.store.dispatchAfterProviderBoundary(
      boundary.permit,
      boundary.guarded,
      watchdog.armed,
    );
    await vi.waitFor(() => {
      expect(provider.write).toHaveBeenCalledOnce();
      expect(
        tx2.calls.some(({ name }) => name === "tx2-idle-finite"),
      ).toBe(true);
    });

    expect(timeline).toEqual([
      "db:tx2-begin",
      "db:tx2-lock-timeout",
      "db:tx2-statement-timeout",
      "db:tx2-idle-zero",
      "db:tx2-transaction-zero",
      "db:tx2-scope-lock",
      "db:tx2-live-fence",
      "db:tx2-authority",
      "db:tx2-final-fence",
      "provider:start",
      "db:tx2-transaction-finite",
      "db:tx2-idle-finite",
    ]);
    expect(tx2.releaseCalls).toEqual([]);
    const expectedWrite = boundary.expectedConsoleWrite;
    if (!expectedWrite) {
      throw new Error("Expected immutable pre-TX1 console bytes.");
    }
    expect(Object.isFrozen(expectedWrite)).toBe(true);
    expect(provider.writes).toHaveLength(1);
    const transmitted = provider.writes[0]!;
    expect(typeof transmitted.chunk).toBe("string");
    expect(transmitted.encoding).toBe(expectedWrite.encoding);
    expect(transmitted.chunk).toBe(expectedWrite.chunk);
    const transmittedBytes =
      typeof transmitted.chunk === "string"
        ? Buffer.from(transmitted.chunk, transmitted.encoding)
        : Buffer.from(transmitted.chunk);
    const transmittedSha256 = createHash("sha256")
      .update(transmittedBytes)
      .digest("hex");
    expect(transmittedSha256).toBe(expectedWrite.sha256);
    expect(transmittedBytes.byteLength).toBe(expectedWrite.length);
    expect(boundary.authority.requestBodySha256).toBe(
      transmittedSha256,
    );
    expect(boundary.authority.requestBodyLength).toBe(
      transmittedBytes.byteLength,
    );
    expect(boundary.authority.bindingSha256).toBe(transmittedSha256);

    provider.settle();
    const result = await operation;

    expect(result).toMatchObject({
      kind: "applied",
      exit: { kind: "sent" },
    });
    const liveFence = tx2.calls.find(
      ({ name }) => name === "tx2-live-fence",
    )!;
    expect(liveFence.sql).toContain("status = 'sending'");
    expect(liveFence.sql).toContain(
      "lease_expires_at > pg_catalog.statement_timestamp()",
    );
    expect(liveFence.sql).toContain("provider_message_id is null");
    expect(liveFence.sql).toContain("sent_at is null");
    expect(liveFence.sql).toContain("quarantined_at is null");
    expect(liveFence.sql).toContain("last_error_code is null");
    expect(liveFence.sql).toContain("provider_request_body_sha256 = $16");
    expect(liveFence.sql).toContain("provider_request_body_length = $17");
    expect(liveFence.sql).toContain("release_receipt_sha256");
    const terminal = tx2.calls.find(
      ({ name }) => name === "tx2-terminal",
    )!;
    expect(terminal.values).toHaveLength(21);
    expect(terminal.values.slice(18)).toEqual([
      boundary.authority.requestBodySha256,
      boundary.authority.requestBodyLength,
      boundary.authority.releaseReceiptSha256,
    ]);
    expect(tx2.releaseCalls).toEqual([false]);
    tx2.assertExhausted();
    await disarmSafeResult(harness.store, watchdog, result);
  });

  it("persists a definitely rejected Gmail outcome exactly once as failed", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) =>
      String(url) === "https://oauth2.googleapis.com/token"
        ? new Response('{"access_token":"oauth-access-token"}', {
            status: 200,
          })
        : new Response('{"error":"invalid-recipient"}', {
            status: 400,
          }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const harness = await createHarness();
    const boundary = await armBoundary(harness, claim, "gmail");
    const tx2 = new ScriptedClient(
      successfulTx2Steps(boundary.authority),
    );
    harness.pool.enqueue(tx2);
    const watchdog = await createWatchdog();

    const result = await harness.store.dispatchAfterProviderBoundary(
      boundary.permit,
      boundary.guarded,
      watchdog.armed,
    );

    expect(result).toMatchObject({
      kind: "applied",
      exit: { kind: "failed" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const terminalCalls = tx2.calls.filter(
      ({ name }) => name === "tx2-terminal",
    );
    expect(terminalCalls).toHaveLength(1);
    expect(terminalCalls[0]!.values[14]).toBe("failed");
    expect(terminalCalls[0]!.values[15]).toBeNull();
    expect(typeof terminalCalls[0]!.values[16]).toBe("string");
    tx2.assertExhausted();
    await disarmSafeResult(harness.store, watchdog, result);
  });

  it("persists an ambiguous console write exactly once as quarantined", async () => {
    const harness = await createHarness();
    const boundary = await armBoundary(harness);
    const tx2 = new ScriptedClient(
      successfulTx2Steps(boundary.authority),
    );
    harness.pool.enqueue(tx2);
    const write = immediateConsoleWrite(
      new Error("Injected ambiguous write completion."),
    );
    const watchdog = await createWatchdog();

    const result = await harness.store.dispatchAfterProviderBoundary(
      boundary.permit,
      boundary.guarded,
      watchdog.armed,
    );

    expect(result).toMatchObject({
      kind: "applied",
      exit: { kind: "quarantined" },
    });
    expect(write).toHaveBeenCalledOnce();
    const terminalCalls = tx2.calls.filter(
      ({ name }) => name === "tx2-terminal",
    );
    expect(terminalCalls).toHaveLength(1);
    expect(terminalCalls[0]!.values[14]).toBe("quarantined");
    expect(terminalCalls[0]!.values[15]).toBeNull();
    expect(typeof terminalCalls[0]!.values[16]).toBe("string");
    tx2.assertExhausted();
    await disarmSafeResult(harness.store, watchdog, result);
  });

  it("does not invoke the provider when the exact live fence returns no row", async () => {
    const harness = await createHarness();
    const boundary = await armBoundary(harness);
    const tx2 = new ScriptedClient(rejectedLiveFenceSteps());
    harness.pool.enqueue(tx2);
    const write = vi.spyOn(process.stdout, "write");
    const watchdog = await createWatchdog();

    const result = await harness.store.dispatchAfterProviderBoundary(
      boundary.permit,
      boundary.guarded,
      watchdog.armed,
    );

    expect(result).toEqual({ kind: "lost" });
    expect(write).not.toHaveBeenCalled();
    expect(tx2.releaseCalls).toEqual([false]);
    tx2.assertExhausted();
    await disarmSafeResult(harness.store, watchdog, result);
  });

  it.each([
    [true, "applied", 1],
    [false, "lost", 0],
  ] as const)(
    "revalidates a revocable reset source at TX2 (authorized=%s)",
    async (sourceAuthorized, expectedKind, providerCalls) => {
      const harness = await createHarness();
      const boundary = await armBoundary(harness, resetClaim);
      const tx2 = new ScriptedClient(
        revocableTx2Steps(boundary.authority, sourceAuthorized),
      );
      harness.pool.enqueue(tx2);
      const write = immediateConsoleWrite();
      const watchdog = await createWatchdog();

      const result = await harness.store.dispatchAfterProviderBoundary(
        boundary.permit,
        boundary.guarded,
        watchdog.armed,
      );

      expect(result.kind).toBe(expectedKind);
      expect(write).toHaveBeenCalledTimes(providerCalls);
      const source = tx2.calls.find(
        ({ name }) => name === "tx2-source-authority",
      )!;
      expect(source.sql).toContain(
        "join public.email_outbox mail on mail.id = $1::uuid",
      );
      expect(source.sql).toContain(
        "source_verification.expires_at > $4",
      );
      expect(source.sql).toContain(
        "for share of recipient_user, source_verification",
      );
      expect(source.values[0]).toBe(resetClaim.id);
      expect(source.values[1]).toBe(
        resetClaim.payload.variables.resetVerificationId,
      );
      tx2.assertExhausted();
      await disarmSafeResult(harness.store, watchdog, result);
    },
  );

  it("accepts only the exact frozen store/watchdog result once for safe disarm", async () => {
    const harness = await createHarness();
    const boundary = await armBoundary(harness);
    const tx2 = new ScriptedClient(rejectedLiveFenceSteps());
    harness.pool.enqueue(tx2);
    const resultWatchdog = await createWatchdog();
    const wrongWatchdog = await createWatchdog();

    const result = await harness.store.dispatchAfterProviderBoundary(
      boundary.permit,
      boundary.guarded,
      resultWatchdog.armed,
    );
    expect(result).toEqual({ kind: "lost" });

    const forged: GuardedDispatchResult = Object.freeze({
      kind: "lost",
    });
    const clone: GuardedDispatchResult = Object.freeze({ ...result });
    const otherHarness = await createHarness();
    expect(
      guardedDispatchResultSafeToDisarm(
        harness.store,
        resultWatchdog.armed,
        forged,
      ),
    ).toBe(false);
    expect(
      guardedDispatchResultSafeToDisarm(
        harness.store,
        resultWatchdog.armed,
        clone,
      ),
    ).toBe(false);
    expect(
      guardedDispatchResultSafeToDisarm(
        otherHarness.store,
        resultWatchdog.armed,
        result,
      ),
    ).toBe(false);
    expect(
      guardedDispatchResultSafeToDisarm(
        harness.store,
        wrongWatchdog.armed,
        result,
      ),
    ).toBe(false);
    expect(
      guardedDispatchResultSafeToDisarm(
        harness.store,
        resultWatchdog.armed,
        result,
      ),
    ).toBe(true);
    expect(
      guardedDispatchResultSafeToDisarm(
        harness.store,
        resultWatchdog.armed,
        result,
      ),
    ).toBe(false);

    await disarmMailDispatchHardWatchdog(resultWatchdog.armed);
    expect(
      releaseGuardedDispatchWatchdogClaim(
        harness.store,
        resultWatchdog.armed,
      ),
    ).toBe(true);
    await resultWatchdog.controller.close();
    watchdogs.delete(resultWatchdog);
    await disarmMailDispatchHardWatchdog(wrongWatchdog.armed);
    await wrongWatchdog.controller.close();
    watchdogs.delete(wrongWatchdog);
  });

  it("burns an authentic permit and guard after one send and rejects replay before another connection", async () => {
    const harness = await createHarness();
    const boundary = await armBoundary(harness);
    const tx2 = new ScriptedClient(
      successfulTx2Steps(boundary.authority),
    );
    harness.pool.enqueue(tx2);
    const write = immediateConsoleWrite();
    const firstWatchdog = await createWatchdog();
    const first = await harness.store.dispatchAfterProviderBoundary(
      boundary.permit,
      boundary.guarded,
      firstWatchdog.armed,
    );
    await disarmSafeResult(harness.store, firstWatchdog, first);
    const connectionCount = harness.pool.connectCalls.length;

    const replayWatchdog = await createWatchdog();
    const replay = await harness.store.dispatchAfterProviderBoundary(
      boundary.permit,
      boundary.guarded,
      replayWatchdog.armed,
    );

    expect(first.kind).toBe("applied");
    expect(replay).toEqual({ kind: "lost" });
    expect(write).toHaveBeenCalledOnce();
    expect(harness.pool.connectCalls).toHaveLength(connectionCount);
    expect(
      guardedDispatchResultSafeToDisarm(
        harness.store,
        replayWatchdog.armed,
        replay,
      ),
    ).toBe(true);
    expect(
      guardedDispatchResultSafeToDisarm(
        harness.store,
        replayWatchdog.armed,
        replay,
      ),
    ).toBe(false);
    await disarmMailDispatchHardWatchdog(replayWatchdog.armed);
    expect(
      releaseGuardedDispatchWatchdogClaim(
        harness.store,
        replayWatchdog.armed,
      ),
    ).toBe(true);
    await replayWatchdog.controller.close();
    watchdogs.delete(replayWatchdog);
  });

  it("burns a permit on a wrong authentic guard and rejects its later correct guard before DB or provider", async () => {
    const harness = await createHarness();
    const first = await armBoundary(harness);
    const second = await armBoundary(harness, otherClaim);
    const connectionsBeforeDispatch = harness.pool.connectCalls.length;
    const write = vi.spyOn(process.stdout, "write");
    const wrongGuardWatchdog = await createWatchdog();

    const wrongGuard = await harness.store.dispatchAfterProviderBoundary(
      second.permit,
      first.guarded,
      wrongGuardWatchdog.armed,
    );

    expect(wrongGuard).toEqual({ kind: "lost" });
    expect(harness.pool.connectCalls).toHaveLength(
      connectionsBeforeDispatch,
    );
    expect(write).not.toHaveBeenCalled();
    await disarmSafeResult(
      harness.store,
      wrongGuardWatchdog,
      wrongGuard,
    );

    const retryClient = new ScriptedClient(rejectedLiveFenceSteps());
    harness.pool.enqueue(retryClient);
    const retryWatchdog = await createWatchdog();
    const correctGuardRetry =
      await harness.store.dispatchAfterProviderBoundary(
        second.permit,
        second.guarded,
        retryWatchdog.armed,
      );

    expect(correctGuardRetry).toEqual({ kind: "lost" });
    expect(harness.pool.connectCalls).toHaveLength(
      connectionsBeforeDispatch,
    );
    expect(write).not.toHaveBeenCalled();
    await disarmSafeResult(
      harness.store,
      retryWatchdog,
      correctGuardRetry,
    );
    discardGuardedPreparedDispatch(
      harness.store,
      first.permit,
      first.guarded,
    );
    discardGuardedPreparedDispatch(
      harness.store,
      second.permit,
      second.guarded,
    );
  });

  it("atomically rejects a concurrent duplicate permit and guard before a second pool acquisition", async () => {
    const harness = await createHarness();
    const boundary = await armBoundary(harness);
    const pendingConnection = deferred<OutboxPgClient>();
    harness.pool.enqueue(pendingConnection.promise);
    const connectionsBeforeDispatch = harness.pool.connectCalls.length;
    const write = vi.spyOn(process.stdout, "write");
    const firstWatchdog = await createWatchdog();
    const duplicateWatchdog = await createWatchdog();

    const first = harness.store.dispatchAfterProviderBoundary(
      boundary.permit,
      boundary.guarded,
      firstWatchdog.armed,
    );
    const duplicate = harness.store.dispatchAfterProviderBoundary(
      boundary.permit,
      boundary.guarded,
      duplicateWatchdog.armed,
    );
    const duplicateResult = await duplicate;

    expect(duplicateResult).toEqual({ kind: "lost" });
    expect(harness.pool.connectCalls).toHaveLength(
      connectionsBeforeDispatch + 1,
    );
    expect(write).not.toHaveBeenCalled();

    const firstClient = new ScriptedClient(rejectedLiveFenceSteps());
    pendingConnection.resolve(firstClient);
    const firstResult = await first;
    expect(firstResult).toEqual({ kind: "lost" });
    expect(write).not.toHaveBeenCalled();
    firstClient.assertExhausted();
    await disarmSafeResult(
      harness.store,
      duplicateWatchdog,
      duplicateResult,
    );
    await disarmSafeResult(harness.store, firstWatchdog, firstResult);
  });

  it.each([
    ["already-applied", "already-applied"],
    ["still-started", "applied"],
    ["conflict", "lost"],
  ] as const)(
    "recovers one opaque persistence uncertainty from %s without another provider call",
    async (mode, expectedResult) => {
      const harness = await createHarness();
      const boundary = await armBoundary(harness);
      const captured: { providerMessageId?: string } = {};
      const tx2 = new ScriptedClient(
        uncertainTx2Steps(boundary.authority, captured),
      );
      const proof = new ScriptedClient(teardownProofSteps());
      harness.pool.enqueue(tx2);
      harness.pool.enqueue(proof);
      const write = immediateConsoleWrite();
      const watchdog = await createWatchdog();

      const result = await harness.store.dispatchAfterProviderBoundary(
        boundary.permit,
        boundary.guarded,
        watchdog.armed,
      );

      expect(result.kind).toBe("persistence-unknown");
      if (
        result.kind !== "persistence-unknown"
        || !captured.providerMessageId
      ) {
        throw new Error("Expected an opaque guarded-dispatch uncertainty.");
      }
      expect(write).toHaveBeenCalledOnce();
      expectExactTeardownProof(tx2, proof);
      tx2.assertExhausted();
      proof.assertExhausted();
      await disarmSafeResult(harness.store, watchdog, result);

      const finalizer = new ScriptedClient(
        finalizerSteps(
          boundary.authority,
          captured.providerMessageId,
          mode,
        ),
      );
      harness.pool.enqueue(finalizer);
      const recovered =
        await harness.store.finishGuardedDispatchUnknown(
          result.uncertainty,
        );

      expect(recovered).toEqual({
        result: { kind: expectedResult },
        exit: {
          kind: "sent",
          providerMessageId: captured.providerMessageId,
        },
      });
      expect(write).toHaveBeenCalledOnce();
      finalizer.assertExhausted();
      expect(finalizer.releaseCalls).toEqual([false]);
      const connectionCount = harness.pool.connectCalls.length;
      await expect(
        harness.store.finishGuardedDispatchUnknown(result.uncertainty),
      ).resolves.toBeNull();
      expect(harness.pool.connectCalls).toHaveLength(connectionCount);
      expect(write).toHaveBeenCalledOnce();
    },
  );

  it("recovers a committed terminal UPDATE with unknown COMMIT acknowledgement as already applied", async () => {
    const harness = await createHarness();
    const boundary = await armBoundary(harness);
    const tx2 = new ScriptedClient(
      commitAckUnknownTx2Steps(boundary.authority),
    );
    const proof = new ScriptedClient(teardownProofSteps("committed"));
    harness.pool.enqueue(tx2);
    harness.pool.enqueue(proof);
    const write = immediateConsoleWrite();
    const watchdog = await createWatchdog();

    const result = await harness.store.dispatchAfterProviderBoundary(
      boundary.permit,
      boundary.guarded,
      watchdog.armed,
    );

    expect(result.kind).toBe("persistence-unknown");
    if (result.kind !== "persistence-unknown") {
      throw new Error("Expected a COMMIT acknowledgement uncertainty.");
    }
    const terminal = tx2.calls.find(
      ({ name }) => name === "tx2-terminal",
    );
    expect(terminal).toBeDefined();
    expect(terminal!.values).toHaveLength(21);
    expect(terminal!.values[14]).toBe("sent");
    const providerMessageId = text(
      terminal!.values[15],
      "provider message ID",
    );
    expect(
      tx2.calls.slice(-2).map(({ name }) => name),
    ).toEqual(["tx2-terminal", "tx2-commit-ack-unknown"]);
    expect(write).toHaveBeenCalledOnce();
    expectExactTeardownProof(tx2, proof);
    tx2.assertExhausted();
    proof.assertExhausted();
    await disarmSafeResult(harness.store, watchdog, result);

    const finalizer = new ScriptedClient(
      finalizerSteps(
        boundary.authority,
        providerMessageId,
        "already-applied",
      ),
    );
    harness.pool.enqueue(finalizer);
    const recovered =
      await harness.store.finishGuardedDispatchUnknown(
        result.uncertainty,
      );

    expect(recovered).toEqual({
      result: { kind: "already-applied" },
      exit: { kind: "sent", providerMessageId },
    });
    expect(write).toHaveBeenCalledOnce();
    finalizer.assertExhausted();
    expect(finalizer.releaseCalls).toEqual([false]);
    const connections = harness.pool.connectCalls.length;
    await expect(
      harness.store.finishGuardedDispatchUnknown(result.uncertainty),
    ).resolves.toBeNull();
    expect(harness.pool.connectCalls).toHaveLength(connections);
    expect(write).toHaveBeenCalledOnce();
  });

  it("destroys and proves TX2 teardown when the post-provider aggregate deadline expires", async () => {
    const harness = await createHarness();
    const boundary = await armBoundary(harness);
    const pendingTerminal =
      deferred<Readonly<{ rows: Rows }>>();
    const tx2 = new ScriptedClient(
      postProviderHungTx2Steps(
        boundary.authority,
        pendingTerminal.promise,
      ),
    );
    const proof = new ScriptedClient(teardownProofSteps());
    harness.pool.enqueue(tx2);
    harness.pool.enqueue(proof);
    const write = immediateConsoleWrite();
    const watchdog = await createWatchdog();
    vi.useFakeTimers();

    const operation = harness.store.dispatchAfterProviderBoundary(
      boundary.permit,
      boundary.guarded,
      watchdog.armed,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(
      tx2.calls.some(({ name }) => name === "tx2-terminal-hung"),
    ).toBe(true);
    expect(write).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(6_001);
    const result = await operation;
    vi.useRealTimers();

    expect(result.kind).toBe("persistence-unknown");
    expectExactTeardownProof(tx2, proof);
    expect(write).toHaveBeenCalledOnce();
    tx2.assertExhausted();
    proof.assertExhausted();
    pendingTerminal.resolve({ rows: [] });
    await Promise.resolve();
    await disarmSafeResult(harness.store, watchdog, result);
  });

  it("combines real-store callback-zero on TX2 acquisition timeout with late-client destruction", async () => {
    const realDispatch = await runFatalScenario("acquire-timeout");
    expect(
      realDispatch.code !== 0 || realDispatch.signal !== null,
    ).toBe(true);
    expect(realDispatch.stderr).toBe("");
    expect(realDispatch.stdout.trimEnd().split("\n")).toEqual([
      "TX1_BEGIN",
      "TX1_COMMIT",
      "TX1_RELEASE_FALSE",
      "READY",
      "TX2_CONNECT",
    ]);
    expect(realDispatch.stdout).not.toContain("PROVIDER_START\n");

    vi.useFakeTimers();
    const connection = deferred<OutboxPgClient>();
    const lateClient = new ScriptedClient([]);
    const acquisition = connectMailDispatchDbWithin({
      pool: { connect: () => connection.promise },
      deadline: createMailDispatchDbDeadline({
        phase: "pool-acquire",
        budgetMs: 17,
      }),
    });
    const rejected = expect(acquisition).rejects.toBeInstanceOf(
      MailDispatchDbDeadlineExceededError,
    );

    await vi.advanceTimersByTimeAsync(17);
    await rejected;
    expect(lateClient.releaseCalls).toEqual([]);

    connection.resolve(lateClient);
    await vi.runAllTimersAsync();

    expect(lateClient.releaseCalls).toEqual([true]);
    lateClient.assertExhausted();
  });

  it.each([
    [
      "pre-provider-hang",
      [
        "TX2_CONNECT",
        "TX2_BEGIN",
        "PRE_PROVIDER_QUERY_STARTED",
        "TX2_RELEASE_TRUE",
      ],
    ],
    [
      "post-init-arm-failure",
      [
        "TX2_CONNECT",
        "TX2_BEGIN",
        "PROVIDER_START",
        "POST_INIT_ARM_FAILED",
      ],
    ],
    [
      "provider-unsettled",
      ["TX2_CONNECT", "TX2_BEGIN", "PROVIDER_START"],
    ],
    [
      "unarmed-watchdog",
      ["WATCHDOG_DISARMED"],
    ],
    [
      "already-claimed-watchdog",
      ["TX2_CONNECT", "FIRST_DISPATCH_PENDING"],
    ],
  ] as const)(
    "fails closed without unwind for isolated fatal scenario %s",
    { timeout: 20_000 },
    async (scenario, scenarioMarkers) => {
      const result = await runFatalScenario(scenario);
      const markers = result.stdout.trimEnd().split("\n");
      const expectedMarkers = [
        "TX1_BEGIN",
        "TX1_COMMIT",
        "TX1_RELEASE_FALSE",
        "READY",
        ...scenarioMarkers,
      ];

      expect(
        result.code !== 0 || result.signal !== null,
      ).toBe(true);
      expect(result.stderr).toBe("");
      expect(markers).toEqual(expectedMarkers);
      expect(result.stdout).not.toMatch(
        /(?:CATCH|FINALLY|SURVIVED|TOP_LEVEL_FAILED|UNCAUGHT|UNHANDLED)\n/u,
      );
      if (scenario === "already-claimed-watchdog") {
        expect(
          markers.filter((marker) => marker === "TX2_CONNECT"),
        ).toHaveLength(1);
      }
      if (
        scenario === "post-init-arm-failure"
        || scenario === "provider-unsettled"
      ) {
        expect(
          markers.filter((marker) =>
            /^(?:TX2_COMMIT|TX2_ROLLBACK|TX2_RELEASE_)/u.test(marker)
          ),
        ).toEqual([]);
      }
    },
  );

  it("rejects an authentic permit at another store before connection or provider invocation", async () => {
    const first = await createHarness();
    const boundary = await armBoundary(first);
    const second = await createHarness();
    const watchdog = await createWatchdog();
    const write = vi.spyOn(process.stdout, "write");

    await expect(
      second.store.dispatchAfterProviderBoundary(
        boundary.permit,
        boundary.guarded,
        watchdog.armed,
      ),
    ).rejects.toThrow("Outbox provider permit is invalid.");

    expect(second.pool.connectCalls).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();
    expect(
      discardGuardedPreparedDispatch(
        first.store,
        boundary.permit,
        boundary.guarded,
      ),
    ).toBe(true);
    await disarmMailDispatchHardWatchdog(watchdog.armed);
    await watchdog.controller.close();
    watchdogs.delete(watchdog);
  });
});
