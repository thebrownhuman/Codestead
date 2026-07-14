import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { BattleError, getBattle, joinBattle, submitBattle } from "@/lib/battles/service";
import { requireAuth } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";

const headers = { "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" };
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("join") }).strict(),
  z.object({ action: z.literal("submit"), requestId: z.uuid(), answer: z.record(z.string(), z.unknown()).optional(), attemptId: z.uuid().nullable().optional() }).strict()
    .refine((value) => Boolean(value.answer) !== Boolean(value.attemptId), "Provide either an authored answer or a verified attempt."),
]);

function response(error: unknown) {
  const code = error instanceof BattleError ? error.code : "BATTLE_UNAVAILABLE";
  const status = ["NOT_FOUND", "NOT_PARTICIPANT"].includes(code) ? 404
    : ["INVALID_INPUT", "ACTIVITY_NOT_ELIGIBLE", "ATTEMPT_NOT_ELIGIBLE"].includes(code) ? 400
      : ["NOT_OPEN", "ALREADY_SUBMITTED", "IDEMPOTENCY_CONFLICT"].includes(code) ? 409 : 503;
  const message = status === 404 ? "That battle is unavailable."
    : status === 400 ? "This answer or verified attempt cannot be accepted."
      : status === 409 ? "The battle state changed. Refresh before trying again."
        : "Battle state is temporarily unavailable.";
  return NextResponse.json({ error: message, code }, { status, headers });
}

export async function GET(_request: NextRequest, context: { params: Promise<{ battleId: string }> }) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "battle_read_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const { battleId } = await context.params;
      try { return NextResponse.json(await getBattle({ actorUserId: authz.session!.user.id, battleId }), { headers }); }
      catch (error) { return response(error); }
    },
  );
}

export async function POST(request: NextRequest, context: { params: Promise<{ battleId: string }> }) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const body = schema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Choose join or provide exactly one accepted submission type." }, { status: 400, headers });
  const policy = body.data.action === "submit" ? "battle_submit_user" : "battle_write_user";
  return withRateLimit(
    { policy, identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const { battleId } = await context.params;
      try {
        const report = body.data.action === "join"
          ? await joinBattle({ actorUserId: authz.session!.user.id, battleId })
          : await submitBattle({ actorUserId: authz.session!.user.id, battleId, requestId: body.data.requestId, answer: body.data.answer, attemptId: body.data.attemptId });
        const auditCorrelationId = randomUUID();
        const completionAuditRecorded = await writeAuditEvent({
          actorUserId: authz.session!.user.id,
          subjectUserId: authz.session!.user.id,
          action: `battle.${body.data.action}`,
          resourceType: "coding_battle",
          resourceId: battleId,
          outcome: "success",
          metadata: { resultRevealed: false, auditCorrelationId },
        }).then(() => true).catch((error) => {
          console.error(JSON.stringify({
            event: "battle.completion_audit_failed",
            action: body.data.action,
            resourceId: battleId,
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
            warning: "The battle action completed, but its completion audit needs operator reconciliation. Do not repeat the request with a new request ID.",
          }),
        }, { headers });
      } catch (error) { return response(error); }
    },
  );
}
