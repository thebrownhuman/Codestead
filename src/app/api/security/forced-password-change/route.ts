import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/http/authz";
import { completeForcedPasswordChange } from "@/lib/security/forced-password-change";
import { withRateLimit } from "@/lib/security/rate-limit";

const bodySchema = z.object({
  currentPassword: z.string().min(12).max(128),
  newPassword: z.string().min(12).max(128),
}).refine((value) => value.currentPassword !== value.newPassword);

function failure(status = 400) {
  return NextResponse.json(
    { error: "Password change could not be completed." },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function POST(request: NextRequest) {
  const authz = await requireAuth({ allowPending: true, allowPasswordChange: true });
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "forced_password_change_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const parsed = bodySchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return failure();
      try {
        const result = await completeForcedPasswordChange({
          userId: authz.session.user.id,
          ...parsed.data,
        });
        if (result !== "changed") return failure(result === "not-required" ? 409 : 400);
        const response = NextResponse.json(
          { ok: true, signInRequired: true },
          { headers: { "Cache-Control": "private, no-store" } },
        );
        for (const name of ["learncoding.session_token", "__Secure-learncoding.session_token"]) {
          response.cookies.set(name, "", {
            expires: new Date(0),
            httpOnly: true,
            sameSite: "lax",
            secure: name.startsWith("__Secure-"),
            path: "/",
          });
        }
        return response;
      } catch {
        return failure(503);
      }
    },
  );
}