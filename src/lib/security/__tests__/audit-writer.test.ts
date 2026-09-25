import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ db: { transaction: mocks.transaction } }));

import { writeAuditEvent, writeAuditEventInTransaction } from "../audit-writer";

function fakeTransaction(latestRow: { eventHash: string; occurredAt: Date } | undefined) {
  const insertedValues: unknown[] = [];
  const executeCalls: unknown[] = [];
  const tx = {
    execute: vi.fn((...args: unknown[]) => {
      executeCalls.push(args);
      return Promise.resolve(undefined);
    }),
    select: () => ({
      from: () => ({
        orderBy: () => ({
          limit: () => Promise.resolve(latestRow ? [latestRow] : []),
        }),
      }),
    }),
    insert: () => ({
      values: (values: unknown) => {
        insertedValues.push(values);
        return Promise.resolve(undefined);
      },
    }),
  };
  return { tx, insertedValues, executeCalls };
}

describe("writeAuditEventInTransaction", () => {
  it("chains onto the genesis hash and stores a null previousHash for the first event", async () => {
    const { tx, insertedValues } = fakeTransaction(undefined);

    const result = await writeAuditEventInTransaction(tx as never, {
      action: "curriculum.owner_review.mark",
      resourceType: "curriculum_artifact_key",
      resourceId: "lesson.python.variables.v1",
      actorUserId: "admin-1",
      outcome: "success",
    });

    expect(result.eventHash).toMatch(/^[a-f0-9]{64}$/);
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]).toMatchObject({
      actorUserId: "admin-1",
      action: "curriculum.owner_review.mark",
      resourceType: "curriculum_artifact_key",
      resourceId: "lesson.python.variables.v1",
      outcome: "success",
      previousHash: undefined,
      correlationId: result.correlationId,
      eventHash: result.eventHash,
    });
  });

  it("chains onto the prior event's hash and advances the occurred-at clock past it", async () => {
    const previousOccurredAt = new Date("2026-07-12T00:00:00.000Z");
    const { tx, insertedValues } = fakeTransaction({
      eventHash: "a".repeat(64),
      occurredAt: previousOccurredAt,
    });

    const result = await writeAuditEventInTransaction(tx as never, {
      action: "curriculum.owner_review.unmark",
      resourceType: "curriculum_artifact_key",
      resourceId: "lesson.python.variables.v1",
      outcome: "success",
    });

    const inserted = insertedValues[0] as { previousHash: string; occurredAt: Date };
    expect(inserted.previousHash).toBe("a".repeat(64));
    expect(inserted.occurredAt.getTime()).toBeGreaterThan(previousOccurredAt.getTime());
    expect(result.eventHash).not.toBe("a".repeat(64));
  });

  it("preserves a caller-supplied correlation id instead of generating one", async () => {
    const { tx, insertedValues } = fakeTransaction(undefined);
    const correlationId = "11111111-1111-4111-8111-111111111111";

    const result = await writeAuditEventInTransaction(tx as never, {
      action: "curriculum.owner_review.mark",
      resourceType: "curriculum_artifact_key",
      resourceId: "lesson.python.variables.v1",
      outcome: "success",
      correlationId,
    });

    expect(result.correlationId).toBe(correlationId);
    expect((insertedValues[0] as { correlationId: string }).correlationId).toBe(correlationId);
  });

  it("rejects secret-shaped metadata before it reaches the hash chain or the insert", async () => {
    const { tx, insertedValues } = fakeTransaction(undefined);

    await expect(writeAuditEventInTransaction(tx as never, {
      action: "curriculum.owner_review.mark",
      resourceType: "curriculum_artifact_key",
      resourceId: "lesson.python.variables.v1",
      outcome: "success",
      metadata: { apiKey: "value" },
    })).rejects.toThrow(/secret-like/i);
    expect(insertedValues).toHaveLength(0);
  });
});

describe("writeAuditEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens a database transaction and delegates to writeAuditEventInTransaction", async () => {
    const { tx, insertedValues } = fakeTransaction(undefined);
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work(tx));

    const result = await writeAuditEvent({
      action: "curriculum.owner_review.mark",
      resourceType: "curriculum_artifact_key",
      resourceId: "lesson.python.variables.v1",
      outcome: "success",
    });

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(insertedValues).toHaveLength(1);
    expect(result.eventHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
