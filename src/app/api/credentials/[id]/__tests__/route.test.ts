import { NextRequest, NextResponse } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  const selectWhere = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));
  const updateWhere = vi.fn();
  const set = vi.fn<(patch: Record<string, unknown>) => { where: typeof updateWhere }>(
    () => ({ where: updateWhere }),
  );
  const update = vi.fn(() => ({ set }));
  const returning = vi.fn();
  const deleteWhere = vi.fn(() => ({ returning }));
  const deleteCredential = vi.fn(() => ({ where: deleteWhere }));
  const execute = vi.fn();
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({ update, execute }));
  return {
    limit, selectWhere, from, select, updateWhere, set, update,
    returning, deleteWhere, deleteCredential, transaction, execute,
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
  updatedAtToken: "2026-09-30T00:00:00.000000Z",
  lastFour: "tial",
};
const requestId = "10000000-0000-4000-8000-000000000001";

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
    mocks.set.mockReset().mockImplementation(() => ({ where: mocks.updateWhere }));
    process.env.CREDENTIAL_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    mocks.requireAuth.mockResolvedValue(auth);
    mocks.requireRecentMfa.mockResolvedValue({ allowed: true });
    mocks.withRateLimit.mockImplementation(async (_config, callback) => callback());
    mocks.limit.mockReset().mockResolvedValue([owned]);
    mocks.updateWhere.mockReset().mockReturnValue({ returning: mocks.returning });
    mocks.returning.mockReset().mockResolvedValue([{ id: owned.id, provider: owned.provider, updatedAtToken: "2026-09-30T00:00:00.000001Z" }]);
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

  it.each([
    ["test", "disable"],
    ["test", "replace"],
    ["replace", "disable"],
    ["replace", "replace"],
  ] as const)("rejects delayed %s after a completed %s", async (earlier, newer) => {
    const row = { ...owned, status: "active", ciphertext: owned.ciphertext };
    mocks.limit.mockImplementation(async () => [{ ...row }]);
    mocks.set.mockImplementation((patch: Record<string, unknown>) => ({
      where: vi.fn((condition: SQL) => {
        const query = new PgDialect().sqlToQuery(condition);
        const version = /"key_version" = \$(\d+)/.exec(query.sql);
        const revision = /\)\s*= \$(\d+)/.exec(query.sql);
        const matches = (!version || query.params[Number(version[1]) - 1] === row.keyVersion)
          && (!revision || query.params[Number(revision[1]) - 1] === row.updatedAtToken);
        if (matches) {
          Object.assign(row, patch);
          row.updatedAtToken = `${row.updatedAtToken}:changed`;
        }
        const result = matches ? [{ id: row.id }] : [];
        return Object.assign(Promise.resolve(result), { returning: async () => result });
      }),
    }));
    let release!: (value: { status: "active"; failureCode: null; model: string }) => void;
    let started!: () => void;
    const validationStarted = new Promise<void>((resolve) => { started = resolve; });
    mocks.validateProviderCredential.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => { release = resolve; });
    });
    const pending = PATCH(request({ action: earlier, secret: "earlier-secret", requestId }), context);
    await validationStarted;
    const completed = await PATCH(request({ action: newer, secret: "newer-secret", requestId }), context);
    expect(completed.status).toBe(200);
    const newerState = { ...row };
    const notifications = mocks.notifyCredentialChanged.mock.calls.length;
    release({ status: "active", failureCode: null, model: "test/model" });
    const stale = await pending;
    expect(row).toEqual(newerState);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "STALE_CREDENTIAL" });
    expect(mocks.notifyCredentialChanged).toHaveBeenCalledTimes(notifications);
  });

  it("rejects stale MFA before looking up a credential", async () => {
    mocks.requireRecentMfa.mockResolvedValueOnce({
      allowed: false,
      response: NextResponse.json({ code: "FRESH_MFA_REQUIRED" }, { status: 403 }),
    });
    const response = await PATCH(request({ action: "disable", requestId }), context);
    expect(response.status).toBe(403);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("tests only the authenticated learner's encrypted credential", async () => {
    const response = await PATCH(request({ action: "test", requestId }), context);
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

  it("validates an existing pending key without replacing its envelope", async () => {
    mocks.limit.mockResolvedValueOnce([{ ...owned, status: "pending_validation" }]);
    const response = await PATCH(request({ action: "test", requestId }), context);
    expect(response.status).toBe(200);
    expect(mocks.validateProviderCredential).toHaveBeenCalledTimes(1);
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({ status: "active", failureCode: null }));
    expect(mocks.sealCredential).not.toHaveBeenCalled();
  });

  it("leaves a legacy pending key retryable if validation ledger persistence fails", async () => {
    mocks.limit.mockResolvedValueOnce([{ ...owned, status: "pending_validation" }]);
    mocks.validateProviderCredential.mockRejectedValueOnce(new Error("synthetic ledger failure"));
    await expect(PATCH(request({ action: "test", requestId }), context)).rejects.toThrow("synthetic ledger failure");
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({ status: "unreachable", failureCode: "VALIDATION_INCOMPLETE" }));
    expect(mocks.sealCredential).not.toHaveBeenCalled();
  });

  it("clears preference across providers when preferring an existing key", async () => {
    const response = await PATCH(request({ action: "prefer", requestId }), context);
    expect(response.status).toBe(200);
    const query = new PgDialect().sqlToQuery(mocks.updateWhere.mock.calls[0][0]);
    expect(query.sql).toContain('"user_id"');
    expect(query.sql).not.toContain('"provider"');
  });

  it("rejects a stale preference mutation without committing its audit or notice", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    const response = await PATCH(request({ action: "prefer", requestId }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "STALE_CREDENTIAL" });
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
    expect(mocks.notifyCredentialChanged).not.toHaveBeenCalled();
  });

  it("validates an enabled key instead of leaving it pending", async () => {
    const response = await PATCH(request({ action: "enable", requestId }), context);
    expect(response.status).toBe(200);
    expect(mocks.openCredential).toHaveBeenCalledTimes(1);
    expect(mocks.validateProviderCredential).toHaveBeenCalledTimes(1);
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({ status: "active", disabledAt: null }));
    expect(mocks.set.mock.calls.some(([patch]) => patch.status === "pending_validation")).toBe(false);
    expect(await response.json()).toEqual({ ok: true, status: "active" });
  });

  it("persists an unreachable enabled key with its safe failure reason", async () => {
    mocks.validateProviderCredential.mockResolvedValueOnce({ status: "unreachable", failureCode: "TIMEOUT", model: "test/model" });
    const response = await PATCH(request({ action: "enable", requestId }), context);
    expect(response.status).toBe(200);
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({ status: "unreachable", failureCode: "TIMEOUT", disabledAt: null }));
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failure" }));
  });

  it("blocks provider use after consent withdrawal while preserving disable/delete controls", async () => {
    mocks.hasCurrentConsent.mockResolvedValue(false);
    const response = await PATCH(request({ action: "test", requestId }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "PROVIDER_CONSENT_REQUIRED" });
    expect(mocks.openCredential).not.toHaveBeenCalled();
    expect(mocks.validateProviderCredential).not.toHaveBeenCalled();

    const disable = await PATCH(request({ action: "disable", requestId }), context);
    expect(disable.status).toBe(200);
  });

  it("replaces ciphertext with a version-bound envelope and never persists plaintext", async () => {
    const replacement = "synthetic-replacement";
    const response = await PATCH(request({ action: "replace", secret: replacement, requestId }), context);
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
    const persisted = JSON.stringify(mocks.set.mock.calls, (_key, value) =>
      value instanceof SQL ? new PgDialect().sqlToQuery(value) : value);
    expect(persisted).toContain("new-ciphertext");
    expect(persisted).not.toContain(replacement);
    expect(mocks.notifyCredentialChanged).toHaveBeenCalledWith(
      expect.objectContaining({ action: "replace", provider: "nvidia_nim" }),
    );
  });

  it("does not reveal whether a fresh-MFA caller owns another user's id", async () => {
    mocks.limit.mockReset().mockResolvedValueOnce([]);
    const response = await PATCH(request({ action: "test", requestId }), context);
    expect(response.status).toBe(404);
    expect(mocks.openCredential).not.toHaveBeenCalled();
    expect(mocks.validateProviderCredential).not.toHaveBeenCalled();
  });

  it("answers 404 for a malformed credential id before MFA or any uuid query", async () => {
    const malformed = { params: Promise.resolve({ id: "not-a-uuid" }) };
    const patched = await PATCH(request({ action: "test", requestId }), malformed);
    const deleted = await DELETE(
      new NextRequest("https://learn.test/api/credentials/not-a-uuid", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId }),
      }),
      malformed,
    );
    expect(patched.status).toBe(404);
    expect(deleted.status).toBe(404);
    expect(mocks.requireRecentMfa).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("gates deletion with MFA and binds the delete to the authenticated learner", async () => {
    const response = await DELETE(
      new NextRequest("https://learn.test/api/credentials/credential-1", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId }),
      }),
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
