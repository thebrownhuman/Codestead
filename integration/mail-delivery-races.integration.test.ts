import { createHash } from "node:crypto";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { sql } from "drizzle-orm";
import pg, { type Pool as PgPool, type PoolClient } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { deleteLearnerAccount } from "@/lib/data-lifecycle/deletion";
import { db, pool } from "@/lib/db/client";
import { accessRequest, invitation, user } from "@/lib/db/schema";
import {
  accountMailEventIdempotencyKey,
} from "@/lib/notifications/idempotency-authority";
import {
  enqueueEmail,
  enqueueEmailInTransaction,
} from "@/lib/notifications/outbox";
import {
  authorizeCommittedPreparedDispatch,
  captureMailDispatchApplicationOrigin,
  discardCommittedPreparedDispatchReceipt,
  guardedDispatchResultSafeToDisarm,
  mailDispatchPreparedRuntimePlan,
  PostgresOutboxStore,
  releaseGuardedDispatchWatchdogClaim,
  type EmailOutboxPayload,
  type OutboxPgClient,
  type OutboxPgPool,
} from "@/lib/notifications/postgres-outbox-store";
import {
  inspectMailDispatchRuntime,
  type MailDispatchStartupPool,
} from "@/lib/notifications/mail-dispatch-runtime-startup";
import { MAIL_DISPATCH_RUNTIME_BOOTSTRAP } from "@/lib/notifications/mail-dispatch-runtime-policy";
import {
  createMaterializedDispatch,
  materializedDispatchEnvelope,
} from "@/lib/notifications/guarded-prepared-dispatch";
import {
  disarmMailDispatchHardWatchdog,
  startMailDispatchHardWatchdog,
} from "@/lib/notifications/mail-dispatch-hard-watchdog";
import { captureMailTransportConfiguration } from "@/lib/notifications/mailer-transport-internal";
import { outboxMessageId } from "@/lib/notifications/provider-correlation";
import { isProductionEmailTemplate } from "@/lib/notifications/template-authority-policy";
import type {
  OutboxClaim,
  ProviderCallPermit,
} from "@/lib/notifications/outbox-worker";
import {
  accessRequestAuthorityLockKey,
  lockAccessRequestAuthority,
  lockAccessRequestSourceAuthority,
  userAuthorityLockKey,
} from "@/lib/security/user-authority-lock";
import { changeLearnerStorageQuota } from "@/lib/storage/admin-quota";
import { DEFAULT_STORAGE_QUOTA_BYTES } from "@/lib/storage/policy";
import { resetDisposableIntegrationDatabase } from "./support/reset-disposable-database";

const { Pool } = pg;

const ADMIN_ID = "mail-race-admin";
const LEARNER_ID = "mail-race-learner";
const LEARNER_PUBLIC_ID = "90000000-0000-4000-8000-000000000001";
const LEARNER_EMAIL = "mail-race-learner@integration.invalid";
const INTEGRATION_APPLICATION_URL = "http://localhost:3000";
const INTEGRATION_MAIL_FROM = "Codestead <mail@codestead.test>";
const ACCESS_REQUEST_ID = "96000000-0000-4000-8000-000000000001";
const INVITATION_ID = "96000000-0000-4000-8000-000000000002";
const POST_DELETE_ACCESS_REQUEST_ID =
  "96000000-0000-4000-8000-000000000003";
const ACCESS_INVITATION_TOKEN = "mail-race-access-invitation-token";
const ACCESS_INVITATION_URL =
  `${INTEGRATION_APPLICATION_URL}/activate?token=${ACCESS_INVITATION_TOKEN}`;
const ACCESS_INVITATION_TOKEN_HASH = createHash("sha256")
  .update(ACCESS_INVITATION_TOKEN)
  .digest("hex");

const ROW_IDS = [
  "91000000-0000-4000-8000-000000000001",
  "91000000-0000-4000-8000-000000000002",
] as const;
const OPERATION_IDS = [
  "92000000-0000-4000-8000-000000000001",
  "92000000-0000-4000-8000-000000000002",
] as const;
const CLAIM_TOKENS = [
  "93000000-0000-4000-8000-000000000001",
  "93000000-0000-4000-8000-000000000002",
  "93000000-0000-4000-8000-000000000003",
] as const;
const STALE_TOKENS = [
  "94000000-0000-4000-8000-000000000001",
  "94000000-0000-4000-8000-000000000002",
] as const;

const ZERO_ERASURE_SUMMARY = {
  total: 0,
  removed: 0,
  alreadyAbsent: 0,
  failed: 0,
  pending: 0,
  complete: true,
} as const;

type DeletionCommitFault =
  | "rollback-before-final-commit-ack"
  | "final-commit-ack-lost";
type DeletionReport = Awaited<ReturnType<typeof deleteLearnerAccount>>;
type FaultInjectableDeletionDependencies =
  NonNullable<Parameters<typeof deleteLearnerAccount>[1]>
  & Readonly<{ acquireClient: () => Promise<PoolClient> }>;
type ApplicationTransaction =
  Parameters<Parameters<typeof db.transaction>[0]>[0];
type QueryRows = Readonly<{
  rows: Record<string, unknown>[];
  rowCount?: number | null;
}>;

type QueryEvent = Readonly<{
  clientOrdinal: number;
  pid: number;
  sql: string;
  values: unknown[];
}>;

type QueryHooks = Readonly<{
  before?: (event: QueryEvent) => Promise<void>;
  after?: (event: QueryEvent, result: QueryRows) => Promise<void>;
}>;

type CommitFault = "rollback-before-ack" | "commit-ack-lost";

function normalizeSql(text: string) {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 3_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not complete within ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class QueryPause {
  private readonly reachedSignal = deferred();
  private readonly releaseSignal = deferred();
  private entered = false;
  pid: number | null = null;

  readonly reached = this.reachedSignal.promise;

  async hold(pid: number) {
    if (this.entered) return;
    this.entered = true;
    this.pid = pid;
    this.reachedSignal.resolve();
    await this.releaseSignal.promise;
  }

  release() {
    this.releaseSignal.resolve();
  }
}

class Rendezvous {
  private arrivals = 0;
  private readonly fullSignal = deferred();
  private readonly openSignal = deferred();

  readonly full = this.fullSignal.promise;

  constructor(private readonly expected: number) {}

  async arrive() {
    this.arrivals += 1;
    if (this.arrivals === this.expected) this.fullSignal.resolve();
    await this.openSignal.promise;
  }

  open() {
    this.openSignal.resolve();
  }
}

function isCandidateSelect(sql: string) {
  return sql.startsWith("select id::text")
    && sql.includes("from public.email_outbox")
    && sql.includes("limit 16");
}

function isTryAdvisoryLock(sql: string) {
  return sql.includes("pg_try_advisory_xact_lock");
}

function isBlockingAdvisoryLock(sql: string) {
  return sql.includes("pg_advisory_xact_lock") && !isTryAdvisoryLock(sql);
}

class ClaimRaceCoordinator {
  private readonly candidateRendezvous = new Rendezvous(2);
  private readonly winnerReadySignal = deferred();
  private readonly loserDoneSignal = deferred();
  private readonly releaseWinnerSignal = deferred();
  private winnerClient: number | null = null;

  readonly hooks: QueryHooks = {
    after: async (event, result) => {
      if (isCandidateSelect(event.sql)) {
        await this.candidateRendezvous.arrive();
        return;
      }
      if (isTryAdvisoryLock(event.sql) && result.rows[0]?.locked === true && this.winnerClient === null) {
        this.winnerClient = event.clientOrdinal;
        this.winnerReadySignal.resolve();
        await this.releaseWinnerSignal.promise;
        return;
      }
      if (event.sql === "commit" && this.winnerClient !== null && event.clientOrdinal !== this.winnerClient) {
        this.loserDoneSignal.resolve();
      }
    },
  };

  async releaseInOrder() {
    await within(this.candidateRendezvous.full, "both outbox candidate snapshots");
    this.candidateRendezvous.open();
    await within(this.winnerReadySignal.promise, "one outbox scope lock winner");
    await within(this.loserDoneSignal.promise, "the losing outbox claimant");
    this.releaseWinnerSignal.resolve();
  }

  releaseAll() {
    this.candidateRendezvous.open();
    this.releaseWinnerSignal.resolve();
  }
}

class InstrumentedClient implements OutboxPgClient {
  constructor(
    private readonly inner: PoolClient,
    private readonly clientOrdinal: number,
    private readonly pid: number,
    private readonly hooks: QueryHooks,
    private readonly consumeCommitFault: () => CommitFault | null,
  ) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ) {
    const event: QueryEvent = {
      clientOrdinal: this.clientOrdinal,
      pid: this.pid,
      sql: normalizeSql(text),
      values,
    };
    await this.hooks.before?.(event);

    if (event.sql === "commit") {
      const fault = this.consumeCommitFault();
      if (fault === "rollback-before-ack") {
        await this.inner.query("rollback");
        throw new Error("forced boundary rollback");
      }
      if (fault === "commit-ack-lost") {
        await this.inner.query("commit");
        throw new Error("forced boundary commit acknowledgement loss");
      }
    }

    const result = await this.inner.query(text, values);
    const projected: QueryRows = {
      rows: result.rows as Record<string, unknown>[],
      rowCount: result.rowCount,
    };
    await this.hooks.after?.(event, projected);
    return {
      rows: result.rows as Row[],
      rowCount: result.rowCount,
    };
  }

  release(destroy = false) {
    this.inner.release(destroy);
  }

  once(event: "end", listener: () => void) {
    this.inner.once(event, listener);
    return this;
  }

  on(event: "error", listener: (error: unknown) => void) {
    this.inner.on(event, listener);
    return this;
  }

  removeListener(
    event: "end" | "error",
    listener: (() => void) | ((error: unknown) => void),
  ) {
    this.inner.removeListener(event, listener);
    return this;
  }
}

