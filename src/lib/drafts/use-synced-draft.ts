"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  clearDraftCaches,
  readDraftCache,
  writeDraftCache,
  type CachedLearnerDraft,
} from "./browser-cache";
import { useDraftCacheNamespace } from "./browser-cache-context";
import type { DraftKey, LearnerDraftRecord } from "./types";

export type DraftSyncStatus =
  | "loading"
  | "local"
  | "syncing"
  | "synced"
  | "offline"
  | "conflict"
  | "reauthenticate"
  | "exam-locked"
  | "scope-unavailable"
  | "unavailable";

type GetResponse = {
  draft?: LearnerDraftRecord | null;
  cacheNamespace?: string;
  code?: string;
};

type PutResponse = GetResponse & {
  replayed?: boolean;
  committedRowVersion?: number;
  current?: LearnerDraftRecord | null;
};

function newRequestId() {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error("This browser cannot create secure draft mutation identifiers.");
  }
  return globalThis.crypto.randomUUID();
}

function queryString(key: DraftKey) {
  return new URLSearchParams({
    kind: key.kind,
    courseId: key.courseId,
    skillId: key.skillId,
    language: key.language ?? "",
  }).toString();
}

function cache(storage: Storage, namespace: string, key: DraftKey, value: CachedLearnerDraft) {
  try {
    writeDraftCache(storage, namespace, key, value);
    return true;
  } catch {
    return false;
  }
}

