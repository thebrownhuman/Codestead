import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { issueLostDeviceProof } from "@/lib/security/lost-device-recovery";
import { rateLimitIp, withRateLimit } from "@/lib/security/rate-limit";

const requestSchema = z
  .object({
    email: z.email().max(254).transform((value) => value.toLowerCase()),
  })
  .strict();

const neutralResponse = () =>
  NextResponse.json(
    {
      ok: true,
      message:
        "If an eligible account has an active browser profile, a short-lived confirmation link has been emailed.",
    },
    { status: 202, headers: { "Cache-Control": "private, no-store" } },
  );

export async function POST(request: NextRequest) {
  return withRateLimit(
    {
      policy: "lost_device_request_ip",
      identity: { kind: "ip", value: rateLimitIp(request) },
    },
    async () => {
      const parsed = requestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        return NextResponse.json(
          { error: "Enter a valid email address." },
          { status: 400, headers: { "Cache-Control": "private, no-store" } },
        );
      }
      return withRateLimit(
        {
          policy: "lost_device_request_email",
          identity: { kind: "email", value: parsed.data.email },
        },
        async () => {
          try {
            await issueLostDeviceProof(parsed.data.email);
            return neutralResponse();
          } catch {
            console.error("lost_device_proof_issuance_failed");
            // Failure may occur only after a real eligible account is found.
            // Reflecting it would turn operational state into an enumeration
            // oracle, so the public response remains byte-for-byte neutral.
            return neutralResponse();
          }
        },
      );
    },
  );
}
