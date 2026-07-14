import { beforeEach, describe, expect, it } from "vitest";

import {
  clearDraftCaches,
  draftCacheKey,
  readDraftCache,
  writeDraftCache,
  type CachedLearnerDraft,
} from "../browser-cache";
import { createDraftCacheNamespace } from "../cache-namespace";

const key = { kind: "code" as const, courseId: "python", skillId: "python.variables", language: "python" };
const requestId = "10000000-0000-4000-8000-000000000001";
const cached: CachedLearnerDraft = {
  schemaVersion: 1,
  content: "answer = 42\n",
  language: "python",
  baseRowVersion: 4,
  requestId,
  locallyUpdatedAt: "2026-07-12T10:00:00.000Z",
  dirty: true,
};

describe("session-scoped learner draft cache", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("uses an opaque namespace bound to both user and durable session", () => {
    const secret = "s".repeat(32);
    const first = createDraftCacheNamespace("learner-one", "session-one", secret);
    const otherUser = createDraftCacheNamespace("learner-two", "session-one", secret);
    const otherDevice = createDraftCacheNamespace("learner-one", "session-two", secret);

    expect(first).toHaveLength(43);
    expect(new Set([first, otherUser, otherDevice])).toHaveLength(3);
    const storageKey = draftCacheKey(first, key);
    expect(storageKey).not.toContain("learner-one");
    expect(storageKey).not.toContain("session-one");
  });

  it("never reads another learner or session namespace", () => {
    writeDraftCache(window.sessionStorage, "namespace-one", key, cached);
    expect(readDraftCache(window.sessionStorage, "namespace-one", key)).toEqual(cached);
    expect(readDraftCache(window.sessionStorage, "namespace-two", key)).toBeNull();
  });

  it("keeps DSA implementation-language drafts in distinct cache identities", () => {
    const cpp = { kind: "code" as const, courseId: "dsa", skillId: "dsa.arrays", language: "cpp" };
    const python = { ...cpp, language: "python" };
    writeDraftCache(window.sessionStorage, "namespace-one", cpp, { ...cached, language: "cpp", content: "vector<int> a;" });
    writeDraftCache(window.sessionStorage, "namespace-one", python, { ...cached, language: "python", content: "a = []" });
    expect(draftCacheKey("namespace-one", cpp)).not.toBe(draftCacheKey("namespace-one", python));
    expect(readDraftCache(window.sessionStorage, "namespace-one", cpp)?.content).toBe("vector<int> a;");
    expect(readDraftCache(window.sessionStorage, "namespace-one", python)?.content).toBe("a = []");
  });

  it("treats eviction as a cache miss instead of a data deletion", () => {
    writeDraftCache(window.sessionStorage, "namespace-one", key, cached);
    window.sessionStorage.removeItem(draftCacheKey("namespace-one", key));
    expect(readDraftCache(window.sessionStorage, "namespace-one", key)).toBeNull();
    // The caller restores from GET /api/drafts; no cache API can delete the
    // authoritative PostgreSQL row.
  });

  it("purges malformed cache records and rejects oversized text", () => {
    const storageKey = draftCacheKey("namespace-one", key);
    window.sessionStorage.setItem(storageKey, JSON.stringify({ ...cached, baseRowVersion: -1 }));
    expect(readDraftCache(window.sessionStorage, "namespace-one", key)).toBeNull();
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();

    expect(() => writeDraftCache(window.sessionStorage, "namespace-one", key, {
      ...cached,
      content: "😀".repeat(40_000),
    })).toThrow(/invalid or too large/i);
  });

  it("clears one namespace or every app draft on logout without touching other storage", () => {
    writeDraftCache(window.sessionStorage, "namespace-one", key, cached);
    writeDraftCache(window.sessionStorage, "namespace-two", key, cached);
    window.sessionStorage.setItem("another-app", "keep");

    expect(clearDraftCaches(window.sessionStorage, "namespace-one")).toBe(1);
    expect(readDraftCache(window.sessionStorage, "namespace-one", key)).toBeNull();
    expect(readDraftCache(window.sessionStorage, "namespace-two", key)).toEqual(cached);
    expect(clearDraftCaches(window.sessionStorage)).toBe(1);
    expect(window.sessionStorage.getItem("another-app")).toBe("keep");
  });
});
