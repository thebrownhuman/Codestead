import {
  clearEmergencyExamEvents,
} from "./emergency-events";
import type { BrowserOutboxRepository } from "./indexed-db";
import {
  isBrowserOutboxNamespace,
  isExamSessionId,
} from "./types";
import {
  clearDraftCaches,
  clearForeignDraftCaches,
} from "@/lib/drafts/browser-cache";

export type BrowserRecoveryBoundary =
  | { kind: "all" }
  | { kind: "namespace"; namespace: string }
  | { kind: "drafts"; namespace: string }
  | { kind: "exam"; namespace: string; sessionId: string };

export type BrowserRecoveryWriteScope =
  | { kind: "drafts"; namespace: string }
  | { kind: "exam"; namespace: string; sessionId: string };

type CleanupLayer = "session-storage" | "indexed-db" | "local-storage";

export interface BrowserRecoveryBoundaryChannel {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  close(): void;
}

type BoundaryEnvelope = Readonly<{
  schemaVersion: 1;
  origin: string;
  generation: number;
  nonce: string;
  sourceId: string;
  createdAt: string;
  boundary: BrowserRecoveryBoundary;
}>;

export type BrowserRecoveryWriteFence = Readonly<{
  scope: BrowserRecoveryWriteScope;
  snapshot: ReadonlyArray<readonly [string, string | null]>;
  memorySnapshot: ReadonlyArray<readonly [string, number]>;
}>;

export type BrowserRecoveryBoundaryContext = Readonly<{
  subscribe(listener: (boundary: BrowserRecoveryBoundary) => void): () => void;
  subscribeAfterFence(
    fence: BrowserRecoveryWriteFence,
    listener: (boundary: BrowserRecoveryBoundary) => void,
  ): () => void;
  captureWriteFence(scope: BrowserRecoveryWriteScope): BrowserRecoveryWriteFence;
  isWriteFenceCurrent(fence: BrowserRecoveryWriteFence): boolean;
  guardWrite<T>(
    fence: BrowserRecoveryWriteFence,
    operation: () => Promise<T>,
    rollback: () => unknown | Promise<unknown>,
  ): Promise<T>;
  guardSynchronousWrite<T>(
    fence: BrowserRecoveryWriteFence,
    operation: () => T,
    rollback: () => unknown,
  ): T;
  close(): void;
}>;

const CHANNEL_NAME = "codestead-browser-recovery-boundary-v1";
const TOMBSTONE_PREFIX = "codestead:browser-recovery-boundary:v1:";
const GLOBAL_COMPACTION_KEY = "codestead:browser-recovery-compaction:v1";
const SESSION_GENERATION_PREFIX = "codestead:browser-recovery-session:v1:";
const ENVELOPE_KEYS = [
  "boundary",
  "createdAt",
  "generation",
  "nonce",
  "origin",
  "schemaVersion",
  "sourceId",
] as const;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const NONCE_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const COMPACTION_KEYS = [
  "globalNonce",
  "origin",
  "phase",
  "schemaVersion",
  "sourceId",
] as const;

type GlobalCompactionState = Readonly<{
  schemaVersion: 1;
  origin: string;
  phase: "active" | "complete";
  globalNonce: string;
  sourceId: string;
}>;

const fenceOwners = new WeakMap<object, BrowserRecoveryBoundaryContext>();

function validOrigin(origin: string) {
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && (parsed.protocol === "https:" || parsed.protocol === "http:");
  } catch {
    return false;
  }
}

function validBoundary(value: unknown): value is BrowserRecoveryBoundary {
  if (!value || typeof value !== "object") return false;
  const boundary = value as Record<string, unknown>;
  if (boundary.kind === "all") return Object.keys(boundary).length === 1;
  if (boundary.kind === "namespace" || boundary.kind === "drafts") {
    return Object.keys(boundary).length === 2
      && typeof boundary.namespace === "string"
      && isBrowserOutboxNamespace(boundary.namespace);
  }
  return boundary.kind === "exam"
    && Object.keys(boundary).length === 3
    && typeof boundary.namespace === "string"
    && isBrowserOutboxNamespace(boundary.namespace)
    && typeof boundary.sessionId === "string"
    && isExamSessionId(boundary.sessionId);
}

