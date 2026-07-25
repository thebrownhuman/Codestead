import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const returning = vi.fn(async () => [{ id: "queued-id" }]);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn((value: Record<string, unknown>) => {
    void value;
    return { onConflictDoNothing };
  });
  const insert = vi.fn(() => ({ values }));
  return { insert, values, onConflictDoNothing, returning };
});

vi.mock("@/lib/db/client", () => ({ db: { insert: mocks.insert } }));
vi.mock("@/lib/db/schema", () => ({
  emailOutbox: { id: "id", idempotencyKey: "idempotency_key" },
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
      .update([
        "mail-event-v1",
        "reset-password",
        "a:learner-1",
        "password-reset-1",
      ].join("\u001f"))
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
      audienceId: "requester:11111111-1111-4111-8111-111111111111",
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
      audienceId: "requester:22222222-2222-4222-8222-222222222222",
    });
    const keys = mocks.values.mock.calls.map(
      ([value]) => (value as { idempotencyKey: string }).idempotencyKey,
    );
    expect(new Set(keys).size).toBe(3);
  });

  it("reports whether the durable authority queued or suppressed the event", async () => {
    const input = {
      to: "learner@example.com",
      template: "verify-email" as const,
      variables: {},
      userId: "learner-1",
      idempotencySeed: "verify-1",
    };
    await expect(enqueueEmail(input)).resolves.toEqual({ kind: "queued" });

    mocks.returning.mockResolvedValueOnce([]);
    await expect(enqueueEmail(input)).resolves.toEqual({ kind: "suppressed" });
  });
});
