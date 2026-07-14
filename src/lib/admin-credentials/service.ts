import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { validateProviderCredential } from "@/lib/ai/credential-validation";
import type { CredentialValidationStatus } from "@/lib/ai/credential-validation";
import { db } from "@/lib/db/client";
import {
  emailOutbox,
  notification,
  providerCredential,
  user,
} from "@/lib/db/schema";
import { consentPurposeForProvider, hasCurrentConsent } from "@/lib/privacy/consent";
import {
  writeAuditEventInTransaction,
  type AuditTransaction,
} from "@/lib/security/audit-writer";
import {
  openCredential,
  parseMasterKey,
  sealCredential,
  type SealedCredential,
} from "@/lib/security/credential-vault";

export type AdminCredentialAction = "test" | "replace" | "enable" | "disable" | "delete";

export type AdminCredentialOperation = Readonly<{
  actorUserId: string;
  learnerPublicId: string;
  credentialId: string;
  action: AdminCredentialAction;
  reason: string;
  replacementSecret?: string;
}>;

export type AdminCredentialOperationResult = Readonly<{
  credentialId: string;
  action: AdminCredentialAction;
  status: CredentialValidationStatus | "disabled" | "deleted";
  auditCorrelationId: string;
}>;

export type AdminCredentialErrorCode =
  | "ADMIN_REQUIRED"
  | "CREDENTIAL_NOT_FOUND"
  | "PROVIDER_CONSENT_REQUIRED"
  | "REPLACEMENT_SECRET_REQUIRED"
  | "VAULT_UNAVAILABLE"
  | "CREDENTIAL_OPEN_FAILED"
  | "VALIDATION_UNAVAILABLE"
  | "CONCURRENT_CHANGE"
  | "INVALID_OPERATION";

export class AdminCredentialError extends Error {
  constructor(
    readonly code: AdminCredentialErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AdminCredentialError";
  }
}

const actionLabel: Record<AdminCredentialAction, string> = {
  test: "tested by an administrator",
  replace: "replaced by an administrator",
  enable: "enabled by an administrator",
  disable: "disabled by an administrator",
  delete: "deleted by an administrator",
};

const targetColumns = {
  id: providerCredential.id,
  userId: providerCredential.userId,
  provider: providerCredential.provider,
  ciphertext: providerCredential.ciphertext,
  wrappedDataKey: providerCredential.wrappedDataKey,
  wrapIv: providerCredential.wrapIv,
  dataIv: providerCredential.dataIv,
  authTag: providerCredential.authTag,
  keyVersion: providerCredential.keyVersion,
  lastFour: providerCredential.lastFour,
  ownerPublicId: user.publicId,
  ownerName: user.name,
  ownerEmail: user.email,
} as const;

type ProviderCredentialRow = typeof providerCredential.$inferSelect;
type CredentialTarget = Pick<
  ProviderCredentialRow,
  | "id"
  | "userId"
  | "provider"
  | "ciphertext"
  | "wrappedDataKey"
  | "wrapIv"
  | "dataIv"
  | "authTag"
  | "keyVersion"
  | "lastFour"
> & {
  ownerPublicId: string;
  ownerName: string;
  ownerEmail: string;
};

function appUrl() {
  return process.env.APP_URL ?? "http://localhost:3000";
}

function outboxIdempotencyKey(input: {
  template: string;
  to: string;
  seed: string;
}) {
  return createHash("sha256")
    .update(`${input.template}:${input.to.toLowerCase()}:${input.seed}`)
    .digest("hex");
}

function assertOperationInput(input: AdminCredentialOperation) {
  const reason = input.reason.trim();
  if (reason.length < 8 || reason.length > 500) {
    throw new AdminCredentialError("INVALID_OPERATION", "A specific reason of 8 to 500 characters is required.");
  }
  if (input.action === "replace") {
    const secret = input.replacementSecret?.trim() ?? "";
    if (secret.length < 8 || secret.length > 4_096) {
      throw new AdminCredentialError("REPLACEMENT_SECRET_REQUIRED", "A valid replacement credential is required.");
    }
  } else if (input.replacementSecret !== undefined) {
    throw new AdminCredentialError("INVALID_OPERATION", "Replacement material is accepted only for replace operations.");
  }
}

