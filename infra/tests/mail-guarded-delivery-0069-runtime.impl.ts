#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";

import {
  disarmMailDispatchHardWatchdog,
  startMailDispatchHardWatchdog,
  type ArmedMailDispatchHardWatchdog,
  type MailDispatchHardWatchdog,
} from "../../src/lib/notifications/mail-dispatch-hard-watchdog";
import { reconcileGmailDelivery } from "../../src/lib/notifications/gmail-reconciliation";
import { createMailDispatchBootstrapResources } from "../../src/lib/notifications/mail-dispatch-pool";
import { inspectMailDispatchRuntime } from "../../src/lib/notifications/mail-dispatch-runtime-startup";
import { captureMailTransportConfiguration } from "../../src/lib/notifications/mailer-transport-internal";
import {
  createMaterializedDispatch,
  materializedDispatchEnvelope,
  type GuardedPreparedDispatch,
  type PreparedDispatchEnvelope,
} from "../../src/lib/notifications/prepared-dispatch-materialization";
import {
  authorizeCommittedPreparedDispatch,
  captureMailDispatchApplicationOrigin,
  discardCommittedPreparedDispatchReceipt,
  guardedDispatchResultSafeToDisarm,
  mailDispatchPreparedRuntimePlan,
  PostgresOutboxStore,
  releaseGuardedDispatchWatchdogClaim,
  type EmailOutboxPayload,
} from "../../src/lib/notifications/postgres-outbox-store";
import { outboxMessageId } from "../../src/lib/notifications/provider-correlation";
import { createResetPasswordSourceVariables } from "../../src/lib/notifications/revocable-source-authority";
import { resolveEmailTemplateAuthorityPolicy } from "../../src/lib/notifications/template-authority-policy";
import type {
  GuardedDispatchResult,
  OutboxClaim,
  ProviderCallPermit,
} from "../../src/lib/notifications/outbox-worker";
import {
  createPostgresCommitAckLossProxy,
  type PostgresCommitAckLossProxy,
} from "../../scripts/lib/postgres-race-proxy.mjs";

export type MailGuardedDeliveryRuntimeProofInput = Readonly<{
  adminDatabaseUrl: string;
  applicationDatabaseUrl: string;
  expectedPostgresMajor: 17 | 18;
  opsDatabaseUrl: string;
  workerDatabaseUrl: string;
}>;

const APPLICATION_URL = "https://codestead-runtime.invalid";
const FROM = "Codestead Runtime <runtime@codestead.invalid>";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const SCENARIO_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 8_000;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type Cleanup = Readonly<{
  label: string;
  close(): Promise<void>;
}>;

class OperationDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationDeadlineError";
  }
}

class ResourceRegistry {
  readonly #resources: Cleanup[] = [];

  add(resource: Cleanup): void {
    this.#resources.push(resource);
  }

