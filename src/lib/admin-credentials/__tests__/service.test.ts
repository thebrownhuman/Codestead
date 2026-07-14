import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const dbLimit = vi.fn();
  const dbWhere = vi.fn(() => ({ limit: dbLimit }));
  const dbInnerJoin = vi.fn(() => ({ where: dbWhere }));
  const dbFrom = vi.fn(() => ({ where: dbWhere, innerJoin: dbInnerJoin }));
  const dbSelect = vi.fn(() => ({ from: dbFrom }));

  const txLimit = vi.fn();
  const txWhere = vi.fn(() => ({ limit: txLimit }));
  const txInnerJoin = vi.fn(() => ({ where: txWhere }));
  const txFrom = vi.fn(() => ({ where: txWhere, innerJoin: txInnerJoin }));
  const txSelect = vi.fn(() => ({ from: txFrom }));
  const txReturning = vi.fn();
  const txUpdateWhere = vi.fn(() => ({ returning: txReturning }));
  const txSet = vi.fn(() => ({ where: txUpdateWhere }));
  const txUpdate = vi.fn(() => ({ set: txSet }));
  const txDeleteReturning = vi.fn();
  const txDeleteWhere = vi.fn(() => ({ returning: txDeleteReturning }));
  const txDelete = vi.fn(() => ({ where: txDeleteWhere }));
  const notificationValues = vi.fn(async () => undefined);
  const outboxConflict = vi.fn(async () => undefined);
  const outboxValues = vi.fn(() => ({ onConflictDoNothing: outboxConflict }));
  const txInsert = vi.fn();
  const txExecute = vi.fn(async () => undefined);
  const tx = {
    execute: txExecute,
    select: txSelect,
    update: txUpdate,
    delete: txDelete,
    insert: txInsert,
  };
  const transaction = vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx));
  return {
    dbLimit,
    dbSelect,
    transaction,
    tx,
    txLimit,
    txReturning,
    txDeleteReturning,
    txSet,
    txInsert,
    notificationValues,
    outboxValues,
    outboxConflict,
    validateProviderCredential: vi.fn(),
    consentPurposeForProvider: vi.fn(),
    hasCurrentConsent: vi.fn(),
    writeAuditEventInTransaction: vi.fn(),
    parseMasterKey: vi.fn(),
    openCredential: vi.fn(),
    sealCredential: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({
  db: { select: mocks.dbSelect, transaction: mocks.transaction },
}));
vi.mock("@/lib/ai/credential-validation", () => ({
  validateProviderCredential: mocks.validateProviderCredential,
}));
vi.mock("@/lib/privacy/consent", () => ({
  consentPurposeForProvider: mocks.consentPurposeForProvider,
  hasCurrentConsent: mocks.hasCurrentConsent,
}));
vi.mock("@/lib/security/audit-writer", () => ({
  writeAuditEventInTransaction: mocks.writeAuditEventInTransaction,
}));
vi.mock("@/lib/security/credential-vault", () => ({
  parseMasterKey: mocks.parseMasterKey,
  openCredential: mocks.openCredential,
  sealCredential: mocks.sealCredential,
}));

import { emailOutbox } from "@/lib/db/schema";
import {
  AdminCredentialError,
  adminCredentialErrorCode,
  adminCredentialErrorStatus,
  adminCredentialPublicError,
  performAdminCredentialOperation,
} from "../service";

const actor = { id: "admin-1" };
const target = {
  id: "a1000000-0000-4000-8000-000000000001",
  userId: "learner-internal-1",
  provider: "nvidia_nim" as const,
  ciphertext: "ciphertext",
  wrappedDataKey: "wrapped",
  wrapIv: "wrap-iv",
  dataIv: "data-iv",
  authTag: "tag",
  keyVersion: 1,
  lastFour: "ABCD",
  ownerPublicId: "b1000000-0000-4000-8000-000000000002",
  ownerName: "Learner",
  ownerEmail: "learner@example.test",
};
const base = {
  actorUserId: actor.id,
  learnerPublicId: target.ownerPublicId,
  credentialId: target.id,
  reason: "Repair the learner provider credential configuration.",
} as const;

