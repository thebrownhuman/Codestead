import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => {
  const execute = vi.fn(async (_statement: unknown) => {
    void _statement;
  });
  const values = vi.fn((_value: Record<string, unknown>) => {
    void _value;
  });
  return { execute, values };
});

vi.mock("@/lib/db/client", () => ({
  db: { execute: mocks.execute },
}));

import {
  EmailOutboxReplayConflictError,
  enqueueEmail,
  enqueueEmailInTransaction,
} from "../outbox";
import { accountMailEventIdempotencyKey } from "../idempotency-authority";

const dialect = new PgDialect();

function renderStatement(statement: unknown) {
  return dialect.sqlToQuery(statement as never);
}

describe("email outbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute.mockImplementation(async (statement) => {
      const { params } = renderStatement(statement);
      const [
        operationId,
        userId,
        deliveryScopeKey,
        toEmail,
        template,
        templateVersion,
        variablesJson,
        idempotencyKey,
        idempotencyAuthorityVersion,
      ] = params;
      mocks.values({
        operationId,
        userId,
        deliveryScopeKey,
        toEmail,
        template,
        templateVersion,
        variables: JSON.parse(String(variablesJson)),
        idempotencyKey,
        idempotencyAuthorityVersion,
      });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["standalone", "transaction"] as const)(
    "renders only the canonical worker-granted insert columns (%s)",
    async (mode) => {
      const input = {
        to: " Worker.Writer@Example.INVALID ",
        template: "verify-email" as const,
        variables: {
          name: "Private learner",
          url: "https://example.invalid/verify?token=must-stay-parameterized",
        },
        userId: "worker-writer-learner",
        idempotencySeed: "worker-writer-event",
      };
      if (mode === "transaction") {
        await enqueueEmailInTransaction(
          {
            execute: mocks.execute,
          } as never,
          input,
        );
      } else {
        await enqueueEmail(input);
      }

      const statement = mocks.execute.mock.calls.at(-1)?.[0];
      expect(statement).toBeDefined();
      const rendered = renderStatement(statement);
      const normalizedSql = rendered.sql
        .replace(/\s+/gu, " ")
        .trim()
        .toLowerCase();
      const targetList = normalizedSql.match(
        /^insert into public[.]email_outbox [(]([^)]*)[)] values/u,
      )?.[1];
      expect(targetList).toBeDefined();
      const targetColumns = targetList?.split(",").map((column) => column.trim());
      expect(targetColumns).toEqual([
        "operation_id",
        "user_id",
        "delivery_scope_key",
        "to_email",
        "template",
        "template_version",
        "variables",
        "idempotency_key",
        "idempotency_authority_version",
        "status",
        "next_attempt_at",
      ]);
      for (const forbiddenColumn of [
        "id",
        "idempotency_authority_sha256",
        "idempotency_original_payload_sha256",
        "attempt_count",
        "claim_token",
        "claim_owner",
        "claim_version",
        "lease_expires_at",
        "provider_call_started",
        "adapter",
        "dispatch_binding_version",
        "dispatch_binding_sha256",
        "provider_correlation_version",
        "provider_evidence_version",
        "provider_evidence_sha256",
        "provider_message_id",
        "sent_at",
        "quarantined_at",
        "last_error_code",
        "created_at",
        "updated_at",
      ]) {
        expect(targetColumns).not.toContain(forbiddenColumn);
      }
      expect(normalizedSql).toContain(
        "on conflict (idempotency_key) do nothing",
      );
      expect(normalizedSql).not.toContain("worker.writer@example.invalid");
      expect(normalizedSql).not.toContain("must-stay-parameterized");
      expect(rendered.params).toEqual(expect.arrayContaining([
        "worker.writer@example.invalid",
        "verify-email",
        "1",
        "event-v1-native",
        JSON.stringify(input.variables),
      ]));
    },
  );

  it("normalizes the recipient and derives a deterministic non-secret idempotency key", async () => {
    const input = {
      to: " Learner@Example.COM ",
      template: "reset-password" as const,
      variables: {
        name: "Learner",
        url: "https://example.test/activate?token=one-time-secret",
      },
      userId: "learner-1",
      idempotencySeed: "password-reset-1",
    };
    await enqueueEmail(input);

    const expected = accountMailEventIdempotencyKey({
      eventId: "password-reset-1",
      template: "reset-password",
      userId: "learner-1",
    });
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "learner@example.com",
        idempotencyKey: expected,
        variables: input.variables,
      }),
    );
    expect(expected).not.toContain("one-time-secret");
    const statement = mocks.execute.mock.calls.at(-1)?.[0];
    expect(renderStatement(statement).sql.replace(/\s+/gu, " ").toLowerCase())
      .toContain(
        "on conflict (idempotency_key) do nothing",
      );
  });

  it("uses distinct keys for different templates or business events", async () => {
    await enqueueEmail({
      to: "a@example.com",
      template: "invitation",
      variables: {},
      systemProducer: "access-request-approved",
      audienceId: "11111111-1111-4111-8111-111111111111",
      idempotencySeed: "event-0001",
      sourceId: "11111111-1111-4111-8111-111111111111",
    });
    await enqueueEmail({
      to: "a@example.com",
      template: "verify-email",
      variables: {},
      userId: "learner-1",
      idempotencySeed: "event-0001",
    });
    await enqueueEmail({
      to: "a@example.com",
      template: "invitation",
      variables: {},
      systemProducer: "access-request-approved",
      audienceId: "22222222-2222-4222-8222-222222222222",
      idempotencySeed: "event-0002",
      sourceId: "22222222-2222-4222-8222-222222222222",
    });
    const keys = mocks.values.mock.calls.map(
      ([value]) => (value as { idempotencyKey: string }).idempotencyKey,
    );
    expect(new Set(keys).size).toBe(3);
  });

  it.each(["standalone", "transaction"] as const)(
    "normalizes nested authority conflicts without exposing parameters (%s)",
    async (mode) => {
      const recipient = "private.learner+reset@example.invalid";
      const resetToken = "reset-token-that-must-never-escape";
      const resetUrl =
        `https://codestead.example.invalid/reset-password?token=${resetToken}`
        + "&callbackUrl=%2Fsettings%3Fsection%3Dsecurity";
      const variables = {
        name: "Private Learner",
        url: resetUrl,
        note: "private-variable-value",
      };
      const rawSql =
        'insert into "email_outbox" ("to_email","variables") values ($1,$2)';
      const pgError = Object.assign(
        new Error(
          `duplicate key ${recipient} ${JSON.stringify(variables)} ${rawSql}`,
        ),
        {
          code: "23505",
          constraint: "email_outbox_idempotency_authority_pkey",
        },
      );
      mocks.execute.mockRejectedValueOnce(
        new DrizzleQueryError(
          rawSql,
          [recipient, JSON.stringify(variables)],
          pgError,
        ),
      );
      const consoleSpies = [
        vi.spyOn(console, "error").mockImplementation(() => undefined),
        vi.spyOn(console, "warn").mockImplementation(() => undefined),
        vi.spyOn(console, "info").mockImplementation(() => undefined),
        vi.spyOn(console, "log").mockImplementation(() => undefined),
      ];
      const input = {
        to: recipient,
        template: "reset-password" as const,
        variables,
        userId: "private-learner",
        idempotencySeed: "private-reset-event",
      };
      let observed: unknown;
      try {
        if (mode === "transaction") {
          await enqueueEmailInTransaction(
            { execute: mocks.execute } as never,
            input,
          );
        } else {
          await enqueueEmail(input);
        }
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(EmailOutboxReplayConflictError);
      expect(observed).toMatchObject({
        code: "EMAIL_OUTBOX_REPLAY_CONFLICT",
        message: "Email outbox replay conflicts with durable authority.",
        name: "EmailOutboxReplayConflictError",
      });
      const exposed = [
        String(observed),
        (observed as Error).stack ?? "",
        JSON.stringify(observed),
        JSON.stringify(Object.keys(observed as object)),
      ].join("\n");
      for (const secret of [
        recipient,
        resetToken,
        resetUrl,
        variables.note,
        rawSql,
        "callbackUrl",
      ]) {
        expect(exposed).not.toContain(secret);
      }
      expect(observed).not.toHaveProperty("cause");
      expect(observed).not.toHaveProperty("query");
      expect(observed).not.toHaveProperty("params");
      for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    },
  );

  it("sanitizes every other nested Drizzle persistence failure", async () => {
    const recipient = "private.learner@example.invalid";
    const rawSql =
      'insert into "email_outbox" ("operation_id") values ($1)';
    const unrelated = new DrizzleQueryError(
      rawSql,
      [recipient],
      Object.assign(new Error(`unrelated ${recipient} ${rawSql}`), {
        code: "23505",
        constraint: "email_outbox_operation_id_unique",
      }),
    );
    mocks.execute.mockRejectedValueOnce(unrelated);

    const observed = await enqueueEmail({
      to: recipient,
      template: "verify-email",
      variables: { name: "Learner", url: "https://example.invalid/verify" },
      userId: "learner-1",
      idempotencySeed: "verify-1",
    }).catch((error: unknown) => error);
    expect(observed).toMatchObject({
      name: "EmailOutboxPersistenceError",
      code: "EMAIL_OUTBOX_PERSISTENCE_FAILED",
      message: "Email outbox persistence failed.",
    });
    expect(observed).not.toHaveProperty("cause");
    expect(observed).not.toHaveProperty("query");
    expect(observed).not.toHaveProperty("params");
    expect(String(observed)).not.toContain(recipient);
    expect((observed as Error).stack ?? "").not.toContain(rawSql);
  });

  it.each([
    "raw-driver",
    "hostile-cause-getter",
    "hostile-prototype",
  ] as const)(
    "sanitizes non-authoritative persistence failures (%s)",
    async (failureKind) => {
      const secret = "driver-secret-that-must-not-escape";
      const rawSql =
        "insert into public.email_outbox (to_email) values ($1)";
      let failure: unknown;
      if (failureKind === "raw-driver") {
        failure = new Error(`${secret}:${rawSql}`);
      } else if (failureKind === "hostile-cause-getter") {
        const wrapped = new DrizzleQueryError(
          rawSql,
          [secret],
          new Error("placeholder"),
        );
        Object.defineProperty(wrapped, "cause", {
          configurable: true,
          get() {
            throw new Error(`${secret}:hostile-cause-getter`);
          },
        });
        failure = wrapped;
      } else {
        failure = new Proxy({}, {
          getPrototypeOf() {
            throw new Error(`${secret}:hostile-prototype`);
          },
        });
      }
      mocks.execute.mockRejectedValueOnce(failure);

      const observed = await enqueueEmail({
        to: "private@example.invalid",
        template: "verify-email",
        variables: { name: "Learner", url: "https://example.invalid/verify" },
        userId: "learner-1",
        idempotencySeed: "verify-sanitized-failure",
      }).catch((error: unknown) => error);

      expect(observed).toMatchObject({
        name: "EmailOutboxPersistenceError",
        code: "EMAIL_OUTBOX_PERSISTENCE_FAILED",
        message: "Email outbox persistence failed.",
      });
      expect(observed).not.toHaveProperty("cause");
      expect(observed).not.toHaveProperty("query");
      expect(observed).not.toHaveProperty("params");
      const exposed = [
        String(observed),
        (observed as Error).stack ?? "",
        JSON.stringify(observed),
      ].join("\n");
      expect(exposed).not.toContain(secret);
      expect(exposed).not.toContain(rawSql);
    },
  );

  it("sanitizes serialization failures before database execution", async () => {
    const secret = "cyclic-variable-secret-that-must-not-escape";
    const cyclicVariables: Record<string, unknown> = { note: secret };
    cyclicVariables.self = cyclicVariables;

    const observed = await enqueueEmail({
      to: "private@example.invalid",
      template: "verify-email",
      variables: cyclicVariables as Record<string, string>,
      userId: "learner-1",
      idempotencySeed: "verify-cyclic-failure",
    }).catch((error: unknown) => error);

    expect(observed).toMatchObject({
      name: "EmailOutboxPersistenceError",
      code: "EMAIL_OUTBOX_PERSISTENCE_FAILED",
      message: "Email outbox persistence failed.",
    });
    expect(observed).not.toHaveProperty("cause");
    expect(observed).not.toHaveProperty("query");
    expect(observed).not.toHaveProperty("params");
    expect(String(observed)).not.toContain(secret);
    expect((observed as Error).stack ?? "").not.toContain(secret);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects backup-status outside its dedicated authority routine", async () => {
    await expect(
      enqueueEmail({
        to: "admin@example.invalid",
        template: "backup-status",
        variables: {
          name: "Administrator",
          summary: "Backup complete.",
        },
        userId: "admin-1",
        idempotencySeed: "backup-run-1",
      }),
    ).rejects.toThrow(
      "Email template backup-status requires its specialized producer.",
    );
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
