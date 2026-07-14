import { and, eq, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { accessRequest } from "@/lib/db/schema";
import { enqueueEmail } from "@/lib/notifications/outbox";
import { rateLimitIp, withRateLimit } from "@/lib/security/rate-limit";

const requestSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.email().max(254).transform((value) => value.toLowerCase()),
  reason: z.string().trim().max(500).optional(),
  adultConfirmed: z.literal(true),
});

export async function POST(request: NextRequest) {
  return withRateLimit(
    { policy: "access_request_ip", identity: { kind: "ip", value: rateLimitIp(request) } },
    async () => {
      const parsed = requestSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        return NextResponse.json(
          { error: "Please provide a valid name, email, and adult confirmation." },
          { status: 400 },
        );
      }
      return withRateLimit(
        { policy: "access_request_email", identity: { kind: "email", value: parsed.data.email } },
        async () => {
          const [existing] = await db
            .select({ id: accessRequest.id, status: accessRequest.status })
            .from(accessRequest)
            .where(
              and(
                sql`lower(${accessRequest.email}) = ${parsed.data.email}`,
                eq(accessRequest.status, "pending"),
              ),
            )
            .limit(1);

          if (!existing) {
            await db.insert(accessRequest).values({
              name: parsed.data.name,
              email: parsed.data.email,
              reason: parsed.data.reason,
              adultConfirmedAt: new Date(),
            });
            const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
            if (adminEmail) {
              await enqueueEmail({
                to: adminEmail,
                template: "invitation",
                variables: {
                  name: "Administrator",
                  url: `${process.env.APP_URL ?? "http://localhost:3000"}/admin/access`,
                },
                idempotencySeed: `access-request:${parsed.data.email}`,
              });
            }
          }

          // Enumeration-safe: an existing request receives the same response.
          return NextResponse.json(
            { ok: true, message: "Your request is waiting for administrator review." },
            { status: 202 },
          );
        },
      );
    },
  );
}
