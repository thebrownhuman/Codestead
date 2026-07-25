import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { Pool, type PoolClient } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { deleteLearnerAccount } from "@/lib/data-lifecycle/deletion";
import { db, pool } from "@/lib/db/client";
import { emailOutbox, user } from "@/lib/db/schema";
import {
  createMaterializedDispatch,
  materializedDispatchEnvelope,
  type PreparedDispatchEnvelope,
} from "@/lib/notifications/guarded-prepared-dispatch";
import {
  disarmMailDispatchHardWatchdog,
  startMailDispatchHardWatchdog,
  type ArmedMailDispatchHardWatchdog,
  type MailDispatchHardWatchdog,
} from "@/lib/notifications/mail-dispatch-hard-watchdog";
import {
  inspectMailDispatchRuntime,
  type MailDispatchRuntimeStartupInspection,
} from "@/lib/notifications/mail-dispatch-runtime-startup";
import {
  captureMailTransportConfiguration,
} from "@/lib/notifications/mailer-transport-internal";
import {
  authorizeCommittedPreparedDispatch,
  guardedDispatchResultSafeToDisarm,
  mailDispatchPreparedRuntimePlan,
  PostgresOutboxStore,
  releaseGuardedDispatchWatchdogClaim,
  type EmailOutboxPayload,
  type OutboxPgClient,
  type OutboxPgPool,
} from "@/lib/notifications/postgres-outbox-store";
import { outboxMessageId } from "@/lib/notifications/provider-correlation";
import {
  PRODUCTION_EMAIL_TEMPLATES,
  type EmailTemplate,
} from "@/lib/notifications/template-authority-policy";
import {
  USER_AUTHORITY_ADVISORY_LOCK_SQL,
  userAuthorityLockKey,
} from "@/lib/security/user-authority-lock";
import type {
  GuardedDispatchResult,
  OutboxClaim,
  ProviderCallPermit,
} from "@/lib/notifications/outbox-worker";

const ADMIN_ID = "mail-race-admin";
const LEARNER_ID = "mail-race-learner";
const SECONDARY_USER_ID = "mail-race-secondary";
const LEARNER_PUBLIC_ID = "90000000-0000-4000-8000-000000000001";
const SECONDARY_PUBLIC_ID = "90000000-0000-4000-8000-000000000002";
const LEARNER_EMAIL = "mail-race-learner@integration.invalid";
const SECONDARY_EMAIL = "mail-race-secondary@integration.invalid";

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

const BACKUP_AUTHORITY_IDS = [
  "96000000-0000-4000-8000-000000000001",
  "96000000-0000-4000-8000-000000000002",
] as const;
const BACKUP_OUTBOX_IDS = [
  "97000000-0000-4000-8000-000000000001",
  "97000000-0000-4000-8000-000000000002",
] as const;
const BACKUP_OPERATION_IDS = [
  "98000000-0000-4000-8000-000000000001",
  "98000000-0000-4000-8000-000000000002",
] as const;
const BACKUP_RUN_KEYS = [
  "20260725T000001Z",
  "20260725T000002Z",
] as const;
const BACKUP_SUCCESS_SUMMARY =
  "The nightly encrypted backup completed and passed local verification. No archive is attached to this email.";

const ZERO_ERASURE_SUMMARY = {
  total: 0,
  removed: 0,
  alreadyAbsent: 0,
  failed: 0,
  pending: 0,
  complete: true,
} as const;

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

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
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

  removeListener(event: "end", listener: () => void) {
    this.inner.removeListener(event, listener);
    return this;
  }
}

const mailPool = new Pool({
  application_name: "codestead_mail_delivery_races",
  connectionString:
    process.env.DATABASE_WORKER_URL
    ?? process.env.DATABASE_URL
    ?? "postgresql://learncoding:learncoding@localhost:5432/learncoding",
  connectionTimeoutMillis: 2_000,
  idleTimeoutMillis: 30_000,
  max: 3,
});

const adminWriterPool = new Pool({
  application_name: "codestead_admin_epoch_writer",
  connectionString:
    process.env.DATABASE_APP_URL
    ?? process.env.DATABASE_URL
    ?? "postgresql://learncoding:learncoding@localhost:5432/learncoding",
  connectionTimeoutMillis: 2_000,
  idleTimeoutMillis: 30_000,
  max: 1,
});

let mailInspection: MailDispatchRuntimeStartupInspection | null = null;

class InstrumentedPool implements OutboxPgPool {
  readonly options = Object.freeze({
    max: 3,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
  });

  private nextClientOrdinal = 1;
  private commitFaultConsumed = false;

  constructor(
    private readonly hooks: QueryHooks = {},
    private readonly commitFault: CommitFault | null = null,
    private readonly sourcePool: Pool = mailPool,
  ) {}

  async query(text: string) {
    return await this.sourcePool.query(text);
  }

  async connect() {
    const inner = await this.sourcePool.connect();
    const pid = (await inner.query<{ pid: number }>("select pg_backend_pid() pid")).rows[0]!.pid;
    const clientOrdinal = this.nextClientOrdinal;
    this.nextClientOrdinal += 1;
    return new InstrumentedClient(
      inner,
      clientOrdinal,
      pid,
      this.hooks,
      () => {
        if (this.commitFaultConsumed || this.commitFault === null) return null;
        this.commitFaultConsumed = true;
        return this.commitFault;
      },
    );
  }
}

const liveOutboxPool = mailPool as unknown as OutboxPgPool;

