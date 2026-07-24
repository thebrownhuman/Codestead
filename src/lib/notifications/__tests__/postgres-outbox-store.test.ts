import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PostgresOutboxStore,
  type EmailOutboxPayload,
  type OutboxPgClient,
  type OutboxPgPool,
} from "../postgres-outbox-store";
import type { GmailReconciliationFence } from "../gmail-reconciliation";
import type {
  OutboxClaim,
  ProviderCallPermit,
  ProviderStartedClaim,
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
}>;

function compact(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

class ScriptedClient implements OutboxPgClient {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
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
    return { rows: (step!.rows ?? []) as Row[] };
  }

  release() {
    this.released = true;
  }
}

function harness(steps: Step[]) {
  const client = new ScriptedClient(steps);
  const connect = vi.fn(async () => client);
  const pool: OutboxPgPool = { connect };
  return { client, connect, store: new PostgresOutboxStore(pool) };
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

const started: ProviderStartedClaim = {
  phase: "post-provider",
  id: ID,
  operationId: OPERATION,
  claimToken: TOKEN,
  claimOwner: "worker-1",
  claimVersion: 4,
  adapter: "gmail",
  providerCallStartedAt: new Date("2026-07-22T19:00:05.000Z"),
  leaseExpiresAt: new Date("2026-07-22T19:01:05.000Z"),
};
const permit = started as ProviderCallPermit;

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
  lastErrorCode: "PROVIDER_OUTCOME_AMBIGUOUS",
};