  async close(): Promise<void> {
    const failures: unknown[] = [];
    const lateCleanups: Promise<void>[] = [];
    for (const resource of [...this.#resources].reverse()) {
      const operation = Promise.resolve().then(() => resource.close());
      try {
        await within(
          operation,
          CLEANUP_TIMEOUT_MS,
          `${resource.label} cleanup timed out`,
        );
      } catch (error) {
        failures.push(error);
        if (error instanceof OperationDeadlineError) {
          lateCleanups.push(operation);
        }
      }
    }
    this.#resources.length = 0;
    if (lateCleanups.length > 0) {
      try {
        const settlements = await within(
          Promise.allSettled(lateCleanups),
          CLEANUP_TIMEOUT_MS,
          "late runtime-proof cleanup observation timed out",
        );
        for (const settlement of settlements) {
          if (settlement.status === "rejected") {
            failures.push(settlement.reason);
          }
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Runtime proof cleanup failed");
    }
  }
}

function within<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new OperationDeadlineError(message)),
      timeoutMs,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function validatedDatabaseUrl(
  value: string,
  name: string,
  expectedRole: string,
): URL {
  const parsed = new URL(value);
  assert.equal(
    parsed.protocol,
    "postgresql:",
    `${name} must use the postgresql protocol`,
  );
  assert.ok(
    LOOPBACK_HOSTS.has(parsed.hostname),
    `${name} must target loopback`,
  );
  assert.ok(parsed.port, `${name} must specify an explicit port`);
  assert.notEqual(parsed.port, "5432", `${name} must not target port 5432`);
  assert.ok(parsed.pathname.length > 1, `${name} must specify a database`);
  assert.equal(
    decodeURIComponent(parsed.username),
    expectedRole,
    `${name} must authenticate as ${expectedRole}`,
  );
  const sslMode = parsed.searchParams.get("sslmode");
  assert.ok(
    sslMode === null || sslMode === "disable",
    `${name} must disable SSL on the disposable loopback cluster`,
  );
  parsed.searchParams.set("sslmode", "disable");
  return parsed;
}

function sameDatabase(left: URL, right: URL): boolean {
  return (
    left.hostname === right.hostname
    && left.port === right.port
    && left.pathname === right.pathname
  );
}

function poolUrl(base: URL, applicationName: string): string {
  const configured = new URL(base);
  configured.searchParams.set("application_name", applicationName);
  configured.searchParams.set("connect_timeout", "3");
  configured.searchParams.set("sslmode", "disable");
  return configured.toString();
}

function trackedPool(
  registry: ResourceRegistry,
  base: URL,
  applicationName: string,
  maximumConnections: number,
): Pool {
  const pool = new Pool({
    connectionString: poolUrl(base, applicationName),
    max: maximumConnections,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 5_000,
  });
  registry.add({
    label: `pool:${applicationName}`,
    close: () => pool.end(),
  });
  return pool;
}

type Runtime = Readonly<{
  pool: Pool;
  store: PostgresOutboxStore;
}>;

async function createRuntime(
  registry: ResourceRegistry,
  workerUrl: URL,
  expectedPostgresMajor: 17 | 18,
  applicationName: string,
): Promise<Runtime> {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = poolUrl(workerUrl, applicationName);
  let resources: ReturnType<typeof createMailDispatchBootstrapResources>;
  try {
    resources = createMailDispatchBootstrapResources();
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
  registry.add({
    label: `runtime-pool:${applicationName}`,
    close: () => resources.pool.end(),
  });
  const inspection = await inspectMailDispatchRuntime(resources.pool);
  assert.equal(
    inspection.postgresMajor,
    expectedPostgresMajor,
    "runtime inspected the wrong PostgreSQL major",
  );
  const origin = captureMailDispatchApplicationOrigin(inspection);
  return Object.freeze({
    pool: resources.pool,
    store: new PostgresOutboxStore(resources.pool, inspection, origin),
  });
}

type Fixture = Readonly<{
  email: string;
  id: string;
  idempotencyKey: string;
  label: string;
  name: string;
  operationId: string;
  token: string;
  userId: string;
  variables: Readonly<Record<string, string>>;
  verificationId: string;
}>;

function createFixture(label: string): Fixture {
  const nonce = randomUUID();
  const id = randomUUID();
  const operationId = randomUUID();
  const verificationId = randomUUID();
  const token = sha256(`reset:${nonce}`).slice(0, 32);
  const name = `Runtime ${label}`;
  const userId = `mail-runtime-${label}-${nonce}`;
  const url =
    `${APPLICATION_URL}/api/auth/reset-password/${token}`
    + `?callbackURL=${encodeURIComponent(`${APPLICATION_URL}/reset-password`)}`;
  const variables = createResetPasswordSourceVariables({
    applicationUrl: APPLICATION_URL,
    name,
    token,
    url,
    verificationId,
  });
  assert.ok(variables, "canonical reset-password variables were not issued");
  return Object.freeze({
    email: `${label}-${nonce}@example.invalid`,
    id,
    idempotencyKey: sha256(`runtime:${label}:${id}`),
    label,
    name,
    operationId,
    token,
    userId,
    variables,
    verificationId,
  });
}

async function inTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let began = false;
  let destroy = false;
  try {
    await client.query("begin");
    began = true;
    const result = await work(client);
    await client.query("commit");
    began = false;
    return result;
  } catch (operationError) {
    if (began) {
      try {
        await client.query("rollback");
      } catch (cleanupError) {
        destroy = true;
        throw new AggregateError(
          [operationError, cleanupError],
          "Runtime fixture operation and rollback both failed",
        );
      }
    }
    throw operationError;
  } finally {
    client.release(destroy);
  }
}

async function seedFixture(
  adminPool: Pool,
  applicationPool: Pool,
  fixture: Fixture,
): Promise<void> {
  await inTransaction(adminPool, async (client) => {
    await client.query(
      `insert into public."user" (
         id, name, email, email_verified, role, status, banned,
         must_change_password
       ) values ($1, $2, $3, true, 'learner', 'active', false, false)`,
      [fixture.userId, fixture.name, fixture.email],
    );
    await client.query(
      `insert into public.verification (
         id, identifier, value, expires_at
       ) values (
         $1, $2, $3, pg_catalog.statement_timestamp() + interval '30 minutes'
       )`,
      [
        fixture.verificationId,
        `reset-password:${fixture.token}`,
        fixture.userId,
      ],
    );
  });

  const receipt = await inTransaction(applicationPool, async (client) => {
    await client.query(
      `insert into public.email_outbox (
         id, operation_id, user_id, delivery_scope_key, to_email, template,
         template_version, variables, idempotency_key,
         idempotency_authority_version, status, next_attempt_at
       ) values (
         $1::uuid, $2::uuid, $3::text, $4::text, $5::text,
         'reset-password', '1', $6::jsonb, $7::text, 'event-v1-native',
         'pending', pg_catalog.transaction_timestamp()
       )`,
      [
        fixture.id,
        fixture.operationId,
        fixture.userId,
        `a:${fixture.userId}`,
        fixture.email,
        JSON.stringify(fixture.variables),
        fixture.idempotencyKey,
      ],
    );
    const released = await client.query<{ release_receipt_sha256: string }>(
      `select release.release_receipt_sha256
         from public.release_email_outbox_delivery(
           $1::uuid,
           $2::uuid,
           $3::text,
           (
             select outbox.idempotency_original_payload_sha256
               from public.email_outbox as outbox
              where outbox.id = $1::uuid
           ),
           'task7-v1'
         ) as release`,
      [fixture.id, fixture.operationId, fixture.idempotencyKey],
    );
    assert.equal(released.rows.length, 1);
    return released.rows[0]!.release_receipt_sha256;
  });
  assert.match(receipt, SHA256);
}

async function claimFixture(
  runtime: Runtime,
  fixture: Fixture,
): Promise<OutboxClaim<EmailOutboxPayload>> {
  const claim = await runtime.store.claimNext({
    leaseMs: 60_000,
    owner: `mail-runtime:${fixture.label}`,
    token: randomUUID(),
  });
  assert.ok(claim, `fixture ${fixture.label} was not claimed`);
  assert.equal(claim.id, fixture.id, `fixture ${fixture.label} lost claim order`);
  return claim;
}

function envelopeFor(
  runtime: Runtime,
  claim: OutboxClaim<EmailOutboxPayload>,
  adapter: "console" | "gmail" = "console",
): PreparedDispatchEnvelope {
  const policy = resolveEmailTemplateAuthorityPolicy(
    claim.payload.template,
    claim.payload.templateVersion,
  );
  assert.ok(policy, "runtime fixture template policy is invalid");
  const materialized = createMaterializedDispatch({
    source: Object.freeze({
      applicationUrl: APPLICATION_URL,
      outboxId: claim.id,
      operationId: claim.operationId,
      claimToken: claim.claimToken,
      claimOwner: claim.claimOwner,
      claimVersion: claim.claimVersion,
      deliveryScopeKey: claim.deliveryScopeKey,
      recipient: claim.payload.to,
      template: policy.template,
      templateVersion: claim.payload.templateVersion,
      variables: Object.freeze({ ...claim.payload.variables }),
    }),
    adapter,
    from: FROM,
    messageId: outboxMessageId(claim.operationId),
    runtimePlan: mailDispatchPreparedRuntimePlan(runtime.store),
    transportConfiguration: captureMailTransportConfiguration(adapter),
  });
  const envelope = materializedDispatchEnvelope(materialized);
  assert.ok(envelope, "runtime materialization did not issue an envelope");
  return envelope;
}

type ArmedBoundary = Readonly<{
  claim: OutboxClaim<EmailOutboxPayload>;
  guarded: GuardedPreparedDispatch;
  permit: ProviderCallPermit;
}>;

async function beginProviderBoundary(
  runtime: Runtime,
  fixture: Fixture,
  adapter: "console" | "gmail" = "console",
) {
  const claim = await claimFixture(runtime, fixture);
  const boundary = await runtime.store.beginProviderCall(claim, {
    adapter,
    envelope: envelopeFor(runtime, claim, adapter),
  });
  assert.equal(boundary.kind, "applied");
  if (boundary.kind !== "applied") {
    throw new Error("TX1 failed to issue provider authority");
  }
  return Object.freeze({ boundary, claim });
}

async function armBoundary(
  runtime: Runtime,
  fixture: Fixture,
  adapter: "console" | "gmail" = "console",
): Promise<ArmedBoundary> {
  const { boundary, claim } = await beginProviderBoundary(
    runtime,
    fixture,
    adapter,
  );
  const guarded = await authorizeCommittedPreparedDispatch(
    runtime.store,
    boundary.receipt,
  );
  return Object.freeze({
    claim,
    guarded,
    permit: boundary.permit,
  });
}

async function armAbandonedProviderBoundary(
  runtime: Runtime,
  fixture: Fixture,
  adapter: "console" | "gmail",
): Promise<void> {
  const { boundary } = await beginProviderBoundary(runtime, fixture, adapter);
  assert.equal(
    discardCommittedPreparedDispatchReceipt(
      runtime.store,
      boundary.permit,
      boundary.receipt,
    ),
    true,
    "abandoned provider boundary receipt was not discarded",
  );
}


type PersistedAuthority = Readonly<{
  providerMessageId: string | null;
  providerRequestBodyLength: number;
  providerRequestBodySha256: string;
  status: string;
}>;

async function persistedAuthority(
  adminPool: Pool,
  fixture: Fixture,
): Promise<PersistedAuthority> {
  const result = await adminPool.query<{
    provider_message_id: string | null;
    provider_request_body_length: string;
    provider_request_body_sha256: string;
    status: string;
  }>(
    `select status::text, provider_message_id,
            provider_request_body_sha256,
            provider_request_body_length::text
       from public.email_outbox
      where id = $1::uuid`,
    [fixture.id],
  );
  assert.equal(result.rows.length, 1);
  const row = result.rows[0]!;
  const length = Number(row.provider_request_body_length);
  assert.ok(Number.isSafeInteger(length) && length >= 0);
  assert.match(row.provider_request_body_sha256, SHA256);
  return Object.freeze({
    providerMessageId: row.provider_message_id,
    providerRequestBodyLength: length,
    providerRequestBodySha256: row.provider_request_body_sha256,
    status: row.status,
  });
}

type ConsoleWriteCapture = Readonly<{
  bytes(): Buffer;
  readonly started: Promise<void>;
  release(): void;
  restore(): void;
  writes(): number;
}>;

function captureConsoleWrite(holdCallback: boolean): ConsoleWriteCapture {
  const original = process.stdout.write;
  let captured = Buffer.alloc(0);
  let callback: ((error?: Error | null) => void) | undefined;
  let writeCount = 0;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const replacement = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    maybeCallback?: (error?: Error | null) => void,
  ): boolean => {
    assert.equal(writeCount, 0, "console provider wrote more than once");
    writeCount += 1;
    const encoding =
      typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
    callback =
      typeof encodingOrCallback === "function"
        ? encodingOrCallback
        : maybeCallback;
    captured = typeof chunk === "string"
      ? Buffer.from(chunk, encoding)
      : Buffer.from(chunk);
    resolveStarted();
    if (!holdCallback) queueMicrotask(() => callback?.());
    return true;
  };
  assert.equal(Reflect.set(process.stdout, "write", replacement), true);
  return Object.freeze({
    bytes: () => Buffer.from(captured),
    started,
    release() {
      const pending = callback;
      callback = undefined;
      pending?.();
    },
    restore() {
      assert.equal(Reflect.set(process.stdout, "write", original), true);
    },
    writes: () => writeCount,
  });
}

type WatchdogLease = Readonly<{
  armed: ArmedMailDispatchHardWatchdog;
  controller: MailDispatchHardWatchdog;
}>;

async function createWatchdog(): Promise<WatchdogLease> {
  const controller = await startMailDispatchHardWatchdog();
  try {
    return Object.freeze({ armed: await controller.arm(), controller });
  } catch (error) {
    await controller.close();
    throw error;
  }
}

async function disarmAfterSafeResult(
  runtime: Runtime,
  watchdog: WatchdogLease,
  result: GuardedDispatchResult,
): Promise<void> {
  assert.equal(
    guardedDispatchResultSafeToDisarm(
      runtime.store,
      watchdog.armed,
      result,
    ),
    true,
    "store result was not safe to disarm",
  );
  await disarmMailDispatchHardWatchdog(watchdog.armed);
  assert.equal(
    releaseGuardedDispatchWatchdogClaim(runtime.store, watchdog.armed),
    true,
    "watchdog claim was not released",
  );
  await watchdog.controller.close();
}

async function assertTx2ObserverBlocked(
  observerPool: Pool,
  fixture: Fixture,
): Promise<void> {
  const scope = await observerPool.query<{ locked: boolean }>(
    `select pg_catalog.pg_try_advisory_xact_lock(
       pg_catalog.hashtext($1)::pg_catalog.int8
     ) as locked`,
    [`user-authority:${fixture.userId}`],
  );
  assert.equal(scope.rows[0]?.locked, false, "TX2 scope lock was not held");
  let rowLockCode: string | undefined;
  try {
    await observerPool.query(
      `select id from public.email_outbox
        where id = $1::uuid for update nowait`,
      [fixture.id],
    );
  } catch (error) {
    rowLockCode =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
  }
  assert.equal(rowLockCode, "55P03", "TX2 row lock was not held");
}

async function proveExactByteHappyPath(
  runtime: Runtime,
  adminPool: Pool,
  applicationPool: Pool,
  observerPool: Pool,
): Promise<void> {
  const fixture = createFixture("exact-byte");
  await seedFixture(adminPool, applicationPool, fixture);
  const boundary = await armBoundary(runtime, fixture);
  const authority = await persistedAuthority(adminPool, fixture);
  const capture = captureConsoleWrite(true);
  try {
    const watchdog = await createWatchdog();
    const operation = runtime.store.dispatchAfterProviderBoundary(
      boundary.permit,
      boundary.guarded,
      watchdog.armed,
    );
    await within(
      capture.started,
      5_000,
      "physical console provider did not start",
    );
    await assertTx2ObserverBlocked(observerPool, fixture);
    assert.equal(
      sha256(capture.bytes()),
      authority.providerRequestBodySha256,
      "physical provider bytes diverged from TX1 digest",
    );
    assert.equal(
      capture.bytes().byteLength,
      authority.providerRequestBodyLength,
      "physical provider byte length diverged from TX1",
    );
    capture.release();
    const result = await within(
      operation,
      SCENARIO_TIMEOUT_MS,
      "exact-byte TX2 did not settle",
    );
    assert.equal(result.kind, "applied");
    assert.equal(
      result.kind === "applied" ? result.exit.kind : null,
      "sent",
    );
    if (result.kind === "applied" && result.exit.kind === "sent") {
      assert.match(result.exit.providerMessageId, /^console-[0-9a-f-]{36}$/u);
    }
    await disarmAfterSafeResult(runtime, watchdog, result);
  } finally {
    capture.release();
    capture.restore();
  }
  assert.equal(capture.writes(), 1);
  const terminal = await persistedAuthority(adminPool, fixture);
  assert.equal(terminal.status, "sent");
  assert.match(terminal.providerMessageId ?? "", /^console-[0-9a-f-]{36}$/u);
}

async function assertExactBytes(
  adminPool: Pool,
  fixture: Fixture,
  bytes: Buffer,
): Promise<void> {
  const authority = await persistedAuthority(adminPool, fixture);
  assert.equal(sha256(bytes), authority.providerRequestBodySha256);
  assert.equal(bytes.byteLength, authority.providerRequestBodyLength);
}

async function dispatch(
  runtime: Runtime,
  boundary: ArmedBoundary,
): Promise<GuardedDispatchResult> {
  const watchdog = await createWatchdog();
  const result = await within(
    runtime.store.dispatchAfterProviderBoundary(
      boundary.permit,
      boundary.guarded,
      watchdog.armed,
    ),
    SCENARIO_TIMEOUT_MS,
    "guarded TX2 did not settle",
  );
  await disarmAfterSafeResult(runtime, watchdog, result);
  return result;
}

type Restore = () => Promise<void>;

async function proveCallbackZero(
  runtime: Runtime,
  adminPool: Pool,
  applicationPool: Pool,
  label: string,
  mutate: (fixture: Fixture) => Promise<Restore | undefined>,
): Promise<void> {
  const fixture = createFixture(label);
  await seedFixture(adminPool, applicationPool, fixture);
  const boundary = await armBoundary(runtime, fixture);
  const restore = await mutate(fixture);
  const capture = captureConsoleWrite(false);
  try {
    const result = await dispatch(runtime, boundary);
    assert.deepEqual(result, { kind: "lost" });
  } finally {
    capture.restore();
    await restore?.();
  }
  assert.equal(capture.writes(), 0, `${label} reached the provider callback`);
  const row = await persistedAuthority(adminPool, fixture);
  assert.equal(row.status, "sending");
  assert.equal(row.providerMessageId, null);
}

async function mutateUserStatus(
  adminPool: Pool,
  fixture: Fixture,
  status: "active" | "suspended",
): Promise<void> {
  await inTransaction(adminPool, async (client) => {
    await client.query(
      `select pg_catalog.pg_advisory_xact_lock(
         pg_catalog.hashtext($1)::pg_catalog.int8
       )`,
      [`user-authority:${fixture.userId}`],
    );
    const updated = await client.query(
      `update public."user" set status = $2
        where id = $1 returning id`,
      [fixture.userId, status],
    );
    assert.equal(updated.rowCount, 1);
  });
}

async function proveAuthorityMismatch(
  runtime: Runtime,
  adminPool: Pool,
  applicationPool: Pool,
): Promise<void> {
  await proveCallbackZero(
    runtime,
    adminPool,
    applicationPool,
    "authority-mismatch",
    async (fixture) => {
      await mutateUserStatus(adminPool, fixture, "suspended");
      return () => mutateUserStatus(adminPool, fixture, "active");
    },
  );
}

async function proveSourceMismatch(
  runtime: Runtime,
  adminPool: Pool,
  applicationPool: Pool,
): Promise<void> {
  await proveCallbackZero(
    runtime,
    adminPool,
    applicationPool,
    "source-mismatch",
    async (fixture) => {
      await inTransaction(adminPool, async (client) => {
        await client.query(
          `select pg_catalog.pg_advisory_xact_lock(
             pg_catalog.hashtext($1)::pg_catalog.int8
           )`,
          [`user-authority:${fixture.userId}`],
        );
        const deleted = await client.query(
          `delete from public.verification
            where id = $1 returning id`,
          [fixture.verificationId],
        );
        assert.equal(deleted.rowCount, 1);
      });
      return undefined;
    },
  );
}

type AlwaysTriggerSpec = Readonly<{
  disableSql: string;
  enableSql: string;
  name: string;
  relation: "public.email_outbox" | "public.mail_delivery_release_receipt";
}>;

const REQUEST_BODY_TRIGGER: AlwaysTriggerSpec = Object.freeze({
  disableSql: `alter table only public.email_outbox
    disable trigger email_outbox_provider_request_body_immutable`,
  enableSql: `alter table only public.email_outbox
    enable always trigger email_outbox_provider_request_body_immutable`,
  name: "email_outbox_provider_request_body_immutable",
  relation: "public.email_outbox",
});

const RELEASE_RECEIPT_TRIGGER: AlwaysTriggerSpec = Object.freeze({
  disableSql: `alter table public.mail_delivery_release_receipt
    disable trigger mail_delivery_release_receipt_append_only`,
  enableSql: `alter table public.mail_delivery_release_receipt
    enable always trigger mail_delivery_release_receipt_append_only`,
  name: "mail_delivery_release_receipt_append_only",
  relation: "public.mail_delivery_release_receipt",
});

const DELIVERY_HOLD_TRIGGER: AlwaysTriggerSpec = Object.freeze({
  disableSql: `alter table only public.email_outbox
    disable trigger email_outbox_delivery_hold`,
  enableSql: `alter table only public.email_outbox
    enable always trigger email_outbox_delivery_hold`,
  name: "email_outbox_delivery_hold",
  relation: "public.email_outbox",
});

const DELIVERY_HOLD_FINAL_TRIGGER: AlwaysTriggerSpec = Object.freeze({
  disableSql: `alter table only public.email_outbox
    disable trigger email_outbox_delivery_hold_final`,
  enableSql: `alter table only public.email_outbox
    enable always trigger email_outbox_delivery_hold_final`,
  name: "email_outbox_delivery_hold_final",
  relation: "public.email_outbox",
});

async function assertAlwaysTriggerState(
  client: PoolClient,
  trigger: AlwaysTriggerSpec,
  expected: "A" | "D",
): Promise<void> {
  const state = await client.query<{ tgenabled: string }>(
    `select trigger_row.tgenabled
       from pg_catalog.pg_trigger as trigger_row
      where trigger_row.tgrelid = $1::pg_catalog.regclass
        and trigger_row.tgname = $2
        and not trigger_row.tgisinternal`,
    [trigger.relation, trigger.name],
  );
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0]!.tgenabled, expected);
}

