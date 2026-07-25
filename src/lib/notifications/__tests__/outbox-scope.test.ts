import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const returning = vi.fn(async () => [{ id: "queued-id" }]);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn((value: unknown) => {
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
      sourceId: "22222222-2222-4222-8222-222222222222",
      audienceId: "requester:22222222-2222-4222-8222-222222222222",
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
        _mailAudienceId:
          "requester:22222222-2222-4222-8222-222222222222",
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
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID durable system source before insertion", async () => {
    await expect(
      enqueueEmail({
        to: "candidate@example.com",
        template: "access-rejected",
        variables: {},
        systemProducer: "access-request-rejected",
        sourceId: "request-2",
        audienceId: "requester:request-2",
        idempotencySeed: "request-2",
      }),
    ).rejects.toThrow("System email source ID must be a UUID");
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