function requireBoundary(boundary: BrowserRecoveryBoundary) {
  if (!validBoundary(boundary)) throw new Error("Browser recovery boundary is invalid.");
}

function requireWriteScope(scope: BrowserRecoveryWriteScope) {
  requireBoundary(scope);
}

function tombstoneKey(boundary: BrowserRecoveryBoundary) {
  if (boundary.kind === "all") return `${TOMBSTONE_PREFIX}all`;
  if (boundary.kind === "exam") {
    return `${TOMBSTONE_PREFIX}exam:${encodeURIComponent(boundary.namespace)}:${encodeURIComponent(boundary.sessionId)}`;
  }
  return `${TOMBSTONE_PREFIX}${boundary.kind}:${encodeURIComponent(boundary.namespace)}`;
}

function relevantTombstoneKeys(scope: BrowserRecoveryWriteScope) {
  const keys = [
    GLOBAL_COMPACTION_KEY,
    tombstoneKey({ kind: "all" }),
    tombstoneKey({ kind: "namespace", namespace: scope.namespace }),
  ];
  if (scope.kind === "drafts") {
    keys.push(tombstoneKey({ kind: "drafts", namespace: scope.namespace }));
  } else {
    keys.push(tombstoneKey({
      kind: "exam",
      namespace: scope.namespace,
      sessionId: scope.sessionId,
    }));
  }
  return keys;
}

function sessionGenerationKey(namespace: string) {
  return `${SESSION_GENERATION_PREFIX}${encodeURIComponent(namespace)}`;
}

function snapshotScopedTombstones(storage: Storage) {
  const globalKey = tombstoneKey({ kind: "all" });
  const snapshot = new Map<string, string>();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(TOMBSTONE_PREFIX) || key === globalKey) continue;
    const raw = storage.getItem(key);
    if (raw !== null) snapshot.set(key, raw);
  }
  return [...snapshot.entries()] as Array<readonly [string, string]>;
}