async function assertAlwaysTriggerRestored(
  pool: Pool,
  trigger: AlwaysTriggerSpec,
): Promise<void> {
  await inTransaction(pool, (client) =>
    assertAlwaysTriggerState(client, trigger, "A"));
}

async function mutateWithAlwaysTriggerDisabled(
  client: PoolClient,
  trigger: AlwaysTriggerSpec,
  mutation: () => Promise<void>,
): Promise<void> {
  await assertAlwaysTriggerState(client, trigger, "A");
  await client.query(trigger.disableSql);
  await assertAlwaysTriggerState(client, trigger, "D");
  let operationError: unknown;
  try {
    await mutation();
  } catch (error) {
    operationError = error;
  }
  let restorationError: unknown;
  try {
    await client.query(trigger.enableSql);
    await assertAlwaysTriggerState(client, trigger, "A");
  } catch (error) {
    restorationError = error;
  }
  if (operationError !== undefined && restorationError !== undefined) {
    throw new AggregateError(
      [operationError, restorationError],
      `Mutation and ${trigger.name} restoration both failed`,
    );
  }
  if (operationError !== undefined) throw operationError;
  if (restorationError !== undefined) throw restorationError;
}

async function mutateRequestBodyWithDeliveryGuardsDisabled(
  client: PoolClient,
  mutation: () => Promise<void>,
): Promise<void> {
  await mutateWithAlwaysTriggerDisabled(
    client,
    DELIVERY_HOLD_TRIGGER,
    () => mutateWithAlwaysTriggerDisabled(
      client,
      DELIVERY_HOLD_FINAL_TRIGGER,
      () => mutateWithAlwaysTriggerDisabled(
        client,
        REQUEST_BODY_TRIGGER,
        mutation,
      ),
    ),
  );
}

async function setReplicaRole(client: PoolClient): Promise<void> {
  await client.query("set local session_replication_role = replica");
}

const INT4_MAX = 2_147_483_647;
const COUNTER_DUE_AT = "2000-01-01T00:00:00.000Z";
const COUNTER_FOLLOWER_DUE_AT = "2000-01-02T00:00:00.000Z";
const COUNTER_EXPIRED_LEASE_AT = "2000-01-03T00:00:00.000Z";


type CounterProofRow = Readonly<{
  adapter: string | null;
  attempt_count: number;
  claim_owner: string | null;
  claim_token: string | null;
  claim_version: number;
  created_at: string;
  delivery_hold_version: string;
  delivery_release_insert_system_identifier: string | null;
  delivery_release_insert_xid: string | null;
  delivery_scope_key: string;
  dispatch_binding_sha256: string | null;
  dispatch_binding_version: string | null;
  idempotency_authority_sha256: string;
  idempotency_authority_version: string;
  idempotency_key: string;
  idempotency_original_payload_sha256: string;
  last_error_code: string | null;
  lease_expires_at: string | null;
  next_attempt_at: string;
  operation_id: string;
  provider_call_started: string | null;
  provider_correlation_version: string | null;
  provider_evidence_sha256: string | null;
  provider_evidence_version: string | null;
  provider_message_id: string | null;
  provider_request_body_length: string | null;
  provider_request_body_sha256: string | null;
  quarantined_at: string | null;
  release_receipt_sha256: string;
  sent_at: string | null;
  status: string;
  template: string;
  template_version: string;
  to_email: string;
  updated_at: string;
  user_id: string | null;
  variables_json: string;
}>;

type CounterFixtureMutation = Readonly<{
  attemptCount: number;
  claimOwner?: string;
  claimToken?: string;
  claimVersion: number;
  fixture: Fixture;
  leaseExpiresAt?: string;
  nextAttemptAt: string;
  status: "pending" | "sending";
}>;

async function readCounterProofRow(
  adminPool: Pool,
  fixture: Fixture,
): Promise<CounterProofRow> {
  const result = await adminPool.query<CounterProofRow>(
    `select status::text, attempt_count, claim_token::text, claim_owner,
            claim_version, lease_expires_at::text, last_error_code,
            next_attempt_at::text, user_id, operation_id::text,
            delivery_scope_key, to_email, template, template_version,
            variables::text as variables_json, idempotency_key,
            idempotency_authority_version, idempotency_authority_sha256,
            idempotency_original_payload_sha256,
            created_at::text, updated_at::text, delivery_hold_version,
            delivery_release_insert_xid::text,
            delivery_release_insert_system_identifier::text,
            provider_call_started::text, adapter,
            dispatch_binding_version, dispatch_binding_sha256,
            provider_correlation_version, provider_evidence_version,
            provider_evidence_sha256, provider_request_body_sha256,
            provider_request_body_length::text, provider_message_id,
            sent_at::text, quarantined_at::text,
            (
              select release.release_receipt_sha256
                from public.mail_delivery_release_receipt as release
               where release.outbox_id = email_outbox.id
            ) as release_receipt_sha256
       from public.email_outbox
      where id = $1::uuid`,
    [fixture.id],
  );
  assert.equal(result.rows.length, 1, `${fixture.label} row is missing`);
  return result.rows[0]!;
}

type ReleaseAuthorityEvidence = Readonly<{
  idempotency_authority_sha256: string;
  idempotency_authority_version: string;
  idempotency_original_payload_sha256: string;
  operation_id: string;
  outbox_id: string;
  release_receipt_sha256: string;
  release_version: string;
  released_at: string;
}>;

async function releaseAuthorityEvidence(
  adminPool: Pool,
  fixture: Fixture,
): Promise<ReleaseAuthorityEvidence> {
  const result = await adminPool.query<ReleaseAuthorityEvidence>(
    `select outbox_id::text, operation_id::text,
            idempotency_authority_version,
            idempotency_authority_sha256,
            idempotency_original_payload_sha256,
            release_version, release_receipt_sha256,
            released_at::text
       from public.mail_delivery_release_receipt
      where outbox_id = $1::uuid`,
    [fixture.id],
  );
  assert.equal(
    result.rows.length,
    1,
    `${fixture.label} release receipt is missing`,
  );
  return result.rows[0]!;
}
function replayAndDeliveryBindingEvidence(row: CounterProofRow) {
  return {
    adapter: row.adapter,
    createdAt: row.created_at,
    deliveryHoldVersion: row.delivery_hold_version,
    deliveryReleaseInsertSystemIdentifier:
      row.delivery_release_insert_system_identifier,
    deliveryReleaseInsertXid: row.delivery_release_insert_xid,
    deliveryScopeKey: row.delivery_scope_key,
    dispatchBindingSha256: row.dispatch_binding_sha256,
    dispatchBindingVersion: row.dispatch_binding_version,
    idempotencyAuthoritySha256: row.idempotency_authority_sha256,
    idempotencyAuthorityVersion: row.idempotency_authority_version,
    idempotencyKey: row.idempotency_key,
    idempotencyOriginalPayloadSha256:
      row.idempotency_original_payload_sha256,
    nextAttemptAt: row.next_attempt_at,
    operationId: row.operation_id,
    providerCallStarted: row.provider_call_started,
    providerCorrelationVersion: row.provider_correlation_version,
    providerEvidenceSha256: row.provider_evidence_sha256,
    providerEvidenceVersion: row.provider_evidence_version,
    providerRequestBodyLength: row.provider_request_body_length,
    providerRequestBodySha256: row.provider_request_body_sha256,
    releaseReceiptSha256: row.release_receipt_sha256,
    template: row.template,
    templateVersion: row.template_version,
    userId: row.user_id,
  };
}

function claimAndAttemptEvidence(row: CounterProofRow) {
  return {
    attemptCount: row.attempt_count,
    claimOwner: row.claim_owner,
    claimToken: row.claim_token,
    claimVersion: row.claim_version,
    leaseExpiresAt: row.lease_expires_at,
  };
}

