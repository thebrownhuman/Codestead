import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  maskedCredential,
  openCredential,
  parseMasterKey,
  sealCredential,
} from "../credential-vault";

const context = {
  userId: "user-1",
  credentialId: "cred-1",
  provider: "nvidia_nim",
  keyVersion: 1,
};

describe("credential vault", () => {
  it("round trips a credential without storing plaintext", () => {
    const masterKey = randomBytes(32);
    const plaintext = "provider-test-secret-1234";
    const sealed = sealCredential(plaintext, context, masterKey);

    expect(JSON.stringify(sealed)).not.toContain(plaintext);
    expect(sealed.lastFour).toBe("1234");
    expect(openCredential(sealed, context, masterKey)).toBe(plaintext);
  });

  it("uses the version-one context default consistently", () => {
    const masterKey = randomBytes(32);
    const unversionedContext = {
      userId: context.userId,
      credentialId: context.credentialId,
      provider: context.provider,
    };
    const sealed = sealCredential("provider-test-secret-5678", unversionedContext, masterKey);

    expect(sealed.keyVersion).toBe(1);
    expect(openCredential(sealed, unversionedContext, masterKey)).toBe("provider-test-secret-5678");
  });

  it("binds ciphertext to the owner and provider", () => {
    const masterKey = randomBytes(32);
    const sealed = sealCredential("provider-test-secret-1234", context, masterKey);
    expect(() =>
      openCredential(sealed, { ...context, userId: "other-user" }, masterKey),
    ).toThrow();
  });

  it("rejects tampering and incorrect master keys", () => {
    const masterKey = randomBytes(32);
    const sealed = sealCredential("provider-test-secret-1234", context, masterKey);
    const changed = {
      ...sealed,
      ciphertext: `${sealed.ciphertext.slice(0, -2)}AA`,
    };
    expect(() => openCredential(changed, context, masterKey)).toThrow();
    expect(() => openCredential(sealed, context, randomBytes(32))).toThrow();
  });

  it("validates the configured wrapping key", () => {
    const raw = randomBytes(32);
    expect(parseMasterKey(raw.toString("base64"))).toEqual(raw);
    expect(() => parseMasterKey(randomBytes(16).toString("base64"))).toThrow();
  });

  it("rejects invalid keys and credential lengths before encryption", () => {
    const masterKey = randomBytes(32);
    expect(() => sealCredential("provider-test-secret", context, randomBytes(31))).toThrow(/master key/i);
    expect(() => sealCredential("short", context, masterKey)).toThrow(/length/i);
    expect(() => sealCredential("x".repeat(4_097), context, masterKey)).toThrow(/length/i);
  });

  it("fails closed on version, envelope, and metadata corruption", () => {
    const masterKey = randomBytes(32);
    const sealed = sealCredential("provider-test-secret-1234", context, masterKey);

    expect(() => openCredential(sealed, context, randomBytes(31))).toThrow(/master key/i);
    expect(() => openCredential(sealed, { ...context, keyVersion: 2 }, masterKey)).toThrow(/version/i);
    expect(() => openCredential({ ...sealed, wrappedDataKey: "" }, context, masterKey)).toThrow(/base64url/i);
    expect(() => openCredential({
      ...sealed,
      wrappedDataKey: Buffer.alloc(16).toString("base64url"),
    }, context, masterKey)).toThrow(/truncated/i);
    expect(() => openCredential({
      ...sealed,
      wrapIv: Buffer.alloc(1).toString("base64url"),
    }, context, masterKey)).toThrow(/wrapping IV/i);
    expect(() => openCredential({
      ...sealed,
      dataIv: Buffer.alloc(1).toString("base64url"),
    }, context, masterKey)).toThrow(/metadata/i);
    expect(() => openCredential({
      ...sealed,
      authTag: Buffer.alloc(1).toString("base64url"),
    }, context, masterKey)).toThrow(/metadata/i);
    expect(() => openCredential({ ...sealed, lastFour: "9999" }, context, masterKey)).toThrow(/integrity/i);
    expect(() => openCredential({ ...sealed, lastFour: "9" }, context, masterKey)).toThrow(/integrity/i);
  });

  it("only renders a safe last-four mask", () => {
    expect(maskedCredential("1234")).toContain("1234");
    expect(maskedCredential("bad secret")).toBe("••••");
  });
});
