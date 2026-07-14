import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const getSession = vi.fn();
  const headers = vi.fn(async () => new Headers({ cookie: "session=test" }));
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const eq = vi.fn((field, value) => ({ field, value }));
  const examGate = vi.fn();
  return { getSession, headers, limit, where, from, select, eq, examGate };
});

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("drizzle-orm", () => ({ eq: mocks.eq }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/db/schema", () => ({
  user: { id: "user.id", status: "user.status", role: "user.role", twoFactorEnabled: "user.twoFactorEnabled" },
}));
vi.mock("@/lib/exams/capability-gate", () => ({ gateClosedBookCapability: mocks.examGate }));

import { currentAuth, requireAdmin, requireAuth } from "../authz";

const SESSION = {
  session: { id: "session-1", userId: "learner-1", mfaVerifiedAt: new Date() },
  // Deliberately stale/elevated session claim: requireAdmin must ignore this
  // value and authorize from the freshly loaded durable account row.
  user: { id: "learner-1", name: "Learner", email: "learner@example.com", role: "admin" },
};

async function responseBody(response: Response) {
  return response.json() as Promise<{ error: string; code?: string }>;
}

function mustResponse(response: Response | null) {
  expect(response).not.toBeNull();
  return response!;
}

describe("protected request authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue(SESSION);
    mocks.limit.mockResolvedValue([{ status: "active", role: "learner", twoFactorEnabled: true }]);
    mocks.examGate.mockResolvedValue({ allowed: true });
  });

  it("loads the Better Auth session using request headers", async () => {
    await expect(currentAuth()).resolves.toEqual(SESSION);
    expect(mocks.getSession).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      query: { disableCookieCache: true, disableRefresh: false },
    });
  });

  it("returns 401 without touching account state when no session exists", async () => {
    mocks.getSession.mockResolvedValue(null);
    const result = await requireAuth();
    expect(result.session).toBeNull();
    const response = mustResponse(result.response);
    expect(response.status).toBe(401);
    expect(await responseBody(response)).toEqual({ error: "Authentication required." });
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("rechecks active status and MFA in the database on every protected request", async () => {
    const result = await requireAuth();
    expect(result.session).toEqual(SESSION);
    expect(result.account).toEqual({ status: "active", role: "learner", twoFactorEnabled: true });
    expect(result.response).toBeNull();
    expect(mocks.select).toHaveBeenCalledOnce();
    expect(mocks.eq).toHaveBeenCalledWith("user.id", "learner-1");
  });

  it.each([
    ["suspended", true, "ACCOUNT_NOT_ACTIVE"],
    ["deletion_pending", true, "ACCOUNT_NOT_ACTIVE"],
    ["deleted", true, "ACCOUNT_NOT_ACTIVE"],
    ["active", false, "MFA_REQUIRED"],
  ])("blocks status=%s mfa=%s", async (status, twoFactorEnabled, code) => {
    mocks.limit.mockResolvedValue([{ status, role: "learner", twoFactorEnabled }]);
    const result = await requireAuth();
    const response = mustResponse(result.response);
    expect(response.status).toBe(403);
    expect(await responseBody(response)).toMatchObject({ code });
  });

  it("blocks a stale cookie when the user row no longer exists", async () => {
    mocks.limit.mockResolvedValue([]);
    const result = await requireAuth();
    const response = mustResponse(result.response);
    expect(response.status).toBe(403);
    expect(await responseBody(response)).toMatchObject({ code: "ACCOUNT_NOT_ACTIVE" });
  });

  it("blocks a social/passwordless session until that exact session completes TOTP", async () => {
    mocks.getSession.mockResolvedValue({
      ...SESSION,
      session: { ...SESSION.session, mfaVerifiedAt: null },
    });
    const blocked = await requireAuth();
    const response = mustResponse(blocked.response);
    expect(response.status).toBe(403);
    expect(await responseBody(response)).toEqual({
      error: "Complete the authenticator challenge before using this feature.",
      code: "MFA_CHALLENGE_REQUIRED",
    });

    const challengeEndpoint = await requireAuth({ allowMfaChallenge: true });
    expect(challengeEndpoint.session).not.toBeNull();
    expect(challengeEndpoint.response).toBeNull();
  });

  it("allows pending status only for explicit activation/onboarding routes", async () => {
    mocks.limit.mockResolvedValue([{ status: "pending", role: "learner", twoFactorEnabled: false }]);
    const blocked = await requireAuth();
    expect(await responseBody(mustResponse(blocked.response))).toMatchObject({ code: "ACCOUNT_SETUP_REQUIRED" });

    const allowed = await requireAuth({ allowPending: true });
    expect(allowed.session).toEqual(SESSION);
    expect(allowed.response).toBeNull();
  });

  it("rejects a stale admin session claim and uses the fresh database role", async () => {
    const denied = await requireAdmin();
    const response = mustResponse(denied.response);
    expect(response.status).toBe(403);
    expect(await responseBody(response)).toEqual({ error: "Administrator access required." });
    expect(SESSION.user.role).toBe("admin");

    mocks.limit.mockResolvedValue([{ status: "active", role: "admin", twoFactorEnabled: true }]);
    const allowed = await requireAdmin();
    expect(allowed.session).toEqual(SESSION);
    expect(allowed.account?.role).toBe("admin");
  });

  it("fails closed with the server-authoritative exam capability decision", async () => {
    mocks.examGate.mockResolvedValueOnce({
      allowed: false,
      code: "EXAM_CLOSED_BOOK",
      status: 423,
      message: "Return to the exam workspace.",
    });
    const blocked = await requireAuth({ closedBookCapability: "learning_workspace" });
    const response = mustResponse(blocked.response);
    expect(response.status).toBe(423);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await responseBody(response)).toEqual({
      error: "Return to the exam workspace.",
      code: "EXAM_CLOSED_BOOK",
    });
    expect(mocks.examGate).toHaveBeenCalledWith("learner-1", "learning_workspace");
  });
});
