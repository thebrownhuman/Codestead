import { desc, eq, ne, sql } from "drizzle-orm";

import type { AccessRequestItem, AccessRequestQueueData } from "@/components/admin/types";
import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { db } from "@/lib/db/client";
import { accessRequest } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/http/authz";

export const dynamic = "force-dynamic";

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function serialize(row: {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly reason: string | null;
  readonly status: string;
  readonly adultConfirmedAt: Date | null;
  readonly emailVerifiedAt: Date | null;
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
  readonly decisionReason: string | null;
}): AccessRequestItem {
  return {
    ...row,
    adultConfirmedAt: toIso(row.adultConfirmedAt),
    emailVerifiedAt: toIso(row.emailVerifiedAt),
    createdAt: row.createdAt.toISOString(),
    decidedAt: toIso(row.decidedAt),
  };
}

const safeColumns = {
  id: accessRequest.id,
  name: accessRequest.name,
  email: accessRequest.email,
  reason: accessRequest.reason,
  status: accessRequest.status,
  adultConfirmedAt: accessRequest.adultConfirmedAt,
  emailVerifiedAt: accessRequest.emailVerifiedAt,
  createdAt: accessRequest.createdAt,
  decidedAt: accessRequest.decidedAt,
  decisionReason: accessRequest.decisionReason,
} as const;

export async function GET() {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);

  try {
    const [pendingRows, recentRows, counts] = await Promise.all([
      db
        .select(safeColumns)
        .from(accessRequest)
        .where(eq(accessRequest.status, "pending"))
        .orderBy(accessRequest.createdAt)
        .limit(100),
      db
        .select(safeColumns)
        .from(accessRequest)
        .where(ne(accessRequest.status, "pending"))
        .orderBy(desc(accessRequest.decidedAt), desc(accessRequest.createdAt))
        .limit(30),
      db
        .select({ status: accessRequest.status, count: sql<number>`count(*)::int` })
        .from(accessRequest)
        .groupBy(accessRequest.status),
    ]);

    const response: AccessRequestQueueData = {
      generatedAt: new Date().toISOString(),
      pending: pendingRows.map(serialize),
      recent: recentRows.map(serialize),
      statusCounts: counts
        .map((row) => ({ status: row.status, count: Number(row.count) }))
        .sort((left, right) => left.status.localeCompare(right.status)),
    };
    return adminJson(response);
  } catch (error) {
    console.error("Admin access-request query failed", error);
    return adminJson({ error: "Access requests are temporarily unavailable." }, 503);
  }
}