async function requireActiveAdmin(actorUserId: string) {
  const [actor] = await db
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.id, actorUserId), eq(user.role, "admin"), eq(user.status, "active")))
    .limit(1);
  if (!actor) {
    throw new AdminCredentialError("ADMIN_REQUIRED", "Administrator access is required.");
  }
}

async function loadCredentialTarget(input: AdminCredentialOperation): Promise<CredentialTarget> {
  const [target] = await db
    .select(targetColumns)
    .from(providerCredential)
    .innerJoin(user, eq(user.id, providerCredential.userId))
    .where(
      and(
        eq(providerCredential.id, input.credentialId),
        eq(user.publicId, input.learnerPublicId),
        eq(user.role, "learner"),
      ),
    )
    .limit(1);
  if (!target) {
    throw new AdminCredentialError("CREDENTIAL_NOT_FOUND", "Credential not found for this learner.");
  }
  return target;
}

function credentialMasterKey() {
  const configured = process.env.CREDENTIAL_MASTER_KEY;
  if (!configured) {
    throw new AdminCredentialError("VAULT_UNAVAILABLE", "Credential vault unavailable.");
  }
  try {
    return parseMasterKey(configured);
  } catch {
    throw new AdminCredentialError("VAULT_UNAVAILABLE", "Credential vault unavailable.");
  }
}

async function prepareValidatedChange(
  input: AdminCredentialOperation,
  target: CredentialTarget,
): Promise<{
  validationStatus: CredentialValidationStatus;
  failureCode: string | null;
  validatedAt: Date | null;
  sealed: SealedCredential | null;
}> {
  const wrappingKey = credentialMasterKey();
  try {
    let secret: string;
    if (input.action === "replace") {
      secret = input.replacementSecret!.trim();
    } else {
      try {
        secret = openCredential(
          target,
          {
            credentialId: target.id,
            userId: target.userId,
            provider: target.provider,
            keyVersion: target.keyVersion,
          },
          wrappingKey,
        );
      } catch {
        throw new AdminCredentialError("CREDENTIAL_OPEN_FAILED", "Credential could not be opened safely.");
      }
    }

    let validation: Awaited<ReturnType<typeof validateProviderCredential>>;
    try {
      validation = await validateProviderCredential({
        userId: target.userId,
        credentialId: target.id,
        provider: target.provider,
        secret,
      });
    } catch {
      throw new AdminCredentialError("VALIDATION_UNAVAILABLE", "Credential validation is temporarily unavailable.");
    }

    const sealed = input.action === "replace"
      ? sealCredential(
          secret,
          {
            credentialId: target.id,
            userId: target.userId,
            provider: target.provider,
            keyVersion: target.keyVersion + 1,
          },
          wrappingKey,
        )
      : null;
    return {
      validationStatus: validation.status,
      failureCode: validation.failureCode,
      validatedAt: validation.model ? new Date() : null,
      sealed,
    };
  } finally {
    wrappingKey.fill(0);
  }
}

async function lockCredentialTarget(
  tx: AuditTransaction,
  input: AdminCredentialOperation,
): Promise<CredentialTarget> {
  // Serialize operations for this credential, including callers that do not
  // use this service, before re-checking actor, owner, and learner role.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.credentialId}))`);
  await tx.execute(sql`select id from provider_credential where id = ${input.credentialId}::uuid for update`);
  const [actor] = await tx
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.id, input.actorUserId), eq(user.role, "admin"), eq(user.status, "active")))
    .limit(1);
  if (!actor) {
    throw new AdminCredentialError("ADMIN_REQUIRED", "Administrator access is required.");
  }
  const [locked] = await tx
    .select(targetColumns)
    .from(providerCredential)
    .innerJoin(user, eq(user.id, providerCredential.userId))
    .where(
      and(
        eq(providerCredential.id, input.credentialId),
        eq(user.publicId, input.learnerPublicId),
        eq(user.role, "learner"),
      ),
    )
    .limit(1);
  if (!locked) {
    throw new AdminCredentialError("CREDENTIAL_NOT_FOUND", "Credential not found for this learner.");
  }
  return locked;
}

