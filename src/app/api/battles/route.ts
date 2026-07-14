import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { BattleError, createBattle, listBattles } from "@/lib/battles/service";
import { requireAuth } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";

const headers = { "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" };
const schema = z.object({
  requestId: z.uuid(),
  activityId: z.uuid(),
  scope: z.enum(["invite", "cohort", "weekly", "monthly"]),
  invitedPublicIds: z.array(z.uuid()).max(20).optional(),
  startsAt: z.iso.datetime().optional(),
  durationMinutes: z.number().int().min(5).max(1_440).optional(),
  revealDelayMinutes: z.number().int().min(0).max(10_080).optional(),
  competitionKey: z.string().trim().max(40).nullable().optional(),
}).strict();

function battleError(error: unknown) {
  const code = error instanceof BattleError ? error.code : "BATTLES_UNAVAILABLE";
  const status = code === "NOT_FOUND" || code === "ACTIVITY_NOT_ELIGIBLE" ? 404
    : code === "INVALID_INPUT" ? 400
      : code === "IDEMPOTENCY_CONFLICT" ? 409 : 503;
  return NextResponse.json({
    error: status === 404 ? "That reviewed challenge source is unavailable."
      : status === 400 ? "Check the challenge timing and participants."
        : status === 409 ? "This request ID was already used for a different battle."
          : "Battles are temporarily unavailable.",
    code,
  }, { status, headers });
}

export async function GET() {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "battle_read_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      try { return NextResponse.json(await listBattles({ actorUserId: authz.session!.user.id }), { headers }); }
      catch (error) { return battleError(error); }
    },
  );
}

export async function POST(request: NextRequest) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const body = schema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Choose a reviewed activity, scope, and valid time window." }, { status: 400, headers });
  return withRateLimit(
    { policy: "battle_write_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      try {
        const report = await createBattle({
          actorUserId: authz.session!.user.id,
          ...body.data,
          startsAt: body.data.startsAt ? new Date(body.data.startsAt) : undefined,
        });
        const auditCorrelationId = randomUUID();
        const completionAuditRecorded = await writeAuditEvent({
          actorUserId: authz.session!.user.id,
          subjectUserId: authz.session!.user.id,
          action: "battle.create",
          resourceType: "coding_battle",
          resourceId: report.id,
          outcome: "success",
          metadata: { scope: body.data.scope, replayed: report.replayed, auditCorrelationId },
        }).then(() => true).catch((error) => {
          console.error(JSON.stringify({
            event: "battle.completion_audit_failed",
            action: "create",
            resourceId: report.id,
            auditCorrelationId,
            errorName: error instanceof Error ? error.name : "UnknownError",
          }));
          return false;
        });
        return NextResponse.json({
          report,
          completionAuditRecorded,
          ...(completionAuditRecorded ? {} : {
            auditCorrelationId,
            warning: "The battle was completed, but its completion audit needs operator reconciliation. Do not repeat the request with a new request ID.",
          }),
        }, { status: report.replayed ? 200 : 201, headers });
      } catch (error) { return battleError(error); }
    },
  );
}