export function useSyncedDraft({
  key,
  language,
  initialContent,
}: {
  key: Omit<DraftKey, "language">;
  language: string | null;
  initialContent: string;
}) {
  const namespace = useDraftCacheNamespace();
  const draftKey = useMemo<DraftKey>(() => ({
    kind: key.kind,
    courseId: key.courseId,
    skillId: key.skillId,
    language,
  }), [key.courseId, key.kind, key.skillId, language]);
  const [draft, setDraftState] = useState<CachedLearnerDraft | null>(null);
  const draftRef = useRef<CachedLearnerDraft | null>(null);
  const [status, setStatus] = useState<DraftSyncStatus>("loading");
  const [serverCopy, setServerCopy] = useState<LearnerDraftRecord | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [loadRetryTick, setLoadRetryTick] = useState(0);
  const [retryTick, setRetryTick] = useState(0);
  const syncInFlight = useRef(false);
  const generation = useRef(0);

  const storeDraft = useCallback((next: CachedLearnerDraft | null) => {
    draftRef.current = next;
    setDraftState(next);
    if (!namespace || !next) return;
    cache(window.sessionStorage, namespace, draftKey, next);
  }, [draftKey, namespace]);

  const denyAndPurge = useCallback((nextStatus: "reauthenticate" | "exam-locked") => {
    generation.current += 1;
    if (namespace) {
      // A 401/403 invalidates the complete session namespace, not merely the
      // editor that happened to observe the denial first. This prevents other
      // course drafts from surviving an administrator/session revocation.
      try { clearDraftCaches(window.sessionStorage, namespace); } catch { /* unavailable storage */ }
    }
    draftRef.current = null;
    setDraftState(null);
    setServerCopy(null);
    setStatus(nextStatus);
    setHydrated(false);
  }, [namespace]);

  useEffect(() => {
    const loadGeneration = generation.current + 1;
    generation.current = loadGeneration;
    syncInFlight.current = false;

    let cached: CachedLearnerDraft | null = null;
    if (namespace) {
      try { cached = readDraftCache(window.sessionStorage, namespace, draftKey); } catch { cached = null; }
    }
    draftRef.current = cached;
    queueMicrotask(() => {
      if (generation.current !== loadGeneration) return;
      setHydrated(!namespace);
      setServerCopy(null);
      setStatus(namespace ? "loading" : "unavailable");
      setDraftState(cached);
    });

    if (!namespace) return;

    const controller = new AbortController();
    void fetch(`/api/drafts?${queryString(draftKey)}`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json().catch(() => ({})) as GetResponse;
      if (generation.current !== loadGeneration) return;
      if (response.status === 401 || response.status === 403) {
        denyAndPurge("reauthenticate");
        return;
      }
      if (response.status === 423 || body.code === "EXAM_CLOSED_BOOK") {
        denyAndPurge("exam-locked");
        return;
      }
      if (body.code === "DRAFT_SCOPE_UNAVAILABLE") {
        setStatus("scope-unavailable");
        setHydrated(true);
        return;
      }
      if (!response.ok || body.cacheNamespace !== namespace) {
        setStatus(navigator.onLine ? "unavailable" : "offline");
        setHydrated(true);
        return;
      }

      const currentLocal = draftRef.current;
      if (currentLocal?.dirty) {
        // Preserve local text and its request id. PUT will either replay an
        // already-accepted mutation or return an explicit version conflict.
        setStatus(navigator.onLine ? "local" : "offline");
      } else if (body.draft) {
        storeDraft({
          schemaVersion: 1,
          content: body.draft.content,
          language: body.draft.language,
          baseRowVersion: body.draft.rowVersion,
          requestId: newRequestId(),
          locallyUpdatedAt: body.draft.updatedAt,
          dirty: false,
        });
        setStatus("synced");
      } else {
        draftRef.current = null;
        setDraftState(null);
        setStatus("synced");
      }
      setHydrated(true);
      setRetryTick((value) => value + 1);
    }).catch((error: unknown) => {
      if (generation.current !== loadGeneration || (error instanceof DOMException && error.name === "AbortError")) return;
      setStatus(navigator.onLine ? "unavailable" : "offline");
      setHydrated(true);
    });

    return () => controller.abort();
  }, [denyAndPurge, draftKey, loadRetryTick, namespace, storeDraft]);

  useEffect(() => {
    const pending = draftRef.current;
    if (!namespace || !hydrated || !pending?.dirty || !["local", "offline"].includes(status) || syncInFlight.current) return;
    if (!navigator.onLine) {
      const offlineGeneration = generation.current;
      queueMicrotask(() => {
        if (generation.current === offlineGeneration) setStatus("offline");
      });
      return;
    }
    const syncGeneration = generation.current;
    const timer = window.setTimeout(() => {
      syncInFlight.current = true;
      setStatus("syncing");
      void fetch("/api/drafts", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...draftKey,
          content: pending.content,
          expectedRowVersion: pending.baseRowVersion,
          requestId: pending.requestId,
        }),
      }).then(async (response) => {
        const body = await response.json().catch(() => ({})) as PutResponse;
        if (generation.current !== syncGeneration) return;
        if (response.status === 401 || response.status === 403) {
          denyAndPurge("reauthenticate");
          return;
        }
        if (response.status === 423 || body.code === "EXAM_CLOSED_BOOK") {
          denyAndPurge("exam-locked");
          return;
        }
        if (body.code === "DRAFT_SCOPE_UNAVAILABLE") {
          setStatus("scope-unavailable");
          return;
        }
        if (response.status === 409) {
          setServerCopy(body.current ?? null);
          setStatus("conflict");
          return;
        }
        if (!response.ok
          || body.cacheNamespace !== namespace
          || !body.draft
          || !Number.isSafeInteger(body.committedRowVersion)) {
          setStatus(navigator.onLine ? "unavailable" : "offline");
          return;
        }

        const latest = draftRef.current;
        if (!latest) return;
        const committedVersion = Number(body.committedRowVersion);
        if (latest.requestId === pending.requestId) {
          // An old receipt can be replayed after somebody else saved a newer
          // version. Never replace local text with that newer server copy.
          if (body.draft.rowVersion !== committedVersion || body.draft.content !== pending.content) {
            setServerCopy(body.draft);
            setStatus("conflict");
            return;
          }
          storeDraft({
            ...latest,
            baseRowVersion: body.draft.rowVersion,
            locallyUpdatedAt: body.draft.updatedAt,
            dirty: false,
          });
          setStatus("synced");
          return;
        }

        // The learner typed while this request was in flight. Advance the
        // base version but preserve the newer text and its distinct request.
        storeDraft({ ...latest, baseRowVersion: committedVersion, dirty: true });
        setStatus("local");
        setRetryTick((value) => value + 1);
      }).catch(() => {
        if (generation.current === syncGeneration) {
          setStatus(navigator.onLine ? "unavailable" : "offline");
        }
      }).finally(() => {
        syncInFlight.current = false;
      });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [denyAndPurge, draftKey, hydrated, namespace, retryTick, status, storeDraft]);

  useEffect(() => {
    const retry = () => {
      if (draftRef.current?.dirty && status !== "conflict") {
        setStatus("local");
        setRetryTick((value) => value + 1);
      }
    };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [status]);

  const setContent = useCallback((content: string) => {
    if (status === "reauthenticate" || status === "exam-locked") return;
    const current = draftRef.current;
    const next: CachedLearnerDraft = {
      schemaVersion: 1,
      content,
      language,
      baseRowVersion: current?.baseRowVersion ?? 0,
      requestId: newRequestId(),
      locallyUpdatedAt: new Date().toISOString(),
      dirty: true,
    };
    storeDraft(next);
    setServerCopy(null);
    if (status === "scope-unavailable") {
      setStatus("scope-unavailable");
      return;
    }
    setStatus(!namespace ? "unavailable" : navigator.onLine ? "local" : "offline");
    setRetryTick((value) => value + 1);
  }, [language, namespace, status, storeDraft]);

  const useServerCopy = useCallback(() => {
    if (!serverCopy) return;
    storeDraft({
      schemaVersion: 1,
      content: serverCopy.content,
      language: serverCopy.language,
      baseRowVersion: serverCopy.rowVersion,
      requestId: newRequestId(),
      locallyUpdatedAt: serverCopy.updatedAt,
      dirty: false,
    });
    setServerCopy(null);
    setStatus("synced");
  }, [serverCopy, storeDraft]);

  const keepLocalCopy = useCallback(() => {
    const current = draftRef.current;
    if (!current || !serverCopy) return;
    storeDraft({
      ...current,
      baseRowVersion: serverCopy.rowVersion,
      requestId: newRequestId(),
      locallyUpdatedAt: new Date().toISOString(),
      dirty: true,
    });
    setServerCopy(null);
    setStatus("local");
    setRetryTick((value) => value + 1);
  }, [serverCopy, storeDraft]);

  const retry = useCallback(() => {
    if (draftRef.current?.dirty) {
      setStatus(navigator.onLine ? "local" : "offline");
      setRetryTick((value) => value + 1);
      return;
    }
    setStatus("loading");
    setLoadRetryTick((value) => value + 1);
  }, []);

  return {
    content: draft?.content ?? initialContent,
    setContent,
    status,
    serverCopy,
    useServerCopy,
    keepLocalCopy,
    retry,
  } as const;
}