function redactionPreservedEvidence(row: CounterProofRow) {
  return {
    ...replayAndDeliveryBindingEvidence(row),
    ...claimAndAttemptEvidence(row),
    lastErrorCode: row.last_error_code,
    providerMessageId: row.provider_message_id,
    quarantinedAt: row.quarantined_at,
    sentAt: row.sent_at,
    status: row.status,
  };
}
function payloadProviderScheduleEvidence(row: CounterProofRow) {
  return {
    schedule: row.next_attempt_at,
    payload: {
      userId: row.user_id,
      operationId: row.operation_id,
      deliveryScopeKey: row.delivery_scope_key,
      recipient: row.to_email,
      template: row.template,
      templateVersion: row.template_version,
      variables: row.variables_json,
      idempotencyKey: row.idempotency_key,
      idempotencyAuthorityVersion: row.idempotency_authority_version,
      idempotencyAuthoritySha256: row.idempotency_authority_sha256,
      idempotencyOriginalPayloadSha256:
        row.idempotency_original_payload_sha256,
    },
    provider: {
      providerCallStarted: row.provider_call_started,
      adapter: row.adapter,
      dispatchBindingVersion: row.dispatch_binding_version,
      dispatchBindingSha256: row.dispatch_binding_sha256,
      providerCorrelationVersion: row.provider_correlation_version,
      providerEvidenceVersion: row.provider_evidence_version,
      providerEvidenceSha256: row.provider_evidence_sha256,
      providerRequestBodySha256: row.provider_request_body_sha256,
      providerRequestBodyLength: row.provider_request_body_length,
      providerMessageId: row.provider_message_id,
      sentAt: row.sent_at,
      quarantinedAt: row.quarantined_at,
    },
  };
}

function retirementEvidence(row: CounterProofRow) {
  return {
    attemptCount: row.attempt_count,
    ...payloadProviderScheduleEvidence(row),
  };
}

async function mutateCounterFixtures(
  adminPool: Pool,
  mutations: readonly CounterFixtureMutation[],
): Promise<void> {
  assert.ok(mutations.length > 0, "counter fixture mutations must not be empty");
  await inTransaction(adminPool, async (client) => {
    await mutateWithAlwaysTriggerDisabled(
      client,
      DELIVERY_HOLD_TRIGGER,
      () => mutateWithAlwaysTriggerDisabled(
        client,
        DELIVERY_HOLD_FINAL_TRIGGER,
        async () => {
          for (const mutation of mutations) {
            const sending = mutation.status === "sending";
            assert.equal(
              mutation.claimToken !== undefined,
              sending,
              `${mutation.fixture.label} claim token/state mismatch`,
            );
            assert.equal(
              mutation.claimOwner !== undefined,
              sending,
              `${mutation.fixture.label} claim owner/state mismatch`,
            );
            assert.equal(
              mutation.leaseExpiresAt !== undefined,
              sending,
              `${mutation.fixture.label} lease/state mismatch`,
            );
            const changed = await client.query<{ id: string }>(
              `update public.email_outbox
                  set status = $2::public.notification_status,
                      claim_version = $3::integer,
                      attempt_count = $4::integer,
                      claim_token = $5::uuid,
                      claim_owner = $6::text,
                      lease_expires_at = $7::timestamptz,
                      next_attempt_at = $8::timestamptz,
                      last_error_code = null
                where id = $1::uuid
                returning id::text`,
              [
                mutation.fixture.id,
                mutation.status,
                mutation.claimVersion,
                mutation.attemptCount,
                mutation.claimToken ?? null,
                mutation.claimOwner ?? null,
                mutation.leaseExpiresAt ?? null,
                mutation.nextAttemptAt,
              ],
            );
            assert.equal(
              changed.rows[0]?.id,
              mutation.fixture.id,
              `${mutation.fixture.label} counter fixture was not mutated`,
            );
          }
        },
      ),
    );
  });
  await assertAlwaysTriggerRestored(adminPool, DELIVERY_HOLD_TRIGGER);
  await assertAlwaysTriggerRestored(adminPool, DELIVERY_HOLD_FINAL_TRIGGER);
}

function assertCounterRetired(
  label: string,
  before: CounterProofRow,
  after: CounterProofRow,
  expectedClaimVersion: number,
): void {
  assert.equal(after.status, "failed", `${label} did not retire`);
  assert.equal(
    after.last_error_code,
    "DELIVERY_COUNTER_EXHAUSTED",
    `${label} used the wrong retirement code`,
  );
  assert.equal(
    after.claim_version,
    expectedClaimVersion,
    `${label} used the wrong saturated generation`,
  );
  assert.equal(after.claim_token, null, `${label} retained its claim token`);
  assert.equal(after.claim_owner, null, `${label} retained its claim owner`);
  assert.equal(after.lease_expires_at, null, `${label} retained its lease`);
  assert.deepEqual(
    retirementEvidence(after),
    retirementEvidence(before),
    `${label} changed attempt, schedule, payload, or provider evidence`,
  );
}

async function claimForCounterProof(
  runtime: Runtime,
  label: string,
): Promise<OutboxClaim<EmailOutboxPayload> | null> {
  return within(
    runtime.store.claimNext({
      leaseMs: 60_000,
      owner: `mail-runtime:${label}`,
      token: randomUUID(),
    }),
    SCENARIO_TIMEOUT_MS,
    `${label} claim timed out`,
  );
}

async function proveClaimCounterRetirements(
  runtime: Runtime,
  adminPool: Pool,
  applicationPool: Pool,
): Promise<void> {
  const cases = [
    {
      label: "counter-pending-generation-threshold",
      status: "pending" as const,
      claimVersion: INT4_MAX - 1,
      attemptCount: 7,
      expectedClaimVersion: INT4_MAX,
    },
    {
      label: "counter-pending-generation-hard-max",
      status: "pending" as const,
      claimVersion: INT4_MAX,
      attemptCount: 8,
      expectedClaimVersion: INT4_MAX,
    },
    {
      label: "counter-pending-attempt-hard-max",
      status: "pending" as const,
      claimVersion: 23,
      attemptCount: INT4_MAX,
      expectedClaimVersion: 24,
    },
    {
      label: "counter-expired-generation-threshold",
      status: "sending" as const,
      claimVersion: INT4_MAX - 1,
      attemptCount: 9,
      expectedClaimVersion: INT4_MAX,
    },
    {
      label: "counter-expired-generation-hard-max",
      status: "sending" as const,
      claimVersion: INT4_MAX,
      attemptCount: 10,
      expectedClaimVersion: INT4_MAX,
    },
    {
      label: "counter-expired-attempt-hard-max",
      status: "sending" as const,
      claimVersion: 31,
      attemptCount: INT4_MAX,
      expectedClaimVersion: 32,
    },
  ];

  for (const counterCase of cases) {
    const fixture = createFixture(counterCase.label);
    await seedFixture(adminPool, applicationPool, fixture);
    const sending = counterCase.status === "sending";
    await mutateCounterFixtures(adminPool, [{
      fixture,
      status: counterCase.status,
      claimVersion: counterCase.claimVersion,
      attemptCount: counterCase.attemptCount,
      nextAttemptAt: COUNTER_DUE_AT,
      ...(sending
        ? {
          claimToken: randomUUID(),
          claimOwner: `expired:${fixture.label}`,
          leaseExpiresAt: COUNTER_EXPIRED_LEASE_AT,
        }
        : {}),
    }]);
    const before = await readCounterProofRow(adminPool, fixture);
    assert.equal(before.status, counterCase.status);
    assert.equal(before.claim_version, counterCase.claimVersion);
    assert.equal(before.attempt_count, counterCase.attemptCount);
    if (sending) {
      assert.match(before.claim_token ?? "", UUID);
      assert.equal(before.claim_owner, `expired:${fixture.label}`);
      assert.ok(before.lease_expires_at);
    } else {
      assert.equal(before.claim_token, null);
      assert.equal(before.claim_owner, null);
      assert.equal(before.lease_expires_at, null);
    }

    const claim = await claimForCounterProof(runtime, counterCase.label);
    assert.equal(
      claim,
      null,
      `${counterCase.label} issued authority after counter exhaustion`,
    );
    const after = await readCounterProofRow(adminPool, fixture);
    assertCounterRetired(
      counterCase.label,
      before,
      after,
      counterCase.expectedClaimVersion,
    );
  }
}

async function proveFinishBeforeProviderCounterRetirements(
  runtime: Runtime,
  adminPool: Pool,
  applicationPool: Pool,
): Promise<void> {
  const cases = [
    {
      label: "counter-finish-generation-edge",
      seedClaimVersion: INT4_MAX - 3,
      seedAttemptCount: 4,
      expectedClaimVersion: INT4_MAX - 2,
      expectedAttemptCount: 5,
      expectedFinalVersion: INT4_MAX - 1,
    },
    {
      label: "counter-finish-last-claimable-generation",
      seedClaimVersion: INT4_MAX - 2,
      seedAttemptCount: 5,
      expectedClaimVersion: INT4_MAX - 1,
      expectedAttemptCount: 6,
      expectedFinalVersion: INT4_MAX,
    },
    {
      label: "counter-finish-attempt-edge",
      seedClaimVersion: 9,
      seedAttemptCount: INT4_MAX - 1,
      expectedClaimVersion: 10,
      expectedAttemptCount: INT4_MAX,
      expectedFinalVersion: 11,
    },
  ];

  for (const counterCase of cases) {
    const fixture = createFixture(counterCase.label);
    await seedFixture(adminPool, applicationPool, fixture);
    await mutateCounterFixtures(adminPool, [{
      fixture,
      status: "pending",
      claimVersion: counterCase.seedClaimVersion,
      attemptCount: counterCase.seedAttemptCount,
      nextAttemptAt: COUNTER_DUE_AT,
    }]);
    const claim = await within(
      claimFixture(runtime, fixture),
      SCENARIO_TIMEOUT_MS,
      `${counterCase.label} initial claim timed out`,
    );
    assert.equal(claim.claimVersion, counterCase.expectedClaimVersion);
    assert.equal(claim.attempt, counterCase.expectedAttemptCount);
    const beforeFinish = await readCounterProofRow(adminPool, fixture);
    assert.equal(beforeFinish.status, "sending");

    const result = await within(
      runtime.store.finishBeforeProvider(claim, {
        kind: "retry",
        code: "COUNTER_PROOF_RETRY",
        retryAt: new Date(Date.now() + 60 * 60 * 1_000),
      }),
      SCENARIO_TIMEOUT_MS,
      `${counterCase.label} pre-provider finish timed out`,
    );
    assert.deepEqual(result, { kind: "applied" });
    const after = await readCounterProofRow(adminPool, fixture);
    assertCounterRetired(
      counterCase.label,
      beforeFinish,
      after,
      counterCase.expectedFinalVersion,
    );
  }
}

