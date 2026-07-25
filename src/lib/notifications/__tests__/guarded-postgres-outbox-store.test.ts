import { describe, expect, it, vi } from "vitest";

import {
  PostgresOutboxStore,
  type EmailOutboxPayload,
  type OutboxPgClient,
  type OutboxPgPool,
} from "../postgres-outbox-store";
import {
  createDispatchAuthorizationEnvelope,
  inspectDispatchAuthorizationEnvelope,
} from "../dispatch-authorization";
import { prepareEmail, type MailDispatchAuthority } from "../prepared-dispatch";
import { outboxMessageId } from "../provider-correlation";
import {
  FatalProviderTransportError,
  GuardedDispatchCommitUnknownError,
  type OutboxClaim,
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
  readonly releases: boolean[] = [];

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

  release(destroy = false) {
    this.releases.push(destroy);
  }
}

function poolFor(...clients: ScriptedClient[]) {
  const queue = [...clients];
  const connect = vi.fn(async () => {
    const client = queue.shift();
    if (!client) throw new Error("No scripted client remains.");
    return client;
  });
  return { connect } satisfies OutboxPgPool;
}

const payload: EmailOutboxPayload = Object.freeze({
  userId: "learner-1",
  to: "learner@example.test",
  template: "invitation",
  templateVersion: "1",
  variables: Object.freeze({ name: "Learner" }),
});

const claim: OutboxClaim<EmailOutboxPayload> = Object.freeze({
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
  payload,
});

const authority: MailDispatchAuthority = Object.freeze({
  id: claim.id,
  operationId: claim.operationId,
  claimToken: claim.claimToken,
  claimOwner: claim.claimOwner,
  claimVersion: claim.claimVersion,
  deliveryScopeKey: claim.deliveryScopeKey,
  recipient: payload.to,
  template: "invitation",
  templateVersion: payload.templateVersion,
});

function authorization() {
  const prepared = prepareEmail(
    {
      to: payload.to,
      template: "invitation",
      templateVersion: payload.templateVersion,
      variables: payload.variables,
    },
    {
      adapter: "gmail",
      from: "Codestead <noreply@example.test>",
      messageId: outboxMessageId(OPERATION),
      authority,
    },
  );
  return createDispatchAuthorizationEnvelope({
    authority,
    prepared,
    source: Object.freeze({
      applicationUrl: "http://localhost:3000",
      outboxId: ID,
      template: payload.template,
      templateVersion: payload.templateVersion,
      variables: payload.variables,
    }),
  });
}

function scopeRow() {
  return {
    id: ID,
    user_id: "learner-1",
    operation_id: OPERATION,
    delivery_scope_key: "a:learner-1",
    claim_version: 4,
  };
}

function armedRow(
  binding: NonNullable<
    ReturnType<typeof inspectDispatchAuthorizationEnvelope>
  >["binding"],
) {
  return {
    ...scopeRow(),
    to_email: payload.to,
    template: payload.template,
    template_version: payload.templateVersion,
    variables: payload.variables,
    claim_token: TOKEN,
    claim_owner: "worker-1",
    attempt_count: 2,
    lease_expires_at: new Date("2026-07-22T19:01:05.000Z"),
    adapter: "gmail",
    provider_call_started: "2026-07-22 19:00:05.123456+00",
    dispatch_binding_version: binding.bindingVersion,
    dispatch_binding_sha256: binding.bindingSha256,
  };
}

function tx1Steps(
  binding: NonNullable<
    ReturnType<typeof inspectDispatchAuthorizationEnvelope>
  >["binding"],
): Step[] {
  return [
    { contains: "begin" },
    { contains: "pg_advisory_xact_lock" },
    { contains: "from public.email_outbox", rows: [scopeRow()] },
    { contains: "select case", rows: [{ decision: "allowed" }] },
    {
      contains: "update public.email_outbox",
      rows: [
        {
          provider_call_started: "2026-07-22 19:00:05.123456+00",
          lease_expires_at: new Date("2026-07-22T19:01:05.000Z"),
          dispatch_binding_version: binding.bindingVersion,
          dispatch_binding_sha256: binding.bindingSha256,
        },
      ],
    },
    { contains: "commit" },
  ];
}

function tx2Prelude(
  binding: NonNullable<
    ReturnType<typeof inspectDispatchAuthorizationEnvelope>
  >["binding"],
): Step[] {
  return [
    { contains: "begin" },
    { contains: "set local lock_timeout" },
    { contains: "set local statement_timeout" },
    { contains: "set local idle_in_transaction_session_timeout" },
    { contains: "server_version_num", rows: [{ server_version_num: 160000 }] },
    { contains: "pg_advisory_xact_lock" },
    { contains: "for update", rows: [armedRow(binding)] },
    { contains: "select case", rows: [{ decision: "allowed" }] },
  ];
}

