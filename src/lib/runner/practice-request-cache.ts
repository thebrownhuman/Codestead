import { DRAFT_CACHE_PREFIX } from "@/lib/drafts/browser-cache";

const SAFE_NAMESPACE = /^[A-Za-z0-9._:-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_NAMESPACE_KEY = `${DRAFT_CACHE_PREFIX}practice-run-session`;

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type PracticeRunRequestPayload = Readonly<{
  language: string;
  source: string;
  skillId: string;
  mode: "compile" | "quick_run";
  stdin?: string;
}>;

export type PracticeRunRequestIdentity = Readonly<{
  requestId: string;
  storageKey: string;
}>;

function requestNamespace(storage: BrowserStorage, namespace: string | null) {
  if (namespace && SAFE_NAMESPACE.test(namespace)) return namespace;
  const stored = storage.getItem(SESSION_NAMESPACE_KEY);
  if (stored && UUID.test(stored)) return `session-${stored}`;
  if (stored) storage.removeItem(SESSION_NAMESPACE_KEY);
  if (!globalThis.crypto?.randomUUID) {
    throw new Error("Secure browser request identifiers are unavailable.");
  }
  const created = globalThis.crypto.randomUUID();
  storage.setItem(SESSION_NAMESPACE_KEY, created);
  if (storage.getItem(SESSION_NAMESPACE_KEY) !== created) {
    throw new Error("The practice request namespace could not be persisted.");
  }
  return `session-${created}`;
}

async function payloadFingerprint(payload: PracticeRunRequestPayload) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Secure browser hashing is unavailable.");
  }
  const canonical = JSON.stringify({
    schemaVersion: 1,
    language: payload.language,
    source: payload.source,
    skillId: payload.skillId,
    mode: payload.mode,
    stdin: payload.stdin ?? null,
  });
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Persist only an opaque request UUID. The payload is represented solely by a
 * SHA-256 key, so source code and credentials never enter browser metadata.
 * The draft-cache prefix makes confirmed sign-out purge these entries too.
 */
export async function acquirePracticeRunRequest(
  storage: BrowserStorage,
  namespace: string | null,
  payload: PracticeRunRequestPayload,
): Promise<PracticeRunRequestIdentity> {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error("Secure browser request identifiers are unavailable.");
  }
  const scopedNamespace = requestNamespace(storage, namespace);
  const fingerprint = await payloadFingerprint(payload);
  const storageKey = `${DRAFT_CACHE_PREFIX}${encodeURIComponent(scopedNamespace)}:practice-run:${fingerprint}`;
  const stored = storage.getItem(storageKey);
  if (stored && UUID.test(stored)) return { requestId: stored, storageKey };
  if (stored) storage.removeItem(storageKey);

  const requestId = globalThis.crypto.randomUUID();
  storage.setItem(storageKey, requestId);
  if (storage.getItem(storageKey) !== requestId) {
    throw new Error("The practice request identifier could not be persisted.");
  }
  return { requestId, storageKey };
}

export function releasePracticeRunRequest(
  storage: BrowserStorage,
  identity: PracticeRunRequestIdentity,
) {
  if (storage.getItem(identity.storageKey) === identity.requestId) {
    storage.removeItem(identity.storageKey);
  }
}