describe("PostgresOutboxStore", () => {
  beforeEach(() => {
    process.env.DELETION_TOMBSTONE_KEY = "deletion-test-secret-that-is-at-least-32-bytes";
  });

  afterEach(() => {
    delete process.env.DELETION_TOMBSTONE_KEY;
    vi.unstubAllEnvs();
  });

  it("claims with an account lock and full generation fence", async () => {
    const input = harness([
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
    const claimSql = input.client.calls[3]!.sql;
    expect(claimSql).toContain("claim_version = claim_version + 1");
    expect(claimSql).toContain("claim_token = $4::uuid");
    expect(claimSql).toContain("user_id is not distinct from $7::text");
    expect(claimSql).toContain("active.delivery_scope_key = $8::text");
    expect(input.client.released).toBe(true);
  });

  it("returns no claim when a competing CAS wins", async () => {
    const input = harness([
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
    const input = harness([
      { contains: "begin" },
      { contains: "select id::text, user_id, operation_id::text, delivery_scope_key", rows: [scopeRow()] },
      { contains: "pg_advisory_xact_lock" },
      { contains: "select case", rows: [{ decision: "allowed" }] },
      { contains: "select case", rows: [{ decision: "allowed" }] },
      {
        contains: "update public.email_outbox",
        rows: [{
          provider_call_started: new Date("2026-07-22T19:00:05.000Z"),
          lease_expires_at: new Date("2026-07-22T19:01:05.000Z"),
        }],
      },
      { contains: "commit" },
    ]);

    await expect(input.store.beginProviderCall(claim, {
      adapter: "gmail",
      leaseMs: 60_000,
    })).resolves.toEqual({ kind: "applied", permit });

    const sql = input.client.calls[5]!.sql;
    expect(sql).toContain("claim_token = $3::uuid");
    expect(sql).toContain("claim_owner = $4::text");
    expect(sql).toContain("claim_version = $5::integer");
    expect(sql).toContain("provider_call_started is null");
    expect(sql).toContain("lease_expires_at > pg_catalog.statement_timestamp()");
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
    expect(input.client.calls[5]!.values.slice(13)).toEqual([null, null, false, null, null]);
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
    const input = harness([
      { contains: "begin" },
      {
        contains: "select id::text, user_id, operation_id::text, delivery_scope_key",
        rows: [systemScopeRow()],
      },
      { contains: "pg_advisory_xact_lock" },
      { contains: "select case", rows: [{ decision: "SYSTEM_EMAIL_AUTHORITY_INVALID" }] },
      { contains: "update public.email_outbox", rows: [{ id: ID }] },
      { contains: "commit" },
    ]);

    await expect(input.store.beginProviderCall(approvedClaim, {
      adapter: "gmail",
      leaseMs: 60_000,
    })).resolves.toEqual({
      kind: "suppressed",
      code: "SYSTEM_EMAIL_AUTHORITY_INVALID",
    });

    const decision = input.client.calls[3]!;
    const suppression = input.client.calls[4]!;
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
    const input = harness([
      { contains: "begin" },
      {
        contains: "select id::text, user_id, operation_id::text, delivery_scope_key",
        rows: [systemScopeRow()],
      },
      { contains: "pg_advisory_xact_lock" },
      { contains: "select case", rows: [{ decision: "allowed" }] },
      { contains: "select case", rows: [{ decision: "allowed" }] },
      {
        contains: "update public.email_outbox",
        rows: [{
          provider_call_started: new Date("2026-07-22T19:00:05.000Z"),
          lease_expires_at: new Date("2026-07-22T19:01:05.000Z"),
        }],
      },
      { contains: "commit" },
    ]);

    await expect(input.store.beginProviderCall(adminClaim, {
      adapter: "gmail",
      leaseMs: 60_000,
    })).resolves.toEqual({ kind: "applied", permit });

    const decision = input.client.calls[3]!;
    const lockedDecision = input.client.calls[4]!;
    const boundary = input.client.calls[5]!;
    for (const call of [decision, lockedDecision, boundary]) {
      expect(call.sql).toContain("_mailOperationId");
      expect(call.sql).toContain("_mailRecipient");
      expect(call.sql).toContain("_mailProducer");
      expect(call.sql).toContain("_mailSourceId");
      expect(call.sql).toContain("source_request.adult_confirmed_at is not null");
      expect(call.sql).toContain("source_request.decided_by is null");
      expect(call.sql).toContain("admin_recipient.banned = false");
      expect(call.sql).toContain("variables ->> 'name' = 'Administrator'");
    }
    expect(lockedDecision.sql).toContain("for share of source_request, admin_recipient");
    expect(decision.sql).toContain("outbox.variables ->> 'url' = $16::text");
    expect(boundary.sql).toContain("outbox.variables ->> 'url' = $18::text");
    expect(decision.values.slice(11)).toEqual([
      null,
      null,
      false,
      null,
      "https://learn.example.test/admin/access",
    ]);
    expect(boundary.values.slice(13)).toEqual([
      null,
      null,
      false,
      null,
      "https://learn.example.test/admin/access",
    ]);
  });

  it("repeats the exact immutable deletion capability inside the provider-boundary CAS", async () => {
    const input = harness([
      { contains: "begin" },
      { contains: "select id::text, user_id, operation_id::text, delivery_scope_key", rows: [scopeRow()] },
      { contains: "pg_advisory_xact_lock" },
      { contains: "select case", rows: [{ decision: "allowed" }] },
      { contains: "select case", rows: [{ decision: "allowed" }] },
      {
        contains: "update public.email_outbox",
        rows: [{
          provider_call_started: new Date("2026-07-22T19:00:05.000Z"),
          lease_expires_at: new Date("2026-07-22T19:01:05.000Z"),
        }],
      },
      { contains: "commit" },
    ]);

    await expect(input.store.beginProviderCall(deletionClaim, {
      adapter: "gmail",
      leaseMs: 60_000,
    })).resolves.toEqual({ kind: "applied", permit });

    const decision = input.client.calls[3]!;
    const lockedDecision = input.client.calls[4]!;
    const boundary = input.client.calls[5]!;
    for (const call of [decision, lockedDecision, boundary]) {
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
    expect(boundary.values.slice(16)).toEqual([null, null]);
  });

  it.each([
    ["missing required keys", malformedDeletionClaim],
    ["containing an extra key", extraKeyDeletionClaim],
  ] as const)(
    "suppresses deletion variables %s without throwing and rechecks invalidity atomically",
    async (_case, invalidClaim) => {
    const input = harness([
      { contains: "begin" },
      { contains: "select id::text, user_id, operation_id::text, delivery_scope_key", rows: [scopeRow()] },
      { contains: "pg_advisory_xact_lock" },
      {
        contains: "select case",
        rows: [{ decision: "DELETION_NOTICE_CAPABILITY_INVALID" }],
      },
      { contains: "update public.email_outbox", rows: [{ id: ID }] },
      { contains: "commit" },
    ]);

    await expect(input.store.beginProviderCall(invalidClaim, {
      adapter: "gmail",
      leaseMs: 60_000,
    })).resolves.toEqual({
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
    const input = harness([
      { contains: "begin" },
      { contains: "select id::text, user_id, operation_id::text, delivery_scope_key", rows: [scopeRow()] },
      { contains: "pg_advisory_xact_lock" },
      {
        contains: "select case",
        rows: [{ decision: "ACCOUNT_NOT_ACTIVE_AT_PROVIDER_BOUNDARY" }],
      },
      { contains: "update public.email_outbox", rows: [{ id: ID }] },
      { contains: "commit" },
    ]);

    await expect(input.store.beginProviderCall(claim, {
      adapter: "gmail",
      leaseMs: 60_000,
    })).resolves.toEqual({
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

  it("does not reconstruct a permit after an unknown boundary commit", async () => {
    const input = harness([
      { contains: "begin" },
      { contains: "select id::text, user_id, operation_id::text, delivery_scope_key", rows: [scopeRow()] },
      { contains: "pg_advisory_xact_lock" },
      { contains: "select case", rows: [{ decision: "allowed" }] },
      { contains: "select case", rows: [{ decision: "allowed" }] },
      {
        contains: "update public.email_outbox",
        rows: [{
          provider_call_started: new Date("2026-07-22T19:00:05.000Z"),
          lease_expires_at: new Date("2026-07-22T19:01:05.000Z"),
        }],
      },
      { contains: "commit", error: new Error("commit acknowledgement lost") },
      { contains: "rollback" },
    ]);

    await expect(input.store.beginProviderCall(claim, {
      adapter: "gmail",
      leaseMs: 60_000,
    })).rejects.toThrow("commit acknowledgement lost");
    expect(input.client.calls.filter(({ sql }) => sql.includes("update public.email_outbox")))
      .toHaveLength(1);
  });

  it("rejects a sent update whose returned provider identity does not verify", async () => {
    const input = harness([
      { contains: "begin" },
      { contains: "select id::text, user_id, operation_id::text, delivery_scope_key", rows: [scopeRow()] },
      { contains: "pg_advisory_xact_lock" },
      {
        contains: "update public.email_outbox",
        rows: [{
          status: "sent",
          claim_version: 4,
          adapter: "gmail",
          provider_message_id: "gmail-other",
          provider_call_started: new Date("2026-07-22T19:00:05.000Z"),
          sent_at: new Date("2026-07-22T19:00:06.000Z"),
          quarantined_at: null,
          last_error_code: null,
        }],
      },
      { contains: "commit" },
    ]);

    await expect(input.store.finishAfterProvider(permit, {
      kind: "sent",
      providerMessageId: "gmail-1",
    })).resolves.toEqual({ kind: "lost" });
  });

  it("accepts an exact already-persisted provider result", async () => {
    const input = harness([
      { contains: "begin" },
      { contains: "select id::text, user_id, operation_id::text, delivery_scope_key", rows: [scopeRow()] },
      { contains: "pg_advisory_xact_lock" },
      { contains: "update public.email_outbox", rows: [] },
      {
        contains: "select status::text",
        rows: [{
          status: "sent",
          claim_version: 4,
          adapter: "gmail",
          provider_message_id: "gmail-1",
          provider_call_started: new Date("2026-07-22T19:00:05.000Z"),
          sent_at: new Date("2026-07-22T19:00:06.000Z"),
          quarantined_at: null,
          last_error_code: null,
        }],
      },
      { contains: "commit" },
    ]);

    await expect(input.store.finishAfterProvider(permit, {
      kind: "sent",
      providerMessageId: "gmail-1",
    })).resolves.toEqual({ kind: "already-applied" });
  });

  it("rejects a conflicting already-persisted provider identity", async () => {
    const input = harness([
      { contains: "begin" },
      { contains: "select id::text, user_id, operation_id::text, delivery_scope_key", rows: [scopeRow()] },
      { contains: "pg_advisory_xact_lock" },
      { contains: "update public.email_outbox", rows: [] },
      {
        contains: "select status::text",
        rows: [{
          status: "sent",
          claim_version: 4,
          adapter: "gmail",
          provider_message_id: "gmail-other",
          provider_call_started: new Date("2026-07-22T19:00:05.000Z"),
          sent_at: new Date("2026-07-22T19:00:06.000Z"),
          quarantined_at: null,
          last_error_code: null,
        }],
      },
      { contains: "commit" },
    ]);

    await expect(input.store.finishAfterProvider(permit, {
      kind: "sent",
      providerMessageId: "gmail-1",
    })).resolves.toEqual({ kind: "lost" });
  });

  it("reports an exact terminal Gmail result as already applied on unknown-commit replay", async () => {
    const input = harness([
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
    const input = harness([
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
  });

  it("finalizes a Gmail match only under the exact fence and delivery-scope lock", async () => {
    const input = harness([
      { contains: "begin" },
      { contains: "status = 'quarantined'", rows: [scopeRow()] },
      { contains: "pg_advisory_xact_lock" },
      {
        contains: "update public.email_outbox",
        rows: [{
          status: "sent",
          claim_version: 4,
          adapter: "gmail",
          provider_message_id: "gmail-1",
          provider_call_started: new Date("2026-07-22T19:00:05.000Z"),
          sent_at: new Date("2026-07-22T19:02:00.000Z"),
          quarantined_at: null,
          last_error_code: null,
        }],
      },
      { contains: "commit" },
    ]);

    await expect(input.store.finalizeGmailReconciliation({
      fence: reconciliationFence,
      providerMessageId: "gmail-1",
    })).resolves.toEqual({ kind: "applied" });

    const update = input.client.calls[3]!;
    expect(update.sql).toContain("claim_token is not distinct from $7::uuid");
    expect(update.sql).toContain("provider_call_started = $10::timestamptz");
    expect(update.sql).toContain("quarantined_at = $11::timestamptz");
    expect(update.sql).toContain("last_error_code = $12::text");
    expect(update.sql).toContain("status = 'quarantined'");
    expect(update.values).toContain("a:learner-1");
    expect(update.values).toContain("gmail-1");
  });

  it("quarantines only expired post-boundary rows with the exact observed fence", async () => {
    const lease = new Date("2026-07-22T18:58:00.000Z");
    const input = harness([
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
      { contains: "update public.email_outbox", rows: [{ operation_id: OPERATION }] },
      { contains: "commit" },
    ]);

    await expect(input.store.quarantineAbandoned({ limit: 10 })).resolves.toBe(1);
    const sql = input.client.calls[3]!.sql;
    expect(sql).toContain("claim_token = $3::uuid");
    expect(sql).toContain("claim_owner = $4::text");
    expect(sql).toContain("claim_version = $5::integer");
    expect(sql).toContain("lease_expires_at = $7::timestamptz");
    expect(sql).not.toContain("claim_token = null");
    expect(sql).not.toContain("status = 'pending'");
  });

  it("validates claim inputs before opening a database connection", async () => {
    const input = harness([]);

    await expect(input.store.claimNext({
      owner: "worker-1",
      token: "not-a-uuid",
      leaseMs: 30_000,
    })).rejects.toThrow("claim token must be a UUID");
    expect(input.connect).not.toHaveBeenCalled();
  });
});
