import { describe, expect, it, vi } from "vitest";

import {
  PostgresOutboxStore,
  type EmailOutboxPayload,
  type OutboxPgClient,
  type OutboxPgPool,
} from "../postgres-outbox-store";
import type {
  OutboxClaim,
  ProviderCallPermit,
  ProviderStartedClaim,
} from "../outbox-worker";

const ID = "11111111-1111-4111-8111-111111111111";
const OPERATION = "22222222-2222-4222-8222-222222222222";
const TOKEN = "33333333-3333-4333-8333-333333333333";

type Step = Readonly<{
  contains: string;
  rows?: Record<string, unknown>[];
  error?: Error;
}>;

function compact(sql: string) {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
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
    this.calls.push({ sql, values });
    const step = this.steps.shift();
    expect(step, `Unexpected SQL: ${sql}`).toBeDefined();
    expect(sql).toContain(step!.contains.toLowerCase());
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

describe("PostgresOutboxStore", () => {
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

    const sql = input.client.calls[4]!.sql;
    expect(sql).toContain("claim_token = $3::uuid");
    expect(sql).toContain("claim_owner = $4::text");
    expect(sql).toContain("claim_version = $5::integer");
    expect(sql).toContain("provider_call_started is null");
    expect(sql).toContain("lease_expires_at > pg_catalog.statement_timestamp()");
    const boundarySql = input.client.calls[3]!.sql;
    expect(boundarySql).toContain("outbox.to_email = lower($8::text)");
    expect(boundarySql).toContain("outbox.template = $9::text");
    expect(boundarySql).toContain("outbox.template_version = $10::text");
    expect(boundarySql).toContain("outbox.variables = $11::jsonb");
    expect(input.client.calls[3]!.values.slice(6)).toEqual([
      "learner-1",
      "learner@example.test",
      "invitation",
      "1",
      JSON.stringify({ name: "Learner" }),
    ]);
    expect(sql).toContain("to_email = lower($10::text)");
    expect(sql).toContain("template = $11::text");
    expect(sql).toContain("template_version = $12::text");
    expect(sql).toContain("variables = $13::jsonb");
  });

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
    expect(suppressionSql).toContain("to_email = lower($9::text)");
    expect(suppressionSql).toContain("template = $10::text");
    expect(suppressionSql).toContain("template_version = $11::text");
    expect(suppressionSql).toContain("variables = $12::jsonb");
    expect(input.client.calls[4]!.values.at(-1)).toBe(JSON.stringify(claim.payload.variables));
  });

  it("does not reconstruct a permit after an unknown boundary commit", async () => {
    const input = harness([
      { contains: "begin" },
      { contains: "select id::text, user_id, operation_id::text, delivery_scope_key", rows: [scopeRow()] },
      { contains: "pg_advisory_xact_lock" },
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
