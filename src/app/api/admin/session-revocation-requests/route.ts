import { desc, eq } from "drizzle-orm";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { db } from "@/lib/db/client";
import { sessionRevocationRequest, user } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/http/authz";

export async function GET() {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  const requests = await db
    .select({
      id: sessionRevocationRequest.id,
      learnerId: sessionRevocationRequest.userId,
      learnerName: user.name,
      learnerEmail: user.email,
      sessionId: sessionRevocationRequest.sessionId,
      reason: sessionRevocationRequest.reason,
      requestChannel: sessionRevocationRequest.requestChannel,
      identityVerifiedAt: sessionRevocationRequest.identityVerifiedAt,
      status: sessionRevocationRequest.status,
      createdAt: sessionRevocationRequest.createdAt,
    })
    .from(sessionRevocationRequest)
    .innerJoin(user, eq(user.id, sessionRevocationRequest.userId))
    .where(eq(sessionRevocationRequest.status, "pending"))
    .orderBy(desc(sessionRevocationRequest.createdAt))
    .limit(100);
  return adminJson({ requests });
}
