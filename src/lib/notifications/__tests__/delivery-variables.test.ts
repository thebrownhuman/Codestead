import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ materialize: vi.fn() }));

vi.mock("@/lib/security/lost-device-recovery", () => ({
  materializeLostDeviceProofDelivery: mocks.materialize,
}));

import {
  materializeDeliveryVariables,
  materializeDeliveryWithAuthorityEvidence,
} from "../delivery-variables";

const APPLICATION_URL = "https://learn.test";

describe("delivery-only email variables", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes ordinary template variables through unchanged", async () => {
    const variables = { name: "Learner", url: "https://example.test/settings" };
    const result = await materializeDeliveryWithAuthorityEvidence({
      applicationUrl: APPLICATION_URL,
      template: "new-device",
      variables,
    });
    expect(result).toEqual({ authorityEvidence: null, variables });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.variables)).toBe(true);
    expect(mocks.materialize).not.toHaveBeenCalled();
  });

  it("keeps the shipped worker on a variables-only adapter until central integration", async () => {
    const variables = { name: "Learner", url: "https://example.test/settings" };
    await expect(materializeDeliveryVariables({
      template: "new-device",
      variables,
    })).resolves.toEqual(variables);
  });

  it("rejects malformed recovery references before deriving a bearer", async () => {
    await expect(materializeDeliveryWithAuthorityEvidence({
      applicationUrl: APPLICATION_URL,
      template: "lost-device-proof",
      variables: { name: "Learner", recoveryRequestId: "not-a-uuid" },
    })).resolves.toBeNull();
    expect(mocks.materialize).not.toHaveBeenCalled();
  });

  it.each([
    ["missing name", { recoveryRequestId: "10000000-0000-4000-8000-000000000001" }],
    ["extra bearer", {
      name: "Learner",
      recoveryRequestId: "10000000-0000-4000-8000-000000000001",
      proof: "must-not-be-accepted",
    }],
    ["control text", {
      name: "Learner\nprivate",
      recoveryRequestId: "10000000-0000-4000-8000-000000000001",
    }],
  ])("fails closed for %s persisted proof variables", async (_label, variables) => {
    await expect(materializeDeliveryWithAuthorityEvidence({
      applicationUrl: APPLICATION_URL,
      template: "lost-device-proof",
      variables,
    })).resolves.toBeNull();
    expect(mocks.materialize).not.toHaveBeenCalled();
  });

  it("materializes a valid proof only in worker memory", async () => {
    const now = new Date("2026-07-12T12:00:00.000Z");
    const requestId = "10000000-0000-4000-8000-000000000001";
    const delivery = Object.freeze({
      authorityEvidence: Object.freeze({
        kind: "lost-device-proof", sourceId: requestId, proofHash: "a".repeat(64),
      }),
      variables: Object.freeze({
        name: "Learner",
        url: "https://learn.test/lost-device#proof=ephemeral",
      }),
    });
    mocks.materialize.mockResolvedValue(delivery);
    const result = await materializeDeliveryWithAuthorityEvidence({
      applicationUrl: APPLICATION_URL,
      template: "lost-device-proof",
      variables: { name: "Learner", recoveryRequestId: requestId },
      now,
    });
    expect(result).toBe(delivery);
    expect(Object.isFrozen(result?.authorityEvidence)).toBe(true);
    expect(mocks.materialize).toHaveBeenCalledWith({
      applicationUrl: APPLICATION_URL,
      requestId,
      name: "Learner",
      now,
    });
  });

  it("uses the captured application URL instead of mutable process environment", async () => {
    const requestId = "10000000-0000-4000-8000-000000000001";
    const delivery = Object.freeze({
      authorityEvidence: Object.freeze({
        kind: "lost-device-proof",
        sourceId: requestId,
        proofHash: "a".repeat(64),
      }),
      variables: Object.freeze({
        name: "Learner",
        url: "https://learn.test/lost-device#proof=ephemeral",
      }),
    });
    mocks.materialize.mockResolvedValue(delivery);
    vi.stubEnv("APP_URL", "not-an-origin");
    try {
      await expect(materializeDeliveryWithAuthorityEvidence({
        applicationUrl: "https://learn.test",
        template: "lost-device-proof",
        variables: { name: "Learner", recoveryRequestId: requestId },
      })).resolves.toBe(delivery);
      expect(mocks.materialize).toHaveBeenCalledWith({
        applicationUrl: "https://learn.test",
        requestId,
        name: "Learner",
        now: undefined,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
