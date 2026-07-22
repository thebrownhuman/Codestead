import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const onConflictDoNothing = vi.fn(async () => undefined);
  const values = vi.fn((value: unknown) => {
    void value;
    return { onConflictDoNothing };
  });
  const insert = vi.fn(() => ({ values }));
  return { insert, values, onConflictDoNothing };
});

vi.mock("@/lib/db/client", () => ({ db: { insert: mocks.insert } }));
vi.mock("@/lib/db/schema", () => ({ emailOutbox: { idempotencyKey: "idempotency_key" } }));

import { enqueueEmail } from "../outbox";

describe("email outbox delivery scope", () => {
  beforeEach(() => vi.clearAllMocks());

  it("derives an immutable account scope from the account identity", async () => {
    await enqueueEmail({
      to: "learner@example.com",
      template: "verify-email",
      variables: {},
      userId: "learner-1",
      idempotencySeed: "verify-1",
    });

    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({
      userId: "learner-1",
      deliveryScopeKey: "a:learner-1",
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    }));
  });

  it("derives an operation scope for a registered accountless producer", async () => {
    await enqueueEmail({
      to: "candidate@example.com",
      template: "access-rejected",
      variables: { name: "Candidate" },
      systemProducer: "access-request-rejected",
      idempotencySeed: "request-1",
    } as never);

    const value = mocks.values.mock.calls.at(-1)?.[0] as {
      operationId: string;
      deliveryScopeKey: string;
      userId: string | null;
    };
    expect(value.userId).toBeNull();
    expect(value.deliveryScopeKey).toBe(`s:${value.operationId}`);
  });

  it("rejects a forged producer/template pair before insertion", async () => {
    await expect(enqueueEmail({
      to: "candidate@example.com",
      template: "reset-password",
      variables: {},
      systemProducer: "access-request-rejected",
      idempotencySeed: "request-2",
    } as never)).rejects.toThrow("System email producer/template pair is not allowed");
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
