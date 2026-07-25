import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  mailDispatchPreparedRuntimePlan,
  PostgresOutboxStore,
  type EmailOutboxPayload,
  type OutboxPgClient,
  type OutboxPgPool,
} from "../postgres-outbox-store";
import {
  createConfiguredMaterializedDispatch,
  materializedDispatchEnvelope,
} from "../guarded-prepared-dispatch";
import {
  LEGACY_RAW_PROVIDER_CORRELATION_VERSION,
  outboxMessageId,
} from "../provider-correlation";
import { inspectMailDispatchRuntime } from "../mail-dispatch-runtime-startup";
import type { GmailReconciliationFence } from "../gmail-reconciliation";
import {
  type OutboxClaim,
  type ProviderCallPermit,
} from "../outbox-worker";

const ID = "11111111-1111-4111-8111-111111111111";
const OPERATION = "22222222-2222-4222-8222-222222222222";
const TOKEN = "33333333-3333-4333-8333-333333333333";
const SOURCE = "44444444-4444-4444-8444-444444444444";
const ACTIVATION_TOKEN = "A".repeat(43);
type Step = Readonly<{
  contains: string;
  rows?: Record<string, unknown>[];
  error?: Error;
  respond?: (
    values: unknown[],
    sql: string,
  ) => Readonly<{ rows: Record<string, unknown>[] }>;
}>;

function compact(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

class ScriptedClient implements OutboxPgClient {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  readonly releaseCalls: boolean[] = [];
  released = false;

  constructor(private readonly steps: Step[]) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ) {
    const sql = compact(text);
    const normalizedSql = sql.toLowerCase();
    this.calls.push({ sql, values });
    const step = this.steps.shift();
    expect(step, `Unexpected SQL: ${sql}`).toBeDefined();
    expect(normalizedSql).toContain(step!.contains.toLowerCase());
    if (step!.error) throw step!.error;
    const result = step!.respond
      ? step!.respond(values, sql)
      : { rows: step!.rows ?? [] };
    return { rows: result.rows as Row[] };
  }

  release(destroy = false) {
    this.released = true;
    this.releaseCalls.push(destroy);
  }
}

async function harness(steps: Step[]) {
  const client = new ScriptedClient(steps);
  const connect = vi.fn(async () => client);
  const startupQuery = vi.fn(async () => ({
    rows: [{
      max_connections: "200",
      admin_reserved_connections: "3",
      server_version_num: "170010",
    }],
  }));
  const pool = {
    options: {
      max: 3,
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 30_000,
    },
    connect,
    query: startupQuery,
  } satisfies OutboxPgPool & Parameters<typeof inspectMailDispatchRuntime>[0];
  const inspection = await inspectMailDispatchRuntime(pool);
  return {
    client,
    connect,
    startupQuery,
    pool,
    store: new PostgresOutboxStore(pool, inspection),
  };
}

function preparedEnvelope(
  store: PostgresOutboxStore,
  candidate: OutboxClaim<EmailOutboxPayload>,
) {
  const runtimePlan = mailDispatchPreparedRuntimePlan(store);
  if (!runtimePlan) throw new Error("Store runtime plan was not issued.");
  const materialized = createConfiguredMaterializedDispatch({
    source: {
      applicationUrl: process.env.APP_URL ?? "http://localhost:3000",
      outboxId: candidate.id,
      operationId: candidate.operationId,
      claimToken: candidate.claimToken,
      claimOwner: candidate.claimOwner,
      claimVersion: candidate.claimVersion,
      deliveryScopeKey: candidate.deliveryScopeKey,
      recipient: candidate.payload.to,
      template: candidate.payload.template as never,
      templateVersion: candidate.payload.templateVersion,
      variables: candidate.payload.variables,
    },
    adapter: "gmail",
    from: "Codestead <mail@codestead.test>",
    messageId: outboxMessageId(candidate.operationId),
    runtimePlan,
  });
  const envelope = materializedDispatchEnvelope(materialized);
  if (!envelope) throw new Error("Materialized dispatch envelope was not issued.");
  return envelope;
}

function beginProviderCall(
  store: PostgresOutboxStore,
  candidate: OutboxClaim<EmailOutboxPayload>,
) {
  return store.beginProviderCall(candidate, {
    adapter: "gmail",
    envelope: preparedEnvelope(store, candidate),
  });
}