async function proveExhaustedPageReselection(
  runtime: Runtime,
  adminPool: Pool,
  applicationPool: Pool,
): Promise<void> {
  const exhaustedFixtures = Array.from(
    { length: 16 },
    (_, index) => createFixture(`counter-page-exhausted-${index + 1}`),
  );
  const follower = createFixture("counter-page-follower");
  for (const fixture of [...exhaustedFixtures, follower]) {
    await seedFixture(adminPool, applicationPool, fixture);
  }
  await mutateCounterFixtures(adminPool, [
    ...exhaustedFixtures.map((fixture, index) => ({
      fixture,
      status: "pending" as const,
      claimVersion: INT4_MAX - 1,
      attemptCount: index + 1,
      nextAttemptAt: COUNTER_DUE_AT,
    })),
    {
      fixture: follower,
      status: "pending" as const,
      claimVersion: 0,
      attemptCount: 0,
      nextAttemptAt: COUNTER_FOLLOWER_DUE_AT,
    },
  ]);
  const exhaustedBefore = await Promise.all(
    exhaustedFixtures.map((fixture) => readCounterProofRow(adminPool, fixture)),
  );
  const followerBefore = await readCounterProofRow(adminPool, follower);
  const owner = "mail-runtime:counter-page-reselection";
  const token = randomUUID();
  const claim = await within(
    runtime.store.claimNext({ leaseMs: 60_000, owner, token }),
    SCENARIO_TIMEOUT_MS,
    "counter page reselection timed out",
  );
  assert.ok(claim, "counter page follower was not claimed");
  assert.equal(claim.id, follower.id, "counter page did not reselect follower");
  assert.equal(claim.claimOwner, owner);
  assert.equal(claim.claimToken, token);
  assert.equal(claim.claimVersion, 1);
  assert.equal(claim.attempt, 1);

  for (const [index, fixture] of exhaustedFixtures.entries()) {
    const after = await readCounterProofRow(adminPool, fixture);
    assertCounterRetired(
      fixture.label,
      exhaustedBefore[index]!,
      after,
      INT4_MAX,
    );
  }
  const followerAfter = await readCounterProofRow(adminPool, follower);
  assert.equal(followerAfter.status, "sending");
  assert.equal(followerAfter.claim_token, token);
  assert.equal(followerAfter.claim_owner, owner);
  assert.equal(followerAfter.claim_version, 1);
  assert.equal(followerAfter.attempt_count, 1);
  assert.ok(followerAfter.lease_expires_at);
  assert.equal(followerAfter.last_error_code, null);
  assert.deepEqual(
    payloadProviderScheduleEvidence(followerAfter),
    payloadProviderScheduleEvidence(followerBefore),
    "counter page follower changed schedule, payload, or provider evidence",
  );
}

async function proveCounterExhaustion(
  runtime: Runtime,
  adminPool: Pool,
  applicationPool: Pool,
): Promise<void> {
  await proveClaimCounterRetirements(runtime, adminPool, applicationPool);
  await proveFinishBeforeProviderCounterRetirements(
    runtime,
    adminPool,
    applicationPool,
  );
  await proveExhaustedPageReselection(runtime, adminPool, applicationPool);
  await assertAlwaysTriggerRestored(adminPool, DELIVERY_HOLD_TRIGGER);
  await assertAlwaysTriggerRestored(adminPool, DELIVERY_HOLD_FINAL_TRIGGER);
}

async function proveBodyMismatch(
  runtime: Runtime,
  adminPool: Pool,
  applicationPool: Pool,
): Promise<void> {
  await proveCallbackZero(
    runtime,
    adminPool,
    applicationPool,
    "body-mismatch",
    async (fixture) => {
      const original = await persistedAuthority(adminPool, fixture);
      const divergentSha = "f".repeat(64);
      assert.notEqual(original.providerRequestBodySha256, divergentSha);
      await inTransaction(adminPool, async (client) => {
        await setReplicaRole(client);
        await mutateRequestBodyWithDeliveryGuardsDisabled(
          client,
          async () => {
            const changed = await client.query(
              `update public.email_outbox
                  set provider_request_body_sha256 = $2
                where id = $1::uuid returning id`,
              [fixture.id, divergentSha],
            );
            assert.equal(changed.rowCount, 1);
          },
        );
      });
      await assertAlwaysTriggerRestored(adminPool, REQUEST_BODY_TRIGGER);
      await assertAlwaysTriggerRestored(adminPool, DELIVERY_HOLD_TRIGGER);
      await assertAlwaysTriggerRestored(adminPool, DELIVERY_HOLD_FINAL_TRIGGER);
      return async () => {
        await inTransaction(adminPool, async (client) => {
          await setReplicaRole(client);
          await mutateRequestBodyWithDeliveryGuardsDisabled(
            client,
            async () => {
              const restored = await client.query(
                `update public.email_outbox
                    set provider_request_body_sha256 = $2
                  where id = $1::uuid returning id`,
                [fixture.id, original.providerRequestBodySha256],
              );
              assert.equal(restored.rowCount, 1);
            },
          );
        });
        await assertAlwaysTriggerRestored(adminPool, REQUEST_BODY_TRIGGER);
        await assertAlwaysTriggerRestored(adminPool, DELIVERY_HOLD_TRIGGER);
        await assertAlwaysTriggerRestored(adminPool, DELIVERY_HOLD_FINAL_TRIGGER);
      };
    },
  );
}

type ReleaseTuple = Readonly<{
  authoritySha256: string;
  authorityVersion: string;
  originalPayloadSha256: string;
  releaseVersion: string;
}>;

async function releaseTuple(
  adminPool: Pool,
  fixture: Fixture,
): Promise<ReleaseTuple> {
  const result = await adminPool.query<{
    idempotency_authority_sha256: string;
    idempotency_authority_version: string;
    idempotency_original_payload_sha256: string;
    release_version: string;
  }>(
    `select idempotency_authority_version, idempotency_authority_sha256,
            idempotency_original_payload_sha256, release_version
       from public.mail_delivery_release_receipt
      where outbox_id = $1::uuid`,
    [fixture.id],
  );
  assert.equal(result.rows.length, 1);
  const row = result.rows[0]!;
  return Object.freeze({
    authoritySha256: row.idempotency_authority_sha256,
    authorityVersion: row.idempotency_authority_version,
    originalPayloadSha256: row.idempotency_original_payload_sha256,
    releaseVersion: row.release_version,
  });
}

async function overwriteReleaseTuple(
  adminPool: Pool,
  fixture: Fixture,
  tuple: ReleaseTuple,
): Promise<void> {
  await inTransaction(adminPool, async (client) => {
    await setReplicaRole(client);
    await mutateWithAlwaysTriggerDisabled(
      client,
      RELEASE_RECEIPT_TRIGGER,
      async () => {
        const changed = await client.query(
          `update public.mail_delivery_release_receipt
              set idempotency_authority_version = $2,
                  idempotency_authority_sha256 = $3,
                  idempotency_original_payload_sha256 = $4,
                  release_version = $5,
                  release_receipt_sha256 =
                    public.mail_delivery_release_receipt_sha256(
                      outbox_id, operation_id, $2, $3, $4, $5
                    )
            where outbox_id = $1::uuid returning outbox_id`,
          [
            fixture.id,
            tuple.authorityVersion,
            tuple.authoritySha256,
            tuple.originalPayloadSha256,
            tuple.releaseVersion,
          ],
        );
        assert.equal(changed.rowCount, 1);
      },
    );
  });
  await assertAlwaysTriggerRestored(adminPool, RELEASE_RECEIPT_TRIGGER);
}

async function proveReleaseMismatch(
  runtime: Runtime,
  adminPool: Pool,
  applicationPool: Pool,
): Promise<void> {
  await proveCallbackZero(
    runtime,
    adminPool,
    applicationPool,
    "release-mismatch",
    async (fixture) => {
      const original = await releaseTuple(adminPool, fixture);
      const divergent = Object.freeze({
        ...original,
        originalPayloadSha256: sha256(`divergent:${fixture.id}`),
      });
      await overwriteReleaseTuple(adminPool, fixture, divergent);
      return () => overwriteReleaseTuple(adminPool, fixture, original);
    },
  );
}

function loopbackHost(value: string): "127.0.0.1" | "::1" | "localhost" {
  assert.ok(LOOPBACK_HOSTS.has(value));
  return value as "127.0.0.1" | "::1" | "localhost";
}

async function createProxyRuntime(
  registry: ResourceRegistry,
  directWorkerUrl: URL,
  expectedPostgresMajor: 17 | 18,
  label: string,
): Promise<Readonly<{
  proxy: PostgresCommitAckLossProxy;
  runtime: Runtime;
}>> {
  const proxy = await createPostgresCommitAckLossProxy({
    targetHost: loopbackHost(directWorkerUrl.hostname),
    targetPort: Number(directWorkerUrl.port),
  });
  registry.add({
    label: `proxy:${label}`,
    close: () => proxy.close(),
  });
  const proxiedUrl = new URL(directWorkerUrl);
  proxiedUrl.hostname = proxy.host;
  proxiedUrl.port = String(proxy.port);
  const runtime = await createRuntime(
    registry,
    proxiedUrl,
    expectedPostgresMajor,
    `mail-runtime-${label}`,
  );
  return Object.freeze({ proxy, runtime });
}

async function proveTx1CommitAckUncertainty(
  registry: ResourceRegistry,
  workerUrl: URL,
  expectedPostgresMajor: 17 | 18,
  adminPool: Pool,
  applicationPool: Pool,
): Promise<void> {
  const fixture = createFixture("tx1-ack-loss");
  await seedFixture(adminPool, applicationPool, fixture);
  const { proxy, runtime } = await createProxyRuntime(
    registry,
    workerUrl,
    expectedPostgresMajor,
    "tx1-ack-loss",
  );
  const claim = await claimFixture(runtime, fixture);
  const envelope = envelopeFor(runtime, claim);
  proxy.armNextCommitAckLoss();
  let failureName: string | undefined;
  try {
    await runtime.store.beginProviderCall(claim, {
      adapter: "console",
      envelope,
    });
  } catch (error) {
    failureName = error instanceof Error ? error.name : undefined;
  }
  assert.equal(
    failureName,
    "ProviderBoundaryCommitUnknownError",
    "TX1 COMMIT-ack loss did not fail closed",
  );
  const armed = await persistedAuthority(adminPool, fixture);
  assert.equal(armed.status, "sending");
  assert.match(armed.providerRequestBodySha256, SHA256);
  assert.equal(armed.providerMessageId, null);
  const snapshot = proxy.snapshot();
  assert.equal(snapshot.armed, false);
  assert.equal(snapshot.droppedCommitAcknowledgements, 1);
  assert.ok(snapshot.acceptedConnections >= 1);
}

type TerminalRowVersion = Readonly<{
  ctid: string;
  providerMessageId: string;
  status: string;
  xmin: string;
}>;

async function terminalRowVersion(
  adminPool: Pool,
  fixture: Fixture,
): Promise<TerminalRowVersion> {
  const result = await adminPool.query<{
    ctid: string;
    provider_message_id: string | null;
    status: string;
    xmin: string;
  }>(
    `select ctid::pg_catalog.text, xmin::pg_catalog.text, status,
            provider_message_id
       from public.email_outbox
      where id = $1::pg_catalog.uuid`,
    [fixture.id],
  );
  assert.equal(result.rows.length, 1);
  const row = result.rows[0]!;
  assert.ok(row.provider_message_id);
  return Object.freeze({
    ctid: row.ctid,
    providerMessageId: row.provider_message_id,
    status: row.status,
    xmin: row.xmin,
  });
}

