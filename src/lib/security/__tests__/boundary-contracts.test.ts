import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { assertAuditMetadataSafe, hashAuditEvent } from "../audit";
import { openCredential, parseMasterKey, sealCredential } from "../credential-vault";
import { authorizePrivilegedAction, isFreshMfa } from "../privileged-access";

describe("fresh-MFA boundary contract", () => {
  const now = new Date("2026-07-12T12:00:00.000Z");

  it("accepts exactly the five-minute boundary but rejects future and stale assertions", () => {
    expect(isFreshMfa(new Date(now.getTime() - 5 * 60_000), now)).toBe(true);
    expect(isFreshMfa(new Date(now.getTime() - 5 * 60_000 - 1), now)).toBe(false);
    expect(isFreshMfa(new Date(now.getTime() + 1), now)).toBe(false);
    expect(isFreshMfa(new Date("invalid"), now)).toBe(false);
    expect(isFreshMfa(null, now)).toBe(false);
  });

  it.each([
    { actorRole: "learner", mfaVerifiedAt: now, reason: "A valid audit reason", code: "ADMIN_REQUIRED" },
    { actorRole: "admin", mfaVerifiedAt: new Date(now.getTime() - 300_001), reason: "A valid audit reason", code: "FRESH_MFA_REQUIRED" },
    { actorRole: "admin", mfaVerifiedAt: now, reason: " short ", code: "REASON_REQUIRED" },
    { actorRole: "admin", mfaVerifiedAt: now, reason: "x".repeat(501), code: "REASON_TOO_LONG" },
  ])("denies privileged action with $code", ({ actorRole, mfaVerifiedAt, reason, code }) => {
    expect(authorizePrivilegedAction({
      actorRole, mfaVerifiedAt, reason, action: "credential.reveal", now,
    })).toEqual({ allowed: false, code });
  });

  it("accepts a trimmed eight-character reason", () => {
    expect(authorizePrivilegedAction({
      actorRole: "admin", mfaVerifiedAt: now, reason: "  12345678  ",
      action: "credential.reveal", now,
    })).toEqual({ allowed: true, code: "AUTHORIZED" });
  });
});

describe("audit metadata fail-closed contract", () => {
  it.each([
    { password: "redacted" },
    { nested: { authorization: "redacted" } },
    { list: [{ credentialId: "id" }] },
    { note: "sk-this-is-a-secret-value" },
    { note: "AIza1234567890" },
    { note: "ghp_1234567890" },
    { note: "xoxb-1234567890" },
  ])("rejects secret-like metadata %#", (metadata) => {
    expect(() => assertAuditMetadataSafe(metadata)).toThrow();
  });

  it("canonicalizes object keys while preserving security-relevant array order", () => {
    const left = hashAuditEvent({ action: "test", metadata: { z: 1, a: 2 } }, null);
    const reordered = hashAuditEvent({ metadata: { a: 2, z: 1 }, action: "test" }, null);
    const arrayChanged = hashAuditEvent({ action: "test", metadata: { values: [2, 1] } }, null);
    const otherArray = hashAuditEvent({ action: "test", metadata: { values: [1, 2] } }, null);
    expect(left).toBe(reordered);
    expect(arrayChanged).not.toBe(otherArray);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("credential envelope context binding", () => {
  const context = { userId: "user-1", credentialId: "cred-1", provider: "nvidia_nim", keyVersion: 1 };

  it.each([
    { userId: "user-2" },
    { credentialId: "cred-2" },
    { provider: "openrouter" },
    { keyVersion: 2 },
  ])("rejects ciphertext replay under changed context %#", (changed) => {
    const master = randomBytes(32);
    const sealed = sealCredential("test-provider-secret-1234", context, master);
    expect(() => openCredential(sealed, { ...context, ...changed }, master)).toThrow();
  });

  it.each(["", "not-base64", randomBytes(31).toString("base64"), randomBytes(33).toString("base64")])(
    "rejects invalid wrapping key %j",
    (configured) => expect(() => parseMasterKey(configured)).toThrow(/exactly 32 .*bytes/),
  );
});