describe("atomic administrator credential service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CREDENTIAL_MASTER_KEY = "configured-test-key";
    delete process.env.APP_URL;
    mocks.dbLimit.mockReset().mockImplementation(async () => (
      mocks.dbLimit.mock.calls.length % 2 === 1 ? [actor] : [target]
    ));
    mocks.txLimit.mockReset().mockImplementation(async () => (
      mocks.txLimit.mock.calls.length % 2 === 1 ? [actor] : [target]
    ));
    mocks.txReturning.mockReset().mockResolvedValue([{ id: target.id }]);
    mocks.txDeleteReturning.mockReset().mockResolvedValue([{ id: target.id }]);
    mocks.txInsert.mockReset();
    mocks.txInsert.mockImplementation((table: unknown) => (
      table === emailOutbox
        ? { values: mocks.outboxValues }
        : { values: mocks.notificationValues }
    ));
    mocks.consentPurposeForProvider.mockReturnValue("provider_nvidia_nim");
    mocks.hasCurrentConsent.mockResolvedValue(true);
    mocks.parseMasterKey.mockReturnValue(Buffer.alloc(32, 9));
    mocks.openCredential.mockReturnValue("existing-provider-material-1234");
    mocks.validateProviderCredential.mockResolvedValue({
      status: "active",
      failureCode: null,
      model: "test-model",
    });
    mocks.sealCredential.mockReturnValue({
      ciphertext: "new-ciphertext",
      wrappedDataKey: "new-wrapped",
      wrapIv: "new-wrap-iv",
      dataIv: "new-data-iv",
      authTag: "new-tag",
      keyVersion: 2,
      lastFour: "5678",
    });
    mocks.writeAuditEventInTransaction.mockResolvedValue({
      correlationId: "audit-correlation-1",
      eventHash: "audit-hash",
    });
  });

  it("checks the active administrator before loading or opening a learner credential", async () => {
    mocks.dbLimit.mockReset().mockResolvedValueOnce([]);
    await expect(performAdminCredentialOperation({ ...base, action: "test" })).rejects.toMatchObject({
      code: "ADMIN_REQUIRED",
    });
    expect(mocks.openCredential).not.toHaveBeenCalled();
    expect(mocks.validateProviderCredential).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("fails an owner mismatch closed before vault access or provider transmission", async () => {
    mocks.dbLimit.mockReset().mockResolvedValueOnce([actor]).mockResolvedValueOnce([]);
    await expect(performAdminCredentialOperation({ ...base, action: "test" })).rejects.toMatchObject({
      code: "CREDENTIAL_NOT_FOUND",
    });
    expect(mocks.openCredential).not.toHaveBeenCalled();
    expect(mocks.validateProviderCredential).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("refuses test, replacement, and enable after provider-consent withdrawal", async () => {
    for (const action of ["test", "replace", "enable"] as const) {
      mocks.dbLimit.mockReset().mockResolvedValueOnce([actor]).mockResolvedValueOnce([target]);
      mocks.hasCurrentConsent.mockResolvedValueOnce(false);
      await expect(performAdminCredentialOperation({
        ...base,
        action,
        ...(action === "replace" ? { replacementSecret: "replacement-provider-material-5678" } : {}),
      })).rejects.toMatchObject({ code: "PROVIDER_CONSENT_REQUIRED" });
    }
    expect(mocks.validateProviderCredential).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("commits disable, audit, in-app notice, and email outbox through one transaction", async () => {
    const result = await performAdminCredentialOperation({ ...base, action: "disable" });
    expect(result).toMatchObject({ action: "disable", status: "disabled" });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.txSet).toHaveBeenCalledWith(expect.objectContaining({
      status: "disabled",
      disabledAt: expect.any(Date),
    }));
    expect(mocks.writeAuditEventInTransaction).toHaveBeenCalledWith(
      mocks.tx,
      expect.objectContaining({
        actorUserId: actor.id,
        subjectUserId: target.userId,
        action: "credential.disable",
        reason: base.reason,
        metadata: {
          provider: "nvidia_nim",
          priorLastFour: "ABCD",
          resultingStatus: "disabled",
        },
      }),
    );
    expect(mocks.notificationValues).toHaveBeenCalledWith(expect.objectContaining({
      userId: target.userId,
      type: "credential-changed",
    }));
    expect(mocks.outboxValues).toHaveBeenCalledWith(expect.objectContaining({
      userId: target.userId,
      toEmail: target.ownerEmail,
      template: "credential-changed",
    }));
  });

  it("validates and seals replacement material but excludes it from audit and notifications", async () => {
    const secret = "replacement-provider-material-5678";
    await performAdminCredentialOperation({
      ...base,
      action: "replace",
      replacementSecret: secret,
    });
    expect(mocks.validateProviderCredential).toHaveBeenCalledWith(expect.objectContaining({ secret }));
    expect(mocks.sealCredential).toHaveBeenCalledWith(secret, expect.objectContaining({ keyVersion: 2 }), expect.any(Buffer));
    expect(mocks.txSet).toHaveBeenCalledWith(expect.objectContaining({
      ciphertext: "new-ciphertext",
      lastFour: "5678",
      keyVersion: 2,
    }));
    expect(JSON.stringify(mocks.writeAuditEventInTransaction.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(mocks.notificationValues.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(mocks.outboxValues.mock.calls)).not.toContain(secret);
  });

  it("withholds decryption and provider transmission when preflight audit or notification fails", async () => {
    mocks.writeAuditEventInTransaction.mockRejectedValueOnce(new Error("preflight audit unavailable"));
    await expect(performAdminCredentialOperation({ ...base, action: "test" })).rejects.toThrow();
    expect(mocks.openCredential).not.toHaveBeenCalled();
    expect(mocks.validateProviderCredential).not.toHaveBeenCalled();
    expect(mocks.txSet).not.toHaveBeenCalled();
  });

  it.each([
    ["audit", () => mocks.writeAuditEventInTransaction.mockRejectedValueOnce(new Error("audit unavailable"))],
    ["in-app notification", () => mocks.notificationValues.mockRejectedValueOnce(new Error("notification unavailable"))],
    ["email outbox", () => mocks.outboxConflict.mockRejectedValueOnce(new Error("outbox unavailable"))],
  ] as const)("fails closed when the %s write fails", async (_label, fail) => {
    fail();
    await expect(performAdminCredentialOperation({ ...base, action: "disable" })).rejects.toThrow();
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it("detects a concurrent replacement before committing stale validation", async () => {
    mocks.txLimit.mockReset()
      .mockResolvedValueOnce([actor])
      .mockResolvedValueOnce([{ ...target, keyVersion: 2 }]);
    await expect(performAdminCredentialOperation({ ...base, action: "test" })).rejects.toMatchObject({
      code: "CONCURRENT_CHANGE",
    });
    expect(mocks.txSet).not.toHaveBeenCalled();
    expect(mocks.writeAuditEventInTransaction).not.toHaveBeenCalled();
    expect(mocks.validateProviderCredential).not.toHaveBeenCalled();
  });

  it("rejects accidental secret material on non-replacement operations", async () => {
    await expect(performAdminCredentialOperation({
      ...base,
      action: "disable",
      replacementSecret: "must-not-be-accepted",
    })).rejects.toEqual(expect.any(AdminCredentialError));
    expect(mocks.dbSelect).not.toHaveBeenCalled();
  });

  it.each([
    ["too short", { ...base, action: "disable" as const, reason: " short " }, "INVALID_OPERATION"],
    ["too long", { ...base, action: "disable" as const, reason: "x".repeat(501) }, "INVALID_OPERATION"],
    ["missing replacement", { ...base, action: "replace" as const }, "REPLACEMENT_SECRET_REQUIRED"],
    ["short replacement", { ...base, action: "replace" as const, replacementSecret: " short " }, "REPLACEMENT_SECRET_REQUIRED"],
    ["long replacement", { ...base, action: "replace" as const, replacementSecret: "x".repeat(4_097) }, "REPLACEMENT_SECRET_REQUIRED"],
  ])("rejects %s input before querying the database", async (_label, operation, code) => {
    await expect(performAdminCredentialOperation(operation)).rejects.toMatchObject({ code });
    expect(mocks.dbSelect).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("short-circuits consent checks when the provider has no consent purpose", async () => {
    mocks.consentPurposeForProvider.mockReturnValueOnce(undefined);

    await expect(performAdminCredentialOperation({ ...base, action: "enable" })).rejects.toMatchObject({
      code: "PROVIDER_CONSENT_REQUIRED",
    });
    expect(mocks.hasCurrentConsent).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("fails safely when the credential master key is missing or malformed", async () => {
    delete process.env.CREDENTIAL_MASTER_KEY;
    await expect(performAdminCredentialOperation({ ...base, action: "test" })).rejects.toMatchObject({
      code: "VAULT_UNAVAILABLE",
    });
    expect(mocks.parseMasterKey).not.toHaveBeenCalled();
    expect(mocks.openCredential).not.toHaveBeenCalled();

    process.env.CREDENTIAL_MASTER_KEY = "malformed";
    mocks.parseMasterKey.mockImplementationOnce(() => {
      throw new Error("bad key");
    });
    await expect(performAdminCredentialOperation({ ...base, action: "test" })).rejects.toMatchObject({
      code: "VAULT_UNAVAILABLE",
    });
    expect(mocks.openCredential).not.toHaveBeenCalled();
  });

  it("zeroes the wrapping key when credential opening fails", async () => {
    const wrappingKey = Buffer.alloc(32, 7);
    mocks.parseMasterKey.mockReturnValueOnce(wrappingKey);
    mocks.openCredential.mockImplementationOnce(() => {
      throw new Error("tampered ciphertext");
    });

    await expect(performAdminCredentialOperation({ ...base, action: "test" })).rejects.toMatchObject({
      code: "CREDENTIAL_OPEN_FAILED",
    });
    expect(mocks.validateProviderCredential).not.toHaveBeenCalled();
    expect([...wrappingKey]).toEqual(Array(32).fill(0));
  });

  it("normalizes provider validation failures and always zeroes the wrapping key", async () => {
    const wrappingKey = Buffer.alloc(32, 8);
    mocks.parseMasterKey.mockReturnValueOnce(wrappingKey);
    mocks.validateProviderCredential.mockRejectedValueOnce(new Error("provider unavailable"));

    await expect(performAdminCredentialOperation({ ...base, action: "test" })).rejects.toMatchObject({
      code: "VALIDATION_UNAVAILABLE",
    });
    expect([...wrappingKey]).toEqual(Array(32).fill(0));
    expect(mocks.txSet).not.toHaveBeenCalled();
  });

  it("trims replacement material and the administrator reason at the mutation boundary", async () => {
    const secret = "replacement-provider-material-5678";
    await performAdminCredentialOperation({
      ...base,
      action: "replace",
      reason: `  ${base.reason}  `,
      replacementSecret: `  ${secret}  `,
    });

    expect(mocks.validateProviderCredential).toHaveBeenCalledWith(expect.objectContaining({ secret }));
    expect(mocks.sealCredential).toHaveBeenCalledWith(secret, expect.any(Object), expect.any(Buffer));
    expect(mocks.writeAuditEventInTransaction).toHaveBeenLastCalledWith(mocks.tx, expect.objectContaining({
      reason: base.reason,
    }));
  });

  it("records a failed completion outcome when validation rejects the credential", async () => {
    mocks.validateProviderCredential.mockResolvedValueOnce({
      status: "invalid",
      failureCode: "AUTHENTICATION_FAILED",
      model: "test-model",
    });

    const result = await performAdminCredentialOperation({ ...base, action: "test" });

    expect(result.status).toBe("invalid");
    expect(mocks.txSet).toHaveBeenCalledWith(expect.objectContaining({
      status: "invalid",
      failureCode: "AUTHENTICATION_FAILED",
      lastValidatedAt: expect.any(Date),
    }));
    expect(mocks.writeAuditEventInTransaction).toHaveBeenLastCalledWith(mocks.tx, expect.objectContaining({
      outcome: "failure",
      metadata: expect.objectContaining({ resultingStatus: "invalid" }),
    }));
  });

  it("keeps lastValidatedAt null when validation is pending without a provider model", async () => {
    mocks.validateProviderCredential.mockResolvedValueOnce({
      status: "pending_validation",
      failureCode: null,
      model: null,
    });

    const result = await performAdminCredentialOperation({ ...base, action: "test" });

    expect(result.status).toBe("pending_validation");
    expect(mocks.txSet).toHaveBeenCalledWith(expect.objectContaining({ lastValidatedAt: null }));
    expect(mocks.writeAuditEventInTransaction).toHaveBeenLastCalledWith(mocks.tx, expect.objectContaining({
      outcome: "success",
    }));
  });

  it("rechecks administrator and learner ownership after taking the credential lock", async () => {
    mocks.txLimit.mockReset().mockResolvedValueOnce([]);
    await expect(performAdminCredentialOperation({ ...base, action: "disable" })).rejects.toMatchObject({
      code: "ADMIN_REQUIRED",
    });
    expect(mocks.txSet).not.toHaveBeenCalled();

    mocks.txLimit.mockReset().mockResolvedValueOnce([actor]).mockResolvedValueOnce([]);
    await expect(performAdminCredentialOperation({ ...base, action: "disable" })).rejects.toMatchObject({
      code: "CREDENTIAL_NOT_FOUND",
    });
    expect(mocks.txSet).not.toHaveBeenCalled();
  });

  it("detects a credential change after provider validation but before the final mutation", async () => {
    mocks.txLimit.mockReset()
      .mockResolvedValueOnce([actor])
      .mockResolvedValueOnce([target])
      .mockResolvedValueOnce([actor])
      .mockResolvedValueOnce([{ ...target, keyVersion: 2 }]);

    await expect(performAdminCredentialOperation({ ...base, action: "test" })).rejects.toMatchObject({
      code: "CONCURRENT_CHANGE",
    });
    expect(mocks.validateProviderCredential).toHaveBeenCalledTimes(1);
    expect(mocks.txSet).not.toHaveBeenCalled();
    expect(mocks.writeAuditEventInTransaction).toHaveBeenCalledTimes(1);
  });

  it("enables a credential as pending validation and clears its prior disable failure", async () => {
    process.env.APP_URL = "https://learning.example.test";
    const mixedCaseTarget = { ...target, ownerEmail: "Learner@Example.TEST" };
    mocks.dbLimit.mockReset().mockResolvedValueOnce([actor]).mockResolvedValueOnce([mixedCaseTarget]);
    mocks.txLimit.mockReset().mockResolvedValueOnce([actor]).mockResolvedValueOnce([mixedCaseTarget]);

    const result = await performAdminCredentialOperation({ ...base, action: "enable" });

    expect(result).toMatchObject({ action: "enable", status: "pending_validation" });
    expect(mocks.txSet).toHaveBeenCalledWith(expect.objectContaining({
      status: "pending_validation",
      disabledAt: null,
      failureCode: null,
    }));
    expect(mocks.outboxValues).toHaveBeenCalledWith(expect.objectContaining({
      toEmail: "learner@example.test",
      variables: expect.objectContaining({ url: "https://learning.example.test/settings?section=ai" }),
    }));
  });

  it("deletes a credential and returns an auditable terminal status", async () => {
    const result = await performAdminCredentialOperation({ ...base, action: "delete" });

    expect(result).toMatchObject({
      credentialId: target.id,
      action: "delete",
      status: "deleted",
      auditCorrelationId: "audit-correlation-1",
    });
    expect(mocks.txDeleteReturning).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditEventInTransaction).toHaveBeenCalledWith(mocks.tx, expect.objectContaining({
      action: "credential.delete",
      outcome: "success",
    }));
  });

  it.each([
    ["delete", () => mocks.txDeleteReturning.mockResolvedValueOnce([])],
    ["enable", () => mocks.txReturning.mockResolvedValueOnce([])],
    ["test", () => mocks.txReturning.mockResolvedValueOnce([])],
  ] as const)("fails closed when a concurrent %s mutation affects no row", async (action, configure) => {
    configure();
    await expect(performAdminCredentialOperation({ ...base, action })).rejects.toMatchObject({
      code: "CONCURRENT_CHANGE",
    });
    expect(mocks.notificationValues).not.toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining(`was ${action}`),
    }));
  });

  it("maps internal credential errors to stable HTTP, public message, and code contracts", () => {
    const cases = [
      ["ADMIN_REQUIRED", 403],
      ["CREDENTIAL_NOT_FOUND", 404],
      ["PROVIDER_CONSENT_REQUIRED", 409],
      ["CONCURRENT_CHANGE", 409],
      ["REPLACEMENT_SECRET_REQUIRED", 400],
      ["INVALID_OPERATION", 400],
      ["VAULT_UNAVAILABLE", 503],
    ] as const;
    for (const [code, status] of cases) {
      const error = new AdminCredentialError(code, `public ${code}`);
      expect(adminCredentialErrorStatus(error)).toBe(status);
      expect(adminCredentialPublicError(error)).toBe(`public ${code}`);
      expect(adminCredentialErrorCode(error)).toBe(code);
    }

    const unknown = new Error("private detail");
    expect(adminCredentialErrorStatus(unknown)).toBe(503);
    expect(adminCredentialPublicError(unknown)).toBe("Credential operation could not be completed safely.");
    expect(adminCredentialErrorCode(unknown)).toBe("OPERATION_UNAVAILABLE");
  });
});
