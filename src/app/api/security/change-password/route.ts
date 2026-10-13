import { readBoundedJson } from "@/lib/http/bounded-json";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/http/authz";
import { changeAccountPassword } from "@/lib/security/password-change";
import { withRateLimit } from "@/lib/security/rate-limit";

const bodySchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(12).max(128) })
  .strict().refine((body) => body.currentPassword !== body.newPassword);
const noStore = { "Cache-Control": "private, no-store" };
function failure(status: number, error = "Password change could not be completed.") {
  return NextResponse.json({ error }, { status, headers: noStore });
}
export async function POST(request: NextRequest) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const current = authz.session;
  const userId = authz.session.user.id;
  return withRateLimit({ policy: "forced_password_change_user", identity: { kind: "user", value: userId } }, async () => {
    const jsonBody = await readBoundedJson(request);
    if (jsonBody.response?.status === 413) return jsonBody.response;
    const parsed = bodySchema.safeParse(jsonBody.value);
    if (!parsed.success) return failure(400, "Use a different new password with 12 to 128 characters.");
    return changeAccountPassword({ current, headers: request.headers, passwords: parsed.data });
  });
}
