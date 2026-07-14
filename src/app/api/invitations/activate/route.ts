import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { findUsableInvitationByToken } from "@/lib/security/invitation-store";
import { rateLimitIp, withRateLimit } from "@/lib/security/rate-limit";
import { runAuthorizedActivation } from "@/lib/security/activation-context";

const activationSchema = z.object({
  token: z.string().min(32).max(256),
  name: z.string().trim().min(2).max(80),
  password: z.string().min(12).max(128),
});

export async function POST(request: NextRequest) {
  return withRateLimit(
    { policy: "invitation_activate_ip", identity: { kind: "ip", value: rateLimitIp(request) } },
    async () => {
      const parsed = activationSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        return NextResponse.json({ error: "Invitation, name, and a valid password are required." }, { status: 400 });
      }
      return withRateLimit(
        { policy: "invitation_activate_token", identity: { kind: "invitation", value: parsed.data.token } },
        async () => {
          const record = await findUsableInvitationByToken(parsed.data.token);
          if (!record) {
            return NextResponse.json({ error: "This invitation is invalid or expired." }, { status: 404 });
          }

          try {
            await runAuthorizedActivation(
              { invitationId: record.id, email: record.email },
              () => auth.api.signUpEmail({
                body: {
                  email: record.email.toLowerCase(),
                  name: parsed.data.name,
                  password: parsed.data.password,
                },
              }),
            );
            return NextResponse.json({ ok: true }, { status: 201 });
          } catch {
            return NextResponse.json(
              { error: "Account activation could not be completed. Request a fresh invitation if this continues." },
              { status: 409 },
            );
          }
        },
      );
    },
  );
}
