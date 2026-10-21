import { registerMailWorkerResources } from "@/lib/notifications/mail-worker-role";
// Shared real-PostgreSQL harness for the mail delivery race suites. The race
// tests were split across three files so CI can run them in parallel; each
// file calls registerMailDeliveryRaceHarness() to register the same hooks.
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
  expect,
} from "vitest";
import { deleteLearnerAccount } from "@/lib/data-lifecycle/deletion";
import { db, pool } from "@/lib/db/client";
import { accessRequest, invitation, user } from "@/lib/db/schema";
import { accountMailEventIdempotencyKey } from "@/lib/notifications/idempotency-authority";
import { enqueueEmailInTransaction } from "@/lib/notifications/outbox";
import {
  type EmailOutboxPayload,
  type OutboxPgClient,
  type OutboxPgPool,
  PostgresOutboxStore,
  authorizeCommittedPreparedDispatch,
  captureMailDispatchApplicationOrigin,
  discardCommittedPreparedDispatchReceipt,
  guardedDispatchResultSafeToDisarm,
  mailDispatchPreparedRuntimePlan,
  releaseGuardedDispatchWatchdogClaim,
} from "@/lib/notifications/postgres-outbox-store";
import { type MailDispatchStartupPool, inspectMailDispatchRuntime } from "@/lib/notifications/mail-dispatch-runtime-startup";
import { MAIL_DISPATCH_RUNTIME_BOOTSTRAP } from "@/lib/notifications/mail-dispatch-runtime-policy";
import { createMaterializedDispatch, materializedDispatchEnvelope } from "@/lib/notifications/guarded-prepared-dispatch";
import { disarmMailDispatchHardWatchdog, startMailDispatchHardWatchdog } from "@/lib/notifications/mail-dispatch-hard-watchdog";
import { captureMailTransportConfiguration } from "@/lib/notifications/mailer-transport-internal";
import { outboxMessageId } from "@/lib/notifications/provider-correlation";
import { isProductionEmailTemplate } from "@/lib/notifications/template-authority-policy";
import type { OutboxClaim, ProviderCallPermit } from "@/lib/notifications/outbox-worker";
import { userAuthorityLockKey } from "@/lib/security/user-authority-lock";
import { resetDisposableIntegrationDatabase } from "../support/reset-disposable-database";


export const { Pool } = pg;


export const ADMIN_ID = "mail-race-admin";

export const LEARNER_ID = "mail-race-learner";

export const LEARNER_PUBLIC_ID = "90000000-0000-4000-8000-000000000001";

export const LEARNER_EMAIL = "mail-race-learner@integration.invalid";

export const INTEGRATION_APPLICATION_URL = "http://localhost:3000";

export const INTEGRATION_MAIL_FROM = "Codestead <mail@codestead.test>";

export const ACCESS_REQUEST_ID = "96000000-0000-4000-8000-000000000001";

export const INVITATION_ID = "96000000-0000-4000-8000-000000000002";

export const POST_DELETE_ACCESS_REQUEST_ID =
  "96000000-0000-4000-8000-000000000003";

export const ACCESS_INVITATION_TOKEN = "mail-race-access-invitation-token";

export const ACCESS_INVITATION_URL =
  `${INTEGRATION_APPLICATION_URL}/activate?token=${ACCESS_INVITATION_TOKEN}`;

export const ACCESS_INVITATION_TOKEN_HASH = createHash("sha256")
  .update(ACCESS_INVITATION_TOKEN)
  .digest("hex");


export const ROW_IDS = [
  "91000000-0000-4000-8000-000000000001",
  "91000000-0000-4000-8000-000000000002",
] as const;

export const OPERATION_IDS = [
  "92000000-0000-4000-8000-000000000001",
  "92000000-0000-4000-8000-000000000002",
] as const;

export const CLAIM_TOKENS = [
  "93000000-0000-4000-8000-000000000001",
  "93000000-0000-4000-8000-000000000002",
  "93000000-0000-4000-8000-000000000003",
] as const;

export const STALE_TOKENS = [
  "94000000-0000-4000-8000-000000000001",
  "94000000-0000-4000-8000-000000000002",
] as const;


