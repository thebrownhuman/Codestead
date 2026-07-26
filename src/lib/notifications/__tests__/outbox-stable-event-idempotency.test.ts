import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const execute = vi.fn(async (statement: unknown) => {
    void statement;
  });
  const values = vi.fn((row: unknown) => {
    void row;
  });
  return { execute, values };
});

vi.mock("@/lib/db/client", () => ({
  db: {
    execute: mocks.execute,
  },
}));

import { enqueueEmail } from "../outbox";
import { capturedOutboxRow } from "./outbox-sql-test-support";

type EnqueueInput = Parameters<typeof enqueueEmail>[0];
type SystemInputWithAudience = EnqueueInput & { audienceId: string };

describe("email producer-event replay authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute.mockImplementation(async (statement) => {
      mocks.values(capturedOutboxRow(statement));
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
