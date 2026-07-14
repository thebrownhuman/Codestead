import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  const selectWhere = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const updateWhere = vi.fn();
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const returning = vi.fn();
  const txWhere = vi.fn(() => ({ returning }));
  const txSet = vi.fn(() => ({ where: txWhere }));
  const txUpdate = vi.fn(() => ({ set: txSet }));
  const transaction = vi.fn();

  return {
    limit,
    selectWhere,
    from,
    select,
    updateWhere,
    updateSet,
    update,
    returning,
    txWhere,
    txSet,
    txUpdate,
    transaction,
    requireAuth: vi.fn(),
    withRateLimit: vi.fn(),
    writeAuditEvent: vi.fn(),
    verifyTOTP: vi.fn(),
    symmetricDecrypt: vi.fn(),
    verifyOtp: vi.fn(),
    headers: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({
  db: {
    select: mocks.select,
    update: mocks.update,
    transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));
vi.mock("@/lib/auth", () => ({
  auth: {
    $context: Promise.resolve({ secretConfig: "application-secret" }),
    api: { verifyTOTP: mocks.verifyTOTP },
  },
}));
vi.mock("@better-auth/utils/otp", () => ({
  createOTP: vi.fn(() => ({ verify: mocks.verifyOtp })),
}));
vi.mock("better-auth/crypto", () => ({ symmetricDecrypt: mocks.symmetricDecrypt }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));

import { POST } from "../route";

const authz = {
  session: {
    user: { id: "learner-1", email: "learner@example.test", name: "Learner" },
    session: { id: "session-1" },
  },
  account: { status: "pending", role: "learner", twoFactorEnabled: true },
  response: null,
};

function request(code: unknown) {
  return new NextRequest("https://learn.test/api/security/fresh-mfa", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

describe("fresh MFA verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue(authz);
    mocks.withRateLimit.mockImplementation(async (_config, callback) => callback());
    mocks.writeAuditEvent.mockResolvedValue({ correlationId: "correlation", eventHash: "hash" });
    mocks.headers.mockResolvedValue(new Headers());
    mocks.symmetricDecrypt.mockResolvedValue("totp-secret");
    mocks.verifyOtp.mockResolvedValue(true);
    mocks.verifyTOTP.mockResolvedValue({ status: true });
    mocks.updateWhere.mockResolvedValue(undefined);
    mocks.returning
      .mockResolvedValueOnce([{ id: "factor-1" }])
      .mockResolvedValueOnce([{ id: "session-1" }]);
    mocks.transaction.mockImplementation(async (callback) => callback({ update: mocks.txUpdate }));
  });

  it("verifies first-time enrollment without asking Better Auth to rotate the only session", async () => {
    mocks.limit.mockResolvedValueOnce([{
      id: "factor-1",
      secret: "encrypted-secret",
      verified: false,
    }]);

    const response = await POST(request("123456"));

    expect(response.status).toBe(200);
    expect(mocks.symmetricDecrypt).toHaveBeenCalledWith({
      key: "application-secret",
      data: "encrypted-secret",
    });
    expect(mocks.verifyOtp).toHaveBeenCalledWith("123456");
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.txUpdate).toHaveBeenCalledTimes(3);
    expect(mocks.verifyTOTP).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));
  });

  it("rejects an invalid first-time code without changing enrollment or session state", async () => {
    mocks.limit.mockResolvedValueOnce([{
      id: "factor-1",
      secret: "encrypted-secret",
      verified: false,
    }]);
    mocks.verifyOtp.mockResolvedValueOnce(false);

    const response = await POST(request("123456"));

    expect(response.status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.verifyTOTP).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
  });

  it("uses Better Auth for an already verified factor and stamps the current session", async () => {
    mocks.limit.mockResolvedValueOnce([{
      id: "factor-1",
      secret: "encrypted-secret",
      verified: true,
    }]);

    const response = await POST(request("654321"));

    expect(response.status).toBe(200);
    expect(mocks.verifyTOTP).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      body: { code: "654321" },
    });
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.updateWhere).toHaveBeenCalledOnce();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects malformed codes before touching the factor", async () => {
    const response = await POST(request("12 34"));

    expect(response.status).toBe(400);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.verifyTOTP).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
