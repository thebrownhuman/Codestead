import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import type { PoolClient } from "pg";
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
import { emailOutbox, user } from "@/lib/db/schema";
import { accountMailEventIdempotencyKey } from "@/lib/notifications/idempotency-authority";
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
import { userAuthorityLockKey } from "@/lib/security/user-authority-lock";

const ADMIN_ID = "mail-race-admin";
const LEARNER_ID = "mail-race-learner";
const LEARNER_PUBLIC_ID = "90000000-0000-4000-8000-000000000001";
const LEARNER_EMAIL = "mail-race-learner@integration.invalid";
const INTEGRATION_APPLICATION_URL = "http://localhost:3000";
const INTEGRATION_MAIL_FROM = "Codestead <mail@codestead.test>";

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
  readonly options = Object.freeze({
    max: pool.options.max,
    connectionTimeoutMillis: pool.options.connectionTimeoutMillis,
    idleTimeoutMillis: pool.options.idleTimeoutMillis,
  });

  private nextClientOrdinal = 1;
  private commitOrdinal = 0;
  private commitFaultConsumed = false;

  constructor(
    private readonly hooks: QueryHooks = {},
    private readonly commitFault: CommitFault | null = null,
    private readonly faultOnCommitOrdinal = 1,
  ) {}

  async query(text: string) {
    const result = await pool.query(text);
    return { rows: result.rows as readonly unknown[] };
  }

  async connect() {
    const inner = await pool.connect();
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

const liveOutboxPool = new InstrumentedPool();
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

function requireDisposableDatabaseUrl(
  name: "DATABASE_URL" | "DATABASE_OPS_URL",
) {
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
    || parsed.hostname !== "127.0.0.1"
    || parsed.pathname !== "/learncoding_integration"
    || !Number.isSafeInteger(port)
    || port < 1
    || port > 65_535
    || port === 5_432
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
  const operations = requireDisposableDatabaseUrl("DATABASE_OPS_URL");
  if (
    application.hostname !== operations.hostname
    || application.port !== operations.port
    || application.pathname !== operations.pathname
  ) {
    throw new Error("Mail delivery race roles must select one disposable database.");
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  const result = await pool.query<{ table_name: string }>(`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
  `);
  if (!result.rows.length) return;
  const names = result.rows
    // 0067 intentionally makes this durable replay ledger append-only and
    // non-truncatable. Every test uses unique event keys and asserts only its
    // own key, so preserving prior authority is both required and safe.
    .filter(({ table_name }) => table_name !== "email_outbox_idempotency_authority")
    .map(({ table_name }) => `"${table_name.replaceAll('"', '""')}"`)
    .join(", ");
  await pool.query(`truncate table ${names} restart identity cascade`);
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

async function seedOutboxRows(kind: "pending" | "expired-pre-provider", count = 2) {
  const now = Date.now();
  await db.insert(emailOutbox).values(
    Array.from({ length: count }, (_unused, index) => ({
      id: ROW_IDS[index]!,
      userId: LEARNER_ID,
      deliveryScopeKey: `a:${LEARNER_ID}`,
      toEmail: LEARNER_EMAIL,
      template: "credential-changed",
      templateVersion: "1",
      variables: { name: "Mail Race Learner" },
      idempotencyKey: accountMailEventIdempotencyKey({
        eventId: `mail-race:${kind}:${index}`,
        template: "credential-changed",
        userId: LEARNER_ID,
      }),
      idempotencyAuthorityVersion: "event-v1-native",
      operationId: OPERATION_IDS[index]!,
      status: kind === "pending" ? "pending" as const : "sending" as const,
      attemptCount: kind === "pending" ? 0 : 1,
      claimToken: kind === "pending" ? null : STALE_TOKENS[index]!,
      claimOwner: kind === "pending" ? null : `stale-worker-${index}`,
      claimVersion: kind === "pending" ? 0 : 1,
      leaseExpiresAt: kind === "pending" ? null : new Date(now - 120_000),
      nextAttemptAt: new Date(now - 180_000 + index),
    })),
  );
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
): Promise<OutboxClaim<EmailOutboxPayload>> {
  const activeStore = selectedStore ?? await store();
  const claim = await activeStore.claimNext({ owner, token, leaseMs: 120_000 });
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
  const expired = await pool.query(`
    update email_outbox
       set lease_expires_at = now() - interval '4 minutes'
     where id = $1::uuid
       and status = 'sending'
       and provider_call_started is not null
       and provider_message_id is null
  `, [claim.id]);
  expect(expired.rowCount).toBe(1);
  return { claim, uncertainty: result.uncertainty };
}
async function expiredPermit() {
  await seedOutboxRows("pending", 1);
  const claim = await requireClaim(CLAIM_TOKENS[0], "provider-worker");
  const permit = await requirePermit(claim);
  await pool.query(
    `update email_outbox
        set lease_expires_at = lease_expires_at - interval '4 minutes'
      where id = $1::uuid`,
    [claim.id],
  );
  return { claim, permit };
}

async function markUnresolvedQuarantined(rowId = ROW_IDS[0]) {
  const result = await pool.query(`
    update email_outbox
       set status = 'quarantined',
           attempt_count = 1,
           claim_token = $2::uuid,
           claim_owner = 'abandoned-provider-worker',
           claim_version = 1,
           lease_expires_at = null,
           provider_call_started = now() - interval '2 minutes',
           adapter = 'console',
           provider_message_id = null,
           quarantined_at = now(),
           last_error_code = 'ABANDONED_POST_PROVIDER_BOUNDARY',
           updated_at = now()
     where id = $1::uuid
  `, [rowId, STALE_TOKENS[0]]);
  expect(result.rowCount).toBe(1);
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

function twoFinalizerDependencies(rendezvous: Rendezvous) {
  return {
    processFileErasures: async () => {
      await rendezvous.arrive();
      return ZERO_ERASURE_SUMMARY;
    },
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
  const dependencies = twoFinalizerDependencies(finalizers);
  const attempts = requestIds.map((requestId) =>
    deleteLearnerAccount(
      deletionInput(objectStorageRoot, requestId),
      dependencies,
    ));
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
  const [notices, tombstones, runs, authorities] = await Promise.all([
    pool.query<{
      id: string;
      operation_id: string;
      run_id: string;
      tombstone_id: string;
      idempotency_key: string;
    }>(
      `select id::text, operation_id::text,
              variables ->> 'deletionRunId' as run_id,
              variables ->> 'tombstoneId' as tombstone_id,
              idempotency_key
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
    pool.query<{
      idempotency_sha256: string;
      original_payload_sha256: string;
    }>(
      `select idempotency_sha256, original_payload_sha256
         from email_outbox_idempotency_authority
        where idempotency_sha256 = $1`,
      [eventKey],
    ),
  ]);
  return {
    eventKey,
    notices: notices.rows,
    tombstones: tombstones.rows,
    runs: runs.rows,
    authorities: authorities.rows,
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

beforeAll(() => {
  process.env.DELETION_TOMBSTONE_KEY = "mail-race-deletion-key-long-enough-for-integration";
  process.env.APP_URL = INTEGRATION_APPLICATION_URL;
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
  await pool.end();
});

describe("real PostgreSQL mail delivery races", () => {
  it("revalidates a selected claim candidate at the CAS after a concurrent winner changes it", async () => {
    await seedOutboxRows("pending", 1);
    const candidatePause = new QueryPause();
    const claimantStore = await store(new InstrumentedPool({
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

    let mutationError: unknown = null;
    let changedRows: number | null = null;
    try {
      const changed = await pool.query(`
        update email_outbox
           set status = 'sending',
               attempt_count = attempt_count + 1,
               claim_token = $2::uuid,
               claim_owner = 'concurrent-cas-winner',
               claim_version = claim_version + 1,
               lease_expires_at = now() + interval '2 minutes',
               updated_at = now()
         where id = $1::uuid and status = 'pending'
      `, [ROW_IDS[0], STALE_TOKENS[0]]);
      changedRows = changed.rowCount;
    } catch (error) {
      mutationError = error;
    } finally {
      candidatePause.release();
    }
    const claim = await within(claiming, "stale candidate CAS");
    if (mutationError) throw mutationError;

    expect(changedRows).toBe(1);
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

  it("treats a NULL sending lease as unresolved authority that blocks later scope work", async () => {
    await seedOutboxRows("pending", 2);
    const ambiguous = await pool.query(`
      update email_outbox
         set status = 'sending',
             attempt_count = 1,
             claim_token = $2::uuid,
             claim_owner = 'null-lease-worker',
             claim_version = 1,
             lease_expires_at = null,
             updated_at = now()
       where id = $1::uuid
    `, [ROW_IDS[0], STALE_TOKENS[0]]);
    expect(ambiguous.rowCount).toBe(1);

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
        last_error_code: "ABANDONED_POST_PROVIDER_BOUNDARY",
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
      last_error_code: "ABANDONED_POST_PROVIDER_BOUNDARY",
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
    const racingStore = await store(new InstrumentedPool(race.hooks));
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
      fixtureKind === "pending" ? 1 : 3,
    );
  });

  it("rolls back a provider boundary when its transaction does not commit", async () => {
    await seedOutboxRows("pending", 1);
    const claim = await requireClaim(CLAIM_TOKENS[0], "rollback-boundary-worker");
    const rollbackStore = await store(new InstrumentedPool({}, "rollback-before-ack", 2));

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
    const unknownCommitStore = await store(new InstrumentedPool({}, "commit-ack-lost", 2));

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
    const finalizerStore = await store(new InstrumentedPool({
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
  });

  it("preserves quarantine evidence when the sweeper owns the scope before a late finalizer", async () => {
    const finalizerStore = await store(new InstrumentedPool(
      {},
      "rollback-before-ack",
      4,
    ));
    const { claim, uncertainty } = await requireSentPersistenceUnknown(
      finalizerStore,
      "sweeper-first-worker",
    );
    const sweeperPause = new QueryPause();
    const sweeperStore = await store(new InstrumentedPool({
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
  });

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
  });
  it("makes a committed provider boundary win when deletion queues behind its account lock", async () => {
    await seedOutboxRows("pending", 1);
    const claim = await requireClaim(CLAIM_TOKENS[0], "boundary-before-deletion-worker");
    const boundaryPause = new QueryPause();
    const boundaryStore = await store(new InstrumentedPool({
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
    expect((await pool.query(
      `select idempotency_sha256 from email_outbox_idempotency_authority
        where idempotency_sha256 = $1`,
      [failedEventKey],
    )).rows).toHaveLength(0);

    const retry = await deleteLearnerAccount(
      deletionInput(objectStorageRoot, requestId),
      zeroErasureDependencies(),
    );
    expect(retry.runId).toBe(failedRun!.id);
    expect(retry.replayed).toBe(false);
    const state = await deletionPersistenceState(retry);
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
