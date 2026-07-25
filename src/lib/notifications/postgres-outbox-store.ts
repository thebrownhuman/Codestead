import { createHash } from "node:crypto";

import type {
  BoundaryResult,
  OutboxClaim,
  OutboxStore,
  PostFinishResult,
  PostProviderExit,
  PreFinishResult,
  PreProviderExit,
  ProviderCallPermit,
  ProviderStartedClaim,
} from "./outbox-worker";

import {
  gmailProofAuthorizesFence,
  gmailReconciliationAuthority as classifyGmailReconciliationAuthority,
  type GmailReconciliationFence,
  type GmailReconciliationProof,
} from "./gmail-reconciliation";
import {
  LEGACY_RAW_PROVIDER_CORRELATION_VERSION,
  OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
} from "./provider-correlation";
import { userAuthorityLockKey } from "@/lib/security/user-authority-lock";
import {
  accountDeletionNoticeBinding,
  deletionNoticeSecret,
  type AccountDeletionNoticeVariables,
} from "./deletion-notice-capability";
import {
  PRODUCTION_EMAIL_TEMPLATES,
  requireDeletionCapabilityTemplateAuthority,
  requireSystemEmailTemplateAuthority,
  TEMPLATE_AUTHORITY_POLICIES,
  type DeletionCapabilityTemplateAuthority,
  type SystemEmailTemplateAuthority,
} from "./template-authority-policy";

export type EmailOutboxPayload = Readonly<{
  userId: string | null;
  to: string;
  template: string;
  templateVersion: string;
  variables: Readonly<Record<string, string>>;
}>;

type QueryResult<Row> = Readonly<{
  rows: Row[];
  rowCount?: number | null;
}>;

export interface OutboxPgClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
  release(): void;
}

export interface OutboxPgPool {
  connect(): Promise<OutboxPgClient>;
}

type CandidateRow = {
  id: string;
  user_id: string | null;
  operation_id: string;
  delivery_scope_key: string;
  claim_version: number;
};

type ClaimRow = CandidateRow & {
  to_email: string;
  template: string;
  template_version: string;
  variables: unknown;
  claim_token: string;
  claim_owner: string;
  attempt_count: number;
  lease_expires_at: Date | string;
};

type BoundaryRow = {
  provider_call_started: string;
  lease_expires_at: Date | string;
};

type TerminalRow = {
  status: string;
  claim_version: number;
  adapter: string | null;
  provider_message_id: string | null;
  provider_call_started: Date | string | null;
  sent_at: Date | string | null;
  quarantined_at: Date | string | null;
  last_error_code: string | null;
};

type SweepCandidateRow = CandidateRow & {
  claim_token: string;
  claim_owner: string;
  lease_expires_at: string;
};


type GmailReconciliationAuthority = Pick<
  GmailReconciliationFence,
  | "dispatchBindingVersion"
  | "dispatchBindingSha256"
  | "providerCorrelationVersion"
  | "providerEvidenceVersion"
  | "providerEvidenceSha256"
>;

type ReconciliationRow = CandidateRow & {
  claim_token: string | null;
  claim_owner: string | null;
  lease_expires_at: string | null;
  adapter: string;
  status: string;
  provider_call_started: string;
  dispatch_binding_version: string | null;
  dispatch_binding_sha256: string | null;
  provider_correlation_version: string | null;
  provider_evidence_version: string | null;
  provider_evidence_sha256: string | null;
  provider_message_id: string | null;
  sent_at: string | null;
  quarantined_at: string | null;
  last_error_code: string | null;
};
type ReconciliationTerminalRow = TerminalRow & {
  dispatch_binding_version: string | null;
  dispatch_binding_sha256: string | null;
  provider_correlation_version: string | null;
  provider_evidence_version: string | null;
  provider_evidence_sha256: string | null;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const ADAPTERS = new Set(["console", "gmail"]);

function assertUuid(value: string, name: string) {
  if (!UUID.test(value)) throw new Error(`${name} must be a UUID.`);
}

function assertBoundedText(value: string, name: string, maximum: number) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum) {
    throw new Error(`${name} must contain 1 to ${maximum} characters.`);
  }
  return trimmed;
}

function assertLeaseMs(value: number) {
  if (!Number.isSafeInteger(value) || value < 15_000 || value > 300_000) {
    throw new Error("Outbox lease must be an integer from 15000 to 300000 milliseconds.");
  }
}

function gmailReconciliationAuthority(input: Readonly<{
  dispatch_binding_version: string | null;
  dispatch_binding_sha256: string | null;
  provider_correlation_version: string | null;
  provider_evidence_version: string | null;
  provider_evidence_sha256: string | null;
}>): GmailReconciliationAuthority | null {
  const {
    dispatch_binding_version: dispatchBindingVersion,
    dispatch_binding_sha256: dispatchBindingSha256,
    provider_correlation_version: providerCorrelationVersion,
    provider_evidence_version: providerEvidenceVersion,
    provider_evidence_sha256: providerEvidenceSha256,
  } = input;
  if (providerCorrelationVersion === LEGACY_RAW_PROVIDER_CORRELATION_VERSION) {
    const bindingIsGrandfathered =
      dispatchBindingVersion === null && dispatchBindingSha256 === null;
    const bindingIsReviewedRaw =
      dispatchBindingVersion === "gmail-raw-v1"
      && typeof dispatchBindingSha256 === "string"
      && LOWERCASE_SHA256.test(dispatchBindingSha256);
    if (
      (!bindingIsGrandfathered && !bindingIsReviewedRaw)
      || providerEvidenceVersion !== null
      || providerEvidenceSha256 !== null
    ) return null;
    return {
      dispatchBindingVersion,
      dispatchBindingSha256,
      providerCorrelationVersion,
      providerEvidenceVersion: null,
      providerEvidenceSha256: null,
    };
  }
  if (
    providerCorrelationVersion !== OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION
    || dispatchBindingVersion !== "gmail-raw-v1"
    || typeof dispatchBindingSha256 !== "string"
    || !LOWERCASE_SHA256.test(dispatchBindingSha256)
    || providerEvidenceVersion !== "gmail-header-evidence-v1"
    || typeof providerEvidenceSha256 !== "string"
    || !LOWERCASE_SHA256.test(providerEvidenceSha256)
  ) return null;
  return {
    dispatchBindingVersion,
    dispatchBindingSha256,
    providerCorrelationVersion,
    providerEvidenceVersion,
    providerEvidenceSha256,
  };
}