async function appendCredentialNotice(
  tx: AuditTransaction,
  target: CredentialTarget,
  input: {
    actionText: string;
    title: string;
    summary: string;
    correlationId: string;
    stage: "requested" | "completed";
  },
) {
  const provider = target.provider.replaceAll("_", " ");
  await tx.insert(notification).values({
    userId: target.userId,
    type: "credential-changed",
    title: input.title,
    body: input.summary,
    actionUrl: "/settings?section=ai",
  });
  await tx
    .insert(emailOutbox)
    .values({
      userId: target.userId,
      toEmail: target.ownerEmail.toLowerCase(),
      template: "credential-changed",
      templateVersion: "1",
      variables: {
        name: target.ownerName,
        provider,
        action: input.actionText,
        url: `${appUrl()}/settings?section=ai`,
      },
      idempotencyKey: outboxIdempotencyKey({
        template: "credential-changed",
        to: target.ownerEmail,
        seed: `${target.id}:${input.correlationId}:${input.stage}`,
      }),
    })
    .onConflictDoNothing({ target: emailOutbox.idempotencyKey });
}

async function recordValidationIntent(
  input: AdminCredentialOperation,
  target: CredentialTarget,
  correlationId: string,
) {
  await db.transaction(async (tx) => {
    const locked = await lockCredentialTarget(tx, input);
    if (locked.keyVersion !== target.keyVersion) {
      throw new AdminCredentialError("CONCURRENT_CHANGE", "Credential changed during this operation. Refresh and retry.");
    }
    const actionText = input.action === "test"
      ? "test started by an administrator"
      : "replacement validation started by an administrator";
    await writeAuditEventInTransaction(tx, {
      actorUserId: input.actorUserId,
      subjectUserId: locked.userId,
      action: `credential.${input.action}.requested`,
      resourceType: "provider_credential",
      resourceId: locked.id,
      reason: input.reason.trim(),
      outcome: "allowed",
      correlationId,
      metadata: { provider: locked.provider, priorLastFour: locked.lastFour },
    });
    await appendCredentialNotice(tx, locked, {
      actionText,
      title: "Administrator credential check started",
      summary: `An administrator started ${input.action === "test" ? "testing" : "replacement validation for"} your ${locked.provider.replaceAll("_", " ")} credential after fresh MFA.`,
      correlationId,
      stage: "requested",
    });
  });
}

