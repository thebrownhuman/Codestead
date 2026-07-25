// @vitest-environment node

import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createConfiguredMaterializedDispatch,
  materializedDispatchEnvelope,
} from "../guarded-prepared-dispatch";
import {
  disarmMailDispatchHardWatchdog,
  isMailDispatchHardWatchdogArmed,
  startMailDispatchHardWatchdog,
  type ArmedMailDispatchHardWatchdog,
  type MailDispatchHardWatchdog,
} from "../mail-dispatch-hard-watchdog";
import {
  inspectMailDispatchRuntime,
  type MailDispatchRuntimeStartupInspection,
} from "../mail-dispatch-runtime-startup";
import {
  authorizeCommittedPreparedDispatch,
  discardGuardedPreparedDispatch,
  guardedDispatchResultSafeToDisarm,
  mailDispatchPreparedRuntimePlan,
  releaseGuardedDispatchWatchdogClaim,
  PostgresOutboxStore,
  type OutboxPgClient,
  type OutboxPgPool,
} from "../postgres-outbox-store";
import { outboxMessageId } from "../provider-correlation";
import type {
  GuardedDispatchResult,
  OutboxClaim,
} from "../outbox-worker";
import type { EmailOutboxPayload } from "../postgres-outbox-store";

const OUTBOX_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const CLAIM_TOKEN = "33333333-3333-4333-8333-333333333333";
const USER_ID = "learner-1";
const SCOPE_KEY = `a:${USER_ID}`;
const SCOPE_LOCK_KEY = `user-authority:${USER_ID}`;
const PROVIDER_STARTED_AT = "2026-07-25 06:00:00.123456+00";
const PROVIDER_LEASE_EXPIRES_AT = "2026-07-25 06:01:50.123456+00";
const TRANSACTION_ID = "912345";
const TEMPLATE = "verify-email" as const;

type QueryResult = Readonly<{ rows: Record<string, unknown>[] }>;
type QueryResponder = (
  values: unknown[],
  sql: string,
) => QueryResult | Promise<QueryResult>;
type QueryStep = Readonly<{
  contains: string;
  respond?: QueryResponder;
}>;

function compact(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, reject, resolve };
}

async function eventually(
  predicate: () => boolean,
  message: string,
  attempts = 100,
) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(message);
}

class ScriptedClient extends EventEmitter implements OutboxPgClient {
  readonly calls: Array<Readonly<{ sql: string; values: unknown[] }>> = [];
  readonly releaseCalls: boolean[] = [];

  constructor(
    readonly label: string,
    private readonly steps: QueryStep[],
    private readonly releaseError?: Error,
  ) {
    super();
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ) {
    const sql = compact(text);
    this.calls.push({ sql, values: [...values] });
    const step = this.steps.shift();
    expect(step, `${this.label}: unexpected SQL ${sql}`).toBeDefined();
    expect(sql.toLowerCase()).toContain(step!.contains.toLowerCase());
    const result = step!.respond
      ? await step!.respond(values, sql)
      : { rows: [] };
    return result as Readonly<{ rows: Row[] }>;
  }

  release(destroy = false) {
    this.releaseCalls.push(destroy);
    if (this.releaseError) throw this.releaseError;
  }

  acknowledgeEnd() {
    this.emit("end");
  }

  expectConsumed() {
    expect(this.steps, `${this.label}: unconsumed SQL steps`).toEqual([]);
  }
}

class ScriptedPool implements OutboxPgPool {
  readonly options = Object.freeze({
    max: 3,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
  });
  readonly connected: ScriptedClient[] = [];

  constructor(private readonly clients: ScriptedClient[]) {}

  async query() {
    return {
      rows: [{
        max_connections: "200",
        admin_reserved_connections: "3",
        server_version_num: "170000",
      }],
    };
  }

  async connect(): Promise<ScriptedClient> {
    const client = this.clients.shift();
    if (!client) throw new Error("No scripted PostgreSQL client remains.");
    this.connected.push(client);
    return client;
  }
}

type AuthorityTuple = Readonly<{
  adapter: string;
  dispatch_binding_version: string;
  dispatch_binding_sha256: string;
  provider_correlation_version: string;
  provider_evidence_version: string | null;
  provider_evidence_sha256: string | null;
}>;

