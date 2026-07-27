import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => {
  const execute = vi.fn(async (_statement: unknown): Promise<unknown> => {
    void _statement;
    return undefined;
  });
  const values = vi.fn((_row: unknown) => {
    void _row;
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

import {
  enqueueEmail,
  type AccountEmailTemplate,
  type EnqueueEmailInput,
} from "../outbox";
import { capturedOutboxRow } from "./outbox-sql-test-support";

const dialect = new PgDialect();
const OUTBOX_ID = "83000000-0000-4000-8000-000000000001";
const AUTHORITY_SHA256 = "a".repeat(64);
const PAYLOAD_SHA256 = "b".repeat(64);

describe("generic outbox template policy", () => {
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

  it("does not type specialized inactivity templates as generic account mail", () => {
    expectTypeOf<"inactivity-reminder">().not.toMatchTypeOf<AccountEmailTemplate>();
    expectTypeOf<"inactivity-reminder-followup">().not.toMatchTypeOf<AccountEmailTemplate>();
    expectTypeOf<"inactivity-admin-notice">().not.toMatchTypeOf<AccountEmailTemplate>();
  });

  it.each([
    "inactivity-reminder",
    "inactivity-reminder-followup",
    "inactivity-admin-notice",
  ] as const)("rejects a runtime-bypassed specialized %s enqueue", async (template) => {
    const bypassedInput = {
      to: "learner@example.test",
      template,
      variables: {},
      userId: "learner-1",
      idempotencySeed: "unsafe-generic-inactivity",
    } as unknown as EnqueueEmailInput;

    await expect(enqueueEmail(bypassedInput)).rejects.toThrow(
      "requires its specialized producer",
    );
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("derives the exact reviewed version instead of relying on a writer literal", async () => {
    await enqueueEmail({
      to: "learner@example.test",
      template: "credential-changed",
      variables: {},
      userId: "learner-1",
      idempotencySeed: "credential-change-1",
    });

    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({ templateVersion: "1" }),
    );
  });
});
