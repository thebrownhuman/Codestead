import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const betterAuthGet = vi.fn(async () => NextResponse.json({ reached: "get" }));
  const betterAuthPost = vi.fn(async () => NextResponse.json({
    reached: "post",
    totpURI: "otpauth://secret-that-must-not-leak",
  }));
  const getSession = vi.fn();
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const leftJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ leftJoin, where }));
  const select = vi.fn(() => ({ from }));
  const eq = vi.fn((field, value) => ({ field, value }));
  return {
    betterAuthGet,
    betterAuthPost,
    getSession,
    limit,
    where,
    leftJoin,
    from,
    select,
    eq,
  };
});

vi.mock("better-auth/next-js", () => ({
  toNextJsHandler: vi.fn(() => ({
    GET: mocks.betterAuthGet,
    POST: mocks.betterAuthPost,
  })),
}));
vi.mock("@/lib/auth", () => ({
  auth: { handler: vi.fn(), api: { getSession: mocks.getSession } },
}));
vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("drizzle-orm", () => ({ eq: mocks.eq }));
vi.mock("@/lib/db/schema", () => ({
  user: {
    id: "user.id",
    status: "user.status",
    twoFactorEnabled: "user.twoFactorEnabled",
  },
  twoFactor: {
    id: "twoFactor.id",
    userId: "twoFactor.userId",
    verified: "twoFactor.verified",
  },
}));

import { GET, POST } from "../route";

function durableAuthority(input: {
  status: string;
  twoFactorEnabled: boolean | null;
  factorId?: string | null;
  factorVerified?: boolean | null;
}) {
  mocks.getSession.mockResolvedValue({
    user: { id: "learner-1" },
    session: { id: "session-1" },
  });
  mocks.limit.mockResolvedValue([{
    status: input.status,
    twoFactorEnabled: input.twoFactorEnabled,
    factorId: input.factorId ?? null,
    factorVerified: input.factorVerified ?? null,
  }]);
}