const claim: OutboxClaim<EmailOutboxPayload> = Object.freeze({
  phase: "pre-provider",
  id: OUTBOX_ID,
  operationId: OPERATION_ID,
  claimToken: CLAIM_TOKEN,
  claimOwner: "mail-worker:test",
  claimVersion: 4,
  userId: USER_ID,
  deliveryScopeKey: SCOPE_KEY,
  attempt: 2,
  leaseExpiresAt: new Date("2026-07-25T06:00:30.000Z"),
  payload: Object.freeze({
    userId: USER_ID,
    to: "learner@example.test",
    template: TEMPLATE,
    templateVersion: "1",
    variables: Object.freeze({
      name: "Learner",
      url: "http://localhost:3000/invitations/fixture",
    }),
  }),
});

function scopeRow() {
  return {
    id: OUTBOX_ID,
    user_id: USER_ID,
    operation_id: OPERATION_ID,
    delivery_scope_key: SCOPE_KEY,
    claim_version: claim.claimVersion,
  };
}

function lockedRow(tuple: AuthorityTuple) {
  return {
    ...scopeRow(),
    to_email: claim.payload.to,
    template: claim.payload.template,
    template_version: claim.payload.templateVersion,
    variables: claim.payload.variables,
    claim_token: claim.claimToken,
    claim_owner: claim.claimOwner,
    attempt_count: claim.attempt,
    lease_expires_at: PROVIDER_LEASE_EXPIRES_AT,
    adapter: tuple.adapter,
    provider_call_started: PROVIDER_STARTED_AT,
    transaction_id: TRANSACTION_ID,
    dispatch_binding_version: tuple.dispatch_binding_version,
    dispatch_binding_sha256: tuple.dispatch_binding_sha256,
    provider_correlation_version: tuple.provider_correlation_version,
    provider_evidence_version: tuple.provider_evidence_version,
    provider_evidence_sha256: tuple.provider_evidence_sha256,
  };
}

function boundaryClient(setTuple: (tuple: AuthorityTuple) => void) {
  return new ScriptedClient("TX1", [
    { contains: "begin" },
    { contains: "pg_advisory_xact_lock" },
    {
      contains: "for update",
      respond: () => ({ rows: [scopeRow()] }),
    },
    {
      contains: "account_not_active_at_provider_boundary",
      respond: () => ({ rows: [{ decision: "allowed" }] }),
    },
    {
      contains: "set provider_call_started",
      respond: (values) => {
        const tuple = Object.freeze({
          adapter: String(values[5]),
          dispatch_binding_version: String(values[18]),
          dispatch_binding_sha256: String(values[19]),
          provider_correlation_version: String(values[20]),
          provider_evidence_version: values[21] as string | null,
          provider_evidence_sha256: values[22] as string | null,
        });
        setTuple(tuple);
        return {
          rows: [{
            provider_call_started: PROVIDER_STARTED_AT,
            lease_expires_at: PROVIDER_LEASE_EXPIRES_AT,
            ...tuple,
          }],
        };
      },
    },
    { contains: "commit" },
  ]);
}

function terminalRow(values: unknown[], tuple: AuthorityTuple) {
  const status = String(values[14]);
  const providerMessageId = values[15] as string | null;
  const code = values[16] as string | null;
  return {
    status,
    claim_version: claim.claimVersion,
    user_id: USER_ID,
    delivery_scope_key: SCOPE_KEY,
    adapter: tuple.adapter,
    provider_message_id: providerMessageId,
    provider_call_started: PROVIDER_STARTED_AT,
    sent_at: status === "sent" ? "2026-07-25 06:00:10.000000+00" : null,
    quarantined_at:
      status === "quarantined" ? "2026-07-25 06:00:10.000000+00" : null,
    last_error_code: code,
    claim_token: null,
    claim_owner: null,
    lease_expires_at: null,
    dispatch_binding_version: tuple.dispatch_binding_version,
    dispatch_binding_sha256: tuple.dispatch_binding_sha256,
    provider_correlation_version: tuple.provider_correlation_version,
    provider_evidence_version: tuple.provider_evidence_version,
    provider_evidence_sha256: tuple.provider_evidence_sha256,
  };
}