async function proveTx2CommitAckUncertainty(
  registry: ResourceRegistry,
  workerUrl: URL,
  expectedPostgresMajor: 17 | 18,
  adminPool: Pool,
  applicationPool: Pool,
): Promise<void> {
  const fixture = createFixture("tx2-ack-loss");
  await seedFixture(adminPool, applicationPool, fixture);
  const { proxy, runtime } = await createProxyRuntime(
    registry,
    workerUrl,
    expectedPostgresMajor,
    "tx2-ack-loss",
  );
  const boundary = await armBoundary(runtime, fixture);
  const capture = captureConsoleWrite(false);
  let result: GuardedDispatchResult;
  try {
    const watchdog = await createWatchdog();
    proxy.armNextCommitAckLoss();
    result = await within(
      runtime.store.dispatchAfterProviderBoundary(
        boundary.permit,
        boundary.guarded,
        watchdog.armed,
      ),
      SCENARIO_TIMEOUT_MS,
      "TX2 COMMIT-ack loss did not settle",
    );
    assert.equal(result.kind, "persistence-unknown");
    await disarmAfterSafeResult(runtime, watchdog, result);
  } finally {
    capture.restore();
  }
  assert.equal(capture.writes(), 1);
  await assertExactBytes(adminPool, fixture, capture.bytes());
  assert.equal(result.kind, "persistence-unknown");
  if (result.kind !== "persistence-unknown") {
    throw new Error("TX2 COMMIT-ack loss did not issue uncertainty");
  }
  const terminalBeforeFinalizer = await terminalRowVersion(adminPool, fixture);
  const finalizerCapture = captureConsoleWrite(false);
  try {
    const recovered = await runtime.store.finishGuardedDispatchUnknown(
      result.uncertainty,
    );
    assert.ok(recovered);
    assert.equal(recovered.result.kind, "already-applied");
    assert.equal(recovered.exit.kind, "sent");
    assert.deepEqual(
      await terminalRowVersion(adminPool, fixture),
      terminalBeforeFinalizer,
    );
    const terminal = await persistedAuthority(adminPool, fixture);
    assert.equal(terminal.status, "sent");
    assert.equal(terminal.providerMessageId, recovered.exit.kind === "sent"
      ? recovered.exit.providerMessageId
      : null);
  } finally {
    finalizerCapture.restore();
  }
  assert.equal(
    finalizerCapture.writes(),
    0,
    "TX2 uncertainty finalizer reached the provider",
  );
  const snapshot = proxy.snapshot();
  assert.equal(snapshot.armed, false);
  assert.equal(snapshot.droppedCommitAcknowledgements, 1);
  assert.ok(snapshot.acceptedConnections >= 2);
}
const TERMINAL_REJECTION_FUNCTION =
  "mail_runtime_0069_targeted_terminal_rejection";
const TERMINAL_REJECTION_TRIGGER =
  "zzzz_mail_runtime_0069_targeted_terminal_rejection";

async function dropTargetedTerminalRejection(
  adminPool: Pool,
): Promise<void> {
  await inTransaction(adminPool, async (client) => {
    await client.query(
      `drop trigger if exists ${TERMINAL_REJECTION_TRIGGER}
         on public.email_outbox`,
    );
    await client.query(
      `drop function if exists public.${TERMINAL_REJECTION_FUNCTION}()`,
    );
  });
}

async function installTargetedTerminalRejection(
  adminPool: Pool,
  fixture: Fixture,
): Promise<void> {
  assert.match(fixture.id, UUID);
  await dropTargetedTerminalRejection(adminPool);
  await adminPool.query(`
    create function public.${TERMINAL_REJECTION_FUNCTION}()
    returns pg_catalog.trigger
    language plpgsql
    volatile
    security definer
    set search_path = pg_catalog, pg_temp
    as $function$
    begin
      if old.id = '${fixture.id}'::pg_catalog.uuid
         and new.id = old.id
         and old.status = 'sending'
         and old.provider_call_started is not null
         and new.status = 'sent'
         and new.provider_message_id is not null
      then
        raise exception 'mail runtime targeted terminal rejection'
          using errcode = '40001';
      end if;
      return new;
    end
    $function$;
    revoke all on function public.${TERMINAL_REJECTION_FUNCTION}()
      from public;
    create trigger ${TERMINAL_REJECTION_TRIGGER}
      before update on public.email_outbox
      for each row
      execute function public.${TERMINAL_REJECTION_FUNCTION}();
  `);
}

const ABANDONED_SWEEP_EXPIRED_LEASE_AT = "1900-01-01T00:00:00.000Z";

async function ageArmedLeaseForAbandonedSweep(
  adminPool: Pool,
  fixture: Fixture,
): Promise<void> {
  await inTransaction(adminPool, async (client) => {
    await mutateWithAlwaysTriggerDisabled(
      client,
      DELIVERY_HOLD_TRIGGER,
      () => mutateWithAlwaysTriggerDisabled(
        client,
        DELIVERY_HOLD_FINAL_TRIGGER,
        async () => {
          const changed = await client.query<{ id: string }>(
            `update public.email_outbox
                set lease_expires_at = $2::pg_catalog.timestamptz
              where id = $1::uuid
                and status = 'sending'
                and provider_call_started is not null
                and provider_message_id is null
                and quarantined_at is null
              returning id::text`,
            [fixture.id, ABANDONED_SWEEP_EXPIRED_LEASE_AT],
          );
          assert.equal(
            changed.rows[0]?.id,
            fixture.id,
            "armed fixture lease was not aged for the abandoned sweep",
          );
        },
      ),
    );
  });
  await assertAlwaysTriggerRestored(adminPool, DELIVERY_HOLD_TRIGGER);
  await assertAlwaysTriggerRestored(adminPool, DELIVERY_HOLD_FINAL_TRIGGER);
}

const GMAIL_REDACTION_QUARANTINED_AT = "2000-01-01T00:00:00.000Z";
const GMAIL_REDACTION_CUTOFF = "2000-01-02T00:00:00.000Z";

async function ageQuarantinedFixtureForRedaction(
  adminPool: Pool,
  fixture: Fixture,
): Promise<void> {
  await inTransaction(adminPool, async (client) => {
    await mutateWithAlwaysTriggerDisabled(
      client,
      DELIVERY_HOLD_TRIGGER,
      () => mutateWithAlwaysTriggerDisabled(
        client,
        DELIVERY_HOLD_FINAL_TRIGGER,
        async () => {
          const changed = await client.query<{ id: string }>(
            `update public.email_outbox
                set quarantined_at = $2::timestamptz
              where id = $1::uuid
                and status = 'quarantined'
                and provider_call_started is not null
                and provider_message_id is null
                and sent_at is null
                and last_error_code = 'ABANDONED_POST_PROVIDER_BOUNDARY'
              returning id::text`,
            [fixture.id, GMAIL_REDACTION_QUARANTINED_AT],
          );
          assert.equal(
            changed.rows[0]?.id,
            fixture.id,
            "Gmail quarantine timestamp was not aged for redaction",
          );
        },
      ),
    );
  });
  await assertAlwaysTriggerRestored(adminPool, DELIVERY_HOLD_TRIGGER);
  await assertAlwaysTriggerRestored(adminPool, DELIVERY_HOLD_FINAL_TRIGGER);
}
async function proveLateSuccessAfterAbandonedQuarantine(
  runtime: Runtime,
  adminPool: Pool,
  applicationPool: Pool,
): Promise<void> {
  const fixture = createFixture("late-success-after-abandoned-quarantine");
  await seedFixture(adminPool, applicationPool, fixture);
  const boundary = await armBoundary(runtime, fixture);
  const armedBeforeDispatch = await readCounterProofRow(adminPool, fixture);
  const immutableBinding = replayAndDeliveryBindingEvidence(
    armedBeforeDispatch,
  );
  const initialClaim = claimAndAttemptEvidence(armedBeforeDispatch);
  const releaseBeforeDispatch = await releaseAuthorityEvidence(
    adminPool,
    fixture,
  );
  assert.equal(armedBeforeDispatch.status, "sending");
  assert.equal(armedBeforeDispatch.provider_message_id, null);

  await installTargetedTerminalRejection(adminPool, fixture);
  const capture = captureConsoleWrite(false);
  let result: GuardedDispatchResult | undefined;
  let scenarioError: unknown;
  try {
    const watchdog = await createWatchdog();
    result = await within(
      runtime.store.dispatchAfterProviderBoundary(
        boundary.permit,
        boundary.guarded,
        watchdog.armed,
      ),
      SCENARIO_TIMEOUT_MS,
      "late-success targeted terminal rejection did not settle",
    );
    assert.equal(result.kind, "persistence-unknown");
    await disarmAfterSafeResult(runtime, watchdog, result);
  } catch (error) {
    scenarioError = error;
  } finally {
    capture.restore();
    try {
      await dropTargetedTerminalRejection(adminPool);
    } catch (cleanupError) {
      if (scenarioError !== undefined) {
        throw new AggregateError(
          [scenarioError, cleanupError],
          "Late-success rejection and cleanup both failed",
        );
      }
      throw cleanupError;
    }
  }
  if (scenarioError !== undefined) throw scenarioError;
  assert.ok(result, "late-success dispatch returned no result");
  assert.equal(capture.writes(), 1);
  await assertExactBytes(adminPool, fixture, capture.bytes());
  if (result.kind !== "persistence-unknown") {
    throw new Error("late-success dispatch did not issue real uncertainty");
  }

  const armedAfterRejection = await readCounterProofRow(adminPool, fixture);
  assert.equal(armedAfterRejection.status, "sending");
  assert.deepEqual(
    replayAndDeliveryBindingEvidence(armedAfterRejection),
    immutableBinding,
  );
  assert.deepEqual(
    claimAndAttemptEvidence(armedAfterRejection),
    initialClaim,
  );

  await ageArmedLeaseForAbandonedSweep(adminPool, fixture);
  const swept = await within(
    runtime.store.quarantineAbandoned({ limit: 1 }),
    SCENARIO_TIMEOUT_MS,
    "late-success abandoned sweep did not settle",
  );
  assert.equal(swept, 1, "late-success fixture was not swept exactly once");
  const quarantined = await readCounterProofRow(adminPool, fixture);
  assert.equal(quarantined.status, "quarantined");
  assert.equal(
    quarantined.last_error_code,
    "ABANDONED_POST_PROVIDER_BOUNDARY",
  );
  assert.equal(quarantined.provider_message_id, null);
  assert.equal(quarantined.sent_at, null);
  assert.ok(quarantined.quarantined_at);
  assert.equal(quarantined.claim_token, null);
  assert.equal(quarantined.claim_owner, null);
  assert.equal(quarantined.lease_expires_at, null);
  assert.equal(
    quarantined.claim_version,
    armedBeforeDispatch.claim_version + 1,
  );
  assert.equal(
    quarantined.attempt_count,
    armedBeforeDispatch.attempt_count,
  );
  assert.deepEqual(
    replayAndDeliveryBindingEvidence(quarantined),
    immutableBinding,
  );

  const finalizerCapture = captureConsoleWrite(false);
  try {
    const recovered = await runtime.store.finishGuardedDispatchUnknown(
      result.uncertainty,
    );
    assert.ok(recovered, "late-success uncertainty was not recognized");
    assert.equal(recovered.result.kind, "applied");
    assert.equal(recovered.exit.kind, "sent");
    const terminal = await readCounterProofRow(adminPool, fixture);
    assert.equal(terminal.status, "quarantined");
    assert.equal(
      terminal.last_error_code,
      "ABANDONED_POST_PROVIDER_BOUNDARY",
    );
    assert.equal(
      terminal.provider_message_id,
      recovered.exit.kind === "sent"
        ? recovered.exit.providerMessageId
        : null,
    );
    assert.ok(terminal.sent_at);
    assert.equal(terminal.sent_at, terminal.updated_at);
    assert.equal(terminal.quarantined_at, quarantined.quarantined_at);
    assert.deepEqual(
      claimAndAttemptEvidence(terminal),
      claimAndAttemptEvidence(quarantined),
    );
    assert.deepEqual(
      replayAndDeliveryBindingEvidence(terminal),
      immutableBinding,
    );
  } finally {
    finalizerCapture.restore();
  }
  assert.equal(
    finalizerCapture.writes(),
    0,
    "late-success uncertainty finalizer reached the provider",
  );
  assert.deepEqual(
    await releaseAuthorityEvidence(adminPool, fixture),
    releaseBeforeDispatch,
  );
}

