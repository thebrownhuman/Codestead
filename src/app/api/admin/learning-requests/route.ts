import { and, desc, eq, inArray, ne, notInArray } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { learningRequest, user } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/http/authz";
import { supportKinds } from "@/lib/learning-requests/support-contract";

export async function GET(request?: NextRequest) {
  const authz = await requireAdmin();
  if (!authz.session) return authz.response;
  const filter = z.object({ queue: z.enum(["curriculum", "support"]).default("curriculum"), status: z.enum(["open", "resolved"]).optional() }).strict()
    .safeParse(Object.fromEntries(request?.nextUrl.searchParams ?? []));
  if (!filter.success) return NextResponse.json({ error: "Choose a valid queue and status." }, { status: 400 });
  const support = filter.data.queue === "support";
  try {
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
    .where(and(
      support ? inArray(learningRequest.kind, [...supportKinds]) : notInArray(learningRequest.kind, [...supportKinds]),
      filter.data.status === "open" ? eq(learningRequest.status, "pending") : undefined,
      filter.data.status === "resolved" ? ne(learningRequest.status, "pending") : undefined,
    ))
    .orderBy(desc(learningRequest.createdAt))
    .limit(200);
  return NextResponse.json(
    { requests: rows },
    { headers: { "Cache-Control": "private, no-store" } },
  );
  } catch {
    return NextResponse.json({ error: "Requests are temporarily unavailable." }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
