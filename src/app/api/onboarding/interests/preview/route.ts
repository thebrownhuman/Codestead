import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/http/authz";
import { inferInterestCategory, isRecognizedInterest, junkInterestReason } from "@/lib/profile/interests";

const bodySchema = z.object({
  labels: z.array(z.string().trim().min(1).max(50)).max(8),
});

export async function POST(request: NextRequest) {
  const authz = await requireAuth({ allowPending: true });
  if (!authz.session) return authz.response;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json(
      { error: "Enter up to eight short interests." },
      { status: 400, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  const interests: Array<{ label: string; suggestedCategory: string; recognized: boolean }> = [];
  const rejected: Array<{ label: string; reason: string }> = [];
  for (const label of body.data.labels) {
    const reason = junkInterestReason(label);
    if (reason) {
      rejected.push({ label, reason });
      continue;
    }
    interests.push({
      label,
      suggestedCategory: inferInterestCategory(label),
      recognized: isRecognizedInterest(label),
    });
  }
  return NextResponse.json(
    { interests, rejected },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