function store() {
  if (!mailInspection) {
    throw new Error("Mail dispatch runtime was not inspected.");
  }
  return new PostgresOutboxStore(liveOutboxPool, mailInspection);
}

async function instrumentedStore(outboxPool: InstrumentedPool) {
  const inspection = await inspectMailDispatchRuntime(outboxPool);
  return new PostgresOutboxStore(outboxPool, inspection);
}

function productionTemplate(value: string): EmailTemplate {
  const template = PRODUCTION_EMAIL_TEMPLATES.find(
    (candidate) => candidate === value,
  );
  if (!template) throw new Error("Outbox template is not production mail.");
  return template;
}

function preparedEnvelope(
  claim: OutboxClaim<EmailOutboxPayload>,
  selectedStore: PostgresOutboxStore,
  adapter: "console" | "gmail" = "console",
): PreparedDispatchEnvelope {
  const runtimePlan = mailDispatchPreparedRuntimePlan(selectedStore);
  if (!runtimePlan) throw new Error("Mail dispatch runtime plan was not issued.");
  const materialized = createMaterializedDispatch({
    source: {
      applicationUrl: "http://localhost:3000",
      outboxId: claim.id,
      operationId: claim.operationId,
      claimToken: claim.claimToken,
      claimOwner: claim.claimOwner,
      claimVersion: claim.claimVersion,
      deliveryScopeKey: claim.deliveryScopeKey,
      recipient: claim.payload.to,
      template: productionTemplate(claim.payload.template),
      templateVersion: claim.payload.templateVersion,
      variables: claim.payload.variables,
    },
    adapter,
    from: "Codestead <mail@codestead.test>",
    messageId: outboxMessageId(claim.operationId),
    runtimePlan,
    transportConfiguration: captureMailTransportConfiguration(adapter),
  });
  const envelope = materializedDispatchEnvelope(materialized);
  if (!envelope) throw new Error("Prepared dispatch envelope was not issued.");
  return envelope;
}

async function beginBoundary(
  claim: OutboxClaim<EmailOutboxPayload>,
  selectedStore: PostgresOutboxStore,
  adapter: "console" | "gmail" = "console",
) {
  return await selectedStore.beginProviderCall(claim, {
    adapter,
    envelope: preparedEnvelope(claim, selectedStore, adapter),
  });
}

type GuardedDispatchRun = Readonly<{
  store: PostgresOutboxStore;
  controller: MailDispatchHardWatchdog;
  armed: ArmedMailDispatchHardWatchdog;
  completion: Promise<GuardedDispatchResult>;
}>;

async function startGuardedGmailDispatch(
  claim: OutboxClaim<EmailOutboxPayload>,
  selectedStore: PostgresOutboxStore,
): Promise<GuardedDispatchRun> {
  const boundary = await beginBoundary(claim, selectedStore, "gmail");
  if (boundary.kind !== "applied") {
    throw new Error(`Expected applied Gmail boundary, got ${boundary.kind}.`);
  }
  const guarded = await authorizeCommittedPreparedDispatch(
    selectedStore,
    boundary.receipt,
  );
  const controller = await startMailDispatchHardWatchdog();
  const armed = await controller.arm();
  const completion = selectedStore.dispatchAfterProviderBoundary(
    boundary.permit,
    guarded,
    armed,
  );
  return { store: selectedStore, controller, armed, completion };
}

async function completeGuardedDispatch(
  run: GuardedDispatchRun,
): Promise<GuardedDispatchResult> {
  const result = await within(run.completion, "guarded Gmail dispatch", 10_000);
  expect(
    guardedDispatchResultSafeToDisarm(run.store, run.armed, result),
  ).toBe(true);
  expect(
    guardedDispatchResultSafeToDisarm(run.store, run.armed, result),
  ).toBe(false);
  await disarmMailDispatchHardWatchdog(run.armed);
  expect(releaseGuardedDispatchWatchdogClaim(run.store, run.armed)).toBe(true);
  await run.controller.close();
  return result;
}
function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Mail delivery race tests require the disposable learncoding_integration database.");
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  const result = await pool.query<{ table_name: string }>(`
    select table_name from information_schema.tables
     where table_schema = 'public'
       and table_type = 'BASE TABLE'
       and table_name not in (
         'backup_status_mail_authority',
         'backup_status_mail_admin_guard'
       )
  `);
  if (!result.rows.length) return;
  const names = result.rows
    .map(({ table_name }) => `"${table_name.replaceAll('"', '""')}"`)
    .join(", ");
  await pool.query(`truncate table ${names} restart identity cascade`);
}

