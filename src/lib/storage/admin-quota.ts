import { createHash } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  learnerProfile,
  notification,
  storageQuotaChange,
  storedObject,
  user,
} from "@/lib/db/schema";
import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  MAX_STORAGE_QUOTA_BYTES,
} from "@/lib/storage/policy";

export type StorageQuotaAdminErrorCode =
  | "LEARNER_NOT_FOUND"
  | "INVALID_REQUEST"
  | "INVALID_QUOTA"
  | "QUOTA_BELOW_USAGE"
  | "VERSION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT";

export class StorageQuotaAdminError extends Error {
  constructor(readonly code: StorageQuotaAdminErrorCode, message: string) {
    super(message);
    this.name = "StorageQuotaAdminError";
  }
}

export interface LearnerStorageQuota {
  readonly learnerUserId: string;
  readonly learnerPublicId: string;
  readonly learnerName: string;
  readonly learnerEmail: string;
  readonly usedBytes: number;
  readonly quotaBytes: number;
  readonly rowVersion: number;
  readonly replayed: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeQuotaChangeRequest(input: {
  readonly learnerPublicId: string;
  readonly requestedBytes: number;
  readonly expectedRowVersion: number;
  readonly requestId: string;
  readonly actorUserId: string;
  readonly reason: string;
}) {
  const learnerPublicId = input.learnerPublicId.trim().toLowerCase();
  const requestId = input.requestId.trim().toLowerCase();
  const actorUserId = input.actorUserId.trim();
  const reason = input.reason.trim();
  if (
    !UUID_PATTERN.test(learnerPublicId) ||
    !UUID_PATTERN.test(requestId) ||
    actorUserId.length < 1 ||
    actorUserId.length > 200 ||
    reason.length < 8 ||
    reason.length > 500 ||
    !Number.isSafeInteger(input.expectedRowVersion) ||
    input.expectedRowVersion < 0
  ) {
    throw new StorageQuotaAdminError(
      "INVALID_REQUEST",
      "Storage quota change identity, version, or reason is invalid.",
    );
  }
  validateRequestedStorageQuota({ requestedBytes: input.requestedBytes, usedBytes: 0 });
  const requestHash = createHash("sha256")
    .update(JSON.stringify([
      "storage-quota-change.v1",
      actorUserId,
      learnerPublicId,
      input.requestedBytes,
      input.expectedRowVersion,
      reason,
    ]))
    .digest("hex");
  return {
    ...input,
    learnerPublicId,
    requestId,
    actorUserId,
    reason,
    requestHash,
  };
}

export function validateRequestedStorageQuota(input: {
  readonly requestedBytes: number;
  readonly usedBytes: number;
}) {
  if (
    !Number.isSafeInteger(input.requestedBytes) ||
    input.requestedBytes < DEFAULT_STORAGE_QUOTA_BYTES ||
    input.requestedBytes > MAX_STORAGE_QUOTA_BYTES
  ) {
    throw new StorageQuotaAdminError(
      "INVALID_QUOTA",
      "Storage quota must be an exact byte value between 2 GiB and 3 GiB.",
    );
  }
  if (!Number.isSafeInteger(input.usedBytes) || input.usedBytes < 0) {
    throw new StorageQuotaAdminError("INVALID_QUOTA", "Stored usage is invalid.");
  }
  if (input.requestedBytes < input.usedBytes) {
    throw new StorageQuotaAdminError(
      "QUOTA_BELOW_USAGE",
      "Storage quota cannot be reduced below the learner's current usage.",
    );
  }
}

function numberFromDatabase(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new StorageQuotaAdminError("INVALID_QUOTA", "Stored usage is invalid.");
  }
  return parsed;
}

