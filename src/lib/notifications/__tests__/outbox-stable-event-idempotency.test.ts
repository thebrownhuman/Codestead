import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const returning = vi.fn(async () => [{ id: "queued-id" }]);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn((_row: unknown) => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  return { insert, onConflictDoNothing, returning, values };
});

vi.mock("@/lib/db/client", () => ({
  db: {
    insert: mocks.insert,
  },
}));
vi.mock("@/lib/db/schema", () => ({
  emailOutbox: {
    id: "id",
    idempotencyKey: "idempotency_key",
  },
}));

import { enqueueEmail } from "../outbox";

describe("email producer-event idempotency authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      .toEqual(["event-v1", "event-v1"]);
  });

  it("separates the same event seed by template and stable account scope", async () => {
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
});
