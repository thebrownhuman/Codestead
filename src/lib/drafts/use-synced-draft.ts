"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  openBrowserOutbox,
  type BrowserOutboxRepository,
} from "@/lib/browser-durability/indexed-db";
import type { DraftOutboxRecord } from "@/lib/browser-durability/types";

import {
  cachedDraftToOutbox,
  clearDraftCaches,
  outboxDraftToCached,
  readDraftCache,
  removeDraftCache,
  writeDraftCache,
  type CachedLearnerDraft,
} from "./browser-cache";
import { useDraftCacheNamespace } from "./browser-cache-context";
import type { DraftKey, LearnerDraftRecord } from "./types";

export type DraftSyncStatus =
  | "loading"
  | "saving-local"
  | "saved-local"
  | "syncing"
  | "synced"
  | "offline-saved-local"
  | "local-save-error"
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

type LocalMutation = {
  record: DraftOutboxRecord;
  sequence: number;
  state: "queued" | "committed" | "failed";
};

type NetworkMutation = {
  record: DraftOutboxRecord;
  hasSent: boolean;
};

type DraftRuntime = {
  generation: number;
  namespace: string;
  key: DraftKey;
  retired: boolean;
  authorized: boolean;
  blockedStatus: "scope-unavailable" | null;
  repository: BrowserOutboxRepository | null;
  repositoryPromise: Promise<BrowserOutboxRepository> | null;
  localChain: Promise<void>;
  nextSequence: number;
  latestMutation: LocalMutation | null;
  networkMutation: NetworkMutation | null;
  networkActive: boolean;
  retryIndex: number;
  timer: number | null;
  abortController: AbortController | null;
};

type ContextResult =
  | { kind: "ok"; body: GetResponse }
  | { kind: "retryable" }
  | { kind: "terminal" };

const DRAFT_DEBOUNCE_MS = 650;
const DRAFT_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

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

function isServerDraft(value: unknown, key: DraftKey): value is LearnerDraftRecord {
  if (!value || typeof value !== "object") return false;
  const draft = value as Record<string, unknown>;
  return typeof draft.id === "string"
    && draft.kind === key.kind
    && draft.courseId === key.courseId
    && draft.skillId === key.skillId
    && draft.language === key.language
    && typeof draft.content === "string"
    && Number.isSafeInteger(draft.rowVersion)
    && Number(draft.rowVersion) >= 0
    && typeof draft.createdAt === "string"
    && Number.isFinite(Date.parse(draft.createdAt))
    && typeof draft.updatedAt === "string"
    && Number.isFinite(Date.parse(draft.updatedAt));
}

function cacheWarmDraft(runtime: DraftRuntime, value: CachedLearnerDraft) {
  try {
    writeDraftCache(window.sessionStorage, runtime.namespace, runtime.key, value);
  } catch {
    // sessionStorage is an optional warm mirror, never the durability boundary.
  }
}

function clearTimer(runtime: DraftRuntime) {
  if (runtime.timer !== null) {
    window.clearTimeout(runtime.timer);
    runtime.timer = null;
  }
}