export async function performAdminCredentialOperation(
  input: AdminCredentialOperation,
): Promise<AdminCredentialOperationResult> {
  assertOperationInput(input);
  await requireActiveAdmin(input.actorUserId);
  const target = await loadCredentialTarget(input);

  if (["test", "replace", "enable"].includes(input.action)) {
    const purpose = consentPurposeForProvider(target.provider);
    if (!purpose || !(await hasCurrentConsent(target.userId, purpose))) {
      throw new AdminCredentialError(
        "PROVIDER_CONSENT_REQUIRED",
        "The learner must restore provider consent before this operation.",
      );
    }
  }

  const correlationId = randomUUID();
  if (input.action === "test" || input.action === "replace") {
    // Provider validation and decryption are external/in-memory effects that
    // cannot be rolled back. Audit and both learner notices must commit first.
    await recordValidationIntent(input, target, correlationId);
  }
  const prepared = input.action === "test" || input.action === "replace"
    ? await prepareValidatedChange(input, target)
    : null;
  const now = new Date();

  return db.transaction(async (tx) => {
    const locked = await lockCredentialTarget(tx, input);
    if (prepared && locked.keyVersion !== target.keyVersion) {
      throw new AdminCredentialError("CONCURRENT_CHANGE", "Credential changed during this operation. Refresh and retry.");
    }

    let status: AdminCredentialOperationResult["status"];
    if (input.action === "delete") {
      const deleted = await tx
        .delete(providerCredential)
        .where(and(eq(providerCredential.id, locked.id), eq(providerCredential.userId, locked.userId)))
        .returning({ id: providerCredential.id });
      if (deleted.length !== 1) {
        throw new AdminCredentialError("CONCURRENT_CHANGE", "Credential changed during this operation. Refresh and retry.");
      }
      status = "deleted";
    } else if (input.action === "disable" || input.action === "enable") {
      const nextStatus = input.action === "disable" ? "disabled" : "pending_validation";
      const updated = await tx
        .update(providerCredential)
        .set({
          status: nextStatus,
          disabledAt: input.action === "disable" ? now : null,
          ...(input.action === "enable" ? { failureCode: null } : {}),
          updatedAt: now,
        })
        .where(and(eq(providerCredential.id, locked.id), eq(providerCredential.userId, locked.userId)))
        .returning({ id: providerCredential.id });
      if (updated.length !== 1) {
        throw new AdminCredentialError("CONCURRENT_CHANGE", "Credential changed during this operation. Refresh and retry.");
      }
      status = nextStatus;
    } else {
      if (!prepared) {
        throw new AdminCredentialError("INVALID_OPERATION", "Credential operation was not prepared safely.");
      }
      const updated = await tx
        .update(providerCredential)
        .set(input.action === "replace" && prepared.sealed
          ? {
              ciphertext: prepared.sealed.ciphertext,
              wrappedDataKey: prepared.sealed.wrappedDataKey,
              wrapIv: prepared.sealed.wrapIv,
              dataIv: prepared.sealed.dataIv,
              authTag: prepared.sealed.authTag,
              keyVersion: prepared.sealed.keyVersion,
              lastFour: prepared.sealed.lastFour,
              status: prepared.validationStatus,
              failureCode: prepared.failureCode,
              lastValidatedAt: prepared.validatedAt,
              disabledAt: null,
              updatedAt: now,
            }
          : {
              status: prepared.validationStatus,
              failureCode: prepared.failureCode,
              lastValidatedAt: prepared.validatedAt,
              updatedAt: now,
            })
        .where(
          and(
            eq(providerCredential.id, locked.id),
            eq(providerCredential.userId, locked.userId),
            eq(providerCredential.keyVersion, target.keyVersion),
          ),
        )
        .returning({ id: providerCredential.id });
      if (updated.length !== 1) {
        throw new AdminCredentialError("CONCURRENT_CHANGE", "Credential changed during this operation. Refresh and retry.");
      }
      status = prepared.validationStatus;
    }

    const audit = await writeAuditEventInTransaction(tx, {
      actorUserId: input.actorUserId,
      subjectUserId: locked.userId,
      action: `credential.${input.action}`,
      resourceType: "provider_credential",
      resourceId: locked.id,
      reason: input.reason.trim(),
      outcome:
        prepared && !["active", "pending_validation"].includes(prepared.validationStatus)
          ? "failure"
          : "success",
      correlationId,
      metadata: {
        provider: locked.provider,
        priorLastFour: locked.lastFour,
        resultingStatus: status,
      },
    });

    await appendCredentialNotice(tx, locked, {
      actionText: actionLabel[input.action],
      title: "AI provider credential changed",
      summary: `Your ${locked.provider.replaceAll("_", " ")} credential was ${actionLabel[input.action]}.`,
      correlationId: audit.correlationId,
      stage: "completed",
    });

    return {
      credentialId: locked.id,
      action: input.action,
      status,
      auditCorrelationId: audit.correlationId,
    };
  });
}

export function adminCredentialErrorStatus(error: unknown): number {
  if (!(error instanceof AdminCredentialError)) return 503;
  if (error.code === "ADMIN_REQUIRED") return 403;
  if (error.code === "CREDENTIAL_NOT_FOUND") return 404;
  if (error.code === "PROVIDER_CONSENT_REQUIRED" || error.code === "CONCURRENT_CHANGE") return 409;
  if (error.code === "REPLACEMENT_SECRET_REQUIRED" || error.code === "INVALID_OPERATION") return 400;
  return 503;
}

export function adminCredentialPublicError(error: unknown): string {
  if (error instanceof AdminCredentialError) return error.message;
  return "Credential operation could not be completed safely.";
}

export function adminCredentialErrorCode(error: unknown): string {
  return error instanceof AdminCredentialError ? error.code : "OPERATION_UNAVAILABLE";
}
