import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ materialize: vi.fn() }));

vi.mock("@/lib/security/lost-device-recovery", () => ({
  materializeLostDeviceProofVariables: mocks.materialize,
}));

import { materializeDeliveryVariables } from "../delivery-variables";

describe("delivery-only email variables", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes ordinary template variables through unchanged", async () => {
    const variables = { name: "Learner", url: "https://example.test/settings" };
    await expect(materializeDeliveryVariables({
      template: "new-device",
      variables,
    })).resolves.toBe(variables);
    expect(mocks.materialize).not.toHaveBeenCalled();
  });

  it("rejects malformed recovery references before deriving a bearer", async () => {
    await expect(materializeDeliveryVariables({
      template: "lost-device-proof",
      variables: { name: "Learner", recoveryRequestId: "not-a-uuid" },
    })).resolves.toBeNull();
    expect(mocks.materialize).not.toHaveBeenCalled();
  });

  it("materializes a valid proof only in worker memory", async () => {
    const now = new Date("2026-07-12T12:00:00.000Z");
    const requestId = "10000000-0000-4000-8000-000000000001";
    mocks.materialize.mockResolvedValue({
      name: "Learner",
      url: "https://learn.test/lost-device#proof=ephemeral",
    });
    await expect(materializeDeliveryVariables({
      template: "lost-device-proof",
      variables: { name: "Learner", recoveryRequestId: requestId },
      now,
    })).resolves.toEqual({
      name: "Learner",
      url: "https://learn.test/lost-device#proof=ephemeral",
    });
    expect(mocks.materialize).toHaveBeenCalledWith({
      requestId,
      name: "Learner",
      now,
    });
  });
});
