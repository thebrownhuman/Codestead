import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/lib/db/client";
import { learningRequest, user } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/http/authz";

export async function GET() {
  const authz = await requireAdmin();
  if (!authz.session) return authz.response;
  const rows = await db
    .select({
      id: learningRequest.id,
      userId: learningRequest.userId,
      learnerName: user.name,
      learnerEmail: user.email,
      kind: learningRequest.kind,
      subject: learningRequest.subject,
      details: learningRequest.details,
      status: learningRequest.status,
      decisionReason: learningRequest.decisionReason,
      createdAt: learningRequest.createdAt,
      decidedAt: learningRequest.decidedAt,
    })
    .from(learningRequest)
    .innerJoin(user, eq(user.id, learningRequest.userId))
    .orderBy(desc(learningRequest.createdAt))
    .limit(200);
  return NextResponse.json(
    { requests: rows },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
