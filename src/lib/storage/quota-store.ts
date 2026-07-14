import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { learnerProfile, quotaLedger, storedObject } from "@/lib/db/schema";
import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  uploadWouldExceedQuota,
} from "@/lib/storage/policy";

export class StorageQuotaExceededError extends Error {
  constructor() {
    super("The stored object would exceed the learner's storage quota.");
    this.name = "StorageQuotaExceededError";
  }
}

export interface StoredObjectReservation {
  readonly objectId: string;
  readonly userId: string;
  readonly storageKey: string;
  readonly originalName: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly scanStatus: string;
  readonly idempotencyKey?: string;
}

/**
 * Reserves quota and records the object in the same transaction. The
 * per-learner advisory lock serializes competing uploads across app workers.
 */
export async function reserveStoredObject(
  input: StoredObjectReservation,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.userId}))`);
    const [profile] = await tx
      .select({ quota: learnerProfile.storageQuotaBytes })
      .from(learnerProfile)
      .where(eq(learnerProfile.userId, input.userId))
      .limit(1);
    const [usage] = await tx
      .select({ used: sql<number>`coalesce(sum(${storedObject.sizeBytes}), 0)` })
      .from(storedObject)
      .where(
        and(
          eq(storedObject.ownerUserId, input.userId),
          isNull(storedObject.deletedAt),
        ),
      );
    const quota = profile?.quota ?? DEFAULT_STORAGE_QUOTA_BYTES;
    if (uploadWouldExceedQuota(Number(usage?.used ?? 0), input.sizeBytes, quota)) {
      throw new StorageQuotaExceededError();
    }
    await tx.insert(storedObject).values({
      id: input.objectId,
      ownerUserId: input.userId,
      storageKey: input.storageKey,
      originalName: input.originalName,
      mediaType: input.mediaType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      scanStatus: input.scanStatus,
    });
    await tx.insert(quotaLedger).values({
      userId: input.userId,
      objectId: input.objectId,
      operation: "reserve_and_finalize",
      bytes: input.sizeBytes,
      idempotencyKey: input.idempotencyKey ?? input.objectId,
    });
  });
}