function dispatchClient(input: Readonly<{
  tuple: () => AuthorityTuple;
  commitError?: Error;
  onFinalFence?: () => void;
}>) {
  return new ScriptedClient("TX2", [
    { contains: "begin" },
    { contains: "set local lock_timeout" },
    { contains: "set local statement_timeout" },
    { contains: "idle_in_transaction_session_timeout = '0'" },
    { contains: "transaction_timeout = '0'" },
    {
      contains: "pg_advisory_xact_lock",
      respond: (values) => {
        expect(values).toEqual([SCOPE_LOCK_KEY]);
        return { rows: [] };
      },
    },
    {
      contains: "pg_current_xact_id()",
      respond: () => ({ rows: [lockedRow(input.tuple())] }),
    },
    {
      contains: "and outbox.adapter = $12::text",
      respond: () => ({ rows: [{ decision: "allowed" }] }),
    },
    {
      contains: "select 1 from public.email_outbox",
      respond: () => {
        input.onFinalFence?.();
        return { rows: [{ authorized: 1 }] };
      },
    },
    { contains: "set local transaction_timeout = '60000ms'" },
    { contains: "set local idle_in_transaction_session_timeout = '60000ms'" },
    {
      contains: "set status = case",
      respond: (values) => ({ rows: [terminalRow(values, input.tuple())] }),
    },
    {
      contains: "commit",
      respond: input.commitError
        ? async () => {
            throw input.commitError;
          }
        : undefined,
    },
  ]);
}

function tupleValues(tuple: AuthorityTuple) {
  return [
    tuple.provider_correlation_version,
    tuple.provider_evidence_version,
    tuple.provider_evidence_sha256,
  ];
}

function finalizerScopeRow(tuple: AuthorityTuple) {
  return {
    ...scopeRow(),
    dispatch_binding_version: tuple.dispatch_binding_version,
    dispatch_binding_sha256: tuple.dispatch_binding_sha256,
    provider_correlation_version: tuple.provider_correlation_version,
    provider_evidence_version: tuple.provider_evidence_version,
    provider_evidence_sha256: tuple.provider_evidence_sha256,
  };
}

function committedSentRow(tuple: AuthorityTuple) {
  return {
    status: "sent",
    claim_version: claim.claimVersion,
    user_id: USER_ID,
    delivery_scope_key: SCOPE_KEY,
    adapter: tuple.adapter,
    provider_message_id: "gmail-provider-id",
    provider_call_started: PROVIDER_STARTED_AT,
    sent_at: "2026-07-25 06:00:10.000000+00",
    quarantined_at: null,
    last_error_code: null,
    claim_token: null,
    claim_owner: null,
    lease_expires_at: null,
    dispatch_binding_version: tuple.dispatch_binding_version,
    dispatch_binding_sha256: tuple.dispatch_binding_sha256,
    provider_correlation_version: tuple.provider_correlation_version,
    provider_evidence_version: tuple.provider_evidence_version,
    provider_evidence_sha256: tuple.provider_evidence_sha256,
  };
}

function committedFinalizerClient(tuple: () => AuthorityTuple) {
  return new ScriptedClient("finalizer", [
    { contains: "begin" },
    {
      contains: "pg_advisory_xact_lock",
      respond: (values) => {
        expect(values).toEqual([SCOPE_LOCK_KEY]);
        return { rows: [] };
      },
    },
    {
      contains: "for update",
      respond: (values, sql) => {
        const authority = tuple();
        expect(sql).toContain("provider_correlation_version = $13::text");
        expect(sql).toContain(
          "provider_evidence_version is not distinct from $14::text",
        );
        expect(sql).toContain(
          "provider_evidence_sha256 is not distinct from $15::text",
        );
        expect(values.slice(12, 15)).toEqual(tupleValues(authority));
        return { rows: [finalizerScopeRow(authority)] };
      },
    },
    {
      contains: "set provider_message_id = $7::text",
      respond: (values, sql) => {
        const authority = tuple();
        expect(sql).toContain("provider_correlation_version = $14::text");
        expect(sql).toContain(
          "provider_evidence_version is not distinct from $15::text",
        );
        expect(sql).toContain(
          "provider_evidence_sha256 is not distinct from $16::text",
        );
        expect(values.slice(13, 16)).toEqual(tupleValues(authority));
        return { rows: [] };
      },
    },
    {
      contains: "last_error_code = 'ABANDONED_POST_PROVIDER_BOUNDARY'",
      respond: (values, sql) => {
        const authority = tuple();
        expect(sql).toContain("provider_correlation_version = $13::text");
        expect(sql).toContain(
          "provider_evidence_version is not distinct from $14::text",
        );
        expect(sql).toContain(
          "provider_evidence_sha256 is not distinct from $15::text",
        );
        expect(values.slice(12, 15)).toEqual(tupleValues(authority));
        return { rows: [] };
      },
    },
    {
      contains: "select status::text",
      respond: (values, sql) => {
        const authority = tuple();
        expect(sql).toContain("provider_correlation_version = $10::text");
        expect(sql).toContain(
          "provider_evidence_version is not distinct from $11::text",
        );
        expect(sql).toContain(
          "provider_evidence_sha256 is not distinct from $12::text",
        );
        expect(values.slice(9, 12)).toEqual(tupleValues(authority));
        return { rows: [committedSentRow(authority)] };
      },
    },
    { contains: "commit" },
  ]);
}

