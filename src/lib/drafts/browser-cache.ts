import type { DraftKey } from "./types";
import { DRAFT_CONTENT_MAX_BYTES } from "./types";

export const DRAFT_CACHE_PREFIX = "learncoding:draft-cache:v1:";

export type CachedLearnerDraft = Readonly<{
  schemaVersion: 1;
  content: string;
  language: string | null;
  baseRowVersion: number;
  requestId: string;
  locallyUpdatedAt: string;
  dirty: boolean;
}>;

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function safeSegment(value: string, max: number) {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || !/^[a-zA-Z0-9._:-]+$/.test(normalized)) {
    throw new Error("Draft cache key is invalid.");
  }
  return encodeURIComponent(normalized);
}

export function draftCacheKey(namespace: string, key: DraftKey) {
  const languageFacet = key.language === null
    ? "language-none"
    : `language-${safeSegment(key.language, 40)}`;
  return `${DRAFT_CACHE_PREFIX}${safeSegment(namespace, 100)}:${key.kind}:${safeSegment(key.courseId, 100)}:${safeSegment(key.skillId, 180)}:${languageFacet}`;
}

function utf8Bytes(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function isCachedDraft(value: unknown): value is CachedLearnerDraft {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.schemaVersion === 1
    && typeof item.content === "string"
    && utf8Bytes(item.content) <= DRAFT_CONTENT_MAX_BYTES
    && (item.language === null || (typeof item.language === "string" && item.language.length > 0 && item.language.length <= 40))
    && Number.isSafeInteger(item.baseRowVersion)
    && Number(item.baseRowVersion) >= 0
    && typeof item.requestId === "string"
    && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(item.requestId)
    && typeof item.locallyUpdatedAt === "string"
    && Number.isFinite(new Date(item.locallyUpdatedAt).getTime())
    && typeof item.dirty === "boolean";
}

export function readDraftCache(
  storage: BrowserStorage,
  namespace: string,
  key: DraftKey,
): CachedLearnerDraft | null {
  const storageKey = draftCacheKey(namespace, key);
  const raw = storage.getItem(storageKey);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isCachedDraft(parsed)) return parsed;
  } catch {
    // Invalid JSON is purged below.
  }
  storage.removeItem(storageKey);
  return null;
}

export function writeDraftCache(
  storage: BrowserStorage,
  namespace: string,
  key: DraftKey,
  draft: CachedLearnerDraft,
) {
  if (!isCachedDraft(draft)) throw new Error("Draft cache value is invalid or too large.");
  storage.setItem(draftCacheKey(namespace, key), JSON.stringify(draft));
}

export function removeDraftCache(storage: BrowserStorage, namespace: string, key: DraftKey) {
  storage.removeItem(draftCacheKey(namespace, key));
}

export function clearDraftCaches(storage: BrowserStorage, namespace?: string) {
  const prefix = namespace
    ? `${DRAFT_CACHE_PREFIX}${safeSegment(namespace, 100)}:`
    : DRAFT_CACHE_PREFIX;
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  keys.forEach((key) => storage.removeItem(key));
  return keys.length;
}