async function waitForAdvisoryWaiters(blockerPid: number, expectedCount: number) {
  const deadline = Date.now() + 3_000;
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

type AdvisoryBlock = Readonly<{
  blocker_pid: number;
  blocker_role: string;
  blocker_application: string;
  waiter_pid: number;
  waiter_role: string;
  waiter_application: string;
  waiter_query: string;
  wait_event_type: string | null;
  wait_event: string | null;
  classid: string;
  objid: string;
}>;

async function waitForAdvisoryBlock(
  blockerPid: number,
  label: string,
): Promise<AdvisoryBlock> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<AdvisoryBlock>(`
      select blocker.pid::integer as blocker_pid,
             blocker_activity.usename::text as blocker_role,
             coalesce(blocker_activity.application_name, '')::text
               as blocker_application,
             waiter.pid::integer as waiter_pid,
             waiter_activity.usename::text as waiter_role,
             coalesce(waiter_activity.application_name, '')::text
               as waiter_application,
             waiter_activity.query::text as waiter_query,
             waiter_activity.wait_event_type::text as wait_event_type,
             waiter_activity.wait_event::text as wait_event,
             blocker.classid::text as classid,
             blocker.objid::text as objid
        from pg_catalog.pg_locks as blocker
        join pg_catalog.pg_locks as waiter
          on waiter.locktype = blocker.locktype
         and waiter.database is not distinct from blocker.database
         and waiter.classid is not distinct from blocker.classid
         and waiter.objid is not distinct from blocker.objid
         and waiter.objsubid is not distinct from blocker.objsubid
        join pg_catalog.pg_stat_activity as blocker_activity
          on blocker_activity.pid = blocker.pid
        join pg_catalog.pg_stat_activity as waiter_activity
          on waiter_activity.pid = waiter.pid
       where blocker.pid = $1
         and blocker.locktype = 'advisory'
         and blocker.granted
         and not waiter.granted
         and waiter.pid <> blocker.pid
       order by waiter.pid
    `, [blockerPid]);
    if (result.rows.length === 1) return result.rows[0]!;
    if (result.rows.length > 1) {
      throw new Error(`${label} had multiple advisory waiters.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} did not expose its advisory blocker in time.`);
}

function expectAdvisoryLockCoordinates(block: AdvisoryBlock) {
  expect(block.classid).toMatch(/^(?:0|[1-9][0-9]*)$/u);
  expect(block.objid).toMatch(/^(?:0|[1-9][0-9]*)$/u);
}

async function deadlockCount(): Promise<bigint> {
  const result = await pool.query<{ deadlocks: string }>(`
    select deadlocks::text as deadlocks
      from pg_catalog.pg_stat_database
     where datname = pg_catalog.current_database()
  `);
  const value = result.rows[0]?.deadlocks;
  if (!value || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("PostgreSQL deadlock counter is unavailable.");
  }
  return BigInt(value);
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
      idempotencyKey: `mail-race:${kind}:${index}`,
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

type BackupAuthorityFixture = Readonly<{
  authorityEpoch: string;
  authorityId: string;
  outboxId: string;
  operationId: string;
  runKey: string;
}>;

async function adminAuthorityEpoch(): Promise<string> {
  const result = await pool.query<{ authority_epoch: string }>(`
    select authority_epoch::text as authority_epoch
      from public.backup_status_mail_admin_guard
     where singleton is true
  `);
  const value = result.rows[0]?.authority_epoch;
  if (!value) {
    throw new Error("Backup-status administrator authority guard is missing.");
  }
  return value;
}

type AdministratorHandoffState = Readonly<{
  active_admins: number;
  prior_role: string;
  source_epoch: string;
  successor_role: string;
}>;

async function administratorHandoffState(
  authorityId: string,
): Promise<AdministratorHandoffState> {
  const result = await pool.query<AdministratorHandoffState>(`
    select (
             select pg_catalog.count(*)::integer
               from public."user"
              where role = 'admin'
                and status = 'active'
                and coalesce(banned, false) = false
           ) as active_admins,
           (
             select role::text
               from public."user"
              where id = $2::text
           ) as prior_role,
           source.authority_epoch::text as source_epoch,
           (
             select role::text
               from public."user"
              where id = $3::text
           ) as successor_role
      from public.backup_status_mail_authority as source
     where source.id = $1::uuid
  `, [authorityId, ADMIN_ID, SECONDARY_USER_ID]);
  if (result.rows.length !== 1) {
    throw new Error("Administrator handoff authority evidence is missing.");
  }
  return result.rows[0]!;
}

async function seedBackupStatusOutbox(
  index: 0 | 1,
): Promise<BackupAuthorityFixture> {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query("begin");
    open = true;
    const authorityEpoch = await client.query<{ authority_epoch: string }>(`
      select authority_epoch::text as authority_epoch
        from public.backup_status_mail_admin_guard
       where singleton is true
    `);
    const selectedEpoch = authorityEpoch.rows[0]?.authority_epoch;
    if (!selectedEpoch) {
      throw new Error("Backup-status administrator authority guard is missing.");
    }

    await client.query(`
      insert into public.email_outbox (
        id,
        operation_id,
        user_id,
        delivery_scope_key,
        to_email,
        template,
        template_version,
        variables,
        idempotency_key
      ) values (
        $1::uuid,
        $2::uuid,
        $3::text,
        'a:' || $3::text,
        $4::text,
        'backup-status',
        '1',
        pg_catalog.jsonb_build_object(
          'name',
          'Administrator',
          'summary',
          $5::text
        ),
        'backup-status:v1:' || $6::text
      )
    `, [
      BACKUP_OUTBOX_IDS[index],
      BACKUP_OPERATION_IDS[index],
      ADMIN_ID,
      "mail-race-admin@integration.invalid",
      BACKUP_SUCCESS_SUMMARY,
      BACKUP_RUN_KEYS[index],
    ]);
    await client.query(`
      insert into public.backup_status_mail_authority (
        id,
        run_key,
        outcome,
        outbox_id,
        operation_id,
        authority_epoch
      ) values (
        $1::uuid,
        $2::text,
        'success',
        $3::uuid,
        $4::uuid,
        $5::uuid
      )
    `, [
      BACKUP_AUTHORITY_IDS[index],
      BACKUP_RUN_KEYS[index],
      BACKUP_OUTBOX_IDS[index],
      BACKUP_OPERATION_IDS[index],
      selectedEpoch,
    ]);
    await client.query("commit");
    open = false;
    return {
      authorityEpoch: selectedEpoch,
      authorityId: BACKUP_AUTHORITY_IDS[index],
      outboxId: BACKUP_OUTBOX_IDS[index],
      operationId: BACKUP_OPERATION_IDS[index],
      runKey: BACKUP_RUN_KEYS[index],
    };
  } catch (error) {
    if (open) await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type AdminHandoffTransaction = Readonly<{
  client: PoolClient;
  pid: number;
}>;

async function beginAdminHandoffTransaction(): Promise<AdminHandoffTransaction> {
  const client = await adminWriterPool.connect();
  let open = false;
  try {
    await client.query("begin");
    open = true;
    const pid = (
      await client.query<{ pid: number }>(
        "select pg_catalog.pg_backend_pid()::integer as pid",
      )
    ).rows[0]!.pid;
    return { client, pid };
  } catch (error) {
    if (open) await client.query("rollback").catch(() => undefined);
    client.release();
    throw error;
  }
}

async function transferAdministratorAuthority(client: PoolClient) {
  const userIds = [ADMIN_ID, SECONDARY_USER_ID].sort();
  for (const userId of userIds) {
    await client.query(
      USER_AUTHORITY_ADVISORY_LOCK_SQL,
      [userAuthorityLockKey(userId)],
    );
  }
  for (const userId of userIds) {
    const locked = await client.query<{ id: string }>(`
      select id
        from public."user"
       where id = $1::text
       for update
    `, [userId]);
    if (locked.rows.length !== 1) {
      throw new Error("Administrator handoff user is missing.");
    }
  }

  const demoted = await client.query(`
    update public."user"
       set role = 'learner'
     where id = $1::text
       and role = 'admin'
  `, [ADMIN_ID]);
  if (demoted.rowCount !== 1) {
    throw new Error("Current administrator was not demoted exactly once.");
  }
  const promoted = await client.query(`
    update public."user"
       set role = 'admin'
     where id = $1::text
       and role = 'learner'
  `, [SECONDARY_USER_ID]);
  if (promoted.rowCount !== 1) {
    throw new Error("Successor administrator was not promoted exactly once.");
  }
}

async function requireClaim(
  token: string,
  owner: string,
  selectedStore = store(),
): Promise<OutboxClaim<EmailOutboxPayload>> {
  const claim = await selectedStore.claimNext({ owner, token, leaseMs: 120_000 });
  expect(claim).not.toBeNull();
  if (!claim) throw new Error(`Expected ${owner} to claim one outbox row.`);
  return claim;
}

async function requirePermit(
  claim: OutboxClaim<EmailOutboxPayload>,
  selectedStore = store(),
): Promise<ProviderCallPermit> {
  const boundary = await beginBoundary(claim, selectedStore);
  expect(boundary.kind).toBe("applied");
  if (boundary.kind !== "applied") throw new Error("Expected provider boundary authority.");
  return boundary.permit;
}

async function expiredPermit(selectedStore = store()) {
  await seedOutboxRows("pending", 1);
  const claim = await requireClaim(CLAIM_TOKENS[0], "provider-worker");
  const permit = await requirePermit(claim, selectedStore);
  await pool.query(
    `update email_outbox
        set lease_expires_at = lease_expires_at - interval '4 minutes'
      where id = $1::uuid`,
    [claim.id],
  );
  return { claim, permit, selectedStore };
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

const previousDeletionKey = process.env.DELETION_TOMBSTONE_KEY;
let objectStorageRoot = "";

beforeAll(async () => {
  assertDisposableDatabase();
  process.env.DELETION_TOMBSTONE_KEY = "mail-race-deletion-key-long-enough-for-integration";
  mailInspection = await inspectMailDispatchRuntime(mailPool);
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
      emailVerified: true,
      role: "learner",
      status: "active",
    },
    {
      id: SECONDARY_USER_ID,
      publicId: SECONDARY_PUBLIC_ID,
      name: "Mail Race Secondary",
      email: SECONDARY_EMAIL,
      role: "learner",
      status: "active",
    },
  ]);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (objectStorageRoot) {
    await rm(objectStorageRoot, { recursive: true, force: true });
    objectStorageRoot = "";
  }
});

afterAll(async () => {
  if (previousDeletionKey === undefined) delete process.env.DELETION_TOMBSTONE_KEY;
  else process.env.DELETION_TOMBSTONE_KEY = previousDeletionKey;
  await Promise.all([
    mailPool.end(),
    adminWriterPool.end(),
    pool.end(),
  ]);
});

describe("real PostgreSQL mail delivery races", () => {
  it("revalidates a selected claim candidate at the CAS after a concurrent winner changes it", async () => {
    await seedOutboxRows("pending", 1);
    const candidatePause = new QueryPause();
    const claimantStore = await instrumentedStore(new InstrumentedPool({
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

    await expect(store().claimNext({
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

    await expect(store().claimNext({
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
    const selectedStore = store();
    const permit = await requirePermit(claim, selectedStore);

    await expect(selectedStore.finishAfterProvider(permit, {
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
    const racingStore = await instrumentedStore(new InstrumentedPool(race.hooks));
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

    const followUp = await store().claimNext({
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
    const rollbackStore = await instrumentedStore(new InstrumentedPool({}, "rollback-before-ack"));

    await expect(beginBoundary(claim, rollbackStore))
      .rejects.toThrow("forced boundary rollback");

    expect((await outboxState())[0]).toMatchObject({
      status: "sending",
      adapter: null,
      provider_call_started: null,
      claim_version: claim.claimVersion,
    });
    const retryStore = store();
    await expect(beginBoundary(claim, retryStore))
      .resolves.toMatchObject({ kind: "applied" });
  });

  it("persists an unknown provider-boundary commit without reconstructing a permit", async () => {
    await seedOutboxRows("pending", 1);
    const claim = await requireClaim(CLAIM_TOKENS[0], "unknown-commit-worker");
    const unknownCommitStore = await instrumentedStore(new InstrumentedPool({}, "commit-ack-lost"));

    await expect(beginBoundary(claim, unknownCommitStore))
      .rejects.toThrow("forced boundary commit acknowledgement loss");

    expect((await outboxState())[0]).toMatchObject({
      status: "sending",
      adapter: "console",
    });
    expect((await outboxState())[0]!.provider_call_started).not.toBeNull();
    const retryStore = store();
    await expect(beginBoundary(claim, retryStore))
      .resolves.toEqual({ kind: "lost" });
  });

  it("keeps provider boundary details opaque while finalizing exact stored authority", async () => {
    await seedOutboxRows("pending", 1);
    const claim = await requireClaim(CLAIM_TOKENS[0], "precision-worker");
    const selectedStore = store();
    const permit = await requirePermit(claim, selectedStore);
    expect(Object.isFrozen(permit)).toBe(true);
    expect(Reflect.ownKeys(permit)).toEqual([]);

    const captured = await pool.query<{ provider_call_started: string }>(`
      select provider_call_started::text as provider_call_started
        from email_outbox
       where id = $1::uuid
    `, [claim.id]);
    expect(captured.rows[0]?.provider_call_started).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\+00$/u,
    );

    await expect(selectedStore.finishAfterProvider(permit, {
      kind: "failed",
      code: "PROVIDER_DEFINITELY_REJECTED",
    })).resolves.toEqual({ kind: "applied" });
  });
  it("lets a definite-rejection finalizer that owns the scope lock beat the sweeper", async () => {
    const finalizerPause = new QueryPause();
    const finalizerStore = await instrumentedStore(new InstrumentedPool({
      after: async (event) => {
        if (isBlockingAdvisoryLock(event.sql)) await finalizerPause.hold(event.pid);
      },
    }));
    const { permit } = await expiredPermit(finalizerStore);
    const finalizing = finalizerStore.finishAfterProvider(permit, {
      kind: "failed",
      code: "PROVIDER_DEFINITELY_REJECTED",
    });
    await within(finalizerPause.reached, "finalizer scope lock");

    let swept: number;
    try {
      swept = await within(
        store().quarantineAbandoned({ limit: 10 }),
        "non-blocking abandoned-send sweep",
      );
    } finally {
      finalizerPause.release();
    }
    const finalized = await finalizing;

    expect(swept).toBe(0);
    expect(finalized).toEqual({ kind: "applied" });
    expect((await outboxState())[0]).toMatchObject({
      status: "failed",
      provider_message_id: null,
      quarantined_at: null,
      last_error_code: "PROVIDER_DEFINITELY_REJECTED",
    });
  });

  it("lets a late definite rejection finalize the released sweeper successor", async () => {
    const { claim, permit, selectedStore } = await expiredPermit();
    const sweeperPause = new QueryPause();
    const sweeperStore = await instrumentedStore(new InstrumentedPool({
      after: async (event, result) => {
        if (isTryAdvisoryLock(event.sql) && result.rows[0]?.locked === true) {
          await sweeperPause.hold(event.pid);
        }
      },
    }));
    const sweeping = sweeperStore.quarantineAbandoned({ limit: 10 });
    await within(sweeperPause.reached, "sweeper scope lock");
    const finalizing = selectedStore.finishAfterProvider(permit, {
      kind: "failed",
      code: "PROVIDER_DEFINITELY_REJECTED",
    });

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
    expect(finalized).toEqual({ kind: "applied" });
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

  it("rejects public sent finalization and preserves unresolved quarantine", async () => {
    const { claim, permit, selectedStore } = await expiredPermit();

    await expect(store().quarantineAbandoned({ limit: 10 })).resolves.toBe(1);
    await expect(selectedStore.finishAfterProvider(permit, {
      kind: "sent",
      providerMessageId: "forged-public-sent-result",
    })).rejects.toThrow(
      "Sent finalization requires a module-issued guarded-dispatch uncertainty.",
    );

    expect((await outboxState())[0]).toMatchObject({
      status: "quarantined",
      claim_version: claim.claimVersion + 1,
      claim_token: null,
      claim_owner: null,
      lease_expires_at: null,
      provider_message_id: null,
      sent_at: null,
      last_error_code: "ABANDONED_POST_PROVIDER_BOUNDARY",
    });
  });
  it("makes deletion win the account lock before TX1 with provider callback zero", async () => {
    vi.stubEnv("GMAIL_CLIENT_ID", "integration-client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "integration-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "integration-refresh");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("Provider transport must not run after deletion wins.");
    });
    vi.stubGlobal("fetch", fetch);

    await seedOutboxRows("pending", 1);
    const boundaryPid = deferred<number>();
    let observeBoundaryLock = false;
    const selectedStore = await instrumentedStore(new InstrumentedPool({
      before: async (event) => {
        if (observeBoundaryLock && isBlockingAdvisoryLock(event.sql)) {
          observeBoundaryLock = false;
          boundaryPid.resolve(event.pid);
        }
      },
    }));
    const claim = await requireClaim(
      CLAIM_TOKENS[0],
      "deletion-first-real-worker",
      selectedStore,
    );
    const deadlocksBefore = await deadlockCount();
    const runnerBarrier = await pool.connect();
    let barrierOpen = false;
    let deletion: ReturnType<typeof deleteLearnerAccount> | null = null;
    let boundary: ReturnType<typeof beginBoundary> | null = null;
    let deletionBlock: AdvisoryBlock | null = null;
    let boundaryBlock: AdvisoryBlock | null = null;
    let providerCallsWhileBlocked = -1;
    let boundaryOutcome: Awaited<ReturnType<typeof beginBoundary>> | null = null;
    let deletionReport: Awaited<ReturnType<typeof deleteLearnerAccount>> | null = null;

    try {
      await runnerBarrier.query("begin");
      barrierOpen = true;
      await runnerBarrier.query(
        "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1))",
        [`runner-learner:${LEARNER_ID}`],
      );
      const runnerBarrierPid = (
        await runnerBarrier.query<{ pid: number }>(
          "select pg_catalog.pg_backend_pid()::integer as pid",
        )
      ).rows[0]!.pid;

      deletion = deleteLearnerAccount(
        deletionInput(
          objectStorageRoot,
          "95000000-0000-4000-8000-000000000002",
        ),
        zeroErasureDependencies(),
      );
      deletionBlock = await waitForAdvisoryBlock(
        runnerBarrierPid,
        "deletion waiting behind the runner barrier",
      );

      observeBoundaryLock = true;
      boundary = beginBoundary(claim, selectedStore, "gmail");
      const workerPid = await within(
        boundaryPid.promise,
        "TX1 account-lock attempt",
      );
      boundaryBlock = await waitForAdvisoryBlock(
        deletionBlock.waiter_pid,
        "TX1 waiting behind deletion authority",
      );
      providerCallsWhileBlocked = fetch.mock.calls.length;

      await runnerBarrier.query("commit");
      barrierOpen = false;
      [boundaryOutcome, deletionReport] = await Promise.all([
        boundary,
        deletion,
      ]);

      expect(boundaryBlock.waiter_pid).toBe(workerPid);
    } finally {
      if (barrierOpen) await runnerBarrier.query("rollback").catch(() => undefined);
      runnerBarrier.release();
      await Promise.allSettled([
        ...(boundary ? [boundary] : []),
        ...(deletion ? [deletion] : []),
      ]);
    }

    expect(deletionBlock).toMatchObject({
      blocker_application: "",
    });
    expectAdvisoryLockCoordinates(deletionBlock!);
    expect(boundaryBlock).toMatchObject({
      blocker_pid: deletionBlock!.waiter_pid,
      waiter_application: "codestead_mail_delivery_races",
      waiter_role: "learncoding_worker",
    });
    expectAdvisoryLockCoordinates(boundaryBlock!);
    expect(providerCallsWhileBlocked).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(boundaryOutcome?.kind).not.toBe("applied");
    expect(deletionReport).toMatchObject({
      primaryStoreDeletionComplete: true,
      objectFileErasureComplete: true,
    });
    expect(await deadlockCount()).toBe(deadlocksBefore);

    const original = await pool.query<{ count: number }>(`
      select count(*)::integer as count
        from public.email_outbox
       where operation_id = $1::uuid
    `, [claim.operationId]);
    expect(original.rows[0]?.count).toBe(0);
    const notices = (await outboxState()).filter(
      (row) => row.template === "account-deleted",
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.variables).toEqual(expect.objectContaining({
      tombstoneId: deletionReport!.tombstoneId,
      deletionRunId: deletionReport!.runId,
    }));
  });

  it("holds TX2 account authority through one ambiguous provider callback before deletion", async () => {
    vi.stubEnv("GMAIL_CLIENT_ID", "integration-client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "integration-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "integration-refresh");
    const sendStarted = deferred<void>();
    const sendResult = deferred<Response>();
    let providerCallbackCount = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        return new Response('{"access_token":"integration-access"}', {
          status: 200,
        });
      }
      if (
        String(url)
          === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
      ) {
        providerCallbackCount += 1;
        sendStarted.resolve();
        return await sendResult.promise;
      }
      throw new Error("Unexpected Gmail integration URL.");
    });
    vi.stubGlobal("fetch", fetch);

    await seedOutboxRows("pending", 1);
    const tx2Pid = deferred<number>();
    let capturedTx2Pid = false;
    const selectedStore = await instrumentedStore(new InstrumentedPool({
      after: async (event) => {
        if (
          !capturedTx2Pid
          && event.sql.startsWith("select 1 from public.email_outbox")
        ) {
          capturedTx2Pid = true;
          tx2Pid.resolve(event.pid);
        }
      },
    }));
    const claim = await requireClaim(
      CLAIM_TOKENS[0],
      "tx2-first-real-worker",
      selectedStore,
    );
    const deadlocksBefore = await deadlockCount();
    const run = await startGuardedGmailDispatch(claim, selectedStore);
    const [providerTx2Pid] = await within(
      Promise.all([tx2Pid.promise, sendStarted.promise]).then(
        ([pid]) => [pid] as const,
      ),
      "TX2 provider callback",
      10_000,
    );
    expect(providerCallbackCount).toBe(1);

    const deletion = deleteLearnerAccount(
      deletionInput(
        objectStorageRoot,
        "95000000-0000-4000-8000-000000000001",
      ),
      zeroErasureDependencies(),
    );
    const deletionBlock = await waitForAdvisoryBlock(
      providerTx2Pid,
      "deletion waiting behind live TX2",
    );
    expect(deletionBlock).toMatchObject({
      blocker_application: "codestead_mail_delivery_races",
      blocker_role: "learncoding_worker",
    });
    expectAdvisoryLockCoordinates(deletionBlock);
    expect(deletionBlock.waiter_pid).not.toBe(providerTx2Pid);
    expect(providerCallbackCount).toBe(1);

    sendResult.reject(new Error("ambiguous Gmail provider outcome"));
    const dispatchResult = await completeGuardedDispatch(run);
    const deletionOutcome = await Promise.allSettled([deletion]);

    expect(dispatchResult).toEqual({
      kind: "applied",
      exit: {
        kind: "quarantined",
        code: "PROVIDER_OUTCOME_UNKNOWN",
      },
    });
    expect(deletionOutcome[0]?.status).toBe("rejected");
    if (deletionOutcome[0]?.status === "rejected") {
      expect(deletionOutcome[0].reason).toMatchObject({
        code: "PROVIDER_OPERATION_IN_PROGRESS",
      });
    }
    expect(providerCallbackCount).toBe(1);
    expect(await deadlockCount()).toBe(deadlocksBefore);
    expect((await outboxState())[0]).toMatchObject({
      id: claim.id,
      status: "quarantined",
      provider_message_id: null,
      sent_at: null,
      last_error_code: "PROVIDER_OUTCOME_UNKNOWN",
    });
    await expect(selectedStore.claimNext({
      owner: "tx2-no-resend-probe",
      token: CLAIM_TOKENS[1],
      leaseMs: 120_000,
    })).resolves.toBeNull();
    expect((await pool.query<{ status: string }>(
      `select status::text from public."user" where id = $1`,
      [LEARNER_ID],
    )).rows[0]?.status).toBe("active");
  });

  it("makes a different-user admin epoch writer beat TX2 with provider callback zero", async () => {
    vi.stubEnv("GMAIL_CLIENT_ID", "integration-client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "integration-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "integration-refresh");
    let providerCallbackCount = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        return new Response('{"access_token":"integration-access"}', {
          status: 200,
        });
      }
      if (
        String(url)
          === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
      ) {
        providerCallbackCount += 1;
        throw new Error(
          "Provider send must not run after the administrator epoch changes.",
        );
      }
      throw new Error("Unexpected Gmail integration URL.");
    });
    vi.stubGlobal("fetch", fetch);

    const fixture = await seedBackupStatusOutbox(0);
    const tx2Pid = deferred<number>();
    let observeTx2AccountLock = false;
    let capturedTx2Pid = false;
    const selectedStore = await instrumentedStore(new InstrumentedPool({
      before: async (event) => {
        if (
          observeTx2AccountLock
          && !capturedTx2Pid
          && isBlockingAdvisoryLock(event.sql)
        ) {
          capturedTx2Pid = true;
          tx2Pid.resolve(event.pid);
        }
      },
    }));
    const claim = await requireClaim(
      CLAIM_TOKENS[0],
      "admin-epoch-writer-first-worker",
      selectedStore,
    );
    expect(claim.id).toBe(fixture.outboxId);
    const boundary = await beginBoundary(claim, selectedStore, "gmail");
    if (boundary.kind !== "applied") {
      throw new Error(`Expected applied Gmail boundary, got ${boundary.kind}.`);
    }
    const guarded = await authorizeCommittedPreparedDispatch(
      selectedStore,
      boundary.receipt,
    );
    const deadlocksBefore = await deadlockCount();
    const handoff = await beginAdminHandoffTransaction();
    let handoffOpen = true;
    let run: GuardedDispatchRun | null = null;
    let runClosed = false;

    try {
      await transferAdministratorAuthority(handoff.client);
      observeTx2AccountLock = true;
      const controller = await startMailDispatchHardWatchdog();
      const armed = await controller.arm();
      run = {
        store: selectedStore,
        controller,
        armed,
        completion: selectedStore.dispatchAfterProviderBoundary(
          boundary.permit,
          guarded,
          armed,
        ),
      };
      const providerTx2Pid = await within(
        tx2Pid.promise,
        "TX2 account authority lock",
      );
      const block = await waitForAdvisoryBlock(
        handoff.pid,
        "TX2 waiting behind the two-user administrator handoff",
      );

      expect(block).toMatchObject({
        blocker_pid: handoff.pid,
        blocker_role: "learncoding_app",
        blocker_application: "codestead_admin_epoch_writer",
        waiter_pid: providerTx2Pid,
        waiter_role: "learncoding_worker",
        waiter_application: "codestead_mail_delivery_races",
      });
      expectAdvisoryLockCoordinates(block);
      expect(providerCallbackCount).toBe(0);

      await handoff.client.query("commit");
      handoffOpen = false;
      const dispatchResult = await completeGuardedDispatch(run);
      runClosed = true;

      expect(dispatchResult).toEqual({ kind: "lost" });
      expect(providerCallbackCount).toBe(0);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      if (handoffOpen) {
        await handoff.client.query("rollback").catch(() => undefined);
      }
      handoff.client.release();
      if (run && !runClosed) {
        await completeGuardedDispatch(run).catch(() => undefined);
      }
    }

    const currentEpoch = await adminAuthorityEpoch();
    expect(currentEpoch).not.toBe(fixture.authorityEpoch);
    expect(await deadlockCount()).toBe(deadlocksBefore);
    expect((await outboxState())[0]).toMatchObject({
      id: fixture.outboxId,
      status: "sending",
      adapter: "gmail",
      provider_message_id: null,
      sent_at: null,
      quarantined_at: null,
      last_error_code: null,
    });
    expect((await outboxState())[0]!.provider_call_started).not.toBeNull();
    await expect(selectedStore.claimNext({
      owner: "admin-epoch-writer-first-no-resend",
      token: CLAIM_TOKENS[1],
      leaseMs: 120_000,
    })).resolves.toBeNull();
    expect(await administratorHandoffState(fixture.authorityId)).toEqual({
      active_admins: 1,
      prior_role: "learner",
      source_epoch: fixture.authorityEpoch,
      successor_role: "admin",
    });
  });

  it("holds TX2 administrator epoch authority through one callback before a different-user writer", async () => {
    vi.stubEnv("GMAIL_CLIENT_ID", "integration-client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "integration-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "integration-refresh");
    const sendStarted = deferred<void>();
    const sendResult = deferred<Response>();
    let providerCallbackCount = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        return new Response('{"access_token":"integration-access"}', {
          status: 200,
        });
      }
      if (
        String(url)
          === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
      ) {
        providerCallbackCount += 1;
        sendStarted.resolve();
        return await sendResult.promise;
      }
      throw new Error("Unexpected Gmail integration URL.");
    });
    vi.stubGlobal("fetch", fetch);

    const fixture = await seedBackupStatusOutbox(1);
    const tx2Pid = deferred<number>();
    let capturedTx2Pid = false;
    const selectedStore = await instrumentedStore(new InstrumentedPool({
      before: async (event) => {
        if (
          !capturedTx2Pid
          && event.sql.includes("backup_status_mail_authorized")
        ) {
          capturedTx2Pid = true;
          tx2Pid.resolve(event.pid);
        }
      },
    }));
    const claim = await requireClaim(
      CLAIM_TOKENS[0],
      "admin-epoch-tx2-first-worker",
      selectedStore,
    );
    expect(claim.id).toBe(fixture.outboxId);
    const deadlocksBefore = await deadlockCount();
    const run = await startGuardedGmailDispatch(claim, selectedStore);
    let runClosed = false;
    let providerSettled = false;
    const [providerTx2Pid] = await within(
      Promise.all([tx2Pid.promise, sendStarted.promise]).then(
        ([pid]) => [pid] as const,
      ),
      "backup-status TX2 provider callback",
      10_000,
    );
    expect(providerCallbackCount).toBe(1);

    const handoff = await beginAdminHandoffTransaction();
    let handoffOpen = true;
    const transferring = transferAdministratorAuthority(handoff.client);

    try {
      const block = await waitForAdvisoryBlock(
        providerTx2Pid,
        "two-user administrator handoff waiting behind TX2",
      );
      expect(block).toMatchObject({
        blocker_pid: providerTx2Pid,
        blocker_role: "learncoding_worker",
        blocker_application: "codestead_mail_delivery_races",
        waiter_pid: handoff.pid,
        waiter_role: "learncoding_app",
        waiter_application: "codestead_admin_epoch_writer",
      });
      expectAdvisoryLockCoordinates(block);
      expect(providerCallbackCount).toBe(1);

      providerSettled = true;
      sendResult.reject(new Error("ambiguous Gmail provider outcome"));
      const dispatchResult = await completeGuardedDispatch(run);
      runClosed = true;
      await within(transferring, "two-user administrator handoff");
      await handoff.client.query("commit");
      handoffOpen = false;

      expect(dispatchResult).toEqual({
        kind: "applied",
        exit: {
          kind: "quarantined",
          code: "PROVIDER_OUTCOME_UNKNOWN",
        },
      });
      expect(providerCallbackCount).toBe(1);
    } finally {
      if (!providerSettled) {
        providerSettled = true;
        sendResult.reject(new Error("forced test cleanup"));
      }
      await within(
        transferring,
        "two-user administrator handoff cleanup",
      ).catch(() => undefined);
      if (handoffOpen) {
        await handoff.client.query("rollback").catch(() => undefined);
      }
      handoff.client.release();
      if (!runClosed) {
        await completeGuardedDispatch(run).catch(() => undefined);
      }
    }

    const currentEpoch = await adminAuthorityEpoch();
    expect(currentEpoch).not.toBe(fixture.authorityEpoch);
    expect(await deadlockCount()).toBe(deadlocksBefore);
    expect((await outboxState())[0]).toMatchObject({
      id: fixture.outboxId,
      status: "quarantined",
      provider_message_id: null,
      sent_at: null,
      last_error_code: "PROVIDER_OUTCOME_UNKNOWN",
    });
    await expect(selectedStore.claimNext({
      owner: "admin-epoch-tx2-first-no-resend",
      token: CLAIM_TOKENS[1],
      leaseMs: 120_000,
    })).resolves.toBeNull();
    expect(await administratorHandoffState(fixture.authorityId)).toEqual({
      active_admins: 1,
      prior_role: "learner",
      source_epoch: fixture.authorityEpoch,
      successor_role: "admin",
    });
  });
});