function request(path: string, body: unknown = {}) {
  return new NextRequest(`https://learn.test/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "learncoding.session_token=opaque" },
    body: JSON.stringify(body),
  });
}

function getRequest(path: string) {
  return new NextRequest(`https://learn.test/api/auth${path}`, { method: "GET" });
}

async function expectGenericDenial(response: Response) {
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const serialized = JSON.stringify(await response.json());
  expect(serialized).toContain("unavailable");
  expect(serialized).not.toMatch(/otpauth|backup|secret|token/i);
}

describe("raw Better Auth security-management boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    durableAuthority({ status: "active", twoFactorEnabled: true });
  });

  it.each([
    "/change-password",
    "/set-password",
    "/link-social",
    "/two-factor/disable",
    "/two-factor/get-totp-uri",
    "/two-factor/generate-backup-codes",
    "/list-sessions",
    "/revoke-session",
    "/revoke-sessions",
    "/revoke-other-sessions",
    "/admin/list-users",
    "/sign-up/email",
    "/account-info",
    "/get-access-token",
    "/refresh-token",
    "/update-user",
  ])("default-denies raw authority route before Better Auth: %s", async (path) => {
    await expectGenericDenial(await POST(request(path)));
    expect(mocks.betterAuthPost).not.toHaveBeenCalled();
  });

  it("denies raw provider unlinking before Better Auth", async () => {
    await expectGenericDenial(await POST(request("/unlink-account", {
      providerId: "credential",
    })));
    expect(mocks.betterAuthPost).not.toHaveBeenCalled();
  });

  it("allows a pending account to begin initial enrollment after a durable recheck", async () => {
    durableAuthority({ status: "pending", twoFactorEnabled: false });
    const enrollmentRequest = request("/two-factor/enable");

    const response = await POST(enrollmentRequest);

    expect(response.status).toBe(200);
    expect(mocks.getSession).toHaveBeenCalledWith({
      headers: enrollmentRequest.headers,
      query: { disableCookieCache: true, disableRefresh: true },
    });
    expect(mocks.select).toHaveBeenCalledOnce();
    expect(mocks.betterAuthPost).toHaveBeenCalledOnce();
  });

  it("allows retrying only an unverified initial enrollment", async () => {
    durableAuthority({
      status: "pending",
      twoFactorEnabled: false,
      factorId: "factor-1",
      factorVerified: false,
    });

    const response = await POST(request("/two-factor/enable"));

    expect(response.status).toBe(200);
    expect(mocks.betterAuthPost).toHaveBeenCalledOnce();
  });

  it.each([
    ["active", false],
    ["suspended", false],
    ["deletion_pending", false],
    ["deleted", false],
    ["pending", true],
    ["pending", null],
  ])("denies enrollment for status=%s enabled=%s", async (status, twoFactorEnabled) => {
    durableAuthority({ status, twoFactorEnabled });

    await expectGenericDenial(await POST(request("/two-factor/enable")));
    expect(mocks.betterAuthPost).not.toHaveBeenCalled();
  });

  it("denies enrollment when a supposedly disabled account already has a verified factor", async () => {
    durableAuthority({
      status: "pending",
      twoFactorEnabled: false,
      factorId: "factor-1",
      factorVerified: true,
    });

    await expectGenericDenial(await POST(request("/two-factor/enable")));
    expect(mocks.betterAuthPost).not.toHaveBeenCalled();
  });

  it("denies anonymous enrollment without reaching Better Auth", async () => {
    mocks.getSession.mockResolvedValue(null);

    await expectGenericDenial(await POST(request("/two-factor/enable")));
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.betterAuthPost).not.toHaveBeenCalled();
  });

  it.each(["session", "account"])(
    "fails closed without leaking authority-read failures from the %s store",
    async (failurePoint) => {
      if (failurePoint === "session") {
        mocks.getSession.mockRejectedValue(new Error("session-store-canary"));
      } else {
        mocks.limit.mockRejectedValue(new Error("account-store-canary"));
      }

      await expectGenericDenial(await POST(request("/two-factor/enable")));
      expect(mocks.betterAuthPost).not.toHaveBeenCalled();
    },
  );

  it.each([
    "/two-factor/verify-totp",
    "/two-factor/verify-backup-code",
  ])("keeps knowledge-of-factor verification available: %s", async (path) => {
    const response = await POST(request(path, { code: "123456" }));

    expect(response.status).toBe(200);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.betterAuthPost).toHaveBeenCalledOnce();
  });

  it.each([
    "/get-session",
    "/verify-email?token=opaque",
    "/reset-password/one-token",
    "/callback/google?code=opaque&state=opaque",
    "/error?error=access_denied",
  ])("keeps only the required GET flow available: %s", async (path) => {
    const response = await GET(getRequest(path));
    expect(response.status).toBe(200);
    expect(mocks.betterAuthGet).toHaveBeenCalledOnce();
  });

  it.each([
    "/list-sessions",
    "/account-info",
    "/get-access-token",
    "/reset-password",
    "/reset-password/two/segments",
    "/callback/github",
    "/callback/google/extra",
    "/sign-in/email",
  ])("default-denies every unclassified or method-mismatched GET: %s", async (path) => {
    await expectGenericDenial(await GET(getRequest(path)));
    expect(mocks.betterAuthGet).not.toHaveBeenCalled();
  });

  it.each([
    "/sign-in/email",
    "/sign-out",
    "/request-password-reset",
    "/reset-password",
  ])("keeps the required ordinary POST flow available: %s", async (path) => {
    const response = await POST(request(path));
    expect(response.status).toBe(200);
    expect(mocks.betterAuthPost).toHaveBeenCalledOnce();
  });

  it("allows only Google through the generic social sign-in endpoint", async () => {
    expect((await POST(request("/sign-in/social", { provider: "google" }))).status).toBe(200);
    expect(mocks.betterAuthPost).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    await expectGenericDenial(await POST(request("/sign-in/social", { provider: "github" })));
    expect(mocks.betterAuthPost).not.toHaveBeenCalled();

    await expectGenericDenial(await POST(request("/sign-in/social", { provider: ["google"] })));
    expect(mocks.betterAuthPost).not.toHaveBeenCalled();
  });

  it.each([
    "/verify-email",
    "/callback/google",
    "/error",
    "/request-password-reset/extra",
    "/unknown",
  ])("default-denies every unclassified or method-mismatched POST: %s", async (path) => {
    await expectGenericDenial(await POST(request(path)));
    expect(mocks.betterAuthPost).not.toHaveBeenCalled();
  });
});
