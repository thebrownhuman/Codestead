import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => {
  const execute = vi.fn(async (_statement: unknown): Promise<unknown> => {
    void _statement;
    return undefined;
  });
  const values = vi.fn((_value: unknown) => {
    void _value;
  });
  const transaction = vi.fn(
    async (callback: (tx: { execute: typeof execute }) => Promise<unknown>) =>
      callback({ execute }),
  );
  return { execute, transaction, values };
});

vi.mock("@/lib/db/client", () => ({
  db: { execute: mocks.execute, transaction: mocks.transaction },
}));

import { enqueueEmail } from "../outbox";
import { capturedOutboxRow } from "./outbox-sql-test-support";

const dialect = new PgDialect();
const OUTBOX_ID = "81000000-0000-4000-8000-000000000001";
const AUTHORITY_SHA256 = "a".repeat(64);
const PAYLOAD_SHA256 = "b".repeat(64);

describe("email outbox delivery scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let operationId: string | undefined;
    mocks.execute.mockImplementation(async (statement) => {
      const rendered = dialect.sqlToQuery(statement as never);
      if (rendered.sql.includes("release_email_outbox_delivery")) {
        if (!operationId) throw new Error("Release ran before insert.");
        return {
          rowCount: 1,
          rows: [{ outbox_id: OUTBOX_ID, operation_id: operationId }],
        };
      }
      const row = capturedOutboxRow(statement);
      operationId = String(row.operationId);
      mocks.values(row);
      return {
        rowCount: 1,
        rows: [{
          id: OUTBOX_ID,
          operation_id: operationId,
          idempotency_authority_sha256: AUTHORITY_SHA256,
          idempotency_original_payload_sha256: PAYLOAD_SHA256,
          delivery_hold_version: "task7-v1",
        }],
      };
    });
  });

  it("derives an immutable account scope from the account identity", async () => {
    await enqueueEmail({
      to: "learner@example.com",
      template: "verify-email",
      variables: {},
      userId: "learner-1",
      idempotencySeed: "verify-1",
    });

    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "learner-1",
        deliveryScopeKey: "a:learner-1",
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      }),
    );
  });

  it("derives an operation scope for a registered accountless producer", async () => {
    await enqueueEmail({
      to: "candidate@example.com",
      template: "access-rejected",
      variables: {
        name: "Candidate",
        _mailOperationId: "forged-operation",
        _mailRecipient: "forged@example.com",
        _mailProducer: "access-request-approved",
        _mailSourceId: "11111111-1111-4111-8111-111111111111",
      },
      systemProducer: "access-request-rejected",
      audienceId: "22222222-2222-4222-8222-222222222222",
      sourceId: "22222222-2222-4222-8222-222222222222",
      idempotencySeed: "request-1",
    });

    const value = mocks.values.mock.calls.at(-1)?.[0] as {
      operationId: string;
      deliveryScopeKey: string;
      userId: string | null;
      variables: Record<string, string>;
    };
    expect(value.userId).toBeNull();
    expect(value.deliveryScopeKey).toBe(`s:${value.operationId}`);
    expect(value.variables).toEqual(
      expect.objectContaining({
        name: "Candidate",
        _mailOperationId: value.operationId,
        _mailRecipient: "candidate@example.com",
        _mailProducer: "access-request-rejected",
        _mailSourceId: "22222222-2222-4222-8222-222222222222",
        _mailAudienceId: "22222222-2222-4222-8222-222222222222",
      }),
    );
  });

  it("rejects a forged producer/template pair before insertion", async () => {
    await expect(
      enqueueEmail({
        to: "candidate@example.com",
        template: "reset-password",
        variables: {},
        systemProducer: "access-request-rejected",
        sourceId: "22222222-2222-4222-8222-222222222222",
        idempotencySeed: "request-2",
      } as never),
    ).rejects.toThrow("System email producer/template pair is not allowed");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID durable system source before insertion", async () => {
    await expect(
      enqueueEmail({
        to: "candidate@example.com",
        template: "access-rejected",
        variables: {},
        systemProducer: "access-request-rejected",
        audienceId: "22222222-2222-4222-8222-222222222222",
        sourceId: "request-2",
        idempotencySeed: "request-2",
      }),
    ).rejects.toThrow("System email source ID must be a UUID");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