describe("guarded Postgres outbox dispatch", () => {
  it("arms exact binding then invokes once and persists terminal state in TX2", async () => {
    const dispatchAuthorization = authorization();
    const binding = inspectDispatchAuthorizationEnvelope(
      dispatchAuthorization,
    )!.binding;
    const tx1 = new ScriptedClient(tx1Steps(binding));
    const tx2 = new ScriptedClient([
      ...tx2Prelude(binding),
      {
        contains: "update public.email_outbox",
        rows: [
          {
            status: "sent",
            claim_version: 4,
            adapter: "gmail",
            provider_message_id: "gmail-1",
            provider_call_started: "2026-07-22 19:00:05.123456+00",
            sent_at: new Date("2026-07-22T19:00:06.000Z"),
            quarantined_at: null,
            last_error_code: null,
            dispatch_binding_version: binding.bindingVersion,
            dispatch_binding_sha256: binding.bindingSha256,
          },
        ],
      },
      { contains: "commit" },
    ]);
    const store = new PostgresOutboxStore(poolFor(tx1, tx2));
    const armed = await store.beginProviderCall(claim, {
      adapter: "gmail",
      leaseMs: 60_000,
      authorization: dispatchAuthorization,
    });
    expect(armed.kind).toBe("applied");
    if (armed.kind !== "applied") throw new Error("Expected permit.");
    const invoke = vi.fn(async () => ({
      kind: "sent" as const,
      providerMessageId: "gmail-1",
    }));

    await expect(
      store.dispatchAfterProviderBoundary(armed.permit, {
        authorization: dispatchAuthorization,
        invoke,
      }),
    ).resolves.toEqual({
      kind: "applied",
      exit: { kind: "sent", providerMessageId: "gmail-1" },
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(tx1.calls[4]!.values.slice(7, 9)).toEqual([
      binding.bindingVersion,
      binding.bindingSha256,
    ]);
    expect(tx2.calls.at(-2)!.sql).toContain(
      "dispatch_binding_sha256 = $11::text",
    );
    expect(tx1.releases).toEqual([false]);
    expect(tx2.releases).toEqual([false]);
  });

  it("destroys without rollback and rethrows the same branded fatal", async () => {
    const dispatchAuthorization = authorization();
    const binding = inspectDispatchAuthorizationEnvelope(
      dispatchAuthorization,
    )!.binding;
    const tx1 = new ScriptedClient(tx1Steps(binding));
    const tx2 = new ScriptedClient(tx2Prelude(binding));
    const store = new PostgresOutboxStore(poolFor(tx1, tx2));
    const armed = await store.beginProviderCall(claim, {
      adapter: "gmail",
      leaseMs: 60_000,
      authorization: dispatchAuthorization,
    });
    if (armed.kind !== "applied") throw new Error("Expected permit.");
    const fatal = new FatalProviderTransportError("GMAIL_TRANSPORT_UNSETTLED");

    await expect(
      store.dispatchAfterProviderBoundary(armed.permit, {
        authorization: dispatchAuthorization,
        invoke: async () => {
          throw fatal;
        },
      }),
    ).rejects.toBe(fatal);

    expect(tx2.calls.some(({ sql }) => sql === "rollback")).toBe(false);
    expect(
      tx2.calls.some(({ sql }) => sql.includes("update public.email_outbox")),
    ).toBe(false);
    expect(tx2.releases).toEqual([true]);
  });

  it("retains the exact provider exit on TX2 commit uncertainty", async () => {
    const dispatchAuthorization = authorization();
    const binding = inspectDispatchAuthorizationEnvelope(
      dispatchAuthorization,
    )!.binding;
    const tx1 = new ScriptedClient(tx1Steps(binding));
    const tx2 = new ScriptedClient([
      ...tx2Prelude(binding),
      {
        contains: "update public.email_outbox",
        rows: [
          {
            status: "sent",
            claim_version: 4,
            adapter: "gmail",
            provider_message_id: "gmail-1",
            provider_call_started: "2026-07-22 19:00:05.123456+00",
            sent_at: new Date("2026-07-22T19:00:06.000Z"),
            quarantined_at: null,
            last_error_code: null,
            dispatch_binding_version: binding.bindingVersion,
            dispatch_binding_sha256: binding.bindingSha256,
          },
        ],
      },
      { contains: "commit", error: new Error("ack lost") },
    ]);
    const store = new PostgresOutboxStore(poolFor(tx1, tx2));
    const armed = await store.beginProviderCall(claim, {
      adapter: "gmail",
      leaseMs: 60_000,
      authorization: dispatchAuthorization,
    });
    if (armed.kind !== "applied") throw new Error("Expected permit.");

    const thrown = await store
      .dispatchAfterProviderBoundary(armed.permit, {
        authorization: dispatchAuthorization,
        invoke: async () => ({ kind: "sent", providerMessageId: "gmail-1" }),
      })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(GuardedDispatchCommitUnknownError);
    expect((thrown as GuardedDispatchCommitUnknownError).exit).toEqual({
      kind: "sent",
      providerMessageId: "gmail-1",
    });
    expect(tx2.calls.some(({ sql }) => sql === "rollback")).toBe(false);
    expect(tx2.releases).toEqual([true]);
  });
});