export async function getLearnerStorageQuota(
  learnerPublicId: string,
): Promise<LearnerStorageQuota> {
  const [row] = await db
    .select({
      learnerUserId: user.id,
      learnerPublicId: user.publicId,
      learnerName: user.name,
      learnerEmail: user.email,
      quotaBytes: learnerProfile.storageQuotaBytes,
      rowVersion: learnerProfile.rowVersion,
      usedBytes: sql<number>`coalesce(sum(${storedObject.sizeBytes}) filter (where ${storedObject.deletedAt} is null), 0)::float8`,
    })
    .from(user)
    .leftJoin(learnerProfile, eq(learnerProfile.userId, user.id))
    .leftJoin(storedObject, eq(storedObject.ownerUserId, user.id))
    .where(and(eq(user.publicId, learnerPublicId), eq(user.role, "learner")))
    .groupBy(
      user.id,
      user.publicId,
      user.name,
      user.email,
      learnerProfile.storageQuotaBytes,
      learnerProfile.rowVersion,
    )
    .limit(1);
  if (!row) {
    throw new StorageQuotaAdminError("LEARNER_NOT_FOUND", "Learner was not found.");
  }
  return {
    ...row,
    quotaBytes: row.quotaBytes ?? DEFAULT_STORAGE_QUOTA_BYTES,
    rowVersion: row.rowVersion ?? 0,
    usedBytes: numberFromDatabase(row.usedBytes),
    replayed: false,
  };
}

