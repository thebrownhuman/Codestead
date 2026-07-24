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
import {
  PostgresOutboxStore,
  type EmailOutboxPayload,
  type OutboxPgClient,
  type OutboxPgPool,
} from "@/lib/notifications/postgres-outbox-store";
import type {
  OutboxClaim,
  ProviderCallPermit,
} from "@/lib/notifications/outbox-worker";

const ADMIN_ID = "mail-race-admin";
const LEARNER_ID = "mail-race-learner";
const LEARNER_PUBLIC_ID = "90000000-0000-4000-8000-000000000001";
const LEARNER_EMAIL = "mail-race-learner@integration.invalid";

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

  release() {
    this.inner.release();
  }
}

class InstrumentedPool implements OutboxPgPool {
  private nextClientOrdinal = 1;
  private commitFaultConsumed = false;

  constructor(
    private readonly hooks: QueryHooks = {},
    private readonly commitFault: CommitFault | null = null,
  ) {}

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
        if (this.commitFaultConsumed || this.commitFault === null) return null;
        this.commitFaultConsumed = true;
        return this.commitFault;
      },
    );
  }
}

const liveOutboxPool: OutboxPgPool = {
  async connect() {
    return await pool.connect() as unknown as OutboxPgClient;
  },
};

function store(outboxPool: OutboxPgPool = liveOutboxPool) {
  return new PostgresOutboxStore(outboxPool);
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
     where table_schema = 'public' and table_type = 'BASE TABLE'
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
  const boundary = await selectedStore.beginProviderCall(claim, {
    adapter: "console",
    leaseMs: 120_000,
  });
  expect(boundary.kind).toBe("applied");
  if (boundary.kind !== "applied") throw new Error("Expected provider boundary authority.");
  return boundary.permit;
}

async function expiredPermit() {
  await seedOutboxRows("pending", 1);
  const claim = await requireClaim(CLAIM_TOKENS[0], "provider-worker");
  const permit = await requirePermit(claim);
  const expiredAt = new Date(Date.now() - 120_000);
  await pool.query(
    "update email_outbox set lease_expires_at = $2::timestamptz where id = $1",
    [claim.id, expiredAt],
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

beforeAll(() => {
  process.env.DELETION_TOMBSTONE_KEY = "mail-race-deletion-key-long-enough-for-integration";
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
  await pool.end();
});

describe("real PostgreSQL mail delivery races", () => {
  it("revalidates a selected claim candidate at the CAS after a concurrent winner changes it", async () => {
    await seedOutboxRows("pending", 1);
    const candidatePause = new QueryPause();
    const claimantStore = store(new InstrumentedPool({
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
    const permit = await requirePermit(claim);

    await expect(store().finishAfterProvider(permit, {
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
    const racingStore = store(new InstrumentedPool(race.hooks));
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
    const rollbackStore = store(new InstrumentedPool({}, "rollback-before-ack"));

    await expect(rollbackStore.beginProviderCall(claim, {
      adapter: "console",
      leaseMs: 120_000,
    })).rejects.toThrow("forced boundary rollback");

    expect((await outboxState())[0]).toMatchObject({
      status: "sending",
      adapter: null,
      provider_call_started: null,
      claim_version: claim.claimVersion,
    });
    await expect(store().beginProviderCall(claim, {
      adapter: "console",
      leaseMs: 120_000,
    })).resolves.toMatchObject({ kind: "applied" });
  });

  it("persists an unknown provider-boundary commit without reconstructing a permit", async () => {
    await seedOutboxRows("pending", 1);
    const claim = await requireClaim(CLAIM_TOKENS[0], "unknown-commit-worker");
    const unknownCommitStore = store(new InstrumentedPool({}, "commit-ack-lost"));

    await expect(unknownCommitStore.beginProviderCall(claim, {
      adapter: "console",
      leaseMs: 120_000,
    })).rejects.toThrow("forced boundary commit acknowledgement loss");

    expect((await outboxState())[0]).toMatchObject({
      status: "sending",
      adapter: "console",
    });
    expect((await outboxState())[0]!.provider_call_started).not.toBeNull();
    await expect(store().beginProviderCall(claim, {
      adapter: "console",
      leaseMs: 120_000,
    })).resolves.toEqual({ kind: "lost" });
  });

  it("lets a finalizer that owns the scope lock beat the abandoned-send sweeper", async () => {
    const { permit } = await expiredPermit();
    const finalizerPause = new QueryPause();
    const finalizerStore = store(new InstrumentedPool({
      after: async (event) => {
        if (isBlockingAdvisoryLock(event.sql)) await finalizerPause.hold(event.pid);
      },
    }));
    const finalizing = finalizerStore.finishAfterProvider(permit, {
      kind: "sent",
      providerMessageId: "console-finalizer-first",
    });
    await within(finalizerPause.reached, "finalizer scope lock");

    let swept: number;
    try {
      swept = await within(store().quarantineAbandoned({ limit: 10 }), "non-blocking abandoned-send sweep");
    } finally {
      finalizerPause.release();
    }
    const finalized = await finalizing;

    expect(swept).toBe(0);
    expect(finalized).toEqual({ kind: "applied" });
    expect((await outboxState())[0]).toMatchObject({
      status: "sent",
      provider_message_id: "console-finalizer-first",
      quarantined_at: null,
      last_error_code: null,
    });
  });

  it("preserves quarantine evidence when the sweeper owns the scope before a late finalizer", async () => {
    const { permit } = await expiredPermit();
    const sweeperPause = new QueryPause();
    const sweeperStore = store(new InstrumentedPool({
      after: async (event, result) => {
        if (isTryAdvisoryLock(event.sql) && result.rows[0]?.locked === true) {
          await sweeperPause.hold(event.pid);
        }
      },
    }));
    const sweeping = sweeperStore.quarantineAbandoned({ limit: 10 });
    await within(sweeperPause.reached, "sweeper scope lock");
    const finalizing = store().finishAfterProvider(permit, {
      kind: "sent",
      providerMessageId: "console-sweeper-first",
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
      status: "quarantined",
      provider_message_id: "console-sweeper-first",
      last_error_code: "ABANDONED_POST_PROVIDER_BOUNDARY",
    });
    expect((await outboxState())[0]!.sent_at).not.toBeNull();
    expect((await outboxState())[0]!.quarantined_at).not.toBeNull();
  });

  it("makes a committed provider boundary win when deletion queues behind its account lock", async () => {
    await seedOutboxRows("pending", 1);
    const claim = await requireClaim(CLAIM_TOKENS[0], "boundary-before-deletion-worker");
    const boundaryPause = new QueryPause();
    const boundaryStore = store(new InstrumentedPool({
      after: async (event) => {
        if (isBlockingAdvisoryLock(event.sql)) await boundaryPause.hold(event.pid);
      },
    }));
    const boundary = boundaryStore.beginProviderCall(claim, {
      adapter: "console",
      leaseMs: 120_000,
    });
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

    const boundary = await store().beginProviderCall(claim, {
      adapter: "console",
      leaseMs: 120_000,
    });
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
    await expect(store().beginProviderCall(noticeClaim, {
      adapter: "console",
      leaseMs: 120_000,
    })).resolves.toMatchObject({ kind: "applied" });
  });
});
