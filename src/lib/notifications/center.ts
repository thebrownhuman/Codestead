import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { notification } from "@/lib/db/schema";

const MAX_PAGE_SIZE = 50;

export type NotificationCursor = Readonly<{ createdAt: Date; id: string }>;

export function encodeNotificationCursor(cursor: NotificationCursor) {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, "utf8").toString("base64url");
}

export function decodeNotificationCursor(value: string | null): NotificationCursor | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const separator = decoded.lastIndexOf("|");
    const createdAt = new Date(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (separator < 1 || !Number.isFinite(createdAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export async function listNotifications(input: {
  userId: string;
  limit?: number;
  cursor?: NotificationCursor | null;
}) {
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(input.limit ?? 20)));
  const cursorFilter = input.cursor
    ? or(
        lt(notification.createdAt, input.cursor.createdAt),
        and(eq(notification.createdAt, input.cursor.createdAt), lt(notification.id, input.cursor.id)),
      )
    : undefined;
  const rows = await db
    .select({
      id: notification.id,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      actionUrl: notification.actionUrl,
      readAt: notification.readAt,
      createdAt: notification.createdAt,
    })
    .from(notification)
    .where(and(eq(notification.userId, input.userId), cursorFilter))
    .orderBy(desc(notification.createdAt), desc(notification.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  const [counter] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notification)
    .where(and(eq(notification.userId, input.userId), isNull(notification.readAt)));
  return {
    notifications: page.map((item) => ({ ...item, readAt: item.readAt?.toISOString() ?? null, createdAt: item.createdAt.toISOString() })),
    unreadCount: Number(counter?.count ?? 0),
    nextCursor: hasMore && last ? encodeNotificationCursor(last) : null,
  };
}

export async function setNotificationsRead(input: {
  userId: string;
  ids?: string[];
  read: boolean;
  readAll?: boolean;
  now?: Date;
}) {
  const ids = [...new Set(input.ids ?? [])].slice(0, 50);
  if (!input.readAll && ids.length === 0) return { updated: 0 };
  const updated = await db
    .update(notification)
    .set({ readAt: input.read ? (input.now ?? new Date()) : null })
    .where(and(
      eq(notification.userId, input.userId),
      input.readAll ? undefined : inArray(notification.id, ids),
      input.read ? isNull(notification.readAt) : undefined,
    ))
    .returning({ id: notification.id });
  return { updated: updated.length };
}
