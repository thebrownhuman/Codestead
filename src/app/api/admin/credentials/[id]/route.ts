import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  adminCredentialErrorCode,
  adminCredentialErrorStatus,
  adminCredentialPublicError,
  performAdminCredentialOperation,
  type AdminCredentialAction,
} from "@/lib/admin-credentials/service";
import {
  canonicalProviderOperationHash,
  executeProviderOperationIdempotently,
  ProviderOperationIdempotencyError,
} from "@/lib/ai/provider-operation-idempotency";
import { db } from "@/lib/db/client";
import { session } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { authorizePrivilegedAction, type PrivilegedAction } from "@/lib/security/privileged-access";
import { withRateLimit } from "@/lib/security/rate-limit";

const commonFields = {
  learnerId: z.uuid(),
  reason: z.string().trim().min(8).max(500),
} as const;
const patchSchema = z.discriminatedUnion("action", [
  z.object({ ...commonFields, action: z.literal("test"), requestId: z.uuid() }).strict(),
  z.object({ ...commonFields, action: z.enum(["enable", "disable"]) }).strict(),
  z.object({
    ...commonFields,
    action: z.literal("replace"),
    requestId: z.uuid(),
    secret: z.string().trim().min(8).max(4_096),
  }).strict(),
]);
const deleteSchema = z.object(commonFields).strict();
const credentialIdSchema = z.uuid();
const noStore = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

function operationJson(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: noStore });
}

async function responseSnapshot(response: Response) {
  const body = await response.clone().json().catch(() => ({
    error: "Credential operation could not be completed safely.",
    code: "OPERATION_UNAVAILABLE",
  })) as Record<string, unknown>;
  return { status: response.status, body };
}

async function safeCredentialExecution(execute: () => Promise<Response>) {
  try {
    return await responseSnapshot(await execute());
  } catch {
    return {
      status: 503,
      body: {
        error: "Credential operation could not be completed safely.",
        code: "OPERATION_UNAVAILABLE",
      },
    };
  }
}

function idempotencyErrorResponse(error: ProviderOperationIdempotencyError) {
  return operationJson(
    {
      error: error.message,
      code: error.code,
      ...(error.code === "IDEMPOTENCY_WAIT_TIMEOUT" ? { retryable: true } : {}),
    },
    error.code === "IDEMPOTENCY_KEY_REUSED" ? 409 : 503,
  );
}

const privilegedActions: Record<AdminCredentialAction, PrivilegedAction> = {
  test: "credential.test",
  replace: "credential.replace",
  enable: "credential.enable",
  disable: "credential.disable",
  delete: "credential.delete",
};

function privilegedAction(action: AdminCredentialAction): PrivilegedAction {
  return privilegedActions[action];
}

async function recordDenied(input: {
  actorUserId: string;
  credentialId?: string;
  action: AdminCredentialAction;
  reason: string;
  code: string;
  outcome?: "denied" | "failure";
}) {
  await writeAuditEvent({
    actorUserId: input.actorUserId,
    action: `credential.${input.action}`,
    resourceType: "provider_credential",
    resourceId: input.credentialId,
    reason: input.reason,
    outcome: input.outcome ?? "denied",
    metadata: { errorCode: input.code },
  }).catch(() => undefined);
}

