import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consumeInvitationByToken: vi.fn(),
  findUsableInvitationByToken: vi.fn(),
  rateLimitIp: vi.fn(),
  signUpEmail: vi.fn(),
  withRateLimit: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { signUpEmail: mocks.signUpEmail } },
}));
vi.mock("@/lib/security/invitation-store", () => ({
  consumeInvitationByToken: mocks.consumeInvitationByToken,
  findUsableInvitationByToken: mocks.findUsableInvitationByToken,
}));
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimitIp: mocks.rateLimitIp,
  withRateLimit: mocks.withRateLimit,
}));

import { currentActivationAuthorization } from "@/lib/security/activation-context";
import { POST } from "../route";

const rawToken = "integration-shaped-token-that-is-not-real";
const invitation = {
  id: "30000000-0000-4000-8000-000000000099",
  email: " Learner@Example.TEST ",
  expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  consumedAt: null,
};
const consumedAt = new Date("2029-12-31T23:00:00.000Z");

function request(body: unknown) {
  return new NextRequest("https://learn.test/api/invitations/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validBody() {
  return {
    token: rawToken,
    name: "Invited Learner",
    password: "integration-only-password-123!",
  };
}

describe("invitation activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateLimitIp.mockReturnValue("trusted-ip-hash");
    mocks.withRateLimit.mockImplementation(
      async (_config, operation: () => Promise<Response>) => operation(),
    );
    mocks.findUsableInvitationByToken.mockResolvedValue(invitation);
    mocks.consumeInvitationByToken.mockResolvedValue({
      ...invitation,
      consumedAt,
    });
    mocks.signUpEmail.mockResolvedValue({ user: { id: "learner-1" } });
  });

  it("atomically consumes the invitation before signup and binds the exact claim to the auth hook", async () => {
    let signupAuthorization: ReturnType<typeof currentActivationAuthorization> = null;
    mocks.signUpEmail.mockImplementation(async () => {
      signupAuthorization = currentActivationAuthorization();
      return { user: { id: "learner-1" } };
    });

    const response = await POST(request(validBody()));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.consumeInvitationByToken).toHaveBeenCalledWith({
      rawToken,
      expectedEmail: invitation.email,
    });
    expect(mocks.consumeInvitationByToken.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.signUpEmail.mock.invocationCallOrder[0],
    );
    expect(signupAuthorization).toEqual({
      invitationId: invitation.id,
      email: "learner@example.test",
      consumedAt: consumedAt.toISOString(),
    });
    expect(currentActivationAuthorization()).toBeNull();
  });

  it("fails closed when another request wins the atomic consume race", async () => {
    mocks.consumeInvitationByToken.mockResolvedValueOnce(null);

    const response = await POST(request(validBody()));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "This invitation is invalid or expired." });
    expect(mocks.signUpEmail).not.toHaveBeenCalled();
  });

  it("keeps a claimed invitation consumed when signup fails", async () => {
    mocks.signUpEmail.mockRejectedValueOnce(new Error("signup failed after claim"));

    const response = await POST(request(validBody()));

    expect(response.status).toBe(409);
    expect(mocks.consumeInvitationByToken).toHaveBeenCalledOnce();
    expect(mocks.signUpEmail).toHaveBeenCalledOnce();
  });

  it("rejects malformed input before reading or consuming an invitation", async () => {
    const response = await POST(request({ token: "short", name: "x", password: "weak" }));

    expect(response.status).toBe(400);
    expect(mocks.findUsableInvitationByToken).not.toHaveBeenCalled();
    expect(mocks.consumeInvitationByToken).not.toHaveBeenCalled();
    expect(mocks.signUpEmail).not.toHaveBeenCalled();
  });
});
