import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  limit: vi.fn(),
  changePassword: vi.fn(),
  mfaRows: [] as unknown[],
  audit: vi.fn(),
  clearTrusted: vi.fn(),
  notice: vi.fn(),
  preserve: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: { api: { changePassword: mocks.changePassword } } }));
vi.mock("@/lib/db/client", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => mocks.mfaRows }) }) }) },
}));
vi.mock("../rate-limit", () => ({ withRateLimit: mocks.limit }));
vi.mock("../password-settings", () => ({ hasCredentialPassword: async () => true, preservePasswordChangeSession: mocks.preserve }));
vi.mock("../audit-writer", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("../password-security-events", () => ({ clearTrustedDevices: mocks.clearTrusted, recordPasswordChanged: mocks.notice }));

import { changeAccountPassword, PASSWORD_CHANGE_MFA_MS } from "../password-change";

const input = (twoFactorEnabled: boolean) => ({
  current: { user: { id: "user-1", twoFactorEnabled }, session: { id: "session-1" } } as never,
  headers: new Headers(),
  passwords: { currentPassword: "current-password", newPassword: "a-new-long-password" },
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.limit.mockImplementation(async (_check, run) => run());
  mocks.changePassword.mockResolvedValue(Response.json({ token: "replacement" }));
  mocks.mfaRows = [{ mfaVerifiedAt: new Date() }];
});

describe("L4: voluntary password change", () => {
  it("spends its own per-user budget, separate from the forced-change route", async () => {
    await changeAccountPassword(input(true));
    expect(mocks.limit).toHaveBeenCalledWith(
      { policy: "password_change_user", identity: { kind: "user", value: "user-1" } },
      expect.any(Function),
    );
  });

  it("refuses an MFA account whose durable session MFA is older than the step-up window", async () => {
    mocks.mfaRows = [{ mfaVerifiedAt: new Date(Date.now() - PASSWORD_CHANGE_MFA_MS - 1_000) }];
    const response = await changeAccountPassword(input(true));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FRESH_MFA_REQUIRED" });
    expect(mocks.changePassword).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied", metadata: { denialCode: "FRESH_MFA_REQUIRED" } }));
  });

  it("rotates after a fresh assertion, then clears trusted devices and sends the notice", async () => {
    const response = await changeAccountPassword(input(true));
    expect(response.status).toBe(200);
    expect(mocks.changePassword).toHaveBeenCalledTimes(1);
    expect(mocks.clearTrusted).toHaveBeenCalledWith("user-1");
    expect(mocks.notice).toHaveBeenCalledWith({ userId: "user-1", kind: "change", audit: false });
  });

  it("does not demand an authenticator from an account without MFA", async () => {
    mocks.mfaRows = [];
    expect((await changeAccountPassword(input(false))).status).toBe(200);
  });

  it("sends no notice when Better Auth refuses the current password", async () => {
    mocks.changePassword.mockResolvedValue(Response.json({ code: "INVALID_PASSWORD" }, { status: 400 }));
    expect((await changeAccountPassword(input(true))).status).toBe(400);
    expect(mocks.notice).not.toHaveBeenCalled();
    expect(mocks.clearTrusted).not.toHaveBeenCalled();
  });
});
