import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const onConflictDoNothing = vi.fn(async () => undefined);
  const values = vi.fn((value: Record<string, unknown>) => {
    void value;
    return { onConflictDoNothing };
  });
  const insert = vi.fn(() => ({ values }));
  return { insert, values, onConflictDoNothing };
});

vi.mock("@/lib/db/client", () => ({ db: { insert: mocks.insert } }));
vi.mock("@/lib/db/schema", () => ({
  emailOutbox: { idempotencyKey: "idempotency_key" },
}));

import { enqueueEmail } from "../outbox";

describe("email outbox", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normalizes the recipient and derives a deterministic non-secret idempotency key", async () => {
    const input = {
      to: "Learner@Example.COM",
      template: "reset-password" as const,
      variables: {
        name: "Learner",
        url: "https://example.test/activate?token=one-time-secret",
      },
      userId: "learner-1",
      idempotencySeed: "password-reset-1",
    };
    await enqueueEmail(input);

    const expected = createHash("sha256")
      .update("reset-password:learner@example.com:password-reset-1")
      .digest("hex");
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "learner@example.com",
        idempotencyKey: expected,
        variables: input.variables,
      }),
    );
    expect(expected).not.toContain("one-time-secret");
    expect(mocks.onConflictDoNothing).toHaveBeenCalledWith({
      target: "idempotency_key",
    });
  });

  it("uses distinct keys for different templates or business events", async () => {
    await enqueueEmail({
      to: "a@example.com",
      template: "invitation",
      variables: {},
      systemProducer: "access-request-approved",
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
      idempotencySeed: "event-0002",
      sourceId: "22222222-2222-4222-8222-222222222222",
    });
    const keys = mocks.values.mock.calls.map(
      ([value]) => (value as { idempotencyKey: string }).idempotencyKey,
    );
    expect(new Set(keys).size).toBe(3);
  });
});
