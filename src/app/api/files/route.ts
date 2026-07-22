import { and, eq, isNull } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db/client";
import { learnerProfile, storedObject } from "@/lib/db/schema";
import { requireAuth } from "@/lib/http/authz";
import { withRateLimit } from "@/lib/security/rate-limit";
import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  MAX_UPLOAD_BYTES,
  validateUpload,
} from "@/lib/storage/policy";
import { objectStorageRoot } from "@/lib/storage/object-root";
import { StorageQuotaExceededError } from "@/lib/storage/quota-store";
import { uploadsEnabled } from "@/lib/storage/upload-feature";
import { NodeDurableObjectStore } from "@/lib/storage/durable-object-store";
import { PostgresUploadReceiptRepository } from "@/lib/storage/upload-repository";
import {
  createDurableUpload,
  UploadCommitAmbiguousError,
  UploadIdempotencyConflictError,
  UploadIdempotencyTombstonedError,
} from "@/lib/storage/upload-service";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export async function GET() {
  const authz = await requireAuth({ closedBookCapability: "learner_files" });
  if (!authz.session) return authz.response;
  const files = await db
    .select({
      id: storedObject.id,
      name: storedObject.originalName,
      mediaType: storedObject.mediaType,
      sizeBytes: storedObject.sizeBytes,
      scanStatus: storedObject.scanStatus,
      createdAt: storedObject.createdAt,
    })
    .from(storedObject)
    .where(
      and(
        eq(storedObject.ownerUserId, authz.session.user.id),
        isNull(storedObject.deletedAt),
      ),
    );
  const [profile] = await db
    .select({ quota: learnerProfile.storageQuotaBytes })
    .from(learnerProfile)
    .where(eq(learnerProfile.userId, authz.session.user.id))
    .limit(1);
  const activeFiles = files.filter((file) => file.scanStatus !== "deleted");
  return NextResponse.json({
    files: activeFiles,
    uploadsEnabled: uploadsEnabled(),
    quota: {
      usedBytes: activeFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
      limitBytes: profile?.quota ?? DEFAULT_STORAGE_QUOTA_BYTES,
    },
  }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: NextRequest) {
  const authz = await requireAuth({ closedBookCapability: "learner_files" });
  if (!authz.session) return authz.response;
  if (!uploadsEnabled()) {
    return NextResponse.json(
      {
        code: "UPLOADS_DISABLED",
        error: "Project file uploads are disabled during the private pilot.",
      },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  return withRateLimit(
    { policy: "file_upload_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const idempotencyKey = request.headers.get("Idempotency-Key") ?? "";
      if (!UUID_PATTERN.test(idempotencyKey)) {
        return NextResponse.json(
          {
            code: "INVALID_IDEMPOTENCY_KEY",
            error: "Idempotency-Key must be a UUID.",
          },
          { status: 400, headers: { "Cache-Control": "private, no-store" } },
        );
      }
      const form = await request.formData();
      const upload = form.get("file");
      if (!(upload instanceof File)) {
        return NextResponse.json({ error: "Choose a file." }, { status: 400 });
      }
      // Reject oversized bodies before materializing a second in-memory copy.
      if (!Number.isSafeInteger(upload.size) || upload.size <= 0 || upload.size > MAX_UPLOAD_BYTES) {
        return NextResponse.json({ error: "Files must be between 1 byte and 50 MB." }, { status: 413 });
      }
      const bytes = Buffer.from(await upload.arrayBuffer());
      const validation = validateUpload({ name: upload.name, size: upload.size, bytes });
      if (!validation.ok) {
        bytes.fill(0);
        return NextResponse.json({ error: validation.error }, { status: validation.status });
      }
      const { name: originalName, extension, scanStatus } = validation;
      try {
        const file = await createDurableUpload({
          ownerUserId: authz.session.user.id,
          idempotencyKey,
          originalName,
          // Browser-supplied MIME values are untrusted; the validated extension
          // alone decides the stored delivery policy.
          mediaType: MEDIA_TYPES[extension] ?? "text/plain",
          scanStatus,
          bytes,
        }, {
          store: new NodeDurableObjectStore({ root: objectStorageRoot() }),
          repository: new PostgresUploadReceiptRepository(),
        });
        return NextResponse.json({
          file: { id: file.id, name: file.name, sizeBytes: file.sizeBytes },
        }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
      } catch (error) {
        if (error instanceof UploadIdempotencyConflictError) {
          return NextResponse.json(
            {
              code: "IDEMPOTENCY_MISMATCH",
              error: "This Idempotency-Key is already bound to a different upload.",
            },
            { status: 409, headers: { "Cache-Control": "private, no-store" } },
          );
        }
        if (error instanceof UploadIdempotencyTombstonedError) {
          return NextResponse.json(
            {
              code: "UPLOAD_IDEMPOTENCY_TOMBSTONED",
              error: "This Idempotency-Key belongs to a deleted upload and cannot be reused.",
            },
            { status: 410, headers: { "Cache-Control": "private, no-store" } },
          );
        }
        if (error instanceof StorageQuotaExceededError) {
          return NextResponse.json(
            { error: "This upload would exceed your storage quota." },
            { status: 413, headers: { "Cache-Control": "private, no-store" } },
          );
        }
        const ambiguous = error instanceof UploadCommitAmbiguousError;
        return NextResponse.json(
          {
            code: ambiguous ? "UPLOAD_COMMIT_AMBIGUOUS" : "UPLOAD_FINALIZATION_FAILED",
            error: ambiguous
              ? "The result is unknown. Retry with the same Idempotency-Key."
              : "The upload could not be finalized.",
          },
          { status: 500, headers: { "Cache-Control": "private, no-store" } },
        );
      }
    },
  );
}