async function proveFailedAfterAbandonedQuarantine(
  runtime: Runtime,
  adminPool: Pool,
  applicationPool: Pool,
): Promise<void> {
  const fixture = createFixture("failed-after-abandoned-quarantine");
  await seedFixture(adminPool, applicationPool, fixture);
  const boundary = await armBoundary(runtime, fixture);
  const armed = await readCounterProofRow(adminPool, fixture);
  const immutableBinding = replayAndDeliveryBindingEvidence(armed);
  const releaseBeforeFailure = await releaseAuthorityEvidence(
    adminPool,
    fixture,
  );
  assert.equal(armed.status, "sending");
  assert.equal(armed.provider_message_id, null);

  await ageArmedLeaseForAbandonedSweep(adminPool, fixture);
  const swept = await within(
    runtime.store.quarantineAbandoned({ limit: 1 }),
    SCENARIO_TIMEOUT_MS,
    "failed-after-sweep abandoned quarantine did not settle",
  );
  assert.equal(swept, 1, "failed-after-sweep fixture was not swept once");
  const quarantined = await readCounterProofRow(adminPool, fixture);
  assert.equal(quarantined.status, "quarantined");
  assert.equal(
    quarantined.last_error_code,
    "ABANDONED_POST_PROVIDER_BOUNDARY",
  );
  assert.ok(quarantined.quarantined_at);
  assert.equal(quarantined.provider_message_id, null);
  assert.equal(quarantined.sent_at, null);
  assert.equal(quarantined.claim_token, null);
  assert.equal(quarantined.claim_owner, null);
  assert.equal(quarantined.lease_expires_at, null);
  assert.equal(quarantined.claim_version, armed.claim_version + 1);
  assert.equal(quarantined.attempt_count, armed.attempt_count);
  assert.deepEqual(
    replayAndDeliveryBindingEvidence(quarantined),
    immutableBinding,
  );

  const failureCode = "PROVIDER_DEFINITELY_REJECTED";
  const finalized = await within(
    runtime.store.finishAfterProvider(boundary.permit, {
      kind: "failed",
      code: failureCode,
    }),
    SCENARIO_TIMEOUT_MS,
    "failed-after-sweep finalizer did not settle",
  );
  assert.equal(finalized.kind, "applied");
  const failed = await readCounterProofRow(adminPool, fixture);
  assert.equal(failed.status, "failed");
  assert.equal(failed.last_error_code, failureCode);
  assert.equal(failed.quarantined_at, null);
  assert.equal(failed.provider_message_id, null);
  assert.equal(failed.sent_at, null);
  assert.equal(failed.claim_token, null);
  assert.equal(failed.claim_owner, null);
  assert.equal(failed.lease_expires_at, null);
  assert.equal(failed.claim_version, quarantined.claim_version);
  assert.equal(failed.attempt_count, quarantined.attempt_count);
  assert.deepEqual(
    claimAndAttemptEvidence(failed),
    claimAndAttemptEvidence(quarantined),
  );
  assert.deepEqual(
    replayAndDeliveryBindingEvidence(failed),
    immutableBinding,
  );
  assert.deepEqual(
    await releaseAuthorityEvidence(adminPool, fixture),
    releaseBeforeFailure,
  );
}