function tamperedFinalizerClient(tuple: () => AuthorityTuple) {
  return new ScriptedClient("tampered-finalizer", [
    { contains: "begin" },
    { contains: "pg_advisory_xact_lock" },
    {
      contains: "for update",
      respond: (values, sql) => {
        const authority = tuple();
        expect(sql).toContain("provider_correlation_version = $13::text");
        expect(values.slice(12, 15)).toEqual(tupleValues(authority));
        return {
          rows: [{
            ...finalizerScopeRow(authority),
            provider_correlation_version: "tampered-provider-correlation-v1",
          }],
        };
      },
    },
    { contains: "commit" },
  ]);
}
async function authorizeFixture(
  pool: ScriptedPool,
  inspection: MailDispatchRuntimeStartupInspection,
) {
  const store = new PostgresOutboxStore(pool, inspection);
  const runtimePlan = mailDispatchPreparedRuntimePlan(store);
  if (!runtimePlan) throw new Error("Store runtime plan was not issued.");
  const materialized = createConfiguredMaterializedDispatch({
    source: {
      applicationUrl: "http://localhost:3000",
      outboxId: claim.id,
      operationId: claim.operationId,
      claimToken: claim.claimToken,
      claimOwner: claim.claimOwner,
      claimVersion: claim.claimVersion,
      deliveryScopeKey: claim.deliveryScopeKey,
      recipient: claim.payload.to,
      template: TEMPLATE,
      templateVersion: claim.payload.templateVersion,
      variables: claim.payload.variables,
    },
    adapter: "gmail",
    from: "Codestead <mail@codestead.test>",
    messageId: outboxMessageId(claim.operationId),
    runtimePlan,
  });
  const envelope = materializedDispatchEnvelope(materialized);
  if (!envelope) throw new Error("Materialized dispatch envelope was not issued.");
  const boundary = await store.beginProviderCall(claim, {
    adapter: "gmail",
    envelope,
  });
  if (boundary.kind !== "applied") {
    throw new Error(`Expected applied provider boundary, got ${boundary.kind}.`);
  }
  const guarded = await authorizeCommittedPreparedDispatch(
    store,
    boundary.receipt,
  );
  return { boundary, guarded, store };
}

