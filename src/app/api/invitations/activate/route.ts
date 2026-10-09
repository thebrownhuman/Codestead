import { readBoundedJson } from "@/lib/http/bounded-json";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import {
  consumeInvitationByToken,
  findUsableInvitationByToken,
} from "@/lib/security/invitation-store";
import { rateLimitIp, withRateLimit } from "@/lib/security/rate-limit";
import { runAuthorizedActivation } from "@/lib/security/activation-context";
import { BREACHED_PASSWORD_MESSAGE, isBreachedPasswordError, requireUnbreachedPassword } from "@/lib/security/breached-passwords";

const activationSchema = z.object({
  token: z.string().min(32).max(256),
  name: z.string().trim().min(2).max(80),
  password: z.string().min(12).max(128),
});

export async function POST(request: NextRequest) {
  return withRateLimit(
    { policy: "invitation_activate_ip", identity: { kind: "ip", value: rateLimitIp(request) } },
    async () => {
      const jsonBody = await readBoundedJson(request);
      if (jsonBody.response?.status === 413) return jsonBody.response;
      const parsed = activationSchema.safeParse(jsonBody.value);
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

          // Check before consuming the single-use invitation so a learner can
          // retry a rejected password with the same invitation.
          try {
            await requireUnbreachedPassword(parsed.data.password);
          } catch (error) {
            if (!isBreachedPasswordError(error)) throw error;
            return NextResponse.json({ code: "PASSWORD_COMPROMISED", error: BREACHED_PASSWORD_MESSAGE }, { status: 400 });
          }
          const claimed = await consumeInvitationByToken({
            rawToken: parsed.data.token,
            expectedEmail: record.email,
          });
          if (!claimed?.consumedAt) {
            return NextResponse.json({ error: "This invitation is invalid or expired." }, { status: 404 });
          }

          // This claim is deliberately irreversible. Restoring it after an
          // ambiguous signup failure could let a replay race create a second
          // account; the safe recovery is an administrator-issued fresh invite.
          try {
            await runAuthorizedActivation(
              {
                invitationId: claimed.id,
                email: claimed.email,
                consumedAt: claimed.consumedAt,
              },
              () => auth.api.signUpEmail({
                body: {
                  email: claimed.email.trim().toLowerCase(),
                  name: parsed.data.name,
                  password: parsed.data.password,
                },
              }),
            );
            return NextResponse.json({ ok: true }, { status: 201 });
          } catch (error) {
            if (isBreachedPasswordError(error)) {
              return NextResponse.json({ code: "PASSWORD_COMPROMISED", error: `${BREACHED_PASSWORD_MESSAGE} Request a fresh invitation to try again.` }, { status: 400 });
            }
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
