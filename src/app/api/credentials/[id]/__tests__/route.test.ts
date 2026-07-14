import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  const selectWhere = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));
  const updateWhere = vi.fn();
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));
  const returning = vi.fn();
  const deleteWhere = vi.fn(() => ({ returning }));
  const deleteCredential = vi.fn(() => ({ where: deleteWhere }));
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({ update }));
  return {
    limit, selectWhere, from, select, updateWhere, set, update,
    returning, deleteWhere, deleteCredential, transaction,
    requireAuth: vi.fn(), requireRecentMfa: vi.fn(), withRateLimit: vi.fn(),
    validateProviderCredential: vi.fn(), openCredential: vi.fn(),
    parseMasterKey: vi.fn(), sealCredential: vi.fn(), writeAuditEvent: vi.fn(),
    notifyCredentialChanged: vi.fn(),
    hasCurrentConsent: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({
  db: {
    select: mocks.select,
    update: mocks.update,
    delete: mocks.deleteCredential,
    transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/security/recent-mfa", () => ({ requireRecentMfa: mocks.requireRecentMfa }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));
vi.mock("@/lib/ai/credential-validation", () => ({
  validateProviderCredential: mocks.validateProviderCredential,
}));
vi.mock("@/lib/security/credential-vault", () => ({
  openCredential: mocks.openCredential,
  parseMasterKey: mocks.parseMasterKey,
  sealCredential: mocks.sealCredential,
}));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));
vi.mock("@/lib/credential-notifications", () => ({
  notifyCredentialChanged: mocks.notifyCredentialChanged,
}));
vi.mock("@/lib/privacy/consent", () => ({
  consentPurposeForProvider: (provider: string) => `provider:${provider}`,
  hasCurrentConsent: mocks.hasCurrentConsent,
}));

import { DELETE, PATCH } from "../route";

const auth = {
  session: {
    user: { id: "learner-1", email: "learner@example.test", name: "Learner" },
    session: { id: "session-1" },
  },
  account: { role: "learner" },
  response: null,
};

const owned = {
  id: "00000000-0000-4000-8000-000000000001",
  userId: "learner-1",
  provider: "nvidia_nim",
  ciphertext: "ciphertext",
  wrappedDataKey: "wrapped",
  wrapIv: "wrap-iv",
  dataIv: "data-iv",
  authTag: "auth-tag",
  keyVersion: 2,
  lastFour: "tial",
};

function request(body: unknown) {
  return new NextRequest("https://learn.test/api/credentials/credential-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ id: owned.id }) };

describe("credential mutation API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CREDENTIAL_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    mocks.requireAuth.mockResolvedValue(auth);
    mocks.requireRecentMfa.mockResolvedValue({ allowed: true });
    mocks.withRateLimit.mockImplementation(async (_config, callback) => callback());
    mocks.limit.mockReset().mockResolvedValue([owned]);
    mocks.returning.mockReset().mockResolvedValue([{ id: owned.id, provider: owned.provider }]);
    mocks.parseMasterKey.mockReturnValue(Buffer.alloc(32, 7));
    mocks.openCredential.mockReturnValue("synthetic-current-secret");
    mocks.sealCredential.mockReturnValue({
      ciphertext: "new-ciphertext",
      wrappedDataKey: "new-wrapped",
      wrapIv: "new-wrap-iv",
      dataIv: "new-data-iv",
      authTag: "new-auth-tag",
      keyVersion: 3,
      lastFour: "ment",
    });
    mocks.validateProviderCredential.mockResolvedValue({
      status: "active",
      failureCode: null,
      model: "test/model",
    });
    mocks.writeAuditEvent.mockResolvedValue({ correlationId: "c", eventHash: "h" });
    mocks.notifyCredentialChanged.mockResolvedValue(undefined);
    mocks.hasCurrentConsent.mockResolvedValue(true);
  });

  it("rejects stale MFA before looking up a credential", async () => {
    mocks.requireRecentMfa.mockResolvedValueOnce({
      allowed: false,
      response: NextResponse.json({ code: "FRESH_MFA_REQUIRED" }, { status: 403 }),
    });
    const response = await PATCH(request({ action: "disable" }), context);
    expect(response.status).toBe(403);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("tests only the authenticated learner's encrypted credential", async () => {
    const response = await PATCH(request({ action: "test" }), context);
    expect(response.status).toBe(200);
    expect(mocks.openCredential).toHaveBeenCalledWith(
      owned,
      expect.objectContaining({ userId: "learner-1", credentialId: owned.id, keyVersion: 2 }),
      expect.any(Buffer),
    );
    expect(mocks.validateProviderCredential).toHaveBeenCalledWith({
      userId: "learner-1",
      credentialId: owned.id,
      provider: "nvidia_nim",
      secret: "synthetic-current-secret",
    });
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }));
    await expect(response.json()).resolves.toEqual({ ok: true, status: "active" });
  });

  it("blocks provider use after consent withdrawal while preserving disable/delete controls", async () => {
    mocks.hasCurrentConsent.mockResolvedValue(false);
    const response = await PATCH(request({ action: "test" }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "PROVIDER_CONSENT_REQUIRED" });
    expect(mocks.openCredential).not.toHaveBeenCalled();
    expect(mocks.validateProviderCredential).not.toHaveBeenCalled();

    const disable = await PATCH(request({ action: "disable" }), context);
    expect(disable.status).toBe(200);
  });

  it("replaces ciphertext with a version-bound envelope and never persists plaintext", async () => {
    const replacement = "synthetic-replacement";
    const response = await PATCH(request({ action: "replace", secret: replacement }), context);
    expect(response.status).toBe(200);
    expect(mocks.sealCredential).toHaveBeenCalledWith(
      replacement,
      expect.objectContaining({
        userId: "learner-1",
        credentialId: owned.id,
        keyVersion: 3,
      }),
      expect.any(Buffer),
    );
    const persisted = JSON.stringify(mocks.set.mock.calls);
    expect(persisted).toContain("new-ciphertext");
    expect(persisted).not.toContain(replacement);
    expect(mocks.notifyCredentialChanged).toHaveBeenCalledWith(
      expect.objectContaining({ action: "replace", provider: "nvidia_nim" }),
    );
  });

  it("does not reveal whether a fresh-MFA caller owns another user's id", async () => {
    mocks.limit.mockReset().mockResolvedValueOnce([]);
    const response = await PATCH(request({ action: "test" }), context);
    expect(response.status).toBe(404);
    expect(mocks.openCredential).not.toHaveBeenCalled();
    expect(mocks.validateProviderCredential).not.toHaveBeenCalled();
  });

  it("gates deletion with MFA and binds the delete to the authenticated learner", async () => {
    const response = await DELETE(
      new NextRequest("https://learn.test/api/credentials/credential-1", { method: "DELETE" }),
      context,
    );
    expect(response.status).toBe(204);
    expect(mocks.requireRecentMfa).toHaveBeenCalledWith(expect.objectContaining({
      userId: "learner-1",
      action: "credential.delete",
      resourceId: owned.id,
    }));
    expect(mocks.deleteCredential).toHaveBeenCalled();
    expect(mocks.notifyCredentialChanged).toHaveBeenCalledWith(
      expect.objectContaining({ action: "delete" }),
    );
  });
});
