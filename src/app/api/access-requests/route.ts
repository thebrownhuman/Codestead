import { and, eq, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { accessRequest, user } from "@/lib/db/schema";
import { enqueueEmailInTransaction } from "@/lib/notifications/outbox";
import { rateLimitIp, withRateLimit } from "@/lib/security/rate-limit";

const requestSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  reason: z.string().trim().max(500).optional(),
  adultConfirmed: z.literal(true),
});

export async function POST(request: NextRequest) {
  return withRateLimit(
    {
      policy: "access_request_ip",
      identity: { kind: "ip", value: rateLimitIp(request) },
    },
    async () => {
      const parsed = requestSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success) {
        return NextResponse.json(
          {
            error:
              "Please provide a valid name, email, and adult confirmation.",
          },
          { status: 400 },
        );
      }
      return withRateLimit(
        {
          policy: "access_request_email",
          identity: { kind: "email", value: parsed.data.email },
        },
        async () => {
          await db.transaction(async (tx) => {
            await tx.execute(
              sql`select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`access-request:${parsed.data.email}`}))`,
            );
            const [existing] = await tx
              .select({ id: accessRequest.id })
              .from(accessRequest)
              .where(
                and(
                  sql`lower(${accessRequest.email}) = ${parsed.data.email}`,
                  eq(accessRequest.status, "pending"),
                ),
              )
              .limit(1);
            if (existing) return;

            const [created] = await tx
              .insert(accessRequest)
              .values({
                name: parsed.data.name,
                email: parsed.data.email,
                reason: parsed.data.reason,
                adultConfirmedAt: new Date(),
              })
              .returning({ id: accessRequest.id });
            if (!created)
              throw new Error("Access request insert did not return an ID.");

            const [admin] = await tx
              .select({ email: user.email })
              .from(user)
              .where(
                and(
                  eq(user.role, "admin"),
                  eq(user.status, "active"),
                  eq(user.banned, false),
                ),
              )
              .limit(1);
            if (!admin) return;

            await enqueueEmailInTransaction(tx, {
              to: admin.email,
              template: "access-request-admin",
              variables: {
                name: "Administrator",
                url: `${process.env.APP_URL ?? "http://localhost:3000"}/admin/access`,
              },
              systemProducer: "access-request-admin",
              sourceId: created.id,
              idempotencySeed: created.id,
            });
          });

          // Enumeration-safe: an existing request receives the same response.
          return NextResponse.json(
            {
              ok: true,
              message: "Your request is waiting for administrator review.",
            },
            { status: 202 },
          );
        },
      );
    },
  );
}
