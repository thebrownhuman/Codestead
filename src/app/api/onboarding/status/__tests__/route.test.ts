import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return {
    limit,
    where,
    from,
    select,
    requireAuth: vi.fn(),
    getCurrentConsents: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/privacy/consent", () => ({
  ENROLLMENT_DISCLOSURE_VERSION: "test-disclosure",
  REQUIRED_DISCLOSURE_PURPOSES: ["adult_18_plus"],
  getCurrentConsents: mocks.getCurrentConsents,
  isCurrentConsentAccepted: vi.fn(() => true),
}));

import { GET } from "../route";

function authz(mfaVerifiedAt: Date | string | null) {
  return {
    session: {
      user: { id: "learner-1", name: "Learner", timezone: "Asia/Kolkata" },
      session: { id: "session-1", mfaVerifiedAt },
    },
    account: { status: "pending", role: "learner", twoFactorEnabled: true },
    response: null,
  };
}

function rows(factorVerified: boolean) {
  mocks.limit
    .mockResolvedValueOnce([{ selectedTracks: ["python"] }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ verified: factorVerified }]);
}

describe("onboarding status MFA requirements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentConsents.mockResolvedValue(new Map());
  });

  it("does not trust the user flag when the durable authenticator factor is unverified", async () => {
    mocks.requireAuth.mockResolvedValue(authz(new Date()));
    rows(false);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.requirements).toMatchObject({ mfaEnabled: false, mfaFresh: false });
  });

  it("reports a verified factor with a recent assertion as fresh", async () => {
    mocks.requireAuth.mockResolvedValue(authz(new Date(Date.now() - 60_000).toISOString()));
    rows(true);

    const response = await GET();
    const body = await response.json();

    expect(body.requirements).toMatchObject({ mfaEnabled: true, mfaFresh: true });
  });

  it("keeps enrollment complete while requiring another code after five minutes", async () => {
    mocks.requireAuth.mockResolvedValue(authz(new Date(Date.now() - 6 * 60_000)));
    rows(true);

    const response = await GET();
    const body = await response.json();

    expect(body.requirements).toMatchObject({ mfaEnabled: true, mfaFresh: false });
  });
});
