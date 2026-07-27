import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => {
  const execute = vi.fn(async (statement: unknown): Promise<unknown> => {
    void statement;
    return undefined;
  });
  const values = vi.fn((row: unknown) => {
    void row;
  });
  const transaction = vi.fn(
    async (callback: (tx: { execute: typeof execute }) => Promise<unknown>) =>
      callback({ execute }),
  );
  return { execute, transaction, values };
});

vi.mock("@/lib/db/client", () => ({
  db: {
    execute: mocks.execute,
    transaction: mocks.transaction,
  },
}));

import { enqueueEmail } from "../outbox";
import { capturedOutboxRow } from "./outbox-sql-test-support";

type EnqueueInput = Parameters<typeof enqueueEmail>[0];
type SystemInputWithAudience = EnqueueInput & { audienceId: string };

const dialect = new PgDialect();
const OUTBOX_ID = "82000000-0000-4000-8000-000000000001";
const AUTHORITY_SHA256 = "a".repeat(64);
const PAYLOAD_SHA256 = "b".repeat(64);

describe("email producer-event replay authority", () => {
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

  it("keeps one account event identity when the recipient address changes", async () => {
    const event = {
      userId: "learner-1",
      template: "storage-quota-changed" as const,
      variables: { quota: "3 GiB" },
      idempotencySeed: "a2000000-0000-4000-8000-000000000001",
    };

    await enqueueEmail({ ...event, to: "old-address@example.test" });
    await enqueueEmail({ ...event, to: "new-address@example.test" });

    const rows = mocks.values.mock.calls.map(([row]) => row as {
      idempotencyAuthorityVersion?: string;
      idempotencyKey: string;
      toEmail: string;
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.toEmail).not.toBe(rows[1]?.toEmail);
    expect(rows[0]?.idempotencyKey).toBe(rows[1]?.idempotencyKey);
    expect(rows.map((row) => row.idempotencyAuthorityVersion))
      .toEqual(["event-v1-native", "event-v1-native"]);
  });

  it("separates the same event by template and canonical account scope", async () => {
    const common = {
      to: "same-address@example.test",
      variables: {},
      idempotencySeed: "event-1",
    };
    await enqueueEmail({
      ...common,
      userId: "learner-1",
      template: "storage-quota-changed",
    });
    await enqueueEmail({
      ...common,
      userId: "learner-2",
      template: "storage-quota-changed",
    });
    await enqueueEmail({
      ...common,
      userId: "learner-1",
      template: "learning-plan-changed",
    });

    const keys = mocks.values.mock.calls.map(
      ([row]) => (row as { idempotencyKey: string }).idempotencyKey,
    );
    expect(new Set(keys).size).toBe(3);
  });

  it("separates system audiences without using their mutable email address", async () => {
    const common = {
      to: "admin@example.test",
      template: "access-request-admin" as const,
      variables: {},
      systemProducer: "access-request-admin" as const,
      sourceId: "a1000000-0000-4000-8000-000000000001",
      idempotencySeed: "a1000000-0000-4000-8000-000000000001",
    };
    await enqueueEmail({
      ...common,
      audienceId: "b1000000-0000-4000-8000-000000000001",
    } as SystemInputWithAudience);
    await enqueueEmail({
      ...common,
      audienceId: "b2000000-0000-4000-8000-000000000002",
    } as SystemInputWithAudience);
    await enqueueEmail({
      ...common,
      to: "renamed-admin@example.test",
      audienceId: "b1000000-0000-4000-8000-000000000001",
    } as SystemInputWithAudience);

    const rows = mocks.values.mock.calls.map(([row]) => row as {
      idempotencyKey: string;
      toEmail: string;
      variables: Record<string, string>;
    });
    expect(rows[0]?.idempotencyKey).not.toBe(rows[1]?.idempotencyKey);
    expect(rows[0]?.idempotencyKey).toBe(rows[2]?.idempotencyKey);
    expect(rows[0]?.variables._mailAudienceId).toBe(
      "b1000000-0000-4000-8000-000000000001",
    );
  });

  it("rejects account-deleted at the generic account producer boundary", async () => {
    const hostileInput = {
      userId: "learner-1",
      to: "deleted-learner@example.test",
      template: "account-deleted",
      variables: {
        backupRetentionUntil: "2027-07-26T00:00:00.000Z",
        deletionRunId: "a1000000-0000-4000-8000-000000000091",
        tombstoneId: "a1000000-0000-4000-8000-000000000092",
      },
      idempotencySeed: "a1000000-0000-4000-8000-000000000091",
    } as unknown as EnqueueInput;

    await expect(enqueueEmail(hostileInput)).rejects.toThrow(
      "Account email template is not allowed for the generic producer.",
    );
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