function asDate(value: Date | string, name: string) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} is not a valid timestamp.`);
  return date;
}

function variables(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Outbox variables must be an object.");
  }
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new Error("Outbox variables must contain only strings.");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

type DeletionNoticeCapabilityEvidence = Readonly<{
  valid: boolean;
  recipientHmacSha256: string | null;
  payloadSha256: string | null;
}>;

const INVALID_DELETION_NOTICE_EVIDENCE: DeletionNoticeCapabilityEvidence = {
  valid: false,
  recipientHmacSha256: null,
  payloadSha256: null,
};

const ACCESS_REQUEST_ADMIN_TEMPLATE_AUTHORITY =
  requireSystemEmailTemplateAuthority("access-request-admin");
const ACCESS_REQUEST_APPROVED_TEMPLATE_AUTHORITY =
  requireSystemEmailTemplateAuthority("access-request-approved");
const ACCESS_REQUEST_REJECTED_TEMPLATE_AUTHORITY =
  requireSystemEmailTemplateAuthority("access-request-rejected");
const DELETION_NOTICE_TEMPLATE_AUTHORITY =
  requireDeletionCapabilityTemplateAuthority("account-deletion-notice-v1");

type SpecializedTemplateAuthority =
  | SystemEmailTemplateAuthority
  | DeletionCapabilityTemplateAuthority;

function matchesTemplateAuthority(
  payload: EmailOutboxPayload,
  authority: SpecializedTemplateAuthority,
) {
  return payload.template === authority.template
    && authority.versions.some((version) => version === payload.templateVersion);
}

function exactDeletionNoticeVariables(
  value: unknown,
): AccountDeletionNoticeVariables | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 3
    || !keys.includes("backupRetentionUntil")
    || !keys.includes("tombstoneId")
    || !keys.includes("deletionRunId")
    || typeof record.backupRetentionUntil !== "string"
    || typeof record.tombstoneId !== "string"
    || typeof record.deletionRunId !== "string"
  ) {
    return null;
  }
  return {
    backupRetentionUntil: record.backupRetentionUntil,
    tombstoneId: record.tombstoneId,
    deletionRunId: record.deletionRunId,
  };
}

function deletionNoticeCapabilityEvidence(
  payload: EmailOutboxPayload,
): DeletionNoticeCapabilityEvidence {
  if (
    !matchesTemplateAuthority(payload, DELETION_NOTICE_TEMPLATE_AUTHORITY)
    || !payload.to.trim()
  ) {
    return INVALID_DELETION_NOTICE_EVIDENCE;
  }
  const parsed = exactDeletionNoticeVariables(payload.variables);
  if (!parsed) return INVALID_DELETION_NOTICE_EVIDENCE;
  const binding = accountDeletionNoticeBinding({
    recipient: payload.to,
    variables: parsed,
    secret: deletionNoticeSecret(),
  });
  return { valid: true, ...binding };
}

function trustedSqlLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function nonEmptySqlDisjunction(
  parts: readonly string[],
  authority: string,
) {
  if (parts.length === 0 || parts.some((part) => !part.trim())) {
    throw new Error(
      `${authority} must contain at least one non-empty SQL predicate.`,
    );
  }
  return parts.join(" or ");
}

const DELETION_NOTICE_TEMPLATE_SQL = trustedSqlLiteral(
  DELETION_NOTICE_TEMPLATE_AUTHORITY.template,
);

function templateVersionAuthorityPredicate(
  outbox: string,
  authority: SpecializedTemplateAuthority,
) {
  if (authority.versions.length === 0) {
    throw new Error(
      `Template authority ${authority.template} must allow at least one version.`,
    );
  }
  const versions = nonEmptySqlDisjunction(
    authority.versions.map(
      (version) => `${outbox}.template_version = ${trustedSqlLiteral(version)}`,
    ),
    `Template authority ${authority.template}`,
  );
  return `(
    ${outbox}.template = ${trustedSqlLiteral(authority.template)}
    and (${versions})
  )`;
}

const ACCOUNT_TEMPLATE_AUTHORITY_SQL = nonEmptySqlDisjunction(
  PRODUCTION_EMAIL_TEMPLATES.flatMap(
    (template) => {
      const policy = TEMPLATE_AUTHORITY_POLICIES[template];
      if (policy.scope !== "account") return [];
      const banned = nonEmptySqlDisjunction(
        policy.account.banned.map(
          (value) => `account_user.banned = ${value}`,
        ),
        `Template authority ${template} banned states`,
      );
      const states = nonEmptySqlDisjunction(
        policy.account.states.map((state) => `(
          account_user.role = ${trustedSqlLiteral(state.role)}
          and account_user.status = ${trustedSqlLiteral(state.status)}
          and account_user.email_verified = ${state.emailVerified}
        )`),
        `Template authority ${template} account states`,
      );
      return policy.versions.map((version) => `(
        outbox.template = ${trustedSqlLiteral(template)}
        and outbox.template_version = ${trustedSqlLiteral(version)}
        and (${banned})
        and (${states})
      )`);
    },
  ),
  "Account template authority",
);

function accountMailAuthorityPredicate(outbox: string, lockClause = "") {
  const authority = ACCOUNT_TEMPLATE_AUTHORITY_SQL.replaceAll(
    /\boutbox\./g,
    `${outbox}.`,
  );
  return `exists (
    select 1 from public."user" account_user
    where account_user.id = ${outbox}.user_id
      and lower(btrim(account_user.email)) = ${outbox}.to_email
      and (${authority})
    ${lockClause}
  )`;
}

type SystemMailAuthorityParameters = Readonly<{
  approvedInvitationTokenHashParameter: number;
  adminAccessUrlParameter: number;
  lockAuthorityRows: boolean;
}>;

function systemMailAuthorityPredicate(
  outbox: string,
  input: SystemMailAuthorityParameters,
) {
  const adminAuthorityLock = input.lockAuthorityRows
    ? "for share of source_request, admin_recipient"
    : "";
  const approvedAuthorityLock = input.lockAuthorityRows
    ? "for share of source_invitation, source_request"
    : "";
  const rejectedAuthorityLock = input.lockAuthorityRows
    ? "for share of source_request"
    : "";

  const adminTemplateAuthority = templateVersionAuthorityPredicate(
    outbox,
    ACCESS_REQUEST_ADMIN_TEMPLATE_AUTHORITY,
  );
  const approvedTemplateAuthority = templateVersionAuthorityPredicate(
    outbox,
    ACCESS_REQUEST_APPROVED_TEMPLATE_AUTHORITY,
  );
  const rejectedTemplateAuthority = templateVersionAuthorityPredicate(
    outbox,
    ACCESS_REQUEST_REJECTED_TEMPLATE_AUTHORITY,
  );

  return `(
    ${outbox}.user_id is null
    and ${outbox}.variables ->> '_mailOperationId' = ${outbox}.operation_id::text
    and ${outbox}.variables ->> '_mailRecipient' = ${outbox}.to_email
    and (
      (
        ${adminTemplateAuthority}
        and ${outbox}.variables ->> '_mailProducer'
              = ${trustedSqlLiteral(ACCESS_REQUEST_ADMIN_TEMPLATE_AUTHORITY.producer)}
        and ${outbox}.variables ->> 'name' = 'Administrator'
        and ${outbox}.variables ->> 'url'
              = $${input.adminAccessUrlParameter}::text
        and exists (
          select 1
          from public.access_request source_request
          join public."user" admin_recipient
            on lower(admin_recipient.email) = ${outbox}.to_email
          where source_request.id::text = ${outbox}.variables ->> '_mailSourceId'
            and source_request.status = 'pending'
            and source_request.adult_confirmed_at is not null
            and source_request.decided_by is null
            and source_request.decision_reason is null
            and source_request.decided_at is null
            and admin_recipient.status = 'active'
            and admin_recipient.role = 'admin'
            and admin_recipient.banned = false
            and admin_recipient.email_verified = true
          ${adminAuthorityLock}
        )
      )
      or (
        ${approvedTemplateAuthority}
        and ${outbox}.variables ->> '_mailProducer'
              = ${trustedSqlLiteral(ACCESS_REQUEST_APPROVED_TEMPLATE_AUTHORITY.producer)}
        and exists (
          select 1
          from public.invitation source_invitation
          join public.access_request source_request
            on source_invitation.access_request_id = source_request.id
          where source_invitation.id::text = ${outbox}.variables ->> '_mailSourceId'
            and source_request.status = 'approved'
            and source_request.decided_by is not null
            and source_request.decision_reason is not null
            and source_request.decided_at is not null
            and source_invitation.created_by = source_request.decided_by
            and lower(source_invitation.email) = ${outbox}.to_email
            and lower(source_request.email) = ${outbox}.to_email
            and source_request.name = ${outbox}.variables ->> 'name'
            and source_invitation.token_hash
                  = $${input.approvedInvitationTokenHashParameter}::text
            and source_invitation.expires_at > pg_catalog.statement_timestamp()
            and source_invitation.consumed_at is null
          ${approvedAuthorityLock}
        )
      )
      or (
        ${rejectedTemplateAuthority}
        and ${outbox}.variables ->> '_mailProducer'
              = ${trustedSqlLiteral(ACCESS_REQUEST_REJECTED_TEMPLATE_AUTHORITY.producer)}
        and not (${outbox}.variables ? 'url')
        and exists (
          select 1
          from public.access_request source_request
          where source_request.id::text = ${outbox}.variables ->> '_mailSourceId'
            and source_request.status = 'rejected'
            and source_request.decided_by is not null
            and source_request.decision_reason is not null
            and source_request.decided_at is not null
            and lower(source_request.email) = ${outbox}.to_email
            and source_request.name = ${outbox}.variables ->> 'name'
          ${rejectedAuthorityLock}
        )
      )
    )
  )`;
}

function deletionNoticeCapabilityPredicate(
  outbox: string,
  input: Readonly<{
    validParameter: number;
    recipientHmacParameter: number;
    payloadDigestParameter: number;
  }>,
) {
  const templateAuthority = templateVersionAuthorityPredicate(
    outbox,
    DELETION_NOTICE_TEMPLATE_AUTHORITY,
  );
  return `(
    $${input.validParameter}::boolean
    and ${outbox}.user_id is not null
    and ${templateAuthority}
    and exists (
      select 1
      from public.account_deletion_tombstone tombstone
      join public.data_lifecycle_run lifecycle
        on lifecycle.id::text = ${outbox}.variables ->> 'deletionRunId'
      join public."user" deleted_user
        on deleted_user.id = ${outbox}.user_id
      where tombstone.id::text = ${outbox}.variables ->> 'tombstoneId'
        and tombstone.user_id = ${outbox}.user_id
        and tombstone.primary_deletion_completed_at is not null
        and deleted_user.role = 'learner'
        and deleted_user.status = 'deleted'
        and lifecycle.target_user_id = ${outbox}.user_id
        and lifecycle.operation = 'account_deletion'
        and lifecycle.status = 'succeeded'
        and lifecycle.completed_at is not null
        and tombstone.report ->> 'runId' = lifecycle.id::text
        and tombstone.report ->> 'tombstoneId' = tombstone.id::text
        and tombstone.report ->> 'backupRetentionUntil'
              = ${outbox}.variables ->> 'backupRetentionUntil'
        and tombstone.report ->> 'primaryStoreDeletionComplete' = 'true'
        and tombstone.report ->> 'learnerNotificationQueued' = 'true'
        and tombstone.report #>> '{deletionNotice,outboxId}' = ${outbox}.id::text
        and tombstone.report #>> '{deletionNotice,operationId}' = ${outbox}.operation_id::text
        and tombstone.report #>> '{deletionNotice,recipientHmacSha256}'
              = $${input.recipientHmacParameter}::text
        and tombstone.report #>> '{deletionNotice,payloadSha256}'
              = $${input.payloadDigestParameter}::text
        and lifecycle.report ->> 'runId' = lifecycle.id::text
        and lifecycle.report ->> 'tombstoneId' = tombstone.id::text
        and lifecycle.report ->> 'backupRetentionUntil'
              = ${outbox}.variables ->> 'backupRetentionUntil'
        and lifecycle.report ->> 'primaryStoreDeletionComplete' = 'true'
        and lifecycle.report ->> 'learnerNotificationQueued' = 'true'
        and lifecycle.report #>> '{deletionNotice,outboxId}' = ${outbox}.id::text
        and lifecycle.report #>> '{deletionNotice,operationId}' = ${outbox}.operation_id::text
        and lifecycle.report #>> '{deletionNotice,recipientHmacSha256}'
              = $${input.recipientHmacParameter}::text
        and lifecycle.report #>> '{deletionNotice,payloadSha256}'
              = $${input.payloadDigestParameter}::text
    )
  )`;
}

const ACCOUNT_MAIL_AUTHORITY_SQL = accountMailAuthorityPredicate("outbox");
const DECISION_DELETION_CAPABILITY_SQL = deletionNoticeCapabilityPredicate("outbox", {
  validParameter: 14,
  recipientHmacParameter: 12,
  payloadDigestParameter: 13,
});
const SUPPRESSION_DELETION_CAPABILITY_SQL = deletionNoticeCapabilityPredicate("outbox", {
  validParameter: 15,
  recipientHmacParameter: 13,
  payloadDigestParameter: 14,
});
const BOUNDARY_DELETION_CAPABILITY_SQL = deletionNoticeCapabilityPredicate("outbox", {
  validParameter: 16,
  recipientHmacParameter: 14,
  payloadDigestParameter: 15,
});
const SUPPRESSION_SYSTEM_MAIL_AUTHORITY_SQL = systemMailAuthorityPredicate("outbox", {
  approvedInvitationTokenHashParameter: 16,
  adminAccessUrlParameter: 17,
  lockAuthorityRows: false,
});
const BOUNDARY_SYSTEM_MAIL_AUTHORITY_SQL = systemMailAuthorityPredicate("outbox", {
  approvedInvitationTokenHashParameter: 17,
  adminAccessUrlParameter: 18,
  lockAuthorityRows: false,
});


type DeliveryScope = Readonly<{
  key: string;
  lockKey: string;
  kind: "account" | "system";
  userId: string | null;
}>;

function deliveryScope(
  row: Pick<CandidateRow, "delivery_scope_key" | "operation_id" | "user_id">,
): DeliveryScope {
  assertUuid(row.operation_id, "Outbox operation ID");
  if (row.user_id !== null) {
    const expected = `a:${row.user_id}`;
    if (row.delivery_scope_key !== expected) {
      throw new Error("Outbox account delivery scope is invalid.");
    }
    return {
      key: expected,
      lockKey: userAuthorityLockKey(row.user_id),
      kind: "account",
      userId: row.user_id,
    };
  }
  const expected = `s:${row.operation_id}`;
  if (row.delivery_scope_key !== expected) {
    throw new Error("Outbox system delivery scope is invalid.");
  }
  return {
    key: expected,
    lockKey: `mail-delivery-scope:${expected}`,
    kind: "system",
    userId: null,
  };
}

async function transaction<T>(pool: OutboxPgPool, work: (client: OutboxPgClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Preserve the original failure, especially an unknown commit result.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function advisoryLock(
  client: OutboxPgClient,
  key: string,
  wait: boolean,
) {
  if (wait) {
    await client.query(
      "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1))",
      [key],
    );
    return true;
  }
  const result = await client.query<{ locked: boolean }>(
    "select pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext($1)) as locked",
    [key],
  );
  return result.rows[0]?.locked === true;
}

type ClaimFenceInput = Readonly<{
  id: string;
  operationId: string;
  claimToken: string;
  claimOwner: string;
  claimVersion: number;
}>;

type BoundaryDecision =
  | "allowed"
  | "ACCOUNT_NOT_ACTIVE_AT_PROVIDER_BOUNDARY"
  | "SYSTEM_EMAIL_AUTHORITY_INVALID"
  | "DELETION_NOTICE_CAPABILITY_INVALID";

async function lockFenceScope(
  client: OutboxPgClient,
  fence: ClaimFenceInput,
  wait: boolean,
): Promise<DeliveryScope | null> {
  const result = await client.query<CandidateRow>(`
    select id::text, user_id, operation_id::text, delivery_scope_key, claim_version
    from public.email_outbox
    where id = $1::uuid
      and operation_id = $2::uuid
      and claim_token = $3::uuid
      and claim_owner = $4::text
      and claim_version = $5::integer
  `, [
    fence.id,
    fence.operationId,
    fence.claimToken,
    fence.claimOwner,
    fence.claimVersion,
  ]);
  const row = result.rows[0];
  if (!row) return null;
  const scope = deliveryScope(row);
  return await advisoryLock(client, scope.lockKey, wait) ? scope : null;
}

type PermitFenceInput = ClaimFenceInput & Readonly<{
  adapter: string;
  providerCallStartedAt: string;
}>;

async function lockPermitScope(
  client: OutboxPgClient,
  permit: PermitFenceInput,
  wait: boolean,
): Promise<DeliveryScope | null> {
  const result = await client.query<CandidateRow>(`
    select id::text, user_id, operation_id::text, delivery_scope_key, claim_version
    from public.email_outbox
    where id = $1::uuid
      and operation_id = $2::uuid
      and adapter = $6::text
      and provider_call_started = $7::timestamptz
      and (
        (
          claim_version = $5::integer
          and claim_token = $3::uuid
          and claim_owner = $4::text
        )
        or (
          claim_version = $5::integer
          and claim_token is null
          and claim_owner is null
          and lease_expires_at is null
          and status in ('sent', 'failed', 'quarantined')
        )
        or (
          $5::integer < 2147483647
          and claim_version = $5::integer + 1
          and claim_token is null
          and claim_owner is null
          and lease_expires_at is null
          and status in ('sent', 'failed', 'quarantined')
        )
      )
  `, [
    permit.id,
    permit.operationId,
    permit.claimToken,
    permit.claimOwner,
    permit.claimVersion,
    permit.adapter,
    permit.providerCallStartedAt,
  ]);
  const row = result.rows[0];
  if (!row) return null;
  const scope = deliveryScope(row);
  return await advisoryLock(client, scope.lockKey, wait) ? scope : null;
}
const ACTIVATION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function canonicalAppOrigin(): string | null {
  const configured = process.env.APP_URL
    ?? (process.env.NODE_ENV === "production" ? null : "http://localhost:3000");
  if (!configured) return null;

  try {
    const appUrl = new URL(configured);
    const protocolAllowed = process.env.NODE_ENV === "production"
      ? appUrl.protocol === "https:"
      : appUrl.protocol === "http:" || appUrl.protocol === "https:";
    return protocolAllowed && appUrl.origin === configured ? configured : null;
  } catch {
    return null;
  }
}

function matchesSystemTemplateAuthority(
  claim: OutboxClaim<EmailOutboxPayload>,
  authority: SystemEmailTemplateAuthority,
) {
  return matchesTemplateAuthority(claim.payload, authority)
    && claim.payload.variables._mailProducer === authority.producer;
}

function canonicalAdminAccessUrl(
  claim: OutboxClaim<EmailOutboxPayload>,
): string | null {
  if (
    claim.payload.userId !== null
    || !matchesSystemTemplateAuthority(
      claim,
      ACCESS_REQUEST_ADMIN_TEMPLATE_AUTHORITY,
    )
  ) {
    return null;
  }
  const appOrigin = canonicalAppOrigin();
  return appOrigin ? `${appOrigin}/admin/access` : null;
}

function canonicalActivationTokenHash(
  claim: OutboxClaim<EmailOutboxPayload>,
): string | null {
  if (
    claim.payload.userId !== null
    || !matchesSystemTemplateAuthority(
      claim,
      ACCESS_REQUEST_APPROVED_TEMPLATE_AUTHORITY,
    )
  ) {
    return null;
  }

  const appOrigin = canonicalAppOrigin();
  if (!appOrigin) return null;

  try {
    const activationUrl = new URL(claim.payload.variables.url);
    const tokens = activationUrl.searchParams.getAll("token");
    if (tokens.length !== 1 || !ACTIVATION_TOKEN.test(tokens[0]!)) return null;
    const canonicalUrl = `${appOrigin}/activate?token=${tokens[0]}`;
    if (claim.payload.variables.url !== canonicalUrl) return null;

    return createHash("sha256").update(tokens[0]!).digest("hex");
  } catch {
    return null;
  }
}

async function providerBoundaryDecision(
  client: OutboxPgClient,
  claim: OutboxClaim<EmailOutboxPayload>,
  scope: DeliveryScope,
  evidence: DeletionNoticeCapabilityEvidence,
  approvedInvitationTokenHash: string | null,
  adminAccessUrl: string | null,
  lockAuthorityRows: boolean,
): Promise<BoundaryDecision | null> {
  const accountAuthoritySql = accountMailAuthorityPredicate(
    "outbox",
    lockAuthorityRows ? "for share of account_user" : "",
  );
  const systemAuthoritySql = systemMailAuthorityPredicate("outbox", {
    approvedInvitationTokenHashParameter: 15,
    adminAccessUrlParameter: 16,
    lockAuthorityRows,
  });

  const result = await client.query<{ decision: BoundaryDecision }>(`
    select case
      when ${systemAuthoritySql} then 'allowed'
      when outbox.user_id is null then 'SYSTEM_EMAIL_AUTHORITY_INVALID'
      when outbox.template <> ${DELETION_NOTICE_TEMPLATE_SQL} and ${accountAuthoritySql}
        then 'allowed'
      when ${DECISION_DELETION_CAPABILITY_SQL} then 'allowed'
      when outbox.template = ${DELETION_NOTICE_TEMPLATE_SQL}
        then 'DELETION_NOTICE_CAPABILITY_INVALID'
      else 'ACCOUNT_NOT_ACTIVE_AT_PROVIDER_BOUNDARY'
    end as decision
    from public.email_outbox outbox
    where outbox.id = $1::uuid
      and outbox.operation_id = $2::uuid
      and outbox.claim_token = $3::uuid
      and outbox.claim_owner = $4::text
      and outbox.claim_version = $5::integer
      and outbox.delivery_scope_key = $6::text
      and outbox.user_id is not distinct from $7::text
      and outbox.to_email = lower(btrim($8::text))
      and outbox.template = $9::text
      and outbox.template_version = $10::text
      and outbox.variables = $11::jsonb
      and outbox.provider_call_started is null
      and outbox.status = 'sending'
  `, [
    claim.id,
    claim.operationId,
    claim.claimToken,
    claim.claimOwner,
    claim.claimVersion,
    scope.key,
    claim.payload.userId,
    claim.payload.to,
    claim.payload.template,
    claim.payload.templateVersion,
    JSON.stringify(claim.payload.variables),
    evidence.recipientHmacSha256,
    evidence.payloadSha256,
    evidence.valid,
    approvedInvitationTokenHash,
    adminAccessUrl,
  ]);
  return result.rows[0]?.decision ?? null;
}

function claimFromRow(row: ClaimRow): OutboxClaim<EmailOutboxPayload> {
  assertUuid(row.id, "Outbox ID");
  assertUuid(row.operation_id, "Outbox operation ID");
  deliveryScope(row);
  assertUuid(row.claim_token, "Outbox claim token");
  const claimOwner = assertBoundedText(row.claim_owner, "Outbox claim owner", 128);
  if (!Number.isSafeInteger(row.claim_version) || row.claim_version <= 0) {
    throw new Error("Outbox claim version must be a positive integer.");
  }
  if (!Number.isSafeInteger(row.attempt_count) || row.attempt_count <= 0) {
    throw new Error("Outbox attempt count must be a positive integer.");
  }
  return {
    phase: "pre-provider",
    id: row.id,
    operationId: row.operation_id,
    claimToken: row.claim_token,
    claimOwner,
    claimVersion: row.claim_version,
    attempt: row.attempt_count,
    leaseExpiresAt: asDate(row.lease_expires_at, "Outbox lease expiry"),
    payload: {
      userId: row.user_id,
      to: row.to_email,
      template: row.template,
      templateVersion: row.template_version,
      variables: variables(row.variables),
    },
  };
}

function validateClaim(claim: OutboxClaim<EmailOutboxPayload>) {
  assertUuid(claim.id, "Outbox ID");
  assertUuid(claim.operationId, "Outbox operation ID");
  assertUuid(claim.claimToken, "Outbox claim token");
  assertBoundedText(claim.claimOwner, "Outbox claim owner", 128);
  if (!Number.isSafeInteger(claim.claimVersion) || claim.claimVersion <= 0) {
    throw new Error("Outbox claim version must be a positive integer.");
  }
}

function validatePermit(permit: ProviderCallPermit) {
  assertUuid(permit.id, "Outbox ID");
  assertUuid(permit.operationId, "Outbox operation ID");
  assertUuid(permit.claimToken, "Outbox claim token");
  assertBoundedText(permit.claimOwner, "Outbox claim owner", 128);
  if (!Number.isSafeInteger(permit.claimVersion) || permit.claimVersion <= 0) {
    throw new Error("Outbox claim version must be a positive integer.");
  }
  if (!ADAPTERS.has(permit.adapter)) throw new Error("Outbox adapter is not allowed.");
  assertBoundedText(permit.providerCallStartedAt, "Provider boundary timestamp", 64);
}

export class PostgresOutboxStore implements OutboxStore<EmailOutboxPayload> {
  constructor(private readonly pool: OutboxPgPool) {}

  async findGmailReconciliationFence(input: Readonly<{ operationId: string }>) {
    assertUuid(input.operationId, "Outbox operation ID");
    return transaction(this.pool, async (client) => {
      const result = await client.query<ReconciliationRow>(`
        select id::text, user_id, operation_id::text, delivery_scope_key,
               claim_version, claim_token::text, claim_owner,
               lease_expires_at::text, adapter, status::text,
               provider_call_started::text, provider_message_id,
               dispatch_binding_version, dispatch_binding_sha256,
               provider_correlation_version, provider_evidence_version,
               provider_evidence_sha256, sent_at::text,
               quarantined_at::text, last_error_code
        from public.email_outbox
        where operation_id = $1::uuid
          and adapter = 'gmail'
          and provider_call_started is not null
          and (
            (
              status = 'quarantined'
              and provider_message_id is null
              and sent_at is null
              and quarantined_at is not null
              and last_error_code is not null
              and btrim(last_error_code) <> ''
            )
            or (
              status = 'sent'
              and provider_message_id is not null
              and btrim(provider_message_id) <> ''
              and sent_at is not null
              and quarantined_at is null
              and last_error_code is null
              and claim_token is null
              and claim_owner is null
              and lease_expires_at is null
            )
          )
          and (
            (user_id is not null and delivery_scope_key = 'a:' || user_id)
            or (user_id is null and delivery_scope_key = 's:' || operation_id::text)
          )
      `, [input.operationId]);
      const row = result.rows[0];
      if (!row) return { kind: "not-reconcilable" as const };
      const scope = deliveryScope(row);
      if (!Number.isSafeInteger(row.claim_version) || row.claim_version <= 0) {
        throw new Error("Outbox reconciliation claim version is invalid.");
      }
      if (
        row.adapter !== "gmail"
        || row.provider_call_started === null
        || typeof row.provider_call_started !== "string"
      ) {
        return { kind: "not-reconcilable" as const };
      }
      const reconciliationAuthority = gmailReconciliationAuthority(row);
      if (reconciliationAuthority === null) {
        return { kind: "not-reconcilable" as const };
      }
      if (row.status === "sent") {
        if (
          row.claim_token === null
          && row.claim_owner === null
          && row.lease_expires_at === null
          && typeof row.provider_message_id === "string"
          && row.provider_message_id.trim() !== ""
          && typeof row.sent_at === "string"
          && row.quarantined_at === null
          && row.last_error_code === null
        ) {
          assertBoundedText(row.provider_message_id, "Provider message ID", 512);
          assertBoundedText(row.provider_call_started, "Provider boundary", 64);
          assertBoundedText(row.sent_at, "Sent timestamp", 64);
          return { kind: "already-applied" as const };
        }
        return { kind: "not-reconcilable" as const };
      }
      if (
        row.status !== "quarantined"
        || row.provider_message_id !== null
        || row.sent_at !== null
        || row.quarantined_at === null
        || row.last_error_code === null
      ) {
        return { kind: "not-reconcilable" as const };
      }
      if ((row.claim_token === null) !== (row.claim_owner === null)) {
        throw new Error("Outbox reconciliation claim authority is inconsistent.");
      }
      if (row.claim_token !== null) assertUuid(row.claim_token, "Outbox claim token");
      const claimOwner = row.claim_owner === null
        ? null
        : assertBoundedText(row.claim_owner, "Outbox claim owner", 128);
      const fence: GmailReconciliationFence = {
        id: row.id,
        operationId: row.operation_id,
        claimVersion: row.claim_version,
        userId: scope.userId,
        deliveryScopeKey: scope.key,
        claimToken: row.claim_token,
        claimOwner,
        leaseExpiresAt: row.lease_expires_at === null
          ? null
          : assertBoundedText(row.lease_expires_at, "Outbox lease expiry", 64),
        adapter: "gmail",
        providerCallStartedAt: assertBoundedText(
          row.provider_call_started,
          "Provider boundary",
          64,
        ),
        ...reconciliationAuthority,
        quarantinedAt: assertBoundedText(row.quarantined_at, "Quarantine timestamp", 64),
        lastErrorCode: assertBoundedText(row.last_error_code, "Outbox error code", 80),
      };
      return { kind: "ready" as const, fence };
    });
  }

  async finalizeGmailReconciliation(input: Readonly<{
    fence: GmailReconciliationFence;
    providerMessageId: string;
    proof: GmailReconciliationProof;
  }>) {
    const { fence } = input;
    assertUuid(fence.id, "Outbox ID");
    assertUuid(fence.operationId, "Outbox operation ID");
    if (!Number.isSafeInteger(fence.claimVersion) || fence.claimVersion <= 0) {
      throw new Error("Outbox reconciliation claim version is invalid.");
    }
    if (fence.adapter !== "gmail") throw new Error("Outbox adapter is not Gmail.");
    if ((fence.claimToken === null) !== (fence.claimOwner === null)) {
      throw new Error("Outbox reconciliation claim authority is inconsistent.");
    }
    if (fence.claimToken !== null) assertUuid(fence.claimToken, "Outbox claim token");
    if (fence.claimOwner !== null) {
      assertBoundedText(fence.claimOwner, "Outbox claim owner", 128);
    }
    const scope = deliveryScope({
      operation_id: fence.operationId,
      user_id: fence.userId,
      delivery_scope_key: fence.deliveryScopeKey,
    });
    const providerMessageId = assertBoundedText(
      input.providerMessageId,
      "Provider message ID",
      512,
    );
    const providerCallStartedAt = assertBoundedText(
      fence.providerCallStartedAt,
      "Provider boundary",
      64,
    );
    const quarantinedAt = assertBoundedText(
      fence.quarantinedAt,
      "Quarantine timestamp",
      64,
    );
    const lastErrorCode = assertBoundedText(fence.lastErrorCode, "Outbox error code", 80);
    const leaseExpiresAt = fence.leaseExpiresAt === null
      ? null
      : assertBoundedText(fence.leaseExpiresAt, "Outbox lease expiry", 64);
    const reconciliationAuthority = gmailReconciliationAuthority({
      dispatch_binding_version: fence.dispatchBindingVersion,
      dispatch_binding_sha256: fence.dispatchBindingSha256,
      provider_correlation_version: fence.providerCorrelationVersion,
      provider_evidence_version: fence.providerEvidenceVersion,
      provider_evidence_sha256: fence.providerEvidenceSha256,
    });
    if (reconciliationAuthority === null) {
      return { kind: "lost" as const };
    }
    const authorityClass = classifyGmailReconciliationAuthority(fence);
    if (
      authorityClass === null
      || authorityClass.kind === "legacy-unbound-v0"
      || !gmailProofAuthorizesFence(authorityClass, input.proof)
    ) {
      return { kind: "lost" as const };
    }

    return transaction(this.pool, async (client) => {
      const observed = await client.query<CandidateRow>(`
        select id::text, user_id, operation_id::text, delivery_scope_key, claim_version
        from public.email_outbox
        where id = $1::uuid
          and operation_id = $2::uuid
          and claim_version = $3::integer
          and user_id is not distinct from $4::text
          and delivery_scope_key = $5::text
          and adapter = $6::text
          and claim_token is not distinct from $7::uuid
          and claim_owner is not distinct from $8::text
          and lease_expires_at is not distinct from $9::timestamptz
          and provider_call_started = $10::timestamptz
          and quarantined_at = $11::timestamptz
          and last_error_code = $12::text
          and dispatch_binding_version is not distinct from $13::text
          and dispatch_binding_sha256 is not distinct from $14::text
          and provider_correlation_version = $15::text
          and provider_evidence_version is not distinct from $16::text
          and provider_evidence_sha256 is not distinct from $17::text
          and provider_message_id is null
          and sent_at is null
          and status = 'quarantined'
      `, [
        fence.id,
        fence.operationId,
        fence.claimVersion,
        scope.userId,
        scope.key,
        fence.adapter,
        fence.claimToken,
        fence.claimOwner,
        leaseExpiresAt,
        providerCallStartedAt,
        quarantinedAt,
        lastErrorCode,
        reconciliationAuthority.dispatchBindingVersion,
        reconciliationAuthority.dispatchBindingSha256,
        reconciliationAuthority.providerCorrelationVersion,
        reconciliationAuthority.providerEvidenceVersion,
        reconciliationAuthority.providerEvidenceSha256,
      ]);
      const row = observed.rows[0];
      if (!row) return { kind: "lost" as const };
      const observedScope = deliveryScope(row);
      if (observedScope.key !== scope.key) return { kind: "lost" as const };
      await advisoryLock(client, scope.lockKey, true);

      const result = await client.query<ReconciliationTerminalRow>(`
        update public.email_outbox
        set status = 'sent',
            provider_message_id = $18::text,
            sent_at = pg_catalog.statement_timestamp(),
            quarantined_at = null,
            last_error_code = null,
            claim_token = null,
            claim_owner = null,
            lease_expires_at = null,
            updated_at = pg_catalog.statement_timestamp()
        where id = $1::uuid
          and operation_id = $2::uuid
          and claim_version = $3::integer
          and user_id is not distinct from $4::text
          and delivery_scope_key = $5::text
          and adapter = $6::text
          and claim_token is not distinct from $7::uuid
          and claim_owner is not distinct from $8::text
          and lease_expires_at is not distinct from $9::timestamptz
          and provider_call_started = $10::timestamptz
          and quarantined_at = $11::timestamptz
          and last_error_code = $12::text
          and dispatch_binding_version is not distinct from $13::text
          and dispatch_binding_sha256 is not distinct from $14::text
          and provider_correlation_version = $15::text
          and provider_evidence_version is not distinct from $16::text
          and provider_evidence_sha256 is not distinct from $17::text
          and provider_message_id is null
          and sent_at is null
          and status = 'quarantined'
        returning status::text, claim_version, adapter, provider_message_id,
                  provider_call_started, dispatch_binding_version,
                  dispatch_binding_sha256, provider_correlation_version,
                  provider_evidence_version, provider_evidence_sha256,
                  sent_at, quarantined_at, last_error_code
      `, [
        fence.id,
        fence.operationId,
        fence.claimVersion,
        scope.userId,
        scope.key,
        fence.adapter,
        fence.claimToken,
        fence.claimOwner,
        leaseExpiresAt,
        providerCallStartedAt,
        quarantinedAt,
        lastErrorCode,
        reconciliationAuthority.dispatchBindingVersion,
        reconciliationAuthority.dispatchBindingSha256,
        reconciliationAuthority.providerCorrelationVersion,
        reconciliationAuthority.providerEvidenceVersion,
        reconciliationAuthority.providerEvidenceSha256,
        providerMessageId,
      ]);
      const updated = result.rows[0];
      return updated
        && updated.status === "sent"
        && updated.claim_version === fence.claimVersion
        && updated.adapter === fence.adapter
        && updated.provider_message_id === providerMessageId
        && updated.provider_call_started !== null
        && updated.dispatch_binding_version ===
          reconciliationAuthority.dispatchBindingVersion
        && updated.dispatch_binding_sha256 ===
          reconciliationAuthority.dispatchBindingSha256
        && updated.provider_correlation_version ===
          reconciliationAuthority.providerCorrelationVersion
        && updated.provider_evidence_version ===
          reconciliationAuthority.providerEvidenceVersion
        && updated.provider_evidence_sha256 ===
          reconciliationAuthority.providerEvidenceSha256
        && updated.sent_at !== null
        && updated.quarantined_at === null
        && updated.last_error_code === null
        ? { kind: "applied" as const }
        : { kind: "lost" as const };
    });
  }
  async claimNext(input: Readonly<{ owner: string; token: string; leaseMs: number }>) {
    const owner = assertBoundedText(input.owner, "Outbox claim owner", 128);
    assertUuid(input.token, "Outbox claim token");
    assertLeaseMs(input.leaseMs);

    return transaction(this.pool, async (client) => {
      const candidates = await client.query<CandidateRow>(`
        select id::text, user_id, operation_id::text, delivery_scope_key, claim_version
        from (
          select candidate.id, candidate.user_id, candidate.operation_id,
                 candidate.delivery_scope_key, candidate.claim_version,
                 candidate.next_attempt_at, candidate.created_at,
                 pg_catalog.row_number() over (
                   partition by candidate.delivery_scope_key
                   order by candidate.next_attempt_at, candidate.created_at, candidate.id
                 ) as scope_rank
          from public.email_outbox candidate
          where candidate.claim_version < 2147483647
            and (
              (candidate.user_id is not null and candidate.delivery_scope_key = 'a:' || candidate.user_id)
            or (
              candidate.user_id is null
              and candidate.delivery_scope_key = 's:' || candidate.operation_id::text
            )
          )
            and (
              (
                candidate.status = 'pending'
                and candidate.next_attempt_at <= pg_catalog.statement_timestamp()
                and candidate.claim_token is null
                and candidate.claim_owner is null
                and candidate.lease_expires_at is null
                and candidate.provider_call_started is null
                and candidate.adapter is null
                and candidate.provider_message_id is null
                and candidate.quarantined_at is null
              ) or (
                candidate.status = 'sending'
                and candidate.lease_expires_at < pg_catalog.statement_timestamp()
                and candidate.provider_call_started is null
                and candidate.adapter is null
                and candidate.provider_message_id is null
                and candidate.quarantined_at is null
              )
            )
            and not exists (
              select 1
              from public.email_outbox active
              where active.delivery_scope_key = candidate.delivery_scope_key
                and active.id <> candidate.id
                and (
                  (
                    active.status = 'sending'
                    and (
                      active.provider_call_started is not null
                      or active.lease_expires_at is null
                      or active.lease_expires_at >= pg_catalog.statement_timestamp()
                    )
                  )
                  or (
                    active.status = 'quarantined'
                    and active.provider_call_started is not null
                    and active.provider_message_id is null
                  )
                )
            )
        ) eligible
        where scope_rank = 1
        order by next_attempt_at, created_at, id
        limit 16
      `);

      for (const candidate of candidates.rows) {
        const scope = deliveryScope(candidate);
        const locked = await advisoryLock(client, scope.lockKey, false);
        if (!locked) continue;

        const claimed = await client.query<ClaimRow>(`
          update public.email_outbox
          set status = 'sending',
              claim_token = $4::uuid,
              claim_owner = $5::text,
              claim_version = claim_version + 1,
              lease_expires_at = pg_catalog.statement_timestamp() + ($6::integer * interval '1 millisecond'),
              attempt_count = attempt_count + 1,
              last_error_code = null,
              updated_at = pg_catalog.statement_timestamp()
          where id = $1::uuid
            and operation_id = $2::uuid
            and claim_version = $3::integer
            and claim_version < 2147483647
            and user_id is not distinct from $7::text
            and delivery_scope_key = $8::text
            and (
              (
                status = 'pending'
                and next_attempt_at <= pg_catalog.statement_timestamp()
                and claim_token is null
                and claim_owner is null
                and lease_expires_at is null
                and provider_call_started is null
                and adapter is null
                and provider_message_id is null
                and quarantined_at is null
              ) or (
                status = 'sending'
                and lease_expires_at < pg_catalog.statement_timestamp()
                and provider_call_started is null
                and adapter is null
                and provider_message_id is null
                and quarantined_at is null
              )
            )
            and not exists (
              select 1
              from public.email_outbox active
              where active.delivery_scope_key = $8::text
                and active.id <> $1::uuid
                and (
                  (
                    active.status = 'sending'
                    and (
                      active.provider_call_started is not null
                      or active.lease_expires_at is null
                      or active.lease_expires_at >= pg_catalog.statement_timestamp()
                    )
                  )
                  or (
                    active.status = 'quarantined'
                    and active.provider_call_started is not null
                    and active.provider_message_id is null
                  )
                )
            )
          returning id::text, user_id, operation_id::text, delivery_scope_key, claim_version,
                    to_email, template, template_version, variables,
                    claim_token::text, claim_owner, attempt_count, lease_expires_at
        `, [
          candidate.id,
          candidate.operation_id,
          candidate.claim_version,
          input.token,
          owner,
          input.leaseMs,
          candidate.user_id,
          scope.key,
        ]);
        if (claimed.rows[0]) return claimFromRow(claimed.rows[0]);
      }
      return null;
    });
  }

  async beginProviderCall(
    claim: OutboxClaim<EmailOutboxPayload>,
    input: Readonly<{ adapter: string; leaseMs: number }>,
  ): Promise<BoundaryResult> {
    validateClaim(claim);
    const adapter = assertBoundedText(input.adapter, "Outbox adapter", 32);
    if (!ADAPTERS.has(adapter)) throw new Error("Outbox adapter is not allowed.");
    assertLeaseMs(input.leaseMs);
    const evidence = deletionNoticeCapabilityEvidence(claim.payload);
    const approvedInvitationTokenHash = canonicalActivationTokenHash(claim);
    const adminAccessUrl = canonicalAdminAccessUrl(claim);

    return transaction(this.pool, async (client) => {
      const scope = await lockFenceScope(client, claim, true);
      if (!scope) return { kind: "lost" };

      let decision = await providerBoundaryDecision(
        client,
        claim,
        scope,
        evidence,
        approvedInvitationTokenHash,
        adminAccessUrl,
        false,
      );
      if (decision === null) return { kind: "lost" };
      if (decision === "allowed") {
        decision = await providerBoundaryDecision(
          client,
          claim,
          scope,
          evidence,
          approvedInvitationTokenHash,
          adminAccessUrl,
          true,
        );
        if (decision === null) return { kind: "lost" };
      }
      if (decision !== "allowed") {
        const suppressed = await client.query<{ id: string }>(`
          update public.email_outbox as outbox
          set status = 'suppressed',
              last_error_code = $7::text,
              claim_token = null,
              claim_owner = null,
              lease_expires_at = null,
              claim_version = claim_version + 1,
              updated_at = pg_catalog.statement_timestamp()
          where outbox.id = $1::uuid
            and outbox.operation_id = $2::uuid
            and outbox.claim_token = $3::uuid
            and outbox.claim_owner = $4::text
            and outbox.claim_version = $5::integer
            and outbox.delivery_scope_key = $6::text
            and outbox.user_id is not distinct from $8::text
            and outbox.to_email = lower(btrim($9::text))
            and outbox.template = $10::text
            and outbox.template_version = $11::text
            and outbox.variables = $12::jsonb
            and outbox.provider_call_started is null
            and outbox.adapter is null
            and outbox.provider_message_id is null
            and outbox.quarantined_at is null
            and outbox.lease_expires_at > pg_catalog.statement_timestamp()
            and outbox.status = 'sending'
            and (
              (
                $7::text = 'DELETION_NOTICE_CAPABILITY_INVALID'
                and outbox.template = ${DELETION_NOTICE_TEMPLATE_SQL}
                and not (${SUPPRESSION_DELETION_CAPABILITY_SQL})
              )
              or (
                $7::text = 'ACCOUNT_NOT_ACTIVE_AT_PROVIDER_BOUNDARY'
                and outbox.user_id is not null
                and outbox.template <> ${DELETION_NOTICE_TEMPLATE_SQL}
                and not (${ACCOUNT_MAIL_AUTHORITY_SQL})
              )
              or (
                $7::text = 'SYSTEM_EMAIL_AUTHORITY_INVALID'
                and outbox.user_id is null
                and not (${SUPPRESSION_SYSTEM_MAIL_AUTHORITY_SQL})
              )
            )
          returning outbox.id::text
        `, [
          claim.id,
          claim.operationId,
          claim.claimToken,
          claim.claimOwner,
          claim.claimVersion,
          scope.key,
          decision,
          claim.payload.userId,
          claim.payload.to,
          claim.payload.template,
          claim.payload.templateVersion,
          JSON.stringify(claim.payload.variables),
          evidence.recipientHmacSha256,
          evidence.payloadSha256,
          evidence.valid,
          approvedInvitationTokenHash,
          adminAccessUrl,
        ]);
        return suppressed.rows[0]
          ? { kind: "suppressed", code: decision }
          : { kind: "lost" };
      }

      const result = await client.query<BoundaryRow>(`
        update public.email_outbox as outbox
        set provider_call_started = pg_catalog.statement_timestamp(),
            adapter = $6::text,
            lease_expires_at = pg_catalog.statement_timestamp() + ($7::integer * interval '1 millisecond'),
            updated_at = pg_catalog.statement_timestamp()
        where outbox.id = $1::uuid
          and outbox.operation_id = $2::uuid
          and outbox.claim_token = $3::uuid
          and outbox.claim_owner = $4::text
          and outbox.claim_version = $5::integer
          and outbox.adapter is null
          and outbox.provider_message_id is null
          and outbox.provider_call_started is null
          and outbox.quarantined_at is null
          and outbox.lease_expires_at > pg_catalog.statement_timestamp()
          and outbox.status = 'sending'
          and outbox.user_id is not distinct from $8::text
          and outbox.delivery_scope_key = $9::text
          and outbox.to_email = lower(btrim($10::text))
          and outbox.template = $11::text
          and outbox.template_version = $12::text
          and outbox.variables = $13::jsonb
          and (
            ${BOUNDARY_SYSTEM_MAIL_AUTHORITY_SQL}
            or (
              outbox.template <> ${DELETION_NOTICE_TEMPLATE_SQL}
              and ${ACCOUNT_MAIL_AUTHORITY_SQL}
            )
            or ${BOUNDARY_DELETION_CAPABILITY_SQL}
          )
        returning outbox.provider_call_started::text as provider_call_started, outbox.lease_expires_at
      `, [
        claim.id,
        claim.operationId,
        claim.claimToken,
        claim.claimOwner,
        claim.claimVersion,
        adapter,
        input.leaseMs,
        scope.userId,
        scope.key,
        claim.payload.to,
        claim.payload.template,
        claim.payload.templateVersion,
        JSON.stringify(claim.payload.variables),
        evidence.recipientHmacSha256,
        evidence.payloadSha256,
        evidence.valid,
        approvedInvitationTokenHash,
        adminAccessUrl,
      ]);
      const row = result.rows[0];
      if (!row) return { kind: "lost" };
      const started: ProviderStartedClaim = {
        phase: "post-provider",
        id: claim.id,
        operationId: claim.operationId,
        claimToken: claim.claimToken,
        claimOwner: claim.claimOwner,
        claimVersion: claim.claimVersion,
        adapter,
        providerCallStartedAt: assertBoundedText(row.provider_call_started, "Provider boundary", 64),
        leaseExpiresAt: asDate(row.lease_expires_at, "Provider lease expiry"),
      };
      return { kind: "applied", permit: started as ProviderCallPermit };
    });
  }

  async finishBeforeProvider(
    claim: OutboxClaim<EmailOutboxPayload>,
    exit: PreProviderExit,
  ): Promise<PreFinishResult> {
    validateClaim(claim);
    const code = assertBoundedText(exit.code, "Outbox error code", 80);
    const retryAt = exit.kind === "retry" ? exit.retryAt : null;
    if (retryAt && !Number.isFinite(retryAt.getTime())) {
      throw new Error("Outbox retry timestamp is invalid.");
    }

    return transaction(this.pool, async (client) => {
      const scope = await lockFenceScope(client, claim, true);
      if (!scope) return { kind: "lost" };
      const result = await client.query<{
          operation_id: string;
          claim_version: number;
          claim_token: string | null;
          claim_owner: string | null;
          lease_expires_at: Date | string | null;
        }>(`
        update public.email_outbox
        set status = case $6::text
              when 'retry' then 'pending'::public.notification_status
              when 'failed' then 'failed'::public.notification_status
              when 'suppressed' then 'suppressed'::public.notification_status
            end,
            next_attempt_at = case when $6::text = 'retry' then $8::timestamptz else next_attempt_at end,
            last_error_code = $7::text,
            claim_token = null,
            claim_owner = null,
            lease_expires_at = null,
            claim_version = claim_version + 1,
            updated_at = pg_catalog.statement_timestamp()
        where id = $1::uuid
          and operation_id = $2::uuid
          and claim_token = $3::uuid
          and claim_owner = $4::text
          and claim_version = $5::integer
          and provider_call_started is null
          and adapter is null
          and provider_message_id is null
          and quarantined_at is null
          and lease_expires_at > pg_catalog.statement_timestamp()
          and status = 'sending'
          and user_id is not distinct from $9::text
          and delivery_scope_key = $10::text
        returning operation_id::text
      `, [
        claim.id,
        claim.operationId,
        claim.claimToken,
        claim.claimOwner,
        claim.claimVersion,
        exit.kind,
        code,
        retryAt,
        scope.userId,
        scope.key,
      ]);
      return result.rows[0] ? { kind: "applied" } : { kind: "lost" };
    });
  }

  async finishAfterProvider(
    permit: ProviderCallPermit,
    exit: PostProviderExit,
  ): Promise<PostFinishResult> {
    validatePermit(permit);
    const providerMessageId = exit.kind === "sent"
      ? assertBoundedText(exit.providerMessageId, "Provider message ID", 512)
      : null;
    const code = exit.kind === "sent"
      ? null
      : assertBoundedText(exit.code, "Outbox error code", 80);

    return transaction(this.pool, async (client) => {
      const scope = await lockPermitScope(client, permit, true);
      if (!scope) return { kind: "lost" };
      let result = exit.kind === "sent"
        ? await client.query<TerminalRow>(`
            update public.email_outbox
            set provider_message_id = $7::text,
                sent_at = pg_catalog.statement_timestamp(),
                status = case when status = 'quarantined'
                  then 'quarantined'::public.notification_status
                  else 'sent'::public.notification_status
                end,
                last_error_code = case when status = 'quarantined' then last_error_code else null end,
                claim_token = null,
                claim_owner = null,
                lease_expires_at = null,
                updated_at = pg_catalog.statement_timestamp()
            where id = $1::uuid
              and operation_id = $2::uuid
              and claim_token = $3::uuid
              and claim_owner = $4::text
              and claim_version = $5::integer
              and adapter = $6::text
              and provider_message_id is null
              and provider_call_started = $9::timestamptz
              and status in ('sending', 'quarantined')
              and user_id is not distinct from $10::text
              and delivery_scope_key = $8::text
            returning status::text, claim_version, adapter, provider_message_id,
                      provider_call_started, sent_at, quarantined_at, last_error_code
          `, [
            permit.id,
            permit.operationId,
            permit.claimToken,
            permit.claimOwner,
            permit.claimVersion,
            permit.adapter,
            providerMessageId,
            scope.key,
            permit.providerCallStartedAt,
            scope.userId,
          ])
        : await client.query<TerminalRow>(`
            update public.email_outbox
            set status = case $7::text
                  when 'failed' then 'failed'::public.notification_status
                  when 'quarantined' then 'quarantined'::public.notification_status
                end,
                last_error_code = $8::text,
                quarantined_at = case when $7::text = 'quarantined'
                  then pg_catalog.statement_timestamp()
                  else null
                end,
                claim_version = case when $7::text = 'quarantined'
                  then claim_version + 1
                  else claim_version
                end,
                claim_token = null,
                claim_owner = null,
                lease_expires_at = null,
                updated_at = pg_catalog.statement_timestamp()
            where id = $1::uuid
              and operation_id = $2::uuid
              and claim_token = $3::uuid
              and claim_owner = $4::text
              and claim_version = $5::integer
              and ($7::text <> 'quarantined' or claim_version < 2147483647)
              and adapter = $6::text
              and provider_message_id is null
              and provider_call_started = $10::timestamptz
              and quarantined_at is null
              and status = 'sending'
              and user_id is not distinct from $11::text
              and delivery_scope_key = $9::text
            returning status::text, claim_version, adapter, provider_message_id,
                      provider_call_started, sent_at, quarantined_at, last_error_code
          `, [
            permit.id,
            permit.operationId,
            permit.claimToken,
            permit.claimOwner,
            permit.claimVersion,
            permit.adapter,
            exit.kind,
            code,
            scope.key,
            permit.providerCallStartedAt,
            scope.userId,
          ]);

      let updated = result.rows[0];
      let successorFinalized = false;
      if (!updated && exit.kind !== "quarantined" && permit.claimVersion < 2147483647) {
        result = await client.query<TerminalRow>(`
          update public.email_outbox
          set status = case when $8::text = 'sent'
                then status
                else 'failed'::public.notification_status
              end,
              provider_message_id = case when $8::text = 'sent' then $9::text else null end,
              sent_at = case when $8::text = 'sent'
                then pg_catalog.statement_timestamp()
                else null
              end,
              quarantined_at = case when $8::text = 'sent' then quarantined_at else null end,
              last_error_code = case when $8::text = 'sent' then last_error_code else $10::text end,
              updated_at = pg_catalog.statement_timestamp()
          where id = $1::uuid
            and operation_id = $2::uuid
            and $3::integer < 2147483647
            and claim_version = $3::integer + 1
            and adapter = $4::text
            and provider_call_started = $5::timestamptz
            and user_id is not distinct from $6::text
            and delivery_scope_key = $7::text
            and claim_token is null
            and claim_owner is null
            and lease_expires_at is null
            and status = 'quarantined'
            and quarantined_at is not null
            and last_error_code = 'ABANDONED_POST_PROVIDER_BOUNDARY'
            and provider_message_id is null
            and sent_at is null
          returning status::text, claim_version, adapter, provider_message_id,
                    provider_call_started, sent_at, quarantined_at, last_error_code
        `, [
          permit.id,
          permit.operationId,
          permit.claimVersion,
          permit.adapter,
          permit.providerCallStartedAt,
          scope.userId,
          scope.key,
          exit.kind,
          providerMessageId,
          code,
        ]);
        updated = result.rows[0];
        successorFinalized = updated !== undefined;
      }

      if (updated) {
        const normalExpectedVersion = exit.kind === "quarantined"
          ? permit.claimVersion + 1
          : permit.claimVersion;
        const expectedClaimVersion = successorFinalized
          ? permit.claimVersion + 1
          : normalExpectedVersion;
        const exact = exit.kind === "sent"
          ? (
              (successorFinalized ? updated.status === "quarantined" : (
                updated.status === "sent" || updated.status === "quarantined"
              ))
              && updated.claim_version === expectedClaimVersion
              && updated.adapter === permit.adapter
              && updated.provider_message_id === providerMessageId
              && updated.provider_call_started !== null
              && updated.sent_at !== null
              && (!successorFinalized || (
                updated.quarantined_at !== null
                && updated.last_error_code === "ABANDONED_POST_PROVIDER_BOUNDARY"
              ))
            )
          : (
              updated.status === exit.kind
              && updated.claim_version === expectedClaimVersion
              && updated.adapter === permit.adapter
              && updated.provider_message_id === null
              && updated.provider_call_started !== null
              && updated.last_error_code === code
              && (exit.kind !== "quarantined" || updated.quarantined_at !== null)
              && (!successorFinalized || updated.quarantined_at === null)
            );
        return exact ? { kind: "applied" } : { kind: "lost" };
      }

      const existing = await client.query<TerminalRow>(`
        select status::text, claim_version, adapter, provider_message_id,
               provider_call_started, sent_at, quarantined_at, last_error_code
        from public.email_outbox
        where id = $1::uuid
          and operation_id = $2::uuid
          and adapter = $3::text
          and provider_call_started = $4::timestamptz
          and user_id is not distinct from $5::text
          and delivery_scope_key = $6::text
          and claim_token is null
          and claim_owner is null
          and lease_expires_at is null
          and (
            claim_version = $7::integer
            or ($7::integer < 2147483647 and claim_version = $7::integer + 1)
          )
      `, [
        permit.id,
        permit.operationId,
        permit.adapter,
        permit.providerCallStartedAt,
        scope.userId,
        scope.key,
        permit.claimVersion,
      ]);
      const row = existing.rows[0];
      if (!row || row.adapter !== permit.adapter) return { kind: "lost" };
      const normalExpectedVersion = exit.kind === "quarantined"
        ? permit.claimVersion + 1
        : permit.claimVersion;
      const successorVersion = permit.claimVersion < 2147483647
        && row.claim_version === permit.claimVersion + 1;
      if (
        exit.kind === "sent"
        && row.provider_message_id === providerMessageId
        && row.provider_call_started !== null
        && row.sent_at !== null
        && (
          (
            row.claim_version === normalExpectedVersion
            && (row.status === "sent" || row.status === "quarantined")
          )
          || (
            successorVersion
            && row.status === "quarantined"
            && row.quarantined_at !== null
            && row.last_error_code === "ABANDONED_POST_PROVIDER_BOUNDARY"
          )
          || (
            successorVersion
            && row.status === "sent"
            && row.quarantined_at === null
            && row.last_error_code === null
          )
        )
      ) {
        return { kind: "already-applied" };
      }
      if (
        exit.kind !== "sent"
        && row.status === exit.kind
        && row.provider_message_id === null
        && row.provider_call_started !== null
        && row.last_error_code === code
        && (exit.kind !== "quarantined" || row.quarantined_at !== null)
        && (
          row.claim_version === normalExpectedVersion
          || (exit.kind === "failed" && successorVersion && row.quarantined_at === null)
        )
      ) {
        return { kind: "already-applied" };
      }
      return { kind: "lost" };
    });
  }
  async quarantineAbandoned(input: Readonly<{ limit: number }>) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new Error("Outbox sweep limit must be an integer from 1 to 500.");
    }
    return transaction(this.pool, async (client) => {
      const candidates = await client.query<SweepCandidateRow>(`
        select id::text, user_id, operation_id::text, delivery_scope_key, claim_version,
               claim_token::text, claim_owner, lease_expires_at::text as lease_expires_at
        from public.email_outbox
        where status = 'sending'
          and provider_call_started is not null
          and adapter is not null
          and provider_message_id is null
          and quarantined_at is null
          and lease_expires_at < pg_catalog.statement_timestamp() - interval '30 seconds'
          and claim_version < 2147483647
          and (
            (user_id is not null and delivery_scope_key = 'a:' || user_id)
            or (user_id is null and delivery_scope_key = 's:' || operation_id::text)
          )
        order by lease_expires_at, id
        limit $1::integer
      `, [input.limit]);
      let quarantined = 0;
      for (const candidate of candidates.rows) {
        const scope = deliveryScope(candidate);
        const locked = await advisoryLock(client, scope.lockKey, false);
        if (!locked) continue;
        const result = await client.query<{
          operation_id: string;
          claim_version: number;
          claim_token: string | null;
          claim_owner: string | null;
          lease_expires_at: Date | string | null;
        }>(`
          update public.email_outbox
          set status = 'quarantined',
              quarantined_at = pg_catalog.statement_timestamp(),
              last_error_code = 'ABANDONED_POST_PROVIDER_BOUNDARY',
              claim_token = null,
              claim_owner = null,
              claim_version = claim_version + 1,
              lease_expires_at = null,
              updated_at = pg_catalog.statement_timestamp()
          where id = $1::uuid
            and operation_id = $2::uuid
            and claim_token = $3::uuid
            and claim_owner = $4::text
            and claim_version = $5::integer
            and claim_version < 2147483647
            and user_id is not distinct from $6::text
            and delivery_scope_key = $8::text
            and lease_expires_at = $7::timestamptz
            and lease_expires_at < pg_catalog.statement_timestamp() - interval '30 seconds'
            and provider_call_started is not null
            and adapter is not null
            and provider_message_id is null
            and quarantined_at is null
            and status = 'sending'
          returning operation_id::text, claim_version, claim_token::text, claim_owner, lease_expires_at
        `, [
          candidate.id,
          candidate.operation_id,
          candidate.claim_token,
          candidate.claim_owner,
          candidate.claim_version,
          scope.userId,
          candidate.lease_expires_at,
          scope.key,
        ]);
        const released = result.rows[0];
        if (released) {
          if (
            released.claim_version !== candidate.claim_version + 1
            || released.claim_token !== null
            || released.claim_owner !== null
            || released.lease_expires_at !== null
          ) {
            throw new Error("Abandoned outbox fence did not release at the next generation.");
          }
          quarantined += 1;
        }
      }
      return quarantined;
    });
  }
}
