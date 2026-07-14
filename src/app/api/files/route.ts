import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
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
import {
  reserveStoredObject,
  StorageQuotaExceededError,
} from "@/lib/storage/quota-store";

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function ownerStorageSegment(userId: string) {
  // Keep identity values out of filesystem paths and make traversal impossible
  // even if an imported auth record contains unusual identifier characters.
  return createHash("sha256").update(`learncoding-storage-owner-v1\0${userId}`).digest("hex");
}

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
    quota: {
      usedBytes: activeFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
      limitBytes: profile?.quota ?? DEFAULT_STORAGE_QUOTA_BYTES,
    },
  }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: NextRequest) {
  const authz = await requireAuth({ closedBookCapability: "learner_files" });
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "file_upload_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
  const form = await request.formData();
  const upload = form.get("file");
  if (!(upload instanceof File)) return NextResponse.json({ error: "Choose a file." }, { status: 400 });
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

  const objectId = randomUUID();
  const ownerSegment = ownerStorageSegment(authz.session.user.id);
  const storageKey = `${ownerSegment}/${objectId}`;
  const root = objectStorageRoot();
  const userDir = path.join(/* turbopackIgnore: true */ root, ownerSegment);
  const temporary = path.join(userDir, `.${objectId}.uploading`);
  const destination = path.join(userDir, objectId);
  await mkdir(userDir, { recursive: true, mode: 0o700 });
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  const digest = createHash("sha256").update(bytes).digest("hex");
  bytes.fill(0);

  try {
    await rename(temporary, destination);
    await reserveStoredObject({
      objectId,
      userId: authz.session.user.id,
      storageKey,
      originalName,
      // Derive the stored type from the validated extension. Browser-supplied
      // MIME values are untrusted and must not decide later rendering policy.
      mediaType: MEDIA_TYPES[extension] ?? "text/plain",
      sizeBytes: upload.size,
      sha256: digest,
      scanStatus,
    });
  } catch (error) {
    await rm(temporary, { force: true });
    await rm(destination, { force: true });
    if (error instanceof StorageQuotaExceededError) {
      return NextResponse.json({ error: "This upload would exceed your storage quota." }, { status: 413 });
    }
    return NextResponse.json({ error: "The upload could not be finalized." }, { status: 500 });
  }
      return NextResponse.json({
        file: { id: objectId, name: originalName, sizeBytes: upload.size },
      }, { status: 201 });
    },
  );
}
