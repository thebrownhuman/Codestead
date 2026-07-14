import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/http/authz";
import { inferInterestCategory } from "@/lib/profile/interests";

const bodySchema = z.object({
  labels: z.array(z.string().trim().min(2).max(50)).max(8),
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
  return NextResponse.json(
    {
      interests: body.data.labels.map((label) => ({
        label,
        suggestedCategory: inferInterestCategory(label),
      })),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