export const ZERO_ERASURE_SUMMARY = {
  total: 0,
  removed: 0,
  alreadyAbsent: 0,
  failed: 0,
  pending: 0,
  complete: true,
} as const;


export type DeletionCommitFault =
  | "rollback-before-final-commit-ack"
  | "final-commit-ack-lost";

export type DeletionReport = Awaited<ReturnType<typeof deleteLearnerAccount>>;

export type FaultInjectableDeletionDependencies =
  NonNullable<Parameters<typeof deleteLearnerAccount>[1]>
  & Readonly<{ acquireClient: () => Promise<PoolClient> }>;

export type ApplicationTransaction =
  Parameters<Parameters<typeof db.transaction>[0]>[0];

export type QueryRows = Readonly<{
  rows: Record<string, unknown>[];
  rowCount?: number | null;
}>;


export type QueryEvent = Readonly<{
  clientOrdinal: number;
  pid: number;
  sql: string;
  values: unknown[];
}>;


export type QueryHooks = Readonly<{
  before?: (event: QueryEvent) => Promise<void>;
  after?: (event: QueryEvent, result: QueryRows) => Promise<void>;
}>;


export type CommitFault = "rollback-before-ack" | "commit-ack-lost";


export function normalizeSql(text: string) {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}


export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}


export async function within<T>(promise: Promise<T>, label: string, timeoutMs = 3_000): Promise<T> {
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


export class QueryPause {
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


export class Rendezvous {
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


export function isCandidateSelect(sql: string) {
  return sql.startsWith("select id::text")
    && sql.includes("from public.email_outbox")
    && sql.includes("limit 16");
}


export function isTryAdvisoryLock(sql: string) {
  return sql.includes("pg_try_advisory_xact_lock");
}


export function isBlockingAdvisoryLock(sql: string) {
  return sql.includes("pg_advisory_xact_lock") && !isTryAdvisoryLock(sql);
}


export class ClaimRaceCoordinator {
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


export class InstrumentedClient implements OutboxPgClient {
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


export class InstrumentedPool implements OutboxPgPool, MailDispatchStartupPool {
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


export /**
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


export function faultInjectableDeletionDependencies(
  fault: FinalDeletionCommitFault,
): FaultInjectableDeletionDependencies {
  return {
    processFileErasures: async () => ZERO_ERASURE_SUMMARY,
    acquireClient: () => fault.acquireClient(),
  };
}


export const workerPool = new Pool({
  connectionString: process.env.DATABASE_MAIL_WORKER_URL,
  max: MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolMaximumConnections,
  connectionTimeoutMillis: MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolAcquireTimeoutMs,
  idleTimeoutMillis: MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolIdleTimeoutMs,
});

export const operationsPool = new Pool({
  connectionString: process.env.DATABASE_OPS_URL,
  max: 2,
  connectionTimeoutMillis: MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolAcquireTimeoutMs,
  idleTimeoutMillis: MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolIdleTimeoutMs,
});

export const liveOutboxPool = new InstrumentedPool(workerPool);

export const outboxStores = new WeakMap<
  InstrumentedPool,
  Promise<PostgresOutboxStore>
>();


export async function store(outboxPool: InstrumentedPool = liveOutboxPool) {
  let selected = outboxStores.get(outboxPool);
  if (!selected) {
    selected = (async () => {
      registerMailWorkerResources(outboxPool, {}, requireDisposableDatabaseUrl("DATABASE_MAIL_WORKER_URL").href);
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


export type DisposableDatabaseUrlName =
  | "DATABASE_URL"
  | "DATABASE_APP_URL"
  | "DATABASE_MAIL_WORKER_URL"
  | "DATABASE_OPS_URL";


export const DISPOSABLE_DATABASE_ROLE = Object.freeze({
  DATABASE_URL: "learncoding_app",
  DATABASE_APP_URL: "learncoding_app",
  DATABASE_MAIL_WORKER_URL: "learncoding_mail_worker",
  DATABASE_OPS_URL: "learncoding_ops",
} satisfies Record<DisposableDatabaseUrlName, string>);


export function requireDisposableDatabaseUrl(name: DisposableDatabaseUrlName) {
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


export function assertDisposableDatabase() {
  if (process.env.INTEGRATION_TEST !== "1") {
    throw new Error("Mail delivery race tests require the disposable learncoding_integration database.");
  }
  const application = requireDisposableDatabaseUrl("DATABASE_URL");
  const explicitApplication =
    requireDisposableDatabaseUrl("DATABASE_APP_URL");
  const worker = requireDisposableDatabaseUrl("DATABASE_MAIL_WORKER_URL");
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


export async function truncateApplicationTables() {
  assertDisposableDatabase();
  await resetDisposableIntegrationDatabase(pool);
}


export async function waitForAdvisoryWaiters(
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


export async function waitForBlockedBackendBy(
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


export async function seedOutboxRows(
  kind: "pending" | "expired-pre-provider",
  count = 2,
): Promise<OutboxClaim<EmailOutboxPayload> | null> {
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
    return claim;
  }
  return null;
}


export async function waitForOutboxLeaseExpiry(
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


export function genuineBoundaryInput(
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


export async function requireClaim(
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


export async function beginProviderCall(
  claim: OutboxClaim<EmailOutboxPayload>,
  selectedStore?: PostgresOutboxStore,
) {
  const activeStore = selectedStore ?? await store();
  return await activeStore.beginProviderCall(
    claim,
    genuineBoundaryInput(activeStore, claim),
  );
}

export async function requireBoundary(
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


export async function requirePermit(
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


export async function requireGuardedBoundary(
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

export async function startGuardedDispatch(
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

export async function requireSentPersistenceUnknown(
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

export async function expiredPermit() {
  await seedOutboxRows("pending", 1);
  const claim = await requireClaim(CLAIM_TOKENS[0], "provider-worker");
  const permit = await requirePermit(claim);
  await waitForOutboxLeaseExpiry(claim.id, 30_000, 150_000);
  return { claim, permit };
}


export async function markUnresolvedQuarantined(rowId = ROW_IDS[0]) {
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


export async function outboxState() {
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


export function deletionInput(objectStorageRoot: string, requestId: string) {
  return {
    actorUserId: ADMIN_ID,
    learnerId: LEARNER_ID,
    requestId,
    reason: "Delete the synthetic learner during the deterministic mail boundary race.",
    now: new Date(),
    objectStorageRoot,
  } as const;
}


export function zeroErasureDependencies(pause?: QueryPause) {
  return {
    processFileErasures: async () => {
      if (pause) await pause.hold(-1);
      return ZERO_ERASURE_SUMMARY;
    },
  };
}


export async function applicationTransactionPid(tx: ApplicationTransaction) {
  const result = await tx.execute<{ pid: number }>(
    sql`select pg_catalog.pg_backend_pid()::integer as pid`,
  );
  const pid = Number(result.rows[0]?.pid);
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new Error("Application transaction did not expose a backend PID.");
  }
  return pid;
}


export async function persistApprovedAccessSystemMail(
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


export function deletionDependenciesWithHooks(
  hooks: QueryHooks,
): FaultInjectableDeletionDependencies {
  const instrumented = new InstrumentedPool(pool, hooks);
  return {
    processFileErasures: async () => ZERO_ERASURE_SUMMARY,
    acquireClient: async () =>
      await instrumented.connect() as unknown as PoolClient,
  };
}


export async function holdFinalizerUserAuthorityGate() {
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


export async function runDeletionFinalizerRace(
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


export function requireSingleSuccessfulFinalizer(
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


export async function deletionPersistenceState(report: DeletionReport) {
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

export function expectSingleDurableDeletionNotice(
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


export const previousDeletionKey = process.env.DELETION_TOMBSTONE_KEY;

export const previousApplicationUrl = process.env.APP_URL;

export let objectStorageRoot = "";

export function registerMailDeliveryRaceHarness() {
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
      effective_role: "learncoding_mail_worker",
      session_role: "learncoding_mail_worker",
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
}