async function proveGmailRedactionReconciliation(
  runtime: Runtime,
  adminPool: Pool,
  applicationPool: Pool,
  opsPool: Pool,
): Promise<void> {
  const fixture = createFixture("gmail-redaction-reconciliation");
  const gmailEnvironmentNames = [
    "GMAIL_CLIENT_ID",
    "GMAIL_CLIENT_SECRET",
    "GMAIL_REFRESH_TOKEN",
  ] as const;
  const previousGmailEnvironment = new Map(
    gmailEnvironmentNames.map((name) => [name, process.env[name]] as const),
  );
  const previousFetch = globalThis.fetch;
  let networkCalls = 0;
  try {
    for (const name of gmailEnvironmentNames) {
      process.env[name] = `runtime-${name.toLowerCase()}-${randomUUID()}`;
    }
    globalThis.fetch = (async () => {
      networkCalls += 1;
      throw new Error("Gmail runtime proof forbids network access");
    }) as typeof globalThis.fetch;

    await seedFixture(adminPool, applicationPool, fixture);
    await armAbandonedProviderBoundary(runtime, fixture, "gmail");
    const armed = await readCounterProofRow(adminPool, fixture);
    assert.equal(armed.status, "sending");
    assert.equal(armed.adapter, "gmail");
    assert.equal(armed.provider_message_id, null);
    assert.equal(armed.sent_at, null);
    assert.match(armed.dispatch_binding_sha256 ?? "", SHA256);
    assert.match(armed.provider_evidence_sha256 ?? "", SHA256);
    assert.match(armed.provider_request_body_sha256 ?? "", SHA256);

    await ageArmedLeaseForAbandonedSweep(adminPool, fixture);
    const swept = await within(
      runtime.store.quarantineAbandoned({ limit: 1 }),
      SCENARIO_TIMEOUT_MS,
      "Gmail abandoned quarantine did not settle",
    );
    assert.equal(swept, 1, "Gmail fixture was not swept exactly once");
    await ageQuarantinedFixtureForRedaction(adminPool, fixture);

    const beforeRedaction = await readCounterProofRow(adminPool, fixture);
    assert.equal(beforeRedaction.status, "quarantined");
    assert.equal(
      beforeRedaction.last_error_code,
      "ABANDONED_POST_PROVIDER_BOUNDARY",
    );
    assert.equal(beforeRedaction.provider_message_id, null);
    assert.equal(beforeRedaction.sent_at, null);
    assert.ok(beforeRedaction.quarantined_at);
    const preservedBeforeRedaction = redactionPreservedEvidence(
      beforeRedaction,
    );
    const releaseBeforeRedaction = await releaseAuthorityEvidence(
      adminPool,
      fixture,
    );

    const opsIdentity = await opsPool.query<{
      current_user: string;
      session_user: string;
    }>("select current_user::text, session_user::text");
    assert.deepEqual(opsIdentity.rows, [
      { current_user: "learncoding_ops", session_user: "learncoding_ops" },
    ]);
    const summary = await opsPool.query<{
      disposition: "eligible" | "blocked" | "malformed";
      eligible: string;
      transitioned: string;
    }>(
      `select disposition, eligible::text, transitioned::text
         from public.redact_quarantined_email_outbox_authority_v2(
           $1::timestamptz,
           $2::integer
         )`,
      [GMAIL_REDACTION_CUTOFF, 1],
    );
    assert.deepEqual(summary.rows, [
      { disposition: "eligible", eligible: "1", transitioned: "1" },
      { disposition: "blocked", eligible: "0", transitioned: "0" },
      { disposition: "malformed", eligible: "0", transitioned: "0" },
    ]);

    const redacted = await readCounterProofRow(adminPool, fixture);
    const redactedEmail = `redacted+${fixture.id}@invalid.local`;
    assert.equal(redacted.to_email, redactedEmail);
    assert.equal(redacted.variables_json, "{}");
    assert.notEqual(redacted.updated_at, beforeRedaction.updated_at);
    assert.deepEqual(
      redactionPreservedEvidence(redacted),
      preservedBeforeRedaction,
    );
    assert.deepEqual(
      await releaseAuthorityEvidence(adminPool, fixture),
      releaseBeforeRedaction,
    );

    const deterministicProviderId =
      `gmail-runtime-reconciled-${fixture.operationId}`;
    let lookupCalls = 0;
    const reconciled = await reconcileGmailDelivery(
      {
        operationId: fixture.operationId,
        apply: true,
        confirmOperationId: fixture.operationId,
      },
      {
        store: runtime.store,
        gmail: {
          findByMessageId: async ({ messageId, authority }) => {
            lookupCalls += 1;
            assert.equal(lookupCalls, 1);
            assert.equal(messageId, outboxMessageId(fixture.operationId));
            assert.equal(authority.kind, "opaque-header-v1");
            if (authority.kind !== "opaque-header-v1") {
              throw new Error("Gmail reconciliation authority is not opaque");
            }
            assert.equal(authority.operationId, fixture.operationId);
            assert.equal(
              authority.adapterPayloadSha256,
              redacted.dispatch_binding_sha256,
            );
            assert.equal(
              authority.providerEvidenceSha256,
              redacted.provider_evidence_sha256,
            );
            return {
              kind: "matched" as const,
              providerMessageId: deterministicProviderId,
              proof: {
                kind: "header-evidence-v1" as const,
                providerEvidenceSha256: authority.providerEvidenceSha256,
              },
            };
          },
        },
      },
    );
    assert.deepEqual(reconciled, { kind: "applied" });
    assert.equal(lookupCalls, 1);
    assert.equal(networkCalls, 0, "Gmail runtime proof reached the network");

    const terminal = await readCounterProofRow(adminPool, fixture);
    assert.equal(terminal.status, "sent");
    assert.equal(terminal.provider_message_id, deterministicProviderId);
    assert.ok(terminal.sent_at);
    assert.equal(terminal.quarantined_at, null);
    assert.equal(terminal.last_error_code, null);
    assert.equal(terminal.to_email, redactedEmail);
    assert.equal(terminal.variables_json, "{}");
    assert.deepEqual(
      replayAndDeliveryBindingEvidence(terminal),
      replayAndDeliveryBindingEvidence(redacted),
    );
    assert.deepEqual(
      claimAndAttemptEvidence(terminal),
      claimAndAttemptEvidence(redacted),
    );
    assert.deepEqual(
      await releaseAuthorityEvidence(adminPool, fixture),
      releaseBeforeRedaction,
    );
  } finally {
    globalThis.fetch = previousFetch;
    for (const name of gmailEnvironmentNames) {
      const previous = previousGmailEnvironment.get(name);
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }
  assert.equal(networkCalls, 0, "Gmail runtime proof reached the network");
}
const TERMINAL_GATE_FUNCTION = "mail_runtime_0069_terminal_gate";
const TERMINAL_GATE_TRIGGER = "mail_runtime_0069_terminal_gate";
const TERMINAL_GATE_LOCK_KEY = 6_900_690_069;

async function dropTerminalGate(adminPool: Pool): Promise<void> {
  await inTransaction(adminPool, async (client) => {
    await client.query(
      "select pg_catalog.set_config('lock_timeout', '2000ms', true)",
    );
    await client.query(
      `drop trigger if exists ${TERMINAL_GATE_TRIGGER}
         on public.email_outbox`,
    );
    await client.query(
      `drop function if exists public.${TERMINAL_GATE_FUNCTION}()`,
    );
  });
}

async function installTerminalGate(
  adminPool: Pool,
  fixture: Fixture,
): Promise<void> {
  assert.match(fixture.id, UUID);
  await dropTerminalGate(adminPool);
  await adminPool.query(`
    create function public.${TERMINAL_GATE_FUNCTION}()
    returns pg_catalog.trigger
    language plpgsql
    volatile
    security definer
    set search_path = pg_catalog, pg_temp
    as $function$
    begin
      if old.id = '${fixture.id}'::pg_catalog.uuid
         and new.id = old.id
         and old.status = 'sending'
         and old.provider_call_started is not null
         and new.status = 'sent'
         and new.provider_message_id is not null
      then
        perform pg_catalog.set_config('lock_timeout', '0', true);
        perform pg_catalog.pg_advisory_xact_lock(
          ${TERMINAL_GATE_LOCK_KEY}::pg_catalog.int8
        );
      end if;
      return new;
    end
    $function$;
    revoke all on function public.${TERMINAL_GATE_FUNCTION}() from public;
    create trigger ${TERMINAL_GATE_TRIGGER}
      before update on public.email_outbox
      for each row
      execute function public.${TERMINAL_GATE_FUNCTION}();
  `);
}

type BlockedBackend = Readonly<{
  pid: number;
  transactionId: string;
}>;

async function waitForTerminalGate(
  adminPool: Pool,
  applicationName: string,
): Promise<BlockedBackend> {
  const expiresAt = Date.now() + 4_000;
  while (Date.now() < expiresAt) {
    const blocked = await adminPool.query<{
      backend_xid: string | null;
      pid: number;
    }>(
      `select pid, backend_xid::text
         from pg_catalog.pg_stat_activity
        where application_name = $1
          and state = 'active'
          and wait_event_type = 'Lock'
          and wait_event = 'advisory'
          and query like '%update public.email_outbox as outbox%'
        order by pid`,
      [applicationName],
    );
    const row = blocked.rows[0];
    if (row?.backend_xid) {
      return Object.freeze({
        pid: row.pid,
        transactionId: row.backend_xid,
      });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("TX2 never reached the real terminal lock gate");
}

async function assertDestroyedBackend(
  adminPool: Pool,
  observerPool: Pool,
  fixture: Fixture,
  blocked: BlockedBackend,
): Promise<void> {
  const activity = await adminPool.query(
    "select 1 from pg_catalog.pg_stat_activity where pid = $1",
    [blocked.pid],
  );
  assert.equal(activity.rowCount, 0, "deadline TX2 backend survived destroy");
  const xid = await adminPool.query<{ transaction_status: string | null }>(
    `select pg_catalog.pg_xact_status($1::xid8)::text
       as transaction_status`,
    [blocked.transactionId],
  );
  assert.equal(
    xid.rows[0]?.transaction_status,
    "aborted",
    "deadline TX2 transaction did not abort",
  );
  await inTransaction(observerPool, async (client) => {
    const available = await client.query<{ locked: boolean }>(
      `select pg_catalog.pg_try_advisory_xact_lock(
         pg_catalog.hashtext($1)::pg_catalog.int8
       ) as locked`,
      [`user-authority:${fixture.userId}`],
    );
    assert.equal(
      available.rows[0]?.locked,
      true,
      "deadline TX2 leaked its scope lock",
    );
  });
}

async function provePostProviderDatabaseDeadline(
  runtime: Runtime,
  adminPool: Pool,
  applicationPool: Pool,
  observerPool: Pool,
  runtimeApplicationName: string,
): Promise<void> {
  const fixture = createFixture("post-provider-deadline");
  await seedFixture(adminPool, applicationPool, fixture);
  const boundary = await armBoundary(runtime, fixture);
  await installTerminalGate(adminPool, fixture);
  let gateClient: PoolClient | undefined;
  let capture: ConsoleWriteCapture | undefined;
  let gateBegan = false;
  let blocked: BlockedBackend | undefined;
  let result: GuardedDispatchResult | undefined;
  let operation: Promise<GuardedDispatchResult> | undefined;
  let operationError: unknown;
  try {
    gateClient = await adminPool.connect();
    capture = captureConsoleWrite(false);
    const watchdog = await createWatchdog();
    await gateClient.query("begin");
    gateBegan = true;
    await gateClient.query(
      "select pg_catalog.pg_advisory_xact_lock($1::pg_catalog.int8)",
      [TERMINAL_GATE_LOCK_KEY],
    );
    operation = runtime.store.dispatchAfterProviderBoundary(
      boundary.permit,
      boundary.guarded,
      watchdog.armed,
    );
    await within(capture.started, 5_000, "deadline provider did not start");
    blocked = await waitForTerminalGate(adminPool, runtimeApplicationName);
    result = await within(
      operation,
      15_000,
      "post-provider database deadline did not settle",
    );
    assert.equal(result.kind, "persistence-unknown");
    await disarmAfterSafeResult(runtime, watchdog, result);
  } catch (error) {
    operationError = error;
  }

  const cleanupFailures: unknown[] = [];
  try {
    capture?.restore();
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (gateClient) {
    let rollbackSucceeded = false;
    if (gateBegan) {
      try {
        await gateClient.query("rollback");
        rollbackSucceeded = true;
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      gateClient.release(!rollbackSucceeded);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (operation !== undefined && result === undefined) {
    try {
      await within(
        operation.then(
          () => undefined,
          () => undefined,
        ),
        CLEANUP_TIMEOUT_MS,
        "late deadline dispatch observation timed out",
      );
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  try {
    await dropTerminalGate(adminPool);
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (operationError !== undefined && cleanupFailures.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupFailures],
      "Deadline proof and cleanup both failed",
    );
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures,
      "Deadline proof cleanup failed",
    );
  }
  assert.ok(blocked, "deadline backend identity was not observed");
  assert.ok(result, "deadline dispatch did not return a result");
  assert.ok(capture, "deadline provider capture was not installed");
  await assertDestroyedBackend(adminPool, observerPool, fixture, blocked);
  assert.equal(capture.writes(), 1);
  await assertExactBytes(adminPool, fixture, capture.bytes());
  assert.equal(result.kind, "persistence-unknown");
  if (result.kind !== "persistence-unknown") {
    throw new Error("deadline dispatch did not issue uncertainty");
  }
  const finalizerCapture = captureConsoleWrite(false);
  try {
    const recovered = await runtime.store.finishGuardedDispatchUnknown(
      result.uncertainty,
    );
    assert.ok(recovered);
    assert.equal(recovered.result.kind, "applied");
    assert.equal(recovered.exit.kind, "sent");
    const terminal = await persistedAuthority(adminPool, fixture);
    assert.equal(terminal.status, "sent");
  } finally {
    finalizerCapture.restore();
  }
  assert.equal(
    finalizerCapture.writes(),
    0,
    "deadline uncertainty finalizer reached the provider",
  );
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required`);
  return value;
}

export async function runMailGuardedDeliveryRuntimeProof(
  input: MailGuardedDeliveryRuntimeProofInput,
): Promise<void> {
  assert.ok(
    input.expectedPostgresMajor === 17
      || input.expectedPostgresMajor === 18,
    "expectedPostgresMajor must be PostgreSQL 17 or 18",
  );
  const adminUrl = validatedDatabaseUrl(
    input.adminDatabaseUrl,
    "adminDatabaseUrl",
    "postgres",
  );
  const applicationUrl = validatedDatabaseUrl(
    input.applicationDatabaseUrl,
    "applicationDatabaseUrl",
    "learncoding_app",
  );
  const opsUrl = validatedDatabaseUrl(
    input.opsDatabaseUrl,
    "opsDatabaseUrl",
    "learncoding_ops",
  );
  const workerUrl = validatedDatabaseUrl(
    input.workerDatabaseUrl,
    "workerDatabaseUrl",
    "learncoding_worker",
  );
  assert.ok(
    sameDatabase(adminUrl, applicationUrl)
      && sameDatabase(adminUrl, opsUrl)
      && sameDatabase(adminUrl, workerUrl),
    "runtime proof URLs must target the same disposable database",
  );

  const registry = new ResourceRegistry();
  const previousApplicationUrl = process.env.APP_URL;
  process.env.APP_URL = APPLICATION_URL;
  let operationError: unknown;
  try {
    const adminPool = trackedPool(
      registry,
      adminUrl,
      "mail-runtime-admin",
      6,
    );
    const applicationPool = trackedPool(
      registry,
      applicationUrl,
      "mail-runtime-application",
      2,
    );
    const opsPool = trackedPool(
      registry,
      opsUrl,
      "mail-runtime-ops",
      1,
    );
    const observerPool = trackedPool(
      registry,
      adminUrl,
      "mail-runtime-observer",
      3,
    );
    const runtimeApplicationName = "mail-runtime-direct";
    const runtime = await createRuntime(
      registry,
      workerUrl,
      input.expectedPostgresMajor,
      runtimeApplicationName,
    );
    const server = await adminPool.query<{
      database_name: string;
      server_version_num: string;
    }>(
      `select pg_catalog.current_database() as database_name,
              pg_catalog.current_setting('server_version_num')
                as server_version_num`,
    );
    assert.equal(server.rows.length, 1);
    assert.equal(
      Math.floor(Number(server.rows[0]!.server_version_num) / 10_000),
      input.expectedPostgresMajor,
    );
    assert.equal(
      `/${server.rows[0]!.database_name}`,
      adminUrl.pathname,
      "runtime proof connected to an unexpected database",
    );
    const opsIdentity = await opsPool.query<{
      current_user: string;
      session_user: string;
    }>(
      `select current_user::text, session_user::text`,
    );
    assert.deepEqual(opsIdentity.rows, [
      { current_user: "learncoding_ops", session_user: "learncoding_ops" },
    ]);

    await proveExactByteHappyPath(
      runtime,
      adminPool,
      applicationPool,
      observerPool,
    );
    await proveAuthorityMismatch(runtime, adminPool, applicationPool);
    await proveSourceMismatch(runtime, adminPool, applicationPool);
    await proveReleaseMismatch(runtime, adminPool, applicationPool);
    await proveBodyMismatch(runtime, adminPool, applicationPool);
    await proveTx1CommitAckUncertainty(
      registry,
      workerUrl,
      input.expectedPostgresMajor,
      adminPool,
      applicationPool,
    );
    await proveTx2CommitAckUncertainty(
      registry,
      workerUrl,
      input.expectedPostgresMajor,
      adminPool,
      applicationPool,
    );
    await proveLateSuccessAfterAbandonedQuarantine(
      runtime,
      adminPool,
      applicationPool,
    );
    await proveFailedAfterAbandonedQuarantine(
      runtime,
      adminPool,
      applicationPool,
    );
    await proveGmailRedactionReconciliation(
      runtime,
      adminPool,
      applicationPool,
      opsPool,
    );
    await provePostProviderDatabaseDeadline(
      runtime,
      adminPool,
      applicationPool,
      observerPool,
      runtimeApplicationName,
    );
    await proveCounterExhaustion(runtime, adminPool, applicationPool);
  } catch (error) {
    operationError = error;
  } finally {
    if (previousApplicationUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousApplicationUrl;
  }

  let cleanupError: unknown;
  try {
    await registry.close();
  } catch (error) {
    cleanupError = error;
  }
  if (operationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [operationError, cleanupError],
      "Runtime proof and cleanup both failed",
    );
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
}

async function main(): Promise<void> {
  const expectedMajorText = requiredEnvironment(
    "MAIL_RUNTIME_EXPECTED_POSTGRES_MAJOR",
  );
  assert.match(expectedMajorText, /^(?:17|18)$/u);
  await runMailGuardedDeliveryRuntimeProof({
    adminDatabaseUrl: requiredEnvironment("MAIL_RUNTIME_ADMIN_DATABASE_URL"),
    applicationDatabaseUrl: requiredEnvironment(
      "MAIL_RUNTIME_APPLICATION_DATABASE_URL",
    ),
    expectedPostgresMajor: Number(expectedMajorText) as 17 | 18,
    opsDatabaseUrl: requiredEnvironment("MAIL_RUNTIME_OPS_DATABASE_URL"),
    workerDatabaseUrl: requiredEnvironment("MAIL_RUNTIME_WORKER_DATABASE_URL"),
  });
  process.stdout.write("mail_guarded_delivery_0069_runtime=PASS\n");
}

const isEntrypoint =
  process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  void main().catch(() => {
    process.stderr.write(
      "mail_guarded_delivery_0069_runtime=FAIL\n",
    );
    process.exitCode = 1;
  });
}
