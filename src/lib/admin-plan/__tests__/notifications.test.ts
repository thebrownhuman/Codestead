import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn((value: Record<string, unknown>) => {
    void value;
    return { onConflictDoNothing };
  });
  const insert = vi.fn(() => ({ values }));
  const tx = { select, insert };
  const transaction = vi.fn(async (callback: (executor: typeof tx) => unknown) => callback(tx));
  return { limit, select, values, insert, onConflictDoNothing, transaction, enqueueEmailInTransaction: vi.fn() };
});

vi.mock("@/lib/db/client", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("@/lib/notifications/outbox", () => ({
  enqueueEmailInTransaction: mocks.enqueueEmailInTransaction,
}));

import { notifyLearningPlanChanged } from "../notifications";

describe("learning-plan revision notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.limit.mockResolvedValue([{ email: "learner@example.com", name: "Leena" }]);
    mocks.onConflictDoNothing.mockResolvedValue(undefined);
    mocks.enqueueEmailInTransaction.mockResolvedValue(undefined);
  });

  it("queues bounded in-app and email notices without plan contents or evidence", async () => {
    await notifyLearningPlanChanged({
      learnerUserId: "learner-1",
      courseTitle: "Python",
      revision: 4,
      action: "updated",
      idempotencySeed: "revision-4",
    });

    expect(mocks.values).toHaveBeenCalledWith({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      userId: "learner-1",
      type: "learning-plan-changed",
      title: "Learning plan changed",
      body: "Python plan updated as revision 4. Mastery evidence and prerequisite gates were preserved.",
      actionUrl: "/roadmap",
    });
    expect(mocks.onConflictDoNothing).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.anything(),
    }));
    expect(mocks.enqueueEmailInTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      to: "learner@example.com",
      userId: "learner-1",
      template: "learning-plan-changed",
      idempotencySeed: "revision-4",
      variables: expect.objectContaining({ course: "Python", revision: "4", action: "updated" }),
    }));
    expect(JSON.stringify(mocks.values.mock.calls)).not.toMatch(/plan\s*:\s*\[|source.?code|answer|credential/i);
  });

  it("uses one stable notification identity per learner and idempotency seed", async () => {
    const base = {
      learnerUserId: "learner-1",
      courseTitle: "Python",
      revision: 4,
      action: "updated" as const,
    };
    await notifyLearningPlanChanged({ ...base, idempotencySeed: "revision-4" });
    await notifyLearningPlanChanged({ ...base, idempotencySeed: "revision-4" });
    await notifyLearningPlanChanged({ ...base, idempotencySeed: "revision-4-other-event" });

    const ids = mocks.values.mock.calls.map(([value]) => value.id);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(mocks.transaction).toHaveBeenCalledTimes(3);
  });

  it("fails the transaction when either durable delivery write fails", async () => {
    mocks.enqueueEmailInTransaction.mockRejectedValueOnce(new Error("outbox unavailable"));
    await expect(notifyLearningPlanChanged({
      learnerUserId: "learner-1",
      courseTitle: "Python",
      revision: 4,
      action: "updated",
      idempotencySeed: "revision-4",
    })).rejects.toThrow("outbox unavailable");
    expect(mocks.values).not.toHaveBeenCalled();

    mocks.onConflictDoNothing.mockRejectedValueOnce(new Error("notification unavailable"));
    await expect(notifyLearningPlanChanged({
      learnerUserId: "learner-1",
      courseTitle: "Python",
      revision: 4,
      action: "updated",
      idempotencySeed: "revision-4",
    })).rejects.toThrow("notification unavailable");
  });

  it("does not create an orphan notice when the bound learner no longer exists", async () => {
    mocks.limit.mockResolvedValueOnce([]);
    await notifyLearningPlanChanged({
      learnerUserId: "missing",
      courseTitle: "Python",
      revision: 4,
      action: "reverted",
      idempotencySeed: "revision-4",
    });
    expect(mocks.values).not.toHaveBeenCalled();
    expect(mocks.enqueueEmailInTransaction).not.toHaveBeenCalled();
  });
});