class InstrumentedPool implements OutboxPgPool, MailDispatchStartupPool {
  readonly options: Readonly<{
    max: number;
    connectionTimeoutMillis: number;
    idleTimeoutMillis: number;
  }>;

  private nextClientOrdinal = 1;
  private commitOrdinal = 0;
  private commitFaultConsumed = false;

  constructor(
    private readonly innerPool: PgPool,
    private readonly hooks: QueryHooks = {},
    private readonly commitFault: CommitFault | null = null,
    private readonly faultOnCommitOrdinal = 1,
  ) {
    this.options = Object.freeze({
      max: MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolMaximumConnections,
      connectionTimeoutMillis:
        MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolAcquireTimeoutMs,
      idleTimeoutMillis: MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolIdleTimeoutMs,
    });
  }

  async query(text: string) {
    const result = await this.innerPool.query(text);
    return { rows: result.rows as readonly unknown[] };
  }

  async connect() {
    const inner = await this.innerPool.connect();
    const pid = (await inner.query<{ pid: number }>("select pg_backend_pid() pid")).rows[0]!.pid;
    const clientOrdinal = this.nextClientOrdinal;
    this.nextClientOrdinal += 1;
    return new InstrumentedClient(
      inner,
      clientOrdinal,
      pid,
      this.hooks,
      () => {
        this.commitOrdinal += 1;
        if (
          this.commitFaultConsumed
          || this.commitFault === null
          || this.commitOrdinal !== this.faultOnCommitOrdinal
        ) return null;
        this.commitFaultConsumed = true;
        return this.commitFault;
      },
    );
  }
}

/**
 * RED prerequisite: AccountDeletionDependencies must accept acquireClient and
 * both authorizeAndClaim plus the erasure/finalizer client acquisition must use
 * it. The extra structurally-compatible property is deliberately ignored by
 * the current runtime, so the rollback/ACK-loss tests fail until that seam is
 * implemented without monkey-patching the process-global pool.
 */
class FinalDeletionCommitFault {
  private consumed = false;

  constructor(private readonly fault: DeletionCommitFault) {}

  get wasConsumed() {
    return this.consumed;
  }

