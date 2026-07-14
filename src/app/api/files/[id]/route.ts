import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { and, eq, isNull } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db/client";
import { quotaLedger, storedObject } from "@/lib/db/schema";
import { requireAuth } from "@/lib/http/authz";
import { objectStorageRoot } from "@/lib/storage/object-root";
import { isStoredObjectDownloadable } from "@/lib/storage/policy";
import {
  openVerifiedStoredObject,
  resolveStoredObjectPath,
} from "@/lib/storage/upload-scanner";

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
  if (!file) return NextResponse.json({ error: "File not found." }, { status: 404 });
  if (!isStoredObjectDownloadable(file.scanStatus)) {
    return NextResponse.json(
      { error: "This file is not available because it has not passed its safety checks." },
      { status: 423 },
    );
  }
  let handle: Awaited<ReturnType<typeof openVerifiedStoredObject>>;
  try {
    handle = await openVerifiedStoredObject(objectStorageRoot(), file);
  } catch {
    return NextResponse.json(
      { error: "This file is unavailable because its storage record failed integrity checks." },
      { status: 423 },
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
  const file = await db.transaction(async (tx) => {
    const [current] = await tx
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
    if (!current) return null;
    const [deleted] = await tx
      .update(storedObject)
      .set({ deletedAt: new Date(), scanStatus: "deleted" })
      .where(
        and(
          eq(storedObject.id, current.id),
          eq(storedObject.ownerUserId, authz.session.user.id),
          isNull(storedObject.deletedAt),
        ),
      )
      .returning({ id: storedObject.id });
    // PostgreSQL rechecks the NULL predicate after a concurrent row lock. Only
    // one delete can release quota; a second concurrent request returns 404.
    if (!deleted) return null;
    await tx.insert(quotaLedger).values({
      userId: authz.session.user.id,
      objectId: current.id,
      operation: "release",
      bytes: -current.sizeBytes,
      idempotencyKey: `delete:${current.id}`,
    }).onConflictDoNothing({
      target: [quotaLedger.userId, quotaLedger.idempotencyKey],
    });
    return current;
  });
  if (!file) return NextResponse.json({ error: "File not found." }, { status: 404 });
  try {
    await rm(/* turbopackIgnore: true */ resolveStoredObjectPath(objectStorageRoot(), file.storageKey), { force: true });
  } catch {
    // The database deletion and quota release remain authoritative. Never use
    // a malformed storage key as a filesystem path during cleanup.
  }
  return new NextResponse(null, { status: 204 });
}
