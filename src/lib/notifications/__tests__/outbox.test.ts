import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => {
  const execute = vi.fn(async (_statement: unknown): Promise<unknown> => {
    void _statement;
    return undefined;
  });
  const transaction = vi.fn(
    async (callback: (tx: { execute: typeof execute }) => Promise<unknown>) =>
      callback({ execute }),
  );
  const values = vi.fn((_value: Record<string, unknown>) => {
    void _value;
  });
  return { execute, transaction, values };
});

vi.mock("@/lib/db/client", () => ({
  db: {
    execute: mocks.execute,
    transaction: mocks.transaction,
  },
}));

import {
  EmailOutboxReplayConflictError,
  enqueueEmail,
  enqueueEmailInTransaction,
} from "../outbox";
import { accountMailEventIdempotencyKey } from "../idempotency-authority";

const dialect = new PgDialect();
const INSERTED_OUTBOX_RELEASE = Object.freeze({
  id: "11111111-1111-4111-8111-111111111111",
  operation_id: "22222222-2222-4222-8222-222222222222",
  idempotency_authority_sha256: "a".repeat(64),
  idempotency_original_payload_sha256: "b".repeat(64),
  delivery_hold_version: "task7-v1",
});

function renderStatement(statement: unknown) {
  return dialect.sqlToQuery(statement as never);
}

function executedStatementContaining(fragment: string) {
  return mocks.execute.mock.calls
    .map(([statement]) => statement)
    .find((statement) =>
      renderStatement(statement)
        .sql.replace(/\s+/gu, " ")
        .trim()
        .toLowerCase()
        .includes(fragment),
    );
}