function pruneScopedTombstones(
  storage: Storage,
  snapshot: ReadonlyArray<readonly [string, string]>,
) {
  let failed = false;
  for (const [key, raw] of snapshot) {
    try {
      if (storage.getItem(key) === raw) storage.removeItem(key);
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error("Browser recovery tombstone compaction failed.");
}

function parseGlobalCompactionState(
  raw: string | null,
  expectedOrigin: string,
): GlobalCompactionState | null {
  if (typeof raw !== "string" || raw.length < 2 || raw.length > 2_048) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const state = parsed as Record<string, unknown>;
  const keys = Object.keys(state).sort();
  if (keys.length !== COMPACTION_KEYS.length
    || !COMPACTION_KEYS.every((key, index) => keys[index] === key)) return null;
  if (state.schemaVersion !== 1
    || state.origin !== expectedOrigin
    || (state.phase !== "active" && state.phase !== "complete")
    || typeof state.globalNonce !== "string"
    || !NONCE_PATTERN.test(state.globalNonce)
    || typeof state.sourceId !== "string"
    || !SOURCE_ID_PATTERN.test(state.sourceId)) return null;
  return state as GlobalCompactionState;
}

function compactionAllowsWrites(storage: Storage, origin: string) {
  const raw = storage.getItem(GLOBAL_COMPACTION_KEY);
  if (raw === null) return true;
  const state = parseGlobalCompactionState(raw, origin);
  if (!state || state.phase !== "complete") return false;
  const globalEnvelope = parseEnvelope(
    storage.getItem(tombstoneKey({ kind: "all" })),
    origin,
  );
  return globalEnvelope?.boundary.kind === "all"
    && globalEnvelope.nonce === state.globalNonce;
}

function parseEnvelope(raw: unknown, expectedOrigin: string): BoundaryEnvelope | null {
  if (typeof raw !== "string" || raw.length < 2 || raw.length > 4_096) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const envelope = parsed as Record<string, unknown>;
  const keys = Object.keys(envelope).sort();
  if (keys.length !== ENVELOPE_KEYS.length
    || !ENVELOPE_KEYS.every((key, index) => keys[index] === key)) return null;
  if (envelope.schemaVersion !== 1
    || envelope.origin !== expectedOrigin
    || typeof envelope.generation !== "number"
    || !Number.isSafeInteger(envelope.generation)
    || envelope.generation < 1
    || typeof envelope.nonce !== "string"
    || !NONCE_PATTERN.test(envelope.nonce)
    || typeof envelope.sourceId !== "string"
    || !SOURCE_ID_PATTERN.test(envelope.sourceId)
    || typeof envelope.createdAt !== "string"
    || !Number.isFinite(Date.parse(envelope.createdAt))
    || !validBoundary(envelope.boundary)) return null;
  return envelope as BoundaryEnvelope;
}

function newIdentifier(label: string) {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error(`Browser recovery ${label} is unavailable.`);
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function createNativeChannel(): BrowserRecoveryBoundaryChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  return {
    postMessage: (message) => channel.postMessage(message),
    addEventListener: (_type, listener) => channel.addEventListener("message", listener),
    removeEventListener: (_type, listener) => channel.removeEventListener("message", listener),
    close: () => channel.close(),
  };
}

function boundaryMatchesScope(
  boundary: BrowserRecoveryBoundary,
  scope: BrowserRecoveryWriteScope,
) {
  if (boundary.kind === "all") return true;
  if (boundary.kind === "namespace") return boundary.namespace === scope.namespace;
  if (boundary.kind === "drafts") {
    return scope.kind === "drafts" && boundary.namespace === scope.namespace;
  }
  return scope.kind === "exam"
    && boundary.namespace === scope.namespace
    && boundary.sessionId === scope.sessionId;
}

function boundaryClosedError() {
  return new DOMException("Browser recovery generation retired.", "AbortError");
}

export function createBrowserRecoveryBoundaryContext(input: {
  origin: string;
  localStorage: Storage;
  sessionStorage: Storage;
  channel?: BrowserRecoveryBoundaryChannel | null;
  sourceId?: string;
}): BrowserRecoveryBoundaryContext & {
  publish(boundary: BrowserRecoveryBoundary): CleanupLayer[];
} {
  if (!validOrigin(input.origin)) throw new Error("Browser recovery origin is invalid.");
  const sourceId = input.sourceId ?? newIdentifier("source identifier");
  if (!SOURCE_ID_PATTERN.test(sourceId)) {
    throw new Error("Browser recovery source identifier is invalid.");
  }
  const channel = input.channel === undefined ? createNativeChannel() : input.channel;
  const subscribers = new Set<(boundary: BrowserRecoveryBoundary) => void>();
  const seenNonces = new Set<string>();
  const memoryEpochs = new Map<string, number>();
  let memoryEpoch = 0;
  let closed = false;

  const snapshot = (scope: BrowserRecoveryWriteScope) => relevantTombstoneKeys(scope)
    .map((key) => [key, input.localStorage.getItem(key)] as const);

  const memorySnapshot = (scope: BrowserRecoveryWriteScope) => relevantTombstoneKeys(scope)
    .map((key) => [key, memoryEpochs.get(key) ?? 0] as const);

  const advanceMemoryBoundary = (boundary: BrowserRecoveryBoundary) => {
    memoryEpoch += 1;
    if (boundary.kind === "all") memoryEpochs.clear();
    memoryEpochs.set(tombstoneKey(boundary), memoryEpoch);
  };

  const sessionFingerprint = (namespace: string) => JSON.stringify(snapshot({
    kind: "drafts",
    namespace,
  }));

  const reconcileDraftSession = (namespace: string, forceClear = false) => {
    const markerKey = sessionGenerationKey(namespace);
    const next = sessionFingerprint(namespace);
    const previous = input.sessionStorage.getItem(markerKey);
    const hasBoundary = snapshot({ kind: "drafts", namespace })
      .some(([, value]) => value !== null);
    if (forceClear || (previous === null ? hasBoundary : previous !== next)) {
      clearDraftCaches(input.sessionStorage, namespace);
    }
    input.sessionStorage.setItem(markerKey, next);
  };

  const dispatch = (boundary: BrowserRecoveryBoundary) => {
    for (const listener of subscribers) {
      try {
        listener(boundary);
      } catch {
        // One retiring writer must not prevent other writers from being fenced.
      }
    }
  };

  const accept = (raw: string, envelope: BoundaryEnvelope) => {
    if (seenNonces.has(envelope.nonce)) return;
    seenNonces.add(envelope.nonce);
    if (seenNonces.size > 256) seenNonces.delete(seenNonces.values().next().value!);
    let sessionFailure: unknown;
    try {
      if (envelope.boundary.kind === "all") {
        clearDraftCaches(input.sessionStorage);
      } else if (envelope.boundary.kind === "namespace"
        || envelope.boundary.kind === "drafts") {
        reconcileDraftSession(envelope.boundary.namespace, true);
      }
    } catch (error) {
      sessionFailure = error;
    }
    dispatch(envelope.boundary);
    if (sessionFailure !== undefined) throw sessionFailure;
    // Keep the raw value live until after local dispatch so a synchronous writer
    // cannot observe the new boundary and then be accepted under an older value.
    if (input.localStorage.getItem(tombstoneKey(envelope.boundary)) !== raw) {
      throw new Error("Browser recovery boundary changed during dispatch.");
    }
  };

  const receive = (event: MessageEvent<unknown>) => {
    if (closed) return;
    const envelope = parseEnvelope(event.data, input.origin);
    if (!envelope) return;
    const raw = event.data as string;
    if (input.localStorage.getItem(tombstoneKey(envelope.boundary)) !== raw) return;
    try {
      accept(raw, envelope);
    } catch {
      // The durable generation still fences writers. A later capture retries the
      // tab-local session cleanup before permitting new recovery writes.
    }
  };
  channel?.addEventListener("message", receive);

  const context: BrowserRecoveryBoundaryContext & {
    publish(boundary: BrowserRecoveryBoundary): CleanupLayer[];
  } = {
    subscribe(listener) {
      if (closed) throw new Error("Browser recovery boundary context is closed.");
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    subscribeAfterFence(fence, listener) {
      if (closed) throw new Error("Browser recovery boundary context is closed.");
      if (fenceOwners.get(fence) !== context) {
        throw new Error("Browser recovery write fence belongs to another context.");
      }
      return context.subscribe((boundary) => {
        if (!context.isWriteFenceCurrent(fence)) listener(boundary);
      });
    },
    captureWriteFence(scope) {
      if (closed) throw new Error("Browser recovery boundary context is closed.");
      requireWriteScope(scope);
      if (scope.kind === "drafts") reconcileDraftSession(scope.namespace);
      const fence: BrowserRecoveryWriteFence = {
        scope,
        snapshot: snapshot(scope),
        memorySnapshot: memorySnapshot(scope),
      };
      fenceOwners.set(fence, context);
      return fence;
    },
    isWriteFenceCurrent(fence) {
      if (closed || fenceOwners.get(fence) !== context) return false;
      return compactionAllowsWrites(input.localStorage, input.origin)
        && fence.snapshot.every(([key, value]) => input.localStorage.getItem(key) === value)
        && fence.memorySnapshot.every(([key, value]) => (
          (memoryEpochs.get(key) ?? 0) === value
        ));
    },
    async guardWrite<T>(fence: BrowserRecoveryWriteFence, operation: () => Promise<T>, rollback: () => unknown | Promise<unknown>) {
      if (!context.isWriteFenceCurrent(fence)) throw boundaryClosedError();
      let result: T;
      try {
        result = await operation();
      } catch (error) {
        if (context.isWriteFenceCurrent(fence)) throw error;
        try {
          await rollback();
        } catch {
          throw new DOMException("Browser recovery rollback failed.", "InvalidStateError");
        }
        throw boundaryClosedError();
      }
      if (context.isWriteFenceCurrent(fence)) return result;
      try {
        await rollback();
      } catch {
        throw new DOMException("Browser recovery rollback failed.", "InvalidStateError");
      }
      throw boundaryClosedError();
    },
    guardSynchronousWrite<T>(fence: BrowserRecoveryWriteFence, operation: () => T, rollback: () => unknown) {
      if (!context.isWriteFenceCurrent(fence)) throw boundaryClosedError();
      const result = operation();
      if (context.isWriteFenceCurrent(fence)) return result;
      try {
        rollback();
      } catch {
        throw new DOMException("Browser recovery rollback failed.", "InvalidStateError");
      }
      throw boundaryClosedError();
    },
    publish(boundary) {
      requireBoundary(boundary);
      advanceMemoryBoundary(boundary);
      const failed = new Set<CleanupLayer>();
      const key = tombstoneKey(boundary);
      let raw = "";
      let envelope: BoundaryEnvelope;
      let scopedSnapshot: ReadonlyArray<readonly [string, string]> = [];
      let activeCompactionRaw: string | null = null;
      try {
        const previousRaw = input.localStorage.getItem(key);
        const previous = parseEnvelope(previousRaw, input.origin);
        const generation = previous?.generation === Number.MAX_SAFE_INTEGER
          ? 1
          : (previous?.generation ?? 0) + 1;
        envelope = {
          schemaVersion: 1,
          origin: input.origin,
          generation,
          nonce: newIdentifier("boundary nonce"),
          sourceId,
          createdAt: new Date().toISOString(),
          boundary,
        };
        raw = JSON.stringify(envelope);
        if (boundary.kind === "all") {
          scopedSnapshot = snapshotScopedTombstones(input.localStorage);
          activeCompactionRaw = JSON.stringify({
            schemaVersion: 1,
            origin: input.origin,
            phase: "active",
            globalNonce: envelope.nonce,
            sourceId,
          } satisfies GlobalCompactionState);
          input.localStorage.setItem(GLOBAL_COMPACTION_KEY, activeCompactionRaw);
          if (input.localStorage.getItem(GLOBAL_COMPACTION_KEY) !== activeCompactionRaw) {
            throw new Error("Browser recovery compaction did not start durably.");
          }
        }
        input.localStorage.setItem(key, raw);
        if (input.localStorage.getItem(key) !== raw) {
          throw new Error("Browser recovery boundary was not durably stored.");
        }
      } catch {
        failed.add("local-storage");
        dispatch(boundary);
        return [...failed];
      }
      try {
        accept(raw, envelope!);
      } catch {
        failed.add("session-storage");
      }
      try {
        channel?.postMessage(raw);
      } catch {
        failed.add("local-storage");
      }
      if (boundary.kind === "all") {
        try {
          pruneScopedTombstones(input.localStorage, scopedSnapshot);
          const completeCompactionRaw = JSON.stringify({
            schemaVersion: 1,
            origin: input.origin,
            phase: "complete",
            globalNonce: envelope!.nonce,
            sourceId,
          } satisfies GlobalCompactionState);
          input.localStorage.setItem(GLOBAL_COMPACTION_KEY, completeCompactionRaw);
          if (input.localStorage.getItem(GLOBAL_COMPACTION_KEY) !== completeCompactionRaw) {
            throw new Error("Browser recovery compaction did not finish durably.");
          }
        } catch {
          failed.add("local-storage");
        }
      }
      return [...failed];
    },
    close() {
      if (closed) return;
      closed = true;
      channel?.removeEventListener("message", receive);
      channel?.close();
      subscribers.clear();
    },
  };
  return context;
}

let defaultBoundaryContext: ReturnType<typeof createBrowserRecoveryBoundaryContext> | null = null;

function defaultContext() {
  if (typeof window === "undefined") {
    throw new Error("Browser recovery boundary context is unavailable.");
  }
  if (!defaultBoundaryContext) {
    defaultBoundaryContext = createBrowserRecoveryBoundaryContext({
      origin: window.location.origin,
      localStorage: window.localStorage,
      sessionStorage: window.sessionStorage,
    });
  }
  return defaultBoundaryContext;
}

function contextFor(input: {
  sessionStorage: Storage;
  localStorage?: Storage;
  boundaryContext?: ReturnType<typeof createBrowserRecoveryBoundaryContext>;
}) {
  if (input.boundaryContext) return { context: input.boundaryContext, owned: false };
  const localStorage = input.localStorage
    ?? (typeof window === "undefined" ? null : window.localStorage);
  if (!localStorage) throw new Error("Browser recovery local storage is unavailable.");
  if (typeof window !== "undefined"
    && input.sessionStorage === window.sessionStorage
    && localStorage === window.localStorage) {
    return { context: defaultContext(), owned: false };
  }
  const context = createBrowserRecoveryBoundaryContext({
    origin: typeof window === "undefined" ? "https://codestead.invalid" : window.location.origin,
    localStorage,
    sessionStorage: input.sessionStorage,
    channel: null,
  });
  return { context, owned: true };
}

export function subscribeBrowserRecoveryBoundary(
  listener: (boundary: BrowserRecoveryBoundary) => void,
): () => void {
  return defaultContext().subscribe(listener);
}

export function subscribeBrowserRecoveryBoundaryAfterFence(
  fence: BrowserRecoveryWriteFence,
  listener: (boundary: BrowserRecoveryBoundary) => void,
): () => void {
  const owner = fenceOwners.get(fence);
  if (!owner) throw boundaryClosedError();
  return owner.subscribeAfterFence(fence, listener);
}

export function captureBrowserRecoveryWriteFence(
  scope: BrowserRecoveryWriteScope,
): BrowserRecoveryWriteFence {
  return defaultContext().captureWriteFence(scope);
}

export function isBrowserRecoveryWriteFenceCurrent(
  fence: BrowserRecoveryWriteFence,
) {
  return fenceOwners.get(fence)?.isWriteFenceCurrent(fence) ?? false;
}

export async function guardBrowserRecoveryWrite<T>(
  fence: BrowserRecoveryWriteFence,
  operation: () => Promise<T>,
  rollback: () => unknown | Promise<unknown>,
) {
  const owner = fenceOwners.get(fence);
  if (!owner) throw boundaryClosedError();
  return owner.guardWrite(fence, operation, rollback);
}

export function guardSynchronousBrowserRecoveryWrite<T>(
  fence: BrowserRecoveryWriteFence,
  operation: () => T,
  rollback: () => unknown,
) {
  const owner = fenceOwners.get(fence);
  if (!owner) throw boundaryClosedError();
  return owner.guardSynchronousWrite(fence, operation, rollback);
}

function unavailableBrowserOutboxRepository(): BrowserOutboxRepository {
  const unavailable = async (): Promise<never> => {
    throw new Error("Browser recovery IndexedDB is unavailable.");
  };
  return {
    getDraft: unavailable,
    putDraft: unavailable,
    deleteDraftIfMutation: unavailable,
    listExamAnswers: unavailable,
    putExamAnswer: unavailable,
    deleteExamAnswerIfMutation: unavailable,
    listExamEvents: unavailable,
    putExamEvent: unavailable,
    deleteExamEvent: unavailable,
    clearExamSession: unavailable,
    clearDrafts: unavailable,
    clearNamespace: unavailable,
    clearForeignNamespaces: unavailable,
    clearAll: unavailable,
    close: () => undefined,
  } satisfies BrowserOutboxRepository;
}

export async function withBrowserRecoveryRepository<T>(
  openRepository: () => Promise<BrowserOutboxRepository>,
  operation: (repository: BrowserOutboxRepository) => Promise<T>,
): Promise<T> {
  let openedRepository: BrowserOutboxRepository | null = null;
  let repository: BrowserOutboxRepository;
  try {
    openedRepository = await openRepository();
    repository = openedRepository;
  } catch {
    repository = unavailableBrowserOutboxRepository();
  }
  try {
    return await operation(repository);
  } finally {
    openedRepository?.close();
  }
}

async function runCleanupLayers(
  layers: ReadonlyArray<readonly [CleanupLayer, () => unknown | Promise<unknown>]>,
  initialFailures: ReadonlyArray<CleanupLayer> = [],
) {
  const settled = await Promise.allSettled(layers.map(([, operation]) => (
    Promise.resolve().then(operation)
  )));
  const failed = new Set<CleanupLayer>(initialFailures);
  settled.forEach((result, index) => {
    if (result.status === "rejected") failed.add(layers[index]![0]);
  });
  if (failed.size > 0) {
    throw new Error(`Browser recovery cleanup failed: ${[...failed].join(", ")}.`);
  }
}

export async function purgeBrowserRecoveryData(input: {
  namespace?: string;
  sessionStorage: Storage;
  localStorage: Storage;
  repository: BrowserOutboxRepository;
  boundaryContext?: ReturnType<typeof createBrowserRecoveryBoundaryContext>;
}) {
  const boundary: BrowserRecoveryBoundary = input.namespace
    ? { kind: "namespace", namespace: input.namespace }
    : { kind: "all" };
  const resolved = contextFor(input);
  const publicationFailures = resolved.context.publish(boundary);
  try {
    await runCleanupLayers([
      ["session-storage", () => clearDraftCaches(input.sessionStorage, input.namespace)],
      ["indexed-db", () => input.namespace
        ? input.repository.clearNamespace(input.namespace)
        : input.repository.clearAll()],
      ["local-storage", () => clearEmergencyExamEvents(
        input.localStorage,
        input.namespace
          ? { kind: "namespace", namespace: input.namespace }
          : { kind: "all" },
      )],
    ], publicationFailures);
  } finally {
    if (resolved.owned) resolved.context.close();
  }
}

export async function prepareBrowserRecoveryNamespace(input: {
  namespace: string;
  sessionStorage: Storage;
  localStorage: Storage;
  repository: BrowserOutboxRepository;
}) {
  const resolved = contextFor(input);
  try {
    resolved.context.captureWriteFence({ kind: "drafts", namespace: input.namespace });
    await runCleanupLayers([
      ["session-storage", () => clearForeignDraftCaches(
        input.sessionStorage,
        input.namespace,
      )],
      ["indexed-db", () => input.repository.clearForeignNamespaces(input.namespace)],
      ["local-storage", () => clearEmergencyExamEvents(input.localStorage, {
        kind: "foreign-namespaces",
        currentNamespace: input.namespace,
      })],
    ]);
  } finally {
    if (resolved.owned) resolved.context.close();
  }
}

export async function purgeDraftRecoveryData(input: {
  namespace: string;
  sessionStorage: Storage;
  repository: BrowserOutboxRepository;
  boundaryContext?: ReturnType<typeof createBrowserRecoveryBoundaryContext>;
}) {
  const resolved = contextFor(input);
  const publicationFailures = resolved.context.publish({
    kind: "drafts",
    namespace: input.namespace,
  });
  try {
    await runCleanupLayers([
      ["session-storage", () => clearDraftCaches(input.sessionStorage, input.namespace)],
      ["indexed-db", () => input.repository.clearDrafts(input.namespace)],
    ], publicationFailures);
  } finally {
    if (resolved.owned) resolved.context.close();
  }
}

export async function purgeExamRecoveryData(input: {
  namespace: string;
  sessionId: string;
  sessionStorage: Storage;
  localStorage: Storage;
  repository: BrowserOutboxRepository;
  boundaryContext?: ReturnType<typeof createBrowserRecoveryBoundaryContext>;
}) {
  const resolved = contextFor({
    sessionStorage: input.sessionStorage,
    localStorage: input.localStorage,
    ...(input.boundaryContext ? { boundaryContext: input.boundaryContext } : {}),
  });
  const publicationFailures = resolved.context.publish({
    kind: "exam",
    namespace: input.namespace,
    sessionId: input.sessionId,
  });
  try {
    await runCleanupLayers([
      ["indexed-db", () => input.repository.clearExamSession(
        input.namespace,
        input.sessionId,
      )],
      ["local-storage", () => clearEmergencyExamEvents(input.localStorage, {
        kind: "exam",
        namespace: input.namespace,
        sessionId: input.sessionId,
      })],
    ], publicationFailures);
  } finally {
    if (resolved.owned) resolved.context.close();
  }
}