export async function changeLearnerStorageQuota(input: {
  readonly learnerPublicId: string;
  readonly requestedBytes: number;
  readonly expectedRowVersion: number;
  readonly requestId: string;
  readonly actorUserId: string;
  readonly reason: string;
}): Promise<LearnerStorageQuota> {
  const request = normalizeQuotaChangeRequest(input);
  return db.transaction(async (tx) => {
    // Serialize the idempotency key independently of the learner lock. Two
    // concurrent calls that reuse one key for different learners must not both
    // mutate before the primary-key conflict is discovered.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`storage-quota:${request.requestId}`}))`,
    );
    const [prior] = await tx
      .select({
        requestHash: storageQuotaChange.requestHash,
        learnerUserId: storageQuotaChange.learnerUserId,
        learnerPublicId: storageQuotaChange.learnerPublicId,
        requestedBytes: storageQuotaChange.requestedBytes,
        usedBytesAtChange: storageQuotaChange.usedBytesAtChange,
        resultingRowVersion: storageQuotaChange.resultingRowVersion,
      })
      .from(storageQuotaChange)
      .where(eq(storageQuotaChange.requestId, request.requestId))
      .limit(1);
    if (prior) {
      if (prior.requestHash !== request.requestHash) {
        throw new StorageQuotaAdminError(
          "IDEMPOTENCY_CONFLICT",
          "That request identifier was already used for a different quota change.",
        );
      }
      const [priorIdentity] = await tx
        .select({
          learnerUserId: user.id,
          learnerPublicId: user.publicId,
          learnerName: user.name,
          learnerEmail: user.email,
        })
        .from(user)
        .where(and(
          eq(user.id, prior.learnerUserId),
          eq(user.publicId, prior.learnerPublicId),
          eq(user.role, "learner"),
        ))
        .limit(1);
      if (!priorIdentity) {
        throw new StorageQuotaAdminError("LEARNER_NOT_FOUND", "Learner was not found.");
      }
      return {
        ...priorIdentity,
        usedBytes: numberFromDatabase(prior.usedBytesAtChange),
        quotaBytes: numberFromDatabase(prior.requestedBytes),
        rowVersion: numberFromDatabase(prior.resultingRowVersion),
        replayed: true,
      };
    }

    const [identity] = await tx
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.publicId, request.learnerPublicId), eq(user.role, "learner")))
      .limit(1);
    if (!identity) {
      throw new StorageQuotaAdminError("LEARNER_NOT_FOUND", "Learner was not found.");
    }

    // Share the exact lock key used by upload reservations. A quota change
    // cannot race a concurrent upload and accidentally move below real usage.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${identity.id}))`);
    const [current] = await tx
      .select({
        learnerUserId: user.id,
        learnerPublicId: user.publicId,
        learnerName: user.name,
        learnerEmail: user.email,
        quotaBytes: learnerProfile.storageQuotaBytes,
        rowVersion: learnerProfile.rowVersion,
      })
      .from(user)
      .leftJoin(learnerProfile, eq(learnerProfile.userId, user.id))
      .where(and(eq(user.id, identity.id), eq(user.role, "learner")))
      .limit(1);
    if (!current) {
      throw new StorageQuotaAdminError("LEARNER_NOT_FOUND", "Learner was not found.");
    }
    const [usage] = await tx
      .select({
        usedBytes: sql<number>`coalesce(sum(${storedObject.sizeBytes}), 0)::float8`,
      })
      .from(storedObject)
      .where(and(eq(storedObject.ownerUserId, identity.id), isNull(storedObject.deletedAt)));
    const usedBytes = numberFromDatabase(usage?.usedBytes);
    validateRequestedStorageQuota({ requestedBytes: request.requestedBytes, usedBytes });

    const currentVersion = current.rowVersion ?? 0;
    if (currentVersion !== request.expectedRowVersion) {
      throw new StorageQuotaAdminError(
        "VERSION_CONFLICT",
        "Storage quota changed in another administrator view. Refresh and try again.",
      );
    }
    const nextVersion = currentVersion + 1;
    if (current.rowVersion === null) {
      await tx.insert(learnerProfile).values({
        userId: identity.id,
        storageQuotaBytes: request.requestedBytes,
        rowVersion: nextVersion,
      });
    } else {
      const updated = await tx
        .update(learnerProfile)
        .set({
          storageQuotaBytes: request.requestedBytes,
          rowVersion: nextVersion,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(learnerProfile.userId, identity.id),
            eq(learnerProfile.rowVersion, currentVersion),
          ),
        )
        .returning({ userId: learnerProfile.userId });
      if (updated.length !== 1) {
        throw new StorageQuotaAdminError(
          "VERSION_CONFLICT",
          "Storage quota changed in another administrator view. Refresh and try again.",
        );
      }
    }
    await tx.insert(notification).values({
      userId: identity.id,
      type: "storage-quota-changed",
      title: "Storage quota changed",
      body: `Your Codestead storage quota is now ${(request.requestedBytes / 1024 ** 3).toFixed(2)} GiB.`,
      actionUrl: "/projects",
    });
    await tx.insert(storageQuotaChange).values({
      requestId: request.requestId,
      actorUserId: request.actorUserId,
      learnerUserId: identity.id,
      learnerPublicId: request.learnerPublicId,
      requestedBytes: request.requestedBytes,
      expectedRowVersion: request.expectedRowVersion,
      previousQuotaBytes: current.quotaBytes ?? DEFAULT_STORAGE_QUOTA_BYTES,
      previousRowVersion: currentVersion,
      usedBytesAtChange: usedBytes,
      resultingRowVersion: nextVersion,
      reason: request.reason,
      requestHash: request.requestHash,
    });
    return {
      learnerUserId: current.learnerUserId,
      learnerPublicId: current.learnerPublicId,
      learnerName: current.learnerName,
      learnerEmail: current.learnerEmail,
      usedBytes,
      quotaBytes: request.requestedBytes,
      rowVersion: nextVersion,
      replayed: false,
    };
  });
}

export function storageQuotaAdminHttpStatus(error: unknown): number {
  if (!(error instanceof StorageQuotaAdminError)) return 500;
  if (error.code === "LEARNER_NOT_FOUND") return 404;
  if (
    error.code === "VERSION_CONFLICT" ||
    error.code === "QUOTA_BELOW_USAGE" ||
    error.code === "IDEMPOTENCY_CONFLICT"
  ) return 409;
  return 400;
}
