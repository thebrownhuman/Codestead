import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = { existingAward: false, badgeMissing: false, userStatus: "active" };
  const achievementConflict = vi.fn();
  const awardReturning = vi.fn(async () => state.existingAward ? [] : [{ id: "award-1" }]);
  const awardConflict = vi.fn(() => ({ returning: awardReturning }));
  const values = vi.fn((value: Record<string, unknown>) => {
    if ("achievementId" in value) return { onConflictDoNothing: awardConflict };
    if (value.type === "mastery-awarded") return Promise.resolve();
    return { onConflictDoNothing: achievementConflict };
  });
  const insert = vi.fn(() => ({ values }));
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn((table: unknown) => {
    void table;
    return { where };
  });
  const select = vi.fn(() => ({ from }));
  const execute = vi.fn(async () => ({ rows: [] }));
  const tx = { execute, insert, select };
  return {
    state,
    values,
    limit,
    execute,
    transaction: vi.fn(async (callback: (executor: typeof tx) => unknown) => callback(tx)),
    enqueueEmailInTransaction: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("@/lib/notifications/outbox", () => ({
  enqueueEmailInTransaction: mocks.enqueueEmailInTransaction,
}));

import {
  awardExamModuleMastery,
  ExamMasteryAwardError,
  examModuleMasterySlug,
} from "../exam-mastery";

const input = {
  userId: "learner-1",
  attemptId: "f1000000-0000-4000-8000-000000000001",
  courseId: "python",
  courseTitle: "Python",
  moduleId: "python.control-flow",
  moduleTitle: "Control flow",
  scorePercent: 97,
  criticalRequirementsMet: true,
};

describe("deterministic exam mastery badges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.existingAward = false;
    mocks.state.badgeMissing = false;
    mocks.state.userStatus = "active";
    let lookup = 0;
    mocks.limit.mockImplementation(async () => {
      lookup += 1;
      if (lookup === 1) {
        return [{ status: mocks.state.userStatus, name: "Learner", email: "learner@example.test" }];
      }
      return mocks.state.badgeMissing ? [] : [{ id: "badge-1" }];
    });
    mocks.enqueueEmailInTransaction.mockResolvedValue(undefined);
  });

  it("uses a stable bounded slug tied to both course and module", () => {
    const slug = examModuleMasterySlug("Python", "control.flow");
    expect(slug).toMatch(/^mastery-python-control-flow-[0-9a-f]{12}$/);
    expect(slug).toBe(examModuleMasterySlug("Python", "control.flow"));
    expect(slug).not.toBe(examModuleMasterySlug("Java", "control.flow"));
    expect(examModuleMasterySlug("***", "...").length).toBeLessThan(100);
  });

  it.each([
    { scorePercent: 94.99, criticalRequirementsMet: true },
    { scorePercent: 100, criticalRequirementsMet: false },
    { scorePercent: Number.NaN, criticalRequirementsMet: true },
  ])("does not award when deterministic mastery gates are not met %#", async (override) => {
    await expect(awardExamModuleMastery({ ...input, ...override })).resolves.toEqual({
      awarded: false,
      reason: "MASTERY_THRESHOLD_NOT_MET",
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("creates one private evidence-bound award and queues learner notices", async () => {
    const result = await awardExamModuleMastery(input);
    expect(result).toMatchObject({ awarded: true, badgeAwardId: "award-1", emailQueued: true });
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({
      slug: expect.stringContaining("mastery-python-python-control-flow"),
      ruleVersion: "exam-mastery-v1",
    }));
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({
      userId: "learner-1",
      achievementId: "badge-1",
      evidenceId: `exam-attempt:${input.attemptId}`,
      visibility: "private",
    }));
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({ type: "mastery-awarded" }));
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.enqueueEmailInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        template: "mastery-awarded",
        idempotencySeed: `exam-mastery:${input.attemptId}`,
      }),
    );
  });

  it("replays without duplicate in-app or email notifications", async () => {
    mocks.state.existingAward = true;
    await expect(awardExamModuleMastery(input)).resolves.toEqual({
      awarded: false,
      reason: "ALREADY_AWARDED",
    });
    expect(mocks.enqueueEmailInTransaction).not.toHaveBeenCalled();
    expect(mocks.values).not.toHaveBeenCalledWith(expect.objectContaining({ type: "mastery-awarded" }));
  });

  it("keeps badge, notification, and email atomic when outbox insertion fails", async () => {
    mocks.enqueueEmailInTransaction.mockRejectedValueOnce(new Error("mail unavailable"));
    await expect(awardExamModuleMastery(input)).rejects.toThrow("mail unavailable");
  });

  it("fails closed after the authority lock when the learner is no longer active", async () => {
    mocks.state.userStatus = "deletion_pending";
    await expect(awardExamModuleMastery(input)).rejects.toEqual(
      new ExamMasteryAwardError("LEARNER_NOT_ACTIVE"),
    );
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.values).not.toHaveBeenCalled();
    expect(mocks.enqueueEmailInTransaction).not.toHaveBeenCalled();
  });

  it("fails if the deterministic badge definition cannot be resolved", async () => {
    mocks.state.badgeMissing = true;
    await expect(awardExamModuleMastery(input)).rejects.toThrow("could not be resolved");
  });
});