  async acquireClient(): Promise<PoolClient> {
    const client = await pool.connect();
    let finalCommitArmed = false;
    return new Proxy(client, {
      get: (target, property, receiver) => {
        if (property === "query") {
          return async (text: string, values: unknown[] = []) => {
            const sql = normalizeSql(text);
            if (sql.startsWith("insert into account_deletion_tombstone")) {
              finalCommitArmed = true;
            }
            if (finalCommitArmed && sql === "commit" && !this.consumed) {
              this.consumed = true;
              if (this.fault === "rollback-before-final-commit-ack") {
                await target.query("rollback");
                throw new Error("forced account-deletion final commit rollback");
              }
              await target.query("commit");
              throw new Error(
                "forced account-deletion final commit acknowledgement loss",
              );
            }
            return await target.query(text, values);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function"
          ? value.bind(target)
          : value;
      },
    });
  }
}

function faultInjectableDeletionDependencies(
  fault: FinalDeletionCommitFault,
): FaultInjectableDeletionDependencies {
  return {
    processFileErasures: async () => ZERO_ERASURE_SUMMARY,
    acquireClient: () => fault.acquireClient(),
  };
}

const workerPool = new Pool({
  connectionString: process.env.DATABASE_WORKER_URL,
  max: MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolMaximumConnections,
  connectionTimeoutMillis: MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolAcquireTimeoutMs,
  idleTimeoutMillis: MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolIdleTimeoutMs,
});
const operationsPool = new Pool({
  connectionString: process.env.DATABASE_OPS_URL,
  max: 2,
  connectionTimeoutMillis: MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolAcquireTimeoutMs,
  idleTimeoutMillis: MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolIdleTimeoutMs,
});
const liveOutboxPool = new InstrumentedPool(workerPool);
const outboxStores = new WeakMap<
  InstrumentedPool,
  Promise<PostgresOutboxStore>
>();

async function store(outboxPool: InstrumentedPool = liveOutboxPool) {
  let selected = outboxStores.get(outboxPool);
  if (!selected) {
    selected = (async () => {
      const inspection = await inspectMailDispatchRuntime(outboxPool);
      const applicationOrigin = captureMailDispatchApplicationOrigin(inspection);
      return new PostgresOutboxStore(
        outboxPool,
        inspection,
        applicationOrigin,
      );
    })();
    outboxStores.set(outboxPool, selected);
  }
  return await selected;
}

type DisposableDatabaseUrlName =
  | "DATABASE_URL"
  | "DATABASE_APP_URL"
  | "DATABASE_WORKER_URL"
  | "DATABASE_OPS_URL";

const DISPOSABLE_DATABASE_ROLE = Object.freeze({
  DATABASE_URL: "learncoding_app",
  DATABASE_APP_URL: "learncoding_app",
  DATABASE_WORKER_URL: "learncoding_worker",
  DATABASE_OPS_URL: "learncoding_ops",
} satisfies Record<DisposableDatabaseUrlName, string>);

function requireDisposableDatabaseUrl(name: DisposableDatabaseUrlName) {
  const raw = process.env[name];
  let parsed: URL;
  try {
    parsed = new URL(raw ?? "");
  } catch {
    throw new Error(`${name} must select the disposable integration database.`);
  }
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "postgresql:"
    || parsed.username !== DISPOSABLE_DATABASE_ROLE[name]
    || parsed.password.length === 0
    || parsed.hostname !== "127.0.0.1"
    || parsed.pathname !== "/learncoding_integration"
    || !Number.isSafeInteger(port)
    || port < 1
    || port > 65_535
    || port === 5_432
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw new Error(`${name} must select a non-5432 disposable loopback database.`);
  }
  return parsed;
}

function assertDisposableDatabase() {
  if (process.env.INTEGRATION_TEST !== "1") {
    throw new Error("Mail delivery race tests require the disposable learncoding_integration database.");
  }
  const application = requireDisposableDatabaseUrl("DATABASE_URL");
  const explicitApplication =
    requireDisposableDatabaseUrl("DATABASE_APP_URL");
  const worker = requireDisposableDatabaseUrl("DATABASE_WORKER_URL");
  const operations = requireDisposableDatabaseUrl("DATABASE_OPS_URL");
  if (application.href !== explicitApplication.href) {
    throw new Error("DATABASE_URL must be the exact disposable app-role URL.");
  }
  if ([worker, operations].some((candidate) =>
    application.hostname !== candidate.hostname
    || application.port !== candidate.port
    || application.pathname !== candidate.pathname
  )) {
    throw new Error("Mail delivery race roles must select one disposable database.");
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  await resetDisposableIntegrationDatabase(pool);
}

async function waitForAdvisoryWaiters(
  blockerPid: number,
  expectedCount: number,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waiting = await pool.query<{ waiting: number }>(`
      select count(*)::int waiting
        from pg_locks held join pg_locks waiter
          on waiter.locktype = held.locktype
         and waiter.database is not distinct from held.database
         and waiter.classid is not distinct from held.classid
         and waiter.objid is not distinct from held.objid
         and waiter.objsubid is not distinct from held.objsubid
       where held.pid = $1 and held.locktype = 'advisory' and held.granted
         and waiter.pid <> held.pid and not waiter.granted
    `, [blockerPid]);
    if ((waiting.rows[0]?.waiting ?? 0) >= expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${expectedCount} operation(s) to wait on advisory lock held by PID ${blockerPid}.`);
}

async function waitForBlockedBackendBy(
  blockerPid: number,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const blocked = await pool.query<{
      pid: number;
      query: string;
      wait_event: string | null;
      wait_event_type: string | null;
    }>(`
      select pid, query, wait_event, wait_event_type
        from pg_catalog.pg_stat_activity activity
       where $1::integer = any(pg_catalog.pg_blocking_pids(activity.pid))
       order by pid
    `, [blockerPid]);
    if (blocked.rows.length > 0) return blocked.rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected a backend blocked by PID ${blockerPid}.`);
}

async function seedOutboxRows(
  kind: "pending" | "expired-pre-provider",
  count = 2,
) {
  const application = await pool.connect();
  try {
    await application.query("BEGIN");
    for (let index = 0; index < count; index += 1) {
      const id = ROW_IDS[index]!;
      const operationId = OPERATION_IDS[index]!;
      const idempotencyKey = accountMailEventIdempotencyKey({
        eventId: `mail-race:${kind}:${index}`,
        template: "credential-changed",
        userId: LEARNER_ID,
      });
      const inserted = await application.query<{
        idempotency_original_payload_sha256: string;
      }>(`
        INSERT INTO public.email_outbox (
          id, operation_id, user_id, delivery_scope_key, to_email, template,
          template_version, variables, idempotency_key,
          idempotency_authority_version, status, next_attempt_at
        ) VALUES (
          $1::uuid, $2::uuid, $3::text, 'a:' || $3::text, $4::text,
          'credential-changed', '1', $5::jsonb, $6::text,
          'event-v1-native', 'pending', pg_catalog.transaction_timestamp()
        )
        RETURNING idempotency_original_payload_sha256
      `, [
        id,
        operationId,
        LEARNER_ID,
        LEARNER_EMAIL,
        JSON.stringify({ name: "Mail Race Learner" }),
        idempotencyKey,
      ]);
      const originalPayloadSha256 =
        inserted.rows[0]?.idempotency_original_payload_sha256;
      expect(originalPayloadSha256).toEqual(
        expect.stringMatching(/^[0-9a-f]{64}$/u),
      );
      await application.query(
        `SELECT released.release_receipt_sha256
           FROM public.release_email_outbox_delivery(
             $1::uuid, $2::uuid, $3::text, $4::text, 'task7-v1'
           ) AS released`,
        [id, operationId, idempotencyKey, originalPayloadSha256],
      );
    }
    await application.query("COMMIT");
  } catch (error) {
    await application.query("ROLLBACK");
    throw error;
  } finally {
    application.release();
  }

  if (kind === "expired-pre-provider") {
    const claim = await requireClaim(
      STALE_TOKENS[0],
      "stale-worker-0",
      undefined,
      16_000,
    );
    await waitForOutboxLeaseExpiry(claim.id);
  }
}

async function waitForOutboxLeaseExpiry(
  rowId: string,
  graceMs = 0,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query<{ expired: boolean }>(
      `SELECT lease_expires_at
                < pg_catalog.statement_timestamp()
                  - ($2::integer * interval '1 millisecond') AS expired
         FROM public.email_outbox
        WHERE id = $1::uuid`,
      [rowId, graceMs],
    );
    if (result.rows[0]?.expired === true) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Outbox lease did not expire for ${rowId}.`);
}

function genuineBoundaryInput(
  selectedStore: PostgresOutboxStore,
  claim: OutboxClaim<EmailOutboxPayload>,
) {
  if (!isProductionEmailTemplate(claim.payload.template)) {
    throw new Error("Expected a production email template.");
  }
  const materialized = createMaterializedDispatch({
    source: {
      applicationUrl: INTEGRATION_APPLICATION_URL,
      outboxId: claim.id,
      operationId: claim.operationId,
      claimToken: claim.claimToken,
      claimOwner: claim.claimOwner,
      claimVersion: claim.claimVersion,
      deliveryScopeKey: claim.deliveryScopeKey,
      recipient: claim.payload.to,
      template: claim.payload.template,
      templateVersion: claim.payload.templateVersion,
      variables: claim.payload.variables,
    },
    adapter: "console",
    from: INTEGRATION_MAIL_FROM,
    messageId: outboxMessageId(claim.operationId),
    runtimePlan: mailDispatchPreparedRuntimePlan(selectedStore),
    transportConfiguration: captureMailTransportConfiguration("console"),
  });
  const envelope = materializedDispatchEnvelope(materialized);
  if (!envelope) throw new Error("Expected a genuine prepared envelope.");
  return Object.freeze({ adapter: "console" as const, envelope });
}

async function requireClaim(
  token: string,
  owner: string,
  selectedStore?: PostgresOutboxStore,
  leaseMs = 60_000,
): Promise<OutboxClaim<EmailOutboxPayload>> {
  const activeStore = selectedStore ?? await store();
  const claim = await activeStore.claimNext({ owner, token, leaseMs });
  expect(claim).not.toBeNull();
  if (!claim) throw new Error(`Expected ${owner} to claim one outbox row.`);
  return claim;
}

async function beginProviderCall(
  claim: OutboxClaim<EmailOutboxPayload>,
  selectedStore?: PostgresOutboxStore,
) {
  const activeStore = selectedStore ?? await store();
  return await activeStore.beginProviderCall(
    claim,
    genuineBoundaryInput(activeStore, claim),
  );
}
async function requireBoundary(
  claim: OutboxClaim<EmailOutboxPayload>,
  selectedStore?: PostgresOutboxStore,
) {
  const activeStore = selectedStore ?? await store();
  const boundary = await beginProviderCall(claim, activeStore);
  expect(boundary.kind).toBe("applied");
  if (boundary.kind !== "applied") {
    throw new Error("Expected provider boundary authority.");
  }
  return { store: activeStore, ...boundary };
}

async function requirePermit(
  claim: OutboxClaim<EmailOutboxPayload>,
  selectedStore?: PostgresOutboxStore,
): Promise<ProviderCallPermit> {
  const boundary = await requireBoundary(claim, selectedStore);
  expect(discardCommittedPreparedDispatchReceipt(
    boundary.store,
    boundary.permit,
    boundary.receipt,
  )).toBe(true);
  return boundary.permit;
}

async function requireGuardedBoundary(
  claim: OutboxClaim<EmailOutboxPayload>,
  selectedStore?: PostgresOutboxStore,
) {
  const boundary = await requireBoundary(claim, selectedStore);
  const guarded = await authorizeCommittedPreparedDispatch(
    boundary.store,
    boundary.receipt,
  );
  return { ...boundary, guarded };
}
async function startGuardedDispatch(
  boundary: Awaited<ReturnType<typeof requireGuardedBoundary>>,
) {
  const controller = await startMailDispatchHardWatchdog();
  const armed = await controller.arm();
  const result = boundary.store.dispatchAfterProviderBoundary(
    boundary.permit,
    boundary.guarded,
    armed,
  );
  return {
    result,
    async finish() {
      try {
        const outcome = await result;
        expect(guardedDispatchResultSafeToDisarm(
          boundary.store,
          armed,
          outcome,
        )).toBe(true);
        await disarmMailDispatchHardWatchdog(armed);
        expect(releaseGuardedDispatchWatchdogClaim(
          boundary.store,
          armed,
        )).toBe(true);
        return outcome;
      } finally {
        await controller.close();
      }
    },
  };
}
async function requireSentPersistenceUnknown(
  selectedStore: PostgresOutboxStore,
  owner: string,
) {
  await seedOutboxRows("pending", 1);
  const claim = await requireClaim(CLAIM_TOKENS[0], owner, selectedStore);
  const boundary = await requireGuardedBoundary(claim, selectedStore);
  const dispatch = await startGuardedDispatch(boundary);
  const result = await dispatch.finish();
  expect(result.kind).toBe("persistence-unknown");
  if (result.kind !== "persistence-unknown") {
    throw new Error("Expected guarded dispatch persistence uncertainty.");
  }
  await waitForOutboxLeaseExpiry(claim.id, 30_000, 150_000);
  return { claim, uncertainty: result.uncertainty };
}
async function expiredPermit() {
  await seedOutboxRows("pending", 1);
  const claim = await requireClaim(CLAIM_TOKENS[0], "provider-worker");
  const permit = await requirePermit(claim);
  await waitForOutboxLeaseExpiry(claim.id, 30_000, 150_000);
  return { claim, permit };
}

async function markUnresolvedQuarantined(rowId = ROW_IDS[0]) {
  const activeStore = await store();
  const claim = await requireClaim(
    STALE_TOKENS[0],
    "unresolved-provider-worker",
    activeStore,
  );
  expect(claim.id).toBe(rowId);
  const permit = await requirePermit(claim, activeStore);
  await expect(activeStore.finishAfterProvider(permit, {
    kind: "quarantined",
    code: "PROVIDER_OUTCOME_UNKNOWN",
  })).resolves.toEqual({ kind: "applied" });
}

async function outboxState() {
  return (await pool.query<{
    id: string;
    status: string;
    attempt_count: number;
    claim_token: string | null;
    claim_owner: string | null;
    claim_version: number;
    lease_expires_at: Date | null;
    lease_is_active: boolean;
    provider_call_started: Date | null;
    adapter: string | null;
    provider_message_id: string | null;
    sent_at: Date | null;
    quarantined_at: Date | null;
    last_error_code: string | null;
    variables: Record<string, string>;
    template: string;
  }>(`
    select id::text,status::text,attempt_count,claim_token::text,claim_owner,claim_version,
           lease_expires_at,
           lease_expires_at is not null
             and lease_expires_at >= statement_timestamp() as lease_is_active,
           provider_call_started,adapter,provider_message_id,sent_at,quarantined_at,
           last_error_code,variables,template
      from email_outbox order by created_at,id
  `)).rows;
}

function deletionInput(objectStorageRoot: string, requestId: string) {
  return {
    actorUserId: ADMIN_ID,
    learnerId: LEARNER_ID,
    requestId,
    reason: "Delete the synthetic learner during the deterministic mail boundary race.",
    now: new Date(),
    objectStorageRoot,
  } as const;
}

function zeroErasureDependencies(pause?: QueryPause) {
  return {
    processFileErasures: async () => {
      if (pause) await pause.hold(-1);
      return ZERO_ERASURE_SUMMARY;
    },
  };
}

async function applicationTransactionPid(tx: ApplicationTransaction) {
  const result = await tx.execute<{ pid: number }>(
    sql`select pg_catalog.pg_backend_pid()::integer as pid`,
  );
  const pid = Number(result.rows[0]?.pid);
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new Error("Application transaction did not expose a backend PID.");
  }
  return pid;
}

async function persistApprovedAccessSystemMail(
  tx: ApplicationTransaction,
  sourceEmail = LEARNER_EMAIL,
) {
  const decidedAt = new Date();
  await tx.insert(accessRequest).values({
    id: ACCESS_REQUEST_ID,
    email: sourceEmail,
    name: "Mail Race Learner",
    reason: "Exercise producer-before-deletion serialization.",
    status: "approved",
    adultConfirmedAt: decidedAt,
    decidedBy: ADMIN_ID,
    decisionReason: "Approved for the deterministic delivery race.",
    decidedAt,
  });
  await tx.insert(invitation).values({
    id: INVITATION_ID,
    accessRequestId: ACCESS_REQUEST_ID,
    email: sourceEmail,
    tokenHash: ACCESS_INVITATION_TOKEN_HASH,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    createdBy: ADMIN_ID,
  });
  await enqueueEmailInTransaction(tx, {
    to: sourceEmail,
    template: "invitation",
    variables: {
      name: "Mail Race Learner",
      url: ACCESS_INVITATION_URL,
    },
    systemProducer: "access-request-approved",
    audienceId: ACCESS_REQUEST_ID,
    sourceId: INVITATION_ID,
    idempotencySeed: INVITATION_ID,
  });
}

function deletionDependenciesWithHooks(
  hooks: QueryHooks,
): FaultInjectableDeletionDependencies {
  const instrumented = new InstrumentedPool(pool, hooks);
  return {
    processFileErasures: async () => ZERO_ERASURE_SUMMARY,
    acquireClient: async () =>
      await instrumented.connect() as unknown as PoolClient,
  };
}

async function holdFinalizerUserAuthorityGate() {
  const client = await pool.connect();
  let released = false;
  try {
    const pid = (await client.query<{ pid: number }>(
      "select pg_catalog.pg_backend_pid() as pid",
    )).rows[0]!.pid;
    await client.query(
      `select pg_catalog.pg_advisory_lock(
         pg_catalog.hashtext($1)::pg_catalog.int8
       )`,
      [userAuthorityLockKey(LEARNER_ID)],
    );
    return {
      pid,
      release: async () => {
        if (released) return;
        released = true;
        try {
          const result = await client.query<{ unlocked: boolean }>(
            `select pg_catalog.pg_advisory_unlock(
               pg_catalog.hashtext($1)::pg_catalog.int8
             ) as unlocked`,
            [userAuthorityLockKey(LEARNER_ID)],
          );
          expect(result.rows[0]?.unlocked).toBe(true);
        } finally {
          client.release();
        }
      },
    };
  } catch (error) {
    client.release();
    throw error;
  }
}

async function runDeletionFinalizerRace(
  requestIds: readonly [string, string],
) {
  const finalizers = new Rendezvous(2);
  const firstAtCheckpoint = deferred();
  let checkpointArrivals = 0;
  const dependencies = {
    processFileErasures: async () => {
      checkpointArrivals += 1;
      if (checkpointArrivals === 1) firstAtCheckpoint.resolve();
      await finalizers.arrive();
      return ZERO_ERASURE_SUMMARY;
    },
  };
  const first = deleteLearnerAccount(
    deletionInput(objectStorageRoot, requestIds[0]),
    dependencies,
  );
  void first.catch(() => undefined);
  await within(
    firstAtCheckpoint.promise,
    "first account-deletion finalizer at the durable checkpoint",
    10_000,
  );
  const attempts = [
    first,
    deleteLearnerAccount(
      deletionInput(objectStorageRoot, requestIds[1]),
      dependencies,
    ),
  ];
  const outcomes = Promise.allSettled(attempts);
  let blocker: Awaited<ReturnType<typeof holdFinalizerUserAuthorityGate>> | null =
    null;
  try {
    await within(
      finalizers.full,
      "both account-deletion finalizers at the post-checkpoint gate",
      10_000,
    );
    blocker = await holdFinalizerUserAuthorityGate();
    finalizers.open();
    await waitForAdvisoryWaiters(blocker.pid, 2, 10_000);
    await blocker.release();
    return await within(outcomes, "both account-deletion finalizers", 10_000);
  } finally {
    finalizers.open();
    await blocker?.release();
    await within(outcomes, "account-deletion finalizer cleanup", 10_000)
      .catch(() => undefined);
  }
}

function requireSingleSuccessfulFinalizer(
  outcomes: readonly PromiseSettledResult<DeletionReport>[],
) {
  const successful = outcomes.filter(
    (outcome): outcome is PromiseFulfilledResult<DeletionReport> =>
      outcome.status === "fulfilled",
  );
  const rejected = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === "rejected",
  );
  expect(successful).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.reason).toMatchObject({ code: "LEARNER_NOT_FOUND" });
  return successful[0]!.value;
}

async function deletionPersistenceState(report: DeletionReport) {
  if (!report.deletionNotice) {
    throw new Error("Account deletion report omitted its notice binding.");
  }
  const eventKey = accountMailEventIdempotencyKey({
    eventId: report.runId,
    template: "account-deleted",
    userId: LEARNER_ID,
  });
  const [notices, tombstones, runs] = await Promise.all([
    pool.query<{
      id: string;
      operation_id: string;
      run_id: string;
      tombstone_id: string;
      idempotency_key: string;
      idempotency_authority_sha256: string;
      idempotency_original_payload_sha256: string;
    }>(
      `select id::text, operation_id::text,
              variables ->> 'deletionRunId' as run_id,
              variables ->> 'tombstoneId' as tombstone_id,
              idempotency_key, idempotency_authority_sha256,
              idempotency_original_payload_sha256
         from email_outbox
        where template = 'account-deleted' and user_id = $1
        order by id`,
      [LEARNER_ID],
    ),
    pool.query<{
      id: string;
      run_id: string;
      outbox_id: string | null;
    }>(
      `select id::text, report ->> 'runId' as run_id,
              report -> 'deletionNotice' ->> 'outboxId' as outbox_id
         from account_deletion_tombstone
        where user_id = $1
        order by id`,
      [LEARNER_ID],
    ),
    pool.query<{
      id: string;
      status: string;
      idempotency_key: string;
      error_code: string | null;
    }>(
      `select id::text, status, idempotency_key, error_code
         from data_lifecycle_run
        where operation = 'account_deletion' and target_user_id = $1
        order by idempotency_key`,
      [LEARNER_ID],
    ),
  ]);
  const coverage = notices.rows.length === 0
    ? false
    : (await operationsPool.query<{ covered: boolean }>(
        `select public.email_outbox_idempotency_coverage_authority(
           $1::uuid[]
         ) as covered`,
        [notices.rows.map((notice) => notice.id)],
      )).rows[0]?.covered === true;
  return {
    eventKey,
    notices: notices.rows.map((notice) => ({
      id: notice.id,
      operation_id: notice.operation_id,
      run_id: notice.run_id,
      tombstone_id: notice.tombstone_id,
      idempotency_key: notice.idempotency_key,
    })),
    tombstones: tombstones.rows,
    runs: runs.rows,
    authorities: coverage
      ? notices.rows.map((notice) => ({
          idempotency_sha256: notice.idempotency_authority_sha256,
          original_payload_sha256:
            notice.idempotency_original_payload_sha256,
        }))
      : [],
  };
}
function expectSingleDurableDeletionNotice(
  report: DeletionReport,
  state: Awaited<ReturnType<typeof deletionPersistenceState>>,
  expectedOutboxCount = 1,
) {
  if (!report.deletionNotice) {
    throw new Error("Account deletion report omitted its notice binding.");
  }
  expect(state.tombstones).toEqual([{
    id: report.tombstoneId,
    run_id: report.runId,
    outbox_id: report.deletionNotice.outboxId,
  }]);
  expect(state.notices).toHaveLength(expectedOutboxCount);
  if (expectedOutboxCount === 1) {
    expect(state.notices[0]).toEqual({
      id: report.deletionNotice.outboxId,
      operation_id: report.deletionNotice.operationId,
      run_id: report.runId,
      tombstone_id: report.tombstoneId,
      idempotency_key: state.eventKey,
    });
  }
  expect(state.authorities).toHaveLength(1);
  expect(state.authorities[0]).toEqual({
    idempotency_sha256: state.eventKey,
    original_payload_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
  });
}

const previousDeletionKey = process.env.DELETION_TOMBSTONE_KEY;
const previousApplicationUrl = process.env.APP_URL;
let objectStorageRoot = "";

beforeAll(async () => {
  process.env.DELETION_TOMBSTONE_KEY = "mail-race-deletion-key-long-enough-for-integration";
  process.env.APP_URL = INTEGRATION_APPLICATION_URL;
  assertDisposableDatabase();
  const [applicationIdentity, workerIdentity] = await Promise.all([
    pool.query<{ effective_role: string; session_role: string }>(
      `SELECT current_user::text AS effective_role,
              session_user::text AS session_role`,
    ),
    workerPool.query<{ effective_role: string; session_role: string }>(
      `SELECT current_user::text AS effective_role,
              session_user::text AS session_role`,
    ),
  ]);
  expect(applicationIdentity.rows[0]).toEqual({
    effective_role: "learncoding_app",
    session_role: "learncoding_app",
  });
  expect(workerIdentity.rows[0]).toEqual({
    effective_role: "learncoding_worker",
    session_role: "learncoding_worker",
  });
  await store();
});

beforeEach(async () => {
  await truncateApplicationTables();
  objectStorageRoot = await mkdtemp(path.join(tmpdir(), "mail-race-deletion-"));
  await db.insert(user).values([
    {
      id: ADMIN_ID,
      name: "Mail Race Admin",
      email: "mail-race-admin@integration.invalid",
      role: "admin",
      status: "active",
    },
    {
      id: LEARNER_ID,
      publicId: LEARNER_PUBLIC_ID,
      name: "Mail Race Learner",
      email: LEARNER_EMAIL,
      role: "learner",
      status: "active",
      emailVerified: true,
    },
  ]);
});

afterEach(async () => {
  if (objectStorageRoot) {
    await rm(objectStorageRoot, { recursive: true, force: true });
    objectStorageRoot = "";
  }
});

afterAll(async () => {
  if (previousDeletionKey === undefined) delete process.env.DELETION_TOMBSTONE_KEY;
  else process.env.DELETION_TOMBSTONE_KEY = previousDeletionKey;
  if (previousApplicationUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = previousApplicationUrl;
  await Promise.all([operationsPool.end(), workerPool.end(), pool.end()]);
});

describe("real PostgreSQL mail delivery races", () => {
  it("revalidates a selected claim candidate at the CAS after a concurrent winner changes it", async () => {
    await seedOutboxRows("pending", 1);
    const candidatePause = new QueryPause();
    const claimantStore = await store(new InstrumentedPool(workerPool, {
      after: async (event) => {
        if (isCandidateSelect(event.sql)) await candidatePause.hold(event.pid);
      },
    }));
    const claiming = claimantStore.claimNext({
      owner: "stale-candidate-worker",
      token: CLAIM_TOKENS[0],
      leaseMs: 120_000,
    });
    await within(candidatePause.reached, "stale claim candidate snapshot");

    let winnerError: unknown = null;
    let winner: OutboxClaim<EmailOutboxPayload> | null = null;
    try {
      winner = await requireClaim(
        STALE_TOKENS[0],
        "concurrent-cas-winner",
      );
    } catch (error) {
      winnerError = error;
    } finally {
      candidatePause.release();
    }
    const claim = await within(claiming, "stale candidate CAS");
    if (winnerError) throw winnerError;

    expect(winner).toMatchObject({
      id: ROW_IDS[0],
      claimToken: STALE_TOKENS[0],
      claimOwner: "concurrent-cas-winner",
      claimVersion: 1,
    });
    expect(claim).toBeNull();
    expect((await outboxState())[0]).toMatchObject({
      status: "sending",
      attempt_count: 1,
      claim_token: STALE_TOKENS[0],
      claim_owner: "concurrent-cas-winner",
      claim_version: 1,
      provider_call_started: null,
    });
  });

  it("rejects a NULL sending lease before ambiguous scope authority can exist", async () => {
    await seedOutboxRows("pending", 2);
    const genuineClaim = await requireClaim(
      STALE_TOKENS[0],
      "null-lease-worker",
    );

    await expect(workerPool.query(
      `UPDATE public.email_outbox
          SET lease_expires_at = NULL,
              updated_at = pg_catalog.statement_timestamp()
        WHERE id = $1::uuid`,
      [genuineClaim.id],
    )).rejects.toMatchObject({
      code: "23514",
      constraint: "email_outbox_delivery_hold_valid",
    });

    await expect((await store()).claimNext({
      owner: "null-lease-follow-up",
      token: CLAIM_TOKENS[0],
      leaseMs: 120_000,
    })).resolves.toBeNull();

    expect(await outboxState()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: ROW_IDS[0],
        status: "sending",
        claim_token: STALE_TOKENS[0],
        claim_version: 1,
        lease_is_active: true,
      }),
      expect.objectContaining({
        id: ROW_IDS[1],
        status: "pending",
        claim_token: null,
        claim_version: 0,
      }),
    ]));
  });

  it("keeps an unresolved quarantined provider call as a delivery-scope blocker", async () => {
    await seedOutboxRows("pending", 2);
    await markUnresolvedQuarantined();

    await expect((await store()).claimNext({
      owner: "quarantined-scope-follow-up",
      token: CLAIM_TOKENS[0],
      leaseMs: 120_000,
    })).resolves.toBeNull();

    expect(await outboxState()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: ROW_IDS[0],
        status: "quarantined",
        provider_message_id: null,
        last_error_code: "PROVIDER_OUTCOME_UNKNOWN",
      }),
      expect.objectContaining({
        id: ROW_IDS[1],
        status: "pending",
        claim_token: null,
        claim_version: 0,
      }),
    ]));
  });

  it("blocks deletion while a quarantined provider call has no provider message", async () => {
    await seedOutboxRows("pending", 1);
    await markUnresolvedQuarantined();
    let fileErasureStarted = false;

    await expect(deleteLearnerAccount(
      deletionInput(objectStorageRoot, "95000000-0000-4000-8000-000000000003"),
      {
        processFileErasures: async () => {
          fileErasureStarted = true;
          return ZERO_ERASURE_SUMMARY;
        },
      },
    )).rejects.toMatchObject({ code: "PROVIDER_OPERATION_IN_PROGRESS" });

    expect(fileErasureStarted).toBe(false);
    expect((await pool.query<{ status: string }>(
      `select status::text from "user" where id = $1`,
      [LEARNER_ID],
    )).rows[0]?.status).toBe("active");
    expect((await outboxState())[0]).toMatchObject({
      status: "quarantined",
      provider_message_id: null,
      last_error_code: "PROVIDER_OUTCOME_UNKNOWN",
    });
  });

  it("permits deletion after a failed provider call is definitely rejected", async () => {
    await seedOutboxRows("pending", 1);
    const claim = await requireClaim(CLAIM_TOKENS[0], "definitely-rejected-worker");
    const permit = await requirePermit(claim);

    await expect((await store()).finishAfterProvider(permit, {
      kind: "failed",
      code: "PROVIDER_DEFINITELY_REJECTED",
    })).resolves.toEqual({ kind: "applied" });
    expect((await outboxState())[0]).toMatchObject({
      id: claim.id,
      status: "failed",
      provider_message_id: null,
      last_error_code: "PROVIDER_DEFINITELY_REJECTED",
    });
    expect((await outboxState())[0]!.provider_call_started).not.toBeNull();

    const report = await deleteLearnerAccount(
      deletionInput(objectStorageRoot, "95000000-0000-4000-8000-000000000004"),
      zeroErasureDependencies(),
    );

    expect(report).toMatchObject({
      primaryStoreDeletionComplete: true,
      objectFileErasureComplete: true,
    });
    expect(report.deletedRows.emailOutbox).toBe(1);
    expect((await outboxState()).some((row) => row.id === claim.id)).toBe(false);
  });

  it.each([
    ["pending claimers", "pending" as const],
    ["expired reclaimers", "expired-pre-provider" as const],
  ])("allows one of two %s and keeps the delivery scope single-active", async (_name, fixtureKind) => {
    await seedOutboxRows(fixtureKind);
    const race = new ClaimRaceCoordinator();
    const racingStore = await store(new InstrumentedPool(workerPool, race.hooks));
    const first = racingStore.claimNext({
      owner: "racing-worker-one",
      token: CLAIM_TOKENS[0],
      leaseMs: 120_000,
    });
    const second = racingStore.claimNext({
      owner: "racing-worker-two",
      token: CLAIM_TOKENS[1],
      leaseMs: 120_000,
    });

    try {
      await race.releaseInOrder();
    } finally {
      race.releaseAll();
    }
    const firstRound = await Promise.all([first, second]);
    expect(firstRound.filter((claim) => claim !== null)).toHaveLength(1);
    expect(firstRound.filter((claim) => claim === null)).toHaveLength(1);

    const followUp = await (await store()).claimNext({
      owner: "racing-worker-follow-up",
      token: CLAIM_TOKENS[2],
      leaseMs: 120_000,
    });
    expect(followUp).toBeNull();

    const rows = await outboxState();
    expect(rows.filter((row) => row.status === "sending" && row.lease_is_active)).toHaveLength(1);
    expect(rows.reduce((total, row) => total + row.attempt_count, 0)).toBe(
      fixtureKind === "pending" ? 1 : 2,
    );
  });

  it("rolls back a provider boundary when its transaction does not commit", async () => {
    await seedOutboxRows("pending", 1);
    const claim = await requireClaim(CLAIM_TOKENS[0], "rollback-boundary-worker");
    const rollbackStore = await store(new InstrumentedPool(workerPool, {}, "rollback-before-ack", 2));

    await expect(beginProviderCall(claim, rollbackStore)).rejects.toThrow("Provider boundary commit result is unknown.");

    expect((await outboxState())[0]).toMatchObject({
      status: "sending",
      adapter: null,
      provider_call_started: null,
      claim_version: claim.claimVersion,
    });
    await expect(beginProviderCall(claim)).resolves.toMatchObject({ kind: "applied" });
  });

  it("persists an unknown provider-boundary commit without reconstructing a permit", async () => {
    await seedOutboxRows("pending", 1);
    const claim = await requireClaim(CLAIM_TOKENS[0], "unknown-commit-worker");
    const unknownCommitStore = await store(new InstrumentedPool(workerPool, {}, "commit-ack-lost", 2));

    await expect(beginProviderCall(claim, unknownCommitStore)).rejects.toThrow("Provider boundary commit result is unknown.");

    expect((await outboxState())[0]).toMatchObject({
      status: "sending",
      adapter: "console",
    });
    expect((await outboxState())[0]!.provider_call_started).not.toBeNull();
    await expect(beginProviderCall(claim)).resolves.toEqual({ kind: "lost" });
  });

  it("carries exact PostgreSQL boundary text through guarded dispatch", async () => {
    await seedOutboxRows("pending", 1);
    const selectedStore = await store();
    const claim = await requireClaim(
      CLAIM_TOKENS[0],
      "precision-worker",
      selectedStore,
    );
    const boundary = await requireGuardedBoundary(claim, selectedStore);
    const captured = await pool.query<{ provider_call_started: string }>(`
      select provider_call_started::text as provider_call_started
        from email_outbox
       where id = $1::uuid
    `, [claim.id]);
    const exactBoundary = captured.rows[0]?.provider_call_started;
    expect(exactBoundary).toEqual(expect.stringMatching(/\S/u));

    const dispatch = await startGuardedDispatch(boundary);
    await expect(dispatch.finish()).resolves.toMatchObject({
      kind: "applied",
      exit: { kind: "sent" },
    });

    const persisted = await pool.query<{
      provider_call_started: string;
      provider_message_id: string | null;
    }>(`
      select provider_call_started::text as provider_call_started,
             provider_message_id
        from email_outbox
       where id = $1::uuid
    `, [claim.id]);
    expect(persisted.rows[0]).toMatchObject({
      provider_call_started: exactBoundary,
      provider_message_id: expect.stringMatching(/\S/u),
    });
  });
  it("lets a finalizer that owns the scope lock beat the abandoned-send sweeper", async () => {
    const finalizerPause = new QueryPause();
    let pauseRecovery = false;
    const finalizerStore = await store(new InstrumentedPool(workerPool, {
      after: async (event) => {
        if (pauseRecovery && isBlockingAdvisoryLock(event.sql)) {
          await finalizerPause.hold(event.pid);
        }
      },
    }, "rollback-before-ack", 4));
    const { claim, uncertainty } = await requireSentPersistenceUnknown(
      finalizerStore,
      "finalizer-first-worker",
    );
    pauseRecovery = true;
    const finalizing = finalizerStore.finishGuardedDispatchUnknown(uncertainty);
    await within(finalizerPause.reached, "finalizer scope lock");

    let swept: number;
    try {
      swept = await within(
        (await store()).quarantineAbandoned({ limit: 10 }),
        "non-blocking abandoned-send sweep",
      );
    } finally {
      finalizerPause.release();
    }
    const finalized = await finalizing;

    expect(swept).toBe(0);
    expect(finalized).toMatchObject({
      result: { kind: "applied" },
      exit: { kind: "sent" },
    });
    expect((await outboxState())[0]).toMatchObject({
      id: claim.id,
      status: "sent",
      quarantined_at: null,
      last_error_code: null,
    });
    expect((await outboxState())[0]!.provider_message_id).not.toBeNull();
  }, 180_000);

  it("preserves quarantine evidence when the sweeper owns the scope before a late finalizer", async () => {
    const finalizerStore = await store(new InstrumentedPool(
      workerPool,
      {},
      "rollback-before-ack",
      4,
    ));
    const { claim, uncertainty } = await requireSentPersistenceUnknown(
      finalizerStore,
      "sweeper-first-worker",
    );
    const sweeperPause = new QueryPause();
    const sweeperStore = await store(new InstrumentedPool(workerPool, {
      after: async (event, result) => {
        if (isTryAdvisoryLock(event.sql) && result.rows[0]?.locked === true) {
          await sweeperPause.hold(event.pid);
        }
      },
    }));
    const sweeping = sweeperStore.quarantineAbandoned({ limit: 10 });
    await within(sweeperPause.reached, "sweeper scope lock");
    const finalizing = finalizerStore.finishGuardedDispatchUnknown(uncertainty);

    let waitError: unknown = null;
    try {
      await waitForAdvisoryWaiters(sweeperPause.pid!, 1);
    } catch (error) {
      waitError = error;
    } finally {
      sweeperPause.release();
    }
    const [swept, finalized] = await Promise.all([sweeping, finalizing]);
    if (waitError) throw waitError;

    expect(swept).toBe(1);
    expect(finalized).toMatchObject({
      result: { kind: "applied" },
      exit: { kind: "sent" },
    });
    expect((await outboxState())[0]).toMatchObject({
      id: claim.id,
      status: "quarantined",
      claim_version: claim.claimVersion + 1,
      claim_token: null,
      claim_owner: null,
      lease_expires_at: null,
      last_error_code: "ABANDONED_POST_PROVIDER_BOUNDARY",
    });
    expect((await outboxState())[0]!.provider_message_id).not.toBeNull();
    expect((await outboxState())[0]!.sent_at).not.toBeNull();
    expect((await outboxState())[0]!.quarantined_at).not.toBeNull();
  }, 180_000);

  it("finalizes a definite rejection from the released sweeper successor without another provider call", async () => {
    const { claim, permit } = await expiredPermit();

    await expect((await store()).quarantineAbandoned({ limit: 10 })).resolves.toBe(1);
    await expect((await store()).finishAfterProvider(permit, {
      kind: "failed",
      code: "PROVIDER_DEFINITELY_REJECTED",
    })).resolves.toEqual({ kind: "applied" });

    expect((await outboxState())[0]).toMatchObject({
      status: "failed",
      claim_version: claim.claimVersion + 1,
      claim_token: null,
      claim_owner: null,
      lease_expires_at: null,
      provider_message_id: null,
      sent_at: null,
      quarantined_at: null,
      last_error_code: "PROVIDER_DEFINITELY_REJECTED",
    });
  }, 180_000);
  it("makes a committed provider boundary win when deletion queues behind its account lock", async () => {
    await seedOutboxRows("pending", 1);
    const claim = await requireClaim(CLAIM_TOKENS[0], "boundary-before-deletion-worker");
    const boundaryPause = new QueryPause();
    const boundaryStore = await store(new InstrumentedPool(workerPool, {
      after: async (event) => {
        if (isBlockingAdvisoryLock(event.sql)) await boundaryPause.hold(event.pid);
      },
    }));
    const boundary = beginProviderCall(claim, boundaryStore);
    await within(boundaryPause.reached, "provider boundary account lock");
    const deletion = deleteLearnerAccount(
      deletionInput(objectStorageRoot, "95000000-0000-4000-8000-000000000001"),
      zeroErasureDependencies(),
    );

    let waitError: unknown = null;
    try {
      await waitForAdvisoryWaiters(boundaryPause.pid!, 1);
    } catch (error) {
      waitError = error;
    } finally {
      boundaryPause.release();
    }
    const [boundaryOutcome, deletionOutcome] = await Promise.allSettled([boundary, deletion]);
    if (waitError) throw waitError;

    expect(boundaryOutcome).toMatchObject({
      status: "fulfilled",
      value: { kind: "applied" },
    });
    expect(deletionOutcome.status).toBe("rejected");
    if (deletionOutcome.status === "rejected") {
      expect(deletionOutcome.reason).toMatchObject({ code: "PROVIDER_OPERATION_IN_PROGRESS" });
    }
    expect((await pool.query<{ status: string }>(
      `select status::text from "user" where id = $1`,
      [LEARNER_ID],
    )).rows[0]?.status).toBe("active");
    expect((await outboxState())[0]!.provider_call_started).not.toBeNull();
  });

  it("makes deletion win before the provider boundary and emits one capability-bound notice", async () => {
    await seedOutboxRows("pending", 1);
    const claim = await requireClaim(CLAIM_TOKENS[0], "deletion-before-boundary-worker");
    const erasurePause = new QueryPause();
    const deletion = deleteLearnerAccount(
      deletionInput(objectStorageRoot, "95000000-0000-4000-8000-000000000002"),
      zeroErasureDependencies(erasurePause),
    );
    await within(erasurePause.reached, "deletion file-erasure checkpoint");

    const boundary = await beginProviderCall(claim);
    expect(boundary).toEqual({ kind: "lost" });

    erasurePause.release();
    const report = await deletion;
    expect(report.primaryStoreDeletionComplete).toBe(true);

    const notices = (await outboxState()).filter((row) => row.template === "account-deleted");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.variables).toEqual(expect.objectContaining({
      tombstoneId: report.tombstoneId,
      deletionRunId: report.runId,
    }));

    const noticeClaim = await requireClaim(CLAIM_TOKENS[1], "deletion-notice-worker");
    expect(noticeClaim.id).toBe(notices[0]!.id);
    await expect(beginProviderCall(noticeClaim)).resolves.toMatchObject({ kind: "applied" });
  });

  it("rejects an access decision after deletion status commits and before phase-two cleanup", async () => {
    await db.insert(accessRequest).values({
      id: ACCESS_REQUEST_ID,
      email: LEARNER_EMAIL,
      name: "Mail Race Learner",
      reason: "Pending before the deletion status transition.",
      adultConfirmedAt: new Date(),
    });
    const beforeFirstAccessLock = new QueryPause();
    let accessLockAttempts = 0;
    const deletion = deleteLearnerAccount(
      deletionInput(objectStorageRoot, "95000000-0000-4000-8000-000000000029"),
      deletionDependenciesWithHooks({
        before: async (event) => {
          if (
            isBlockingAdvisoryLock(event.sql)
            && event.values[0] === accessRequestAuthorityLockKey(LEARNER_EMAIL)
          ) {
            accessLockAttempts += 1;
            if (accessLockAttempts === 1) {
              await beforeFirstAccessLock.hold(event.pid);
            }
          }
        },
      }),
    );
    await within(
      beforeFirstAccessLock.reached,
      "phase-two access-request lock attempt",
      10_000,
    );
    expect((await pool.query<{ status: string }>(
      `select status::text from "user" where id = $1`,
      [LEARNER_ID],
    )).rows[0]?.status).toBe("deletion_pending");

    const sourceAuthorized = await db.transaction(async (tx) => {
      const allowed = await lockAccessRequestSourceAuthority(
        tx,
        LEARNER_EMAIL,
      );
      if (!allowed) return false;
      const decidedAt = new Date();
      await tx
        .update(accessRequest)
        .set({
          status: "approved",
          decidedBy: ADMIN_ID,
          decisionReason: "This branch must be unreachable during deletion.",
          decidedAt,
        })
        .where(sql`${accessRequest.id} = ${ACCESS_REQUEST_ID}::uuid`);
      await tx.insert(invitation).values({
        id: INVITATION_ID,
        accessRequestId: ACCESS_REQUEST_ID,
        email: LEARNER_EMAIL,
        tokenHash: ACCESS_INVITATION_TOKEN_HASH,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
        createdBy: ADMIN_ID,
      });
      await enqueueEmailInTransaction(tx, {
        to: LEARNER_EMAIL,
        template: "invitation",
        variables: {
          name: "Mail Race Learner",
          url: ACCESS_INVITATION_URL,
        },
        systemProducer: "access-request-approved",
        audienceId: ACCESS_REQUEST_ID,
        sourceId: INVITATION_ID,
        idempotencySeed: INVITATION_ID,
      });
      return true;
    });
    const prematureClaim = await (await store()).claimNext({
      owner: "status-window-system-worker",
      token: CLAIM_TOKENS[0],
      leaseMs: 60_000,
    });
    const prematureBoundary = prematureClaim
      ? await beginProviderCall(prematureClaim)
      : null;

    let assertionError: unknown = null;
    try {
      expect(sourceAuthorized).toBe(false);
      expect(prematureClaim).toBeNull();
      expect(prematureBoundary).toBeNull();
    } catch (error) {
      assertionError = error;
    } finally {
      beforeFirstAccessLock.release();
    }
    const deletionOutcome = await Promise.allSettled([deletion]);
    if (assertionError) throw assertionError;
    expect(deletionOutcome[0]?.status).toBe("fulfilled");
    expect((await pool.query(
      `select id from access_request where id = $1::uuid
       union all select id from invitation where id = $2::uuid
       union all select id from email_outbox
         where variables ->> '_mailSourceId' = $2::text`,
      [ACCESS_REQUEST_ID, INVITATION_ID],
    )).rows).toHaveLength(0);
  }, 30_000);

  it("makes a committed access approval lose to deletion cleanup without an orphan mail source", async () => {
    const producerReady = deferred();
    const releaseProducer = deferred();
    let producerPid: number | null = null;
    const producer = db.transaction(async (tx) => {
      const sourceAuthorized =
        await lockAccessRequestSourceAuthority(tx, LEARNER_EMAIL);
      if (!sourceAuthorized) {
        throw new Error("Expected pre-deletion source authority.");
      }
      producerPid = await applicationTransactionPid(tx);
      await persistApprovedAccessSystemMail(
        tx,
        `  ${LEARNER_EMAIL.toUpperCase()}  `,
      );
      producerReady.resolve();
      await releaseProducer.promise;
    });
    const readyOrFailure = Promise.race([
      producerReady.promise,
      producer.then(() => {
        throw new Error("Access producer committed before its test gate opened.");
      }),
    ]);
    await within(readyOrFailure, "approved access producer", 10_000);

    const deletion = deleteLearnerAccount(
      deletionInput(objectStorageRoot, "95000000-0000-4000-8000-000000000030"),
      zeroErasureDependencies(),
    );
    let waitError: unknown = null;
    try {
      const blocked = await waitForBlockedBackendBy(producerPid!, 10_000);
      expect(blocked).toEqual([
        expect.objectContaining({
          wait_event_type: "Lock",
          wait_event: "transactionid",
          query: expect.stringContaining(`from "user" where id = $1 for update`),
        }),
      ]);
      const exactLockProbe = await pool.query<{ acquired: boolean }>(
        `select pg_catalog.pg_try_advisory_xact_lock(
           pg_catalog.hashtext($1)::pg_catalog.int8
         ) as acquired`,
        [accessRequestAuthorityLockKey(LEARNER_EMAIL)],
      );
      expect(exactLockProbe.rows[0]?.acquired).toBe(false);
    } catch (error) {
      waitError = error;
    } finally {
      releaseProducer.resolve();
    }
    const [producerOutcome, deletionOutcome] = await Promise.allSettled([
      producer,
      deletion,
    ]);
    if (waitError) throw waitError;
    expect(producerOutcome.status).toBe("fulfilled");
    expect(deletionOutcome.status).toBe("fulfilled");
    if (deletionOutcome.status !== "fulfilled") throw deletionOutcome.reason;

    expect(deletionOutcome.value.deletedRows.accessRequests).toBeGreaterThanOrEqual(1);
    expect(deletionOutcome.value.deletedRows.invitations).toBeGreaterThanOrEqual(1);
    const residue = (await pool.query<{
      access_requests: number;
      invitations: number;
      outbox_rows: number;
    }>(`
      select
        (select count(*)::int from access_request where id = $1::uuid) access_requests,
        (select count(*)::int from invitation where id = $2::uuid) invitations,
        (select count(*)::int from email_outbox
          where variables ->> '_mailSourceId' = $2::text) outbox_rows
    `, [ACCESS_REQUEST_ID, INVITATION_ID])).rows[0];
    expect(residue).toEqual({
      access_requests: 0,
      invitations: 0,
      outbox_rows: 0,
    });
  }, 30_000);

  it("lets a same-email access request begin only after final pseudonymization", async () => {
    const finalAccessLock = new QueryPause();
    let accessLockCount = 0;
    const deletion = deleteLearnerAccount(
      deletionInput(objectStorageRoot, "95000000-0000-4000-8000-000000000031"),
      deletionDependenciesWithHooks({
        after: async (event) => {
          if (
            isBlockingAdvisoryLock(event.sql)
            && event.values[0] === accessRequestAuthorityLockKey(LEARNER_EMAIL)
          ) {
            accessLockCount += 1;
            if (accessLockCount === 2) {
              await finalAccessLock.hold(event.pid);
            }
          }
        },
      }),
    );
    await within(finalAccessLock.reached, "final access-request authority lock", 10_000);

    const producerAttempted = deferred();
    const producer = db.transaction(async (tx) => {
      const pid = await applicationTransactionPid(tx);
      producerAttempted.resolve();
      const sourceAuthorized =
        await lockAccessRequestSourceAuthority(tx, LEARNER_EMAIL);
      if (!sourceAuthorized) {
        throw new Error("Expected post-deletion source authority.");
      }
      await tx.insert(accessRequest).values({
        id: POST_DELETE_ACCESS_REQUEST_ID,
        email: LEARNER_EMAIL,
        name: "New Mailbox Owner",
        reason: "A genuinely new request after the prior account was erased.",
        adultConfirmedAt: new Date(),
      });
      return pid;
    });
    await within(producerAttempted.promise, "post-deletion access producer", 10_000);

    let waitError: unknown = null;
    try {
      await waitForAdvisoryWaiters(finalAccessLock.pid!, 1, 10_000);
    } catch (error) {
      waitError = error;
    } finally {
      finalAccessLock.release();
    }
    const [deletionOutcome, producerOutcome] = await Promise.allSettled([
      deletion,
      producer,
    ]);
    if (waitError) throw waitError;
    expect(deletionOutcome.status).toBe("fulfilled");
    expect(producerOutcome.status).toBe("fulfilled");

    const postCommit = (await pool.query<{
      user_status: string;
      user_email: string;
      request_status: string;
      request_email: string;
    }>(`
      select deleted_user.status::text user_status,
             deleted_user.email user_email,
             fresh_request.status::text request_status,
             fresh_request.email request_email
        from "user" deleted_user
        join access_request fresh_request on fresh_request.id = $2::uuid
       where deleted_user.id = $1
    `, [LEARNER_ID, POST_DELETE_ACCESS_REQUEST_ID])).rows[0];
    expect(postCommit).toEqual({
      user_status: "deleted",
      user_email: expect.stringMatching(/^deleted\+.*@invalid[.]local$/u),
      request_status: "pending",
      request_email: LEARNER_EMAIL,
    });
  }, 30_000);

  it("rejects delayed account mail while the final deletion transaction owns user authority", async () => {
    const finalOutboxDelete = new QueryPause();
    let outboxDeleteCount = 0;
    const deletion = deleteLearnerAccount(
      deletionInput(objectStorageRoot, "95000000-0000-4000-8000-000000000032"),
      deletionDependenciesWithHooks({
        after: async (event) => {
          if (
            event.sql.startsWith(
              "delete from email_outbox where user_id = $1 or pg_catalog.lower(pg_catalog.btrim(to_email)) = pg_catalog.lower(pg_catalog.btrim($2))",
            )
          ) {
            outboxDeleteCount += 1;
            if (outboxDeleteCount === 2) {
              await finalOutboxDelete.hold(event.pid);
            }
          }
        },
      }),
    );
    await within(finalOutboxDelete.reached, "final outbox deletion", 10_000);

    let observed: unknown;
    let attemptError: unknown = null;
    try {
      observed = await within(
        enqueueEmail({
          to: LEARNER_EMAIL,
          template: "credential-changed",
          variables: { name: "Mail Race Learner" },
          userId: LEARNER_ID,
          idempotencySeed: "delayed-after-final-outbox-delete",
        }).catch((error: unknown) => error),
        "delayed account-mail rejection",
        5_000,
      );
    } catch (error) {
      attemptError = error;
    } finally {
      finalOutboxDelete.release();
    }
    await deletion;
    if (attemptError) throw attemptError;
    expect(observed).toMatchObject({
      name: "EmailOutboxPersistenceError",
      code: "EMAIL_OUTBOX_PERSISTENCE_FAILED",
    });
    expect((await pool.query(
      `select id from email_outbox
        where user_id = $1 and template = 'credential-changed'`,
      [LEARNER_ID],
    )).rows).toHaveLength(0);
  }, 30_000);

  it("rejects a stale quota mutation after deletion wins user authority", async () => {
    const blocker = await holdFinalizerUserAuthorityGate();
    const deletion = deleteLearnerAccount(
      deletionInput(objectStorageRoot, "95000000-0000-4000-8000-000000000034"),
      zeroErasureDependencies(),
    );
    let quota: ReturnType<typeof changeLearnerStorageQuota> | null = null;
    let waitError: unknown = null;
    try {
      await waitForAdvisoryWaiters(blocker.pid, 1, 10_000);
      quota = changeLearnerStorageQuota({
        learnerPublicId: LEARNER_PUBLIC_ID,
        requestedBytes: DEFAULT_STORAGE_QUOTA_BYTES + 256 * 1024 ** 2,
        expectedRowVersion: 0,
        requestId: "95000000-0000-4000-8000-000000000035",
        actorUserId: ADMIN_ID,
        reason: "Prove quota authority cannot survive account deletion.",
      });
      await waitForAdvisoryWaiters(blocker.pid, 2, 10_000);
    } catch (error) {
      waitError = error;
    } finally {
      await blocker.release();
    }
    const [deletionOutcome, quotaOutcome] = await Promise.allSettled([
      deletion,
      quota ?? Promise.reject(waitError),
    ]);
    if (waitError) throw waitError;
    expect(deletionOutcome.status).toBe("fulfilled");
    expect(quotaOutcome.status).toBe("rejected");
    if (quotaOutcome.status === "rejected") {
      expect(quotaOutcome.reason).toMatchObject({ code: "LEARNER_NOT_FOUND" });
    }
    expect((await pool.query(`
      select
        (select count(*)::int from learner_profile where user_id = $1) profiles,
        (select count(*)::int from notification
          where user_id = $1 and type = 'storage-quota-changed') notices,
        (select count(*)::int from storage_quota_change
          where learner_user_id = $1) changes
    `, [LEARNER_ID])).rows[0]).toEqual({
      profiles: 0,
      notices: 0,
      changes: 0,
    });
  }, 30_000);

  it("suppresses a released system row whose authoritative request source was removed", async () => {
    await db.transaction(async (tx) => {
      const sourceAuthorized =
        await lockAccessRequestSourceAuthority(tx, LEARNER_EMAIL);
      if (!sourceAuthorized) throw new Error("Expected source authority.");
      await persistApprovedAccessSystemMail(tx);
    });
    await db.transaction(async (tx) => {
      await lockAccessRequestAuthority(tx, LEARNER_EMAIL);
      await tx.execute(sql`delete from invitation where id = ${INVITATION_ID}::uuid`);
      await tx.execute(sql`delete from access_request where id = ${ACCESS_REQUEST_ID}::uuid`);
    });

    const claim = await requireClaim(
      CLAIM_TOKENS[0],
      "orphan-system-source-worker",
    );
    await expect(beginProviderCall(claim)).resolves.toEqual({
      kind: "suppressed",
      code: "SYSTEM_EMAIL_AUTHORITY_INVALID",
    });
    expect((await outboxState())[0]).toMatchObject({
      status: "suppressed",
      provider_call_started: null,
      last_error_code: "SYSTEM_EMAIL_AUTHORITY_INVALID",
    });
  }, 30_000);

  it("commits one notice when two same-request finalizers queue on the user-authority lock", async () => {
    const requestId = "95000000-0000-4000-8000-000000000020";
    const report = requireSingleSuccessfulFinalizer(
      await runDeletionFinalizerRace([requestId, requestId]),
    );
    const state = await deletionPersistenceState(report);

    expectSingleDurableDeletionNotice(report, state);
    expect(state.runs).toEqual([{
      id: report.runId,
      status: "succeeded",
      idempotency_key: `account-deletion:${LEARNER_ID}:${requestId}`,
      error_code: null,
    }]);
  });

  it("commits one notice but records the losing distinct request as a failed lifecycle run", async () => {
    const requestIds = [
      "95000000-0000-4000-8000-000000000021",
      "95000000-0000-4000-8000-000000000022",
    ] as const;
    const report = requireSingleSuccessfulFinalizer(
      await runDeletionFinalizerRace(requestIds),
    );
    const state = await deletionPersistenceState(report);

    expectSingleDurableDeletionNotice(report, state);
    expect(state.runs).toHaveLength(2);
    expect(state.runs.map((run) => run.idempotency_key).sort()).toEqual(
      requestIds
        .map((requestId) => `account-deletion:${LEARNER_ID}:${requestId}`)
        .sort(),
    );
    expect(state.runs.filter((run) => run.status === "succeeded")).toEqual([
      expect.objectContaining({
        id: report.runId,
        error_code: null,
      }),
    ]);
    expect(state.runs.filter((run) => run.status === "failed")).toEqual([
      expect.objectContaining({
        error_code: "LEARNER_NOT_FOUND",
      }),
    ]);
  });

  it("rolls the final transaction back and lets the same request retry to one notice", async () => {
    const requestId = "95000000-0000-4000-8000-000000000023";
    const fault = new FinalDeletionCommitFault(
      "rollback-before-final-commit-ack",
    );

    await expect(deleteLearnerAccount(
      deletionInput(objectStorageRoot, requestId),
      faultInjectableDeletionDependencies(fault),
    )).rejects.toThrow("forced account-deletion final commit rollback");
    expect(fault.wasConsumed).toBe(true);

    const [failedRun] = (await pool.query<{
      id: string;
      status: string;
      error_code: string | null;
    }>(
      `select id::text, status, error_code
         from data_lifecycle_run
        where operation = 'account_deletion' and target_user_id = $1`,
      [LEARNER_ID],
    )).rows;
    expect(failedRun).toMatchObject({
      status: "failed",
      error_code: "ACCOUNT_DELETION_FAILED",
    });
    const failedEventKey = accountMailEventIdempotencyKey({
      eventId: failedRun!.id,
      template: "account-deleted",
      userId: LEARNER_ID,
    });
    expect((await pool.query(
      `select id from account_deletion_tombstone where user_id = $1`,
      [LEARNER_ID],
    )).rows).toHaveLength(0);
    expect((await pool.query(
      `select id from email_outbox
        where template = 'account-deleted' and user_id = $1`,
      [LEARNER_ID],
    )).rows).toHaveLength(0);

    const retry = await deleteLearnerAccount(
      deletionInput(objectStorageRoot, requestId),
      zeroErasureDependencies(),
    );
    expect(retry.runId).toBe(failedRun!.id);
    expect(retry.replayed).toBe(false);
    const state = await deletionPersistenceState(retry);
    expect(state.eventKey).toBe(failedEventKey);
    expectSingleDurableDeletionNotice(retry, state);
    expect(state.runs).toEqual([{
      id: retry.runId,
      status: "succeeded",
      idempotency_key: `account-deletion:${LEARNER_ID}:${requestId}`,
      error_code: null,
    }]);
  });

  it("replays the committed tombstone after final-commit acknowledgement loss without another notice", async () => {
    const requestId = "95000000-0000-4000-8000-000000000024";
    const fault = new FinalDeletionCommitFault("final-commit-ack-lost");

    await expect(deleteLearnerAccount(
      deletionInput(objectStorageRoot, requestId),
      faultInjectableDeletionDependencies(fault),
    )).rejects.toThrow(
      "forced account-deletion final commit acknowledgement loss",
    );
    expect(fault.wasConsumed).toBe(true);

    const replay = await deleteLearnerAccount(
      deletionInput(objectStorageRoot, requestId),
      zeroErasureDependencies(),
    );
    expect(replay.replayed).toBe(true);
    const state = await deletionPersistenceState(replay);
    expectSingleDurableDeletionNotice(replay, state);
    expect(state.runs).toEqual([{
      id: replay.runId,
      status: "succeeded",
      idempotency_key: `account-deletion:${LEARNER_ID}:${requestId}`,
      error_code: null,
    }]);
  });
});
