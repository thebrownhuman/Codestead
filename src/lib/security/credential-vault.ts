import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

export interface CredentialContext {
  credentialId: string;
  userId: string;
  provider: string;
  keyVersion?: number;
}

export interface SealedCredential {
  ciphertext: string;
  wrappedDataKey: string;
  wrapIv: string;
  dataIv: string;
  authTag: string;
  keyVersion: number;
  lastFour: string;
}

function aad(context: CredentialContext, purpose: "data" | "wrap") {
  return Buffer.from(
    [
      "learncoding",
      "provider-credential",
      purpose,
      String(context.keyVersion ?? 1),
      context.userId,
      context.credentialId,
      context.provider,
    ].join(":"),
    "utf8",
  );
}

function decodeBase64(value: string, label: string) {
  const buffer = Buffer.from(value, "base64url");
  if (buffer.length === 0) throw new Error(`${label} is not valid base64url data.`);
  return buffer;
}

export function parseMasterKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== AES_KEY_BYTES) {
    throw new Error("CREDENTIAL_MASTER_KEY must be exactly 32 base64-encoded bytes.");
  }
  return key;
}

export function sealCredential(
  plaintext: string,
  context: CredentialContext,
  masterKey: Buffer,
): SealedCredential {
  if (masterKey.length !== AES_KEY_BYTES) throw new Error("Invalid master key length.");
  const normalized = plaintext.trim();
  if (normalized.length < 8 || normalized.length > 4_096) {
    throw new Error("Credential length is outside the accepted range.");
  }

  const version = context.keyVersion ?? 1;
  const versionedContext = { ...context, keyVersion: version };
  const dataKey = randomBytes(AES_KEY_BYTES);
  const dataIv = randomBytes(GCM_IV_BYTES);
  const dataCipher = createCipheriv("aes-256-gcm", dataKey, dataIv);
  dataCipher.setAAD(aad(versionedContext, "data"));
  const ciphertext = Buffer.concat([
    dataCipher.update(normalized, "utf8"),
    dataCipher.final(),
  ]);
  const dataTag = dataCipher.getAuthTag();

  const wrapIv = randomBytes(GCM_IV_BYTES);
  const wrapCipher = createCipheriv("aes-256-gcm", masterKey, wrapIv);
  wrapCipher.setAAD(aad(versionedContext, "wrap"));
  const wrappedKey = Buffer.concat([wrapCipher.update(dataKey), wrapCipher.final()]);
  const wrappedWithTag = Buffer.concat([wrappedKey, wrapCipher.getAuthTag()]);
  dataKey.fill(0);

  return {
    ciphertext: ciphertext.toString("base64url"),
    wrappedDataKey: wrappedWithTag.toString("base64url"),
    wrapIv: wrapIv.toString("base64url"),
    dataIv: dataIv.toString("base64url"),
    authTag: dataTag.toString("base64url"),
    keyVersion: version,
    lastFour: normalized.slice(-4),
  };
}

export function openCredential(
  sealed: SealedCredential,
  context: CredentialContext,
  masterKey: Buffer,
): string {
  if (masterKey.length !== AES_KEY_BYTES) throw new Error("Invalid master key length.");
  if (sealed.keyVersion !== (context.keyVersion ?? sealed.keyVersion)) {
    throw new Error("Credential key version does not match its context.");
  }
  const versionedContext = { ...context, keyVersion: sealed.keyVersion };

  const wrapped = decodeBase64(sealed.wrappedDataKey, "wrappedDataKey");
  if (wrapped.length <= GCM_TAG_BYTES) throw new Error("Wrapped data key is truncated.");
  const wrappedKey = wrapped.subarray(0, -GCM_TAG_BYTES);
  const wrapTag = wrapped.subarray(-GCM_TAG_BYTES);
  const wrapIv = decodeBase64(sealed.wrapIv, "wrapIv");
  if (wrapIv.length !== GCM_IV_BYTES) throw new Error("Invalid wrapping IV length.");

  const unwrap = createDecipheriv("aes-256-gcm", masterKey, wrapIv);
  unwrap.setAAD(aad(versionedContext, "wrap"));
  unwrap.setAuthTag(wrapTag);
  const dataKey = Buffer.concat([unwrap.update(wrappedKey), unwrap.final()]);
  if (dataKey.length !== AES_KEY_BYTES) throw new Error("Invalid unwrapped data key.");

  try {
    const dataIv = decodeBase64(sealed.dataIv, "dataIv");
    const dataTag = decodeBase64(sealed.authTag, "authTag");
    if (dataIv.length !== GCM_IV_BYTES || dataTag.length !== GCM_TAG_BYTES) {
      throw new Error("Credential encryption metadata is invalid.");
    }
    const decipher = createDecipheriv("aes-256-gcm", dataKey, dataIv);
    decipher.setAAD(aad(versionedContext, "data"));
    decipher.setAuthTag(dataTag);
    const plaintext = Buffer.concat([
      decipher.update(decodeBase64(sealed.ciphertext, "ciphertext")),
      decipher.final(),
    ]).toString("utf8");

    const expectedLastFour = Buffer.from(sealed.lastFour, "utf8");
    const actualLastFour = Buffer.from(plaintext.slice(-4), "utf8");
    if (
      expectedLastFour.length !== actualLastFour.length ||
      !timingSafeEqual(expectedLastFour, actualLastFour)
    ) {
      throw new Error("Credential metadata integrity check failed.");
    }
    return plaintext;
  } finally {
    dataKey.fill(0);
  }
}

export function maskedCredential(lastFour: string) {
  if (!/^[\w-]{4}$/.test(lastFour)) return "••••";
  return `•••• •••• •••• ${lastFour}`;
}
