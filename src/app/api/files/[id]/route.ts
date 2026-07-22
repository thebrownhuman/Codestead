import { Readable } from "node:stream";
import { and, eq, isNull } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db/client";
import { storedObject } from "@/lib/db/schema";
import {
  deleteUserFile,
  FileDeletionCommitAmbiguousError,
} from "@/lib/storage/file-deletion";
import { requireAuth } from "@/lib/http/authz";
import { objectStorageRoot } from "@/lib/storage/object-root";
import { isStoredObjectDownloadable } from "@/lib/storage/policy";
import {
  openVerifiedStoredObject,
} from "@/lib/storage/upload-scanner";

const FILE_OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fileNotFound() {
  return NextResponse.json(
    { error: "File not found." },
    { status: 404, headers: { "Cache-Control": "private, no-store" } },
  );
}

function attachmentName(value: string) {
  return value.replace(/[^A-Za-z0-9._+ -]/g, "_").slice(0, 180) || "download";
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireAuth({ closedBookCapability: "learner_files" });
  if (!authz.session) return authz.response;
  const { id } = await context.params;
  if (!FILE_OBJECT_ID.test(id)) return fileNotFound();
  const [file] = await db
    .select()
    .from(storedObject)
    .where(
      and(
        eq(storedObject.id, id),
        eq(storedObject.ownerUserId, authz.session.user.id),
        isNull(storedObject.deletedAt),
      ),
    )
    .limit(1);
  if (!file) return fileNotFound();
  if (!isStoredObjectDownloadable(file.scanStatus)) {
    return NextResponse.json(
      { error: "This file is not available because it has not passed its safety checks." },
      { status: 423, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  let handle: Awaited<ReturnType<typeof openVerifiedStoredObject>>;
  try {
    handle = await openVerifiedStoredObject(objectStorageRoot(), file);
  } catch {
    return NextResponse.json(
      { error: "This file is unavailable because its storage record failed integrity checks." },
      { status: 423, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  const stream = Readable.toWeb(
    handle.createReadStream(),
  ) as ReadableStream;
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(file.sizeBytes),
      "Content-Disposition": `attachment; filename="${attachmentName(file.originalName)}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireAuth({ closedBookCapability: "learner_files" });
  if (!authz.session) return authz.response;
  const { id } = await context.params;
  if (!FILE_OBJECT_ID.test(id)) return fileNotFound();
  let deletion;
  try {
    deletion = await deleteUserFile({
      ownerUserId: authz.session.user.id,
      objectId: id,
    });
  } catch (error) {
    if (error instanceof FileDeletionCommitAmbiguousError) {
      return NextResponse.json(
        {
          code: "FILE_DELETE_COMMIT_AMBIGUOUS",
          error: "Deletion outcome is uncertain. Retry deleting this same file.",
        },
        { status: 500, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    throw error;
  }
  if (!deletion) return fileNotFound();
  return NextResponse.json(
    { id: deletion.id, accessRemoved: true, erasureQueued: true },
    { status: 202, headers: { "Cache-Control": "private, no-store" } },
  );
}
