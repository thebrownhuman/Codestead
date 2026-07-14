import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const orderBy = vi.fn();
  const whereSelect = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where: whereSelect }));
  const select = vi.fn(() => ({ from }));
  const insertValues = vi.fn();
  const insert = vi.fn(() => ({ values: insertValues }));
  const updateWhere = vi.fn();
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));
  return {
    orderBy, whereSelect, from, select, insertValues, insert, updateWhere, set, update,
    requireAuth: vi.fn(), requireRecentMfa: vi.fn(), withRateLimit: vi.fn(),
    validateProviderCredential: vi.fn(), parseMasterKey: vi.fn(), sealCredential: vi.fn(),
    writeAuditEvent: vi.fn(), notifyCredentialChanged: vi.fn(),
    hasCurrentConsent: vi.fn(), getCurrentConsents: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({
  db: { select: mocks.select, insert: mocks.insert, update: mocks.update },
}));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/security/recent-mfa", () => ({ requireRecentMfa: mocks.requireRecentMfa }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));
vi.mock("@/lib/ai/credential-validation", () => ({
  validateProviderCredential: mocks.validateProviderCredential,
}));
vi.mock("@/lib/security/credential-vault", () => ({
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
  getCurrentConsents: mocks.getCurrentConsents,
  isCurrentConsentAccepted: () => true,
}));

import { GET, POST } from "../route";

const auth = {
  session: {
    user: { id: "learner-1", email: "learner@example.test", name: "Learner" },
    session: { id: "session-1" },
  },
  account: { role: "learner" },
  response: null,
};

const secret = "synthetic-provider-secret";
function request() {
  return new NextRequest("https://learn.test/api/credentials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "nvidia_nim",
      label: "Personal NIM",
      secret,
      preferred: false,
    }),
  });
}

describe("credential collection API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CREDENTIAL_MASTER_KEY = Buffer.alloc(32, 3).toString("base64");
    mocks.requireAuth.mockResolvedValue(auth);
    mocks.requireRecentMfa.mockResolvedValue({ allowed: true });
    mocks.withRateLimit.mockImplementation(async (_config, callback) => callback());
    mocks.parseMasterKey.mockReturnValue(Buffer.alloc(32, 3));
    mocks.sealCredential.mockReturnValue({
      ciphertext: "ciphertext",
      wrappedDataKey: "wrapped-data-key",
      wrapIv: "wrap-iv",
      dataIv: "data-iv",
      authTag: "auth-tag",
      keyVersion: 1,
      lastFour: "cret",
    });
    mocks.validateProviderCredential.mockResolvedValue({
      status: "active",
      failureCode: null,
      model: "test/model",
    });
    mocks.insertValues.mockResolvedValue(undefined);
    mocks.updateWhere.mockResolvedValue(undefined);
    mocks.writeAuditEvent.mockResolvedValue({ correlationId: "c", eventHash: "h" });
    mocks.notifyCredentialChanged.mockResolvedValue(undefined);
    mocks.hasCurrentConsent.mockResolvedValue(true);
    mocks.getCurrentConsents.mockResolvedValue(new Map());
  });

  it("denies add before reading or sealing the supplied key when MFA is stale", async () => {
    mocks.requireRecentMfa.mockResolvedValueOnce({
      allowed: false,
      response: NextResponse.json({ code: "FRESH_MFA_REQUIRED" }, { status: 403 }),
    });
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(mocks.sealCredential).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("fails closed when the wrapping key is not configured", async () => {
    delete process.env.CREDENTIAL_MASTER_KEY;
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(mocks.sealCredential).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("refuses to store a provider key before explicit provider consent", async () => {
    mocks.hasCurrentConsent.mockResolvedValueOnce(false);
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "PROVIDER_CONSENT_REQUIRED" });
    expect(mocks.sealCredential).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("persists only the envelope and returns only masked metadata", async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(mocks.sealCredential).toHaveBeenCalledWith(
      secret,
      expect.objectContaining({ userId: "learner-1", provider: "nvidia_nim", keyVersion: 1 }),
      expect.any(Buffer),
    );
    const persisted = JSON.stringify(mocks.insertValues.mock.calls);
    expect(persisted).toContain("ciphertext");
    expect(persisted).not.toContain(secret);
    expect(mocks.validateProviderCredential).toHaveBeenCalledWith(expect.objectContaining({
      userId: "learner-1",
      provider: "nvidia_nim",
      secret,
    }));
    const body = await response.json();
    expect(body).toMatchObject({
      credential: { provider: "nvidia_nim", label: "Personal NIM", lastFour: "cret", status: "active" },
    });
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(mocks.notifyCredentialChanged).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "learner-1", action: "add" }),
    );
  });

  it("records an invalid probe as failed without returning key material", async () => {
    mocks.validateProviderCredential.mockResolvedValueOnce({
      status: "invalid",
      failureCode: "AUTHENTICATION",
      model: "test/model",
    });
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failure",
      metadata: expect.objectContaining({ status: "invalid", lastFour: "cret" }),
    }));
    expect(JSON.stringify(await response.json())).not.toContain(secret);
  });

  it("lists only masked credential fields", async () => {
    mocks.orderBy.mockResolvedValueOnce([{
      id: "credential-1",
      provider: "nvidia_nim",
      label: "Personal NIM",
      lastFour: "cret",
      status: "active",
      isPreferred: true,
    }]);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.credentials[0]).toMatchObject({ lastFour: "cret", status: "active", routingConsented: true });
    expect(JSON.stringify(body)).not.toMatch(/ciphertext|wrappedDataKey|authTag|synthetic-provider-secret/);
  });
});
