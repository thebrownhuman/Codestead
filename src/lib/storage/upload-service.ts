import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import type { DurableObjectStore } from "./durable-object-store";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type UploadServiceCutpoint = "after_database_commit_before_response";

export type DurableUploadObject = Readonly<{
  id: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  storageKey: string;
  sha256: string;
  scanStatus: string;
}>;

export type UploadReceipt = Readonly<{
  requestHash: string;
  object: DurableUploadObject;
  tombstoned: boolean;
}>;

export interface UploadReceiptRepository {
  find(ownerUserId: string, idempotencyKey: string): Promise<UploadReceipt | null>;
  commit(input: {
    ownerUserId: string;
    idempotencyKey: string;
    requestHash: string;
    object: DurableUploadObject;
  }): Promise<{
    disposition: "created" | "replay" | "tombstoned";
    object: DurableUploadObject;
  }>;
}

export class UploadIdempotencyConflictError extends Error {
  constructor() {
    super("The idempotency key is already bound to a different upload.");
    this.name = "UploadIdempotencyConflictError";
  }
}

export class UploadIdempotencyTombstonedError extends Error {
  constructor() {
    super("The idempotency key belongs to an upload that has been deleted.");
    this.name = "UploadIdempotencyTombstonedError";
  }
}

export class InvalidUploadIdempotencyKeyError extends Error {
  constructor() {
    super("Idempotency-Key must be a UUID.");
    this.name = "InvalidUploadIdempotencyKeyError";
  }
}

export class UploadCommitAmbiguousError extends Error {
  constructor(options?: ErrorOptions) {
    super("The upload commit outcome is ambiguous; retry with the same idempotency key.", options);
    this.name = "UploadCommitAmbiguousError";
  }
}

function hashesEqual(left: string, right: string) {
  const pattern = /^v1:[0-9a-f]{64}$/;
  if (!pattern.test(left) || !pattern.test(right)) return false;
  return timingSafeEqual(Buffer.from(left.slice(3), "hex"), Buffer.from(right.slice(3), "hex"));
}

export function ownerStorageSegment(userId: string) {
  return createHash("sha256")
    .update(`learncoding-storage-owner-v1\0${userId}`)
    .digest("hex");
}

export function uploadRequestHash(input: {
  originalName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  scanStatus: string;
}) {
  const hash = createHash("sha256");
  hash.update("codestead-upload-request-v1\0", "utf8");
  hash.update(JSON.stringify([
    input.originalName,
    input.mediaType,
    input.sizeBytes,
    input.sha256,
    input.scanStatus,
  ]), "utf8");
  return `v1:${hash.digest("hex")}`;
}

export async function createDurableUpload(
  input: {
    ownerUserId: string;
    idempotencyKey: string;
    originalName: string;
    mediaType: string;
    scanStatus: string;
    bytes: Buffer;
  },
  dependencies: {
    store: DurableObjectStore;
    repository: UploadReceiptRepository;
    objectId?: () => string;
    checkpoint?: (point: UploadServiceCutpoint) => Promise<void>;
  },
): Promise<DurableUploadObject & { replayed: boolean }> {
  try {
    if (!UUID_PATTERN.test(input.idempotencyKey)) {
      throw new InvalidUploadIdempotencyKeyError();
    }
    const idempotencyKey = input.idempotencyKey.toLowerCase();
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const requestHash = uploadRequestHash({
      originalName: input.originalName,
      mediaType: input.mediaType,
      sizeBytes: input.bytes.byteLength,
      sha256,
      scanStatus: input.scanStatus,
    });
    const prior = await dependencies.repository.find(input.ownerUserId, idempotencyKey);
    if (prior) {
      if (!hashesEqual(prior.requestHash, requestHash)) {
        throw new UploadIdempotencyConflictError();
      }
      if (prior.tombstoned) {
        throw new UploadIdempotencyTombstonedError();
      }
      return { ...prior.object, replayed: true };
    }

    const objectId = (dependencies.objectId ?? randomUUID)();
    const persisted = await dependencies.store.create({
      ownerSegment: ownerStorageSegment(input.ownerUserId),
      objectId,
      bytes: input.bytes,
    });
    const object: DurableUploadObject = {
      id: objectId,
      name: input.originalName,
      mediaType: input.mediaType,
      sizeBytes: input.bytes.byteLength,
      storageKey: persisted.storageKey,
      sha256,
      scanStatus: input.scanStatus,
    };

    let committed: Awaited<ReturnType<UploadReceiptRepository["commit"]>>;
    try {
      committed = await dependencies.repository.commit({
        ownerUserId: input.ownerUserId,
        idempotencyKey,
        requestHash,
        object,
      });
    } catch (error) {
      if (error instanceof UploadCommitAmbiguousError) throw error;
      await dependencies.store.remove(persisted.storageKey);
      throw error;
    }

    if (committed.disposition !== "created") {
      await dependencies.store.remove(persisted.storageKey);
    }
    if (committed.disposition === "tombstoned") {
      throw new UploadIdempotencyTombstonedError();
    }
    await (dependencies.checkpoint ?? (async () => undefined))(
      "after_database_commit_before_response",
    );
    return { ...committed.object, replayed: committed.disposition === "replay" };
  } finally {
    input.bytes.fill(0);
  }
}