function providerBoundaryRow(values: unknown[]) {
  return {
    rows: [{
      provider_call_started: "2026-07-22 19:00:05.123456+00",
      lease_expires_at: "2026-07-22 19:01:05.000000+00",
      dispatch_binding_version: values[18],
      dispatch_binding_sha256: values[19],
      provider_correlation_version: values[20],
      provider_evidence_version: values[21],
      provider_evidence_sha256: values[22],
    }],
  };
}
function claimRow() {
  return {
    id: ID,
    user_id: "learner-1",
    delivery_scope_key: "a:learner-1",
    operation_id: OPERATION,
    claim_version: 4,
    to_email: "learner@example.test",
    template: "verify-email",
    template_version: "1",
    variables: { name: "Learner", url: "https://learn.example.test/verify" },
    claim_token: TOKEN,
    claim_owner: "worker-1",
    attempt_count: 2,
    lease_expires_at: new Date("2026-07-22T19:01:00.000Z"),
  };
}

function scopeRow(claimVersion = 4) {
  return {
    id: ID,
    user_id: "learner-1",
    operation_id: OPERATION,
    delivery_scope_key: "a:learner-1",
    claim_version: claimVersion,
  };
}
function systemScopeRow() {
  return {
    ...scopeRow(),
    user_id: null,
    delivery_scope_key: `s:${OPERATION}`,
  };
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
    template: "verify-email",
    templateVersion: "1",
    variables: { name: "Learner", url: "https://learn.example.test/verify" },
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
  providerEvidenceVersion: null,
  providerEvidenceSha256: null,
  lastErrorCode: "PROVIDER_OUTCOME_AMBIGUOUS",
};

