import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const values = vi.fn();
  const insert = vi.fn(() => ({ values }));
  return { limit, where, from, select, values, insert, enqueueEmail: vi.fn() };
});

vi.mock("@/lib/db/client", () => ({
  db: { select: mocks.select, insert: mocks.insert },
}));
vi.mock("@/lib/notifications/outbox", () => ({ enqueueEmail: mocks.enqueueEmail }));

import { notifyCredentialChanged } from "../credential-notifications";

describe("credential security notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.limit.mockReset().mockResolvedValue([{ email: "learner@example.test", name: "Aarav" }]);
    mocks.values.mockResolvedValue(undefined);
    mocks.enqueueEmail.mockResolvedValue(undefined);
  });

  it("sends in-app and email notices without including key material", async () => {
    await notifyCredentialChanged({
      userId: "learner-1",
      provider: "nvidia_nim",
      action: "replace",
      idempotencySeed: "credential-1:replace:1",
    });

    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({
      userId: "learner-1",
      type: "credential-changed",
      body: "Your nvidia nim credential was replaced.",
    }));
    expect(mocks.enqueueEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "learner@example.test",
      template: "credential-changed",
      variables: expect.objectContaining({ provider: "nvidia nim", action: "replaced" }),
    }));
    const serialized = JSON.stringify([
      mocks.values.mock.calls,
      mocks.enqueueEmail.mock.calls,
    ]);
    expect(serialized).not.toMatch(/nvapi-|api[_-]?key|secret/i);
  });

  it("does not enqueue a notice for a missing owner", async () => {
    mocks.limit.mockReset().mockResolvedValue([]);
    await notifyCredentialChanged({
      userId: "deleted-user",
      provider: "openai",
      action: "delete",
      idempotencySeed: "credential-2:delete:1",
    });
    expect(mocks.values).not.toHaveBeenCalled();
    expect(mocks.enqueueEmail).not.toHaveBeenCalled();
  });
});
