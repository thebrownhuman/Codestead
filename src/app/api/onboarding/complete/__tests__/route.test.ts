import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const updateWhere = vi.fn();
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));
  const transaction = vi.fn();
  return {
    limit,
    where,
    from,
    select,
    updateWhere,
    set,
    update,
    transaction,
    requireAuth: vi.fn(),
    withRateLimit: vi.fn(),
    getCurrentConsents: vi.fn(),
    initializePlans: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({
  db: { select: mocks.select, transaction: mocks.transaction },
}));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));
vi.mock("@/lib/learning-service/runtime", () => ({
  learningService: { initializePlans: mocks.initializePlans },
}));
vi.mock("@/lib/privacy/consent", () => ({
  REQUIRED_DISCLOSURE_PURPOSES: ["adult_18_plus"],
  getCurrentConsents: mocks.getCurrentConsents,
  isCurrentConsentAccepted: vi.fn(() => true),
}));

import { POST } from "../route";

const authz = {
  session: {
    user: { id: "learner-1", name: "Learner" },
    session: { id: "session-1" },
  },
  account: {
    status: "pending",
    role: "learner",
    twoFactorEnabled: true,
    mustChangePassword: false,
  },
  response: null,
};

function rows(factorVerified: boolean) {
  mocks.limit
    .mockResolvedValueOnce([{ selectedTracks: ["python"] }])
    .mockResolvedValueOnce([{ id: "credential-1" }])
    .mockResolvedValueOnce([{ verified: factorVerified }]);
}

describe("onboarding completion MFA gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue(authz);
    mocks.withRateLimit.mockImplementation(async (_config, callback) => callback());
    mocks.getCurrentConsents.mockResolvedValue(new Map());
    mocks.initializePlans.mockResolvedValue({
      state: "ready",
      plans: [
        { enrollmentId: "enrollment-1" },
        { enrollmentId: "enrollment-2" },
      ],
      missingPublications: [],
    });
    mocks.updateWhere.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation(async (callback) => callback({ update: mocks.update }));
  });

  it("refuses completion when only the user MFA flag is set", async () => {
    rows(false);

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.missing).toContain("mfa");
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.initializePlans).not.toHaveBeenCalled();
  });

  it("keeps a bootstrap account pending until the dedicated password flow clears the flag", async () => {
    rows(true);
    mocks.requireAuth.mockResolvedValueOnce({
      ...authz,
      account: { ...authz.account, mustChangePassword: true },
    });

    const response = await POST();

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ missing: ["password_change"] });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalledWith(expect.objectContaining({ mustChangePassword: false }));
  });

  it("activates the account and initializes selected-track plans after durable MFA", async () => {
    rows(true);

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      redirectTo: "/learn",
      planInitialization: {
        state: "ready",
        planCount: 2,
        missingPublications: [],
      },
    });
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.set).not.toHaveBeenCalledWith(expect.objectContaining({ mustChangePassword: false }));
    expect(mocks.initializePlans).toHaveBeenCalledWith(
      "learner-1",
      "onboarding-plans:learner-1",
    );
    expect(mocks.transaction.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.initializePlans.mock.invocationCallOrder[0]!,
    );
  });

  it("reports missing publications without undoing completed onboarding", async () => {
    rows(true);
    mocks.initializePlans.mockResolvedValueOnce({
      state: "degraded",
      plans: [{ enrollmentId: "enrollment-foundations" }],
      missingPublications: ["python"],
    });

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      redirectTo: "/learn",
      planInitialization: {
        state: "degraded",
        planCount: 1,
        missingPublications: ["python"],
      },
    });
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });

  it("keeps onboarding complete when plan initialization is temporarily unavailable", async () => {
    rows(true);
    mocks.initializePlans.mockRejectedValueOnce(new Error("database transport unavailable"));

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      redirectTo: "/learn",
      planInitialization: {
        state: "unavailable",
        planCount: 0,
        missingPublications: [],
      },
    });
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.set).not.toHaveBeenCalledWith(expect.objectContaining({ mustChangePassword: false }));
  });
});