async function execute(
  authz: Awaited<ReturnType<typeof requireAdmin>> & { session: NonNullable<Awaited<ReturnType<typeof requireAdmin>>["session"]> },
  credentialId: string,
  input: {
    learnerId: string;
    reason: string;
    action: AdminCredentialAction;
    secret?: string;
  },
) {
  const [authSession] = await db
    .select({ mfaVerifiedAt: session.mfaVerifiedAt })
    .from(session)
    .where(and(eq(session.id, authz.session.session.id), eq(session.userId, authz.session.user.id)))
    .limit(1);
  const gate = authorizePrivilegedAction({
    actorRole: authz.account.role,
    mfaVerifiedAt: authSession?.mfaVerifiedAt,
    reason: input.reason,
    action: privilegedAction(input.action),
  });
  if (!gate.allowed) {
    await recordDenied({
      actorUserId: authz.session.user.id,
      credentialId,
      action: input.action,
      reason: input.reason,
      code: gate.code,
    });
    return operationJson({ error: gate.code }, 403);
  }

  try {
    const result = await performAdminCredentialOperation({
      actorUserId: authz.session.user.id,
      learnerPublicId: input.learnerId,
      credentialId,
      action: input.action,
      reason: input.reason,
      ...(input.action === "replace" ? { replacementSecret: input.secret } : {}),
    });
    return operationJson({
      ok: true,
      action: result.action,
      status: result.status,
      auditCorrelationId: result.auditCorrelationId,
    });
  } catch (error) {
    const code = adminCredentialErrorCode(error);
    await recordDenied({
      actorUserId: authz.session.user.id,
      credentialId,
      action: input.action,
      reason: input.reason,
      code,
      outcome: "failure",
    });
    return operationJson({ error: adminCredentialPublicError(error), code }, adminCredentialErrorStatus(error));
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return authz.response;
  const { id } = await context.params;
  const body = patchSchema.safeParse(await request.json().catch(() => null));
  if (!credentialIdSchema.safeParse(id).success || !body.success) {
    await writeAuditEvent({
      actorUserId: authz.session.user.id,
      action: "credential.admin_mutation",
      resourceType: "provider_credential",
      reason: "Invalid administrator credential operation request",
      outcome: "denied",
      metadata: { errorCode: "INVALID_REQUEST" },
    }).catch(() => undefined);
    return operationJson(
      { error: credentialIdSchema.safeParse(id).success ? "Invalid credential operation." : "Credential not found." },
      credentialIdSchema.safeParse(id).success ? 400 : 404,
    );
  }

  const runOnce = async () => {
    const response = await withRateLimit(
      {
        policy: "credential_mutation_admin",
        identity: { kind: "user", value: authz.session.user.id },
      },
      () => execute(authz as Parameters<typeof execute>[0], id, body.data),
    );
    if (response.status === 429) {
      await recordDenied({
        actorUserId: authz.session.user.id,
        credentialId: id,
        action: body.data.action,
        reason: body.data.reason,
        code: "RATE_LIMITED",
      });
    }
    return response;
  };

  if (body.data.action !== "test" && body.data.action !== "replace") return runOnce();
  try {
    const result = await executeProviderOperationIdempotently({
      ownerUserId: authz.session.user.id,
      action: `credential.${body.data.action}`,
      requestId: body.data.requestId,
      inputHash: canonicalProviderOperationHash({
        credentialId: id,
        learnerId: body.data.learnerId,
        action: body.data.action,
        reason: body.data.reason,
        ...(body.data.action === "replace" ? { replacementSecret: body.data.secret } : {}),
      }),
      execute: () => safeCredentialExecution(runOnce),
    });
    return NextResponse.json(result.body, {
      status: result.status,
      headers: { ...noStore, "X-Idempotent-Replay": result.replayed ? "true" : "false" },
    });
  } catch (error) {
    if (error instanceof ProviderOperationIdempotencyError) return idempotencyErrorResponse(error);
    return operationJson(
      { error: "Credential operation could not be completed safely.", code: "OPERATION_UNAVAILABLE" },
      503,
    );
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return authz.response;
  const { id } = await context.params;
  const body = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!credentialIdSchema.safeParse(id).success || !body.success) {
    await writeAuditEvent({
      actorUserId: authz.session.user.id,
      action: "credential.delete",
      resourceType: "provider_credential",
      reason: "Invalid administrator credential deletion request",
      outcome: "denied",
      metadata: { errorCode: "INVALID_REQUEST" },
    }).catch(() => undefined);
    return operationJson(
      { error: credentialIdSchema.safeParse(id).success ? "A learner and specific reason are required." : "Credential not found." },
      credentialIdSchema.safeParse(id).success ? 400 : 404,
    );
  }

  const response = await withRateLimit(
    {
      policy: "credential_mutation_admin",
      identity: { kind: "user", value: authz.session.user.id },
    },
    () => execute(authz as Parameters<typeof execute>[0], id, { ...body.data, action: "delete" }),
  );
  if (response.status === 429) {
    await recordDenied({
      actorUserId: authz.session.user.id,
      credentialId: id,
      action: "delete",
      reason: body.data.reason,
      code: "RATE_LIMITED",
    });
  }
  return response;
}