describe("PostgresOutboxStore", () => {
  beforeEach(() => {
    process.env.DELETION_TOMBSTONE_KEY = "deletion-test-secret-that-is-at-least-32-bytes";
    process.env.GMAIL_CLIENT_ID = "fixture-client";
    process.env.GMAIL_CLIENT_SECRET = "fixture-secret";
    process.env.GMAIL_REFRESH_TOKEN = "fixture-refresh";
  });

  afterEach(() => {
    delete process.env.DELETION_TOMBSTONE_KEY;
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_SECRET;
    delete process.env.GMAIL_REFRESH_TOKEN;
    vi.unstubAllEnvs();
  });

  it("rejects exact-pool drift after construction before acquiring TX1", async () => {
    const input = await harness([]);
    input.pool.options.max = 4;

    await expect(input.store.claimNext({
      owner: "worker-1",
      token: TOKEN,
      leaseMs: 30_000,
    })).rejects.toThrow("startup inspection is no longer valid");
    expect(input.connect).not.toHaveBeenCalled();
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
    expect(candidateSql).toContain("candidate.claim_version < 2147483647");
    const claimSql = input.client.calls[3]!.sql;
    expect(claimSql).toContain("claim_version = claim_version + 1");
    expect(claimSql).toContain("claim_version < 2147483647");
    expect(claimSql).toContain("claim_token = $4::uuid");
    expect(claimSql).toContain("user_id is not distinct from $7::text");
    expect(claimSql).toContain("active.delivery_scope_key = $8::text");
    expect(input.client.released).toBe(true);
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
      {
        contains: "update public.email_outbox",
        respond: providerBoundaryRow,
      },
      { contains: "commit" },
    ]);

    const result = await beginProviderCall(input.store, claim);
    expect(result).toMatchObject({ kind: "applied" });
    if (result.kind !== "applied") throw new Error("Expected an applied provider boundary.");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.permit)).toBe(true);
    expect(Reflect.ownKeys(result.permit)).toHaveLength(0);
    expect(Object.isFrozen(result.receipt)).toBe(true);
    expect(Reflect.ownKeys(result.receipt)).toHaveLength(0);

    const decision = input.client.calls[3]!;
    const boundary = input.client.calls[4]!;
    expect(decision.sql).toContain("for share of account_user");
    expect(decision.sql).toContain("for share of source_invitation, source_request");
    expect(decision.sql).toContain("for share of source_request, admin_recipient");
    expect(decision.sql).toContain("outbox.to_email = lower(btrim($8::text))");
    expect(decision.sql).toContain("outbox.template = $9::text");
    expect(decision.sql).toContain("outbox.template_version = $10::text");
    expect(decision.sql).toContain("outbox.variables = $11::jsonb");
    expect(decision.values.slice(6, 11)).toEqual([
      "learner-1",
      "learner@example.test",
      "verify-email",
      "1",
      JSON.stringify({ name: "Learner", url: "https://learn.example.test/verify" }),
    ]);
    expect(decision.values.slice(11)).toEqual([null, null, false, null, null]);
    expect(boundary.sql).toContain("claim_token = $3::uuid");
    expect(boundary.sql).toContain("claim_owner = $4::text");
    expect(boundary.sql).toContain("claim_version = $5::integer");
    expect(boundary.sql).toContain("provider_call_started is null");
    expect(boundary.sql).toContain("lease_expires_at > pg_catalog.statement_timestamp()");
    expect(boundary.sql).toContain("dispatch_binding_version = $19::text");
    expect(boundary.sql).toContain("dispatch_binding_sha256 = $20::text");
    expect(boundary.sql).toContain("provider_correlation_version = $21::text");
    expect(boundary.sql).toContain("outbox.to_email = lower(btrim($10::text))");
    expect(boundary.sql).toContain("outbox.template = $11::text");
    expect(boundary.sql).toContain("outbox.template_version = $12::text");
    expect(boundary.sql).toContain("outbox.variables = $13::jsonb");
    expect(boundary.values.slice(13, 18)).toEqual([null, null, false, null, null]);
    expect(input.client.releaseCalls).toEqual([false]);
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

    await expect(beginProviderCall(input.store, approvedClaim)).resolves.toEqual({
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
      {
        contains: "update public.email_outbox",
        respond: providerBoundaryRow,
      },
      { contains: "commit" },
    ]);

    await expect(beginProviderCall(input.store, adminClaim)).resolves.toMatchObject({ kind: "applied" });

    const decision = input.client.calls[3]!;
    const boundary = input.client.calls[4]!;
    for (const call of [decision, boundary]) {
      expect(call.sql).toContain("_mailOperationId");
      expect(call.sql).toContain("_mailRecipient");
      expect(call.sql).toContain("_mailProducer");
      expect(call.sql).toContain("_mailSourceId");
      expect(call.sql).toContain("source_request.adult_confirmed_at is not null");
      expect(call.sql).toContain("source_request.decided_by is null");
      expect(call.sql).toContain("admin_recipient.banned = false");
      expect(call.sql).toContain("variables ->> 'name' = 'Administrator'");
    }
    expect(decision.sql).toContain("for share of source_request, admin_recipient");
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
      {
        contains: "update public.email_outbox",
        respond: providerBoundaryRow,
      },
      { contains: "commit" },
    ]);

    await expect(beginProviderCall(input.store, deletionClaim)).resolves.toMatchObject({ kind: "applied" });

    const decision = input.client.calls[3]!;
    const boundary = input.client.calls[4]!;
    for (const call of [decision, boundary]) {
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

    await expect(beginProviderCall(input.store, invalidClaim)).resolves.toEqual({
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

    await expect(beginProviderCall(input.store, claim)).resolves.toEqual({
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

  it("rejects a retired template before opening a database connection", async () => {
    const retiredClaim: OutboxClaim<EmailOutboxPayload> = {
      ...claim,
      payload: {
        ...claim.payload,
        template: "exam-result",
        variables: {},
      },
    };
    const input = await harness([]);

    expect(() => beginProviderCall(input.store, retiredClaim))
      .toThrow("Invalid email template.");
    expect(input.connect).not.toHaveBeenCalled();
  });
  it("does not reconstruct a permit after an unknown boundary commit", async () => {
    const input = await harness([
      { contains: "begin" },
      { contains: "pg_advisory_xact_lock" },
      { contains: "select id::text, user_id, operation_id::text, delivery_scope_key", rows: [scopeRow()] },
      { contains: "select case", rows: [{ decision: "allowed" }] },
      {
        contains: "update public.email_outbox",
        respond: providerBoundaryRow,
      },
      { contains: "commit", error: new Error("commit acknowledgement lost") },
      { contains: "rollback" },
    ]);

    await expect(beginProviderCall(input.store, claim)).rejects.toThrow("Provider boundary commit result is unknown.");
    expect(input.client.calls.filter(({ sql }) => sql.includes("update public.email_outbox")))
      .toHaveLength(1);
  });

  it("rejects public sent finalization before opening a database connection", async () => {
    const input = await harness([]);

    await expect(input.store.finishAfterProvider({} as ProviderCallPermit, {
      kind: "sent",
      providerMessageId: "gmail-1",
    })).rejects.toThrow(
      "Sent finalization requires a module-issued guarded-dispatch uncertainty.",
    );
    expect(input.connect).not.toHaveBeenCalled();
  });

  it("rejects a forged permit for a non-sent finalization", async () => {
    const input = await harness([]);

    await expect(input.store.finishAfterProvider({} as ProviderCallPermit, {
      kind: "quarantined",
      code: "PROVIDER_OUTCOME_AMBIGUOUS",
    })).rejects.toThrow("Outbox provider permit is invalid.");
    expect(input.connect).not.toHaveBeenCalled();
  });

  it("finalizes provider ambiguity only with a freshly issued permit", async () => {
    const input = await harness([
      { contains: "begin" },
      { contains: "pg_advisory_xact_lock" },
      {
        contains: "select id::text, user_id, operation_id::text, delivery_scope_key",
        rows: [scopeRow()],
      },
      { contains: "select case", rows: [{ decision: "allowed" }] },
      { contains: "update public.email_outbox", respond: providerBoundaryRow },
      { contains: "commit" },
      { contains: "begin" },
      { contains: "pg_advisory_xact_lock" },
      {
        contains: "select id::text, user_id, operation_id::text, delivery_scope_key",
        respond: (values) => ({
          rows: [{
            ...scopeRow(),
            dispatch_binding_version: values[9],
            dispatch_binding_sha256: values[10],
            provider_correlation_version: values[12],
            provider_evidence_version: values[13],
            provider_evidence_sha256: values[14],
          }],
        }),
      },
      {
        contains: "update public.email_outbox",
        respond: (values) => ({
          rows: [{
            status: "quarantined",
            claim_version: 5,
            user_id: values[10],
            delivery_scope_key: values[8],
            adapter: values[5],
            provider_message_id: null,
            provider_call_started: values[9],
            sent_at: null,
            quarantined_at: "2026-07-22 19:00:06.000000+00",
            last_error_code: values[7],
            claim_token: null,
            claim_owner: null,
            lease_expires_at: null,
            dispatch_binding_version: values[11],
            dispatch_binding_sha256: values[12],
            provider_correlation_version: values[14],
            provider_evidence_version: values[15],
            provider_evidence_sha256: values[16],
          }],
        }),
      },
      { contains: "commit" },
    ]);

    const boundary = await beginProviderCall(input.store, claim);
    if (boundary.kind !== "applied") throw new Error("Expected an issued permit.");
    await expect(input.store.finishAfterProvider(boundary.permit, {
      kind: "quarantined",
      code: "PROVIDER_OUTCOME_AMBIGUOUS",
    })).resolves.toEqual({ kind: "applied" });

    const terminal = input.client.calls[9]!;
    expect(terminal.sql).toContain("then claim_version + 1");
    expect(terminal.sql).toContain("lease_expires_at = $14::timestamptz");
    expect(input.client.releaseCalls).toEqual([false, false]);
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
          dispatch_binding_version: "gmail-raw-v1",
          dispatch_binding_sha256: "b".repeat(64),
          provider_correlation_version: LEGACY_RAW_PROVIDER_CORRELATION_VERSION,
          provider_evidence_version: null,
          provider_evidence_sha256: null,
          status: "quarantined",
          provider_message_id: null,
          sent_at: null,
          quarantined_at: "2026-07-22 19:01:05+00",
          last_error_code: "PROVIDER_OUTCOME_AMBIGUOUS",
        }],
      },
      { contains: "commit" },      { contains: "begin" },
      { contains: "pg_advisory_xact_lock" },
      { contains: "status = 'quarantined'", rows: [scopeRow()] },
      {
        contains: "update public.email_outbox",
        rows: [{
          status: "sent",
          claim_version: 4,
          user_id: "learner-1",
          delivery_scope_key: "a:learner-1",
          adapter: "gmail",
          provider_message_id: "gmail-1",
          provider_call_started: "2026-07-22 19:00:05+00",
          dispatch_binding_version: "gmail-raw-v1",
          dispatch_binding_sha256: "b".repeat(64),
          provider_correlation_version: "legacy-raw-v0",
          provider_evidence_version: null,
          provider_evidence_sha256: null,
          sent_at: new Date("2026-07-22T19:02:00.000Z"),
          quarantined_at: null,
          last_error_code: null,
          claim_token: null,
          claim_owner: null,
          lease_expires_at: null,
        }],
      },
      { contains: "commit" },
    ]);

    const observed = await input.store.findGmailReconciliationFence({
      operationId: OPERATION,
    });
    expect(observed).toMatchObject({ kind: "ready" });
    if (observed.kind !== "ready") throw new Error("Expected an issued Gmail fence.");
    await expect(input.store.finalizeGmailReconciliation({
      fence: observed.fence,
      providerMessageId: "gmail-1",
      proof: {
        kind: "raw-sha256-v1",
        adapterPayloadSha256: "b".repeat(64),
      },
    })).resolves.toEqual({ kind: "applied" });

    const connectCount = input.connect.mock.calls.length;
    await expect(input.store.finalizeGmailReconciliation({
      fence: observed.fence,
      providerMessageId: "gmail-1",
      proof: {
        kind: "raw-sha256-v1",
        adapterPayloadSha256: "b".repeat(64),
      },
    })).resolves.toEqual({ kind: "lost" });
    expect(input.connect).toHaveBeenCalledTimes(connectCount);

    const update = input.client.calls[6]!;
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
    expect(update.values).toContain("gmail-1");
  });

  it("rolls back a Gmail reconciliation update whose returned proof is corrupted", async () => {
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
          dispatch_binding_version: "gmail-raw-v1",
          dispatch_binding_sha256: "b".repeat(64),
          provider_correlation_version: LEGACY_RAW_PROVIDER_CORRELATION_VERSION,
          provider_evidence_version: null,
          provider_evidence_sha256: null,
          status: "quarantined",
          provider_message_id: null,
          sent_at: null,
          quarantined_at: "2026-07-22 19:01:05+00",
          last_error_code: "PROVIDER_OUTCOME_AMBIGUOUS",
        }],
      },
      { contains: "commit" },      { contains: "begin" },
      { contains: "pg_advisory_xact_lock" },
      { contains: "status = 'quarantined'", rows: [scopeRow()] },
      {
        contains: "update public.email_outbox",
        rows: [{
          status: "sent",
          claim_version: 4,
          user_id: "learner-1",
          delivery_scope_key: "a:learner-1",
          adapter: "gmail",
          provider_message_id: "gmail-conflicting",
          provider_call_started: "2026-07-22 19:00:05+00",
          dispatch_binding_version: "gmail-raw-v1",
          dispatch_binding_sha256: "b".repeat(64),
          provider_correlation_version: "legacy-raw-v0",
          provider_evidence_version: null,
          provider_evidence_sha256: null,
          sent_at: new Date("2026-07-22T19:02:00.000Z"),
          quarantined_at: null,
          last_error_code: null,
          claim_token: null,
          claim_owner: null,
          lease_expires_at: null,
        }],
      },
      { contains: "rollback" },
    ]);

    const observed = await input.store.findGmailReconciliationFence({
      operationId: OPERATION,
    });
    if (observed.kind !== "ready") throw new Error("Expected an issued Gmail fence.");
    await expect(input.store.finalizeGmailReconciliation({
      fence: observed.fence,
      providerMessageId: "gmail-1",
      proof: {
        kind: "raw-sha256-v1",
        adapterPayloadSha256: "b".repeat(64),
      },
    })).rejects.toThrow("Gmail reconciliation terminal proof mismatch.");

    expect(input.client.calls.at(-1)!.sql).toBe("rollback");
    expect(input.client.releaseCalls).toEqual([false, false]);
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
          adapter: "gmail",
          provider_call_started: "2026-07-22 18:57:00+00",
          dispatch_binding_version: null,
          dispatch_binding_sha256: null,
        }],
      },
      { contains: "pg_try_advisory_xact_lock", rows: [{ locked: true }] },
      {
        contains: "update public.email_outbox",
        rows: [{
          operation_id: OPERATION,
          claim_version: 5,
          user_id: "learner-1",
          delivery_scope_key: "a:learner-1",
          adapter: "gmail",
          provider_call_started: "2026-07-22 18:57:00+00",
          claim_token: null,
          claim_owner: null,
          lease_expires_at: null,
          dispatch_binding_version: null,
          dispatch_binding_sha256: null,
          status: "quarantined",
          provider_message_id: null,
          sent_at: null,
          quarantined_at: "2026-07-22 19:00:00+00",
          last_error_code: "ABANDONED_POST_PROVIDER_BOUNDARY",
        }],
      },
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
      "returning operation_id::text, claim_version, user_id, delivery_scope_key, adapter",
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
          adapter: "gmail",
          provider_call_started: "2026-07-22 18:57:00+00",
          dispatch_binding_version: null,
          dispatch_binding_sha256: null,
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

  it("validates claim inputs before opening a database connection", async () => {
    const input = await harness([]);

    await expect(input.store.claimNext({
      owner: "worker-1",
      token: "not-a-uuid",
      leaseMs: 30_000,
    })).rejects.toThrow("claim token must be a UUID");
    expect(input.connect).not.toHaveBeenCalled();
  });
});