async function closeWatchdog(
  controller: MailDispatchHardWatchdog | undefined,
  store: PostgresOutboxStore | undefined,
  armed: ArmedMailDispatchHardWatchdog | undefined,
) {
  if (armed && isMailDispatchHardWatchdogArmed(armed)) {
    await disarmMailDispatchHardWatchdog(armed);
  }
  if (armed && store) releaseGuardedDispatchWatchdogClaim(store, armed);
  await controller?.close();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("guarded PostgreSQL outbox dispatch", () => {
  it("rejects startup authority issued for an equivalent different pool", async () => {
    const inspectedPool = new ScriptedPool([]);
    const substitutedPool = new ScriptedPool([]);
    const inspection = await inspectMailDispatchRuntime(inspectedPool);

    expect(() => new PostgresOutboxStore(
      substitutedPool,
      inspection,
    )).toThrow("Mail dispatch startup inspection is invalid.");
    expect(inspectedPool.connected).toEqual([]);
    expect(substitutedPool.connected).toEqual([]);
  });
  it("retains one TX2 client and its scope lock through the provider promise and COMMIT ACK", async () => {
    vi.stubEnv("GMAIL_CLIENT_ID", "fixture-client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "fixture-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "fixture-refresh");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    let tuple: AuthorityTuple | undefined;
    let finalFenceReached = false;
    const tx1 = boundaryClient((issued) => {
      tuple = issued;
    });
    const sendResponse = deferred<Response>();
    const tx2 = dispatchClient({
      tuple: () => {
        if (!tuple) throw new Error("TX1 tuple was not captured.");
        return tuple;
      },
      onFinalFence: () => {
        finalFenceReached = true;
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        return new Response('{"access_token":"fixture-access"}', { status: 200 });
      }
      expect(String(url)).toBe(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      );
      expect(finalFenceReached).toBe(true);
      expect(tx2.calls).toHaveLength(9);
      expect(tx2.releaseCalls).toEqual([]);
      return sendResponse.promise;
    });
    vi.stubGlobal("fetch", fetch);

    const pool = new ScriptedPool([tx1, tx2]);
    const inspection = await inspectMailDispatchRuntime(pool);
    const fixture = await authorizeFixture(pool, inspection);
    let controller: MailDispatchHardWatchdog | undefined;
    let armed: ArmedMailDispatchHardWatchdog | undefined;
    try {
      controller = await startMailDispatchHardWatchdog();
      armed = await controller.arm();
      let settled = false;
      const resultPromise = fixture.store.dispatchAfterProviderBoundary(
        fixture.boundary.permit,
        fixture.guarded,
        armed,
      ).then((result) => {
        settled = true;
        return result;
      });

      await eventually(
        () => tx2.calls.length === 11,
        "TX2 did not arm both post-initiation timeouts.",
      );
      expect(settled).toBe(false);
      expect(tx2.releaseCalls).toEqual([]);
      expect(tx2.calls.map(({ sql }) => sql)).toEqual([
        "begin",
        expect.stringContaining("set local lock_timeout"),
        expect.stringContaining("set local statement_timeout"),
        "set local idle_in_transaction_session_timeout = '0'",
        "set local transaction_timeout = '0'",
        expect.stringContaining("pg_advisory_xact_lock"),
        expect.stringContaining("pg_current_xact_id()"),
        expect.stringContaining("and outbox.adapter = $12::text"),
        expect.stringContaining("select 1 from public.email_outbox"),
        "set local transaction_timeout = '60000ms'",
        "set local idle_in_transaction_session_timeout = '60000ms'",
      ]);

      sendResponse.resolve(
        new Response('{"id":"gmail-provider-id"}', { status: 200 }),
      );
      const result = await resultPromise;
      expect(result).toEqual({
        kind: "applied",
        exit: {
          kind: "sent",
          providerMessageId: "gmail-provider-id",
        },
      });
      expect(tx2.releaseCalls).toEqual([false]);
      expect(tx2.calls.at(-1)?.sql).toBe("commit");
      expect(pool.connected).toEqual([tx1, tx2]);
      expect(
        guardedDispatchResultSafeToDisarm(fixture.store, armed, result),
      ).toBe(true);
      expect(
        guardedDispatchResultSafeToDisarm(fixture.store, armed, result),
      ).toBe(false);

      await disarmMailDispatchHardWatchdog(armed);
      expect(releaseGuardedDispatchWatchdogClaim(fixture.store, armed)).toBe(true);
      armed = undefined;
      tx1.expectConsumed();
      tx2.expectConsumed();
    } finally {
      await closeWatchdog(controller, fixture.store, armed);
    }
  });

  it("waits for client end, terminal xid8, and the same advisory barrier before issuing uncertainty", async () => {
    vi.stubEnv("GMAIL_CLIENT_ID", "fixture-client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "fixture-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "fixture-refresh");

    let tuple: AuthorityTuple | undefined;
    const tx1 = boundaryClient((issued) => {
      tuple = issued;
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => (
      String(url) === "https://oauth2.googleapis.com/token"
        ? new Response('{"access_token":"fixture-access"}', { status: 200 })
        : new Response('{"id":"gmail-provider-id"}', { status: 200 })
    ));
    vi.stubGlobal("fetch", fetch);

    const tx2 = dispatchClient({
      tuple: () => {
        if (!tuple) throw new Error("TX1 tuple was not captured.");
        return tuple;
      },
      commitError: new Error("commit acknowledgement lost"),
    });
    const barrier = deferred<QueryResult>();
    const control = new ScriptedClient("control", [
      {
        contains: "pg_xact_status($1::xid8)",
        respond: (values) => {
          expect(values).toEqual([TRANSACTION_ID]);
          return { rows: [{ transaction_status: "committed" }] };
        },
      },
      { contains: "begin" },
      { contains: "set local lock_timeout" },
      {
        contains: "pg_advisory_xact_lock",
        respond: (values) => {
          expect(values).toEqual([SCOPE_LOCK_KEY]);
          return barrier.promise;
        },
      },
      { contains: "commit" },
    ]);
    const finalizer = committedFinalizerClient(() => {
      if (!tuple) throw new Error("TX1 tuple was not captured.");
      return tuple;
    });
    const pool = new ScriptedPool([tx1, tx2, control, finalizer]);
    const inspection = await inspectMailDispatchRuntime(pool);
    const fixture = await authorizeFixture(pool, inspection);
    let controller: MailDispatchHardWatchdog | undefined;
    let armed: ArmedMailDispatchHardWatchdog | undefined;
    try {
      controller = await startMailDispatchHardWatchdog();
      armed = await controller.arm();
      let settled = false;
      const resultPromise: Promise<GuardedDispatchResult> =
        fixture.store.dispatchAfterProviderBoundary(
          fixture.boundary.permit,
          fixture.guarded,
          armed,
        ).then((result) => {
          settled = true;
          return result;
        });

      await eventually(
        () => tx2.releaseCalls.length === 1,
        "TX2 did not initiate forced teardown after commit uncertainty.",
      );
      expect(tx2.releaseCalls).toEqual([true]);
      expect(settled).toBe(false);
      expect(pool.connected).toEqual([tx1, tx2]);

      tx2.acknowledgeEnd();
      await eventually(
        () => control.calls.some(({ sql }) => sql.includes("pg_advisory_xact_lock")),
        "Control client did not reach the advisory cleanup barrier.",
      );
      expect(settled).toBe(false);
      expect(control.releaseCalls).toEqual([]);

      barrier.resolve({ rows: [] });
      const result = await resultPromise;
      expect(result.kind).toBe("persistence-unknown");
      expect(control.calls.at(-1)?.sql).toBe("commit");
      expect(control.releaseCalls).toEqual([false]);
      expect(
        guardedDispatchResultSafeToDisarm(fixture.store, armed, result),
      ).toBe(true);

      await disarmMailDispatchHardWatchdog(armed);
      expect(releaseGuardedDispatchWatchdogClaim(fixture.store, armed)).toBe(true);
      armed = undefined;

      if (result.kind !== "persistence-unknown") {
        throw new Error("Expected persistence uncertainty capability.");
      }
      await expect(
        fixture.store.finishGuardedDispatchUnknown(result.uncertainty),
      ).resolves.toEqual({
        result: { kind: "already-applied" },
        exit: {
          kind: "sent",
          providerMessageId: "gmail-provider-id",
        },
      });
      await expect(
        fixture.store.finishGuardedDispatchUnknown(result.uncertainty),
      ).resolves.toBeNull();
      expect(finalizer.releaseCalls).toEqual([false]);
      expect(pool.connected).toEqual([tx1, tx2, control, finalizer]);
      tx1.expectConsumed();
      tx2.expectConsumed();
      control.expectConsumed();
      finalizer.expectConsumed();
    } finally {
      await closeWatchdog(controller, fixture.store, armed);
    }
  });

  it("rejects unissued sent finalization and a tampered authority before any write", async () => {
    vi.stubEnv("GMAIL_CLIENT_ID", "fixture-client");
    vi.stubEnv("GMAIL_CLIENT_SECRET", "fixture-secret");
    vi.stubEnv("GMAIL_REFRESH_TOKEN", "fixture-refresh");
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async () => (
      new Response('{"access_token":"fixture-access"}', { status: 200 })
    )));

    let tuple: AuthorityTuple | undefined;
    const tx1 = boundaryClient((issued) => {
      tuple = issued;
    });
    const tamperedFinalizer = tamperedFinalizerClient(() => {
      if (!tuple) throw new Error("TX1 tuple was not captured.");
      return tuple;
    });
    const pool = new ScriptedPool([tx1, tamperedFinalizer]);
    const inspection = await inspectMailDispatchRuntime(pool);
    const fixture = await authorizeFixture(pool, inspection);

    await expect(fixture.store.finishAfterProvider(
      fixture.boundary.permit,
      { kind: "sent", providerMessageId: "arbitrary-provider-id" },
    )).rejects.toThrow(
      "Sent finalization requires a module-issued guarded-dispatch uncertainty.",
    );
    expect(tamperedFinalizer.calls).toEqual([]);

    await expect(fixture.store.finishAfterProvider(
      fixture.boundary.permit,
      { kind: "failed", code: "AUTHORIZATION_FAILED" },
    )).resolves.toEqual({ kind: "lost" });
    expect(tamperedFinalizer.calls.map(({ sql }) => sql)).toEqual([
      "begin",
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("for update"),
      "commit",
    ]);
    expect(tamperedFinalizer.releaseCalls).toEqual([false]);
    expect(discardGuardedPreparedDispatch(
      fixture.store,
      fixture.boundary.permit,
      fixture.guarded,
    )).toBe(true);
    tx1.expectConsumed();
    tamperedFinalizer.expectConsumed();
  });
});