describe("email outbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (
        callback: (tx: { execute: typeof mocks.execute }) => Promise<unknown>,
      ) => callback({ execute: mocks.execute }),
    );
    let insertedOperationId: string = INSERTED_OUTBOX_RELEASE.operation_id;
    mocks.execute.mockImplementation(async (statement) => {
      const rendered = renderStatement(statement);
      const normalizedSql = rendered.sql
        .replace(/\s+/gu, " ")
        .trim()
        .toLowerCase();
      if (normalizedSql.includes("release_email_outbox_delivery")) {
        return {
          rowCount: 1,
          rows: [
            {
              outbox_id: INSERTED_OUTBOX_RELEASE.id,
              operation_id: insertedOperationId,
            },
          ],
        };
      }
      const { params } = rendered;
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
      insertedOperationId = String(operationId);
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
      return {
        rowCount: 1,
        rows: [
          {
            ...INSERTED_OUTBOX_RELEASE,
            operation_id: String(operationId),
          },
        ],
      };
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("issues release authority from exact database-returned fields before yielding the caller transaction", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [INSERTED_OUTBOX_RELEASE],
      })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            outbox_id: INSERTED_OUTBOX_RELEASE.id,
            operation_id: INSERTED_OUTBOX_RELEASE.operation_id,
          },
        ],
      });

    await enqueueEmailInTransaction({ execute } as never, {
      to: "learner@example.invalid",
      template: "verify-email",
      variables: {
        name: "Learner",
        url: "https://example.invalid/verify",
      },
      userId: "learner-release-1",
      idempotencySeed: "verify-release-1",
    });

    expect(execute).toHaveBeenCalledTimes(2);
    const insert = renderStatement(execute.mock.calls[0]![0]);
    expect(insert.sql.replace(/\s+/gu, " ").trim().toLowerCase()).toContain(
      "returning id::pg_catalog.text as id, operation_id::pg_catalog.text as operation_id, idempotency_authority_sha256, idempotency_original_payload_sha256, delivery_hold_version",
    );
    const release = renderStatement(execute.mock.calls[1]![0]);
    expect(release.sql.replace(/\s+/gu, " ").trim().toLowerCase()).toContain(
      "from public.release_email_outbox_delivery",
    );
    expect(release.params).toEqual([
      INSERTED_OUTBOX_RELEASE.id,
      INSERTED_OUTBOX_RELEASE.operation_id,
      INSERTED_OUTBOX_RELEASE.idempotency_authority_sha256,
      INSERTED_OUTBOX_RELEASE.idempotency_original_payload_sha256,
      INSERTED_OUTBOX_RELEASE.delivery_hold_version,
    ]);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("binds every account insert to a fresh canonical user-authority decision", async () => {
    await enqueueEmailInTransaction({ execute: mocks.execute } as never, {
      to: " Learner@Example.INVALID ",
      template: "verify-email",
      variables: {
        name: "Learner",
        url: "https://example.invalid/verify",
      },
      userId: "learner-authority-1",
      idempotencySeed: "verify-authority-1",
    });

    const statement = executedStatementContaining(
      "insert into public.email_outbox",
    );
    expect(statement).toBeDefined();
    const rendered = renderStatement(statement);
    const normalizedSql = rendered.sql
      .replace(/\s+/gu, " ")
      .trim()
      .toLowerCase();
    expect(normalizedSql).toContain("pg_try_advisory_xact_lock");
    expect(rendered.params).toContain(
      "user-authority:learner-authority-1",
    );
    expect(normalizedSql).toContain('left join public."user"');
    expect(normalizedSql).toContain("authority_user.status not in");
    expect(normalizedSql).toContain("'deletion_pending'");
    expect(normalizedSql).toContain("'deleted'");
    expect(normalizedSql).toContain(
      "pg_catalog.lower(pg_catalog.btrim(authority_user.email)) =",
    );
  });

  it("owns the standalone insert-and-release transaction", async () => {
    const transactionExecute = vi
      .fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [INSERTED_OUTBOX_RELEASE],
      })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          outbox_id: INSERTED_OUTBOX_RELEASE.id,
          operation_id: INSERTED_OUTBOX_RELEASE.operation_id,
        }],
      });
    mocks.transaction.mockImplementationOnce(
      async (
        callback: (tx: {
          execute: typeof transactionExecute;
        }) => Promise<unknown>,
      ) => callback({ execute: transactionExecute }),
    );

    await enqueueEmail({
      to: "learner@example.invalid",
      template: "verify-email",
      variables: {
        name: "Learner",
        url: "https://example.invalid/verify",
      },
      userId: "learner-release-standalone",
      idempotencySeed: "verify-release-standalone",
    });

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(transactionExecute).toHaveBeenCalledTimes(2);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(
      renderStatement(transactionExecute.mock.calls[1]![0]).params,
    ).toEqual([
      INSERTED_OUTBOX_RELEASE.id,
      INSERTED_OUTBOX_RELEASE.operation_id,
      INSERTED_OUTBOX_RELEASE.idempotency_authority_sha256,
      INSERTED_OUTBOX_RELEASE.idempotency_original_payload_sha256,
      INSERTED_OUTBOX_RELEASE.delivery_hold_version,
    ]);
  });

  it.each([
    ["zero rows", { rowCount: 0, rows: [] }],
    [
      "multiple rows",
      {
        rowCount: 2,
        rows: [
          {
            outbox_id: INSERTED_OUTBOX_RELEASE.id,
            operation_id: INSERTED_OUTBOX_RELEASE.operation_id,
          },
          {
            outbox_id: INSERTED_OUTBOX_RELEASE.id,
            operation_id: INSERTED_OUTBOX_RELEASE.operation_id,
          },
        ],
      },
    ],
    [
      "a different outbox",
      {
        rowCount: 1,
        rows: [{
          outbox_id: "33333333-3333-4333-8333-333333333333",
          operation_id: INSERTED_OUTBOX_RELEASE.operation_id,
        }],
      },
    ],
    [
      "a different operation",
      {
        rowCount: 1,
        rows: [{
          outbox_id: INSERTED_OUTBOX_RELEASE.id,
          operation_id: "44444444-4444-4444-8444-444444444444",
        }],
      },
    ],
  ] as const)(
    "rejects and aborts the standalone transaction when release returns %s",
    async (_label, invalidRelease) => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [INSERTED_OUTBOX_RELEASE],
        })
        .mockResolvedValueOnce(invalidRelease);
      let transactionRejection: unknown;
      mocks.transaction.mockImplementationOnce(
        async (
          callback: (tx: { execute: typeof execute }) => Promise<unknown>,
        ) => {
          try {
            return await callback({ execute });
          } catch (error) {
            transactionRejection = error;
            throw error;
          }
        },
      );

      const observed = await enqueueEmail({
        to: "learner@example.invalid",
        template: "verify-email",
        variables: {
          name: "Learner",
          url: "https://example.invalid/verify",
        },
        userId: "learner-release-invalid",
        idempotencySeed: "verify-release-invalid",
      }).catch((error: unknown) => error);

      expect(observed).toMatchObject({
        name: "EmailOutboxPersistenceError",
        code: "EMAIL_OUTBOX_PERSISTENCE_FAILED",
        message: "Email outbox persistence failed.",
      });
      expect(transactionRejection).toMatchObject({
        name: "EmailOutboxReleaseReceiptError",
        code: "EMAIL_OUTBOX_RELEASE_RECEIPT_INVALID",
      });
      expect(execute).toHaveBeenCalledTimes(2);
    },
  );

  it("skips release issuance when the exact replay inserts no row", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rowCount: 0,
        rows: [],
      })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: INSERTED_OUTBOX_RELEASE.id }],
      });

    await enqueueEmailInTransaction({ execute } as never, {
      to: "learner@example.invalid",
      template: "verify-email",
      variables: {
        name: "Learner",
        url: "https://example.invalid/verify",
      },
      userId: "learner-release-replay",
      idempotencySeed: "verify-release-replay",
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      renderStatement(execute.mock.calls[0]![0])
        .sql.replace(/\s+/gu, " ")
        .trim()
        .toLowerCase(),
    ).not.toContain("release_email_outbox_delivery");
  });

  it.each(["standalone", "transaction"] as const)(
    "rejects the owning transaction when release issuance fails (%s)",
    async (mode) => {
      const secret = "release-authority-secret-that-must-not-escape";
      const releaseFailure = new Error(secret);
      const execute = vi
        .fn()
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [INSERTED_OUTBOX_RELEASE],
        })
        .mockRejectedValueOnce(releaseFailure);
      let transactionRejection: unknown;
      if (mode === "standalone") {
        mocks.transaction.mockImplementationOnce(
          async (
            callback: (tx: { execute: typeof execute }) => Promise<unknown>,
          ) => {
            try {
              return await callback({ execute });
            } catch (error) {
              transactionRejection = error;
              throw error;
            }
          },
        );
      }
      const input = {
        to: "learner@example.invalid",
        template: "verify-email" as const,
        variables: {
          name: "Learner",
          url: "https://example.invalid/verify",
        },
        userId: "learner-release-failure",
        idempotencySeed: `verify-release-failure:${mode}`,
      };

      const observed =
        mode === "standalone"
          ? await enqueueEmail(input).catch((error: unknown) => error)
          : await enqueueEmailInTransaction({ execute } as never, input).catch(
              (error: unknown) => error,
            );

      expect(observed).toMatchObject({
        name: "EmailOutboxPersistenceError",
        code: "EMAIL_OUTBOX_PERSISTENCE_FAILED",
        message: "Email outbox persistence failed.",
      });
      expect(execute).toHaveBeenCalledTimes(2);
      expect(String(observed)).not.toContain(secret);
      expect((observed as Error).stack ?? "").not.toContain(secret);
      if (mode === "standalone") {
        expect(mocks.transaction).toHaveBeenCalledTimes(1);
        expect(transactionRejection).toBe(releaseFailure);
      } else {
        expect(mocks.transaction).not.toHaveBeenCalled();
      }
    },
  );
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

      const statement = executedStatementContaining(
        "insert into public.email_outbox",
      );
      expect(statement).toBeDefined();
      const rendered = renderStatement(statement);
      const normalizedSql = rendered.sql
        .replace(/\s+/gu, " ")
        .trim()
        .toLowerCase();
      const targetList = normalizedSql.match(
        /^insert into public[.]email_outbox [(]([^)]*)[)] select/u,
      )?.[1];
      expect(targetList).toBeDefined();
      const targetColumns = targetList
        ?.split(",")
        .map((column) => column.trim());
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
      expect(rendered.params).toEqual(
        expect.arrayContaining([
          "worker.writer@example.invalid",
          "verify-email",
          "1",
          "event-v1-native",
          JSON.stringify(input.variables),
        ]),
      );
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
    const statement = executedStatementContaining(
      "insert into public.email_outbox",
    );
    expect(
      renderStatement(statement).sql.replace(/\s+/gu, " ").toLowerCase(),
    ).toContain("on conflict (idempotency_key) do nothing");
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
        `https://codestead.example.invalid/reset-password?token=${resetToken}` +
        "&callbackUrl=%2Fsettings%3Fsection%3Dsecurity";
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
    const rawSql = 'insert into "email_outbox" ("operation_id") values ($1)';
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

  it.each(["raw-driver", "hostile-cause-getter", "hostile-prototype"] as const)(
    "sanitizes non-authoritative persistence failures (%s)",
    async (failureKind) => {
      const secret = "driver-secret-that-must-not-escape";
      const rawSql = "insert into public.email_outbox (to_email) values ($1)";
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
        failure = new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error(`${secret}:hostile-prototype`);
            },
          },
        );
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
