import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  issue: vi.fn(),
  verify: vi.fn(),
  withRateLimit: vi.fn(),
}));

vi.mock("@/lib/security/lost-device-recovery", () => ({
  issueLostDeviceProof: mocks.issue,
  verifyLostDeviceProof: mocks.verify,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimitIp: () => "192.0.2.1",
  withRateLimit: mocks.withRateLimit,
}));

import { POST as requestProof } from "../request/route";
import { POST as verifyProof } from "../verify/route";

function post(path: string, body: unknown) {
  return new NextRequest(`https://learn.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("public lost-device recovery routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withRateLimit.mockImplementation(async (_check, handler) => handler());
  });

  it("returns the exact neutral response for eligible and unknown emails", async () => {
    mocks.issue
      .mockResolvedValueOnce({ requestId: crypto.randomUUID(), expiresAt: new Date() })
      .mockResolvedValueOnce(null);
    const eligible = await requestProof(
      post("/api/lost-device/request", { email: "learner@example.test" }),
    );
    const unknown = await requestProof(
      post("/api/lost-device/request", { email: "unknown@example.test" }),
    );
    expect(eligible.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(await eligible.text()).toBe(await unknown.text());
    expect(eligible.headers.get("cache-control")).toContain("no-store");
    expect(mocks.withRateLimit.mock.calls.map(([check]) => check.policy)).toEqual([
      "lost_device_request_ip",
      "lost_device_request_email",
      "lost_device_request_ip",
      "lost_device_request_email",
    ]);
  });

  it("keeps internal eligible-account failure byte-for-byte neutral without logging identity", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.issue
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("database unavailable for learner@example.test"));
    const unknown = await requestProof(
      post("/api/lost-device/request", { email: "unknown@example.test" }),
    );
    const failedEligible = await requestProof(
      post("/api/lost-device/request", { email: "learner@example.test" }),
    );
    expect(failedEligible.status).toBe(202);
    expect(failedEligible.status).toBe(unknown.status);
    expect(await failedEligible.text()).toBe(await unknown.text());
    expect([...failedEligible.headers]).toEqual([...unknown.headers]);
    expect(error).toHaveBeenCalledWith("lost_device_proof_issuance_failed");
    expect(JSON.stringify(error.mock.calls)).not.toContain("learner@example.test");
    error.mockRestore();
  });

  it("accepts one well-formed proof without reflecting or returning it", async () => {
    const proof = "p".repeat(43);
    mocks.verify.mockResolvedValue({
      requestId: crypto.randomUUID(),
      userId: "learner-1",
      sessionId: "session-1",
    });
    const response = await verifyProof(
      post("/api/lost-device/verify", {
        proof,
        reason: "The laptop was lost during travel.",
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.text()).not.toContain(proof);
    expect(mocks.verify).toHaveBeenCalledWith({
      rawProof: proof,
      reason: "The laptop was lost during travel.",
    });
    expect(mocks.withRateLimit.mock.calls.map(([check]) => check.policy)).toEqual([
      "lost_device_verify_ip",
      "lost_device_verify_proof",
    ]);
  });

  it("uses one generic failure for expired, replayed, or unowned proofs", async () => {
    mocks.verify.mockResolvedValue(null);
    const proof = "z".repeat(43);
    const response = await verifyProof(
      post("/api/lost-device/verify", {
        proof,
        reason: "The approved device is no longer available.",
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).not.toContain(proof);
    expect(body).toContain("invalid, expired, already used");
  });

  it("rejects malformed proofs before storage or verification code runs", async () => {
    const response = await verifyProof(
      post("/api/lost-device/verify", {
        proof: "short",
        reason: "The approved profile is unavailable.",
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.withRateLimit).toHaveBeenCalledTimes(1);
  });
});