function abortRequest(runtime: DraftRuntime) {
  runtime.abortController?.abort();
  runtime.abortController = null;
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
  const [status, setStatusState] = useState<DraftSyncStatus>("loading");
  const statusRef = useRef<DraftSyncStatus>("loading");
  const [serverCopy, setServerCopy] = useState<LearnerDraftRecord | null>(null);
  const [loadRetryTick, setLoadRetryTick] = useState(0);
  const generationRef = useRef(0);
  const runtimeRef = useRef<DraftRuntime | null>(null);
  const attemptNetworkRef = useRef<(runtime: DraftRuntime) => void>(() => undefined);
  const enqueueRecordRef = useRef<(
    runtime: DraftRuntime,
    record: DraftOutboxRecord,
    delay?: number,
    onCommitted?: () => void,
  ) => Promise<void>>(async () => undefined);

  const isCurrent = useCallback((runtime: DraftRuntime) => (
    runtimeRef.current === runtime
    && generationRef.current === runtime.generation
    && !runtime.retired
  ), []);

  const transition = useCallback((runtime: DraftRuntime, next: DraftSyncStatus) => {
    if (!isCurrent(runtime)) return;
    statusRef.current = next;
    setStatusState(next);
  }, [isCurrent]);

  const applyDraft = useCallback((
    runtime: DraftRuntime,
    next: CachedLearnerDraft | null,
    mirror = true,
  ) => {
    if (!isCurrent(runtime)) return;
    draftRef.current = next;
    setDraftState(next);
    if (next && mirror) cacheWarmDraft(runtime, next);
    if (!next && mirror) {
      try {
        removeDraftCache(window.sessionStorage, runtime.namespace, runtime.key);
      } catch {
        // The authoritative in-memory state still applies when the warm cache is blocked.
      }
    }
  }, [isCurrent]);

  const retireForDenial = useCallback((
    runtime: DraftRuntime,
    nextStatus: "reauthenticate" | "exam-locked",
  ) => {
    if (!isCurrent(runtime)) return;
    clearTimer(runtime);
    abortRequest(runtime);
    runtime.repository?.close();
    runtime.repository = null;
    runtime.repositoryPromise = null;
    try {
      clearDraftCaches(window.sessionStorage, runtime.namespace);
    } catch {
      // The denial still retires all callbacks when warm storage is unavailable.
    }
    draftRef.current = null;
    setDraftState(null);
    setServerCopy(null);
    statusRef.current = nextStatus;
    setStatusState(nextStatus);
    runtime.retired = true;
    generationRef.current += 1;
  }, [isCurrent]);

  const ensureRepository = useCallback(async (runtime: DraftRuntime) => {
    if (runtime.retired) throw new DOMException("Draft generation retired.", "AbortError");
    if (runtime.repository) return runtime.repository;
    if (runtime.repositoryPromise) return runtime.repositoryPromise;

    const opening = openBrowserOutbox();
    runtime.repositoryPromise = opening;
    try {
      const repository = await opening;
      if (!isCurrent(runtime)) {
        repository.close();
        throw new DOMException("Draft generation retired.", "AbortError");
      }
      runtime.repository = repository;
      return repository;
    } finally {
      if (runtime.repositoryPromise === opening) runtime.repositoryPromise = null;
    }
  }, [isCurrent]);

  const fetchContext = useCallback(async (runtime: DraftRuntime): Promise<ContextResult> => {
    if (!isCurrent(runtime)) return { kind: "terminal" };
    const controller = new AbortController();
    runtime.abortController = controller;
    try {
      const response = await fetch(`/api/drafts?${queryString(runtime.key)}`, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({})) as GetResponse;
      if (!isCurrent(runtime)) return { kind: "terminal" };
      if (response.status === 401 || response.status === 403) {
        retireForDenial(runtime, "reauthenticate");
        return { kind: "terminal" };
      }
      if (response.status === 423 || body.code === "EXAM_CLOSED_BOOK") {
        retireForDenial(runtime, "exam-locked");
        return { kind: "terminal" };
      }
      if (body.code === "DRAFT_SCOPE_UNAVAILABLE") {
        runtime.blockedStatus = "scope-unavailable";
        runtime.authorized = false;
        clearTimer(runtime);
        transition(runtime, "scope-unavailable");
        return { kind: "terminal" };
      }
      if (!response.ok || body.cacheNamespace !== runtime.namespace) {
        runtime.authorized = false;
        return { kind: "retryable" };
      }
      if (body.draft !== null && !isServerDraft(body.draft, runtime.key)) {
        runtime.authorized = false;
        return { kind: "retryable" };
      }
      runtime.authorized = true;
      return { kind: "ok", body };
    } catch (error) {
      if (!isCurrent(runtime)
        || (error instanceof DOMException && error.name === "AbortError")) {
        return { kind: "terminal" };
      }
      runtime.authorized = false;
      return { kind: "retryable" };
    } finally {
      if (runtime.abortController === controller) runtime.abortController = null;
    }
  }, [isCurrent, retireForDenial, transition]);

  const scheduleAttempt = useCallback((runtime: DraftRuntime, delay: number) => {
    if (!isCurrent(runtime) || runtime.blockedStatus) return;
    clearTimer(runtime);
    runtime.timer = window.setTimeout(() => {
      runtime.timer = null;
      if (isCurrent(runtime)) attemptNetworkRef.current(runtime);
    }, delay);
  }, [isCurrent]);

  const scheduleRetry = useCallback((runtime: DraftRuntime) => {
    if (!isCurrent(runtime) || runtime.blockedStatus || !runtime.networkMutation) return;
    const delay = DRAFT_RETRY_DELAYS_MS[Math.min(
      runtime.retryIndex,
      DRAFT_RETRY_DELAYS_MS.length - 1,
    )];
    runtime.retryIndex = Math.min(runtime.retryIndex + 1, DRAFT_RETRY_DELAYS_MS.length - 1);
    transition(runtime, "offline-saved-local");
    scheduleAttempt(runtime, delay);
  }, [isCurrent, scheduleAttempt, transition]);

  const enqueueRecord = useCallback((
    runtime: DraftRuntime,
    record: DraftOutboxRecord,
    delay = DRAFT_DEBOUNCE_MS,
    onCommitted?: () => void,
  ) => {
    if (!isCurrent(runtime)) return Promise.resolve();
    const mutation: LocalMutation = {
      record,
      sequence: runtime.nextSequence,
      state: "queued",
    };
    runtime.nextSequence += 1;
    runtime.latestMutation = mutation;

    if (runtime.networkMutation && !runtime.networkMutation.hasSent && !runtime.networkActive) {
      clearTimer(runtime);
      runtime.networkMutation = null;
    }
    if (!runtime.blockedStatus) transition(runtime, "saving-local");

    const write = runtime.localChain
      .catch(() => undefined)
      .then(async () => {
        if (!isCurrent(runtime)) return;
        const repository = await ensureRepository(runtime);
        if (!isCurrent(runtime)) return;
        await repository.putDraft(record);
      });
    runtime.localChain = write.then(() => undefined, () => undefined);

    void write.then(() => {
      mutation.state = "committed";
      if (!isCurrent(runtime) || runtime.latestMutation !== mutation) return;
      onCommitted?.();
      if (statusRef.current === "conflict") return;
      if (runtime.blockedStatus) {
        transition(runtime, runtime.blockedStatus);
        return;
      }
      transition(runtime, "saved-local");
      if (runtime.networkMutation?.hasSent) return;
      runtime.networkMutation = { record, hasSent: false };
      runtime.retryIndex = 0;
      scheduleAttempt(runtime, delay);
    }).catch(() => {
      mutation.state = "failed";
      if (!isCurrent(runtime) || runtime.latestMutation !== mutation) return;
      if (runtime.networkMutation?.record.requestId === record.requestId
        && !runtime.networkMutation.hasSent) {
        runtime.networkMutation = null;
      }
      clearTimer(runtime);
      transition(runtime, "local-save-error");
    });
    return write;
  }, [ensureRepository, isCurrent, scheduleAttempt, transition]);

  const handleAcknowledgement = useCallback(async (
    runtime: DraftRuntime,
    sent: DraftOutboxRecord,
    body: PutResponse,
  ) => {
    if (!isCurrent(runtime) || !body.draft) return;
    const committedVersion = Number(body.committedRowVersion);
    if (body.draft.rowVersion !== committedVersion
      || body.draft.content !== sent.payload.content) {
      runtime.networkMutation = null;
      clearTimer(runtime);
      setServerCopy(body.draft);
      transition(runtime, "conflict");
      return;
    }

    try {
      const repository = await ensureRepository(runtime);
      await repository.deleteDraftIfMutation(runtime.namespace, runtime.key, sent.requestId);
    } catch {
      // The authoritative save remains valid. Exact replay can clean this record later.
    }
    if (!isCurrent(runtime)) return;
    runtime.networkMutation = null;
    runtime.retryIndex = 0;

    while (isCurrent(runtime)) {
      const pendingLocalWrites = runtime.localChain;
      await pendingLocalWrites;
      if (runtime.localChain === pendingLocalWrites) break;
    }
    if (!isCurrent(runtime)) return;
    const latest = runtime.latestMutation;
    if (latest && latest.record.requestId !== sent.requestId) {
      if (latest.state !== "committed") return;
      const rebased: DraftOutboxRecord = {
        ...latest.record,
        payload: {
          ...latest.record.payload,
          baseRevision: committedVersion,
        },
      };
      applyDraft(runtime, outboxDraftToCached(rebased));
      void enqueueRecordRef.current(runtime, rebased, 0);
      return;
    }

    const clean: CachedLearnerDraft = {
      schemaVersion: 1,
      content: sent.payload.content,
      language: sent.payload.key.language,
      baseRowVersion: committedVersion,
      requestId: sent.requestId,
      locallyUpdatedAt: body.draft.updatedAt,
      dirty: false,
    };
    runtime.latestMutation = null;
    applyDraft(runtime, clean);
    setServerCopy(null);
    transition(runtime, "synced");
  }, [applyDraft, ensureRepository, isCurrent, transition]);

  const attemptNetwork = useCallback(async (runtime: DraftRuntime) => {
    if (!isCurrent(runtime)
      || runtime.networkActive
      || runtime.blockedStatus
      || !runtime.networkMutation) return;
    clearTimer(runtime);
    runtime.networkActive = true;
    try {
      if (!runtime.authorized) {
        const context = await fetchContext(runtime);
        if (!isCurrent(runtime) || context.kind === "terminal") return;
        if (context.kind === "retryable") {
          scheduleRetry(runtime);
          return;
        }
      }

      let network = runtime.networkMutation;
      const latest = runtime.latestMutation;
      if (!network.hasSent
        && latest?.state === "committed"
        && latest.record.requestId !== network.record.requestId) {
        network = { record: latest.record, hasSent: false };
        runtime.networkMutation = network;
      }
      network.hasSent = true;
      if (latest?.record.requestId === network.record.requestId) {
        transition(runtime, "syncing");
      }

      const controller = new AbortController();
      runtime.abortController = controller;
      const response = await fetch("/api/drafts", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...runtime.key,
          content: network.record.payload.content,
          expectedRowVersion: network.record.payload.baseRevision,
          requestId: network.record.requestId,
        }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({})) as PutResponse;
      if (runtime.abortController === controller) runtime.abortController = null;
      if (!isCurrent(runtime)) return;
      if (response.status === 401 || response.status === 403) {
        retireForDenial(runtime, "reauthenticate");
        return;
      }
      if (response.status === 423 || body.code === "EXAM_CLOSED_BOOK") {
        retireForDenial(runtime, "exam-locked");
        return;
      }
      if (body.code === "DRAFT_SCOPE_UNAVAILABLE") {
        runtime.blockedStatus = "scope-unavailable";
        runtime.authorized = false;
        runtime.networkMutation = null;
        transition(runtime, "scope-unavailable");
        return;
      }
      if (response.status === 409) {
        runtime.networkMutation = null;
        runtime.retryIndex = 0;
        clearTimer(runtime);
        setServerCopy(isServerDraft(body.current, runtime.key) ? body.current : null);
        transition(runtime, "conflict");
        return;
      }
      if (!response.ok
        || body.cacheNamespace !== runtime.namespace
        || !isServerDraft(body.draft, runtime.key)
        || !Number.isSafeInteger(body.committedRowVersion)
        || Number(body.committedRowVersion) < 0) {
        runtime.authorized = body.cacheNamespace === runtime.namespace;
        scheduleRetry(runtime);
        return;
      }
      await handleAcknowledgement(runtime, network.record, body);
    } catch (error) {
      if (isCurrent(runtime)
        && !(error instanceof DOMException && error.name === "AbortError")) {
        scheduleRetry(runtime);
      }
    } finally {
      runtime.networkActive = false;
    }
  }, [fetchContext, handleAcknowledgement, isCurrent, retireForDenial, scheduleRetry, transition]);

  useEffect(() => {
    attemptNetworkRef.current = attemptNetwork;
    enqueueRecordRef.current = enqueueRecord;
  }, [attemptNetwork, enqueueRecord]);

  const initializeRuntime = useCallback(async (runtime: DraftRuntime) => {
    runtime.networkActive = true;
    let recovered: DraftOutboxRecord | null = null;
    try {
      const repository = await ensureRepository(runtime);
      recovered = await repository.getDraft(runtime.namespace, runtime.key);
      if (recovered && isCurrent(runtime)) {
        runtime.latestMutation = {
          record: recovered,
          sequence: runtime.nextSequence,
          state: "committed",
        };
        runtime.nextSequence += 1;
        runtime.networkMutation = { record: recovered, hasSent: false };
        applyDraft(runtime, outboxDraftToCached(recovered));
      }
    } catch {
      runtime.repository?.close();
      runtime.repository = null;
      runtime.repositoryPromise = null;
      recovered = null;
    }
    if (!isCurrent(runtime)) return;

    const context = await fetchContext(runtime);
    runtime.networkActive = false;
    if (!isCurrent(runtime) || context.kind === "terminal") return;
    if (context.kind === "retryable") {
      if (recovered) scheduleRetry(runtime);
      else transition(runtime, "unavailable");
      return;
    }

    if (recovered) {
      transition(runtime, "saved-local");
      scheduleAttempt(runtime, DRAFT_DEBOUNCE_MS);
      return;
    }

    runtime.latestMutation = null;
    runtime.networkMutation = null;
    if (context.body.draft) {
      applyDraft(runtime, {
        schemaVersion: 1,
        content: context.body.draft.content,
        language: context.body.draft.language,
        baseRowVersion: context.body.draft.rowVersion,
        requestId: newRequestId(),
        locallyUpdatedAt: context.body.draft.updatedAt,
        dirty: false,
      });
    } else {
      applyDraft(runtime, null);
    }
    transition(runtime, "synced");
  }, [applyDraft, ensureRepository, fetchContext, isCurrent, scheduleAttempt, scheduleRetry, transition]);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;

    let warm: CachedLearnerDraft | null = null;
    if (namespace) {
      try {
        warm = readDraftCache(window.sessionStorage, namespace, draftKey);
      } catch {
        warm = null;
      }
    }
    draftRef.current = warm;
    statusRef.current = namespace ? "loading" : "unavailable";
    queueMicrotask(() => {
      if (generationRef.current !== generation) return;
      setDraftState(warm);
      setServerCopy(null);
      setStatusState(namespace ? "loading" : "unavailable");
    });

    if (!namespace) {
      runtimeRef.current = null;
      return;
    }

    const runtime: DraftRuntime = {
      generation,
      namespace,
      key: draftKey,
      retired: false,
      authorized: false,
      blockedStatus: null,
      repository: null,
      repositoryPromise: null,
      localChain: Promise.resolve(),
      nextSequence: 1,
      latestMutation: null,
      networkMutation: null,
      networkActive: false,
      retryIndex: 0,
      timer: null,
      abortController: null,
    };
    runtimeRef.current = runtime;
    void initializeRuntime(runtime);

    return () => {
      if (!runtime.retired) {
        runtime.retired = true;
        clearTimer(runtime);
        abortRequest(runtime);
        runtime.repository?.close();
        runtime.repository = null;
      }
      if (runtimeRef.current === runtime) runtimeRef.current = null;
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [draftKey, initializeRuntime, loadRetryTick, namespace]);

  useEffect(() => {
    const accelerate = () => {
      const runtime = runtimeRef.current;
      if (!runtime
        || !isCurrent(runtime)
        || runtime.networkActive
        || statusRef.current !== "offline-saved-local"
        || !runtime.networkMutation) return;
      clearTimer(runtime);
      attemptNetworkRef.current(runtime);
    };
    window.addEventListener("online", accelerate);
    return () => window.removeEventListener("online", accelerate);
  }, [isCurrent]);

  const setContent = useCallback((content: string) => {
    const currentStatus = statusRef.current;
    if (currentStatus === "reauthenticate"
      || currentStatus === "exam-locked") return;
    if (!namespace) {
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
      draftRef.current = next;
      setDraftState(next);
      setServerCopy(null);
      statusRef.current = "unavailable";
      setStatusState("unavailable");
      return;
    }
    if (currentStatus === "loading") return;
    const runtime = runtimeRef.current;
    if (!runtime || !isCurrent(runtime)) return;

    const current = draftRef.current;
    const next: CachedLearnerDraft = {
      schemaVersion: 1,
      content,
      language: runtime.key.language,
      baseRowVersion: current?.baseRowVersion ?? 0,
      requestId: newRequestId(),
      locallyUpdatedAt: new Date().toISOString(),
      dirty: true,
    };
    applyDraft(runtime, next);
    setServerCopy(null);
    const record = cachedDraftToOutbox(runtime.namespace, runtime.key, next);
    void enqueueRecord(runtime, record);
  }, [applyDraft, enqueueRecord, isCurrent, language, namespace]);

  const useServerCopy = useCallback(() => {
    const runtime = runtimeRef.current;
    const selected = serverCopy;
    const currentMutation = runtime?.latestMutation;
    if (!runtime
      || !selected
      || !currentMutation
      || !isCurrent(runtime)
      || statusRef.current !== "conflict") return;

    clearTimer(runtime);
    runtime.networkMutation = null;
    void ensureRepository(runtime).then(async (repository) => {
      const deleted = await repository.deleteDraftIfMutation(
        runtime.namespace,
        runtime.key,
        currentMutation.record.requestId,
      );
      if (!deleted
        || !isCurrent(runtime)
        || runtime.latestMutation !== currentMutation) return;
      const clean: CachedLearnerDraft = {
        schemaVersion: 1,
        content: selected.content,
        language: selected.language,
        baseRowVersion: selected.rowVersion,
        requestId: newRequestId(),
        locallyUpdatedAt: selected.updatedAt,
        dirty: false,
      };
      runtime.latestMutation = null;
      applyDraft(runtime, clean);
      setServerCopy(null);
      transition(runtime, "synced");
    }).catch(() => {
      if (isCurrent(runtime)) transition(runtime, "conflict");
    });
  }, [applyDraft, ensureRepository, isCurrent, serverCopy, transition]);

  const keepLocalCopy = useCallback(() => {
    const runtime = runtimeRef.current;
    const current = draftRef.current;
    const selected = serverCopy;
    if (!runtime || !current || !selected || !isCurrent(runtime)) return;

    clearTimer(runtime);
    runtime.networkMutation = null;
    runtime.retryIndex = 0;
    const rebased: CachedLearnerDraft = {
      ...current,
      baseRowVersion: selected.rowVersion,
      requestId: newRequestId(),
      locallyUpdatedAt: new Date().toISOString(),
      dirty: true,
    };
    applyDraft(runtime, rebased);
    const record = cachedDraftToOutbox(runtime.namespace, runtime.key, rebased);
    void enqueueRecord(runtime, record, 0, () => setServerCopy(null));
  }, [applyDraft, enqueueRecord, isCurrent, serverCopy]);

  const retry = useCallback(() => {
    const runtime = runtimeRef.current;
    if (statusRef.current === "local-save-error"
      && runtime
      && isCurrent(runtime)
      && runtime.latestMutation?.state === "failed") {
      const record = runtime.latestMutation.record;
      void enqueueRecord(runtime, record);
      return;
    }
    if (statusRef.current === "offline-saved-local"
      && runtime
      && isCurrent(runtime)
      && runtime.networkMutation
      && !runtime.networkActive) {
      clearTimer(runtime);
      attemptNetworkRef.current(runtime);
      return;
    }
    if (statusRef.current === "unavailable") {
      setLoadRetryTick((value) => value + 1);
    }
  }, [enqueueRecord, isCurrent]);

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
