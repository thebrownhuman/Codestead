import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { verifyLostDeviceProof } from "@/lib/security/lost-device-recovery";
import { rateLimitIp, withRateLimit } from "@/lib/security/rate-limit";

const verifySchema = z
  .object({
    proof: z.string().min(32).max(256),
    reason: z.string().trim().min(12).max(500),
  })
  .strict();

export async function POST(request: NextRequest) {
  return withRateLimit(
    {
      policy: "lost_device_verify_ip",
      identity: { kind: "ip", value: rateLimitIp(request) },
    },
    async () => {
      const parsed = verifySchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        return NextResponse.json(
          { error: "The confirmation link or request reason is invalid." },
          { status: 400, headers: { "Cache-Control": "private, no-store" } },
        );
      }
      return withRateLimit(
        {
          policy: "lost_device_verify_proof",
          identity: { kind: "recovery", value: parsed.data.proof },
        },
        async () => {
          const verified = await verifyLostDeviceProof({
            rawProof: parsed.data.proof,
            reason: parsed.data.reason,
          });
          if (!verified) {
            return NextResponse.json(
              {
                error:
                  "This confirmation link is invalid, expired, already used, or the browser profile is no longer active.",
              },
              { status: 400, headers: { "Cache-Control": "private, no-store" } },
            );
          }
          return NextResponse.json(
            {
              ok: true,
              message:
                "Your mailbox was confirmed. The administrator must still verify your identity and approve the revocation.",
            },
            { status: 201, headers: { "Cache-Control": "private, no-store" } },
          );
        },
      );
    },
  );
}
